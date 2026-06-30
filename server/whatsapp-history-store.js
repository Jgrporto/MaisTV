import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_HISTORY_DB_PATH = "server/data/maistv-history.sqlite";

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");

const resolveHistoryDbPath = () =>
  path.resolve(process.cwd(), process.env.WHATSAPP_HISTORY_DB_PATH || DEFAULT_HISTORY_DB_PATH);

let historyDb = null;

const ensureHistorySchema = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_messages (
      id TEXT PRIMARY KEY,
      legacy_conversation_id TEXT,
      phone TEXT NOT NULL,
      direction TEXT,
      payload TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      created_at TEXT,
      route_key TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_history_messages_phone_time
      ON history_messages (phone, timestamp_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_history_messages_conversation_time
      ON history_messages (legacy_conversation_id, timestamp_ms DESC);
  `);
};

export const openWhatsappHistoryStore = () => {
  if (historyDb) return historyDb;

  const dbPath = resolveHistoryDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  historyDb = new Database(dbPath);
  historyDb.pragma("journal_mode = WAL");
  historyDb.pragma("synchronous = NORMAL");
  ensureHistorySchema(historyDb);
  return historyDb;
};

export const closeWhatsappHistoryStore = () => {
  if (!historyDb) return;
  historyDb.close();
  historyDb = null;
};

export const upsertWhatsappHistoryMessage = (record = {}) => {
  const id = String(record.id || "").trim();
  const phone = normalizePhone(record.phone);
  const timestampMs = Number(record.timestampMs);
  const payload = record.payload && typeof record.payload === "object" ? record.payload : null;

  if (!id || !phone || !Number.isFinite(timestampMs) || !payload) {
    return false;
  }

  const db = openWhatsappHistoryStore();
  db.prepare(`
    INSERT INTO history_messages (
      id,
      legacy_conversation_id,
      phone,
      direction,
      payload,
      timestamp_ms,
      created_at,
      route_key
    )
    VALUES (
      @id,
      @legacyConversationId,
      @phone,
      @direction,
      @payload,
      @timestampMs,
      @createdAt,
      @routeKey
    )
    ON CONFLICT(id) DO UPDATE SET
      legacy_conversation_id = excluded.legacy_conversation_id,
      phone = excluded.phone,
      direction = excluded.direction,
      payload = excluded.payload,
      timestamp_ms = excluded.timestamp_ms,
      created_at = excluded.created_at,
      route_key = excluded.route_key
  `).run({
    id,
    legacyConversationId: String(record.legacyConversationId || "").trim() || null,
    phone,
    direction: String(record.direction || "").trim() || null,
    payload: JSON.stringify(payload),
    timestampMs,
    createdAt: String(record.createdAt || payload.created_at || payload.timestamp || "").trim() || null,
    routeKey: String(record.routeKey || "").trim() || null,
  });

  return true;
};

export const queryWhatsappHistoryMessages = ({
  phone,
  conversationId,
  until,
  limit = 1000,
  windowDays = 7,
} = {}) => {
  const safePhone = normalizePhone(phone);
  const safeConversationId = String(conversationId || "").trim();
  const safeLimit = Math.max(1, Math.min(2000, Number.parseInt(String(limit || 1000), 10) || 1000));
  const safeWindowDays = Math.max(1, Math.min(31, Number.parseInt(String(windowDays || 7), 10) || 7));
  const untilMs = until ? Date.parse(String(until)) : Date.now() + 60 * 1000;
  const safeUntilMs = Number.isFinite(untilMs) ? untilMs : Date.now() + 60 * 1000;

  if (!safePhone && !safeConversationId) {
    return { items: [], hasMore: false };
  }

  const db = openWhatsappHistoryStore();
  const whereClause = `
    (
      (@phone <> '' AND phone = @phone)
      OR (@conversationId <> '' AND legacy_conversation_id = @conversationId)
    )
  `;

  const anchor = db.prepare(`
    SELECT timestamp_ms
      FROM history_messages
     WHERE timestamp_ms < @untilMs
       AND ${whereClause}
     ORDER BY timestamp_ms DESC
     LIMIT 1
  `).get({
    phone: safePhone,
    conversationId: safeConversationId,
    untilMs: safeUntilMs,
  });

  if (!anchor) {
    return { items: [], hasMore: false };
  }

  const windowEndMs = Number(anchor.timestamp_ms);
  const windowStartMs = windowEndMs - safeWindowDays * 24 * 60 * 60 * 1000;
  const rows = db.prepare(`
    SELECT payload, timestamp_ms
      FROM history_messages
     WHERE timestamp_ms >= @windowStartMs
       AND timestamp_ms <= @windowEndMs
       AND ${whereClause}
     ORDER BY timestamp_ms ASC
     LIMIT @limit
  `).all({
    phone: safePhone,
    conversationId: safeConversationId,
    windowStartMs,
    windowEndMs,
    limit: safeLimit,
  });

  const hasOlder = db.prepare(`
    SELECT 1
      FROM history_messages
     WHERE timestamp_ms < @windowStartMs
       AND ${whereClause}
     LIMIT 1
  `).get({
    phone: safePhone,
    conversationId: safeConversationId,
    windowStartMs,
  });

  const items = rows
    .map((row) => {
      try {
        return JSON.parse(row.payload);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return {
    items,
    hasMore: Boolean(hasOlder),
    windowStartMs,
    windowEndMs,
  };
};
