import { query } from '../db/postgres.mjs';
export const listConversations = async ({ tenantId, status, limit, cursor, access }) => {
  const values = [tenantId];
  const where = ['c.tenant_id=$1'];
  if (access && !access.privileged) {
    values.push(access.userId || '', access.queueIds || []);
    const userParam = `$${values.length - 1}`;
    const queueParam = `$${values.length}`;
    where.push(`(c.assigned_agent_id=${userParam} OR c.queue_id=ANY(${queueParam}::text[]) OR c.service_id=ANY(${queueParam}::text[]))`);
  }
  if (status) { values.push(status); where.push(`c.status=$${values.length}`); }
  if (cursor) { values.push(cursor.at, cursor.id); where.push(`(COALESCE(c.last_message_at,c.created_at),c.id) < ($${values.length - 1}::timestamptz,$${values.length}::uuid)`); }
  values.push(limit + 1);
  const result = await query(`
    SELECT c.*,
      COALESCE(c.last_message_at,c.created_at) AS cursor_at,
      latest_inbound.last_received_at,
      COALESCE(c.unread_count,0) AS user_unread_count
    FROM conversations c
    LEFT JOIN LATERAL (
      SELECT m.created_at AS last_received_at
      FROM messages m
      WHERE m.tenant_id=c.tenant_id
        AND m.conversation_id=c.id
        AND m.direction='inbound'
      ORDER BY m.created_at DESC,m.id DESC
      LIMIT 1
    ) latest_inbound ON true
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(c.last_message_at,c.created_at) DESC,c.id DESC
    LIMIT $${values.length}
  `, values);
  return result.rows;
};
export const getConversation = async (tenantId, id, access = null) => {
  const values = [tenantId, id];
  let accessSql = '';
  if (access && !access.privileged) {
    values.push(access.userId || '', access.queueIds || []);
    accessSql = ' AND (assigned_agent_id=$3 OR queue_id=ANY($4::text[]) OR service_id=ANY($4::text[]))';
  }
  return (await query(`SELECT * FROM conversations WHERE tenant_id=$1 AND id=$2${accessSql}`, values)).rows[0] || null;
};
export const upsertInboundConversation = async (client, data) => (await client.query(`INSERT INTO conversations
  (tenant_id,contact_phone,contact_name,last_message,last_message_type,last_message_at,unread_count,
   queue_id,service_id,assigned_agent_id,assignment_status,route_key,phone_number_id,
   source_accounts_json,active_route_selector_json,default_route_selector_json)
  VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,CASE WHEN $9::text IS NOT NULL THEN 'assigned' WHEN $7::text IS NOT NULL THEN 'queued' ELSE 'unassigned' END,$10,$11,$12::jsonb,$13::jsonb,$13::jsonb)
  ON CONFLICT (tenant_id,contact_phone) DO UPDATE SET
  contact_name=COALESCE(NULLIF(EXCLUDED.contact_name,''),conversations.contact_name),
  queue_id=COALESCE(conversations.queue_id,EXCLUDED.queue_id),service_id=COALESCE(conversations.service_id,EXCLUDED.service_id),
  assigned_agent_id=COALESCE(conversations.assigned_agent_id,EXCLUDED.assigned_agent_id),
  assignment_status=CASE
    WHEN conversations.status='closed' OR conversations.assignment_status='closed' THEN 'closed'
    WHEN conversations.assigned_agent_id IS NOT NULL THEN conversations.assignment_status
    WHEN COALESCE(conversations.queue_id,EXCLUDED.queue_id) IS NOT NULL THEN 'queued'
    ELSE 'unassigned' END,
  route_key=COALESCE(EXCLUDED.route_key,conversations.route_key),phone_number_id=COALESCE(EXCLUDED.phone_number_id,conversations.phone_number_id),
  source_accounts_json=CASE WHEN EXCLUDED.source_accounts_json='[]'::jsonb THEN conversations.source_accounts_json ELSE EXCLUDED.source_accounts_json END,
  active_route_selector_json=COALESCE(EXCLUDED.active_route_selector_json,conversations.active_route_selector_json),
  default_route_selector_json=COALESCE(conversations.default_route_selector_json,EXCLUDED.default_route_selector_json),updated_at=now() RETURNING *`,
  [data.tenantId,data.contactPhone,data.contactName||null,data.body||null,data.type,data.createdAt,
    data.queueId||null,data.serviceId||null,data.assignedAgentId||null,data.routeKey||null,data.phoneNumberId||null,
    JSON.stringify(data.routeSelector?[data.routeSelector]:[]),data.routeSelector?JSON.stringify(data.routeSelector):null])).rows[0];
export const updateConversationLastMessage = async (client, conversationId, message) => client.query(`UPDATE conversations SET
  last_message_id=CASE WHEN last_message_at IS NULL OR $5>=last_message_at THEN $2 ELSE last_message_id END,
  last_message=CASE WHEN last_message_at IS NULL OR $5>=last_message_at THEN $3 ELSE last_message END,
  last_message_type=CASE WHEN last_message_at IS NULL OR $5>=last_message_at THEN $4 ELSE last_message_type END,
  last_message_at=GREATEST(COALESCE(last_message_at,$5),$5),unread_count=unread_count+1,updated_at=now()
  WHERE id=$1`, [conversationId, message.id, message.body, message.type, message.created_at]);
export const updateConversationLastOutbound = async (client, conversationId, message) => (await client.query(`UPDATE conversations SET
  last_message_id=CASE WHEN last_message_at IS NULL OR $5>=last_message_at THEN $2 ELSE last_message_id END,
  last_message=CASE WHEN last_message_at IS NULL OR $5>=last_message_at THEN $3 ELSE last_message END,
  last_message_type=CASE WHEN last_message_at IS NULL OR $5>=last_message_at THEN $4 ELSE last_message_type END,
  last_message_at=GREATEST(COALESCE(last_message_at,$5),$5),updated_at=now()
  WHERE id=$1 RETURNING *`,[conversationId,message.id,message.body,message.type,message.created_at])).rows[0];
export const markConversationReadGlobal = async (client,{tenantId,conversationId,lastReadMessageId,lastReadAt,userId}) =>
  (await client.query(`UPDATE conversations SET unread_count=0,manual_unread=false,last_read_message_id=$3,
    last_read_at=$4,last_read_by=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
  [tenantId,conversationId,lastReadMessageId||null,lastReadAt,userId||null])).rows[0]||null;
