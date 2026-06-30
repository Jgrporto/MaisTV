import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { fetchChatConversationsPage } from '@/lib/whatsapp-api';
import { CONVERSATION_REFRESH_INTERVAL_MS, CONVERSATION_SUMMARY_LIMIT } from '@/lib/performance-config';
import { chatQueryKeys } from '../query-keys';

export function useConversationSummaries(options = {}) {
  const limit = options.limit || CONVERSATION_SUMMARY_LIMIT;
  return useQuery({
    queryKey: ['conversations', 'attendance', 'summary', limit],
    queryFn: async () => (await fetchChatConversationsPage({ ...options, limit })).items,
    refetchInterval: CONVERSATION_REFRESH_INTERVAL_MS,
    staleTime: 30_000,
  });
}

export function useConversations(options = {}) {
  const limit = options.limit || CONVERSATION_SUMMARY_LIMIT;
  return useInfiniteQuery({
    queryKey: chatQueryKeys.conversationPages({ ...options, limit }),
    queryFn: ({ pageParam }) => fetchChatConversationsPage({ ...options, limit, cursor: pageParam }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage?.hasMore ? lastPage.nextCursor : undefined,
    staleTime: 30_000,
    refetchInterval: CONVERSATION_REFRESH_INTERVAL_MS,
  });
}
