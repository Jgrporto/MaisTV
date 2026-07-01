import {
  extractTriggerConfig,
  normalizeChatbotText,
  validateChatbotDefinition,
} from './chatbot-engine.service.mjs';

const START_NODE_ID = 'chatbot-start';
const MAX_SAFE_DELAY_SECONDS = 60;

const asArray = (value) => (Array.isArray(value) ? value : []);

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const getDefinition = (flow = {}) => flow.version?.definition || flow.definition || {};

const getState = (definition = {}) => asObject(definition.state);

const getNodes = (definition = {}) => asArray(getState(definition).nodes);

const getEdges = (definition = {}) => asArray(getState(definition).edges);

const nodeType = (node = {}) => String(node.data?.componentType || '').trim().toLowerCase();

const textValue = (value) => String(value || '').trim();

const normalizedIncludesAny = (value, needles = []) => {
  const source = normalizeChatbotText(value);
  return needles.some((needle) => source.includes(normalizeChatbotText(needle)));
};

const walkValues = (value, visitor) => {
  if (Array.isArray(value)) {
    value.forEach((item) => walkValues(item, visitor));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      visitor(key, item);
      walkValues(item, visitor);
    });
    return;
  }
  visitor('', value);
};

const definitionContains = (definition, predicate) => {
  let found = false;
  walkValues(definition, (key, value) => {
    if (found) return;
    if (predicate(key, value)) found = true;
  });
  return found;
};

const collectNodeText = (nodes = []) =>
  nodes
    .map((node) => [
      node.data?.name,
      node.data?.text,
      node.data?.body,
      node.data?.description,
      node.data?.label,
    ].filter(Boolean).join(' '))
    .join(' ');

const classifyResponseNodes = (nodes = []) =>
  nodes.filter((node) => {
    const type = nodeType(node);
    if (['message', 'audio', 'ura', 'finish'].includes(type)) return true;
    return false;
  });

const countConditions = (nodes = [], edges = []) => {
  const edgeConditions = edges.filter((edge) => {
    const connectionType = String(edge.data?.connectionType || '').toLowerCase();
    return ['condition', 'fallback', 'option'].includes(connectionType);
  }).length;
  const nodeConditions = nodes.filter((node) => {
    const data = asObject(node.data);
    return Boolean(data.condition || data.operator || data.rule || data.variableKey);
  }).length;
  return edgeConditions + nodeConditions;
};

const hasMedia = (nodes = []) =>
  nodes.some((node) => {
    const data = asObject(node.data);
    const type = nodeType(node);
    if (type === 'audio') return Boolean(data.audioAsset || data.audioName);
    if (type === 'message') {
      const headerType = String(data.headerType || 'none').toLowerCase();
      return headerType && headerType !== 'none';
    }
    return false;
  });

const hasMissingMedia = (nodes = []) =>
  nodes.some((node) => {
    const data = asObject(node.data);
    const type = nodeType(node);
    if (type === 'audio') return !data.audioAsset?.dataUrl;
    if (type !== 'message') return false;
    const headerType = String(data.headerType || 'none').toLowerCase();
    if (!headerType || headerType === 'none') return false;
    return !data.headerAsset?.dataUrl;
  });

const hasHandoff = (definition = {}) => {
  const nodes = getNodes(definition);
  const combinedText = collectNodeText(nodes);
  if (normalizedIncludesAny(combinedText, ['atendente', 'humano', 'suporte humano', 'falar com atendente'])) {
    return true;
  }
  return nodes.some((node) => {
    const data = asObject(node.data);
    return nodeType(node) === 'finish' && normalizedIncludesAny(data.finishType, ['handoff', 'human']);
  });
};

const hasFallback = (definition = {}) => {
  const nodes = getNodes(definition);
  const edges = getEdges(definition);
  if (edges.some((edge) => normalizedIncludesAny(edge.data?.connectionType, ['fallback', 'invalid', 'timeout']))) {
    return true;
  }
  return normalizedIncludesAny(collectNodeText(nodes), [
    'nao entendi',
    'não entendi',
    'opcao invalida',
    'opção inválida',
    'tente novamente',
    'fallback',
  ]);
};

const hasTermination = (nodes = []) =>
  nodes.some((node) => nodeType(node) === 'finish');

const hasTemplateHsm = (definition = {}) =>
  definitionContains(definition, (key, value) => {
    const normalizedKey = normalizeChatbotText(key);
    const normalizedValue = normalizeChatbotText(value);
    return normalizedKey.includes('template')
      || normalizedKey.includes('hsm')
      || normalizedValue.includes('/api/whatsapp/send-template')
      || normalizedValue.includes('send-template');
  });

