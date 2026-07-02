import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { buildChatSseUrl } from '../api/chat-api';
import { dispatchLocalRealtimeEvent } from '@/lib/realtime-events';
import {
  CHAT_MAX_CACHED_MESSAGES_PER_CONVERSATION,
  ENABLE_SSE_REALTIME,
} from '@/lib/performance-config';
import {
  appendMessageCache,
  markConversationReadCaches,
  updateConversationCaches,
  updateMessageStatusCache,
} from '../cache-updaters';
import { useChatStore } from '../store/useChatStore';
import { markChatConversationRead } from '@/lib/whatsapp-api';

const EVENT_NAMES = [
  'new_message',
  'conversation_updated',
  'message_status_updated',
  'queue_updated',
  'agent_assigned',
  'presence_updated',
  'media_updated',
  'conversation_read',
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

const getPresenceUserId = (presence = {}) => String(presence?.user_id || presence?.userId || presence?.id || '').trim();
const pendingReadMarks = new Map();

const scheduleSelectedConversationRead = (conversationId, messageId) => {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) return;
  const safeMessageId = String(messageId || '').trim();
  const key = `${safeConversationId}:${safeMessageId || 'latest'}`;
  if (pendingReadMarks.has(key)) {
    window.clearTimeout(pendingReadMarks.get(key));
  }
  const timeoutId = window.setTimeout(() => {
    pendingReadMarks.delete(key);
    void markChatConversationRead(safeConversationId, { lastReadMessageId: safeMessageId || null }).catch(() => {});
  }, 1200);
  pendingReadMarks.set(key, timeoutId);
};

const updatePresenceCaches = (queryClient, payload = {}) => {
  const presence = payload.presence && typeof payload.presence === 'object' ? payload.presence : payload;
  const userId = getPresenceUserId(presence) || String(payload.userId || payload.user_id || '').trim();
  if (!userId) return;

  queryClient.setQueriesData({ queryKey: ['presence', 'status'] }, (current = {}) => {
    const currentPresence = current?.presence && typeof current.presence === 'object' ? current.presence : {};
    const currentUserId = getPresenceUserId(currentPresence);
    if (currentUserId && currentUserId !== userId) return current;
    return {
      ...(current && typeof current === 'object' ? current : {}),
      ok: true,
      presence: { ...currentPresence, ...presence, user_id: userId, id: presence.id || userId },
    };
  });

  queryClient.setQueryData(['presence', 'attending-users'], (current = []) => {
    const items = Array.isArray(current) ? current : [];
    const nextItems = items.filter((item) => getPresenceUserId(item) !== userId);
    const status = String(presence.status || '').trim().toLowerCase();
    if (status === 'offline') return nextItems;
    return [{ ...presence, user_id: userId, id: presence.id || userId }, ...nextItems];
  });
};

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

    const eventSource = new window.EventSource(buildChatSseUrl(), { withCredentials: true });
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
            const isSelectedConversation = String(conversationId) === String(selectedConversationIdRef.current);
            const senderType = String(message.sender_type || message.senderType || message.direction || '').trim().toLowerCase();
            const isInboundMessage = senderType === 'client' || senderType === 'customer' || senderType === 'inbound';
            if (isSelectedConversation && isInboundMessage) {
              scheduleSelectedConversationRead(conversationId, message.id || message.message_id || null);
            }
            const activityPatch = payload.summary || {
              last_message: message.body || message.content || '',
              last_message_type: message.type || message.message_type || 'text',
              last_message_at: message.created_at || message.created_date || message.timestamp,
            };
            updateConversationCaches(queryClient, conversationId, (currentConversation = {}) => {
              const currentUnread = Number(currentConversation.unread_count || currentConversation.unreadCount || 0);
              const unreadCount = isSelectedConversation || !isInboundMessage ? 0 : currentUnread + 1;
              return {
                ...activityPatch,
                unread_count: unreadCount,
                unreadCount,
                isUnread: unreadCount > 0,
              };
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

        if (eventName === 'presence_updated') {
          updatePresenceCaches(queryClient, payload);
          dispatchLocalRealtimeEvent('presence:updated', payload);
          return;
        }

        if (eventName === 'conversation_read') {
          if (conversationId) {
            markConversationReadCaches(queryClient, conversationId, payload.unreadCount ?? payload.unread_count ?? 0);
          }
          dispatchLocalRealtimeEvent('conversation:read', { ...payload, conversationId });
          return;
        }

        if (conversationId && (eventName === 'conversation_updated' || eventName === 'agent_assigned' || eventName === 'queue_updated')) {
          const patch = payload.summary || payload.conversation || payload;
          updateConversationCaches(queryClient, conversationId, (currentConversation = {}) => {
            const currentUnread = Number(currentConversation.unread_count || currentConversation.unreadCount || 0);
            const unreadCount = String(conversationId) === String(selectedConversationIdRef.current) ? 0 : currentUnread;
            return {
              ...patch,
              unread_count: unreadCount,
              unreadCount,
              isUnread: unreadCount > 0,
            };
          });
          if (eventName === 'agent_assigned' || eventName === 'queue_updated') {
            dispatchLocalRealtimeEvent('conversation:assignment-updated', { ...payload, conversationId });
          }
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
  }, [queryClient]);
}
