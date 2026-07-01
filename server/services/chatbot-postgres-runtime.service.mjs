import crypto from 'node:crypto';

import { withTransaction } from '../db/postgres.mjs';
import { insertPendingOutbound } from '../repositories/messages.repository.mjs';
import { updateConversationLastOutbound } from '../repositories/conversations.repository.mjs';
import { recordChatbotEvent } from '../repositories/chatbot-flow.repository.mjs';
import { addJob } from '../queues/queues.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
import { runPostgresChatbotDryRun } from './chatbot-flow.service.mjs';
import { getLogger } from './logger.service.mjs';

const truthy = (value) => ['1', 'true', 'yes', 'sim', 'on'].includes(String(value || '').trim().toLowerCase());
const listEnv = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);

const config = () => ({
  runtimeEnabled: truthy(process.env.CHATBOT_POSTGRES_RUNTIME_ENABLED),
  outboundEnabled: truthy(process.env.CHATBOT_POSTGRES_OUTBOUND_ENABLED),
  requireLegacyDisabled: !truthy(process.env.CHATBOT_ENABLED),
  sourceIsPostgres: String(process.env.CHATBOT_FLOW_SOURCE || '').trim().toLowerCase() === 'postgres',
  allowedRoutes: listEnv(process.env.CHATBOT_POSTGRES_ALLOWED_ROUTES || process.env.CHATBOT_ALLOWED_ROUTES),
  allowedFlowIds: listEnv(process.env.CHATBOT_POSTGRES_ALLOWED_FLOW_IDS || process.env.CHATBOT_ALLOWED_FLOW_IDS),
  allowAssignedConversations: truthy(process.env.CHATBOT_POSTGRES_ALLOW_ASSIGNED_CONVERSATIONS),
  maxTextOutputs: Math.max(1, Number(process.env.CHATBOT_POSTGRES_MAX_TEXT_OUTPUTS || 1)),
  botUserId: String(process.env.CHATBOT_POSTGRES_BOT_USER_ID || 'chatbot-postgres').trim() || 'chatbot-postgres',
});

const routeFromItem = (item = {}, conversation = {}) => {
  const selector = item.routeSelector
    || conversation.active_route_selector_json
    || conversation.default_route_selector_json
    || {};
  return String(selector.routeKey || selector.route_key || 'default').trim().toLowerCase() || 'default';
};

const buildSkip = (reason, extra = {}) => ({
  skipped: true,
  reason,
  createdOutbound: 0,
  queuedOutbound: 0,
  ...extra,
});

const eventScopeOf = ({ tenantId, conversation }) => ({
  tenantId,
  conversationId: conversation.id,
  queueId: conversation.queue_id,
  assignedAgentId: conversation.assigned_agent_id,
  customerPhone: conversation.contact_phone,
});

const createBotOutboundMessage = async ({
  tenantId,
  conversation,
  inboundMessage,
  output,
  outputIndex,
  botUserId,
}) => {
  const clientMessageId = `chatbot:${tenantId}:${inboundMessage.id}:${outputIndex}`;
  const result = await withTransaction(async (client) => {
    const message = await insertPendingOutbound({
      tenantId,
      conversationId: conversation.id,
      clientMessageId,
      type: 'text',
      body: output.text,
      raw: {
        requestedBy: botUserId,
        origin: 'chatbot-postgres',
        inboundMessageId: inboundMessage.id,
        outputIndex,
      },
    }, client);
    const updatedConversation = await updateConversationLastOutbound(client, conversation.id, message);
    return { message, conversation: updatedConversation || conversation };
  });

  await addJob('outbound', 'send-message', {
    tenantId,
    messageId: result.message.id,
    userId: botUserId,
  }, { jobId: `outbound:${tenantId}:${clientMessageId}` });

  const eventScope = eventScopeOf({ tenantId, conversation });
  await publishRealtimeEvent({
    ...eventScope,
    type: 'new_message',
    data: { conversationId: conversation.id, message: result.message },
  });
  await publishRealtimeEvent({
    ...eventScope,
    type: 'conversation_updated',
    data: { conversationId: conversation.id, conversation: result.conversation },
  });

  return result.message;
};

