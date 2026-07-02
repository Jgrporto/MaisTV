const normalize = (value) => String(value || '').trim();
const normalizeLower = (value) =>
  normalize(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
const uniqueNormalized = (values = []) => Array.from(new Set(
  (Array.isArray(values) ? values : [values]).map(normalize).filter(Boolean),
));

export const isPrivilegedChatUser = (auth = {}) =>
  (Array.isArray(auth.roles) ? auth.roles : [])
    .some((role) => ['admin', 'administrador', 'role-admin', 'administracao'].includes(normalizeLower(role))) ||
  normalizeLower(auth.raw?.role) === 'admin' ||
  normalizeLower(auth.raw?.role_name || auth.raw?.roleName) === 'administrador' ||
  normalizeLower(auth.raw?.role_id || auth.raw?.roleId) === 'role-admin' ||
  normalizeLower(auth.raw?.department_key || auth.raw?.departmentKey) === 'administracao';

export const getChatAccessFilter = (auth = {}) => {
  const queueIds = uniqueNormalized(auth.queueIds);
  const serviceIds = uniqueNormalized(auth.serviceIds);
  return {
    userId: normalize(auth.userId),
    queueIds,
    serviceIds,
    queueOrServiceIds: uniqueNormalized([...queueIds, ...serviceIds]),
    privileged: isPrivilegedChatUser(auth),
  };
};

export const canAccessConversation = (auth = {}, conversation = {}) => {
  if (isPrivilegedChatUser(auth)) return true;
  const userId = normalize(auth.userId);
  const assignedAgentId = normalize(conversation.assigned_agent_id || conversation.assignedAgentId);
  if (userId && assignedAgentId === userId) return true;
  const allowedIds = getChatAccessFilter(auth).queueOrServiceIds;
  const queueId = normalize(conversation.queue_id || conversation.queueId);
  const serviceId = normalize(conversation.service_id || conversation.serviceId);
  return Boolean((queueId && allowedIds.includes(queueId)) || (serviceId && allowedIds.includes(serviceId)));
};
