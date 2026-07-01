import {
  createChatbotFlowWithVersion,
  findChatbotVersionByChecksum,
  listActiveChatbotFlows,
  listChatbotFlows,
  recordChatbotEvent,
} from '../repositories/chatbot-flow.repository.mjs';
import {
  buildChatbotDefinition,
  buildDryRunConversation,
  calculateDefinitionChecksum,
  extractTriggerConfig,
  findMatchingChatbotFlow,
  normalizeLegacyChatbotFlows,
  simulateChatbotFlow,
  validateChatbotDefinition,
} from './chatbot-engine.service.mjs';

const DEFAULT_TENANT_ID = 'maistv';

const normalizeTenantId = (value) => String(value || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;

const normalizeRouteKey = (value) => {
  const routeKey = String(value || '').trim().toLowerCase();
  return routeKey || null;
};

const normalizeRuntimeFlow = (flow = {}) => {
  const definition = flow.version?.definition || {};
  return {
    id: flow.id,
    tenantId: flow.tenantId,
    routeKey: flow.routeKey,
    name: flow.name,
    status: flow.status,
    isActive: flow.isActive,
    priority: flow.priority,
    triggerConfig: flow.triggerConfig || extractTriggerConfig(definition),
    versionId: flow.version?.id || '',
    version: flow.version?.version || 0,
    checksum: flow.version?.checksum || '',
    definition,
  };
};

export const loadPostgresChatbotFlowsForDryRun = async ({ tenantId = DEFAULT_TENANT_ID, routeKey = null } = {}) => {
  const flows = await listActiveChatbotFlows({
    tenantId: normalizeTenantId(tenantId),
    routeKey: normalizeRouteKey(routeKey),
  });
  return flows.map(normalizeRuntimeFlow);
};

export const listPostgresChatbotFlows = async ({ tenantId = DEFAULT_TENANT_ID, routeKey = null, includeArchived = false } = {}) => {
  const flows = await listChatbotFlows({
    tenantId: normalizeTenantId(tenantId),
    routeKey: normalizeRouteKey(routeKey),
    includeArchived,
  });
  return flows.map((flow) => ({
    ...flow,
    version: flow.version || null,
  }));
};

export const runPostgresChatbotDryRun = async ({
  tenantId = DEFAULT_TENANT_ID,
  routeKey = null,
  text = '',
  type = 'text',
  phone = '5524999999999',
  conversationId = '',
  log = false,
  messageId = null,
} = {}) => {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedRouteKey = normalizeRouteKey(routeKey);
  const flows = await loadPostgresChatbotFlowsForDryRun({
    tenantId: normalizedTenantId,
    routeKey: normalizedRouteKey,
  });
  const conversation = buildDryRunConversation({
    routeKey: normalizedRouteKey || 'default',
    text,
    type,
    phone,
    conversationId,
  });
  const matchedFlow = findMatchingChatbotFlow(flows, text);

  const base = {
    mode: 'dry-run',
    source: 'postgres',
    tenantId: normalizedTenantId,
    routeKey: normalizedRouteKey || 'default',
    conversationId: conversation.id,
    messageType: type,
    text,
    createsOutboundJob: false,
    callsMeta: false,
    mutatesMessages: false,
  };

  if (!matchedFlow) {
    const result = {
      ...base,
      matched: false,
      reason: flows.length ? 'no_trigger' : 'no_active_flows',
      flowId: '',
      version: null,
      versionId: '',
      nodeId: '',
      wouldSend: [],
      nextState: null,
      trace: [],
    };
    if (log) {
      await recordChatbotEvent({
        tenantId: normalizedTenantId,
        eventType: 'dry_run_no_match',
        mode: 'dry-run',
        messageId,
        payload: result,
      });
    }
    return result;
  }

  const plan = simulateChatbotFlow({ flow: matchedFlow, conversation });
  const result = {
    ...base,
    matched: true,
    reason: 'trigger_matched',
    trigger: matchedFlow.triggerConfig || {},
    flowId: matchedFlow.id,
    flowName: matchedFlow.name,
    version: matchedFlow.version,
    versionId: matchedFlow.versionId,
    checksum: matchedFlow.checksum,
    nodeId: plan.trace[0]?.nodeId || '',
    wouldSend: plan.outputs,
    nextState: plan.nextState,
    trace: plan.trace,
  };

  if (log) {
    await recordChatbotEvent({
      tenantId: normalizedTenantId,
      eventType: 'dry_run_decision',
      mode: 'dry-run',
      messageId,
      flowId: matchedFlow.id,
      flowVersionId: matchedFlow.versionId || null,
      payload: result,
    });
  }

  return result;
};

export const buildLegacyImportPlan = ({ legacyFlows = [], source = 'store.json' } = {}) => {
  const flows = normalizeLegacyChatbotFlows(legacyFlows);
  const items = flows.map((legacyFlow, index) => {
    const definition = buildChatbotDefinition({ legacyFlow, source });
    const validation = validateChatbotDefinition(definition);
    const triggerConfig = extractTriggerConfig(definition);
    const checksum = calculateDefinitionChecksum(definition);
    return {
      index,
      source,
      legacyId: legacyFlow.id,
      legacyCode: legacyFlow.code,
      name: legacyFlow.name,
      legacyActive: Boolean(legacyFlow.active),
      definition,
      validation,
      triggerConfig,
      checksum,
    };
  });
  return {
    source,
    foundFlows: flows.length,
    validFlows: items.filter((item) => item.validation.valid).length,
    invalidFlows: items.filter((item) => !item.validation.valid).length,
    items,
  };
};

export const importLegacyChatbotFlows = async ({
  tenantId = DEFAULT_TENANT_ID,
  routeKey = null,
  legacyFlows = [],
  source = 'store.json',
  confirm = false,
  publish = false,
  activate = false,
  createdBy = 'chatbot-import-legacy',
} = {}) => {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedRouteKey = normalizeRouteKey(routeKey);
  const plan = buildLegacyImportPlan({ legacyFlows, source });
  const report = {
    source,
    tenantId: normalizedTenantId,
    routeKey: normalizedRouteKey,
    foundFlows: plan.foundFlows,
    validFlows: plan.validFlows,
    invalidFlows: plan.invalidFlows,
    wouldInsertFlows: 0,
    wouldInsertVersions: 0,
    insertedFlows: 0,
    insertedVersions: 0,
    wouldSkipDuplicates: 0,
    skippedDuplicates: 0,
    errors: [],
    items: [],
    mode: confirm ? 'confirm' : 'dry-run',
  };

  for (const item of plan.items) {
    if (!item.validation.valid) {
      report.errors.push({
        legacyId: item.legacyId,
        name: item.name,
        errors: item.validation.errors,
      });
      report.items.push({
        legacyId: item.legacyId,
        name: item.name,
        status: 'invalid',
        errors: item.validation.errors,
      });
      continue;
    }

    const duplicate = await findChatbotVersionByChecksum({
      tenantId: normalizedTenantId,
      checksum: item.checksum,
    });

    if (duplicate) {
      report.wouldSkipDuplicates += 1;
      report.skippedDuplicates += confirm ? 1 : 0;
      report.items.push({
        legacyId: item.legacyId,
        name: item.name,
        status: 'duplicate',
        duplicateFlowId: duplicate.flowId,
        duplicateVersionId: duplicate.id,
        checksum: item.checksum,
      });
      continue;
    }

    report.wouldInsertFlows += 1;
    report.wouldInsertVersions += 1;

    if (!confirm) {
      report.items.push({
        legacyId: item.legacyId,
        name: item.name,
        status: 'would_insert',
        checksum: item.checksum,
        triggerConfig: item.triggerConfig,
      });
      continue;
    }

    const created = await createChatbotFlowWithVersion({
      tenantId: normalizedTenantId,
      routeKey: normalizedRouteKey,
      name: item.name,
      status: publish ? 'published' : 'draft',
      isActive: publish && activate,
      priority: 100 + item.index,
      triggerConfig: item.triggerConfig,
      definition: item.definition,
      checksum: item.checksum,
      notes: `Imported from ${source} legacyId=${item.legacyId}`,
      createdBy,
      publish,
    });
    report.insertedFlows += 1;
    report.insertedVersions += 1;
    report.items.push({
      legacyId: item.legacyId,
      name: item.name,
      status: 'inserted',
      flowId: created.id,
      versionId: created.version?.id || '',
      checksum: item.checksum,
      published: publish,
      active: publish && activate,
    });
  }

  return report;
};
