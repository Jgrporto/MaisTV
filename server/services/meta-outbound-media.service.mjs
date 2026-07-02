import { setMediaProviderId } from '../repositories/media.repository.mjs';
import { getObject } from '../storage/storage.service.mjs';

const truncate = (value, max) => String(value || '').trim().slice(0, max);

export const buildStoredMediaMessagePayload = ({ conversation, message, providerMediaId }) => {
  if (!['image', 'audio', 'video', 'document'].includes(message.type)) {
    throw new Error(`Unsupported stored outbound media type: ${message.type || '(missing)'}.`);
  }
  if (!providerMediaId) throw new Error(`Provider media id is required for outbound ${message.type}.`);
  const raw = message.raw_json && typeof message.raw_json === 'object' ? message.raw_json : {};
  const media = { id: providerMediaId };
  if (['image', 'video', 'document'].includes(message.type) && String(raw.caption || '').trim()) {
    media.caption = truncate(raw.caption, 1024);
  }
  if (message.type === 'document' && String(raw.filename || message.media_original_filename || '').trim()) {
    media.filename = truncate(raw.filename || message.media_original_filename, 240);
  }
  const payload = {
    messaging_product: 'whatsapp',
    to: conversation.contact_phone,
    type: message.type,
    [message.type]: media,
    biz_opaque_callback_data: message.client_message_id,
  };
  if (message.reply_provider_message_id) payload.context = { message_id: message.reply_provider_message_id };
  return payload;
};

const bodyToBuffer = async (body) => {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body?.transformToByteArray) return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body || []) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

export const uploadStoredMediaToMeta = async ({ message, token, phoneId }) => {
  if (!message.storage_key || message.media_status !== 'available') {
    throw new Error(`Outbound media ${message.joined_media_id || message.media_id || '(missing)'} is not available in storage.`);
  }
  const stored = await getObject(message.storage_key);
  const body = await bodyToBuffer(stored.Body);
  if (!body.length) throw new Error('Outbound media storage object is empty.');
  const mimeType = message.media_mime_type || stored.ContentType || 'application/octet-stream';
  const filename = String(message.media_original_filename || `media-${message.id}`).trim();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([body], { type: mimeType }), filename);
  let response;
  try {
    response = await fetch(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}/${phoneId}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (cause) {
    throw Object.assign(new Error(`Meta media upload transport failed: ${cause.message}`, { cause }), { retryable: true });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) {
    throw Object.assign(
      new Error(`Meta media upload failed (${response.status}): ${payload?.error?.message || 'missing media id'}`),
      { retryable: response.status === 429 || response.status >= 500 },
    );
  }
  await setMediaProviderId({ tenantId: message.tenant_id, id: message.joined_media_id || message.media_id, providerMediaId: payload.id });
  return payload.id;
};
