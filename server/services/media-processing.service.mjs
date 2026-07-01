import crypto from 'node:crypto';
import path from 'node:path';
import { getLogger } from './logger.service.mjs';
import { getMedia, markMediaAvailable, markMediaFailed, markMediaProcessing } from '../repositories/media.repository.mjs';
import { headObject, putObject } from '../storage/storage.service.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';

const safeFilename = (value) => String(value || '').trim().replace(/[\r\n"\\]/g, '_').slice(0, 180);
const extensionByMimeType = (mimeType) => ({
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'application/pdf': '.pdf',
}[String(mimeType || '').toLowerCase()] || '');

const resolveAccessToken = (phoneNumberId) => {
  const normalized = String(phoneNumberId || '').replace(/\D/g, '');
  const candidates = [
    ['WHATSAPP_VENDAS_PHONE_NUMBER_ID', 'WHATSAPP_VENDAS_ACCESS_TOKEN'],
    ['WHATSAPP_VENDAS2_PHONE_NUMBER_ID', 'WHATSAPP_VENDAS2_ACCESS_TOKEN'],
    ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'],
  ];
  for (const [idKey, tokenKey] of candidates) {
    if (normalized && normalized === String(process.env[idKey] || '').replace(/\D/g, '') && process.env[tokenKey]) {
      return process.env[tokenKey];
    }
  }
  return process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || '';
};

const publishMediaUpdate = async (media, status, extra = {}) => {
  if (!media) return;
  await publishRealtimeEvent({
    tenantId: media.tenant_id,
    conversationId: media.conversation_id,
    queueId: media.queue_id,
    assignedAgentId: media.assigned_agent_id,
    type: 'media_updated',
    data: {
      conversationId: media.conversation_id,
      messageId: media.message_id,
      mediaId: media.id,
      status,
      mimeType: media.mime_type,
      size: media.size_bytes == null ? null : Number(media.size_bytes),
      hasThumbnail: Boolean(media.thumbnail_key),
      ...extra,
    },
  });
};

export const processMediaJob = async (job) => {
  const logger = await getLogger();
  const { tenantId, mediaId, providerMediaId, phoneNumberId } = job.data || {};
  if (!tenantId || !mediaId || !providerMediaId) throw new Error('Media job requires tenantId, mediaId and providerMediaId.');
  const existing = await getMedia(tenantId, mediaId);
  if (!existing) throw new Error(`Media record not found: ${mediaId}`);

  if (existing.status === 'available' && existing.storage_key) {
    try {
      await headObject(existing.storage_key);
      logger.info({ jobId: job.id, tenantId, mediaId, storageKey: existing.storage_key }, 'media already available; retry is idempotent');
      return { alreadyAvailable: true, sizeBytes: Number(existing.size_bytes || 0), thumbnailCreated: Boolean(existing.thumbnail_key) };
    } catch (error) {
      logger.warn({ jobId: job.id, tenantId, mediaId, err: error }, 'media database record exists but storage object is missing; downloading again');
    }
  }

  await markMediaProcessing({ tenantId, id: mediaId });
  try {
    const effectivePhoneNumberId = phoneNumberId || existing.active_route_selector_json?.phoneNumberId || existing.active_route_selector_json?.phone_number_id;
    const token = resolveAccessToken(effectivePhoneNumberId);
    if (!token) throw new Error(`Meta access token is not configured for phone_number_id ${effectivePhoneNumberId || '(missing)'}.`);
    const graphVersion = process.env.META_GRAPH_VERSION || process.env.WHATSAPP_API_VERSION || 'v23.0';
    const metaResponse = await fetch(`https://graph.facebook.com/${graphVersion}/${providerMediaId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const metaText = await metaResponse.text();
    let meta = {};
    try { meta = metaText ? JSON.parse(metaText) : {}; } catch { meta = {}; }
    if (!metaResponse.ok || !meta.url) {
      throw new Error(`Meta media metadata failed (${metaResponse.status}): ${String(meta?.error?.message || metaText || 'missing url').slice(0, 500)}`);
    }

    const mediaResponse = await fetch(meta.url, { headers: { authorization: `Bearer ${token}` } });
    if (!mediaResponse.ok) throw new Error(`Meta media download failed (${mediaResponse.status}).`);
    const body = Buffer.from(await mediaResponse.arrayBuffer());
    if (!body.length) throw new Error('Meta returned an empty media object.');

    const contentType = meta.mime_type || mediaResponse.headers.get('content-type') || existing.mime_type || 'application/octet-stream';
    const originalFilename = safeFilename(existing.original_filename || meta.filename);
    const extension = path.extname(originalFilename) || extensionByMimeType(contentType);
    const key = `${tenantId}/media/${mediaId}/original${extension}`;
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    await putObject({
      key,
      body,
      contentType,
      contentDisposition: originalFilename ? `attachment; filename="${originalFilename}"` : undefined,
      metadata: { mediaid: String(mediaId), providermediaid: String(providerMediaId), sha256 },
    });

    let thumbnailKey = null;
    const isImage = contentType.startsWith('image/') || existing.type === 'image' || existing.type === 'sticker';
    if (isImage) {
      const { default: sharp } = await import('sharp');
      const thumbnail = await sharp(body, { animated: false })
        .rotate()
        .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 72, progressive: true })
        .toBuffer();
      thumbnailKey = `${tenantId}/media/${mediaId}/thumbnail.jpg`;
      await putObject({ key: thumbnailKey, body: thumbnail, contentType: 'image/jpeg', metadata: { mediaid: String(mediaId) } });
    }

    await headObject(key);
    if (thumbnailKey) await headObject(thumbnailKey);
    await markMediaAvailable({
      tenantId,
      id: mediaId,
      storageKey: key,
      thumbnailKey,
      sizeBytes: body.length,
      mimeType: contentType,
      sha256,
      metadata: { metaFileSize: meta.file_size || null, metaSha256: meta.sha256 || null },
    });
    const media = await getMedia(tenantId, mediaId);
    await publishMediaUpdate(media, 'available');
    logger.info({ jobId: job.id, tenantId, mediaId, contentType, sizeBytes: body.length, thumbnailCreated: Boolean(thumbnailKey) }, 'inbound media stored');
    return { sizeBytes: body.length, thumbnailCreated: Boolean(thumbnailKey), storageKey: key };
  } catch (error) {
    const failed = (await markMediaFailed({ tenantId, id: mediaId, error })).rows[0] || existing;
    await publishMediaUpdate(failed, 'failed', { error: String(error?.message || error).slice(0, 500) }).catch(() => {});
    logger.error({ jobId: job.id, tenantId, mediaId, err: error }, 'inbound media processing failed');
    throw error;
  }
};
