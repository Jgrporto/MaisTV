import 'dotenv/config';
import { QUEUE_NAMES } from '../queues/queue-names.mjs';
import { startWorker } from './worker-runtime.mjs';
import {
  claimMessageForSending,
  claimMessageForMediaUpload,
  findMessageWithMedia,
  markMediaMessageSending,
  markMessageFailed,
  markMessageSent,
  resetMessagePending,
  setMessageOutboundChannel,
} from '../repositories/messages.repository.mjs';
import { getConversation } from '../repositories/conversations.repository.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
import { resolveMetaConfig } from '../services/meta-config.service.mjs';
import { getLogger } from '../services/logger.service.mjs';
import { resolveOutboundChannel } from '../services/channel-routing.service.mjs';
import { buildStoredMediaMessagePayload, uploadStoredMediaToMeta } from '../services/meta-outbound-media.service.mjs';
import { buildInteractivePayload } from '../services/interactive-message.service.mjs';
import {
  getChatbotOutboundPermission,
  handleChatbotOutboundFailed,
  handleChatbotOutboundSent,
} from '../services/chatbot-sequence.service.mjs';

const buildMetaMessagePayload = ({ conversation, message, providerMediaId = '' }) => {
  if (['image', 'audio', 'video', 'document'].includes(message.type)) {
    return buildStoredMediaMessagePayload({ conversation, message, providerMediaId });
  }
  if (message.type === 'interactive') {
    return {
      messaging_product: 'whatsapp',
      to: conversation.contact_phone,
      ...buildInteractivePayload(message),
      biz_opaque_callback_data: message.client_message_id,
    };
  }
  return {
    messaging_product: 'whatsapp',
    to: conversation.contact_phone,
    type: 'text',
    text: { body: message.body },
    biz_opaque_callback_data: message.client_message_id,
  };
};

