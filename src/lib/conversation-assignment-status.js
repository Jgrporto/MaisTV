const normalizeKey = (value) => String(value || '').trim().toLowerCase();

const normalizeStringArray = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );

export const ASSIGNMENT_SOURCE_LABELS = Object.freeze({
  agent_login_distribution: 'Distribuicao automatica',
  manual_assignment: 'Transferencia manual',
  manual_service_queue: 'Enviado para fila',
  service_queue: 'Fila do servico',
  agent_logout_queue: 'Redistribuicao por logout',
  broadcast_service_queue: 'Aguardando resposta',
  unclassified_queue: 'Sem fila definida',
  resolved: 'Atendimento encerrado',
});

const findServiceById = (services = [], serviceId = '') =>
  (Array.isArray(services) ? services : []).find((service) => String(service?.id || '').trim() === String(serviceId || '').trim()) || null;

const getQueuedServiceIds = (conversation = {}) =>
  normalizeStringArray([
    conversation.queued_service_id,
    ...(Array.isArray(conversation.queued_service_ids) ? conversation.queued_service_ids : []),
    conversation.queue_id,
    conversation.service_id,
  ]);

const getInferredServiceIds = (conversation = {}) =>
  normalizeStringArray([
    ...(Array.isArray(conversation.matching_service_ids) ? conversation.matching_service_ids : []),
    ...(Array.isArray(conversation.accessible_service_ids) ? conversation.accessible_service_ids : []),
  ]);

const resolveServiceName = (conversation = {}, services = []) => {
  const explicitName = String(conversation.queued_service_name || '').trim();
  if (explicitName) return explicitName;

  const explicitNames = normalizeStringArray(conversation.queued_service_names);
  if (explicitNames.length) return explicitNames.join(', ');

  // Queue metadata is authoritative. Label-derived matches are only a legacy
  // fallback and must not be presented as simultaneous queue membership.
  const queuedServiceIds = getQueuedServiceIds(conversation);
  const serviceIds = queuedServiceIds.length ? queuedServiceIds : getInferredServiceIds(conversation);
  const serviceNames = serviceIds
    .map((serviceId) => findServiceById(services, serviceId)?.name || '')
    .filter(Boolean);
  return serviceNames.join(', ');
};

const resolveAgentName = (conversation = {}, users = []) => {
  const explicitName = String(conversation.assigned_agent_name || '').trim();
  if (explicitName) return explicitName;

  const assignedId = normalizeKey(conversation.assigned_agent_id);
  const assignedEmail = normalizeKey(conversation.assigned_agent_email || conversation.assigned_agent);
  const matchedUser = (Array.isArray(users) ? users : []).find((user) => {
    const userId = normalizeKey(user?.id);
    const userEmail = normalizeKey(user?.email);
    const username = normalizeKey(user?.username);
    return (
      (assignedId && userId === assignedId) ||
      (assignedEmail && (userEmail === assignedEmail || username === assignedEmail))
    );
  });

  return (
    String(matchedUser?.full_name || matchedUser?.name || matchedUser?.username || matchedUser?.email || '').trim() ||
    String(conversation.assigned_agent_email || conversation.assigned_agent || '').trim()
  );
};

export const isConversationAssignedToCurrentUser = (conversation = {}, currentUser = null) => {
  const currentKeys = [
    currentUser?.id,
    currentUser?.email,
    currentUser?.username,
  ].map(normalizeKey).filter(Boolean);
  if (!currentKeys.length) return false;

  const assignedKeys = [
    conversation.assigned_agent,
    conversation.assigned_agent_id,
    conversation.assigned_agent_email,
  ].map(normalizeKey).filter(Boolean);

  return assignedKeys.some((assignedKey) => currentKeys.includes(assignedKey));
};

export const hasConversationAssignment = (conversation = {}) =>
  [
    conversation.assigned_agent,
    conversation.assigned_agent_id,
    conversation.assigned_agent_email,
    conversation.assigned_agent_name,
  ].some((value) => String(value || '').trim());

export const resolveConversationAssignmentStatus = ({
  conversation = {},
  currentUser = null,
  users = [],
  services = [],
} = {}) => {
  const safeConversation = conversation && typeof conversation === 'object' ? conversation : {};
  const queueStatus = normalizeKey(safeConversation.queue_status || safeConversation.assignment_status);
  const assignmentSource = normalizeKey(safeConversation.assignment_source);
  const sourceLabel = ASSIGNMENT_SOURCE_LABELS[assignmentSource] || '';
  const serviceName = resolveServiceName(safeConversation, services);
  const assigned = hasConversationAssignment(safeConversation);
  const assignedToCurrentUser = assigned && isConversationAssignedToCurrentUser(safeConversation, currentUser);
  const agentName = resolveAgentName(safeConversation, users);

  if (assigned) {
    return {
      status: assignedToCurrentUser ? 'assigned_to_me' : 'assigned_to_other',
      label: assignedToCurrentUser ? 'Atribuido a mim' : `Com ${agentName || 'atendente'}`,
      detail: sourceLabel || 'Atendimento atribuido',
      agentName,
      serviceName,
      source: assignmentSource,
      sourceLabel,
      queueStatus,
      badgeClassName: assignedToCurrentUser
        ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700'
        : 'border-sky-500/25 bg-sky-500/10 text-sky-700',
    };
  }

  if (queueStatus === 'unclassified' || assignmentSource === 'unclassified_queue') {
    return {
      status: 'unclassified',
      label: 'Sem fila definida',
      detail: sourceLabel || 'Etiquetas nao definem servico',
      agentName: '',
      serviceName,
      source: assignmentSource,
      sourceLabel,
      queueStatus,
      badgeClassName: 'border-amber-500/25 bg-amber-500/10 text-amber-700',
    };
  }

  if (queueStatus === 'waiting' || queueStatus === 'queued' || assignmentSource.includes('queue')) {
    return {
      status: 'queued',
      label: serviceName ? `Na fila: ${serviceName}` : 'Na fila',
      detail: sourceLabel || 'Aguardando distribuicao',
      agentName: '',
      serviceName,
      source: assignmentSource,
      sourceLabel,
      queueStatus,
      badgeClassName: 'border-violet-500/25 bg-violet-500/10 text-violet-700',
    };
  }

  return {
    status: 'unassigned',
    label: serviceName ? `Sem responsavel: ${serviceName}` : 'Sem responsavel',
    detail: sourceLabel || 'Aguardando classificacao',
    agentName: '',
    serviceName,
    source: assignmentSource,
    sourceLabel,
    queueStatus,
    badgeClassName: 'border-muted bg-muted text-muted-foreground',
  };
};
