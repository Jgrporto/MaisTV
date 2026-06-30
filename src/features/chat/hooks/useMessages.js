import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchChatMessagesPage } from '@/lib/whatsapp-api';
import { MESSAGE_PAGE_LIMIT } from '@/lib/performance-config';
import { chatQueryKeys } from '../query-keys';

export function useMessages(conversation, options = {}) {
  const conversationId = String(conversation?.id || conversation || '').trim();
  return useInfiniteQuery({
    queryKey: chatQueryKeys.messages(conversationId),
    queryFn: ({ pageParam }) => fetchChatMessagesPage(conversationId, {
      limit: options.limit || MESSAGE_PAGE_LIMIT,
      before: pageParam,
      conversationIds: conversation?.source_conversation_ids,
      sourceAccounts: conversation?.source_accounts,
    }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage?.hasMore ? lastPage.prevCursor : undefined,
    enabled: options.enabled !== false && Boolean(conversationId),
    staleTime: 30_000,
  });
}

export const flattenMessagePages = (data) => {
  const pages = Array.isArray(data?.pages) ? [...data.pages].reverse() : [];
  return pages.flatMap((page) => Array.isArray(page?.items) ? page.items : []);
};
