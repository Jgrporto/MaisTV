import 'dotenv/config';
import { readSqlStoreValue, upsertSqlStoreValue } from '../server/sql-store.js';
import { resolveConversationLabels } from '../server/labels-store.js';
import { listSqlAttendancePresence } from '../server/modules/attendance/presence-store.js';

const ATTENDANCE_PRESENCE_TTL_MS = Number.parseInt(
  process.env.ATTENDANCE_PRESENCE_TTL_MS || `${3 * 60 * 1000}`,
  10,
);
const ASSIGNMENT_OFFLINE_REQUEUE_GRACE_MS = (() => {
  const parsed = Number.parseInt(
    process.env.ASSIGNMENT_OFFLINE_REQUEUE_GRACE_MS || `${5 * 60 * 1000}`,
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : ATTENDANCE_PRESENCE_TTL_MS;
})();

const nowIso = () => new Date().toISOString();
const normalizeStringArray = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );

const normalizeUserKey = (value) => String(value || '').trim().toLowerCase();
const args = new Set(process.argv.slice(2));
const includeAssignedOpen =
  args.has('--include-assigned-open') ||
  ['1', 'true', 'yes', 'sim'].includes(String(process.env.REQUEUE_INCLUDE_ASSIGNED_OPEN || '').trim().toLowerCase());
const requeueOfflineAssigned =
  args.has('--requeue-offline-assigned') ||
  ['1', 'true', 'yes', 'sim'].includes(String(process.env.REQUEUE_OFFLINE_ASSIGNED || '').trim().toLowerCase());
const dryRun =
  args.has('--dry-run') ||
  ['1', 'true', 'yes', 'sim'].includes(String(process.env.REQUEUE_DRY_RUN || '').trim().toLowerCase());

const LABEL_ID_ALIASES = Object.freeze({
  'label-lead': ['system-lead'],
  'system-lead': ['label-lead'],
  'label-sql': ['system-sql'],
  'system-sql': ['label-sql'],
  'label-customer': ['system-cliente'],
  'system-cliente': ['label-customer'],
  'label-churn': ['system-cancelados'],
  'system-cancelados': ['label-churn'],
});

const expandServiceLabelIds = (value) =>
  Array.from(
    new Set(
      normalizeStringArray(value).flatMap((labelId) => [labelId, ...(LABEL_ID_ALIASES[labelId] || [])]),
    ),
  );

