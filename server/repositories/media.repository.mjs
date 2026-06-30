import { query } from '../db/postgres.mjs';
export const getMedia = async (tenantId, id) => (await query(`SELECT media_files.*,conversations.assigned_agent_id,conversations.queue_id,conversations.service_id
  FROM media_files JOIN conversations ON conversations.id=media_files.conversation_id AND conversations.tenant_id=media_files.tenant_id
  WHERE media_files.tenant_id=$1 AND media_files.id=$2`, [tenantId,id])).rows[0] || null;
export const upsertMediaMetadata = async (client, data) => (await client.query(`INSERT INTO media_files
  (tenant_id,provider_media_id,conversation_id,type,mime_type,status) VALUES ($1,$2,$3,$4,$5,'pending')
  ON CONFLICT (tenant_id,provider_media_id) DO UPDATE SET mime_type=COALESCE(EXCLUDED.mime_type,media_files.mime_type),updated_at=now() RETURNING *`,
  [data.tenantId,data.providerMediaId,data.conversationId,data.type,data.mimeType || null])).rows[0];
export const markMediaAvailable = async ({ tenantId,id,storageKey,thumbnailKey,sizeBytes,mimeType }) => query(`UPDATE media_files SET storage_key=$3,thumbnail_key=$4,size_bytes=$5,mime_type=COALESCE($6,mime_type),status='available',updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId,id,storageKey,thumbnailKey || null,sizeBytes || null,mimeType || null]);
