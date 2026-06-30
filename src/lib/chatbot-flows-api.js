import { parseJsonResponse, requestLocalApi } from '@/lib/local-api';

export const CHATBOT_VARIABLES = [
  { key: '{#usuario}', label: 'Usuario', locked: true },
  { key: '{#senha}', label: 'Senha', locked: true },
  { key: '{#plano}', label: 'Plano', locked: true },
  { key: '{#vencimento}', label: 'Vencimento', locked: true },
];

export const CHATBOT_START_NODE_ID = 'chatbot-start';

export const EMPTY_FLOW_STATE = {
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

const requestChatbotJson = async (path = '', options = {}) => {
  const response = await requestLocalApi(`/chatbot/flows${path}`, options);
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Falha ao acessar flows de chatbot.');
  }

  return data;
};

export const createStartNode = (node = {}) => ({
  id: CHATBOT_START_NODE_ID,
  type: 'chatbotNode',
  position: node.position || { x: 40, y: 120 },
  deletable: false,
  data: {
    componentType: 'start',
    name: 'inicio fluxo',
    rule: 'contains',
    triggerValue: '',
    ...(node.data && typeof node.data === 'object' ? node.data : {}),
    componentType: 'start',
    name: String(node.data?.name || 'inicio fluxo').trim() || 'inicio fluxo',
  },
});

export const ensureStartNode = (state = {}) => {
  const source = state && typeof state === 'object' ? state : {};
  const nodes = Array.isArray(source.nodes) ? source.nodes : [];
  const edges = Array.isArray(source.edges) ? source.edges : [];
  const startIndex = nodes.findIndex(
    (node) => node?.id === CHATBOT_START_NODE_ID || node?.data?.componentType === 'start',
  );
  const startNode = startIndex >= 0 ? createStartNode(nodes[startIndex]) : createStartNode();
  const restNodes = nodes.filter((_, index) => index !== startIndex);
  const validNodeIds = new Set([startNode.id, ...restNodes.map((node) => String(node?.id || '')).filter(Boolean)]);

  return {
    ...source,
    nodes: [startNode, ...restNodes],
    edges: edges.filter((edge) => validNodeIds.has(String(edge?.source || '')) && validNodeIds.has(String(edge?.target || ''))),
  };
};

export const normalizeFlowState = (state = {}) => {
  const source = ensureStartNode(state && typeof state === 'object' ? state : {});
  const viewport = source.viewport && typeof source.viewport === 'object' ? source.viewport : EMPTY_FLOW_STATE.viewport;

  return {
    nodes: Array.isArray(source.nodes) ? source.nodes : [],
    edges: Array.isArray(source.edges) ? source.edges : [],
    viewport: {
      x: Number.isFinite(Number(viewport.x)) ? Number(viewport.x) : 0,
      y: Number.isFinite(Number(viewport.y)) ? Number(viewport.y) : 0,
      zoom: Number.isFinite(Number(viewport.zoom)) ? Number(viewport.zoom) : 1,
    },
  };
};

export const normalizeChatbotFlow = (flow = {}, index = 0) => {
  const code = Number.isFinite(Number(flow.code)) && Number(flow.code) > 0 ? Number(flow.code) : index + 1;

  return {
    id: String(flow.id || `flow-${code}`),
    code,
    name: String(flow.name || `Flow ${code}`).trim() || `Flow ${code}`,
    active: Boolean(flow.active),
    state: normalizeFlowState(flow.state || flow),
    created_date: String(flow.created_date || flow.createdAt || new Date().toISOString()),
    updated_date: String(flow.updated_date || flow.updatedAt || ''),
  };
};

export const normalizeChatbotFlowSummary = (flow = {}, index = 0) => {
  const code = Number.isFinite(Number(flow.code)) && Number(flow.code) > 0 ? Number(flow.code) : index + 1;

  return {
    id: String(flow.id || `flow-${code}`),
    code,
    name: String(flow.name || `Flow ${code}`).trim() || `Flow ${code}`,
    active: Boolean(flow.active),
    created_date: String(flow.created_date || flow.createdAt || new Date().toISOString()),
    updated_date: String(flow.updated_date || flow.updatedAt || ''),
    node_count: Number.isFinite(Number(flow.node_count)) ? Number(flow.node_count) : 0,
    edge_count: Number.isFinite(Number(flow.edge_count)) ? Number(flow.edge_count) : 0,
  };
};

export const listChatbotFlows = async () => {
  const data = await requestChatbotJson('?summary=1', { method: 'GET' });
  return (Array.isArray(data) ? data : []).map((flow, index) => normalizeChatbotFlowSummary(flow, index));
};