export const processPostgresChatbotForInbound = async ({ tenantId, item, message, conversation }) => {
  const cfg = config();
  const logger = await getLogger();
  const routeKey = routeFromItem(item, conversation);

  if (!cfg.runtimeEnabled) return buildSkip('runtime_disabled');
  if (!cfg.outboundEnabled) return buildSkip('outbound_disabled');
  if (!cfg.requireLegacyDisabled) return buildSkip('legacy_chatbot_enabled');
  if (!cfg.sourceIsPostgres) return buildSkip('source_not_postgres');
  if (cfg.allowedRoutes.length && !cfg.allowedRoutes.includes(routeKey)) {
    return buildSkip('route_not_allowed', { routeKey });
  }
  if (message.direction !== 'inbound') return buildSkip('not_inbound');
  if (message.type !== 'text') return buildSkip('unsupported_message_type', { messageType: message.type });
  if (!String(message.body || '').trim()) return buildSkip('empty_text');
  if (conversation.assigned_agent_id && !cfg.allowAssignedConversations) {
    return buildSkip('conversation_assigned_to_human', { assignedAgentId: conversation.assigned_agent_id });
  }

  const decision = await runPostgresChatbotDryRun({
    tenantId,
    routeKey,
    text: message.body,
    type: message.type,
    phone: conversation.contact_phone,
    conversationId: conversation.id,
    messageId: message.id,
    log: false,
  });

  if (!decision.matched) {
    await recordChatbotEvent({
      tenantId,
      conversationId: conversation.id,
      messageId: message.id,
      eventType: 'live_no_match',
      mode: 'live',
      payload: {
        routeKey,
        reason: decision.reason,
        createsOutboundJob: false,
        callsMeta: false,
      },
    });
    return buildSkip(decision.reason || 'no_match', { routeKey, decision });
  }

  if (cfg.allowedFlowIds.length && !cfg.allowedFlowIds.includes(decision.flowId)) {
    await recordChatbotEvent({
      tenantId,
      conversationId: conversation.id,
      messageId: message.id,
      flowId: decision.flowId || null,
      flowVersionId: decision.versionId || null,
      eventType: 'live_flow_not_allowed',
      mode: 'live',
      payload: { routeKey, allowedFlowIds: cfg.allowedFlowIds, decision },
    });
    return buildSkip('flow_not_allowed', { routeKey, decision });
  }

  const textOutputs = (decision.wouldSend || [])
    .filter((output) => output.type === 'text' && String(output.text || '').trim())
    .slice(0, cfg.maxTextOutputs);
  const skippedOutputs = (decision.wouldSend || [])
    .filter((output) => output.type !== 'text');

  if (!textOutputs.length) {
    await recordChatbotEvent({
      tenantId,
      conversationId: conversation.id,
      messageId: message.id,
      flowId: decision.flowId || null,
      flowVersionId: decision.versionId || null,
      eventType: 'live_no_supported_outputs',
      mode: 'live',
      payload: { routeKey, decision, skippedOutputs },
    });
    return buildSkip('no_supported_outputs', { routeKey, decision, skippedOutputs });
  }

  const createdMessages = [];
  for (const [index, output] of textOutputs.entries()) {
    createdMessages.push(await createBotOutboundMessage({
      tenantId,
      conversation,
      inboundMessage: message,
      output,
      outputIndex: index,
      botUserId: cfg.botUserId,
    }));
  }

  await recordChatbotEvent({
    tenantId,
    conversationId: conversation.id,
    messageId: message.id,
    flowId: decision.flowId || null,
    flowVersionId: decision.versionId || null,
    eventType: 'live_outbound_queued',
    mode: 'live',
    payload: {
      routeKey,
      decision,
      createdMessageIds: createdMessages.map((created) => created.id),
      skippedOutputs,
      idempotencyKey: crypto.createHash('sha256').update(`${tenantId}:${message.id}`).digest('hex'),
    },
  });

  logger.info({
    tenantId,
    conversationId: conversation.id,
    inboundMessageId: message.id,
    flowId: decision.flowId,
    routeKey,
    createdOutbound: createdMessages.length,
    skippedOutputs: skippedOutputs.length,
  }, 'postgres chatbot live outbound queued');

  return {
    skipped: false,
    reason: 'outbound_queued',
    routeKey,
    decision,
    createdOutbound: createdMessages.length,
    queuedOutbound: createdMessages.length,
    skippedOutputs,
  };
};

export const getPostgresChatbotRuntimeSafety = () => {
  const cfg = config();
  return {
    runtimeEnabled: cfg.runtimeEnabled,
    outboundEnabled: cfg.outboundEnabled,
    legacyChatbotDisabled: cfg.requireLegacyDisabled,
    sourceIsPostgres: cfg.sourceIsPostgres,
    allowedRoutes: cfg.allowedRoutes,
    allowedFlowIds: cfg.allowedFlowIds,
    allowAssignedConversations: cfg.allowAssignedConversations,
    maxTextOutputs: cfg.maxTextOutputs,
  };
};
