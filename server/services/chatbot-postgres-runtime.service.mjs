import { withTransaction } from '../db/postgres.mjs';
import {
  findChatbotSessionByConversationForUpdate,
  recordChatbotEvent,
  upsertChatbotSession,
} from '../repositories/chatbot-flow.repository.mjs';
import { loadPostgresChatbotFlowsForDryRun } from './chatbot-flow.service.mjs';
import {
  getChatbotOutgoingEdges,
  normalizeChatbotText,
  selectChatbotFlowWinner,
  simulateChatbotFlow,
} from './chatbot-engine.service.mjs';
import {
  createChatbotOutputBatch,
  enqueueInitialChatbotOutput,
} from './chatbot-sequence.service.mjs';
import { getLogger } from './logger.service.mjs';

const truthy = (value) => ['1', 'true', 'yes', 'sim', 'on'].includes(String(value || '').trim().toLowerCase());
const listEnv = (value) => String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);

const config = () => ({
  runtimeEnabled: truthy(process.env.CHATBOT_POSTGRES_RUNTIME_ENABLED),
  outboundEnabled: truthy(process.env.CHATBOT_POSTGRES_OUTBOUND_ENABLED),
  requireLegacyDisabled: !truthy(process.env.CHATBOT_ENABLED),
  sourceIsPostgres: String(process.env.CHATBOT_FLOW_SOURCE || '').trim().toLowerCase() === 'postgres',
  allowedRoutes: listEnv(process.env.CHATBOT_POSTGRES_ALLOWED_ROUTES || process.env.CHATBOT_ALLOWED_ROUTES),
  allowedFlowIds: listEnv(process.env.CHATBOT_POSTGRES_ALLOWED_FLOW_IDS || process.env.CHATBOT_ALLOWED_FLOW_IDS),
  allowAssignedConversations: truthy(process.env.CHATBOT_POSTGRES_ALLOW_ASSIGNED_CONVERSATIONS),
  maxOutputs: Math.max(1, Math.min(100, Number(process.env.CHATBOT_POSTGRES_MAX_OUTPUTS || process.env.CHATBOT_POSTGRES_MAX_TEXT_OUTPUTS || 10))),
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

const uniqueValues = (values) => [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];

export const normalizeChatbotInboundValues = (message = {}) => {
  const raw = message.raw_json && typeof message.raw_json === 'object' ? message.raw_json : {};
  const values = uniqueValues([
    message.body,
    raw.text?.body,
    raw.button?.text,
    raw.button?.payload,
    raw.interactive?.button_reply?.title,
    raw.interactive?.button_reply?.id,
    raw.interactive?.list_reply?.title,
    raw.interactive?.list_reply?.id,
  ]);
  return {
    primary: values[0] || '',
    values,
    normalizedValues: uniqueValues(values.map(normalizeChatbotText)),
  };
};

const findFlowById = (flows = [], flowId = '') =>
  flows.find((flow) => String(flow.id) === String(flowId)) || null;

const findUraMatch = ({ flow, session, inbound }) => {
  const edges = getChatbotOutgoingEdges(flow, session.currentNodeId || session.state?.nodeId || '');
  const optionEdges = edges.filter((edge) => (edge.data?.connectionType || 'option') === 'option');
  for (const [index, edge] of optionEdges.entries()) {
    const comparable = uniqueValues([
      edge.data?.description,
      edge.data?.title,
      edge.data?.id,
      edge.data?.targetNodeId,
      edge.id,
      edge.target,
      String(index + 1),
    ]).map(normalizeChatbotText);
    const matchedValue = inbound.normalizedValues.find((value) => comparable.includes(value));
    if (matchedValue) return { targetNodeId: String(edge.target || ''), edge, optionIndex: index, matchedValue };
  }
  return null;
};

const buildDecision = ({ flow, conversation, message, inbound, session = null, startNodeId = '' }) => {
  const plan = simulateChatbotFlow({
    flow,
    conversation: {
      ...conversation,
      last_message: inbound.primary,
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
    text: inbound.primary,
    matched: true,
    reason: session ? 'session_resumed' : 'trigger_matched',
    trigger: flow.triggerConfig || {},
    flowId: flow.id,
    flowName: flow.name,
    version: flow.version,
    versionId: flow.versionId,
    checksum: flow.checksum,
    nodeId: plan.trace[0]?.nodeId || '',
    wouldSend: plan.outputs.map((output) => ({ ...output, nodeId: output.nodeId || plan.trace[0]?.nodeId || null })),
    nextState: plan.nextState,
    trace: plan.trace,
    variables: plan.variables,
  };
};

const persistSessionFromDecision = async ({ client, tenantId, conversation, message, decision }) => {
  const stateStatus = decision.nextState?.status || 'closed';
  const isOpen = ['awaiting_ura', 'waiting_timer'].includes(stateStatus);
  return upsertChatbotSession({
    tenantId,
    conversationId: conversation.id,
    flowId: decision.flowId || null,
    flowVersionId: decision.versionId || null,
    currentNodeId: isOpen ? decision.nextState.nodeId : null,
    status: isOpen ? 'active' : 'closed',
    state: {
      ...(decision.nextState || { status: stateStatus }),
      variables: decision.variables || {},
      trace: decision.trace || [],
    },
    lastInboundMessageId: message.id,
    lastOutboundMessageId: null,
  }, client);
};

const audit = (client, { tenantId, conversation, message, flow = null, session = null, eventType, payload = {} }) =>
  recordChatbotEvent({
    tenantId,
    conversationId: conversation.id,
    messageId: message.id,
    flowId: flow?.id || session?.flowId || null,
    flowVersionId: flow?.versionId || session?.flowVersionId || null,
    sessionId: session?.id || null,
    eventType,
    mode: 'live',
    payload: {
      tenantId,
      conversationId: conversation.id,
      inboundMessageId: message.id,
      flowId: flow?.id || session?.flowId || null,
      flowVersionId: flow?.versionId || session?.flowVersionId || null,
      sessionId: session?.id || null,
      ...payload,
    },
  }, client);

const outputIsSendable = (output = {}) => output.type === 'text' || output.type === 'interactive';

export const processPostgresChatbotForInbound = async ({ tenantId, item, message, conversation }) => {
  const cfg = config();
  const logger = await getLogger();
  const routeKey = routeFromItem(item, conversation);
  const inbound = normalizeChatbotInboundValues(message);

  if (!cfg.runtimeEnabled) return buildSkip('runtime_disabled');
  if (!cfg.outboundEnabled) return buildSkip('outbound_disabled');
  if (!cfg.requireLegacyDisabled) return buildSkip('legacy_chatbot_enabled');
  if (!cfg.sourceIsPostgres) return buildSkip('source_not_postgres');
  if (cfg.allowedRoutes.length && !cfg.allowedRoutes.includes(routeKey)) return buildSkip('route_not_allowed', { routeKey });
  if (message.direction !== 'inbound') return buildSkip('not_inbound');
  if (!['text', 'button', 'interactive'].includes(message.type)) return buildSkip('unsupported_message_type', { messageType: message.type });
  if (!inbound.primary) return buildSkip('empty_text');
  if (conversation.assigned_agent_id && !cfg.allowAssignedConversations) {
    await audit(null, {
      tenantId,
      conversation,
      message,
      eventType: 'ignored_assigned_conversation',
      payload: { reason: 'assigned_to_human', assignedAgentId: conversation.assigned_agent_id, routeKey },
    });
    return buildSkip('conversation_assigned_to_human', { assignedAgentId: conversation.assigned_agent_id });
  }

  const flows = await loadPostgresChatbotFlowsForDryRun({ tenantId, routeKey });
  const transactionResult = await withTransaction(async (client) => {
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS acquired',
      [tenantId, conversation.id],
    );
    if (!lockResult.rows[0]?.acquired) {
      await audit(client, { tenantId, conversation, message, eventType: 'conversation_locked', payload: { reason: 'transaction_lock_busy', routeKey } });
      return buildSkip('conversation_locked', { routeKey });
    }

    const duplicateResult = await client.query(`
      SELECT id, status FROM chatbot_output_batches
      WHERE tenant_id=$1 AND inbound_message_id=$2
      LIMIT 1
    `, [tenantId, message.id]);
    if (duplicateResult.rows[0]) {
      await audit(client, {
        tenantId,
        conversation,
        message,
        eventType: 'ignored_duplicate_message',
        payload: { reason: 'batch_already_exists', batchId: duplicateResult.rows[0].id, batchStatus: duplicateResult.rows[0].status },
      });
      return buildSkip('duplicate_inbound', { routeKey, batchId: duplicateResult.rows[0].id });
    }

    const activeBatchResult = await client.query(`
      SELECT id, status, inbound_message_id
      FROM chatbot_output_batches
      WHERE tenant_id=$1 AND conversation_id=$2 AND status IN ('pending','processing')
      ORDER BY created_at DESC LIMIT 1
    `, [tenantId, conversation.id]);
    if (activeBatchResult.rows[0]) {
      await audit(client, {
        tenantId,
        conversation,
        message,
        eventType: 'conversation_locked',
        payload: { reason: 'active_batch', batchId: activeBatchResult.rows[0].id, routeKey },
      });
      return buildSkip('active_batch', { routeKey, batchId: activeBatchResult.rows[0].id });
    }

    const session = await findChatbotSessionByConversationForUpdate({ tenantId, conversationId: conversation.id }, client);
    let flow = null;
    let decision = null;
    if (session?.status === 'active' && session.flowId) {
      flow = findFlowById(flows, session.flowId);
      const sessionStatus = String(session.state?.status || '').trim();
      if (flow && sessionStatus === 'awaiting_ura') {
        const match = findUraMatch({ flow, session, inbound });
        if (!match?.targetNodeId) {
          await audit(client, {
            tenantId,
            conversation,
            message,
            flow,
            session,
            eventType: 'ura_option_not_matched',
            payload: { reason: 'no_matching_option', routeKey, inputValues: inbound.values },
          });
          return buildSkip('ura_no_option', { routeKey, session });
        }
        await audit(client, {
          tenantId,
          conversation,
          message,
          flow,
          session,
          eventType: 'ura_option_matched',
          payload: { routeKey, edgeId: match.edge.id, targetNodeId: match.targetNodeId, optionIndex: match.optionIndex, matchedValue: match.matchedValue },
        });
        decision = buildDecision({ flow, conversation, message, inbound, session, startNodeId: match.targetNodeId });
        await audit(client, { tenantId, conversation, message, flow, session, eventType: 'session_resumed', payload: { routeKey, reason: 'ura_option_matched' } });
      } else if (flow && sessionStatus === 'waiting_timer') {
        const resumeAt = Date.parse(String(session.state?.resumeAt || ''));
        if (Number.isFinite(resumeAt) && Date.now() < resumeAt) return buildSkip('waiting_timer_pending', { routeKey, session });
        decision = buildDecision({
          flow,
          conversation,
          message,
          inbound,
          session,
          startNodeId: session.state?.resumeNodeId || session.currentNodeId || '',
        });
        await audit(client, { tenantId, conversation, message, flow, session, eventType: 'session_resumed', payload: { routeKey, reason: 'timer_elapsed' } });
      }
    }

    if (!decision) {
      const selection = selectChatbotFlowWinner(flows, inbound.primary, routeKey);
      await audit(client, {
        tenantId,
        conversation,
        message,
        eventType: 'flow_candidates_found',
        payload: {
          routeKey,
          candidateFlowIds: selection.candidates.map((candidate) => candidate.flow.id),
          candidateCount: selection.candidates.length,
        },
      });
      flow = selection.winner;
      if (flow) {
        await audit(client, { tenantId, conversation, message, flow, eventType: 'flow_selected', payload: { routeKey, reason: 'deterministic_ranking' } });
        for (const candidate of selection.candidates.filter((entry) => !entry.selected)) {
          await audit(client, {
            tenantId,
            conversation,
            message,
            flow: candidate.flow,
            eventType: 'flow_skipped',
            payload: { routeKey, reason: 'lower_deterministic_rank', winnerFlowId: flow.id },
          });
        }
        decision = buildDecision({ flow, conversation, message, inbound });
      }
    }

    if (!decision) return buildSkip(flows.length ? 'no_trigger' : 'no_active_flows', { routeKey });
    if (cfg.allowedFlowIds.length && !cfg.allowedFlowIds.includes(String(decision.flowId).toLowerCase())) {
      await audit(client, { tenantId, conversation, message, flow, eventType: 'flow_skipped', payload: { routeKey, reason: 'flow_not_allowed' } });
      return buildSkip('flow_not_allowed', { routeKey, decision });
    }

    const sendableOutputs = (decision.wouldSend || []).filter(outputIsSendable).slice(0, cfg.maxOutputs);
    const skippedOutputs = (decision.wouldSend || []).filter((output) => !outputIsSendable(output));
    const sessionRecord = await persistSessionFromDecision({ client, tenantId, conversation, message, decision });
    if (decision.nextState?.status === 'awaiting_ura') {
      await audit(client, { tenantId, conversation, message, flow, session: sessionRecord, eventType: 'session_waiting_ura', payload: { routeKey, nodeId: decision.nextState.nodeId } });
    }
    if (!sendableOutputs.length) return buildSkip('no_supported_outputs', { routeKey, decision, skippedOutputs });

    const created = await createChatbotOutputBatch({
      client,
      tenantId,
      conversation,
      inboundMessage: message,
      decision,
      sessionId: sessionRecord?.id || null,
      outputs: sendableOutputs,
      botUserId: cfg.botUserId,
    });
    return {
      skipped: false,
      reason: 'outbound_batch_created',
      routeKey,
      decision,
      createdOutbound: 1,
      queuedOutbound: 1,
      plannedOutbound: sendableOutputs.length,
      skippedOutputs,
      nextState: decision.nextState,
      created,
    };
  });

  if (transactionResult.created) await enqueueInitialChatbotOutput(transactionResult.created);
  logger.info({
    tenantId,
    conversationId: conversation.id,
    inboundMessageId: message.id,
    flowId: transactionResult.decision?.flowId,
    batchId: transactionResult.created?.batch?.id,
    routeKey,
    plannedOutbound: transactionResult.plannedOutbound || 0,
    queuedOutbound: transactionResult.queuedOutbound || 0,
    skipped: transactionResult.skipped,
    reason: transactionResult.reason,
  }, 'postgres chatbot sequential runtime decision');
  const { created: _created, ...publicResult } = transactionResult;
  return publicResult;
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
    sequencing: 'per-conversation-postgres-advisory-lock',
  };
};
