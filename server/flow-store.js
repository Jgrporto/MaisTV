import "dotenv/config";
import { Pool } from "pg";

const parseBooleanEnv = (value, defaultValue = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === "true" || normalized === "1" || normalized === "yes";
};

const sanitizeIdentifier = (value, fallback) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (!/^[a-z_][a-z0-9_]*$/.test(normalized)) return fallback;
  return normalized;
};

const connectionString =
  String(process.env.SQL_STORE_DATABASE_URL || process.env.DATABASE_URL || "").trim();
const sqlSchema = sanitizeIdentifier(
  process.env.FLOWS_SQL_SCHEMA || process.env.SQL_STORE_SCHEMA,
  "public",
);
const flowsTableRef = `"${sqlSchema}"."flows"`;
const flowRunsTableRef = `"${sqlSchema}"."flow_runs"`;
const flowSessionsTableRef = `"${sqlSchema}"."flow_sessions"`;
const SQL_SSL = parseBooleanEnv(process.env.SQL_STORE_SSL);

let pool = null;
let initPromise = null;

const isEnabled = () => Boolean(connectionString);

export const isFlowStoreEnabled = () => isEnabled();

const createPool = () => {
  if (!isEnabled()) {
    throw new Error("DATABASE_URL or SQL_STORE_DATABASE_URL is required for flows");
  }
  if (pool) return pool;
  pool = new Pool({
    connectionString,
    ssl: SQL_SSL ? { rejectUnauthorized: false } : false,
    max: 6,
  });
  pool.on("error", (error) => {
    console.error("[flow-store] pool error:", error?.message || error);
  });
  return pool;
};

const nowIso = () => new Date().toISOString();

const normalizeFlowStatus = (value) =>
  String(value || "").trim().toLowerCase() === "active" ? "active" : "inactive";

const normalizeTriggerType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "contains" || normalized === "equals" || normalized === "multiple") {
    return normalized;
  }
  return "contains";
};

const normalizeFlowNode = (node, index = 0) => ({
  id: String(node?.id || `node-${Date.now()}-${index}`),
  type: String(node?.type || "action").trim().toLowerCase(),
  label: String(node?.label || node?.type || `Bloco ${index + 1}`).trim(),
  x: Number.isFinite(Number(node?.x)) ? Number(node.x) : 0,
  y: Number.isFinite(Number(node?.y)) ? Number(node.y) : 0,
  config: node?.config && typeof node.config === "object" ? node.config : {},
});

const normalizeFlowConnection = (connection, index = 0) => ({
  from: String(connection?.from || "").trim(),
  to: String(connection?.to || "").trim(),
  label: String(connection?.label || "").trim(),
  id: String(connection?.id || `conn-${Date.now()}-${index}`),
});

const uniqueStrings = (items) =>
  [...new Set((Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean))];

