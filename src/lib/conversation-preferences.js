import { parseJsonResponse, requestLocalApi } from '@/lib/local-api';

export const normalizeConversationPreference = (preference = {}) => ({
  id: String(preference?.id || preference?.conversation_id || preference?.conversationId || '').trim(),
  conversation_id: String(preference?.conversation_id || preference?.conversationId || preference?.id || '').trim(),
  is_pinned: Boolean(preference?.is_pinned),
  pinned_at: String(preference?.pinned_at || ''),
  pinned_by_id: String(preference?.pinned_by_id || preference?.pinned_by_email || ''),
  pinned_by_name: String(preference?.pinned_by_name || ''),
  manual_unread: Boolean(preference?.manual_unread),
  manual_unread_at: String(preference?.manual_unread_at || ''),
  manual_unread_by_id: String(preference?.manual_unread_by_id || preference?.manual_unread_by_email || ''),
  manual_unread_by_name: String(preference?.manual_unread_by_name || ''),
  resolution_status: String(preference?.resolution_status || ''),
  resolution_type: String(preference?.resolution_type || ''),
  resolved_at: String(preference?.resolved_at || ''),
  resolved_until: String(preference?.resolved_until || ''),
  resolved_by_id: String(preference?.resolved_by_id || ''),
  resolved_by_name: String(preference?.resolved_by_name || ''),
  created_date: String(preference?.created_date || ''),
  updated_date: String(preference?.updated_date || ''),
});

const getConversationPreferenceKey = (preference = {}) =>
  String(preference?.conversation_id || preference?.id || '').trim();

const getConversationPreferenceTime = (preference = {}) => {
  const candidates = [
    preference?.updated_date,
    preference?.created_date,
    preference?.pinned_at,
    preference?.manual_unread_at,
    preference?.resolved_at,
  ];

  return Math.max(
    0,
    ...candidates.map((value) => {
      const time = Date.parse(String(value || ''));
      return Number.isFinite(time) ? time : 0;
    }),
  );
};

export const dedupeConversationPreferences = (preferences = []) => {
  const byConversationId = new Map();

  (Array.isArray(preferences) ? preferences : []).forEach((rawPreference) => {
    const preference = normalizeConversationPreference(rawPreference);
    const conversationId = getConversationPreferenceKey(preference);
    if (!conversationId) return;

    const current = byConversationId.get(conversationId);
    if (!current || getConversationPreferenceTime(preference) > getConversationPreferenceTime(current)) {
      byConversationId.set(conversationId, preference);
    }
  });

  return [...byConversationId.values()];
};

const requestConversationPreferenceJson = async (path = '', options = {}) => {
  const response = await requestLocalApi(`/entities/ConversationPreference${path}`, options);
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    const error = new Error(data?.error || 'Falha ao salvar as preferencias da conversa.');
    error.status = response.status;
    throw error;
  }

  return data;
};

export const fetchConversationPreferences = async () => {
  const data = await requestConversationPreferenceJson('?sort=-updated_date', { method: 'GET' });
  return dedupeConversationPreferences(data);
};

export const saveConversationPreference = async (conversationId, patch = {}) => {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) {
    throw new Error('Conversa invalida para salvar preferencia.');
  }

  const payload = {
    id: safeConversationId,
    conversation_id: safeConversationId,
    ...patch,
  };

  try {
    const updated = await requestConversationPreferenceJson(`/${safeConversationId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return normalizeConversationPreference(updated);
  } catch (error) {
    if (error?.status !== 404) {
      throw error;
    }
  }

  const created = await requestConversationPreferenceJson('', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return normalizeConversationPreference(created);
};
