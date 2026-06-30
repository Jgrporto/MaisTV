const DAY_IN_MS = 24 * 60 * 60 * 1000;

const normalizeKey = (value) => String(value || '').trim().toLowerCase();
const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');

const getTimestampMs = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeSet = (value) =>
  new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean));

export const getConversationIdentifierCandidates = (conversation = {}) =>
  Array.from(
    new Set(
      [
        conversation.id,
        conversation.aggregate_conversation_id,
        conversation.customer?.id,
        ...(Array.isArray(conversation.source_conversation_ids) ? conversation.source_conversation_ids : []),
      ]
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );

export const hasConversationAssignment = (conversation = {}) =>
  [
    conversation.assigned_agent,
    conversation.assigned_agent_id,
    conversation.assigned_agent_email,
    conversation.assigned_agent_name,
  ].some((value) => String(value || '').trim());

export const isConversationWithinCustomerWindow = (conversation = {}, now = Date.now()) => {
  if (typeof conversation.is_within_customer_window === 'boolean') {
    return conversation.is_within_customer_window;
  }

  const lastClientMs = Math.max(
    getTimestampMs(conversation.last_client_message_time),
    getTimestampMs(conversation.lastClientMessageTime),
    getTimestampMs(conversation.last_received_at),
  );
  return lastClientMs > 0 && now - lastClientMs <= DAY_IN_MS;
};

const hasAnyRuntimeSession = (conversation = {}, runtime = {}) => {
  const candidates = getConversationIdentifierCandidates(conversation);
  const activeIds = normalizeSet(runtime.activeSessionConversationIds);
  const waitingTimerIds = normalizeSet(runtime.waitingTimerConversationIds);
  const awaitingUraIds = normalizeSet(runtime.awaitingUraConversationIds);

  return candidates.some(
    (id) => activeIds.has(id) || waitingTimerIds.has(id) || awaitingUraIds.has(id),
  );
};

const isBroadcastAwaitingCustomerReply = (conversation = {}) => {
  const assignmentSource = normalizeKey(conversation.assignment_source);
  const tags = Array.isArray(conversation.tags) ? conversation.tags.map(normalizeKey) : [];
  const isBroadcastSource =
    assignmentSource === 'broadcast_service_queue' ||
    Boolean(conversation.is_broadcast) ||
    tags.includes('disparo');
  if (!isBroadcastSource) return false;

  const lastClientMs = Math.max(
    getTimestampMs(conversation.last_client_message_time),
    getTimestampMs(conversation.lastClientMessageTime),
    getTimestampMs(conversation.last_received_at),
  );
  const lastSentMs = Math.max(
    getTimestampMs(conversation.last_sent_at),
    getTimestampMs(conversation.lastMessageTime),
    getTimestampMs(conversation.last_message_time),
    getTimestampMs(conversation.last_message_at),
  );

  if (lastClientMs <= 0 || lastSentMs <= 0) return true;
  return lastSentMs >= lastClientMs;
};

export const isConversationQueuedForAdmin = (conversation = {}) => {
  if (hasConversationAssignment(conversation)) return false;

  const queueStatus = normalizeKey(conversation.queue_status);
  const assignmentSource = normalizeKey(conversation.assignment_source);
  return (
    queueStatus === 'waiting' ||
    queueStatus === 'queued' ||
    queueStatus === 'unclassified' ||
    assignmentSource.includes('queue') ||
    !assignmentSource
  );
};

export const resolveConversationAttendanceBucket = (conversation = {}, options = {}) => {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const queueStatus = normalizeKey(conversation.queue_status);
  const assignmentSource = normalizeKey(conversation.assignment_source);
  const isManualResolved =
    Boolean(conversation.is_resolution_active || conversation.is_daily_resolved) ||
    queueStatus === 'resolved' ||
    assignmentSource === 'resolved' ||
    (String(conversation.resolution_status || '').trim() === 'resolved' &&
      !Boolean(conversation.reopened_by_customer));

  if (isManualResolved) {
    return {
      bucket: 'resolved',
      reason: 'manual',
      resolutionKind: 'manual',
    };
  }

  if (hasAnyRuntimeSession(conversation, options.chatbotRuntime || {})) {
    return {
      bucket: 'resolved',
      reason: 'bot',
      resolutionKind: 'automatic_bot',
    };
  }

  if (isBroadcastAwaitingCustomerReply(conversation)) {
    return {
      bucket: 'resolved',
      reason: 'broadcast_waiting_customer',
      resolutionKind: 'automatic_broadcast',
    };
  }

  if (!isConversationWithinCustomerWindow(conversation, now)) {
    return {
      bucket: 'resolved',
      reason: 'outside_24h',
      resolutionKind: 'automatic_outside_24h',
    };
  }

  if (isConversationQueuedForAdmin(conversation)) {
    return {
      bucket: 'queue',
      reason: 'waiting_assignment',
      resolutionKind: '',
    };
  }

  return {
    bucket: 'active',
    reason: 'active',
    resolutionKind: '',
  };
};

export const conversationMatchesQueueServiceFilter = (conversation = {}, serviceFilter = 'all') => {
  if (serviceFilter === 'all') return true;
  const serviceIds = [
    conversation.queued_service_id,
    ...(Array.isArray(conversation.queued_service_ids) ? conversation.queued_service_ids : []),
    ...(Array.isArray(conversation.matching_service_ids) ? conversation.matching_service_ids : []),
    ...(Array.isArray(conversation.accessible_service_ids) ? conversation.accessible_service_ids : []),
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return serviceIds.includes(String(serviceFilter || '').trim());
};

export const conversationPhoneKey = (conversation = {}) =>
  normalizeDigits(conversation.contact_phone || conversation.customer?.phone || conversation.phone || '');