const normalizeFlowPayload = (input, existing = null) => {
  const name = String(input?.name || existing?.name || "").trim();
  if (!name) {
    throw new Error("Flow name is required");
  }

  const nodesSource = Array.isArray(input?.nodes)
    ? input.nodes
    : Array.isArray(existing?.nodes)
      ? existing.nodes
      : [];
  const connectionsSource = Array.isArray(input?.connections)
    ? input.connections
    : Array.isArray(existing?.connections)
      ? existing.connections
      : [];

  const nodes = nodesSource.map((node, index) => normalizeFlowNode(node, index));
  const connections = connectionsSource
    .map((connection, index) => normalizeFlowConnection(connection, index))
    .filter((connection) => connection.from && connection.to);

  const triggerNode = nodes.find((node) => node.type === "trigger") || null;
  const fallbackKeywords = uniqueStrings(
    Array.isArray(triggerNode?.config?.keywords) ? triggerNode.config.keywords : [],
  );

  return {
    id: String(
      input?.id || existing?.id || `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ),
    name,
    status: normalizeFlowStatus(input?.status ?? existing?.status),
    priority: Number.isFinite(Number(input?.priority))
      ? Number(input.priority)
      : Number.isFinite(Number(existing?.priority))
        ? Number(existing.priority)
        : 0,
    trigger_keywords: uniqueStrings(
      Array.isArray(input?.trigger_keywords)
        ? input.trigger_keywords
        : Array.isArray(existing?.trigger_keywords)
          ? existing.trigger_keywords
          : fallbackKeywords,
    ),
    trigger_type: normalizeTriggerType(
      input?.trigger_type ?? existing?.trigger_type ?? triggerNode?.config?.match_type,
    ),
    nodes,
    connections,
    builderState:
      input?.builderState && typeof input.builderState === "object"
        ? input.builderState
        : existing?.builderState && typeof existing.builderState === "object"
          ? existing.builderState
          : { flow: [], variaveis: {}, atalhos: [], bot: [] },
    createdAt: existing?.createdAt || nowIso(),
  };
};

const mapFlowRow = (row) => ({
  id: String(row.id),
  name: String(row.name),
  status: normalizeFlowStatus(row.status),
  priority: Number(row.priority || 0),
  trigger_keywords: Array.isArray(row.trigger_keywords) ? row.trigger_keywords.map((item) => String(item || "")) : [],
  trigger_type: normalizeTriggerType(row.trigger_type),
  nodes: Array.isArray(row.nodes) ? row.nodes : [],
  connections: Array.isArray(row.connections) ? row.connections : [],
  builderState:
    row.builder_state && typeof row.builder_state === "object"
      ? row.builder_state
      : { flow: [], variaveis: {}, atalhos: [], bot: [] },
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : nowIso(),
});

export const ensureFlowStoreReady = async () => {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const client = await createPool().connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${sqlSchema}"`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${flowsTableRef} (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'inactive',
          priority INTEGER NOT NULL DEFAULT 0,
          trigger_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
          trigger_type TEXT NOT NULL DEFAULT 'contains',
          nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
          connections JSONB NOT NULL DEFAULT '[]'::jsonb,
          builder_state JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`ALTER TABLE ${flowsTableRef} ADD COLUMN IF NOT EXISTS builder_state JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${flowRunsTableRef} (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL REFERENCES ${flowsTableRef}(id) ON DELETE CASCADE,
          channel TEXT NOT NULL DEFAULT 'support',
          conversation_id TEXT,
          wa_id TEXT,
          message_id TEXT NOT NULL,
          input_text TEXT,
          matched_keyword TEXT,
          status TEXT NOT NULL DEFAULT 'processing',
          trace JSONB NOT NULL DEFAULT '[]'::jsonb,
          error_message TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(flow_id, channel, message_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${flowSessionsTableRef} (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL REFERENCES ${flowsTableRef}(id) ON DELETE CASCADE,
          channel TEXT NOT NULL DEFAULT 'support',
          conversation_id TEXT,
          wa_id TEXT,
          current_node_id TEXT NOT NULL,
          wait_type TEXT NOT NULL,
          variables JSONB NOT NULL DEFAULT '{}'::jsonb,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL DEFAULT 'waiting',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS flows_status_priority_idx ON ${flowsTableRef}(status, priority, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS flow_runs_message_idx ON ${flowRunsTableRef}(message_id, channel)`);
      await client.query(`CREATE INDEX IF NOT EXISTS flow_sessions_lookup_idx ON ${flowSessionsTableRef}(channel, wa_id, conversation_id, status, updated_at DESC)`);
      return true;
    } finally {
      client.release();
    }
  })();

  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
};

export const listFlows = async () => {
  await ensureFlowStoreReady();
  const { rows } = await createPool().query(
    `SELECT * FROM ${flowsTableRef} ORDER BY priority ASC, updated_at DESC, name ASC`,
  );
  return rows.map(mapFlowRow);
};

export const createFlow = async (payload) => {
  await ensureFlowStoreReady();
  const normalized = normalizeFlowPayload(payload, null);
  const { rows } = await createPool().query(
    `
      INSERT INTO ${flowsTableRef} (
        id, name, status, priority, trigger_keywords, trigger_type, nodes, connections, builder_state, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, NOW(), NOW())
      RETURNING *
    `,
    [
      normalized.id,
      normalized.name,
      normalized.status,
      normalized.priority,
      JSON.stringify(normalized.trigger_keywords),
      normalized.trigger_type,
      JSON.stringify(normalized.nodes),
      JSON.stringify(normalized.connections),
      JSON.stringify(normalized.builderState || {}),
    ],
  );
  return mapFlowRow(rows[0]);
};

