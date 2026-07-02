import { query } from '../db/postgres.mjs';

export const getConversationRead = async ({ tenantId, conversationId, userId }, executor = null) =>
  (await (executor || { query }).query(
    `SELECT *
     FROM conversation_reads
     WHERE tenant_id=$1 AND conversation_id=$2 AND user_id=$3`,
    [tenantId, conversationId, userId],
  )).rows[0] || null;

export const findMessageReadCursor = async ({ tenantId, conversationId, messageId }, executor = null) => {
  if (!messageId) return null;
  return (await (executor || { query }).query(
    `SELECT id, created_at
     FROM messages
     WHERE tenant_id=$1 AND conversation_id=$2
       AND (id::text=$3 OR provider_message_id=$3)
     ORDER BY CASE WHEN id::text=$3 THEN 0 ELSE 1 END
     LIMIT 1`,
    [tenantId, conversationId, messageId],
  )).rows[0] || null;
};

export const findLatestConversationMessage = async ({ tenantId, conversationId }, executor = null) =>
  (await (executor || { query }).query(
    `SELECT id, created_at
     FROM messages
     WHERE tenant_id=$1 AND conversation_id=$2
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [tenantId, conversationId],
  )).rows[0] || null;

export const countUnreadForUser = async ({ tenantId, conversationId, userId }, executor = null) =>
  Number((await (executor || { query }).query(
    `SELECT COUNT(m.id)::int AS unread_count
     FROM messages m
     LEFT JOIN conversation_reads cr
       ON cr.tenant_id=m.tenant_id
      AND cr.conversation_id=m.conversation_id
      AND cr.user_id=$3
     WHERE m.tenant_id=$1
       AND m.conversation_id=$2
       AND m.direction='inbound'
       AND m.created_at > COALESCE(cr.last_read_at, '1970-01-01'::timestamptz)`,
    [tenantId, conversationId, userId],
  )).rows[0]?.unread_count || 0);

export const upsertConversationRead = async (
  { tenantId, conversationId, userId, lastReadMessageId, lastReadAt },
  executor = null,
) =>
  (await (executor || { query }).query(
    `INSERT INTO conversation_reads
       (tenant_id, conversation_id, user_id, last_read_message_id, last_read_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id, conversation_id, user_id)
     DO UPDATE SET
       last_read_message_id=CASE
         WHEN EXCLUDED.last_read_at >= conversation_reads.last_read_at THEN EXCLUDED.last_read_message_id
         ELSE conversation_reads.last_read_message_id
       END,
       last_read_at=GREATEST(conversation_reads.last_read_at, EXCLUDED.last_read_at),
       updated_at=now()
     RETURNING *`,
    [tenantId, conversationId, userId, lastReadMessageId || null, lastReadAt],
  )).rows[0];
