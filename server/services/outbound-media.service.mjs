import crypto from 'node:crypto';
import path from 'node:path';
import { withTransaction } from '../db/postgres.mjs';
import { getConversation, updateConversationLastOutbound } from '../repositories/conversations.repository.mjs';
import { linkMediaToMessage, upsertOutboundMedia } from '../repositories/media.repository.mjs';
import { findMessageByClientMessageId, insertPendingOutbound } from '../repositories/messages.repository.mjs';
import { findMessageReadCursor } from '../repositories/conversation-reads.repository.mjs';
import { addJob } from '../queues/queues.mjs';
import { deleteObject, putObject } from '../storage/storage.service.mjs';
import { getChatAccessFilter } from './chat-authorization.service.mjs';
import { resolveOutboundChannel } from './channel-routing.service.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
import { getLogger } from './logger.service.mjs';

const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'document']);
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const text = (value) => String(value || '').trim();
const safeFilename = (value) => text(value).replace(/[\r\n"/\\]/g, '_').slice(0, 180);
const maxBytes = () => {
  const configured = Number(process.env.OUTBOUND_MEDIA_MAX_BYTES || DEFAULT_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.max(1024, configured) : DEFAULT_MAX_BYTES;
};

const extensionByMimeType = (mimeType) => ({
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'application/pdf': '.pdf',
}[String(mimeType || '').toLowerCase()] || '');

const deterministicUuid = (value) => {
  const bytes = crypto.createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const decodeOutboundMediaInput = (input = {}) => {
  const type = text(input.type).toLowerCase();
  if (!MEDIA_TYPES.has(type)) throw Object.assign(new Error('Tipo de midia invalido.'), { statusCode: 400 });
  const raw = text(input.dataBase64 || input.base64);
  if (!raw) throw Object.assign(new Error('Arquivo de midia obrigatorio.'), { statusCode: 400 });
  const dataUrlMatch = raw.match(/^data:([^;,]+)?;base64,(.*)$/s);
  const encoded = (dataUrlMatch?.[2] || raw).replace(/\s+/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw Object.assign(new Error('Conteudo base64 invalido.'), { statusCode: 400 });
  }
  const body = Buffer.from(encoded, 'base64');
  if (!body.length) throw Object.assign(new Error('Arquivo de midia vazio.'), { statusCode: 400 });
  if (body.length > maxBytes()) throw Object.assign(new Error('Arquivo excede o limite permitido.'), { statusCode: 413 });
  const mimeType = text(input.mimeType || input.mimetype || dataUrlMatch?.[1]) || 'application/octet-stream';
  const filename = safeFilename(input.filename) || `${type}${extensionByMimeType(mimeType)}`;
  return { type, body, mimeType, filename, caption: text(input.caption) };
};

const persistObjects = async ({ tenantId, mediaId, media }) => {
  const extension = path.extname(media.filename) || extensionByMimeType(media.mimeType);
  const storageKey = `${tenantId}/media/${mediaId}/original${extension}`;
  const sha256 = crypto.createHash('sha256').update(media.body).digest('hex');
  await putObject({
    key: storageKey,
    body: media.body,
    contentType: media.mimeType,
    contentDisposition: `inline; filename="${media.filename}"`,
    metadata: { mediaid: mediaId, direction: 'outbound', sha256 },
  });

  let thumbnailKey = null;
  if (media.type === 'image') {
    const { default: sharp } = await import('sharp');
    const thumbnail = await sharp(media.body, { animated: false }).rotate()
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72, progressive: true }).toBuffer();
    thumbnailKey = `${tenantId}/media/${mediaId}/thumbnail.jpg`;
    await putObject({ key: thumbnailKey, body: thumbnail, contentType: 'image/jpeg', metadata: { mediaid: mediaId, direction: 'outbound' } });
  }
  return { storageKey, thumbnailKey, sha256 };
};

const enqueueExisting = async ({ tenantId, message }) => {
  if (message.status === 'pending') {
    await addJob('outbound', 'send-message', { tenantId, messageId: message.id }, { jobId: `outbound:${tenantId}:${message.client_message_id}` });
  }
  return message;
};

export const queueOutboundMediaMessage = async ({ auth, input = {} }) => {
  const tenantId = auth.tenantId;
  const conversationId = text(input.conversationId);
  const clientMessageId = text(input.clientMessageId) || crypto.randomUUID();
  if (!conversationId) throw Object.assign(new Error('conversationId obrigatorio.'), { statusCode: 400 });

  const existing = await findMessageByClientMessageId(tenantId, clientMessageId);
  if (existing) return enqueueExisting({ tenantId, message: existing });

  const conversation = await getConversation(tenantId, conversationId, getChatAccessFilter(auth));
  if (!conversation) throw Object.assign(new Error('Conversa nao encontrada.'), { statusCode: 404 });
  const channel = resolveOutboundChannel({ conversation, deliveryKind: 'free_text' });
  if (!channel.allowed) throw Object.assign(new Error('A janela de 24h esta fechada. Use um template HSM.'), { statusCode: 409 });

  const media = decodeOutboundMediaInput(input);
  const requestedReplyId = text(input.replyToMessageId);
  const replyCursor = requestedReplyId
    ? await findMessageReadCursor({ tenantId, conversationId, messageId: requestedReplyId })
    : null;
  const mediaId = deterministicUuid(`${tenantId}:outbound-media:${clientMessageId}`);
  const stored = await persistObjects({ tenantId, mediaId, media });
  let result;
  try {
    result = await withTransaction(async (client) => {
      await upsertOutboundMedia(client, {
        id: mediaId, tenantId, conversationId, type: media.type, mimeType: media.mimeType,
        filename: media.filename, sizeBytes: media.body.length, ...stored,
        metadata: { direction: 'outbound', clientMessageId },
      });
      const body = media.caption || `[${media.type === 'image' ? 'Imagem' : media.type === 'audio' ? 'Audio' : media.type === 'video' ? 'Video' : 'Documento'}]`;
      const message = await insertPendingOutbound({
        tenantId, conversationId, clientMessageId, type: media.type, body,
        routeKey: channel.routeKey, phoneNumberId: channel.phoneNumberId, mediaId,
        replyToMessageId: replyCursor?.id || null,
        raw: { requestedBy: auth.userId, deliveryKind: 'free_text', routeKey: channel.routeKey, phoneNumberId: channel.phoneNumberId, filename: media.filename, caption: media.caption },
      }, client);
      await linkMediaToMessage(client, { tenantId, mediaId, messageId: message.id });
      const updatedConversation = await updateConversationLastOutbound(client, conversationId, message);
      return { message, conversation: updatedConversation || conversation };
    });
  } catch (error) {
    await Promise.allSettled([deleteObject(stored.storageKey), stored.thumbnailKey ? deleteObject(stored.thumbnailKey) : Promise.resolve()]);
    throw error;
  }

  await addJob('outbound', 'send-message', { tenantId, messageId: result.message.id, userId: auth.userId }, { jobId: `outbound:${tenantId}:${clientMessageId}` });
  const scope = { tenantId, conversationId, queueId: conversation.queue_id, assignedAgentId: conversation.assigned_agent_id, customerPhone: conversation.contact_phone };
  await publishRealtimeEvent({ ...scope, type: 'new_message', data: { conversationId, message: result.message } });
  await publishRealtimeEvent({
    ...scope,
    type: 'media_updated',
    data: {
      conversationId,
      messageId: result.message.id,
      mediaId,
      status: 'available',
      mimeType: media.mimeType,
      size: media.body.length,
      hasThumbnail: Boolean(stored.thumbnailKey),
    },
  });
  await publishRealtimeEvent({ ...scope, type: 'conversation_updated', data: { conversationId, conversation: result.conversation } });
  (await getLogger()).info({
    tenantId,
    conversationId,
    messageId: result.message.id,
    mediaId,
    type: media.type,
    sizeBytes: media.body.length,
    routeKey: channel.routeKey,
    phoneNumberId: channel.phoneNumberId,
  }, 'outbound media persisted and queued');
  return result.message;
};