export const updateFlowById = async (id, payload) => {
  await ensureFlowStoreReady();
  const { rows: currentRows } = await createPool().query(
    `SELECT * FROM ${flowsTableRef} WHERE id = $1 LIMIT 1`,
    [String(id || "").trim()],
  );
  if (!currentRows.length) {
    throw new Error("Flow not found");
  }
  const normalized = normalizeFlowPayload(payload, mapFlowRow(currentRows[0]));
  const { rows } = await createPool().query(
    `
      UPDATE ${flowsTableRef}
      SET
        name = $2,
        status = $3,
        priority = $4,
        trigger_keywords = $5::jsonb,
        trigger_type = $6,
        nodes = $7::jsonb,
        connections = $8::jsonb,
        builder_state = $9::jsonb,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      normalized.id,
      normalized.name,
      normalized.status,
      normalized.priority,
      JSON.stringify(normalized.trigger_keywords),
      normalized.trigger_type,
      JSON.stringify(normalized.nodes),
      JSON.stringify(normalized.connections),
      JSON.stringify(normalized.builderState || {}),
    ],
  );
  return mapFlowRow(rows[0]);
};

export const deleteFlowById = async (id) => {
  await ensureFlowStoreReady();
  const { rowCount } = await createPool().query(
    `DELETE FROM ${flowsTableRef} WHERE id = $1`,
    [String(id || "").trim()],
  );
  return rowCount > 0;
};

export const normalizeFlowMatchInput = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const doesKeywordMatch = (text, keyword, triggerType) => {
  const normalizedText = normalizeFlowMatchInput(text);
  const normalizedKeyword = normalizeFlowMatchInput(keyword);
  if (!normalizedText || !normalizedKeyword) return false;
  if (triggerType === "equals") return normalizedText === normalizedKeyword;
  return normalizedText.includes(normalizedKeyword);
};

export const findMatchingFlowForText = async (text) => {
  const flows = (await listFlows()).filter((flow) => flow.status === "active");
  let selected = null;
  for (const flow of flows) {
    const keywords = uniqueStrings(flow.trigger_keywords);
    const matchedKeyword = keywords.find((keyword) =>
      doesKeywordMatch(text, keyword, flow.trigger_type),
    );
    if (!matchedKeyword) continue;
    const candidate = { flow, matchedKeyword };
    if (!selected) {
      selected = candidate;
      continue;
    }
    const currentPriority = Number(selected.flow.priority || 0);
    const nextPriority = Number(flow.priority || 0);
    if (nextPriority < currentPriority) {
      selected = candidate;
      continue;
    }
    if (
      nextPriority === currentPriority &&
      matchedKeyword.length > String(selected.matchedKeyword || "").length
    ) {
      selected = candidate;
    }
  }
  return selected;
};

export const claimFlowRun = async ({
  flowId,
  channel = "support",
  conversationId = null,
  waId = null,
  messageId,
  inputText = "",
  matchedKeyword = "",
}) => {
  await ensureFlowStoreReady();
  const id = `flow-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await createPool().query(
    `
      INSERT INTO ${flowRunsTableRef} (
        id, flow_id, channel, conversation_id, wa_id, message_id, input_text, matched_keyword, status, trace, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'processing', '[]'::jsonb, NOW(), NOW())
      ON CONFLICT (flow_id, channel, message_id) DO NOTHING
      RETURNING id
    `,
    [id, flowId, channel, conversationId, waId, messageId, String(inputText || ""), String(matchedKeyword || "")],
  );
  return rows[0]?.id ? String(rows[0].id) : null;
};

export const completeFlowRun = async (id, { status = "completed", trace = [], errorMessage = null } = {}) => {
  if (!id) return false;
  await ensureFlowStoreReady();
  await createPool().query(
    `
      UPDATE ${flowRunsTableRef}
      SET status = $2, trace = $3::jsonb, error_message = $4, updated_at = NOW()
      WHERE id = $1
    `,
    [id, String(status || "completed"), JSON.stringify(Array.isArray(trace) ? trace : []), errorMessage ? String(errorMessage) : null],
  );
  return true;
};

const mapFlowRunRow = (row) => ({
  id: String(row.id),
  flowId: String(row.flow_id),
  channel: String(row.channel || "support"),
  conversationId: row.conversation_id ? String(row.conversation_id) : null,
  waId: row.wa_id ? String(row.wa_id) : null,
  messageId: row.message_id ? String(row.message_id) : null,
  inputText: String(row.input_text || ""),
  matchedKeyword: String(row.matched_keyword || ""),
  status: String(row.status || "processing"),
  trace: Array.isArray(row.trace) ? row.trace : [],
  errorMessage: row.error_message ? String(row.error_message) : null,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : nowIso(),
});

export const listFlowRunsByConversation = async ({
  channel = "support",
  conversationId = null,
  waId = null,
  limit = 20,
}) => {
  await ensureFlowStoreReady();
  const normalizedConversationId = conversationId ? String(conversationId).trim() : null;
  const normalizedWaId = waId ? String(waId).trim() : null;
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 20)));
  const { rows } = await createPool().query(
    `
      SELECT *
      FROM ${flowRunsTableRef}
      WHERE channel = $1
        AND (
          ($2::text IS NOT NULL AND conversation_id = $2)
          OR
          ($3::text IS NOT NULL AND wa_id = $3)
        )
      ORDER BY created_at DESC
      LIMIT $4
    `,
    [String(channel || "support"), normalizedConversationId, normalizedWaId, safeLimit],
  );
  return rows.map(mapFlowRunRow);
};

