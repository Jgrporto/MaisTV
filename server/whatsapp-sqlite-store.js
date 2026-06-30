import "dotenv/config";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getSqlStoreConfig } from "./sql-store.js";

const parseBooleanEnv = (value, defaultValue = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "sim";
};

const config = getSqlStoreConfig();
const WHATSAPP_SQLITE_STORE_ENABLED = parseBooleanEnv(
  process.env.WHATSAPP_SQLITE_STORE_ENABLED,
  config.enabled && config.driver === "sqlite" && Boolean(config.sqlitePath),
);

let db = null;
let schemaReady = false;

const nowIso = () => new Date().toISOString();

const safeJsonParse = (value, fallback = null) => {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
};

const normalizeTimestampMs = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizePagination = ({ page = 1, limit = 50 } = {}) => {
  const parsedPage = Number.parseInt(String(page || "1"), 10);
  const parsedLimit = Number.parseInt(String(limit || "50"), 10);
  const normalizedPage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const normalizedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.max(parsedLimit, 1), 1000)
    : 50;
  return {
    page: normalizedPage,
    limit: normalizedLimit,
    offset: (normalizedPage - 1) * normalizedLimit,
  };
};

const normalizeStore = (store = {}) => ({
  conversations:
    store?.conversations && typeof store.conversations === "object" && !Array.isArray(store.conversations)
      ? store.conversations
      : {},
  messages:
    store?.messages && typeof store.messages === "object" && !Array.isArray(store.messages)
      ? store.messages
      : {},
  session:
    store?.session && typeof store.session === "object"
      ? store.session
      : {
          status: "disconnected",
          qrCode: null,
          lastConnectedAt: null,
          updatedAt: null,
        },
});

const conversationSortMs = (conversation = {}, messages = []) =>
  normalizeTimestampMs(
    conversation.lastMessageAt ||
      conversation.last_message_at ||
      conversation.updatedAt ||
      conversation.updated_at ||
      messages?.[messages.length - 1]?.timestamp ||
      messages?.[messages.length - 1]?.created_at,
  );

export const isWhatsappSqliteStoreEnabled = () => WHATSAPP_SQLITE_STORE_ENABLED;

