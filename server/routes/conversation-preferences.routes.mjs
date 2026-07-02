export const handleConversationPreferenceReadRoutes = async (req, res, url, deps = {}) => {
  if (req?.method !== 'GET' || url?.pathname !== '/api/local/conversation-preferences') return false;
  const { readStore, sendJson } = deps;
  if (typeof readStore !== 'function' || typeof sendJson !== 'function') {
    throw new Error('Conversation preference route dependencies are incomplete.');
  }

  const ids = String(url.searchParams.get('ids') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!ids.length) {
    sendJson(res, 400, { error: 'conversation_ids_required' });
    return true;
  }
  if (ids.length > 100) {
    sendJson(res, 400, { error: 'too_many_conversation_ids', max: 100 });
    return true;
  }

  const allowedIds = new Set(ids);
  const store = await readStore();
  const items = (Array.isArray(store.conversationPreferences) ? store.conversationPreferences : [])
    .filter((item) => allowedIds.has(String(item?.conversation_id || item?.conversationId || item?.id || '').trim()));
  sendJson(res, 200, items, { 'Cache-Control': 'private, max-age=5' });
  return true;
};
