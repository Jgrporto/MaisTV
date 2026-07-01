import crypto from 'node:crypto';

import { withTransaction } from '../db/postgres.mjs';
import { insertPendingOutbound } from '../repositories/messages.repository.mjs';
import { updateConversationLastOutbound } from '../repositories/conversations.repository.mjs';
import {
  findChatbotSessionByConversation,
  recordChatbotEvent,
  upsertChatbotSession,
} from '../repositories/chatbot-flow.repository.mjs';
import { addJob } from '../queues/queues.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
import { loadPostgresChatbotFlowsForDryRun } from './chatbot-flow.service.mjs';
import {
  findMatchingChatbotFlow,
  getChatbotOutgoingEdges,
  normalizeChatbotText,
  simulateChatbotFlow,
} from './chatbot-engine.service.mjs';
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
  maxOutputs: Math.max(1, Math.min(100, Number(process.env.CHATBOT_POSTGRES_MAX_OUTPUTS || process.env.CHATBOT_POSTGRES_MAX_TEXT_OUTPUTS || 50))),
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
  const messageType = output.type === 'interactive' ? 'interactive' : 'text';
  const body = output.type === 'interactive'
    ? String(output.text || 'Selecione uma opcao:')
    : String(output.text || '');
  const result = await withTransaction(async (client) => {
    const message = await insertPendingOutbound({
      tenantId,
      conversationId: conversation.id,
      clientMessageId,
      type: messageType,
      body,
      raw: {
        requestedBy: botUserId,
        origin: 'chatbot-postgres',
        inboundMessageId: inboundMessage.id,
        outputIndex,
        chatbotOutput: output,
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

const outputIsSendable = (output = {}) =>
  output.type === 'text' || output.type === 'interactive';

const findFlowById = (flows = [], flowId = '') =>
  flows.find((flow) => String(flow.id) === String(flowId)) || null;

const findUraTargetNodeId = ({ flow, session, text }) => {
  const edges = getChatbotOutgoingEdges(flow, session.currentNodeId || session.current_node_id || session.state?.nodeId || '');
  const normalizedText = normalizeChatbotText(text);
  const numericChoice = Number.parseInt(normalizedText, 10);
  const optionEdges = edges.filter((edge) => (edge.data?.connectionType || 'option') === 'option');

  const matched = optionEdges.find((edge, index) => {
    const title = String(edge.data?.description || `Opcao ${index + 1}`).trim();
    return normalizeChatbotText(title) === normalizedText
      || normalizeChatbotText(edge.id) === normalizedText
      || normalizeChatbotText(edge.target) === normalizedText
      || numericChoice === index + 1;
  });

  return matched?.target || '';
};

const buildDecision = ({ flow, conversation, message, session = null, startNodeId = '' }) => {
  const plan = simulateChatbotFlow({
    flow,
    conversation: {
      ...conversation,
      last_message: message.body,
      last_message_type: message.type,
    },
    session: {
      nodeId: startNodeId || session?.currentNodeId || session?.state?.nodeId || null,
      variables: session?.state?.variables || {},
    },
  });
  return {
    mode: 'live',
    source: 'postgres',
    tenantId: flow.tenantId,
    routeKey: flow.routeKey,
    conversationId: conversation.id,
    messageType: message.type,
    text: message.body,
    matched: true,
    reason: session ? 'session_resumed' : 'trigger_matched',
    trigger: flow.triggerConfig || {},
    flowId: flow.id,
    flowName: flow.name,
    version: flow.version,
    versionId: flow.versionId,
    checksum: flow.checksum,
    nodeId: plan.trace[0]?.nodeId || '',
    wouldSend: plan.outputs,
    nextState: plan.nextState,
    trace: plan.trace,
    variables: plan.variables,
  };
};

const persistSessionFromDecision = async ({ tenantId, conversation, message, decision, createdMessages }) => {
  const stateStatus = decision.nextState?.status || 'closed';
  const isOpen = ['awaiting_ura', 'waiting_timer'].includes(stateStatus);
  const flowId = decision.flowId || null;
  const flowVersionId = decision.versionId || null;
  const currentNodeId = isOpen ? decision.nextState.nodeId : null;
  const state = {
    ...(decision.nextState || { status: stateStatus }),
    variables: decision.variables || {},
    trace: decision.trace || [],
  };
  return upsertChatbotSession({
    tenantId,
    conversationId: conversation.id,
    flowId,
    flowVersionId,
    currentNodeId,
    status: isOpen ? 'active' : 'closed',
    state,
    lastInboundMessageId: message.id,
    lastOutboundMessageId: createdMessages.at(-1)?.id || null,
  });
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

  const flows = await loadPostgresChatbotFlowsForDryRun({
    tenantId,
    routeKey,
  });
  const session = await findChatbotSessionByConversation({ tenantId, conversationId: conversation.id });
  let flow = null;
  let decision = null;

  if (session?.status === 'active' && session.flowId) {
    flow = findFlowById(flows, session.flowId);
    const sessionStatus = String(session.state?.status || '').trim();
    if (flow && sessionStatus === 'awaiting_ura') {
      const targetNodeId = findUraTargetNodeId({ flow, session, text: message.body });
      if (targetNodeId) {
        decision = buildDecision({ flow, conversation, message, session, startNodeId: targetNodeId });
      } else {
        await recordChatbotEvent({
          tenantId,
          conversationId: conversation.id,
          messageId: message.id,
          flowId: session.flowId,
          flowVersionId: session.flowVersionId,
          sessionId: session.id,
          eventType: 'live_ura_no_option',
          mode: 'live',
          payload: { routeKey, text: message.body, createsOutboundJob: false, callsMeta: false },
        });
        return buildSkip('ura_no_option', { routeKey, session });
      }
    } else if (flow && sessionStatus === 'waiting_timer') {
      const resumeAt = Date.parse(String(session.state?.resumeAt || ''));
      if (Number.isFinite(resumeAt) && Date.now() < resumeAt) {
        return buildSkip('waiting_timer_pending', { routeKey, session });
      }
      decision = buildDecision({
        flow,
        conversation,
        message,
        session,
        startNodeId: session.state?.resumeNodeId || session.currentNodeId || '',
      });
    }
  }

  if (!decision) {
    flow = findMatchingChatbotFlow(flows, message.body);
    if (flow) {
      decision = buildDecision({ flow, conversation, message });
    }
  }

  if (!decision) {
    await recordChatbotEvent({
      tenantId,
      conversationId: conversation.id,
      messageId: message.id,
      eventType: 'live_no_match',
      mode: 'live',
      payload: {
        routeKey,
        reason: flows.length ? 'no_trigger' : 'no_active_flows',
        createsOutboundJob: false,
        callsMeta: false,
      },
    });
    return buildSkip(flows.length ? 'no_trigger' : 'no_active_flows', { routeKey });
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

  const sendableOutputs = (decision.wouldSend || [])
    .filter(outputIsSendable)
    .slice(0, cfg.maxOutputs);
  const skippedOutputs = (decision.wouldSend || [])
    .filter((output) => !outputIsSendable(output));

  if (!sendableOutputs.length) {
    const sessionRecord = await persistSessionFromDecision({
      tenantId,
      conversation,
      message,
      decision,
      createdMessages: [],
    });
    await recordChatbotEvent({
      tenantId,
      conversationId: conversation.id,
      messageId: message.id,
      flowId: decision.flowId || null,
      flowVersionId: decision.versionId || null,
      sessionId: sessionRecord?.id || null,
      eventType: 'live_no_supported_outputs',
      mode: 'live',
      payload: { routeKey, decision, skippedOutputs },
    });
    return buildSkip('no_supported_outputs', { routeKey, decision, skippedOutputs });
  }

  const createdMessages = [];
  for (const [index, output] of sendableOutputs.entries()) {
    createdMessages.push(await createBotOutboundMessage({
      tenantId,
      conversation,
      inboundMessage: message,
      output,
      outputIndex: index,
      botUserId: cfg.botUserId,
    }));
  }

  const sessionRecord = await persistSessionFromDecision({
    tenantId,
    conversation,
    message,
    decision,
    createdMessages,
  });

  await recordChatbotEvent({
    tenantId,
    conversationId: conversation.id,
    messageId: message.id,
    flowId: decision.flowId || null,
    flowVersionId: decision.versionId || null,
    sessionId: sessionRecord?.id || null,
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
    nextState: decision.nextState?.status || 'closed',
  }, 'postgres chatbot live outbound queued');

  return {
    skipped: false,
    reason: 'outbound_queued',
    routeKey,
    decision,
    createdOutbound: createdMessages.length,
    queuedOutbound: createdMessages.length,
    skippedOutputs,
    nextState: decision.nextState,
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
    maxOutputs: cfg.maxOutputs,
  };
};
