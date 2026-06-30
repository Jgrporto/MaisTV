import 'dotenv/config';
import { QUEUE_NAMES } from '../queues/queue-names.mjs';
import { startWorker } from './worker-runtime.mjs';
import {
  claimMessageForSending,
  findMessageById,
  markMessageSent,
  resetMessagePending,
} from '../repositories/messages.repository.mjs';
import { getConversation } from '../repositories/conversations.repository.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';

await startWorker(QUEUE_NAMES.outbound, async (job) => {
  const { tenantId, messageId } = job.data;
  const message = await findMessageById(tenantId, messageId);
  if (!message) throw new Error(`Outbound message ${messageId} not found.`);
  const conversation = await getConversation(tenantId, message.conversation_id);

  if (message.provider_message_id && message.status !== 'pending') {
    await publishRealtimeEvent({
      tenantId,
      conversationId: conversation.id,
      queueId: conversation.queue_id,
      type: 'message_status_updated',
      data: { messageId: message.id, status: message.status, providerMessageId: message.provider_message_id },
    });
    return { providerMessageId: message.provider_message_id, alreadySent: true };
  }

  const claimed = await claimMessageForSending(tenantId, message.id);
  if (!claimed) {
    throw new Error(`Outbound message ${message.id} is in uncertain state ${message.status}; automatic resend was blocked to avoid duplication.`);
  }

  const token = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    await resetMessagePending(tenantId, message.id);
    throw new Error('META_ACCESS_TOKEN and META_PHONE_NUMBER_ID are required by outbound worker.');
  }

  let response;
  try {
    response = await fetch(
      `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}/${phoneId}/messages`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: conversation.contact_phone,
          type: 'text',
          text: { body: message.body },
          biz_opaque_callback_data: message.client_message_id,
        }),
      },
    );
  } catch (error) {
    // A transport failure is ambiguous: Meta may have accepted the request. Keep
    // status=sending so BullMQ retries cannot send the same client_message_id again.
    throw new Error(`Meta send outcome is uncertain; automatic resend blocked: ${error.message}`, { cause: error });
  }

  const payload = await response.json();
  if (!response.ok) {
    await resetMessagePending(tenantId, message.id);
    throw new Error(`Meta send failed (${response.status}): ${payload?.error?.message || 'unknown error'}`);
  }

  const providerMessageId = payload.messages?.[0]?.id;
  if (!providerMessageId) {
    throw new Error('Meta accepted the request without a message id; automatic resend blocked.');
  }

  await markMessageSent(tenantId, message.id, providerMessageId);
  await publishRealtimeEvent({
    tenantId,
    conversationId: conversation.id,
    queueId: conversation.queue_id,
    type: 'message_status_updated',
    data: { messageId: message.id, status: 'sent', providerMessageId },
  });
  return { providerMessageId };
});
