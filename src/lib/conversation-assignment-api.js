import { parseJsonResponse, requestLocalApi } from '@/lib/local-api';

const normalizeStringArray = (value) =>
  Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];

export const assignConversationToUser = async (conversationId, userId, options = {}) => {
  const safeConversationId = String(conversationId || '').trim();
  const safeUserId = String(userId || '').trim();
  if (!safeConversationId || !safeUserId) {
    throw new Error('Conversa ou usuario invalido para redirecionamento.');
  }

  const response = await requestLocalApi(`/conversations/${encodeURIComponent(safeConversationId)}/assign`, {
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
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Nao foi possivel redirecionar a conversa.');
  }

  return data;
};

export const requeueConversationForService = async (conversationId, options = {}) => {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) {
    throw new Error('Conversa invalida para envio a fila.');
  }

  const response = await requestLocalApi(`/conversations/${encodeURIComponent(safeConversationId)}/requeue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sourceConversationIds: normalizeStringArray(options.sourceConversationIds),
      matchingServiceIds: normalizeStringArray(options.matchingServiceIds),
      targetServiceId: String(options.targetServiceId || '').trim(),
    }),
  });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Nao foi possivel enviar a conversa para a fila.');
  }

  return data;
};
