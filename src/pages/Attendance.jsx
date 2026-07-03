import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import ConversationList from '@/components/chat/ConversationList';
import ChatWindow from '@/components/chat/ChatWindow';
import ContactInfoPanel from '@/components/chat/ContactInfoPanel';
import StartConversationDialog from '@/components/chat/StartConversationDialog';
import { useAuth } from '@/lib/AuthContext';
import {
  dedupeConversationPreferences,
  fetchConversationPreferences,
  normalizeConversationPreference,
  saveConversationPreference,
} from '@/lib/conversation-preferences';
import { fetchPersistedCustomerDetail } from '@/lib/customer-sync-api';
import { subscribeToLocalEvents } from '@/lib/local-events';
import { dispatchLocalRealtimeEvent } from '@/lib/realtime-events';
import { scheduleQueryInvalidation } from '@/lib/query-invalidation';
import {
  decorateConversationsWithServices,
  resolveAvailableServicesForUser,
} from '@/lib/services';
import { fetchServices } from '@/lib/services-api';
import {
  readCachedConversations,
  readCachedDraftEntries,
  subscribeToCachedDrafts,
  writeCachedConversations,
} from '@/lib/inbox-cache';
import { createPresenceLeadership } from '@/lib/presence-leadership';
import { enrichConversationsWithLabels, useLabelCatalog } from '@/lib/labels';
import {
  fetchActiveAttendanceUsers,
  fetchAttendancePresenceStatus,
  heartbeatAttendancePresence,
  pauseAttendanceDistribution,
  resumeAttendanceDistribution,
  startAttendancePresence,
} from '@/lib/presence-api';
import { fetchChatbotRuntimeState } from '@/lib/chatbot-flows-api';
import { resolveConversationAttendanceBucket } from '@/lib/attendance-buckets';
import {
  CHATBOT_RUNTIME_REFRESH_INTERVAL_MS,
  CONVERSATION_SUMMARY_LIMIT,
  ENABLE_NEW_CHAT_DATA_LAYER,
  PRESENCE_REFRESH_INTERVAL_MS,
  SERVICES_REFRESH_INTERVAL_MS,
} from '@/lib/performance-config';
import { fetchLocalUsers } from '@/lib/users-api';
import { isAdminLikeUser } from '@/lib/navigation-permissions';
import { useConversationSummaries, useConversations } from '@/features/chat/hooks/useConversations';
import { useChatStore } from '@/features/chat/store/useChatStore';

const getPreferenceTime = (value) => Date.parse(String(value || '')) || 0;
const getConversationTime = (conversation) =>
  Math.max(
    getPreferenceTime(conversation?.last_message_time),
    getPreferenceTime(conversation?.updated_date),
    getPreferenceTime(conversation?.draft_sort_at)
  );

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');
const normalizeUserKey = (value) => String(value || '').trim().toLowerCase();

const buildConversationRefreshKey = (conversation) => JSON.stringify([
  conversation?.id || '',
  conversation?.contact_name || '',
  conversation?.contact_phone || '',
  conversation?.avatar_url || '',
  conversation?.last_message || '',
  conversation?.last_message_type || '',
  conversation?.last_message_at || '',
  Number(conversation?.unread_count || 0),
  conversation?.status || '',
  conversation?.priority || '',
  conversation?.assigned_agent_id || '',
  conversation?.assigned_agent_name || '',
  conversation?.queue_id || '',
  conversation?.service_id || '',
  Boolean(conversation?.is_within_customer_window),
  conversation?.source_accounts || [],
  conversation?.active_route_selector || null,
  conversation?.default_route_selector || null,
]);

const getPauseRemainingMs = (pausedUntil) => {
  const pausedUntilMs = Date.parse(String(pausedUntil || ''));
  return Number.isFinite(pausedUntilMs) ? Math.max(0, pausedUntilMs - Date.now()) : 0;
};

const isAdminUser = isAdminLikeUser;

const isConversationAssignedToUser = (conversation, user) => {
  const userIds = [
    user?.id,
    user?.email,
    user?.username,
  ].map(normalizeUserKey).filter(Boolean);
  const assignedIds = [
    conversation?.assigned_agent,
    conversation?.assigned_agent_id,
    conversation?.assigned_agent_email,
  ].map(normalizeUserKey).filter(Boolean);
  return assignedIds.some((assignedId) => userIds.includes(assignedId));
};

