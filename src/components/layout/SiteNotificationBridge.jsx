import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  startCustomerBrowserSync,
  useCustomerBrowserSync,
} from '@/lib/customer-browser-sync';
import { buildCustomerRows } from '@/lib/customer-base';
import { fetchChatbotRuntimeState, processChatbotConversation } from '@/lib/chatbot-flows-api';
import {
  buildConversationMessageKey,
  getMatchingActiveFlow,
  hasNewClientMessage,
} from '@/lib/chatbot-runtime';
import { fetchCustomerSyncState, fetchNewbrBrowserAuthConfig, fetchPersistedCustomers } from '@/lib/customer-sync-api';
import { enrichConversationsWithLabels, useLabelCatalog } from '@/lib/labels';
import { subscribeToLocalEvents } from '@/lib/local-events';
import {
  BACKGROUND_REFRESH_INTERVAL_MS,
  CHATBOT_RUNTIME_REFRESH_INTERVAL_MS,
  CONVERSATION_REFRESH_INTERVAL_MS,
  CONVERSATION_SUMMARY_LIMIT,
  CUSTOMER_CACHE_REFRESH_INTERVAL_MS,
  NOTIFICATION_SETTINGS_REFRESH_INTERVAL_MS,
} from '@/lib/performance-config';
import { scheduleQueryInvalidation } from '@/lib/query-invalidation';
import { fetchWhatsappConversations } from '@/lib/whatsapp-api';
import { useAuth } from '@/lib/AuthContext';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  fetchNotificationSettings,
  playNotificationSound,
  readNotificationSettings,
  subscribeToNotificationSettings,
  warmNotificationAudio,
} from '@/lib/notification-settings';

const CUSTOMER_SYNC_TOAST_ID = 'customer-sync-status';
const CHATBOT_MAX_CONCURRENT_PROCESSING = 2;
const CUSTOMER_SYNC_STATE_REFRESH_INTERVAL_MS = BACKGROUND_REFRESH_INTERVAL_MS;

const buildUnreadSnapshot = (conversations = []) =>
  new Map(
    conversations.map((conversation) => [
      String(conversation?.id || ''),
      Number.isFinite(Number(conversation?.unread_count)) ? Number(conversation.unread_count) : 0,
    ]),
  );

const normalizeUserKey = (value) => String(value || '').trim().toLowerCase();

const isConversationAssignedToUser = (conversation, user) => {
  const userKeys = [user?.id, user?.email, user?.username].map(normalizeUserKey).filter(Boolean);
  const assignedKeys = [
    conversation?.assigned_agent,
    conversation?.assigned_agent_id,
    conversation?.assigned_agent_email,
  ].map(normalizeUserKey).filter(Boolean);
  return assignedKeys.some((assignedKey) => userKeys.includes(assignedKey));
};

