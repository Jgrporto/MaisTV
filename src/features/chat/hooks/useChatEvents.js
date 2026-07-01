import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { buildChatSseUrl } from '../api/chat-api';
import { dispatchLocalRealtimeEvent } from '@/lib/realtime-events';
import {
  CHAT_MAX_CACHED_MESSAGES_PER_CONVERSATION,
  ENABLE_SSE_REALTIME,
} from '@/lib/performance-config';
import { appendMessageCache, updateConversationCaches, updateMessageStatusCache } from '../cache-updaters';
import { useChatStore } from '../store/useChatStore';

const EVENT_NAMES = [
  'new_message',
  'conversation_updated',
  'message_status_updated',
  'queue_updated',
  'agent_assigned',
  'media_updated',
];

const parseEventData = (event) => {
  try {
    return JSON.parse(event.data || '{}');
  } catch {
    return null;
  }
};

const getConversationId = (payload) => String(
  payload?.conversationId || payload?.conversation_id || payload?.message?.conversationId || payload?.message?.conversation_id || '',
).trim();

export function useChatEvents({ selectedConversationId = '' } = {}) {
  const queryClient = useQueryClient();
  const normalizedSelectedConversationId = String(selectedConversationId || '').trim();
  const selectedConversationIdRef = useRef(normalizedSelectedConversationId);
  selectedConversationIdRef.current = normalizedSelectedConversationId;

  useEffect(() => {
    if (!ENABLE_SSE_REALTIME || typeof window === 'undefined' || typeof window.EventSource !== 'function') {
      useChatStore.getState().setSseStatus('fallback');
      return undefined;
    }

    const eventSource = new window.EventSource(buildChatSseUrl({
      conversationIds: normalizedSelectedConversationId ? [normalizedSelectedConversationId] : [],
    }), { withCredentials: true });
    useChatStore.getState().setSseStatus('connecting');

    const handleOpen = () => useChatStore.getState().setSseStatus('connected');
    const handleError = () => useChatStore.getState().setSseStatus('reconnecting');
    const handlers = new Map();

    EVENT_NAMES.forEach((eventName) => {
      const handler = (event) => {
        const payload = parseEventData(event);
        if (!payload) return;
        const conversationId = getConversationId(payload);

        if (eventName === 'new_message') {
          const message = payload.message || payload;
          if (conversationId) {
            appendMessageCache(queryClient, conversationId, message, CHAT_MAX_CACHED_MESSAGES_PER_CONVERSATION);
            updateConversationCaches(queryClient, conversationId, payload.summary || {
              last_message: message.body || message.content || '',
              last_message_type: message.type || message.message_type || 'text',
              last_message_at: message.created_at || message.created_date || message.timestamp,
              unread_count: String(conversationId) === String(selectedConversationIdRef.current)
                ? 0
                : Number(payload.unreadCount ?? payload.unread_count ?? 1),
            }, { prepend: true });
          }
          dispatchLocalRealtimeEvent('conversation:message-upserted', { ...payload, conversationId, message });
          return;
        }

        if (eventName === 'message_status_updated') {
          const messageId = payload.messageId || payload.message_id || payload.id;
          if (conversationId) updateMessageStatusCache(queryClient, conversationId, messageId, payload.status);
          dispatchLocalRealtimeEvent('conversation:message-status-updated', payload);
          return;
        }

        if (eventName === 'media_updated') {
          if (conversationId) {
            void queryClient.invalidateQueries({ queryKey: ['chat', 'messages', conversationId] });
          }
          dispatchLocalRealtimeEvent('conversation:media-updated', { ...payload, conversationId });
          return;
        }

        if (conversationId && (eventName === 'conversation_updated' || eventName === 'agent_assigned')) {
          updateConversationCaches(queryClient, conversationId, payload.summary || payload.conversation || payload);
        }
      };
      handlers.set(eventName, handler);
      eventSource.addEventListener(eventName, handler);
    });

    eventSource.addEventListener('open', handleOpen);
    eventSource.addEventListener('error', handleError);

    return () => {
      handlers.forEach((handler, eventName) => eventSource.removeEventListener(eventName, handler));
      eventSource.removeEventListener('open', handleOpen);
      eventSource.removeEventListener('error', handleError);
      eventSource.close();
      useChatStore.getState().setSseStatus('closed');
    };
  }, [normalizedSelectedConversationId, queryClient]);
}