const hasTemplateWithoutName = (definition = {}) =>
  definitionContains(definition, (key, value) => {
    const normalizedKey = normalizeChatbotText(key);
    if (!normalizedKey.includes('template')) return false;
    if (normalizedKey.includes('name') || normalizedKey.includes('id')) {
      return !textValue(value);
    }
    return false;
  });

const hasLegacySendRoute = (definition = {}) =>
  definitionContains(definition, (_key, value) =>
    typeof value === 'string' && /\/api\/whatsapp\/send-/i.test(value));

const collectBrokenReferences = (definition = {}) => {
  const nodes = getNodes(definition);
  const edges = getEdges(definition);
  const ids = new Set(nodes.map((node) => String(node.id || '')).filter(Boolean));
  const errors = [];
  edges.forEach((edge) => {
    const source = String(edge.source || '');
    const target = String(edge.target || '');
    if (!ids.has(source)) errors.push(`edge ${edge.id || '-'} aponta source inexistente: ${source || '-'}`);
    if (!ids.has(target)) errors.push(`edge ${edge.id || '-'} aponta target inexistente: ${target || '-'}`);
  });
  nodes.forEach((node) => {
    if (nodeType(node) !== 'redirect') return;
    const destination = String(node.data?.destinationNodeId || '').trim();
    if (!destination) errors.push(`redirect ${node.id || '-'} sem destino`);
    if (destination && !ids.has(destination)) errors.push(`redirect ${node.id || '-'} aponta no inexistente: ${destination}`);
  });
  return errors;
};

