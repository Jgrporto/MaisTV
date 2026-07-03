const getConversationId = (value) => String(value?.id || value?.conversation_id || value?.conversationId || '').trim();
const getMessageId = (value) => String(
  value?.id || value?.message_id || value?.messageId || value?.provider_message_id || value?.client_message_id || '',
).trim();

const patchConversationList = (items, conversationId, patch, { prepend = false } = {}) => {
  if (!Array.isArray(items)) return items;
  const index = items.findIndex((item) => getConversationId(item) === conversationId);
  if (index < 0) {
    if (!prepend || !patch) return items;
    const nextPatch = typeof patch === 'function' ? patch({ id: conversationId }) : patch;
    return [{ id: conversationId, ...nextPatch }, ...items];
  }
  const nextPatch = typeof patch === 'function' ? patch(items[index]) : patch;
  const nextItem = { ...items[index], ...nextPatch };
  return prepend
    ? [nextItem, ...items.slice(0, index), ...items.slice(index + 1)]
    : items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
};

const patchConversationData = (data, conversationId, patch, options) => {
  if (Array.isArray(data)) return patchConversationList(data, conversationId, patch, options);
  if (!data || !Array.isArray(data.pages)) return data;
  if (options?.prepend) {
    let existing = null;
    for (const page of data.pages) {
      const pageItems = Array.isArray(page) ? page : page?.items;
      existing ||= pageItems?.find((item) => getConversationId(item) === conversationId) || null;
    }
    const nextPatch = typeof patch === 'function' ? patch(existing || { id: conversationId }) : patch;
    const nextItem = { id: conversationId, ...(existing || {}), ...(nextPatch || {}) };
    const pages = data.pages.map((page, pageIndex) => {
      const pageItems = Array.isArray(page) ? page : page?.items;
      if (!Array.isArray(pageItems)) return page;
      const withoutDuplicate = pageItems.filter((item) => getConversationId(item) !== conversationId);
      const nextItems = pageIndex === 0 ? [nextItem, ...withoutDuplicate] : withoutDuplicate;
      return Array.isArray(page) ? nextItems : { ...page, items: nextItems };
    });
    return { ...data, pages };
  }
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

export function markConversationReadCaches(queryClient, conversationId, unreadCount = 0) {
  const nextUnreadCount = Math.max(0, Number(unreadCount || 0));
  updateConversationCaches(queryClient, conversationId, {
    unread_count: nextUnreadCount,
    unreadCount: nextUnreadCount,
    isUnread: nextUnreadCount > 0,
  });
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

export function updateMessageMediaCache(queryClient, conversationId, payload = {}) {
  const targetMessageId = String(payload.messageId || payload.message_id || '').trim();
  const targetMediaId = String(payload.mediaId || payload.media_id || '').trim();
  if (!targetMessageId && !targetMediaId) return;
  queryClient.setQueryData(['chat', 'messages', String(conversationId || '')], (data) => {
    if (!data || !Array.isArray(data.pages)) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: (Array.isArray(page?.items) ? page.items : []).map((message) => {
          const messageMatches = targetMessageId && getMessageId(message) === targetMessageId;
          const mediaMatches = targetMediaId && (Array.isArray(message?.attachments) ? message.attachments : [])
            .some((attachment) => String(attachment?.mediaId || attachment?.media_id || attachment?.id || '').trim() === targetMediaId);
          if (!messageMatches && !mediaMatches) return message;
          const attachments = (Array.isArray(message?.attachments) ? message.attachments : []).map((attachment) => {
            const attachmentId = String(attachment?.mediaId || attachment?.media_id || attachment?.id || '').trim();
            if (targetMediaId && attachmentId !== targetMediaId) return attachment;
            return {
              ...attachment,
              status: payload.status || attachment.status,
              mimeType: payload.mimeType || payload.mime_type || attachment.mimeType,
              size: payload.size ?? attachment.size,
              hasThumbnail: payload.hasThumbnail ?? payload.has_thumbnail ?? attachment.hasThumbnail,
              transcription: payload.transcription || attachment.transcription,
            };
          });
          return {
            ...message,
            attachments,
            transcription: payload.transcription || message.transcription,
          };
        }),
      })),
    };
  });
}
