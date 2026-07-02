import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { fetchChatConversationsPage } from '@/lib/whatsapp-api';
import { CONVERSATION_REFRESH_INTERVAL_MS, CONVERSATION_SUMMARY_LIMIT } from '@/lib/performance-config';
import { chatQueryKeys } from '../query-keys';
import { useChatStore } from '../store/useChatStore';

const FALLBACK_CONVERSATION_REFRESH_INTERVAL_MS = Math.max(300000, CONVERSATION_REFRESH_INTERVAL_MS);

export function useConversationSummaries(options = {}) {
  const limit = options.limit || CONVERSATION_SUMMARY_LIMIT;
  const enabled = options.enabled ?? true;
  const sseStatus = useChatStore((state) => state.sseStatus);
  const refetchInterval = enabled && sseStatus !== 'connected' ? FALLBACK_CONVERSATION_REFRESH_INTERVAL_MS : false;
  const requestOptions = { ...options };
  delete requestOptions.enabled;
  return useQuery({
    queryKey: ['conversations', 'attendance', 'summary', limit],
    queryFn: async () => (await fetchChatConversationsPage({ ...requestOptions, limit })).items,
    enabled,
    refetchInterval,
    refetchOnWindowFocus: sseStatus !== 'connected',
    staleTime: 300_000,
  });
}

export function useConversations(options = {}) {
  const limit = options.limit || CONVERSATION_SUMMARY_LIMIT;
  const enabled = options.enabled ?? true;
  const sseStatus = useChatStore((state) => state.sseStatus);
  const refetchInterval = enabled && sseStatus !== 'connected' ? FALLBACK_CONVERSATION_REFRESH_INTERVAL_MS : false;
  const requestOptions = { ...options };
  delete requestOptions.enabled;
  return useInfiniteQuery({
    queryKey: chatQueryKeys.conversationPages({ ...requestOptions, limit }),
    queryFn: ({ pageParam }) => fetchChatConversationsPage({ ...requestOptions, limit, cursor: pageParam }),
    initialPageParam: null,
    enabled,
    getNextPageParam: (lastPage) => lastPage?.hasMore ? lastPage.nextCursor : undefined,
    staleTime: 300_000,
    refetchInterval,
    refetchOnWindowFocus: sseStatus !== 'connected',
  });
}
