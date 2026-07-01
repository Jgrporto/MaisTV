import crypto from 'node:crypto';
import { insertWebhookEvent,markWebhookFailed } from '../repositories/webhook-events.repository.mjs';
import { addJob } from '../queues/queues.mjs';
export const verifyMetaSignature = (rawBody,signature) => {
  const secret=String(process.env.META_APP_SECRET||'');
  if (!secret) throw Object.assign(new Error('META_APP_SECRET is required for webhook signature validation.'),{statusCode:503});
  const expected=`sha256=${crypto.createHmac('sha256',secret).update(rawBody).digest('hex')}`;
  const actual=String(signature||'');
  return actual.length===expected.length && crypto.timingSafeEqual(Buffer.from(actual),Buffer.from(expected));
};
const eventKey = (payload,raw) => {
  const value=payload?.entry?.[0]?.changes?.[0]?.value;
  const stable=value?.messages?.[0]?.id || `${value?.statuses?.[0]?.id||''}:${value?.statuses?.[0]?.status||''}:${value?.statuses?.[0]?.timestamp||''}`;
  return stable || crypto.createHash('sha256').update(raw).digest('hex');
};
export const acceptMetaWebhook = async ({rawBody,payload}) => {
  const value=payload?.entry?.[0]?.changes?.[0]?.value||{};
  const phoneNumberId=String(value?.metadata?.phone_number_id||'');
  const tenantId=String(process.env[`META_TENANT_${phoneNumberId}`]||process.env.CHAT_DEFAULT_TENANT_ID||'');
  if (!tenantId) throw Object.assign(new Error(`No tenant mapping for Meta phone_number_id ${phoneNumberId||'(missing)'}.`),{statusCode:422});
  const stored=await insertWebhookEvent({tenantId,phoneNumberId,eventKey:eventKey(payload,rawBody),payload});
  if (!stored.event) throw Object.assign(new Error('Webhook event could not be persisted or recovered.'),{statusCode:503});
  const shouldEnqueue=!stored.duplicate||['received','failed'].includes(String(stored.event.status||'received'));
  if (shouldEnqueue) {
    try {
      await addJob('inbound','process-webhook',{webhookEventId:stored.event.id,tenantId,payload:stored.event.payload_json||payload},{jobId:`webhook:${stored.event.id}`});
    } catch (error) {
      await markWebhookFailed(stored.event.id,error).catch(()=>{});
      throw error;
    }
  }
  return {accepted:true,duplicate:stored.duplicate};
};