const mapFlowSessionRow = (row) => ({
  id: String(row.id),
  flowId: String(row.flow_id),
  channel: String(row.channel || "support"),
  conversationId: row.conversation_id ? String(row.conversation_id) : null,
  waId: row.wa_id ? String(row.wa_id) : null,
  currentNodeId: String(row.current_node_id),
  waitType: String(row.wait_type),
  variables: row.variables && typeof row.variables === "object" ? row.variables : {},
  metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  status: String(row.status || "waiting"),
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : nowIso(),
});

export const getActiveFlowSession = async ({
  channel = "support",
  conversationId = null,
  waId = null,
}) => {
  await ensureFlowStoreReady();
  const normalizedConversationId = conversationId ? String(conversationId).trim() : null;
  const normalizedWaId = waId ? String(waId).trim() : null;
  const { rows } = await createPool().query(
    `
      SELECT *
      FROM ${flowSessionsTableRef}
      WHERE channel = $1
        AND status = 'waiting'
        AND (
          ($2::text IS NOT NULL AND conversation_id = $2)
          OR
          ($3::text IS NOT NULL AND wa_id = $3)
        )
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [String(channel || "support"), normalizedConversationId, normalizedWaId],
  );
  return rows[0] ? mapFlowSessionRow(rows[0]) : null;
};

export const saveFlowSession = async ({
  id = null,
  flowId,
  channel = "support",
  conversationId = null,
  waId = null,
  currentNodeId,
  waitType,
  variables = {},
  metadata = {},
  status = "waiting",
}) => {
  await ensureFlowStoreReady();
  const sessionId = id ? String(id) : `flow-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedChannel = String(channel || "support");
  const normalizedConversationId = conversationId ? String(conversationId).trim() : null;
  const normalizedWaId = waId ? String(waId).trim() : null;
  const { rows } = await createPool().query(
    `
      INSERT INTO ${flowSessionsTableRef} (
        id, flow_id, channel, conversation_id, wa_id, current_node_id, wait_type, variables, metadata, status, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE
      SET
        flow_id = EXCLUDED.flow_id,
        channel = EXCLUDED.channel,
        conversation_id = EXCLUDED.conversation_id,
        wa_id = EXCLUDED.wa_id,
        current_node_id = EXCLUDED.current_node_id,
        wait_type = EXCLUDED.wait_type,
        variables = EXCLUDED.variables,
        metadata = EXCLUDED.metadata,
        status = EXCLUDED.status,
        updated_at = NOW()
      RETURNING *
    `,
    [
      sessionId,
      String(flowId),
      normalizedChannel,
      normalizedConversationId,
      normalizedWaId,
      String(currentNodeId || ""),
      String(waitType || ""),
      JSON.stringify(variables && typeof variables === "object" ? variables : {}),
      JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}),
      String(status || "waiting"),
    ],
  );
  return mapFlowSessionRow(rows[0]);
};

export const closeFlowSession = async (id, status = "completed") => {
  if (!id) return false;
  await ensureFlowStoreReady();
  await createPool().query(
    `
      UPDATE ${flowSessionsTableRef}
      SET status = $2, updated_at = NOW()
      WHERE id = $1
    `,
    [String(id), String(status || "completed")],
  );
  return true;
};
