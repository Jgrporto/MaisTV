import { createHash } from 'node:crypto';

const CHATBOT_START_NODE_ID = 'chatbot-start';

export const normalizeChatbotText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const normalizeVariableKey = (value) =>
  String(value || '')
    .trim()
    .replace(/^\{#/, '')
    .replace(/\}$/, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

const stableClone = (value) => {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableClone(value[key])]),
    );
  }
  return value;
};

export const stableStringify = (value) => JSON.stringify(stableClone(value));

export const calculateDefinitionChecksum = (definition = {}) =>
  createHash('sha256').update(stableStringify(definition)).digest('hex');

export const normalizeChatbotFlowState = (state = {}) => {
  const source = state && typeof state === 'object' ? state : {};
  const viewport = source.viewport && typeof source.viewport === 'object'
    ? source.viewport
    : { x: 0, y: 0, zoom: 1 };
  const sourceNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const startIndex = sourceNodes.findIndex(
    (node) => node?.id === CHATBOT_START_NODE_ID || node?.data?.componentType === 'start',
  );
  const startSource = startIndex >= 0 ? sourceNodes[startIndex] : {};
  const startNode = {
    ...startSource,
    id: CHATBOT_START_NODE_ID,
    type: 'chatbotNode',
    deletable: false,
    position: startSource.position || { x: 40, y: 120 },
    data: {
      ...(startSource.data && typeof startSource.data === 'object' ? startSource.data : {}),
      componentType: 'start',
      name: String(startSource.data?.name || 'inicio fluxo').trim() || 'inicio fluxo',
      rule: String(startSource.data?.rule || 'contains').trim() || 'contains',
      triggerValue: String(startSource.data?.triggerValue || '').trim(),
    },
  };
  const nodes = [
    startNode,
    ...sourceNodes.filter((_, index) => index !== startIndex && sourceNodes[index]?.data?.componentType !== 'start'),
  ];
  const validNodeIds = new Set(nodes.map((node) => String(node?.id || '')).filter(Boolean));

  return {
    nodes,
    edges: (Array.isArray(source.edges) ? source.edges : []).filter(
      (edge) => validNodeIds.has(String(edge?.source || '')) && validNodeIds.has(String(edge?.target || '')),
    ),
    viewport: {
      x: Number.isFinite(Number(viewport.x)) ? Number(viewport.x) : 0,
      y: Number.isFinite(Number(viewport.y)) ? Number(viewport.y) : 0,
      zoom: Number.isFinite(Number(viewport.zoom)) ? Number(viewport.zoom) : 1,
    },
  };
};

export const normalizeLegacyChatbotFlow = (flow = {}, index = 0, fallbackCode = null) => {
  const code = Number.isFinite(Number(flow.code)) && Number(flow.code) > 0
    ? Number(flow.code)
    : fallbackCode || index + 1;
  return {
    id: String(flow.id || `flow-${code}`).trim() || `flow-${code}`,
    code,
    name: String(flow.name || flow.title || `Flow ${code}`).trim() || `Flow ${code}`,
    active: Boolean(flow.active),
    state: normalizeChatbotFlowState(flow.state || flow.flow || flow),
    created_date: String(flow.created_date || flow.createdAt || new Date().toISOString()),
    updated_date: String(flow.updated_date || flow.updatedAt || ''),
  };
};

export const normalizeLegacyChatbotFlows = (flows = []) =>
  (Array.isArray(flows) ? flows : [])
    .map((flow, index) => normalizeLegacyChatbotFlow(flow, index))
    .filter((flow) => flow.name)
    .sort((left, right) => Number(left.code || 0) - Number(right.code || 0));

export const buildChatbotDefinition = ({ legacyFlow, source = 'legacy-store' }) => ({
  schemaVersion: 1,
  source,
  legacy: {
    id: legacyFlow.id,
    code: legacyFlow.code,
    active: Boolean(legacyFlow.active),
    created_date: legacyFlow.created_date,
    updated_date: legacyFlow.updated_date,
  },
  name: legacyFlow.name,
  state: normalizeChatbotFlowState(legacyFlow.state),
});

export const extractTriggerConfig = (definition = {}) => {
  const startNode = getNodeById({ definition }, CHATBOT_START_NODE_ID);
  return {
    rule: String(startNode?.data?.rule || 'contains').trim() || 'contains',
    triggerValue: String(startNode?.data?.triggerValue || '').trim(),
  };
};

