import { query } from '../db/postgres.mjs';

export const getMedia = async (tenantId, id) => (await query(`SELECT media_files.*,conversations.assigned_agent_id,conversations.queue_id,conversations.service_id,conversations.active_route_selector_json
  FROM media_files JOIN conversations ON conversations.id=media_files.conversation_id AND conversations.tenant_id=media_files.tenant_id
  WHERE media_files.tenant_id=$1 AND media_files.id=$2`, [tenantId,id])).rows[0] || null;

export const upsertMediaMetadata = async (client, data) => (await client.query(`INSERT INTO media_files
  (tenant_id,provider_media_id,conversation_id,type,mime_type,original_filename,metadata_json,status)
  VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending')
  ON CONFLICT (tenant_id,provider_media_id) DO UPDATE SET
    mime_type=COALESCE(EXCLUDED.mime_type,media_files.mime_type),
    original_filename=COALESCE(EXCLUDED.original_filename,media_files.original_filename),
    metadata_json=media_files.metadata_json || EXCLUDED.metadata_json,
    updated_at=now()
  RETURNING *`, [
    data.tenantId,
    data.providerMediaId,
    data.conversationId,
    data.type,
    data.mimeType || null,
    data.filename || null,
    JSON.stringify(data.metadata || {}),
  ])).rows[0];

export const linkMediaToMessage = async (client, { tenantId, mediaId, messageId }) => client.query(
  'UPDATE media_files SET message_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND message_id IS DISTINCT FROM $3',
  [tenantId, mediaId, messageId],
);

export const markMediaProcessing = async ({ tenantId, id }) => query(`UPDATE media_files SET
  status='processing',error_message=NULL,last_attempt_at=now(),updated_at=now()
  WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId,id]);

export const markMediaAvailable = async ({ tenantId,id,storageKey,thumbnailKey,sizeBytes,mimeType,sha256,metadata }) => query(`UPDATE media_files SET
  storage_key=$3,thumbnail_key=$4,size_bytes=$5,mime_type=COALESCE($6,mime_type),sha256=$7,
  metadata_json=metadata_json || $8::jsonb,status='available',error_message=NULL,available_at=now(),updated_at=now()
  WHERE tenant_id=$1 AND id=$2 RETURNING *`, [
    tenantId,id,storageKey,thumbnailKey || null,sizeBytes || null,mimeType || null,sha256 || null,JSON.stringify(metadata || {}),
  ]);

export const markMediaFailed = async ({ tenantId,id,error }) => query(`UPDATE media_files SET
  status='failed',error_message=$3,last_attempt_at=now(),updated_at=now()
  WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId,id,String(error?.message || error || 'Unknown media processing error').slice(0,2000)]);

export const updateMessageTranscription = async ({ tenantId, messageId, transcription }) => query(`UPDATE messages SET
  transcription_json=$3::jsonb WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId,messageId,JSON.stringify(transcription || {})]);