export default function Attendance() {
  const { effectiveUser } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const selectedConversation = useChatStore((state) => state.selectedConversation);
  const setSelectedConversation = useChatStore((state) => state.setSelectedConversation);
  const searchTerm = useChatStore((state) => state.filters.searchTerm);
  const primaryFilter = useChatStore((state) => state.filters.primary);
  const serviceFilter = useChatStore((state) => state.filters.service);
  const labelFilter = useChatStore((state) => state.filters.label);
  const sidePanel = useChatStore((state) => state.sidePanel);
  const sseStatus = useChatStore((state) => state.sseStatus);
  const setFilter = useChatStore((state) => state.setFilter);
  const setSidePanel = useChatStore((state) => state.setSidePanel);
  const setSearchTerm = (value) => setFilter('searchTerm', value);
  const setPrimaryFilter = (value) => setFilter('primary', value);
  const setServiceFilter = (value) => setFilter('service', value);
  const setLabelFilter = (value) => setFilter('label', value);
  const showContactInfo = sidePanel === 'contact';
  const setShowContactInfo = (update) => setSidePanel((currentPanel) => {
    const currentValue = currentPanel === 'contact';
    const nextValue = typeof update === 'function' ? update(currentValue) : update;
    return nextValue ? 'contact' : null;
  });
  const [startConversationOpen, setStartConversationOpen] = useState(false);
  const [startConversationPhone, setStartConversationPhone] = useState('');
  const [cachedConversations, setCachedConversations] = useState([]);
  const [draftEntries, setDraftEntries] = useState([]);
  const [distributionPauseUntil, setDistributionPauseUntil] = useState('');
  const [distributionPauseReasonLabel, setDistributionPauseReasonLabel] = useState('');
  const [distributionPauseTick, setDistributionPauseTick] = useState(Date.now());
  const [backgroundQueryReady, setBackgroundQueryReady] = useState(false);
  const { customLabels, assignments, stageAssignments } = useLabelCatalog();
  const initialConversationTargetRef = React.useRef(null);

  const legacyConversationsQuery = useConversationSummaries({ limit: CONVERSATION_SUMMARY_LIMIT, enabled: !ENABLE_NEW_CHAT_DATA_LAYER });
  const paginatedConversationsQuery = useConversations({ limit: CONVERSATION_SUMMARY_LIMIT, enabled: ENABLE_NEW_CHAT_DATA_LAYER });
  const networkConversations = useMemo(() => {
    if (!ENABLE_NEW_CHAT_DATA_LAYER) return legacyConversationsQuery.data || [];
    const seen = new Set();
    return (paginatedConversationsQuery.data?.pages || []).flatMap((page) => page?.items || []).filter((conversation) => {
      const id = String(conversation?.id || '').trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [legacyConversationsQuery.data, paginatedConversationsQuery.data]);
  const activeConversationsQuery = ENABLE_NEW_CHAT_DATA_LAYER ? paginatedConversationsQuery : legacyConversationsQuery;
  const { isLoading, isFetched, isError, error } = activeConversationsQuery;

  useEffect(() => {
    if (!isFetched) {
      setBackgroundQueryReady(false);
      return undefined;
    }

    let active = true;
    const activateBackgroundQueries = () => {
      if (active) {
        setBackgroundQueryReady(true);
      }
    };
    const idleId = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(activateBackgroundQueries, { timeout: 1200 })
      : window.setTimeout(activateBackgroundQueries, 400);

    return () => {
      active = false;
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      } else {
        window.clearTimeout(idleId);
      }
    };
  }, [isFetched]);

  const selectedCustomerId = String(
    selectedConversation?.customer_summary?.id || selectedConversation?.customer?.id || '',
  ).trim();
  const { data: selectedCustomerDetail } = useQuery({
    queryKey: ['customer-detail', selectedCustomerId],
    queryFn: () => fetchPersistedCustomerDetail(selectedCustomerId),
    enabled: Boolean(selectedCustomerId) && Boolean(showContactInfo || sidePanel === 'quick-replies'),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!selectedCustomerDetail || !selectedCustomerId) return;
    setSelectedConversation((currentConversation) => {
      const currentCustomerId = String(
        currentConversation?.customer_summary?.id || currentConversation?.customer?.id || '',
      ).trim();
      if (currentCustomerId !== selectedCustomerId) return currentConversation;
      const currentPassword = String(currentConversation?.customer?.password || currentConversation?.customer?.senha || '');
      const nextPassword = String(selectedCustomerDetail.password || selectedCustomerDetail.senha || '');
      if (currentPassword === nextPassword && currentConversation?.customer?.detailLoaded) return currentConversation;
      return {
        ...currentConversation,
        customer: {
          ...(currentConversation?.customer || {}),
          id: selectedCustomerDetail.id || selectedCustomerId,
          name: selectedCustomerDetail.display_name || currentConversation?.customer?.name || '',
          username: selectedCustomerDetail.username || currentConversation?.customer?.username || '',
          password: nextPassword,
          senha: nextPassword,
          plan: selectedCustomerDetail.package || currentConversation?.customer?.plan || '',
          dueDate: selectedCustomerDetail.expires_at || currentConversation?.customer?.dueDate || '',
          detailLoaded: true,
        },
      };
    });
  }, [
    selectedConversation?.customer?.detailLoaded,
    selectedConversation?.customer?.password,
    selectedConversation?.customer?.senha,
    selectedCustomerDetail,
    selectedCustomerId,
    setSelectedConversation,
  ]);

  const visibleConversationIds = useMemo(
    () => Array.from(
      new Set(
        networkConversations
          .map((conversation) => String(conversation?.id || '').trim())
          .filter(Boolean),
      ),
    ).sort(),
    [networkConversations],
  );
  const { data: conversationPreferences = [] } = useQuery({
    queryKey: ['conversation-preferences', 'attendance', visibleConversationIds],
    queryFn: () => fetchConversationPreferences(visibleConversationIds),
    enabled: visibleConversationIds.length > 0,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const { data: services = [] } = useQuery({
    queryKey: ['services', 'attendance'],
    queryFn: fetchServices,
    staleTime: Math.max(300000, SERVICES_REFRESH_INTERVAL_MS),
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const { data: teamUsers = [] } = useQuery({
    queryKey: ['settings', 'users'],
    queryFn: fetchLocalUsers,
    staleTime: 30000,
    enabled: isAdminUser(effectiveUser),
  });

  const { data: activeAttendanceUsers = [] } = useQuery({
    queryKey: ['presence', 'attending-users'],
    queryFn: fetchActiveAttendanceUsers,
    enabled: backgroundQueryReady,
    staleTime: 15000,
    refetchInterval: backgroundQueryReady && sseStatus === 'connected' ? false : PRESENCE_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: backgroundQueryReady && sseStatus !== 'connected',
  });

  const { data: presenceStatus } = useQuery({
    queryKey: ['presence', 'status', effectiveUser?.id],
    queryFn: fetchAttendancePresenceStatus,
    staleTime: 15000,
    enabled: Boolean(effectiveUser?.id) && backgroundQueryReady,
    refetchOnWindowFocus: backgroundQueryReady && sseStatus !== 'connected',
  });

  const { data: chatbotRuntimeState } = useQuery({
    queryKey: ['chatbot-runtime-state'],
    queryFn: fetchChatbotRuntimeState,
    enabled: backgroundQueryReady && isAdminLikeUser(effectiveUser),
    staleTime: 30000,
    refetchInterval: backgroundQueryReady && isAdminLikeUser(effectiveUser)
      ? CHATBOT_RUNTIME_REFRESH_INTERVAL_MS
      : false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    let active = true;

    const hydrateCache = async () => {
      const [cached, drafts] = await Promise.all([readCachedConversations(), readCachedDraftEntries()]);

      if (active && cached.length > 0) {
        setCachedConversations(cached);
      }

      if (active) {
        setDraftEntries(drafts);
      }
    };

    void hydrateCache();
    const unsubscribe = subscribeToCachedDrafts(() => {
      void readCachedDraftEntries().then((drafts) => {
        if (active) {
          setDraftEntries(drafts);
        }
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (networkConversations.length === 0) return;
    setCachedConversations(networkConversations);
    void writeCachedConversations(networkConversations);
  }, [networkConversations]);

  useEffect(() => {
    const pausedUntil = String(presenceStatus?.distributionPause?.pausedUntil || presenceStatus?.presence?.paused_until || '').trim();
    if (pausedUntil && getPauseRemainingMs(pausedUntil) > 0) {
      setDistributionPauseUntil(pausedUntil);
      setDistributionPauseReasonLabel(
        String(presenceStatus?.distributionPause?.reasonLabel || presenceStatus?.presence?.pause_reason_label || '').trim(),
      );
      return;
    }
    setDistributionPauseUntil('');
    setDistributionPauseReasonLabel('');
  }, [presenceStatus]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setDistributionPauseTick(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  void distributionPauseTick;
  const distributionPauseRemainingMs = getPauseRemainingMs(distributionPauseUntil);
  const isDistributionPaused = distributionPauseRemainingMs > 0;

  const handlePauseQueueDistribution = async (reason) => {
    try {
      const result = await pauseAttendanceDistribution(reason);
      const pausedUntil = String(result?.distributionPause?.pausedUntil || result?.presence?.paused_until || '').trim();
      setDistributionPauseUntil(pausedUntil || new Date(Date.now() + 10 * 60 * 1000).toISOString());
      setDistributionPauseReasonLabel(String(result?.distributionPause?.reasonLabel || result?.presence?.pause_reason_label || '').trim());
      setDistributionPauseTick(Date.now());
      await queryClient.invalidateQueries({ queryKey: ['presence', 'attending-users'] });
      await queryClient.invalidateQueries({ queryKey: ['presence', 'status'] });
    } catch (error) {
      throw error;
    }
  };

  const handleResumeQueueDistribution = async () => {
    try {
      await resumeAttendanceDistribution();
      setDistributionPauseUntil('');
      setDistributionPauseReasonLabel('');
      setDistributionPauseTick(Date.now());
      await queryClient.invalidateQueries({ queryKey: ['presence', 'attending-users'] });
      await queryClient.invalidateQueries({ queryKey: ['presence', 'status'] });
    } catch (error) {
      throw error;
    }
  };

  useEffect(() => {
    if (!effectiveUser?.id) {
      return undefined;
    }

    let cancelled = false;
    const presenceLeadership = createPresenceLeadership(effectiveUser.id);
    const applyPresenceResult = (result) => {
      const presence = result?.presence;
      if (!presence) return;
      queryClient.setQueryData(['presence', 'status', effectiveUser.id], (current = {}) => ({
        ...(current && typeof current === 'object' ? current : {}),
        ok: true,
        presence,
        distributionPause: result?.distributionPause || current?.distributionPause || null,
      }));
      queryClient.setQueryData(['presence', 'attending-users'], (current = []) => {
        const items = Array.isArray(current) ? current : [];
        const presenceId = String(presence.user_id || presence.id || '').trim();
        if (!presenceId) return items;
        const nextItems = items.filter((item) => String(item?.user_id || item?.id || '').trim() !== presenceId);
        return presence.status === 'offline' ? nextItems : [presence, ...nextItems];
      });
    };

    const startPresenceIfLeader = () => {
      if (!presenceLeadership.claim()) return;
      void startAttendancePresence({ sessionId: presenceLeadership.sessionId })
        .then((result) => {
          if (cancelled) return;
          applyPresenceResult(result);
        })
        .catch(() => {
          // A tela continua carregando mesmo se a presenca falhar; as queries mostram o estado real.
        });
    };

    startPresenceIfLeader();

    const presenceHeartbeatId = window.setInterval(() => {
      if (!presenceLeadership.claim()) return;
      void heartbeatAttendancePresence()
        .then((result) => {
          if (!cancelled) applyPresenceResult(result);
        })
        .catch(() => {});
    }, 30_000);

    const unsubscribe = subscribeToLocalEvents((event) => {
      if (event.type === 'conversation:preference-updated') {
        try {
          const payload = event.payload || {};
          const preference = normalizeConversationPreference(payload?.preference || {});
          if (!preference.conversation_id) return;

          queryClient.setQueriesData({ queryKey: ['conversation-preferences'] }, (current = []) => {
            const items = Array.isArray(current) ? current : [];
            const itemsWithoutDuplicates = items.filter(
              (item) => String(item?.conversation_id || item?.conversationId || item?.id || '') !== preference.conversation_id,
            );
            return dedupeConversationPreferences([preference, ...itemsWithoutDuplicates]);
          });
        } catch {
          // Evento invalido nao deve derrubar a tela de atendimento.
        }
        return;
      }

      if (
        event.type === 'conversation:message-upserted' ||
        event.type === 'conversation:message-status-updated' ||
        event.type === 'conversation:message-reaction-updated'
      ) {
        dispatchLocalRealtimeEvent(event.type, event.payload || {});
        return;
      }

      if (event.type === 'presence:distribution-paused' || event.type === 'presence:distribution-resumed') {
        scheduleQueryInvalidation(queryClient, { queryKey: ['presence', 'status', effectiveUser.id] });
      }
    });

    return () => {
      cancelled = true;
      window.clearInterval(presenceHeartbeatId);
      presenceLeadership.release();
      unsubscribe();
    };
  }, [effectiveUser?.id, queryClient]);

  // Eventos de conversa/presenca atualizam cache via SSE; refetch amplo fica fora do caminho quente.

  const shouldUseCachedConversations =
    networkConversations.length === 0 &&
    cachedConversations.length > 0 &&
    (!isFetched || isError);
  const baseConversations =
    networkConversations.length > 0 ? networkConversations : shouldUseCachedConversations ? cachedConversations : [];
  const conversationPreferencesMap = useMemo(
    () =>
      new Map(
        dedupeConversationPreferences(conversationPreferences).map((preference) => [
          preference.conversation_id,
          preference,
        ]),
      ),
    [conversationPreferences]
  );
  const draftEntriesMap = useMemo(
    () => new Map(draftEntries.map((entry) => [entry.conversationId, entry])),
    [draftEntries]
  );
  const availableServices = useMemo(
    () => resolveAvailableServicesForUser(services, effectiveUser),
    [services, effectiveUser]
  );
  const chatbotRuntimeContext = useMemo(
    () => ({
      activeSessionConversationIds: Array.isArray(chatbotRuntimeState?.activeSessionConversationIds)
        ? chatbotRuntimeState.activeSessionConversationIds
        : [],
      waitingTimerConversationIds: Array.isArray(chatbotRuntimeState?.waitingTimerConversationIds)
        ? chatbotRuntimeState.waitingTimerConversationIds
        : [],
      awaitingUraConversationIds: Array.isArray(chatbotRuntimeState?.awaitingUraConversationIds)
        ? chatbotRuntimeState.awaitingUraConversationIds
        : [],
    }),
    [chatbotRuntimeState],
  );

  useEffect(() => {
    if (serviceFilter === 'all') {
      return;
    }

    if (!availableServices.some((service) => service.id === serviceFilter)) {
      setServiceFilter('all');
    }
  }, [availableServices, serviceFilter]);

  const conversations = useMemo(
    () => {
      const enrichedConversations = enrichConversationsWithLabels(baseConversations, [], {
        customLabels,
        assignments,
        stageAssignments,
        serviceRoutingLabelIds: services.flatMap((service) => service.label_ids || service.labelIds || []),
      });

      const decoratedConversations = decorateConversationsWithServices(
        enrichedConversations
        .map((conversation, index) => {
          const preference = conversationPreferencesMap.get(conversation.id);
          const draftEntry = draftEntriesMap.get(conversation.id);
          const unreadCount = Number(conversation.unread_count || 0);

          return {
            ...conversation,
            is_pinned: Boolean(preference?.is_pinned ?? conversation.is_pinned),
            pinned_at: preference?.pinned_at || '',
            pinned_by_id: preference?.pinned_by_id || '',
            pinned_by_name: preference?.pinned_by_name || '',
            manual_unread: Boolean(preference?.manual_unread ?? conversation.manual_unread),
            manual_unread_at: preference?.manual_unread_at || '',
            manual_unread_by_id: preference?.manual_unread_by_id || '',
            manual_unread_by_name: preference?.manual_unread_by_name || '',
            resolution_status: preference?.resolution_status || '',
            resolution_type: preference?.resolution_type || '',
            resolved_at: preference?.resolved_at || '',
            resolved_until: preference?.resolved_until || '',
            resolved_by_id: preference?.resolved_by_id || '',
            resolved_by_name: preference?.resolved_by_name || '',
            has_draft: Boolean(draftEntry?.value),
            draft_preview: draftEntry?.value || '',
            draft_updated_at: draftEntry?.updatedAt || '',
            draft_sort_at: draftEntry?.sortAt || '',
            effective_unread: unreadCount > 0 || Boolean(preference?.manual_unread ?? conversation.manual_unread),
            sort_index: index,
          };
        }),
        services,
        effectiveUser,
      ).map((conversation) => {
        const resolvedAtMs = getPreferenceTime(conversation.resolved_at);
        const lastClientMessageAtMs = getPreferenceTime(
          conversation.last_client_message_time || conversation.last_received_at
        );
        const defaultResolvedUntilMs =
          lastClientMessageAtMs > 0 ? lastClientMessageAtMs + DAY_IN_MS : resolvedAtMs + DAY_IN_MS;
        const resolvedUntilMs = getPreferenceTime(conversation.resolved_until) || defaultResolvedUntilMs;
        const reopenedByCustomer = resolvedAtMs > 0 && lastClientMessageAtMs > resolvedAtMs;
        const isResolutionActive =
          conversation.resolution_status === 'resolved' &&
          resolvedAtMs > 0 &&
          !reopenedByCustomer;
        const isDailyResolved = isResolutionActive && resolvedUntilMs > Date.now();
        const attendanceState = resolveConversationAttendanceBucket(
          {
            ...conversation,
            reopened_by_customer: reopenedByCustomer,
            is_resolution_active: isResolutionActive,
            is_daily_resolved: isDailyResolved,
          },
          { chatbotRuntime: chatbotRuntimeContext },
        );

        return {
          ...conversation,
          reopened_by_customer: reopenedByCustomer,
          is_resolution_active: isResolutionActive,
          is_daily_resolved: isDailyResolved,
          resolved_until_effective: resolvedUntilMs ? new Date(resolvedUntilMs).toISOString() : '',
          attendance_bucket: attendanceState.bucket,
          attendance_bucket_reason: attendanceState.reason,
          resolution_kind: attendanceState.resolutionKind,
        };
      });

      const visibleConversations = isAdminUser(effectiveUser)
        ? decoratedConversations
        : decoratedConversations.filter(
            (conversation) =>
              conversation.attendance_bucket === 'active' &&
              isConversationAssignedToUser(conversation, effectiveUser),
          );

      return visibleConversations
        .sort((left, right) => {
          if (left.is_pinned !== right.is_pinned) {
            return left.is_pinned ? -1 : 1;
          }

          if (left.is_pinned && right.is_pinned) {
            const leftPinnedAt = getPreferenceTime(left.pinned_at);
            const rightPinnedAt = getPreferenceTime(right.pinned_at);
            if (leftPinnedAt !== rightPinnedAt) {
              return rightPinnedAt - leftPinnedAt;
            }
          }

          const timeDifference = getConversationTime(right) - getConversationTime(left);
          if (timeDifference !== 0) {
            return timeDifference;
          }

          return left.sort_index - right.sort_index;
        });
    },
    [
      assignments,
      baseConversations,
      chatbotRuntimeContext,
      conversationPreferencesMap,
      customLabels,
      draftEntriesMap,
      services,
      stageAssignments,
      effectiveUser,
    ]
  );

  useEffect(() => {
    const target = location.state?.openConversation;
    if (!target || conversations.length === 0) return;

    const key = JSON.stringify({
      conversationId: target.conversationId || '',
      customerId: target.customerId || '',
      phone: normalizePhoneDigits(target.phone || ''),
    });
    if (initialConversationTargetRef.current === key) return;

    const targetIds = new Set(
      [
        target.conversationId,
        target.customerId,
        ...(Array.isArray(target.sourceConversationIds) ? target.sourceConversationIds : []),
      ].map((id) => String(id || '').trim()).filter(Boolean),
    );
    const targetPhone = normalizePhoneDigits(target.phone || '');
    const matchedConversation = conversations.find((conversation) => {
      const conversationIds = [
        conversation.id,
        conversation.aggregate_conversation_id,
        conversation.customer?.id,
        ...(Array.isArray(conversation.source_conversation_ids) ? conversation.source_conversation_ids : []),
      ].map((id) => String(id || '').trim()).filter(Boolean);
      const hasMatchingId = conversationIds.some((id) => targetIds.has(id));
      const conversationPhone = normalizePhoneDigits(conversation.contact_phone || conversation.customer?.phone || '');
      return hasMatchingId || (targetPhone && conversationPhone === targetPhone);
    });

    if (matchedConversation) {
      initialConversationTargetRef.current = key;
      handleSelectConversation(matchedConversation);
    }
  }, [conversations, location.state?.openConversation]);

  useEffect(() => {
    if (!selectedConversation?.id) return;

    const refreshedConversation = conversations.find((conversation) => conversation.id === selectedConversation.id);
    if (refreshedConversation) {
      if (buildConversationRefreshKey(refreshedConversation) === buildConversationRefreshKey(selectedConversation)) {
        return;
      }
      setSelectedConversation(refreshedConversation);
      return;
    }

    setSelectedConversation(null);
  }, [conversations, selectedConversation, setSelectedConversation]);

  const handleSelectConversation = (conv) => {
    setSelectedConversation(conv);
    setShowContactInfo(false);

    if (!conv?.manual_unread) {
      return;
    }

    queryClient.setQueriesData({ queryKey: ['conversation-preferences'] }, (current = []) =>
      current.map((preference) =>
        String(preference?.conversation_id) !== String(conv.id)
          ? preference
          : {
              ...preference,
              manual_unread: false,
              manual_unread_at: '',
              manual_unread_by_id: '',
              manual_unread_by_name: '',
            }
      )
    );

    void saveConversationPreference(conv.id, {
      manual_unread: false,
      manual_unread_at: '',
      manual_unread_by_id: '',
      manual_unread_by_name: '',
    }).catch(() => {
      void queryClient.invalidateQueries({ queryKey: ['conversation-preferences'] });
    });
  };

  const handleUpdateConversation = (updated) => {
    setSelectedConversation(updated);
  };

  return (
    <div className="chat-app-shell h-screen flex overflow-hidden bg-background">
      {isError && conversations.length === 0 ? (
        <div className="chat-panel w-[380px] xl:w-[400px] flex-shrink-0 border-r border-border flex items-center justify-center p-6">
          <div className="text-center space-y-3 max-w-[240px]">
            <div className="w-12 h-12 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center mx-auto">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-sm text-foreground">Falha ao carregar atendimentos</h3>
              <p className="text-xs text-muted-foreground mt-1">
                {error?.message || 'Não foi possível consultar a API do WhatsApp.'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <ConversationList
          conversations={conversations}
          services={availableServices}
          selectedId={selectedConversation?.id}
          onSelect={handleSelectConversation}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          primaryFilter={primaryFilter}
          onPrimaryFilterChange={setPrimaryFilter}
          serviceFilter={serviceFilter}
          onServiceFilterChange={setServiceFilter}
          labelFilter={labelFilter}
          onLabelFilterChange={setLabelFilter}
          customLabels={customLabels}
          currentUser={effectiveUser}
          teamUsers={teamUsers}
          activeUsers={activeAttendanceUsers}
          allServices={services}
          isLoading={!isFetched && conversations.length === 0}
          hasMore={ENABLE_NEW_CHAT_DATA_LAYER && Boolean(paginatedConversationsQuery.hasNextPage)}
          isLoadingMore={ENABLE_NEW_CHAT_DATA_LAYER && paginatedConversationsQuery.isFetchingNextPage}
          onLoadMore={ENABLE_NEW_CHAT_DATA_LAYER ? paginatedConversationsQuery.fetchNextPage : undefined}
          onOpenStartConversation={() => {
            setStartConversationPhone('');
            setStartConversationOpen(true);
          }}
          isQueueDistributionPaused={isDistributionPaused}
          queueDistributionPauseRemainingMs={distributionPauseRemainingMs}
          queueDistributionPauseReasonLabel={distributionPauseReasonLabel}
          onPauseQueueDistribution={handlePauseQueueDistribution}
          onResumeQueueDistribution={handleResumeQueueDistribution}
        />
      )}
      <ChatWindow
        key={selectedConversation?.id || 'no-conversation'}
        conversation={selectedConversation}
        onUpdateConversation={handleUpdateConversation}
        onClearConversation={() => {
          setSelectedConversation(null);
          setShowContactInfo(false);
        }}
        onToggleInfo={() => setShowContactInfo(v => !v)}
        showInfo={showContactInfo}
        currentUser={effectiveUser}
        activeUsers={activeAttendanceUsers}
        teamUsers={teamUsers}
        allServices={services}
        onOpenStartConversation={(phone) => {
          setStartConversationPhone(String(phone || ''));
          setStartConversationOpen(true);
        }}
      />
      {selectedConversation && showContactInfo && (
        <ContactInfoPanel
          conversation={selectedConversation}
          onClose={() => setShowContactInfo(false)}
        />
      )}
      <StartConversationDialog
        open={startConversationOpen}
        onOpenChange={setStartConversationOpen}
        services={availableServices}
        defaultServiceId={serviceFilter === 'all' ? availableServices[0]?.id || '' : serviceFilter}
        initialPhone={startConversationPhone}
        currentUser={effectiveUser}
      />
    </div>
  );
}
