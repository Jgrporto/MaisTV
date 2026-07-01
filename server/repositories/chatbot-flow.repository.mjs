import { query, withTransaction } from '../db/postgres.mjs';

const json = (value) => JSON.stringify(value ?? {});

const mapFlowRow = (row = {}) => ({
  id: String(row.id || ''),
  tenantId: String(row.tenant_id || ''),
  routeKey: row.route_key == null ? null : String(row.route_key),
  name: String(row.name || ''),
  description: row.description == null ? null : String(row.description),
  status: String(row.status || 'draft'),
  isActive: Boolean(row.is_active),
  priority: Number(row.priority || 100),
  triggerConfig: row.trigger_config && typeof row.trigger_config === 'object' ? row.trigger_config : {},
  currentVersionId: row.current_version_id == null ? null : String(row.current_version_id),
  createdBy: row.created_by == null ? null : String(row.created_by),
  updatedBy: row.updated_by == null ? null : String(row.updated_by),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapVersionRow = (row = {}) => ({
  id: String(row.id || ''),
  tenantId: String(row.tenant_id || ''),
  flowId: String(row.flow_id || ''),
  version: Number(row.version || 0),
  definition: row.definition && typeof row.definition === 'object' ? row.definition : {},
  checksum: String(row.checksum || ''),
  notes: row.notes == null ? null : String(row.notes),
  createdBy: row.created_by == null ? null : String(row.created_by),
  publishedAt: row.published_at,
  createdAt: row.created_at,
});

const mapSessionRow = (row = {}) => (row ? ({
  id: String(row.id || ''),
  tenantId: String(row.tenant_id || ''),
  conversationId: String(row.conversation_id || ''),
  flowId: row.flow_id == null ? null : String(row.flow_id),
  flowVersionId: row.flow_version_id == null ? null : String(row.flow_version_id),
  currentNodeId: row.current_node_id == null ? null : String(row.current_node_id),
  status: String(row.status || 'active'),
  state: row.state && typeof row.state === 'object' ? row.state : {},
  pausedReason: row.paused_reason == null ? null : String(row.paused_reason),
  pausedBy: row.paused_by == null ? null : String(row.paused_by),
  lastInboundMessageId: row.last_inbound_message_id == null ? null : String(row.last_inbound_message_id),
  lastOutboundMessageId: row.last_outbound_message_id == null ? null : String(row.last_outbound_message_id),
  lastInteractionAt: row.last_interaction_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
}) : null);

const mapFlowWithVersionRow = (row = {}) => ({
  ...mapFlowRow(row),
  version: row.version_id
    ? mapVersionRow({
        id: row.version_id,
        tenant_id: row.version_tenant_id || row.tenant_id,
        flow_id: row.version_flow_id || row.id,
        version: row.version,
        definition: row.definition,
        checksum: row.checksum,
        notes: row.version_notes,
        created_by: row.version_created_by,
        published_at: row.published_at,
        created_at: row.version_created_at,
      })
    : null,
});

export const listActiveChatbotFlows = async ({ tenantId, routeKey = null }) => {
  const result = await query(`
    SELECT f.*,
      v.id AS version_id,
      v.tenant_id AS version_tenant_id,
      v.flow_id AS version_flow_id,
      v.version,
      v.definition,
      v.checksum,
      v.notes AS version_notes,
      v.created_by AS version_created_by,
      v.published_at,
      v.created_at AS version_created_at
    FROM chatbot_flows f
    JOIN chatbot_flow_versions v ON v.id=f.current_version_id AND v.tenant_id=f.tenant_id
    WHERE f.tenant_id=$1
      AND f.status='published'
      AND f.is_active=true
      AND ($2::text IS NULL OR f.route_key IS NULL OR f.route_key=$2)
    ORDER BY
      CASE WHEN f.route_key=$2 THEN 0 WHEN f.route_key IS NULL THEN 1 ELSE 2 END,
      f.priority ASC,
      f.updated_at DESC,
      f.id ASC
  `, [tenantId, routeKey || null]);
  return result.rows.map(mapFlowWithVersionRow);
};

export const listChatbotFlows = async ({ tenantId, routeKey = null, includeArchived = false } = {}) => {
  const values = [tenantId];
  const where = ['f.tenant_id=$1'];
  if (routeKey) {
    values.push(routeKey);
    where.push(`f.route_key=$${values.length}`);
  }
  if (!includeArchived) {
    where.push("f.status<>'archived'");
  }
  const result = await query(`
    SELECT f.*,
      v.id AS version_id,
      v.tenant_id AS version_tenant_id,
      v.flow_id AS version_flow_id,
      v.version,
      v.definition,
      v.checksum,
      v.notes AS version_notes,
      v.created_by AS version_created_by,
      v.published_at,
      v.created_at AS version_created_at
    FROM chatbot_flows f
    LEFT JOIN chatbot_flow_versions v ON v.id=f.current_version_id AND v.tenant_id=f.tenant_id
    WHERE ${where.join(' AND ')}
    ORDER BY f.priority ASC, f.updated_at DESC, f.id ASC
  `, values);
  return result.rows.map(mapFlowWithVersionRow);
};

export const listChatbotFlowVersions = async ({ tenantId, flowId }) => {
  const result = await query(
    'SELECT * FROM chatbot_flow_versions WHERE tenant_id=$1 AND flow_id=$2 ORDER BY version DESC',
    [tenantId, flowId],
  );
  return result.rows.map(mapVersionRow);
};

export const findChatbotVersionByChecksum = async ({ tenantId, checksum }) => {
  const result = await query(`
    SELECT v.*, f.name AS flow_name, f.route_key
    FROM chatbot_flow_versions v
    JOIN chatbot_flows f ON f.tenant_id=v.tenant_id AND f.id=v.flow_id
    WHERE v.tenant_id=$1 AND v.checksum=$2
    ORDER BY v.created_at DESC
    LIMIT 1
  `, [tenantId, checksum]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...mapVersionRow(row),
    flowName: String(row.flow_name || ''),
    routeKey: row.route_key == null ? null : String(row.route_key),
  };
};

export const createChatbotFlowWithVersion = async ({
  tenantId,
  routeKey = null,
  name,
  description = null,
  status = 'draft',
  isActive = false,
  priority = 100,
  triggerConfig = {},
  definition = {},
  checksum,
  notes = null,
  createdBy = null,
  publish = false,
}) => withTransaction(async (client) => {
  const effectiveStatus = publish ? 'published' : status;
  const effectiveActive = publish ? Boolean(isActive) : false;
  const flowResult = await client.query(`
    INSERT INTO chatbot_flows (
      tenant_id, route_key, name, description, status, is_active, priority,
      trigger_config, created_by, updated_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9)
    RETURNING *
  `, [
    tenantId,
    routeKey || null,
    name,
    description,
    effectiveStatus,
    effectiveActive,
    Number(priority || 100),
    json(triggerConfig),
    createdBy || null,
  ]);
  const flow = mapFlowRow(flowResult.rows[0]);
  const versionResult = await client.query(`
    INSERT INTO chatbot_flow_versions (
      tenant_id, flow_id, version, definition, checksum, notes, created_by, published_at
    )
    VALUES ($1,$2,1,$3::jsonb,$4,$5,$6,CASE WHEN $7::boolean THEN now() ELSE NULL END)
    RETURNING *
  `, [
    tenantId,
    flow.id,
    json(definition),
    checksum,
    notes,
    createdBy || null,
    publish,
  ]);
  const version = mapVersionRow(versionResult.rows[0]);
  const updatedFlowResult = await client.query(`
    UPDATE chatbot_flows
    SET current_version_id=$3, updated_at=now()
    WHERE tenant_id=$1 AND id=$2
    RETURNING *
  `, [tenantId, flow.id, version.id]);
  return {
    ...mapFlowRow(updatedFlowResult.rows[0]),
    version,
  };
});

export const publishChatbotFlowVersion = async ({ tenantId, flowId, versionId, isActive = true, updatedBy = null }) => {
  const result = await withTransaction(async (client) => {
    await client.query(`
      UPDATE chatbot_flow_versions
      SET published_at=COALESCE(published_at, now())
      WHERE tenant_id=$1 AND flow_id=$2 AND id=$3
    `, [tenantId, flowId, versionId]);
    const flowResult = await client.query(`
      UPDATE chatbot_flows
      SET status='published',
        is_active=$4,
        current_version_id=$3,
        updated_by=$5,
        updated_at=now()
      WHERE tenant_id=$1 AND id=$2
      RETURNING *
    `, [tenantId, flowId, versionId, Boolean(isActive), updatedBy || null]);
    return flowResult.rows[0] ? mapFlowRow(flowResult.rows[0]) : null;
  });
  return result;
};

export const publishChatbotFlowForDryRun = async ({
  tenantId,
  flowId,
  routeKey,
  updatedBy = 'chatbot-publish-dry-run',
}) => withTransaction(async (client) => {
  const currentResult = await client.query(`
    SELECT *
    FROM chatbot_flows
    WHERE tenant_id=$1 AND id=$2
    FOR UPDATE
  `, [tenantId, flowId]);
  const current = currentResult.rows[0];
  if (!current?.current_version_id) return null;

  await client.query(`
    UPDATE chatbot_flow_versions
    SET published_at=COALESCE(published_at, now())
    WHERE tenant_id=$1 AND flow_id=$2 AND id=$3
  `, [tenantId, flowId, current.current_version_id]);

  const flowResult = await client.query(`
    UPDATE chatbot_flows
    SET status='published',
      is_active=true,
      route_key=$3,
      updated_by=$4,
      updated_at=now()
    WHERE tenant_id=$1 AND id=$2
    RETURNING *
  `, [tenantId, flowId, routeKey || null, updatedBy || null]);

  return flowResult.rows[0] ? mapFlowRow(flowResult.rows[0]) : null;
});

export const moveChatbotFlowToDraft = async ({
  tenantId,
  flowId,
  updatedBy = 'chatbot-publish-dry-run',
}) => {
  const result = await query(`
    UPDATE chatbot_flows
    SET status='draft',
      is_active=false,
      updated_by=$3,
      updated_at=now()
    WHERE tenant_id=$1 AND id=$2
    RETURNING *
  `, [tenantId, flowId, updatedBy || null]);
  return result.rows[0] ? mapFlowRow(result.rows[0]) : null;
};

export const upsertChatbotSession = async ({
  tenantId,
  conversationId,
  flowId = null,
  flowVersionId = null,
  currentNodeId = null,
  status = 'active',
  state = {},
  pausedReason = null,
  pausedBy = null,
  lastInboundMessageId = null,
  lastOutboundMessageId = null,
}, executor = null) => {
  const result = await (executor || { query }).query(`
    INSERT INTO chatbot_sessions (
      tenant_id, conversation_id, flow_id, flow_version_id, current_node_id,
      status, state, paused_reason, paused_by, last_inbound_message_id,
      last_outbound_message_id, last_interaction_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,now())
    ON CONFLICT (tenant_id, conversation_id) DO UPDATE SET
      flow_id=EXCLUDED.flow_id,
      flow_version_id=EXCLUDED.flow_version_id,
      current_node_id=EXCLUDED.current_node_id,
      status=EXCLUDED.status,
      state=EXCLUDED.state,
      paused_reason=EXCLUDED.paused_reason,
      paused_by=EXCLUDED.paused_by,
      last_inbound_message_id=EXCLUDED.last_inbound_message_id,
      last_outbound_message_id=EXCLUDED.last_outbound_message_id,
      last_interaction_at=now(),
      updated_at=now()
    RETURNING *
  `, [
    tenantId,
    conversationId,
    flowId,
    flowVersionId,
    currentNodeId,
    status,
    json(state),
    pausedReason,
    pausedBy,
    lastInboundMessageId,
    lastOutboundMessageId,
  ]);
  return mapSessionRow(result.rows[0]);
};

export const findChatbotSessionByConversation = async ({ tenantId, conversationId }) => {
  const result = await query(`
    SELECT *
    FROM chatbot_sessions
    WHERE tenant_id=$1 AND conversation_id=$2
    LIMIT 1
  `, [tenantId, conversationId]);
  return mapSessionRow(result.rows[0]);
};

export const findChatbotSessionByConversationForUpdate = async ({ tenantId, conversationId }, executor) => {
  const result = await executor.query(`
    SELECT *
    FROM chatbot_sessions
    WHERE tenant_id=$1 AND conversation_id=$2
    LIMIT 1
    FOR UPDATE
  `, [tenantId, conversationId]);
  return mapSessionRow(result.rows[0]);
};

export const recordChatbotEvent = async ({
  tenantId,
  conversationId = null,
  messageId = null,
  flowId = null,
  flowVersionId = null,
  sessionId = null,
  eventType,
  mode = 'dry-run',
  payload = {},
}, executor = null) => {
  const result = await (executor || { query }).query(`
    INSERT INTO chatbot_events (
      tenant_id, conversation_id, message_id, flow_id, flow_version_id,
      session_id, event_type, mode, payload
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    RETURNING *
  `, [
    tenantId,
    conversationId,
    messageId,
    flowId,
    flowVersionId,
    sessionId,
    eventType,
    mode,
    json(payload),
  ]);
  return result.rows[0] || null;
};