const isAdminUser = (store = {}, user = {}) => {
  const roleText = [user.role, user.role_id, user.role_name, user.profile, user.type]
    .map((value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())
    .join(' ');
  const roleId = String(user.role_id || '').trim();
  const matchedRole = (Array.isArray(store.roles) ? store.roles : []).find((role) => {
    const normalizedName = normalizeUserKey(role?.name).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return String(role?.id || '').trim() === roleId || normalizedName === normalizeUserKey(user.role_name || user.role);
  });
  const matchedRoleText = [matchedRole?.name, matchedRole?.department_key]
    .map((value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())
    .join(' ');
  return (
    roleText.includes('admin') ||
    roleText.includes('administrador') ||
    matchedRoleText.includes('administrador') ||
    matchedRoleText.includes('administracao')
  );
};

const hasAssignment = (conversation = {}) =>
  [conversation.assigned_agent, conversation.assigned_agent_id, conversation.assigned_agent_email, conversation.assigned_agent_name]
    .some((value) => String(value || '').trim());

const getAssignmentActivityMs = (conversation = {}) => {
  const timestamps = [
    conversation.assigned_at,
    conversation.assignedAt,
    conversation.last_agent_message_at,
    conversation.lastAgentMessageAt,
    conversation.last_sent_at,
    conversation.lastSentAt,
  ]
    .map((value) => Date.parse(String(value || '')))
    .filter((value) => Number.isFinite(value) && value > 0);
  return timestamps.length ? Math.max(...timestamps) : 0;
};

const hasRecentAssignmentActivity = (conversation = {}, referenceMs = Date.now()) => {
  const lastActivityMs = getAssignmentActivityMs(conversation);
  return lastActivityMs > 0 && referenceMs - lastActivityMs < ASSIGNMENT_OFFLINE_REQUEUE_GRACE_MS;
};

const isResolutionActive = (preference = null, conversation = {}) => {
  if (!preference || String(preference.resolution_status || '').trim() !== 'resolved') return false;
  const resolvedAtMs = Date.parse(String(preference.resolved_at || ''));
  if (!Number.isFinite(resolvedAtMs) || resolvedAtMs <= 0) return false;
  const lastClientMs = Date.parse(
    String(conversation.lastClientMessageTime || conversation.last_client_message_time || conversation.last_received_at || ''),
  );
  return !(Number.isFinite(lastClientMs) && lastClientMs > resolvedAtMs);
};

const resolveConversationServiceIds = (store = {}, conversation = {}) => {
  const conversationLabelIds = expandServiceLabelIds(conversation.label_ids || conversation.labelIds);
  if (!conversationLabelIds.length) return [];

  return (Array.isArray(store.services) ? store.services : [])
    .filter((service) => {
      const serviceLabelIds = expandServiceLabelIds(service.label_ids || service.labelIds);
      return serviceLabelIds.some((labelId) => conversationLabelIds.includes(labelId));
    })
    .map((service) => String(service.id || '').trim())
    .filter(Boolean);
};

const getUserServiceIds = (store = {}, user = {}) => {
  const userId = String(user.id || '').trim();
  const userEmail = normalizeUserKey(user.email);
  return (Array.isArray(store.services) ? store.services : [])
    .filter((service) => {
      const ids = normalizeStringArray(service.user_ids || service.userIds);
      const emails = normalizeStringArray(service.user_emails || service.userEmails).map(normalizeUserKey);
      return (userId && ids.includes(userId)) || (userEmail && emails.includes(userEmail));
    })
    .map((service) => String(service.id || '').trim())
    .filter(Boolean);
};

const normalizePresenceItems = (value = []) =>
  (Array.isArray(value) ? value : [])
    .map((item) => ({
      user_id: String(item?.user_id || item?.userId || '').trim(),
      user_name: String(item?.user_name || item?.userName || '').trim(),
      role: String(item?.role || '').trim(),
      status: String(item?.status || 'attending').trim(),
      paused_until: String(item?.paused_until || item?.pausedUntil || '').trim(),
      last_seen_at: String(item?.last_seen_at || item?.lastSeenAt || '').trim(),
      updated_at: String(item?.updated_at || item?.updatedAt || item?.last_seen_at || item?.lastSeenAt || '').trim(),
    }))
    .filter((item) => item.user_id && item.last_seen_at);

const mergePresenceItems = (items = []) => {
  const byUserId = new Map();
  normalizePresenceItems(items).forEach((presence) => {
    const previous = byUserId.get(presence.user_id);
    const previousMs = Date.parse(previous?.updated_at || previous?.last_seen_at || '');
    const currentMs = Date.parse(presence.updated_at || presence.last_seen_at || '');
    if (!previous || (Number.isFinite(currentMs) && (!Number.isFinite(previousMs) || currentMs >= previousMs))) {
      byUserId.set(presence.user_id, presence);
    }
  });
  return [...byUserId.values()];
};

const getPersistedPresenceItems = (store = {}) =>
  mergePresenceItems([...listSqlAttendancePresence(), ...(Array.isArray(store.attendancePresence) ? store.attendancePresence : [])]);

const getActiveUsers = (store = {}) => {
  const usersById = new Map((Array.isArray(store.users) ? store.users : []).map((user) => [String(user.id || '').trim(), user]));
  const cutoff = Date.now() - ATTENDANCE_PRESENCE_TTL_MS;

  return getPersistedPresenceItems(store)
    .filter((presence) => {
      const lastSeenAtMs = Date.parse(String(presence.last_seen_at || ''));
      return presence.status === 'attending' && Number.isFinite(lastSeenAtMs) && lastSeenAtMs >= cutoff;
    })
    .map((presence) => usersById.get(String(presence.user_id || '').trim()))
    .filter((user) => user && !isAdminUser(store, user))
    .map((user) => ({
      id: String(user.id || '').trim(),
      email: String(user.email || '').trim().toLowerCase(),
      name: String(user.full_name || user.username || user.email || '').trim() || 'Operador',
      serviceIds: getUserServiceIds(store, user),
    }));
};

const isConversationAssignedToUser = (conversation = {}, user = {}) => {
  const assignedKeys = [conversation.assigned_agent, conversation.assigned_agent_id, conversation.assigned_agent_email]
    .map(normalizeUserKey)
    .filter(Boolean);
  const userKeys = [user.id, user.email].map(normalizeUserKey).filter(Boolean);
  return assignedKeys.some((key) => userKeys.includes(key));
};

const getAssignedUser = (store = {}, conversation = {}) => {
  const assignedKeys = [
    conversation.assigned_agent,
    conversation.assigned_agent_id,
    conversation.assigned_agent_email,
  ].map(normalizeUserKey).filter(Boolean);
  if (!assignedKeys.length) return null;
  return (Array.isArray(store.users) ? store.users : []).find((user) =>
    [user.id, user.email, user.username].map(normalizeUserKey).some((key) => assignedKeys.includes(key)),
  ) || null;
};

const getConversationAssignmentExclusionKeys = (conversation = {}) =>
  Array.from(
    new Set(
      [
        ...normalizeStringArray(conversation.assignment_excluded_user_ids || conversation.assignmentExcludedUserIds),
        ...normalizeStringArray(conversation.assignment_excluded_user_emails || conversation.assignmentExcludedUserEmails),
        ...normalizeStringArray(conversation.assignment_excluded_usernames || conversation.assignmentExcludedUsernames),
      ]
        .map(normalizeUserKey)
        .filter(Boolean),
    ),
  );

const isUserExcludedFromConversationAssignment = (conversation = {}, user = {}) => {
  const excludedKeys = getConversationAssignmentExclusionKeys(conversation);
  if (!excludedKeys.length) return false;
  const userKeys = [user.id, user.email].map(normalizeUserKey).filter(Boolean);
  return userKeys.some((key) => excludedKeys.includes(key));
};

const clearAssignmentExclusionPatch = {
  assignment_excluded_user_ids: [],
  assignment_excluded_user_emails: [],
  assignment_excluded_usernames: [],
  assignment_exclusion_reason: '',
};

const countAssignments = (whatsappStore = {}, preferences = new Map(), activeUsers = [], ignoredConversationIds = new Set()) => {
  const counts = new Map(activeUsers.map((user) => [user.id, 0]));
  Object.entries(whatsappStore.conversations || {}).forEach(([conversationId, conversation]) => {
    const safeConversationId = String(conversation?.id || conversationId || '').trim();
    if (ignoredConversationIds.has(safeConversationId)) return;
    if (!hasAssignment(conversation)) return;
    if (isResolutionActive(preferences.get(String(conversation.id || '').trim()), conversation)) return;
    const user = activeUsers.find((candidate) => isConversationAssignedToUser(conversation, candidate));
    if (user) counts.set(user.id, (counts.get(user.id) || 0) + 1);
  });
  return counts;
};

const chooseUser = (candidates = [], counts = new Map()) => {
  if (!candidates.length) return null;
  const min = Math.min(...candidates.map((user) => counts.get(user.id) || 0));
  const balanced = candidates.filter((user) => (counts.get(user.id) || 0) === min);
  return balanced[Math.floor(Math.random() * balanced.length)] || null;
};

const isQueuedOrPendingConversation = (conversation = {}) => {
  const queueStatus = String(conversation.queue_status || '').trim();
  const assignmentSource = String(conversation.assignment_source || '').trim();
  return (
    !hasAssignment(conversation) ||
    ['waiting', 'unclassified'].includes(queueStatus) ||
    ['service_queue', 'agent_logout_queue', 'manual_service_queue', 'unclassified_queue'].includes(assignmentSource)
  );
};

const isBroadcastAwaitingCustomerReply = (conversation = {}) => {
  const tags = Array.isArray(conversation.tags) ? conversation.tags.map((tag) => normalizeUserKey(tag)) : [];
  if (!tags.includes('disparo') && !conversation.is_broadcast) return false;

  const lastClientMs = Date.parse(
    String(conversation.lastClientMessageTime || conversation.last_client_message_time || conversation.last_received_at || ''),
  );
  const lastSentMs = Date.parse(String(conversation.last_sent_at || conversation.lastMessageTime || conversation.last_message_at || ''));

  if (!Number.isFinite(lastClientMs) || lastClientMs <= 0) return true;
  if (!Number.isFinite(lastSentMs) || lastSentMs <= 0) return true;
  return lastSentMs >= lastClientMs;
};

const queueMetadata = (store = {}, serviceIds = [], queuedAt = nowIso()) => {
  const serviceNames = serviceIds
    .map((serviceId) => (store.services || []).find((service) => String(service.id || '') === serviceId)?.name || '')
    .filter(Boolean);
  return {
    queued_service_ids: serviceIds,
    queued_service_id: serviceIds[0] || '',
    queued_service_name: serviceNames[0] || '',
    queued_service_names: serviceNames,
    queue_status: serviceIds.length ? 'waiting' : 'unclassified',
    queued_at: queuedAt,
  };
};

const buildLabelConversation = (conversation = {}) => ({
  ...conversation,
  phone: conversation.phone || conversation.contact_phone || conversation.contactPhone || conversation.wa_id || conversation.waId || '',
  wa_id: conversation.wa_id || conversation.waId || conversation.contact_phone || conversation.contactPhone || conversation.phone || '',
  customer: {
    ...(conversation.customer && typeof conversation.customer === 'object' ? conversation.customer : {}),
    phone:
      conversation.customer?.phone ||
      conversation.customer?.number ||
      conversation.contact_phone ||
      conversation.contactPhone ||
      conversation.phone ||
      '',
  },
});

const main = (await readSqlStoreValue('main_store')).payload || {};
const whatsappStore = (await readSqlStoreValue('whatsapp_store')).payload || {};
const conversations = Object.values(whatsappStore.conversations || {});
const preferences = new Map(
  (Array.isArray(main.conversationPreferences) ? main.conversationPreferences : [])
    .map((preference) => [String(preference.conversation_id || preference.id || '').trim(), preference])
    .filter(([id]) => id),
);
const activeUsers = getActiveUsers(main);
const activeUserIds = new Set(activeUsers.map((user) => user.id));
const referenceMs = Date.now();
const inactiveAssignedConversations = conversations.filter((conversation) => {
  if (!hasAssignment(conversation)) return false;
  if (isResolutionActive(preferences.get(String(conversation.id || '').trim()), conversation)) return false;
  const assignedUser = getAssignedUser(main, conversation);
  return !assignedUser || !activeUserIds.has(String(assignedUser.id || '').trim());
});
const recentAssignedKept = inactiveAssignedConversations.filter((conversation) =>
  hasRecentAssignmentActivity(conversation, referenceMs),
).length;
const candidates = conversations.filter((conversation) => {
  return !isResolutionActive(preferences.get(String(conversation.id || '').trim()), conversation);
}).filter((conversation) => {
  if (requeueOfflineAssigned && hasAssignment(conversation)) {
    const assignedUser = getAssignedUser(main, conversation);
    const assignedUserIsActive = assignedUser && activeUserIds.has(String(assignedUser.id || '').trim());
    return !assignedUserIsActive && !hasRecentAssignmentActivity(conversation, referenceMs);
  }
  if (requeueOfflineAssigned) {
    return isQueuedOrPendingConversation(conversation);
  }
  return includeAssignedOpen || isQueuedOrPendingConversation(conversation);
});
const resolvedLabels = await resolveConversationLabels({ conversations: candidates.map(buildLabelConversation) });
const candidateIds = new Set(candidates.map((conversation) => String(conversation.id || '').trim()).filter(Boolean));
const counts = countAssignments(whatsappStore, preferences, activeUsers, candidateIds);
const assignedAt = nowIso();

let assigned = 0;
let waiting = 0;
let unclassified = 0;
let requeued = 0;
let broadcastWaiting = 0;
let offlineAssigned = 0;
const requeuedByAgent = new Map();

for (const conversation of candidates) {
  const conversationId = String(conversation.id || '').trim();
  const assignedUser = getAssignedUser(main, conversation);
  const assignedUserIsActive = assignedUser && activeUserIds.has(String(assignedUser.id || '').trim());
  if (requeueOfflineAssigned && hasAssignment(conversation) && !assignedUserIsActive) {
    offlineAssigned += 1;
  }
  const resolved = resolvedLabels.get(conversationId) || null;
  const labelIds = (Array.isArray(resolved?.labels) ? resolved.labels : [])
    .map((label) => String(label.id || '').trim())
    .filter(Boolean);
  const next = {
    ...conversation,
    label_ids: labelIds.length ? labelIds : normalizeStringArray(conversation.label_ids || conversation.labelIds),
  };
  const hadAssignment = hasAssignment(next);
  if (hadAssignment) {
    const previousAgentKey =
      String(next.assigned_agent_name || next.assigned_agent_email || next.assigned_agent_id || next.assigned_agent || 'Sem agente').trim();
    next.previous_assigned_agent = next.assigned_agent || '';
    next.previous_assigned_agent_id = next.assigned_agent_id || '';
    next.previous_assigned_agent_email = next.assigned_agent_email || '';
    next.previous_assigned_agent_name = next.assigned_agent_name || '';
    next.assignment_requeued_at = assignedAt;
    next.assignment_exclusion_reason = 'offline_requeue';
    next.assigned_agent = '';
    next.assigned_agent_id = '';
    next.assigned_agent_email = '';
    next.assigned_agent_name = '';
    next.assigned_at = '';
    requeued += 1;
    requeuedByAgent.set(previousAgentKey, (requeuedByAgent.get(previousAgentKey) || 0) + 1);
  }
  const serviceIds = resolveConversationServiceIds(main, next);
  Object.assign(next, queueMetadata(main, serviceIds, next.queued_at || assignedAt));

  if (!serviceIds.length) {
    next.assignment_source = 'unclassified_queue';
    whatsappStore.conversations[conversationId] = next;
    unclassified += 1;
    continue;
  }

  if (isBroadcastAwaitingCustomerReply(next)) {
    next.assignment_source = 'broadcast_service_queue';
    whatsappStore.conversations[conversationId] = next;
    waiting += 1;
    broadcastWaiting += 1;
    continue;
  }

  const serviceCandidates = activeUsers.filter((user) => {
    if (isUserExcludedFromConversationAssignment(next, user)) return false;
    return serviceIds.some((serviceId) => user.serviceIds.includes(serviceId));
  });
  const selectedUser = chooseUser(serviceCandidates, counts);
  if (!selectedUser) {
    next.assignment_source = hadAssignment ? 'agent_logout_queue' : 'service_queue';
    whatsappStore.conversations[conversationId] = next;
    waiting += 1;
    continue;
  }

  whatsappStore.conversations[conversationId] = {
    ...next,
    ...clearAssignmentExclusionPatch,
    assigned_agent: selectedUser.email || selectedUser.id,
    assigned_agent_id: selectedUser.id,
    assigned_agent_email: selectedUser.email || '',
    assigned_agent_name: selectedUser.name,
    assigned_at: assignedAt,
    assignment_source: 'service_queue_distribution',
    queue_status: 'assigned',
    queued_at: '',
  };
  counts.set(selectedUser.id, (counts.get(selectedUser.id) || 0) + 1);
  assigned += 1;
}

if (assigned || waiting || unclassified) {
  if (!dryRun) {
    await upsertSqlStoreValue('whatsapp_store', whatsappStore);
  }
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  includeAssignedOpen,
  requeueOfflineAssigned,
  activeUsers: activeUsers.map((user) => ({ id: user.id, email: user.email, name: user.name, serviceIds: user.serviceIds })),
  candidates: candidates.length,
  inactiveAssigned: inactiveAssignedConversations.length,
  recentAssignedKept,
  offlineAssigned,
  requeued,
  requeuedByAgent: Object.fromEntries(requeuedByAgent),
  assigned,
  waiting,
  unclassified,
  broadcastWaiting,
}, null, 2));
