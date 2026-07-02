import { query } from '../db/postgres.mjs';
export const listConversations = async ({ tenantId, status, limit, cursor, access }) => {
  const values = [tenantId];
  const where = ['c.tenant_id=$1'];
  if (access && !access.privileged) {
    values.push(access.userId || '', access.queueOrServiceIds || access.queueIds || []);
    const userParam = `$${values.length - 1}`;
    const accessParam = `$${values.length}`;
    where.push(`(c.assigned_agent_id=${userParam} OR c.queue_id=ANY(${accessParam}::text[]) OR c.service_id=ANY(${accessParam}::text[]))`);
  }
  if (status) { values.push(status); where.push(`c.status=$${values.length}`); }
  if (cursor) { values.push(cursor.at, cursor.id); where.push(`(COALESCE(c.last_message_at,c.created_at),c.id) < ($${values.length - 1}::timestamptz,$${values.length}::uuid)`); }
  values.push(limit + 1);
  const result = await query(`
    SELECT c.*,
      COALESCE(c.last_message_at,c.created_at) AS cursor_at,
      c.last_customer_message_at AS last_received_at,
      COALESCE(c.unread_count,0) AS user_unread_count
    FROM conversations c
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
    values.push(access.userId || '', access.queueOrServiceIds || access.queueIds || []);
    accessSql = ' AND (assigned_agent_id=$3 OR queue_id=ANY($4::text[]) OR service_id=ANY($4::text[]))';
  }
  return (await query(`SELECT * FROM conversations WHERE tenant_id=$1 AND id=$2${accessSql}`, values)).rows[0] || null;
};
export const upsertInboundConversation = async (client, data) => (await client.query(`INSERT INTO conversations
  (tenant_id,contact_phone,normalized_phone,contact_name,last_message,last_message_type,last_message_at,unread_count,
   queue_id,service_id,assigned_agent_id,assignment_status,route_key,phone_number_id,
   last_inbound_route_key,last_inbound_phone_number_id,last_customer_message_at,last_24h_window_expires_at,
   standard_label,standard_label_source,standard_label_reason,standard_label_overridden,standard_label_updated_at,
   source_accounts_json,active_route_selector_json,default_route_selector_json)
  VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,CASE WHEN $10::text IS NOT NULL THEN 'assigned' WHEN $8::text IS NOT NULL THEN 'queued' ELSE 'unassigned' END,$11,$12,
    $11,$12,$7,$7::timestamptz + interval '24 hours',$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$19::jsonb)
  ON CONFLICT (tenant_id,normalized_phone) WHERE normalized_phone IS NOT NULL DO UPDATE SET
  contact_phone=EXCLUDED.contact_phone,
  contact_name=COALESCE(NULLIF(EXCLUDED.contact_name,''),conversations.contact_name),
  queue_id=CASE WHEN EXCLUDED.last_customer_message_at>=COALESCE(conversations.last_customer_message_at,'-infinity'::timestamptz) THEN EXCLUDED.queue_id ELSE conversations.queue_id END,
  service_id=CASE WHEN EXCLUDED.last_customer_message_at>=COALESCE(conversations.last_customer_message_at,'-infinity'::timestamptz) THEN EXCLUDED.service_id ELSE conversations.service_id END,
  assigned_agent_id=COALESCE(conversations.assigned_agent_id,EXCLUDED.assigned_agent_id),
  assignment_status=CASE
    WHEN conversations.status='closed' OR conversations.assignment_status='closed' THEN 'closed'
    WHEN conversations.assigned_agent_id IS NOT NULL THEN conversations.assignment_status
    WHEN (CASE WHEN EXCLUDED.last_customer_message_at>=COALESCE(conversations.last_customer_message_at,'-infinity'::timestamptz) THEN EXCLUDED.queue_id ELSE conversations.queue_id END) IS NOT NULL THEN 'queued'
    ELSE 'unassigned' END,
  route_key=CASE WHEN EXCLUDED.last_customer_message_at>=COALESCE(conversations.last_customer_message_at,'-infinity'::timestamptz) THEN EXCLUDED.route_key ELSE conversations.route_key END,
  phone_number_id=CASE WHEN EXCLUDED.last_customer_message_at>=COALESCE(conversations.last_customer_message_at,'-infinity'::timestamptz) THEN EXCLUDED.phone_number_id ELSE conversations.phone_number_id END,
  last_inbound_route_key=CASE WHEN EXCLUDED.last_customer_message_at>=COALESCE(conversations.last_customer_message_at,'-infinity'::timestamptz) THEN EXCLUDED.last_inbound_route_key ELSE conversations.last_inbound_route_key END,
  last_inbound_phone_number_id=CASE WHEN EXCLUDED.last_customer_message_at>=COALESCE(conversations.last_customer_message_at,'-infinity'::timestamptz) THEN EXCLUDED.last_inbound_phone_number_id ELSE conversations.last_inbound_phone_number_id END,
  last_customer_message_at=GREATEST(COALESCE(conversations.last_customer_message_at,EXCLUDED.last_customer_message_at),EXCLUDED.last_customer_message_at),
  last_24h_window_expires_at=GREATEST(COALESCE(conversations.last_24h_window_expires_at,EXCLUDED.last_24h_window_expires_at),EXCLUDED.last_24h_window_expires_at),
  standard_label=EXCLUDED.standard_label,standard_label_source=EXCLUDED.standard_label_source,
  standard_label_reason=EXCLUDED.standard_label_reason,standard_label_overridden=EXCLUDED.standard_label_overridden,
  standard_label_updated_at=EXCLUDED.standard_label_updated_at,
  source_accounts_json=CASE WHEN EXCLUDED.source_accounts_json='[]'::jsonb THEN conversations.source_accounts_json ELSE (
    SELECT COALESCE(jsonb_agg(account),'[]'::jsonb)
    FROM (SELECT DISTINCT account FROM jsonb_array_elements(conversations.source_accounts_json || EXCLUDED.source_accounts_json) AS items(account)) unique_accounts
  ) END,
  active_route_selector_json=CASE WHEN EXCLUDED.last_customer_message_at>=COALESCE(conversations.last_customer_message_at,'-infinity'::timestamptz) THEN COALESCE(EXCLUDED.active_route_selector_json,conversations.active_route_selector_json) ELSE conversations.active_route_selector_json END,
  default_route_selector_json=COALESCE(conversations.default_route_selector_json,EXCLUDED.default_route_selector_json),updated_at=now() RETURNING *`,
  [data.tenantId,data.contactPhone,data.normalizedPhone,data.contactName||null,data.body||null,data.type,data.createdAt,
    data.queueId||null,data.serviceId||data.queueId||null,data.assignedAgentId||null,data.routeKey||null,data.phoneNumberId||null,
    data.standardLabel||null,data.standardLabelSource||null,data.standardLabelReason||null,Boolean(data.standardLabelOverridden),data.standardLabelUpdatedAt||null,
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
