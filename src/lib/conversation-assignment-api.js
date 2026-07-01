import { requestChatJson } from '@/features/chat/api/chat-api';

const normalizeStringArray = (value) =>
  Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];

export const assignConversationToUser = async (conversationId, userId, options = {}) => {
  const safeConversationId = String(conversationId || '').trim();
  const safeUserId = String(userId || '').trim();
  if (!safeConversationId || !safeUserId) {
    throw new Error('Conversa ou usuario invalido para redirecionamento.');
  }

  return requestChatJson(`/api/conversations/${encodeURIComponent(safeConversationId)}/assign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userId: safeUserId,
      sourceConversationIds: normalizeStringArray(options.sourceConversationIds),
      matchingServiceIds: normalizeStringArray(options.matchingServiceIds),
    }),
  });
};

export const requeueConversationForService = async (conversationId, options = {}) => {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) {
    throw new Error('Conversa invalida para envio a fila.');
  }

  return requestChatJson(`/api/conversations/${encodeURIComponent(safeConversationId)}/unassign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sourceConversationIds: normalizeStringArray(options.sourceConversationIds),
      matchingServiceIds: normalizeStringArray(options.matchingServiceIds),
      queueId: String(options.targetServiceId || '').trim(),
    }),
  });
};

export const transferConversationToUser = async (conversationId, userId, options = {}) => {
  const safeConversationId = String(conversationId || '').trim();
  const safeUserId = String(userId || '').trim();
  if (!safeConversationId || !safeUserId) throw new Error('Conversa ou usuario invalido para transferencia.');
  return requestChatJson(`/api/conversations/${encodeURIComponent(safeConversationId)}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: safeUserId,
      queueId: String(options.targetServiceId || options.queueId || '').trim(),
      reason: String(options.reason || 'manual_transfer').trim(),
    }),
  });
};