const detectCycle = (definition = {}) => {
  const edges = getEdges(definition);
  const graph = new Map();
  edges.forEach((edge) => {
    const source = String(edge.source || '');
    const target = String(edge.target || '');
    if (!source || !target) return;
    if (!graph.has(source)) graph.set(source, []);
    graph.get(source).push(target);
  });
  const visiting = new Set();
  const visited = new Set();

  const visit = (nodeId, path = []) => {
    if (visiting.has(nodeId)) {
      return [...path, nodeId];
    }
    if (visited.has(nodeId)) return null;
    visiting.add(nodeId);
    for (const nextId of graph.get(nodeId) || []) {
      const result = visit(nextId, [...path, nodeId]);
      if (result) return result;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return null;
  };

  for (const nodeId of graph.keys()) {
    const result = visit(nodeId, []);
    if (result) return result;
  }
  return null;
};

const validateNodeResponses = (nodes = [], edges = []) => {
  const issues = [];
  const outgoingBySource = new Map();
  edges.forEach((edge) => {
    const source = String(edge.source || '');
    if (!source) return;
    outgoingBySource.set(source, (outgoingBySource.get(source) || 0) + 1);
  });

  nodes.forEach((node) => {
    const data = asObject(node.data);
    const type = nodeType(node);
    const nodeId = String(node.id || '-');
    if (type === 'message') {
      const hasText = Boolean(textValue(data.text));
      const headerType = String(data.headerType || 'none').toLowerCase();
      const hasHeader = headerType && headerType !== 'none' && data.headerAsset?.dataUrl;
      if (!hasText && !hasHeader) issues.push(`no ${nodeId} do tipo message sem resposta`);
    }
    if (type === 'audio' && !data.audioAsset?.dataUrl) {
      issues.push(`no ${nodeId} do tipo audio sem arquivo`);
    }
    if (type === 'ura' && !outgoingBySource.get(nodeId)) {
      issues.push(`no ${nodeId} do tipo ura sem opcoes`);
    }
  });
  return issues;
};

const collectDelays = (nodes = []) =>
  nodes
    .filter((node) => nodeType(node) === 'wait')
    .map((node) => ({
      nodeId: String(node.id || ''),
      seconds: Math.max(0, Number(node.data?.waitSeconds || 0)),
    }));

const classifyRisk = ({ flow = {}, metrics = {}, issues = [] }) => {
  const blockers = issues.filter((issue) => issue.severity === 'blocker');
  if (blockers.length) return 'bloqueado';

  const hasHighRisk = metrics.delays.length
    || metrics.usesTemplateHsm
    || metrics.responseCount >= 5
    || normalizedIncludesAny(flow.name, ['cobranca', 'cobrança', 'renovar', 'pagamento', 'reconquista', 'posvenda', 'pós-venda']);
  if (hasHighRisk) return 'alto risco';

  const hasMediumRisk = metrics.nodeCount > 3
    || metrics.conditionCount > 0
    || metrics.usesLabel
    || metrics.hasFallback;
  if (hasMediumRisk) return 'medio risco';

  return 'baixo risco';
};

export const auditChatbotFlow = (flow = {}) => {
  const definition = getDefinition(flow);
  const nodes = getNodes(definition);
  const edges = getEdges(definition);
  const startNode = nodes.find((node) => node.id === START_NODE_ID || nodeType(node) === 'start') || null;
  const baseValidation = validateChatbotDefinition(definition);
  const brokenReferences = collectBrokenReferences(definition);
  const responseIssues = validateNodeResponses(nodes, edges);
  const cycle = detectCycle(definition);
  const delays = collectDelays(nodes);
  const triggerConfig = flow.triggerConfig || extractTriggerConfig(definition);
  const issues = [];

  baseValidation.errors.forEach((message) => issues.push({ severity: 'blocker', code: 'invalid_definition', message }));
  brokenReferences.forEach((message) => issues.push({ severity: 'blocker', code: 'broken_reference', message }));
  responseIssues.forEach((message) => issues.push({ severity: 'warning', code: 'empty_response', message }));
  if (!startNode) issues.push({ severity: 'blocker', code: 'missing_start_node', message: 'fluxo sem no inicial' });
  if (cycle) issues.push({ severity: 'blocker', code: 'unbounded_loop', message: `possivel loop sem limite: ${cycle.join(' -> ')}` });
  if (!flow.routeKey) issues.push({ severity: 'blocker', code: 'missing_route_key', message: 'fluxo sem route_key confiavel' });
  if (!hasFallback(definition)) issues.push({ severity: 'blocker', code: 'missing_fallback', message: 'fluxo sem fallback identificado' });
  if (!hasHandoff(definition)) issues.push({ severity: 'blocker', code: 'missing_handoff', message: 'fluxo sem handoff humano identificado' });
  delays
    .filter((delay) => delay.seconds > MAX_SAFE_DELAY_SECONDS)
    .forEach((delay) => issues.push({
      severity: 'warning',
      code: 'dangerous_delay',
      message: `delay acima de ${MAX_SAFE_DELAY_SECONDS}s no no ${delay.nodeId}: ${delay.seconds}s`,
    }));
  if (hasTemplateWithoutName(definition)) {
    issues.push({ severity: 'blocker', code: 'template_without_name', message: 'template/HSM sem nome identificado' });
  }
  if (hasMissingMedia(nodes)) {
    issues.push({ severity: 'blocker', code: 'media_without_file', message: 'midia configurada sem arquivo incorporado' });
  }
  if (hasLegacySendRoute(definition)) {
    issues.push({ severity: 'blocker', code: 'legacy_send_route', message: 'fluxo referencia rota legada /api/whatsapp/send-*' });
  }
  if (definition.legacy && typeof definition.legacy === 'object') {
    issues.push({ severity: 'info', code: 'legacy_origin', message: 'fluxo originado do legado; validar campos antes de ativacao real' });
  }

  const metrics = {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    responseCount: classifyResponseNodes(nodes).length,
    conditionCount: countConditions(nodes, edges),
    delays,
    usesMedia: hasMedia(nodes),
    usesTemplateHsm: hasTemplateHsm(definition),
    usesLabel: nodes.some((node) => nodeType(node) === 'label'),
    hasHandoff: hasHandoff(definition),
    hasFallback: hasFallback(definition),
    hasTermination: hasTermination(nodes),
  };

  const risk = classifyRisk({ flow, metrics, issues });

  return {
    id: flow.id,
    name: flow.name,
    status: flow.status,
    isActive: Boolean(flow.isActive),
    routeKey: flow.routeKey,
    priority: flow.priority,
    currentVersionId: flow.currentVersionId,
    version: flow.version?.version || null,
    triggerConfig,
    nodeCount: metrics.nodeCount,
    triggers: {
      rule: triggerConfig.rule || 'contains',
      value: triggerConfig.triggerValue || '',
    },
    responses: metrics.responseCount,
    conditions: metrics.conditionCount,
    delays: metrics.delays,
    usesMedia: metrics.usesMedia,
    usesTemplateHsm: metrics.usesTemplateHsm,
    handoffHuman: metrics.hasHandoff,
    fallback: metrics.hasFallback,
    termination: metrics.hasTermination,
    risks: risk,
    origin: definition.source || 'postgres',
    legacy: definition.legacy || null,
    checksum: flow.version?.checksum || '',
    issues,
  };
};

export const buildChatbotFlowsAuditReport = ({ flows = [], generatedAt = new Date().toISOString() } = {}) => {
  const items = flows.map(auditChatbotFlow);
  return {
    generatedAt,
    source: 'postgres',
    total: items.length,
    summary: {
      draft: items.filter((item) => item.status === 'draft').length,
      publishedActive: items.filter((item) => item.status === 'published' && item.isActive).length,
      lowRisk: items.filter((item) => item.risks === 'baixo risco').length,
      mediumRisk: items.filter((item) => item.risks === 'medio risco').length,
      highRisk: items.filter((item) => item.risks === 'alto risco').length,
      blocked: items.filter((item) => item.risks === 'bloqueado').length,
    },
    items,
  };
};
