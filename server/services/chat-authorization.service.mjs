const normalize = (value) => String(value || '').trim();

export const isPrivilegedChatUser = (auth = {}) =>
  (Array.isArray(auth.roles) ? auth.roles : [])
    .some((role) => ['admin', 'administrador'].includes(normalize(role).toLowerCase()));

export const getChatAccessFilter = (auth = {}) => ({
  userId: normalize(auth.userId),
  queueIds: Array.from(new Set((Array.isArray(auth.queueIds) ? auth.queueIds : []).map(normalize).filter(Boolean))),
  privileged: isPrivilegedChatUser(auth),
});

export const canAccessConversation = (auth = {}, conversation = {}) => {
  if (isPrivilegedChatUser(auth)) return true;
  const userId = normalize(auth.userId);
  const assignedAgentId = normalize(conversation.assigned_agent_id || conversation.assignedAgentId);
  if (userId && assignedAgentId === userId) return true;
  const queueId = normalize(conversation.queue_id || conversation.queueId || conversation.service_id || conversation.serviceId);
  return Boolean(queueId && (Array.isArray(auth.queueIds) ? auth.queueIds : []).map(normalize).includes(queueId));
};