export const fetchChatbotRuntimeState = async () => {
  const response = await requestLocalApi('/chatbot/runtime-state', { method: 'GET', timeoutMs: 5000 });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Falha ao carregar runtime do chatbot.');
  }

  return {
    activeFlows: Array.isArray(data?.activeFlows) ? data.activeFlows : [],
    activeSessionConversationIds: Array.isArray(data?.activeSessionConversationIds)
      ? data.activeSessionConversationIds.map(String)
      : [],
    waitingTimerConversationIds: Array.isArray(data?.waitingTimerConversationIds)
      ? data.waitingTimerConversationIds.map(String)
      : [],
    awaitingUraConversationIds: Array.isArray(data?.awaitingUraConversationIds)
      ? data.awaitingUraConversationIds.map(String)
      : [],
  };
};

export const getChatbotFlow = async (flowRef) => {
  const data = await requestChatbotJson(`/${encodeURIComponent(flowRef)}`, { method: 'GET' });
  return normalizeChatbotFlow(data);
};

export const createChatbotFlow = async (payload = {}) => {
  const data = await requestChatbotJson('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: payload.name || '',
      active: Boolean(payload.active),
      state: normalizeFlowState(payload.state),
    }),
  });

  return normalizeChatbotFlow(data);
};

export const importChatbotFlow = async (payload = {}) => {
  const data = await requestChatbotJson('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return normalizeChatbotFlow(data);
};

export const updateChatbotFlow = async (flowRef, payload = {}, options = {}) => {
  const suffix = options.summary ? '?summary=1' : '';
  const data = await requestChatbotJson(`/${encodeURIComponent(flowRef)}${suffix}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return options.summary ? normalizeChatbotFlowSummary(data) : normalizeChatbotFlow(data);
};

export const deleteChatbotFlow = async (flowRef) => {
  await requestChatbotJson(`/${encodeURIComponent(flowRef)}`, { method: 'DELETE' });
  return true;
};

export const uploadChatbotAsset = async ({ fileName, mimeType, dataUrl, kind }) => {
  const response = await requestLocalApi('/chatbot/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, mimeType, dataUrl, kind }),
  });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Falha ao enviar arquivo do chatbot para a VPS.');
  }

  return data;
};

export const processChatbotConversation = async (conversation, options = {}) => {
  const response = await requestLocalApi('/chatbot/process-conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: options.timeoutMs || 10000,
    body: JSON.stringify({
      conversation,
      messageKey: options.messageKey || '',
    }),
  });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Falha ao processar chatbot.');
  }

  return data;
};

const formatFlowEventContent = (event = {}) => {
  const type = String(event.type || '').trim();
  const flowName = String(event.flowName || event.flow_name || '').trim();
  if (type === 'started') {
    return `Flow Iniciado: ${flowName || 'Flow'}`;
  }
  if (type === 'finished') {
    const date = new Date(event.created_date || event.createdAt || Date.now());
    const time = Number.isNaN(date.getTime())
      ? '--:--'
      : new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
    return `Flow Finalizado as ${time}`;
  }
  return String(event.content || '').trim();
};

export const normalizeChatbotEventMessage = (event = {}) => {
  const createdAt = String(event.created_date || event.createdAt || new Date().toISOString());
  const id = String(event.id || `chatbot-event-${event.conversation_id || event.conversationId || ''}-${createdAt}`);
  return {
    id,
    message_key: id,
    server_message_id: '',
    conversation_id: String(event.conversation_id || event.conversationId || ''),
    sender_type: 'system',
    sender_name: 'Sistema',
    message_type: 'system',
    status: 'sent',
    content: formatFlowEventContent(event),
    attachments: [],
    reactions: [],
    created_date: createdAt,
    timestamp: createdAt,
    client_sort_at: createdAt,
    client_order: null,
    chatbot_event_type: String(event.type || ''),
    chatbot_flow_id: String(event.flowId || event.flow_id || ''),
  };
};

export const fetchChatbotEvents = async (conversationId) => {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) return [];

  const response = await requestLocalApi(`/chatbot/events?conversationId=${encodeURIComponent(safeConversationId)}`, {
    method: 'GET',
  });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Falha ao carregar eventos do chatbot.');
  }

  return (Array.isArray(data) ? data : []).map(normalizeChatbotEventMessage);
};

export const buildFlowEditorPath = (flow) => `/chatbot/editar/flow${Number(flow?.code || 0) || 1}`;

export const exportChatbotFlowJson = (flow) =>
  JSON.stringify(
    {
      id: flow.id,
      code: flow.code,
      name: flow.name,
      active: flow.active,
      created_date: flow.created_date,
      updated_date: flow.updated_date,
      state: normalizeFlowState(flow.state),
    },
    null,
    2,
  );

export const downloadTextFile = (fileName, content, mimeType = 'application/json') => {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};