const openDb = () => {
  if (!isWhatsappSqliteStoreEnabled()) return null;
  if (db) return db;
  const resolvedPath = path.resolve(process.cwd(), config.sqlitePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  return db;
};

const ensureSchema = () => {
  const sqlite = openDb();
  if (!sqlite || schemaReady) return sqlite;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_conversations (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      phone TEXT,
      assigned_agent_id TEXT,
      queue_status TEXT,
      meta_route_key TEXT,
      last_message_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      conversation_id TEXT NOT NULL,
      id TEXT NOT NULL,
      payload TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL DEFAULT 0,
      type TEXT,
      status TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, id)
    );

    CREATE TABLE IF NOT EXISTS whatsapp_state (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_last_message
      ON whatsapp_conversations (last_message_at_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_assignment
      ON whatsapp_conversations (assigned_agent_id, queue_status);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_route
      ON whatsapp_conversations (meta_route_key);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_phone
      ON whatsapp_conversations (phone);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation_time
      ON whatsapp_messages (conversation_id, timestamp_ms ASC);
  `);
  schemaReady = true;
  return sqlite;
};

const tableCounts = (sqlite) => {
  const conversations = sqlite.prepare("SELECT COUNT(*) AS count FROM whatsapp_conversations").get()?.count || 0;
  const messages = sqlite.prepare("SELECT COUNT(*) AS count FROM whatsapp_messages").get()?.count || 0;
  return { conversations, messages };
};

const seedFromFallbackIfEmpty = async (sqlite, { fallbackLoader = null, seedIfEmpty = true } = {}) => {
  if (!seedIfEmpty || typeof fallbackLoader !== "function") return;
  const counts = tableCounts(sqlite);
  if (counts.conversations > 0 || counts.messages > 0) return;
  const legacy = normalizeStore(await fallbackLoader());
  if (Object.keys(legacy.conversations).length || Object.keys(legacy.messages).length) {
    await replaceWhatsappSqliteStore(legacy);
  }
};

const parseConversationRow = (row = {}) => {
  const payload = safeJsonParse(row.payload, null);
  if (!payload || typeof payload !== "object") return null;
  return {
    ...payload,
    id: String(payload.id || row.id || "").trim(),
  };
};

const parseMessageRow = (row = {}) => {
  const payload = safeJsonParse(row.payload, null);
  if (!payload || typeof payload !== "object") return null;
  return payload;
};

const upsertSession = (sqlite, session = {}) => {
  sqlite
    .prepare(
      `
        INSERT INTO whatsapp_state (key, payload, updated_at)
        VALUES ('session', @payload, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          payload = excluded.payload,
          updated_at = datetime('now')
      `,
    )
    .run({ payload: JSON.stringify(session || {}) });
};

const upsertConversation = (sqlite, conversationId, conversation, messages = []) => {
  const id = String(conversationId || conversation?.id || "").trim();
  if (!id) return;
  const payload = {
    ...conversation,
    id: String(conversation?.id || id),
  };
  sqlite
    .prepare(
      `
        INSERT INTO whatsapp_conversations (
          id,
          payload,
          phone,
          assigned_agent_id,
          queue_status,
          meta_route_key,
          last_message_at_ms,
          updated_at
        )
        VALUES (
          @id,
          @payload,
          @phone,
          @assignedAgentId,
          @queueStatus,
          @routeKey,
          @lastMessageAtMs,
          datetime('now')
        )
        ON CONFLICT(id) DO UPDATE SET
          payload = excluded.payload,
          phone = excluded.phone,
          assigned_agent_id = excluded.assigned_agent_id,
          queue_status = excluded.queue_status,
          meta_route_key = excluded.meta_route_key,
          last_message_at_ms = excluded.last_message_at_ms,
          updated_at = datetime('now')
      `,
    )
    .run({
      id,
      payload: JSON.stringify(payload),
      phone: String(payload.waId || payload.wa_id || payload.phone || payload.id || "").replace(/\D/g, "") || null,
      assignedAgentId: String(payload.assigned_agent_id || payload.assignedAgentId || "").trim() || null,
      queueStatus: String(payload.queue_status || payload.queueStatus || "").trim() || null,
      routeKey: String(payload.meta_route_key || payload.routeKey || "").trim() || null,
      lastMessageAtMs: conversationSortMs(payload, messages),
    });
};

const replaceMessagesForConversation = (sqlite, conversationId, messages = []) => {
  const id = String(conversationId || "").trim();
  if (!id) return;
  sqlite.prepare("DELETE FROM whatsapp_messages WHERE conversation_id = ?").run(id);
  const statement = sqlite.prepare(`
    INSERT INTO whatsapp_messages (
      conversation_id,
      id,
      payload,
      timestamp_ms,
      type,
      status,
      updated_at
    )
    VALUES (
      @conversationId,
      @id,
      @payload,
      @timestampMs,
      @type,
      @status,
      datetime('now')
    )
    ON CONFLICT(conversation_id, id) DO UPDATE SET
      payload = excluded.payload,
      timestamp_ms = excluded.timestamp_ms,
      type = excluded.type,
      status = excluded.status,
      updated_at = datetime('now')
  `);
  for (const [index, message] of (Array.isArray(messages) ? messages : []).entries()) {
    const messageId = String(message?.id || message?.messageId || `${id}-${index}`).trim();
    if (!messageId) continue;
    statement.run({
      conversationId: id,
      id: messageId,
      payload: JSON.stringify({ ...message, id: messageId }),
      timestampMs: normalizeTimestampMs(message?.timestamp || message?.created_at || message?.createdAt),
      type: String(message?.type || "").trim() || null,
      status: String(message?.status || "").trim() || null,
    });
  }
};

export const replaceWhatsappSqliteStore = async (store = {}) => {
  const sqlite = ensureSchema();
  if (!sqlite) return false;
  const normalized = normalizeStore(store);
  const replace = sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM whatsapp_messages").run();
    sqlite.prepare("DELETE FROM whatsapp_conversations").run();
    upsertSession(sqlite, normalized.session);
    for (const [conversationId, conversation] of Object.entries(normalized.conversations)) {
      const messages = Array.isArray(normalized.messages?.[conversationId])
        ? normalized.messages[conversationId]
        : [];
      upsertConversation(sqlite, conversationId, conversation, messages);
      replaceMessagesForConversation(sqlite, conversationId, messages);
    }
  });
  replace();
  return true;
};

export const writeWhatsappSqliteStore = async (
  store = {},
  { conversationIds = null, fullReplace = false } = {},
) => {
  const sqlite = ensureSchema();
  if (!sqlite) return false;
  const normalized = normalizeStore(store);
  if (fullReplace || !Array.isArray(conversationIds)) {
    return replaceWhatsappSqliteStore(normalized);
  }
  const ids = [...new Set(conversationIds.map((item) => String(item || "").trim()).filter(Boolean))];
  const write = sqlite.transaction(() => {
    upsertSession(sqlite, normalized.session);
    for (const conversationId of ids) {
      const conversation = normalized.conversations?.[conversationId];
      if (!conversation) {
        sqlite.prepare("DELETE FROM whatsapp_messages WHERE conversation_id = ?").run(conversationId);
        sqlite.prepare("DELETE FROM whatsapp_conversations WHERE id = ?").run(conversationId);
        continue;
      }
      const messages = Array.isArray(normalized.messages?.[conversationId])
        ? normalized.messages[conversationId]
        : [];
      upsertConversation(sqlite, conversationId, conversation, messages);
      replaceMessagesForConversation(sqlite, conversationId, messages);
    }
  });
  write();
  return true;
};

export const readWhatsappSqliteStore = async ({ fallbackLoader = null, seedIfEmpty = true } = {}) => {
  const sqlite = ensureSchema();
  if (!sqlite) return null;
  await seedFromFallbackIfEmpty(sqlite, { fallbackLoader, seedIfEmpty });

  const conversations = {};
  for (const row of sqlite
    .prepare("SELECT id, payload FROM whatsapp_conversations ORDER BY last_message_at_ms DESC")
    .all()) {
    const payload = parseConversationRow(row);
    if (payload) {
      conversations[String(row.id)] = payload;
    }
  }

  const messages = {};
  for (const row of sqlite
    .prepare("SELECT conversation_id, payload FROM whatsapp_messages ORDER BY conversation_id ASC, timestamp_ms ASC")
    .all()) {
    const payload = parseMessageRow(row);
    if (!payload) continue;
    const conversationId = String(row.conversation_id || "").trim();
    if (!conversationId) continue;
    messages[conversationId] = messages[conversationId] || [];
    messages[conversationId].push(payload);
  }

  const sessionRow = sqlite.prepare("SELECT payload FROM whatsapp_state WHERE key = 'session' LIMIT 1").get();
  const session = safeJsonParse(sessionRow?.payload, null) || {
    status: "disconnected",
    qrCode: null,
    lastConnectedAt: null,
    updatedAt: nowIso(),
  };

  return { conversations, messages, session };
};

export const listWhatsappSqliteConversations = async ({
  page = 1,
  limit = 50,
  fallbackLoader = null,
  seedIfEmpty = true,
} = {}) => {
  const sqlite = ensureSchema();
  if (!sqlite) return null;
  await seedFromFallbackIfEmpty(sqlite, { fallbackLoader, seedIfEmpty });

  const pagination = normalizePagination({ page, limit });
  const total = sqlite.prepare("SELECT COUNT(*) AS count FROM whatsapp_conversations").get()?.count || 0;
  const rows = sqlite
    .prepare(
      `
        SELECT id, payload
        FROM whatsapp_conversations
        ORDER BY last_message_at_ms DESC
        LIMIT @limit OFFSET @offset
      `,
    )
    .all({ limit: pagination.limit, offset: pagination.offset });

  const items = rows.map(parseConversationRow).filter(Boolean);
  return {
    items,
    page: pagination.page,
    limit: pagination.limit,
    total,
    hasMore: pagination.offset + pagination.limit < total,
  };
};

export const getWhatsappSqliteConversation = async (
  conversationId,
  { fallbackLoader = null, seedIfEmpty = true } = {},
) => {
  const sqlite = ensureSchema();
  if (!sqlite) return null;
  await seedFromFallbackIfEmpty(sqlite, { fallbackLoader, seedIfEmpty });
  const safeId = String(conversationId || "").trim();
  if (!safeId) return null;
  const row = sqlite
    .prepare("SELECT id, payload FROM whatsapp_conversations WHERE id = ? LIMIT 1")
    .get(safeId);
  return row ? parseConversationRow(row) : null;
};

export const listWhatsappSqliteConversationsByPhone = async (
  phone,
  { fallbackLoader = null, seedIfEmpty = true, limit = 20 } = {},
) => {
  const sqlite = ensureSchema();
  if (!sqlite) return null;
  await seedFromFallbackIfEmpty(sqlite, { fallbackLoader, seedIfEmpty });
  const safePhone = String(phone || "").replace(/\D/g, "");
  if (!safePhone) return [];
  const parsedLimit = Number.parseInt(String(limit || "20"), 10);
  const normalizedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 20;
  const rows = sqlite
    .prepare(
      `
        SELECT id, payload
        FROM whatsapp_conversations
        WHERE phone = @phone
        ORDER BY last_message_at_ms DESC
        LIMIT @limit
      `,
    )
    .all({ phone: safePhone, limit: normalizedLimit });
  return rows.map(parseConversationRow).filter(Boolean);
};

export const listWhatsappSqliteMessages = async (
  conversationId,
  { tail = 0, sinceMs = NaN, untilMs = NaN, fallbackLoader = null, seedIfEmpty = true } = {},
) => {
  const sqlite = ensureSchema();
  if (!sqlite) return null;
  await seedFromFallbackIfEmpty(sqlite, { fallbackLoader, seedIfEmpty });
  const safeConversationId = String(conversationId || "").trim();
  if (!safeConversationId) return [];

  const conditions = ["conversation_id = @conversationId"];
  const params = { conversationId: safeConversationId };
  if (Number.isFinite(sinceMs)) {
    conditions.push("timestamp_ms >= @sinceMs");
    params.sinceMs = sinceMs;
  }
  if (Number.isFinite(untilMs)) {
    conditions.push("timestamp_ms < @untilMs");
    params.untilMs = untilMs;
  }

  const normalizedTail = Number.isFinite(Number(tail)) && Number(tail) > 0
    ? Math.max(20, Math.min(2000, Number.parseInt(String(tail), 10)))
    : 0;
  const whereClause = conditions.join(" AND ");
  const rows = normalizedTail > 0
    ? sqlite
        .prepare(
          `
            SELECT payload
            FROM (
              SELECT payload, timestamp_ms
              FROM whatsapp_messages
              WHERE ${whereClause}
              ORDER BY timestamp_ms DESC
              LIMIT @tail
            )
            ORDER BY timestamp_ms ASC
          `,
        )
        .all({ ...params, tail: normalizedTail })
    : sqlite
        .prepare(
          `
            SELECT payload
            FROM whatsapp_messages
            WHERE ${whereClause}
            ORDER BY timestamp_ms ASC
          `,
        )
        .all(params);

  return rows.map(parseMessageRow).filter(Boolean);
};

export const markWhatsappSqliteConversationRead = async (
  conversationId,
  { readAt = nowIso(), conversationPatch = null, fallbackLoader = null, seedIfEmpty = true } = {},
) => {
  const sqlite = ensureSchema();
  if (!sqlite) return false;
  await seedFromFallbackIfEmpty(sqlite, { fallbackLoader, seedIfEmpty });
  const safeConversationId = String(conversationId || "").trim();
  if (!safeConversationId) return false;

  const conversationRow = sqlite
    .prepare("SELECT id, payload FROM whatsapp_conversations WHERE id = ? LIMIT 1")
    .get(safeConversationId);
  const conversation = conversationRow ? parseConversationRow(conversationRow) : null;
  let changed = false;

  const write = sqlite.transaction(() => {
    if (conversation) {
      conversation.unreadCount = 0;
      conversation.unread_count = 0;
      conversation.last_read_at = readAt;
      if (conversationPatch && typeof conversationPatch === "object") {
        Object.assign(conversation, conversationPatch);
      }
      sqlite
        .prepare(
          `
            UPDATE whatsapp_conversations
            SET payload = @payload, updated_at = datetime('now')
            WHERE id = @id
          `,
        )
        .run({ id: safeConversationId, payload: JSON.stringify(conversation) });
      changed = true;
    }

    const messageRows = sqlite
      .prepare("SELECT id, payload FROM whatsapp_messages WHERE conversation_id = ?")
      .all(safeConversationId);
    const updateMessage = sqlite.prepare(
      `
        UPDATE whatsapp_messages
        SET payload = @payload, updated_at = datetime('now')
        WHERE conversation_id = @conversationId AND id = @id
      `,
    );
    for (const row of messageRows) {
      const message = parseMessageRow(row);
      if (!message || message.isRead) continue;
      updateMessage.run({
        conversationId: safeConversationId,
        id: row.id,
        payload: JSON.stringify({ ...message, isRead: true }),
      });
      changed = true;
    }
  });
  write();
  return changed;
};

export const getWhatsappSqliteStoreStatus = () => {
  const sqlite = ensureSchema();
  if (!sqlite) {
    return { enabled: false, conversations: 0, messages: 0 };
  }
  return { enabled: true, ...tableCounts(sqlite) };
};