export const validateChatbotDefinition = (definition = {}) => {
  const errors = [];
  const state = definition?.state && typeof definition.state === 'object' ? definition.state : null;
  const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
  const edges = Array.isArray(state?.edges) ? state.edges : [];
  const startNode = nodes.find((node) => node?.id === CHATBOT_START_NODE_ID || node?.data?.componentType === 'start');
  if (!state) errors.push('definition.state ausente');
  if (!nodes.length) errors.push('definition.state.nodes vazio');
  if (!startNode) errors.push('no inicial do chatbot ausente');
  for (const edge of edges) {
    if (!String(edge?.source || '').trim() || !String(edge?.target || '').trim()) {
      errors.push(`edge invalida: ${edge?.id || 'sem id'}`);
    }
  }
  return { valid: errors.length === 0, errors };
};

const getState = (flow = {}) => {
  const definition = flow.definition || flow.version?.definition || flow;
  return definition?.state && typeof definition.state === 'object'
    ? definition.state
    : normalizeChatbotFlowState(definition);
};

export const getNodeById = (flow = {}, nodeId) =>
  (Array.isArray(getState(flow).nodes) ? getState(flow).nodes : [])
    .find((node) => String(node.id) === String(nodeId)) || null;

export const getChatbotOutgoingEdges = (flow = {}, nodeId) =>
  (Array.isArray(getState(flow).edges) ? getState(flow).edges : [])
    .filter((edge) => String(edge.source) === String(nodeId));

export const interpolateChatbotText = (template = '', variables = {}) =>
  String(template || '').replace(/\{#([A-Za-z0-9_]+)\}/g, (_, key) => {
    const normalizedKey = normalizeVariableKey(key);
    return variables[normalizedKey] != null ? String(variables[normalizedKey]) : '';
  });

export const buildDefaultChatbotVariables = (conversation = {}) => {
  const customer = conversation.customer || {};
  const source = customer.sourceCustomer || customer.raw || customer;
  return {
    usuario: String(source.usuario || source.user || source.username || source.login || source.name || customer.name || '').trim(),
    senha: String(source.senha || source.password || source.pass || '').trim(),
    plano: String(source.plano || source.plan || source.package || customer.plan || '').trim(),
    vencimento: String(source.vencimento || source.due_date || source.expiration_date || source.data_vencimento || '').trim(),
  };
};

export const evaluateChatbotRule = (rule, sourceValue, expectedValue) => {
  const normalizedRule = String(rule || 'contains').trim();
  const left = normalizeChatbotText(sourceValue);
  const right = normalizeChatbotText(expectedValue);
  if (!right) return false;
  if (normalizedRule === 'not_equal') return left !== right;
  if (normalizedRule === 'equals') return left === right;
  if (['gte', 'gt', 'lte', 'lt'].includes(normalizedRule)) {
    const leftNumber = Number(left.replace(',', '.'));
    const rightNumber = Number(right.replace(',', '.'));
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
    if (normalizedRule === 'gte') return leftNumber >= rightNumber;
    if (normalizedRule === 'gt') return leftNumber > rightNumber;
    if (normalizedRule === 'lte') return leftNumber <= rightNumber;
    return leftNumber < rightNumber;
  }
  return left.includes(right);
};

export const findMatchingChatbotFlow = (flows = [], text = '') =>
  (Array.isArray(flows) ? flows : []).find((flow) => {
    const trigger = flow.triggerConfig || extractTriggerConfig(flow.definition || flow.version?.definition || {});
    return evaluateChatbotRule(trigger.rule || 'contains', text, trigger.triggerValue || '');
  }) || null;

const describeOutput = (type, payload = {}) => ({ type, ...payload });