export default function SiteNotificationBridge() {
  const queryClient = useQueryClient();
  const { effectiveUser } = useAuth();
  const [notificationSettings, setNotificationSettings] = useState(DEFAULT_NOTIFICATION_SETTINGS);
  const previousUnreadSnapshotRef = useRef(null);
  const previousCustomerSyncStatusRef = useRef(null);
  const previousSuccessfulCustomerSyncRef = useRef('');
  const lastStartedAutoScheduleRef = useRef('');
  const isPlayingRef = useRef(false);
  const { customLabels, assignments, stageAssignments } = useLabelCatalog();
  const customerBrowserSync = useCustomerBrowserSync();
  const chatbotEvaluatedMessageKeysRef = useRef(new Set());
  const chatbotInFlightKeysRef = useRef(new Set());
  const chatbotInFlightConversationIdsRef = useRef(new Set());
  const chatbotQueueRef = useRef([]);
  const chatbotActiveCountRef = useRef(0);
  const chatbotInvalidationTimerRef = useRef(null);

  const { data: rawConversations = [] } = useQuery({
    queryKey: ['conversations', 'attendance', 'summary', CONVERSATION_SUMMARY_LIMIT],
    queryFn: () => fetchWhatsappConversations({ summary: true, limit: CONVERSATION_SUMMARY_LIMIT }),
    refetchInterval: notificationSettings.alertNewConversations ? CONVERSATION_REFRESH_INTERVAL_MS : false,
    staleTime: 10000,
    enabled: notificationSettings.alertNewConversations,
  });

  const { data: customersResponse } = useQuery({
    queryKey: ['persisted-customers'],
    queryFn: fetchPersistedCustomers,
    staleTime: CUSTOMER_CACHE_REFRESH_INTERVAL_MS,
    refetchInterval: notificationSettings.alertNewConversations ? CUSTOMER_CACHE_REFRESH_INTERVAL_MS : false,
    enabled: notificationSettings.alertNewConversations,
  });

  const { data: customerSyncState } = useQuery({
    queryKey: ['customer-sync-state'],
    queryFn: fetchCustomerSyncState,
    staleTime: 10000,
    refetchInterval: CUSTOMER_SYNC_STATE_REFRESH_INTERVAL_MS,
  });

  const { data: notificationSettingsData } = useQuery({
    queryKey: ['settings', 'notification-settings'],
    queryFn: fetchNotificationSettings,
    staleTime: 10000,
    refetchInterval: NOTIFICATION_SETTINGS_REFRESH_INTERVAL_MS,
  });

  const { data: chatbotRuntimeState } = useQuery({
    queryKey: ['chatbot-runtime-state'],
    queryFn: fetchChatbotRuntimeState,
    staleTime: 10000,
    refetchInterval: CHATBOT_RUNTIME_REFRESH_INTERVAL_MS,
  });

  useEffect(() => subscribeToNotificationSettings(setNotificationSettings), []);

  useEffect(
    () =>
      subscribeToLocalEvents((event) => {
        if (event.type === 'conversation:preference-updated') {
          scheduleQueryInvalidation(queryClient, { queryKey: ['conversation-preferences'] });
        }

        if (
          event.type === 'presence:distribution-paused' ||
          event.type === 'presence:distribution-resumed'
        ) {
          scheduleQueryInvalidation(queryClient, { queryKey: ['presence', 'status'] });
        }
      }),
    [queryClient],
  );

  useEffect(() => () => {
    if (chatbotInvalidationTimerRef.current) {
      window.clearTimeout(chatbotInvalidationTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!notificationSettingsData) {
      return;
    }

    setNotificationSettings(readNotificationSettings(notificationSettingsData));
  }, [notificationSettingsData]);

  const persistedCustomers = Array.isArray(customersResponse?.rows) ? customersResponse.rows : [];
  const customerRows = useMemo(
    () => buildCustomerRows(persistedCustomers, rawConversations),
    [persistedCustomers, rawConversations]
  );
  const conversations = useMemo(
    () => enrichConversationsWithLabels(rawConversations, customerRows, {
      customLabels,
      assignments,
      stageAssignments,
    }),
    [assignments, customLabels, customerRows, rawConversations, stageAssignments],
  );

  useEffect(() => {
    const runNext = () => {
      while (
        chatbotActiveCountRef.current < CHATBOT_MAX_CONCURRENT_PROCESSING &&
        chatbotQueueRef.current.length
      ) {
        const item = chatbotQueueRef.current.shift();
        if (!item) return;

        chatbotActiveCountRef.current += 1;
        void processChatbotConversation(item.conversation, {
          messageKey: item.messageKey,
          timeoutMs: 10000,
        })
          .then((result) => {
            if (!result?.mutated && !result?.session) {
              return;
            }

            if (chatbotInvalidationTimerRef.current) {
              window.clearTimeout(chatbotInvalidationTimerRef.current);
            }
            chatbotInvalidationTimerRef.current = window.setTimeout(() => {
              void queryClient.invalidateQueries({ queryKey: ['labels'] });
              void queryClient.invalidateQueries({ queryKey: ['conversation-preferences'] });
              void queryClient.invalidateQueries({ queryKey: ['conversations'] });
              void queryClient.invalidateQueries({ queryKey: ['chatbot-runtime-state'] });
            }, 500);
          })
          .catch((error) => {
            if (import.meta.env.DEV || import.meta.env.VITE_CHATBOT_DEBUG === 'true') {
              console.warn('[chatbot] background processing skipped:', error?.message || error);
            }
          })
          .finally(() => {
            chatbotActiveCountRef.current = Math.max(0, chatbotActiveCountRef.current - 1);
            chatbotInFlightKeysRef.current.delete(item.messageKey);
            chatbotInFlightConversationIdsRef.current.delete(item.conversationId);
            runNext();
          });
      }
    };

    const enqueueChatbotProcessing = (conversation, messageKey) => {
      const conversationId = String(conversation?.id || '').trim();
      if (!conversationId || !messageKey) {
        return false;
      }
      if (
        chatbotInFlightKeysRef.current.has(messageKey) ||
        chatbotInFlightConversationIdsRef.current.has(conversationId)
      ) {
        return false;
      }

      chatbotInFlightKeysRef.current.add(messageKey);
      chatbotInFlightConversationIdsRef.current.add(conversationId);
      chatbotQueueRef.current.push({ conversation, conversationId, messageKey });
      runNext();
      return true;
    };

    const activeFlows = Array.isArray(chatbotRuntimeState?.activeFlows)
      ? chatbotRuntimeState.activeFlows
      : [];
    const activeSessionConversationIds = new Set(
      (chatbotRuntimeState?.activeSessionConversationIds || []).map(String),
    );
    const waitingTimerConversationIds = new Set(
      (chatbotRuntimeState?.waitingTimerConversationIds || []).map(String),
    );
    const awaitingUraConversationIds = new Set(
      (chatbotRuntimeState?.awaitingUraConversationIds || []).map(String),
    );

    if (!conversations.length || (!activeFlows.length && !activeSessionConversationIds.size)) {
      return undefined;
    }

    conversations.forEach((conversation) => {
      const conversationId = String(conversation?.id || '').trim();
      if (!conversationId) return;

      const baseMessageKey = buildConversationMessageKey(conversation);
      const hasWaitingTimer = waitingTimerConversationIds.has(conversationId);

      if (hasWaitingTimer) {
        enqueueChatbotProcessing(
          conversation,
          `${baseMessageKey}|timer:${Math.floor(Date.now() / CHATBOT_RUNTIME_REFRESH_INTERVAL_MS)}`,
        );
        return;
      }

      if (!hasNewClientMessage(conversation)) {
        return;
      }

      if (chatbotEvaluatedMessageKeysRef.current.has(baseMessageKey)) {
        return;
      }

      const hasActiveSession = activeSessionConversationIds.has(conversationId);
      const isAwaitingUra = awaitingUraConversationIds.has(conversationId);
      const matchedFlow = !hasActiveSession
        ? getMatchingActiveFlow(activeFlows, conversation.last_message)
        : null;

      if (!hasActiveSession && !matchedFlow) {
        chatbotEvaluatedMessageKeysRef.current.add(baseMessageKey);
        return;
      }

      const enqueued = enqueueChatbotProcessing(
        conversation,
        isAwaitingUra ? `${baseMessageKey}|ura` : baseMessageKey,
      );
      if (enqueued) {
        chatbotEvaluatedMessageKeysRef.current.add(baseMessageKey);
      }
    });

    if (chatbotEvaluatedMessageKeysRef.current.size > 1000) {
      chatbotEvaluatedMessageKeysRef.current = new Set(
        Array.from(chatbotEvaluatedMessageKeysRef.current).slice(-500),
      );
    }

    return undefined;
  }, [chatbotRuntimeState, conversations, queryClient]);

  useEffect(() => {
    const unlockAudio = () => {
      void warmNotificationAudio().catch(() => {});
    };

    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio);

    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  useEffect(() => {
    const currentSnapshot = buildUnreadSnapshot(conversations);
    const previousSnapshot = previousUnreadSnapshotRef.current;
    previousUnreadSnapshotRef.current = currentSnapshot;

    if (!previousSnapshot || !notificationSettings.alertNewConversations || !notificationSettings.enableBrowserSound) {
      return;
    }

    const triggeredConversation = conversations.find((conversation) => {
      if (!isConversationAssignedToUser(conversation, effectiveUser)) {
        return false;
      }
      const conversationId = String(conversation?.id || '');
      const currentUnread = currentSnapshot.get(conversationId) || 0;
      const previousUnread = previousSnapshot.get(conversationId) || 0;
      return currentUnread > previousUnread && currentUnread > 0;
    });

    if (!triggeredConversation || isPlayingRef.current) {
      return;
    }

    isPlayingRef.current = true;
    void playNotificationSound(notificationSettings, {
      labelIds: triggeredConversation.label_ids || [],
    })
      .catch(() => {})
      .finally(() => {
        window.setTimeout(() => {
          isPlayingRef.current = false;
        }, 800);
      });
  }, [conversations, effectiveUser, notificationSettings]);

  useEffect(() => {
    const currentStatus = customerBrowserSync.status || null;
    const previousStatus = previousCustomerSyncStatusRef.current;

    if (currentStatus === 'running' && previousStatus !== 'running') {
      toast.loading('Sincronizacao em andamento...', {
        id: CUSTOMER_SYNC_TOAST_ID,
      });
    }

    if (previousStatus === 'running' && currentStatus === 'success') {
      toast.success('Sincronizacao realizada com sucesso.', {
        id: CUSTOMER_SYNC_TOAST_ID,
        duration: 5000,
      });
      void queryClient.invalidateQueries({ queryKey: ['persisted-customers'] });
      void queryClient.invalidateQueries({ queryKey: ['customer-sync-logs'] });
    }

    if (previousStatus === 'running' && currentStatus === 'error') {
      toast.error(
        customerBrowserSync.error || 'A sincronizacao NewBr falhou.',
        {
          id: CUSTOMER_SYNC_TOAST_ID,
          duration: 5000,
        },
      );
      void queryClient.invalidateQueries({ queryKey: ['customer-sync-logs'] });
    }

    previousCustomerSyncStatusRef.current = currentStatus;
  }, [customerBrowserSync.error, customerBrowserSync.status, queryClient]);

  useEffect(() => {
    const nextSuccessfulSyncAt = String(customerSyncState?.lastSuccessfulSyncAt || '');
    const previousSuccessfulSyncAt = previousSuccessfulCustomerSyncRef.current;
    if (nextSuccessfulSyncAt && previousSuccessfulSyncAt && nextSuccessfulSyncAt !== previousSuccessfulSyncAt) {
      void queryClient.invalidateQueries({ queryKey: ['persisted-customers'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
    previousSuccessfulCustomerSyncRef.current = nextSuccessfulSyncAt;
  }, [customerSyncState?.lastSuccessfulSyncAt, queryClient]);

  useEffect(() => {
    if (customerBrowserSync.status === 'running') {
      return undefined;
    }

    const nextScheduledAtRaw = String(customerSyncState?.nextScheduledAt || '');
    if (!nextScheduledAtRaw || lastStartedAutoScheduleRef.current === nextScheduledAtRaw) {
      return undefined;
    }

    const nextScheduledAt = Date.parse(nextScheduledAtRaw);
    if (!Number.isFinite(nextScheduledAt)) {
      return undefined;
    }

    const delayMs = Math.max(0, nextScheduledAt - Date.now());
    const timerId = window.setTimeout(() => {
      void (async () => {
        const config = await fetchNewbrBrowserAuthConfig();
        if (!config.configured || !config.baseUrl || !config.username || !config.password) {
          return;
        }

        lastStartedAutoScheduleRef.current = nextScheduledAtRaw;
        startCustomerBrowserSync({
          ...config,
          mode: 'browser_automatic',
        });
      })().catch(() => {});
    }, delayMs);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [customerBrowserSync.status, customerSyncState?.nextScheduledAt]);

  return null;
}