await startWorker(QUEUE_NAMES.outbound, async (job) => {
  const logger = await getLogger();
  const { tenantId, messageId } = job.data;
  const message = await findMessageWithMedia(tenantId, messageId);
  if (!message) throw new Error(`Outbound message ${messageId} not found.`);
  const conversation = await getConversation(tenantId, message.conversation_id);
  const eventScope = {
    tenantId,
    conversationId: conversation.id,
    queueId: conversation.queue_id,
    assignedAgentId: conversation.assigned_agent_id,
    customerPhone: conversation.contact_phone,
  };

  if (message.status === 'failed') {
    await handleChatbotOutboundFailed({ tenantId, message, error: message.error_message || 'Outbound message already failed.' });
    return { failed: true, alreadyFailed: true, error: message.error_message || 'Outbound message already failed.' };
  }

  if (message.provider_message_id && message.status !== 'pending') {
    if (message.status === 'failed') {
      await handleChatbotOutboundFailed({ tenantId, message, error: message.error_message || 'Provider marked message as failed.' });
    } else {
      await handleChatbotOutboundSent({ tenantId, message });
    }
    await publishRealtimeEvent({
      ...eventScope,
      type: 'message_status_updated',
      data: { messageId: message.id, status: message.status, providerMessageId: message.provider_message_id },
    });
    return { providerMessageId: message.provider_message_id, alreadySent: true };
  }

  const isStoredMedia = ['image', 'audio', 'video', 'document'].includes(message.type);
  const claimed = isStoredMedia
    ? await claimMessageForMediaUpload(tenantId, message.id)
    : await claimMessageForSending(tenantId, message.id);
  if (!claimed) {
    throw new Error(`Outbound message ${message.id} is in uncertain state ${message.status}; automatic resend was blocked to avoid duplication.`);
  }

  const raw=message.raw_json&&typeof message.raw_json==='object'?message.raw_json:{};
  const deliveryKind=String(raw.deliveryKind||raw.delivery_kind||'free_text').trim().toLowerCase();
  const channel=resolveOutboundChannel({conversation,deliveryKind:message.type==='template'?'template':deliveryKind});
  if(!channel.allowed){
      const errorMessage='Customer 24h window is closed; free text outbound was blocked.';
      await markMessageFailed(tenantId,message.id,errorMessage);
      await handleChatbotOutboundFailed({tenantId,message,error:errorMessage});
      return {failed:true,blocked:true,error:errorMessage};
  }
  const routeSelector=channel.deliveryKind==='template'
    ? {routeKey:'default'}
    : {routeKey:message.route_key||channel.routeKey,phoneNumberId:message.phone_number_id||channel.phoneNumberId};
  const metaConfig=resolveMetaConfig({phoneNumberId:routeSelector.phoneNumberId,routeKey:routeSelector.routeKey});
  const token = metaConfig.accessToken;
  const phoneId = metaConfig.phoneNumberId;
  await setMessageOutboundChannel(tenantId,message.id,{routeKey:metaConfig.routeKey,phoneNumberId:phoneId});
  logger.info({
    tenantId,
    messageId: message.id,
    conversationId: conversation.id,
    routeKey: metaConfig.routeKey,
    phoneNumberId: phoneId,
    hasAccessToken: Boolean(token),
  }, 'outbound route resolved');
  if (!token || !phoneId) {
    const errorMessage = 'No Meta credential mapping is configured for the conversation route.';
    await markMessageFailed(tenantId, message.id, errorMessage);
    await handleChatbotOutboundFailed({ tenantId, message, error: errorMessage });
    await publishRealtimeEvent({
      ...eventScope,
      type: 'message_status_updated',
      data: { messageId: message.id, status: 'failed', errorMessage },
    });
    return { failed: true, error: errorMessage };
  }

  let response;
  let providerMediaId = '';
  if (isStoredMedia) {
    try {
      providerMediaId = await uploadStoredMediaToMeta({ message, token, phoneId });
      if (!await markMediaMessageSending(tenantId, message.id)) {
        throw Object.assign(new Error(`Outbound media message ${message.id} could not transition to sending.`), { retryable: true });
      }
    } catch (error) {
      const maxAttempts = Number(job.opts?.attempts || 1);
      const lastAttempt = Number(job.attemptsMade || 0) + 1 >= maxAttempts;
      if (error.retryable !== false && !lastAttempt) {
        await resetMessagePending(tenantId, message.id);
        throw error;
      }
      const errorMessage = String(error?.message || error || 'Outbound media upload failed.').slice(0, 2000);
      await markMessageFailed(tenantId, message.id, errorMessage);
      await publishRealtimeEvent({
        ...eventScope,
        type: 'message_status_updated',
        data: { messageId: message.id, status: 'failed', errorMessage },
      });
      logger.warn({ tenantId, messageId: message.id, conversationId: conversation.id, err: error }, 'outbound media upload failed');
      return { failed: true, error: errorMessage };
    }
  }
  try {
    response = await fetch(
      `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}/${phoneId}/messages`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildMetaMessagePayload({ conversation, message, providerMediaId })),
      },
    );
  } catch (error) {
    // A transport failure is ambiguous: Meta may have accepted the request. Keep
    // status=sending so BullMQ retries cannot send the same client_message_id again.
    const uncertainError = new Error(`Meta send outcome is uncertain; automatic resend blocked: ${error.message}`, { cause: error });
    await handleChatbotOutboundFailed({ tenantId, message, error: uncertainError });
    throw uncertainError;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    const uncertainError = new Error(`Meta response could not be parsed; automatic resend blocked: ${error.message}`, { cause: error });
    await handleChatbotOutboundFailed({ tenantId, message, error: uncertainError });
    throw uncertainError;
  }

  const chatbotPermission = await getChatbotOutboundPermission({ tenantId, message });
  if (!chatbotPermission.allowed) {
    const errorMessage = `Chatbot output blocked: ${chatbotPermission.reason}.`;
    await markMessageFailed(tenantId, message.id, errorMessage);
    await handleChatbotOutboundFailed({ tenantId, message, error: errorMessage });
    logger.warn({
      tenantId,
      messageId: message.id,
      conversationId: conversation.id,
      batchId: chatbotPermission.batchId,
      outputIndex: chatbotPermission.outputIndex,
      reason: chatbotPermission.reason,
    }, 'blocked stale chatbot outbound job');
    return { failed: true, blocked: true, error: errorMessage };
  }
  if (!response.ok) {
    const errorMessage = `Meta send failed (${response.status}): ${payload?.error?.message || 'unknown error'}`;
    await markMessageFailed(tenantId, message.id, errorMessage);
    await handleChatbotOutboundFailed({ tenantId, message, error: errorMessage });
    await publishRealtimeEvent({
      ...eventScope,
      type: 'message_status_updated',
      data: { messageId: message.id, status: 'failed', errorMessage },
    });
    logger.warn({
      tenantId,
      messageId: message.id,
      conversationId: conversation.id,
      routeKey: metaConfig.routeKey,
      phoneNumberId: phoneId,
      statusCode: response.status,
      metaErrorCode: payload?.error?.code,
      metaErrorSubcode: payload?.error?.error_subcode,
    }, 'outbound meta send failed');
    return { failed: true, error: errorMessage };
  }

  const providerMessageId = payload.messages?.[0]?.id;
  if (!providerMessageId) {
    const error = new Error('Meta accepted the request without a message id; automatic resend blocked.');
    await handleChatbotOutboundFailed({ tenantId, message, error });
    throw error;
  }

  await markMessageSent(tenantId, message.id, providerMessageId);
  await handleChatbotOutboundSent({
    tenantId,
    message: { ...message, status: 'sent', provider_message_id: providerMessageId },
  });
  logger.info({
    tenantId,
    messageId: message.id,
    conversationId: conversation.id,
    routeKey: metaConfig.routeKey,
    phoneNumberId: phoneId,
    providerMessageId,
  }, 'outbound meta send succeeded');
  await publishRealtimeEvent({
    ...eventScope,
    type: 'message_status_updated',
    data: { messageId: message.id, status: 'sent', providerMessageId },
  });
  return { providerMessageId };
});