export const simulateChatbotFlow = ({ flow, conversation, session = null }) => {
  const variables = {
    ...buildDefaultChatbotVariables(conversation),
    ...(session?.variables && typeof session.variables === 'object' ? session.variables : {}),
  };
  const outputs = [];
  const trace = [];
  let nextState = null;
  let nodeId = session?.nodeId || getChatbotOutgoingEdges(flow, CHATBOT_START_NODE_ID)[0]?.target || '';
  let guard = 0;

  while (nodeId && guard < 50) {
    guard += 1;
    const node = getNodeById(flow, nodeId);
    if (!node) {
      trace.push({ nodeId, type: 'missing_node' });
      break;
    }
    const data = node.data || {};
    const outgoingEdges = getChatbotOutgoingEdges(flow, node.id);
    let nextNodeId = outgoingEdges[0]?.target || '';

    trace.push({
      nodeId: String(node.id || ''),
      type: String(data.componentType || ''),
      name: String(data.name || ''),
    });

    if (data.componentType === 'message') {
      const text = interpolateChatbotText(data.text || '', variables);
      if (data.headerType && data.headerType !== 'none' && data.headerAsset?.dataUrl) {
        outputs.push(describeOutput('media', {
          mediaType: String(data.headerType),
          mimeType: String(data.headerAsset?.mimeType || 'application/octet-stream'),
          fileName: String(data.headerAsset?.fileName || ''),
          dataUrl: String(data.headerAsset?.dataUrl || ''),
          caption: text,
        }));
      } else if (text) {
        outputs.push(describeOutput('text', { text }));
      }
    } else if (data.componentType === 'audio' && data.audioAsset?.dataUrl) {
      outputs.push(describeOutput('audio', {
        fileName: String(data.audioAsset?.fileName || data.audioName || ''),
        mimeType: String(data.audioAsset?.mimeType || 'audio/ogg'),
        dataUrl: String(data.audioAsset?.dataUrl || ''),
      }));
    } else if (data.componentType === 'label') {
      outputs.push(describeOutput('label', {
        addLabelId: String(data.addLabelId || ''),
        removeLabelId: String(data.removeLabelId || ''),
        removeAllCustom: Boolean(data.removeAllCustom),
      }));
    } else if (data.componentType === 'finish') {
      outputs.push(describeOutput('finish', {
        finishType: String(data.finishType || 'resolved'),
      }));
      nextState = { status: 'finished', nodeId: '' };
      break;
    } else if (data.componentType === 'variables') {
      for (const variable of Array.isArray(data.variables) ? data.variables : []) {
        const key = normalizeVariableKey(variable.key);
        if (key) variables[key] = interpolateChatbotText(variable.value || '', variables);
      }
      outputs.push(describeOutput('variables', { keys: Object.keys(variables).sort() }));
    } else if (data.componentType === 'redirect') {
      nextNodeId = data.destinationNodeId || nextNodeId;
    } else if (data.componentType === 'wait') {
      nextState = {
        status: 'waiting_timer',
        nodeId: String(node.id || ''),
        resumeNodeId: nextNodeId,
        resumeAfterSeconds: Math.max(1, Number(data.waitSeconds || 1)),
      };
      break;
    } else if (data.componentType === 'ura') {
      const options = outgoingEdges
        .filter((edge) => (edge.data?.connectionType || 'option') === 'option')
        .map((edge, index) => ({
          id: String(edge.id || `option-${index + 1}`),
          title: String(edge.data?.description || `Opcao ${index + 1}`).trim(),
          targetNodeId: String(edge.target || ''),
        }))
        .filter((option) => option.title);
      outputs.push(describeOutput('interactive', {
        displayAs: String(data.displayAs || 'buttons'),
        text: interpolateChatbotText(data.text || data.body || 'Selecione uma opcao:', variables),
        options,
      }));
      nextState = {
        status: 'awaiting_ura',
        nodeId: String(node.id || ''),
        timeoutMinutes: Math.max(1, Number(data.waitMinutes || 1)),
      };
      break;
    }

    nodeId = nextNodeId;
  }

  if (guard >= 50) {
    trace.push({ type: 'guard_stop', reason: 'max_50_nodes' });
  }

  return {
    outputs,
    trace,
    nextState,
    variables,
  };
};

export const buildDryRunConversation = ({ routeKey, text, type = 'text', phone = '5524999999999', conversationId = '' }) => {
  const timestamp = new Date().toISOString();
  const normalizedPhone = String(phone || '').replace(/\D/g, '') || '5524999999999';
  return {
    id: conversationId || `dry-run-${routeKey || 'default'}-${normalizedPhone}`,
    contact_name: 'Dry Run',
    contact_phone: normalizedPhone,
    phone: normalizedPhone,
    customer: { phone: normalizedPhone, name: 'Dry Run' },
    meta_route_key: routeKey || 'default',
    last_message: text,
    last_message_type: type || 'text',
    last_message_time: timestamp,
    last_message_at: timestamp,
    updated_date: timestamp,
    last_received_at: timestamp,
    last_client_message_time: timestamp,
    last_sent_at: null,
    unread_count: 1,
  };
};
