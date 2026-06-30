import { query } from '../db/postgres.mjs';
export const listConversations = async ({ tenantId, status, limit, cursor, access }) => {
  const values = [tenantId];
  const where = ['tenant_id=$1'];
  if (access && !access.privileged) {
    values.push(access.userId || '');
    const userParam = `$${values.length}`;
    values.push(access.queueIds || []);
    const queueParam = `$${values.length}`;
    where.push(`(assigned_agent_id=${userParam} OR queue_id=ANY(${queueParam}::text[]) OR service_id=ANY(${queueParam}::text[]))`);
  }
  if (status) { values.push(status); where.push(`status=$${values.length}`); }
  if (cursor) { values.push(cursor.at, cursor.id); where.push(`(COALESCE(last_message_at,created_at),id) < ($${values.length - 1}::timestamptz,$${values.length}::uuid)`); }
  values.push(limit + 1);
  const result = await query(`SELECT *, COALESCE(last_message_at,created_at) AS cursor_at FROM conversations WHERE ${where.join(' AND ')} ORDER BY COALESCE(last_message_at,created_at) DESC,id DESC LIMIT $${values.length}`, values);
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
  (tenant_id,contact_phone,contact_name,last_message,last_message_type,last_message_at,unread_count)
  VALUES ($1,$2,$3,$4,$5,$6,0) ON CONFLICT (tenant_id,contact_phone) DO UPDATE SET
  contact_name=COALESCE(NULLIF(EXCLUDED.contact_name,''),conversations.contact_name),updated_at=now() RETURNING *`,
  [data.tenantId, data.contactPhone, data.contactName || null, data.body || null, data.type, data.createdAt])).rows[0];
export const updateConversationLastMessage = async (client, conversationId, message) => client.query(`UPDATE conversations SET
  last_message_id=CASE WHEN last_message_at IS NULL OR $5>=last_message_at THEN $2 ELSE last_message_id END,
  last_message=CASE WHEN last_message_at IS NULL OR $5>=last_message_at THEN $3 ELSE last_message END,
  last_message_type=CASE WHEN last_message_at IS NULL OR $5>=last_message_at THEN $4 ELSE last_message_type END,
  last_message_at=GREATEST(COALESCE(last_message_at,$5),$5),unread_count=unread_count+1,updated_at=now()
  WHERE id=$1`, [conversationId, message.id, message.body, message.type, message.created_at]);
