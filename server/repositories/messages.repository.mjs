import { query } from '../db/postgres.mjs';
export const listMessages = async ({ tenantId, conversationId, limit, cursor }) => {
  const values = [tenantId, conversationId];
  let cursorSql = '';
  if (cursor) { values.push(cursor.at, cursor.id); cursorSql = ` AND (created_at,id) < ($3::timestamptz,$4::uuid)`; }
  values.push(limit + 1);
  return (await query(`SELECT * FROM messages WHERE tenant_id=$1 AND conversation_id=$2${cursorSql} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`, values)).rows;
};
export const insertInboundMessage = async (client, data) => (await client.query(`INSERT INTO messages
  (tenant_id,conversation_id,provider_message_id,direction,sender_type,type,body,status,media_id,raw_json,created_at)
  VALUES ($1,$2,$3,'inbound','customer',$4,$5,'received',$6,$7::jsonb,$8)
  ON CONFLICT (tenant_id,provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING RETURNING *`,
  [data.tenantId,data.conversationId,data.providerMessageId,data.type,data.body || null,data.mediaId||null,JSON.stringify(data.raw),data.createdAt])).rows[0] || null;
export const insertPendingOutbound = async (data) => (await query(`INSERT INTO messages
  (tenant_id,conversation_id,client_message_id,direction,sender_type,type,body,status,raw_json)
  VALUES ($1,$2,$3,'outbound','agent',$4,$5,'pending',$6::jsonb)
  ON CONFLICT (tenant_id,client_message_id) DO UPDATE SET client_message_id=EXCLUDED.client_message_id RETURNING *`,
  [data.tenantId,data.conversationId,data.clientMessageId,data.type,data.body || null,JSON.stringify(data.raw || {})])).rows[0];
export const findMessageById = async (tenantId, id) => (await query('SELECT * FROM messages WHERE tenant_id=$1 AND id=$2', [tenantId,id])).rows[0] || null;
export const claimMessageForSending = async (tenantId,id) => (await query("UPDATE messages SET status='sending' WHERE tenant_id=$1 AND id=$2 AND status='pending' RETURNING *",[tenantId,id])).rows[0]||null;
export const resetMessagePending = async (tenantId,id) => query("UPDATE messages SET status='pending' WHERE tenant_id=$1 AND id=$2 AND status='sending'",[tenantId,id]);
export const markMessageSent = async (tenantId, id, providerMessageId) => query("UPDATE messages SET provider_message_id=$3,status='sent',sent_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId,id,providerMessageId]);
export const recordStatus = async ({ tenantId, providerMessageId, status, raw }) => query(`WITH target AS (SELECT id FROM messages WHERE tenant_id=$1 AND provider_message_id=$2)
  INSERT INTO message_statuses (tenant_id,message_id,provider_message_id,status,raw_json) SELECT $1,id,$2,$3,$4::jsonb FROM target
  ON CONFLICT (tenant_id,provider_message_id,status) DO NOTHING`, [tenantId,providerMessageId,status,JSON.stringify(raw || {})]);
export const applyStatus = async ({ tenantId, providerMessageId, status }) => query(`UPDATE messages SET status=$3,
  sent_at=CASE WHEN $3='sent' THEN COALESCE(sent_at,now()) ELSE sent_at END,
  delivered_at=CASE WHEN $3='delivered' THEN COALESCE(delivered_at,now()) ELSE delivered_at END,
  read_at=CASE WHEN $3='read' THEN COALESCE(read_at,now()) ELSE read_at END
  WHERE tenant_id=$1 AND provider_message_id=$2
    AND CASE $3 WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE -1 END
      >= CASE status WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE -1 END
  RETURNING *`, [tenantId,providerMessageId,status]);
