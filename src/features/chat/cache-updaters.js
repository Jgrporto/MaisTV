const getConversationId = (value) => String(value?.id || value?.conversation_id || value?.conversationId || '').trim();
const getMessageId = (value) => String(
  value?.id || value?.message_id || value?.messageId || value?.provider_message_id || value?.client_message_id || '',
).trim();

const patchConversationList = (items, conversationId, patch, { prepend = false } = {}) => {
  if (!Array.isArray(items)) return items;
  const index = items.findIndex((item) => getConversationId(item) === conversationId);
  if (index < 0) return prepend && patch ? [{ id: conversationId, ...patch }, ...items] : items;
  const nextItem = { ...items[index], ...patch };
  return prepend
    ? [nextItem, ...items.slice(0, index), ...items.slice(index + 1)]
    : items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
};

const patchConversationData = (data, conversationId, patch, options) => {
  if (Array.isArray(data)) return patchConversationList(data, conversationId, patch, options);
  if (!data || !Array.isArray(data.pages)) return data;
  let inserted = false;
  const pages = data.pages.map((page, pageIndex) => {
    const pageItems = Array.isArray(page) ? page : page?.items;
    if (!Array.isArray(pageItems)) return page;
    const contains = pageItems.some((item) => getConversationId(item) === conversationId);
    const nextItems = patchConversationList(pageItems, conversationId, patch, {
      prepend: !inserted && pageIndex === 0 && options?.prepend,
    });
    inserted ||= contains || (pageIndex === 0 && options?.prepend && Boolean(patch));
    return Array.isArray(page) ? nextItems : { ...page, items: nextItems };
  });
  return { ...data, pages };
};

export function updateConversationCaches(queryClient, conversationId, patch, options = {}) {
  const safeId = String(conversationId || '').trim();
  if (!safeId) return;
  queryClient.setQueriesData({ queryKey: ['conversations'] }, (data) =>
    patchConversationData(data, safeId, patch, options));
  queryClient.setQueriesData({ queryKey: ['chat', 'conversations'] }, (data) =>
    patchConversationData(data, safeId, patch, options));
}

const appendMessageToPages = (data, message, maxMessages) => {
  if (!data || !Array.isArray(data.pages)) return data;
  const messageId = getMessageId(message);
  if (!messageId) return data;
  const exists = data.pages.some((page) =>
    (Array.isArray(page?.items) ? page.items : []).some((item) => getMessageId(item) === messageId));
  if (exists) return data;
  const pages = data.pages.map((page, index) => index === 0
    ? { ...page, items: [...(Array.isArray(page?.items) ? page.items : []), message] }
    : page);
  let remaining = maxMessages;
  const boundedPages = pages.map((page) => {
    if (remaining <= 0) return { ...page, items: [] };
    const items = page.items.slice(Math.max(0, page.items.length - remaining));
    remaining -= items.length;
    return { ...page, items };
  });
  return { ...data, pages: boundedPages };
};

export function appendMessageCache(queryClient, conversationId, message, maxMessages = 200) {
  queryClient.setQueryData(['chat', 'messages', String(conversationId || '')], (data) =>
    appendMessageToPages(data, message, maxMessages));
}

export function updateMessageStatusCache(queryClient, conversationId, messageId, status) {
  const targetId = String(messageId || '').trim();
  if (!targetId) return;
  queryClient.setQueryData(['chat', 'messages', String(conversationId || '')], (data) => {
    if (!data || !Array.isArray(data.pages)) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: (Array.isArray(page?.items) ? page.items : []).map((message) =>
          getMessageId(message) === targetId ? { ...message, status } : message),
      })),
    };
  });
}
