import { withTransaction } from '../db/postgres.mjs';
import { upsertInboundConversation, updateConversationLastMessage } from '../repositories/conversations.repository.mjs';
import { insertInboundMessage } from '../repositories/messages.repository.mjs';
import { linkMediaToMessage, upsertMediaMetadata } from '../repositories/media.repository.mjs';
import { markWebhookProcessed, markWebhookFailed } from '../repositories/webhook-events.repository.mjs';
import { addJob } from '../queues/queues.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
import { buildMetaRouteSelector } from './meta-config.service.mjs';
import { processPostgresChatbotForInbound } from './chatbot-postgres-runtime.service.mjs';
import { getLogger } from './logger.service.mjs';

const typeOf = (message) => ['image', 'audio', 'video', 'document', 'sticker'].find((type) => message?.[type]) || message?.type || 'text';
const bodyOf = (message, type) => message?.text?.body
  || message?.[type]?.caption
  || message?.button?.text
  || message?.button?.payload
  || message?.interactive?.button_reply?.title
  || message?.interactive?.button_reply?.id
  || message?.interactive?.list_reply?.title
  || message?.interactive?.list_reply?.id
  || '';
const routingValue = (prefix, phoneNumberId, fallback) => process.env[`${prefix}_${String(phoneNumberId || '').replace(/\D/g, '')}`] || process.env[fallback] || null;

export const normalizeMetaPayload = (payload) => {
  const out = { messages: [], statuses: [] };
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || '';
      const routeSelector = buildMetaRouteSelector({ phoneNumberId, displayPhoneNumber: value.metadata?.display_phone_number });
      const names = new Map((value.contacts || []).map((contact) => [contact.wa_id, contact.profile?.name || '']));
      for (const message of value.messages || []) {
        const type = typeOf(message);
        const media = message[type] && type !== 'text' ? message[type] : null;
        out.messages.push({
          providerMessageId: message.id,
          contactPhone: message.from,
          contactName: names.get(message.from) || '',
          phoneNumberId,
          routeSelector,
          queueId: routingValue('META_QUEUE', phoneNumberId, 'CHAT_DEFAULT_QUEUE_ID'),
          serviceId: routingValue('META_SERVICE', phoneNumberId, 'CHAT_DEFAULT_SERVICE_ID'),
          assignedAgentId: routingValue('META_ASSIGNED_AGENT', phoneNumberId, 'CHAT_DEFAULT_ASSIGNED_AGENT_ID'),
          type,
          body: bodyOf(message, type),
          createdAt: new Date(Number(message.timestamp || Date.now() / 1000) * 1000).toISOString(),
          media: media ? {
            providerMediaId: media.id,
            type,
            mimeType: media.mime_type,
            filename: media.filename || null,
            metadata: { caption: media.caption || null, sha256: media.sha256 || null },
          } : null,
          raw: message,
        });
      }
      for (const status of value.statuses || []) {
        out.statuses.push({ providerMessageId: status.id, status: status.status, raw: status });
      }
    }
  }
  return out;
};

export const processInboundWebhook = async (data) => {
  const normalized = normalizeMetaPayload(data.payload);
  try {
    for (const item of normalized.messages) {
      const result = await withTransaction(async (client) => {
        const conversation = await upsertInboundConversation(client, { ...item, tenantId: data.tenantId });
        const media = item.media ? await upsertMediaMetadata(client, {
          ...item.media,
          tenantId: data.tenantId,
          conversationId: conversation.id,
        }) : null;
        const message = await insertInboundMessage(client, {
          ...item,
          tenantId: data.tenantId,
          conversationId: conversation.id,
          mediaId: media?.id,
        });
        if (!message) return { duplicate: true, conversation };
        if (media) await linkMediaToMessage(client, { tenantId: data.tenantId, mediaId: media.id, messageId: message.id });
        await updateConversationLastMessage(client, conversation.id, message);
        return { message, conversation, media };
      });

      if (result.message) {
        if (result.media) {
          await addJob('media', 'download-media', {
            tenantId: data.tenantId,
            mediaId: result.media.id,
            providerMediaId: result.media.provider_media_id,
            phoneNumberId: item.phoneNumberId,
          }, { jobId: `media:${data.tenantId}:${result.media.provider_media_id}` });
        }
        const eventScope = {
          tenantId: data.tenantId,
          conversationId: result.conversation.id,
          queueId: result.conversation.queue_id,
          assignedAgentId: result.conversation.assigned_agent_id,
          customerPhone: result.conversation.contact_phone,
        };
        const conversationSummary = {
          ...result.conversation,
          last_message: result.message.body,
          last_message_type: result.message.type,
          last_message_at: result.message.created_at,
          last_received_at: result.message.created_at,
          last_client_message_time: result.message.created_at,
          is_within_customer_window: true,
          unread_count: Number(result.conversation.unread_count || 0) + 1,
        };
        await publishRealtimeEvent({ ...eventScope, type: 'new_message', data: { conversationId: result.conversation.id, message: result.message, summary: conversationSummary } });
        await publishRealtimeEvent({ ...eventScope, type: 'conversation_updated', data: { conversationId: result.conversation.id, conversation: conversationSummary } });
        try {
          await processPostgresChatbotForInbound({
            tenantId: data.tenantId,
            item,
            message: result.message,
            conversation: result.conversation,
          });
        } catch (error) {
          const logger = await getLogger();
          logger.error({
            tenantId: data.tenantId,
            conversationId: result.conversation.id,
            messageId: result.message.id,
            error: error?.message || String(error),
          }, 'postgres chatbot live runtime failed after inbound persistence');
        }
      }
    }
    for (const status of normalized.statuses) {
      await addJob('status', 'apply-status', { tenantId: data.tenantId, ...status }, { jobId: `status:${data.tenantId}:${status.providerMessageId}:${status.status}` });
    }
    if (data.webhookEventId) await markWebhookProcessed(data.webhookEventId);
    return normalized;
  } catch (error) {
    if (data.webhookEventId) await markWebhookFailed(data.webhookEventId, error).catch(() => {});
    throw error;
  }
};
