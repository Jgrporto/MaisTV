import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowRightLeft, Clock3, Eye, Filter, ListChecks, MessageSquare, RefreshCw, Search, Send, UserCheck, Users } from 'lucide-react';
import { toast } from 'sonner';

import ServiceIconBadge from '@/components/services/ServiceIconBadge';
import PageHeader from '@/components/layout/PageHeader';
import PageShell from '@/components/layout/PageShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { fetchActiveAttendanceUsers } from '@/lib/presence-api';
import { fetchPersistedCustomers } from '@/lib/customer-sync-api';
import { buildCustomerRows } from '@/lib/customer-base';
import { enrichConversationsWithLabels, useLabelCatalog } from '@/lib/labels';
import { subscribeToLocalEvents } from '@/lib/local-events';
import {
  BACKGROUND_REFRESH_INTERVAL_MS,
  CONVERSATION_BACKGROUND_SUMMARY_LIMIT,
  CONVERSATION_REFRESH_INTERVAL_MS,
  CUSTOMER_CACHE_REFRESH_INTERVAL_MS,
  PRESENCE_REFRESH_INTERVAL_MS,
} from '@/lib/performance-config';
import { decorateConversationsWithServices } from '@/lib/services';
import { fetchServices } from '@/lib/services-api';
import { fetchLocalUsers } from '@/lib/users-api';
import { fetchWhatsappConversations } from '@/lib/whatsapp-api';
import { assignConversationToUser, requeueConversationForService } from '@/lib/conversation-assignment-api';
import { resolveConversationAssignmentStatus } from '@/lib/conversation-assignment-status';
import { cn } from '@/lib/utils';

const normalizeStringArray = (value) =>
  Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];

const normalizeUserKey = (value) => String(value || '').trim().toLowerCase();

const resolveConversationServiceIds = (conversation = {}) =>
  Array.from(
    new Set(
      [
        conversation.queued_service_id,
        ...(normalizeStringArray(conversation.queued_service_ids)),
        ...(normalizeStringArray(conversation.matching_service_ids)),
        ...(normalizeStringArray(conversation.accessible_service_ids)),
      ].filter(Boolean),
    ),
  );

const formatWaitingTime = (dateValue) => {
  const timestamp = Date.parse(String(dateValue || ''));
  if (!Number.isFinite(timestamp)) return '-';
  const diffMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (diffMinutes < 1) return 'agora';
  if (diffMinutes < 60) return `${diffMinutes}min`;
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return minutes ? `${hours}h ${minutes}min` : `${hours}h`;
};

const formatDateTime = (dateValue) => {
  const date = new Date(String(dateValue || ''));
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const serviceUserMatches = (service = {}, user = {}) => {
  const serviceUserIds = normalizeStringArray(service.user_ids || service.userIds);
  const serviceUserEmails = normalizeStringArray(service.user_emails || service.userEmails).map(normalizeUserKey);
  const userId = String(user?.id || '').trim();
  const userEmail = normalizeUserKey(user?.email);
  return (userId && serviceUserIds.includes(userId)) || (userEmail && serviceUserEmails.includes(userEmail));
};

const isAdminUser = (user = {}) => {
  const role = normalizeUserKey(user?.role || user?.type || user?.profile);
  return role === 'admin' || role === 'administrator' || role === 'owner';
};

const getUserName = (user = {}) =>
  String(user?.name || user?.display_name || user?.displayName || user?.username || user?.email || 'Atendente').trim();

const conversationAssignedToUser = (conversation = {}, user = {}) => {
  const userId = String(user?.id || '').trim();
  const userEmail = normalizeUserKey(user?.email);
  const userName = normalizeUserKey(getUserName(user));
  const assignedId = String(conversation?.assigned_agent_id || conversation?.assignedAgentId || '').trim();
  const assignedEmail = normalizeUserKey(conversation?.assigned_agent_email || conversation?.assignedAgentEmail);
  const assignedName = normalizeUserKey(conversation?.assigned_agent_name || conversation?.assignedAgentName || conversation?.assigned_agent);

  if (userId && assignedId && userId === assignedId) return true;
  if (userEmail && assignedEmail && userEmail === assignedEmail) return true;
  if (userName && assignedName && userName === assignedName) return true;
  return false;
};

const uniqueConversations = (conversations = []) =>
  Array.from(new Map(conversations.map((conversation) => [String(conversation?.id || ''), conversation])).values())
    .filter((conversation) => conversation?.id);

const buildAgentLoadRows = ({ users = [], conversations = [], services = [], activeUserKeys = new Set() }) =>
  users
    .filter((user) => !isAdminUser(user))
    .map((user) => {
      const serviceNames = services
        .filter((service) => serviceUserMatches(service, user))
        .map((service) => service.name || 'Servico sem nome');
      const assignedConversations = uniqueConversations(
        conversations.filter((conversation) => conversationAssignedToUser(conversation, user)),
      );
      const userId = String(user?.id || '').trim();
      const userEmail = normalizeUserKey(user?.email);

      return {
        user,
        name: getUserName(user),
        active: activeUserKeys.has(userId) || activeUserKeys.has(userEmail),
        assignedCount: assignedConversations.length,
        serviceNames,
      };
    })
    .sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      if (left.assignedCount !== right.assignedCount) return right.assignedCount - left.assignedCount;
      return left.name.localeCompare(right.name, 'pt-BR', { sensitivity: 'base' });
    });

const resolveAssignableUsersForConversation = ({ conversation = {}, users = [], services = [], activeUserKeys = new Set() }) => {
  const serviceIds = resolveConversationServiceIds(conversation);
  const matchingServices = services.filter((service) => serviceIds.includes(String(service?.id || '').trim()));

  return users
    .filter((user) => {
      if (isAdminUser(user)) return false;
      const userId = String(user?.id || '').trim();
      const userEmail = normalizeUserKey(user?.email);
      if (!activeUserKeys.has(userId) && !activeUserKeys.has(userEmail)) return false;
      if (conversationAssignedToUser(conversation, user)) return false;
      if (!matchingServices.length) return true;
      return matchingServices.some((service) => serviceUserMatches(service, user));
    })
    .sort((left, right) =>
      getUserName(left).localeCompare(getUserName(right), 'pt-BR', { sensitivity: 'base' }),
    );
};

const findAssignedUserForConversation = ({ conversation = {}, users = [] }) =>
  users.find((user) => conversationAssignedToUser(conversation, user)) || null;

const hasConversationAssignment = (conversation = {}) =>
  [
    conversation.assigned_agent,
    conversation.assigned_agent_id,
    conversation.assigned_agent_email,
    conversation.assigned_agent_name,
  ].some((value) => String(value || '').trim());

const getConversationOperationalFlags = ({ conversation = {}, users = [], services = [], activeUserKeys = new Set() }) => {
  const assignmentStatus = resolveConversationAssignmentStatus({ conversation, users, services });
  const serviceIds = resolveConversationServiceIds(conversation);
  const assignedUser = findAssignedUserForConversation({ conversation, users });
  const assignedUserId = String(assignedUser?.id || '').trim();
  const assignedUserEmail = normalizeUserKey(assignedUser?.email);
  const assignedUserActive = Boolean(
    assignedUser && (activeUserKeys.has(assignedUserId) || activeUserKeys.has(assignedUserEmail)),
  );
  const assignedOffline = hasConversationAssignment(conversation) && !assignedUserActive;
  const queueStatus = String(conversation.queue_status || '').trim();
  const assignmentSource = String(conversation.assignment_source || '').trim();
  const waiting = assignmentStatus.status === 'queued' || queueStatus === 'waiting';
  const unclassified = assignmentStatus.status === 'unclassified' || queueStatus === 'unclassified';
  const assignableUsers = resolveAssignableUsersForConversation({
    conversation,
    users,
    services,
    activeUserKeys,
  });
  const waitingWithoutCandidate = waiting && assignableUsers.length === 0;

  return {
    assignmentStatus,
    assignedOffline,
    stuck: assignedOffline || waitingWithoutCandidate,
    withoutQueue: unclassified || serviceIds.length === 0 || assignmentSource === 'unclassified_queue',
    queued: waiting || unclassified,
    assigned: assignmentStatus.status === 'assigned_to_me' || assignmentStatus.status === 'assigned_to_other',
    assignableUsers,
  };
};

const conversationMatchesSearch = (conversation = {}, search = '') => {
  const normalizedSearch = normalizeUserKey(search);
  if (!normalizedSearch) return true;
  return [
    conversation.contact_name,
    conversation.customer?.name,
    conversation.contact_phone,
    conversation.customer?.phone,
    conversation.display_phone_number,
    conversation.last_message,
    conversation.assigned_agent_name,
    conversation.assigned_agent_email,
  ]
    .map(normalizeUserKey)
    .some((value) => value.includes(normalizedSearch));
};

const StatCard = ({ icon: Icon, label, value, description }) => (
  <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold text-foreground">{value}</p>
      </div>
    </div>
    {description ? <p className="mt-3 text-xs text-muted-foreground">{description}</p> : null}
  </div>
);

export default function QueuesServices() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedService, setSelectedService] = useState(null);
  const [transferSelections, setTransferSelections] = useState({});
  const [selectedConversationIds, setSelectedConversationIds] = useState([]);
  const [queueFilters, setQueueFilters] = useState({ search: '', status: 'all' });
  const [bulkTransfer, setBulkTransfer] = useState({ userId: '', serviceId: '' });
  const [transferringKey, setTransferringKey] = useState('');
  const { customLabels, assignments, stageAssignments } = useLabelCatalog();

  const { data: services = [], isLoading: loadingServices } = useQuery({
    queryKey: ['services', 'queues-services'],
    queryFn: fetchServices,
    staleTime: 10000,
    refetchInterval: BACKGROUND_REFRESH_INTERVAL_MS,
  });

  const { data: conversations = [], isLoading: loadingConversations } = useQuery({
    queryKey: ['conversations', 'queues-services', 'summary', CONVERSATION_BACKGROUND_SUMMARY_LIMIT],
    queryFn: () => fetchWhatsappConversations({ summary: true, limit: CONVERSATION_BACKGROUND_SUMMARY_LIMIT }),
    staleTime: 10000,
    refetchInterval: CONVERSATION_REFRESH_INTERVAL_MS,
  });

  const { data: customersResponse = {} } = useQuery({
    queryKey: ['persisted-customers', 'queues-services'],
    queryFn: fetchPersistedCustomers,
    staleTime: CUSTOMER_CACHE_REFRESH_INTERVAL_MS,
    refetchInterval: CUSTOMER_CACHE_REFRESH_INTERVAL_MS,
  });

  const { data: teamUsers = [] } = useQuery({
    queryKey: ['settings', 'users'],
    queryFn: fetchLocalUsers,
    staleTime: 30000,
  });

  const { data: activeUsers = [] } = useQuery({
    queryKey: ['presence', 'attending-users'],
    queryFn: fetchActiveAttendanceUsers,
    staleTime: 10000,
    refetchInterval: PRESENCE_REFRESH_INTERVAL_MS,
  });

  useEffect(
    () =>
      subscribeToLocalEvents((event) => {
        if (
          event.type === 'conversation:assignment-updated' ||
          event.type === 'conversation:message-upserted' ||
          event.type === 'conversation:message-status-updated' ||
          event.type === 'conversation:message-reaction-updated'
        ) {
          void queryClient.invalidateQueries({ queryKey: ['conversations', 'queues-services'] });
          void queryClient.invalidateQueries({ queryKey: ['conversations', 'attendance'] });
          void queryClient.invalidateQueries({ queryKey: ['presence', 'attending-users'] });
        }
      }),
    [queryClient],
  );

  const activeUserKeys = useMemo(
    () => new Set(activeUsers.flatMap((user) => [String(user?.id || '').trim(), normalizeUserKey(user?.email)]).filter(Boolean)),
    [activeUsers],
  );

  const customerRows = useMemo(
    () => buildCustomerRows(Array.isArray(customersResponse?.rows) ? customersResponse.rows : [], conversations),
    [conversations, customersResponse],
  );

  const enrichedConversations = useMemo(
    () =>
      decorateConversationsWithServices(
        enrichConversationsWithLabels(conversations, customerRows, {
          customLabels,
          assignments,
          stageAssignments,
          serviceRoutingLabelIds: services.flatMap((service) => service.label_ids || service.labelIds || []),
        }),
        services,
        null,
      ),
    [assignments, conversations, customLabels, customerRows, services, stageAssignments],
  );

  const serviceRows = useMemo(() =>
    services.map((service) => {
      const linkedUsers = teamUsers.filter((user) => serviceUserMatches(service, user) && !isAdminUser(user));
      const onlineUsers = linkedUsers.filter((user) => activeUserKeys.has(String(user?.id || '').trim()) || activeUserKeys.has(normalizeUserKey(user?.email)));
      const serviceConversations = enrichedConversations.filter((conversation) => resolveConversationServiceIds(conversation).includes(service.id));
      const queuedConversations = serviceConversations.filter((conversation) => {
        const status = resolveConversationAssignmentStatus({ conversation, users: teamUsers, services });
        return status.status === 'queued' || status.status === 'unclassified';
      });
      const assignedConversations = serviceConversations.filter((conversation) => {
        const status = resolveConversationAssignmentStatus({ conversation, users: teamUsers, services });
        return status.status === 'assigned_to_me' || status.status === 'assigned_to_other';
      });
      const agentLoadRows = buildAgentLoadRows({
        users: linkedUsers,
        conversations: serviceConversations,
        services: [service],
        activeUserKeys,
      });

      return {
        service,
        linkedUsers,
        onlineUsers,
        serviceConversations,
        queuedConversations,
        assignedConversations,
        agentLoadRows,
      };
    }),
  [activeUserKeys, enrichedConversations, services, teamUsers]);

  const allQueuesRow = useMemo(() => ({
    service: {
      id: '__all__',
      name: 'Todos os clientes',
      description: 'Visao consolidada para localizar clientes sem fila, presos ou atribuidos a usuario offline.',
    },
    linkedUsers: teamUsers.filter((user) => !isAdminUser(user)),
    onlineUsers: teamUsers.filter((user) => {
      const userId = String(user?.id || '').trim();
      const userEmail = normalizeUserKey(user?.email);
      return !isAdminUser(user) && (activeUserKeys.has(userId) || activeUserKeys.has(userEmail));
    }),
    serviceConversations: enrichedConversations,
    queuedConversations: enrichedConversations.filter((conversation) => {
      const flags = getConversationOperationalFlags({
        conversation,
        users: teamUsers,
        services,
        activeUserKeys,
      });
      return flags.queued;
    }),
    assignedConversations: enrichedConversations.filter((conversation) => {
      const flags = getConversationOperationalFlags({
        conversation,
        users: teamUsers,
        services,
        activeUserKeys,
      });
      return flags.assigned;
    }),
    agentLoadRows: buildAgentLoadRows({
      users: teamUsers,
      conversations: enrichedConversations,
      services,
      activeUserKeys,
    }),
  }), [activeUserKeys, enrichedConversations, services, teamUsers]);

  const agentLoadRows = useMemo(
    () =>
      buildAgentLoadRows({
        users: teamUsers,
        conversations: enrichedConversations,
        services,
        activeUserKeys,
      }),
    [activeUserKeys, enrichedConversations, services, teamUsers],
  );

  const selectedRow = selectedService
    ? String(selectedService.id) === '__all__'
      ? allQueuesRow
      : serviceRows.find((row) => String(row.service.id) === String(selectedService.id)) || null
    : null;

  const filteredServiceConversations = useMemo(() => {
    const rows = selectedRow?.serviceConversations || [];
    return rows.filter((conversation) => {
      if (!conversationMatchesSearch(conversation, queueFilters.search)) return false;

      const flags = getConversationOperationalFlags({
        conversation,
        users: teamUsers,
        services,
        activeUserKeys,
      });

      if (queueFilters.status === 'queued') return flags.queued;
      if (queueFilters.status === 'assigned') return flags.assigned;
      if (queueFilters.status === 'without_queue') return flags.withoutQueue;
      if (queueFilters.status === 'stuck') return flags.stuck;
      if (queueFilters.status === 'offline_assigned') return flags.assignedOffline;
      return true;
    });
  }, [activeUserKeys, queueFilters.search, queueFilters.status, selectedRow, services, teamUsers]);

  const filteredConversationIds = useMemo(
    () => filteredServiceConversations.map((conversation) => String(conversation.id || '').trim()).filter(Boolean),
    [filteredServiceConversations],
  );

  const selectedConversationIdSet = useMemo(() => new Set(selectedConversationIds), [selectedConversationIds]);

  const selectedConversations = useMemo(
    () =>
      (selectedRow?.serviceConversations || []).filter((conversation) =>
        selectedConversationIdSet.has(String(conversation.id || '').trim()),
      ),
    [selectedConversationIdSet, selectedRow],
  );

  const allFilteredSelected =
    filteredConversationIds.length > 0 && filteredConversationIds.every((conversationId) => selectedConversationIdSet.has(conversationId));
  const partiallyFilteredSelected =
    !allFilteredSelected && filteredConversationIds.some((conversationId) => selectedConversationIdSet.has(conversationId));

  const bulkAssignableUsers = useMemo(() => {
    const serviceUsers = selectedRow?.linkedUsers?.length ? selectedRow.linkedUsers : teamUsers;
    return serviceUsers
      .filter((user) => {
        if (isAdminUser(user)) return false;
        const userId = String(user?.id || '').trim();
        const userEmail = normalizeUserKey(user?.email);
        return activeUserKeys.has(userId) || activeUserKeys.has(userEmail);
      })
      .sort((left, right) => getUserName(left).localeCompare(getUserName(right), 'pt-BR', { sensitivity: 'base' }));
  }, [activeUserKeys, selectedRow, teamUsers]);

  const totals = useMemo(() => ({
    services: serviceRows.length,
    queued: serviceRows.reduce((total, row) => total + row.queuedConversations.length, 0),
    assigned: serviceRows.reduce((total, row) => total + row.assignedConversations.length, 0),
    onlineAgents: new Set(activeUsers.map((user) => String(user?.id || user?.email || '').trim()).filter(Boolean)).size,
  }), [activeUsers, serviceRows]);

  const openConversation = (conversation) => {
    navigate('/', {
      state: {
        openConversation: {
          conversationId: conversation.id,
          customerId: conversation.customer?.id || conversation.customer_id || '',
          phone: conversation.contact_phone || conversation.customer?.phone || '',
          sourceConversationIds: conversation.source_conversation_ids || [],
        },
      },
    });
  };

  const openServiceQueue = (service) => {
    setSelectedConversationIds([]);
    setQueueFilters({ search: '', status: 'all' });
    setBulkTransfer({ userId: '', serviceId: '' });
    setSelectedService(service);
  };

  const closeServiceQueue = () => {
    setSelectedService(null);
    setSelectedConversationIds([]);
    setQueueFilters({ search: '', status: 'all' });
    setBulkTransfer({ userId: '', serviceId: '' });
  };

  const updateQueueFilter = (key, value) => {
    setQueueFilters((current) => ({ ...current, [key]: value }));
  };

  const toggleConversationSelection = (conversationId, checked) => {
    const safeConversationId = String(conversationId || '').trim();
    if (!safeConversationId) return;
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(safeConversationId);
      } else {
        next.delete(safeConversationId);
      }
      return [...next];
    });
  };

  const toggleFilteredSelection = (checked) => {
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      filteredConversationIds.forEach((conversationId) => {
        if (checked) {
          next.add(conversationId);
        } else {
          next.delete(conversationId);
        }
      });
      return [...next];
    });
  };

  const updateTransferSelection = (conversationId, patch) => {
    setTransferSelections((current) => ({
      ...current,
      [conversationId]: {
        ...(current[conversationId] || {}),
        ...patch,
      },
    }));
  };

  const refreshQueueQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['conversations', 'queues-services'] }),
      queryClient.invalidateQueries({ queryKey: ['conversations', 'attendance'] }),
      queryClient.invalidateQueries({ queryKey: ['presence', 'attending-users'] }),
    ]);
  };

  const runBulkConversationAction = async ({ actionLabel, run }) => {
    if (!selectedConversations.length || transferringKey) return;

    setTransferringKey(`bulk:${actionLabel}`);
    let successCount = 0;
    let failureCount = 0;

    for (const conversation of selectedConversations) {
      try {
        await run(conversation);
        successCount += 1;
      } catch (error) {
        failureCount += 1;
      }
    }

    try {
      await refreshQueueQueries();
      if (successCount > 0) {
        setSelectedConversationIds([]);
        toast.success(`${successCount} cliente(s) processado(s).`);
      }
      if (failureCount > 0) {
        toast.error(`${failureCount} cliente(s) nao puderam ser processados.`);
      }
    } finally {
      setTransferringKey('');
    }
  };

  const handleBulkRedistributeCurrentQueue = async () => {
    const targetServiceId = String(selectedRow?.service?.id || '').trim();
    if (!targetServiceId || targetServiceId === '__all__') return;
    await runBulkConversationAction({
      actionLabel: 'redistribute',
      run: (conversation) =>
        requeueConversationForService(conversation.id, {
          sourceConversationIds: conversation.source_conversation_ids,
          matchingServiceIds: [targetServiceId],
          targetServiceId,
        }),
    });
  };

  const handleBulkTransferToService = async () => {
    const targetServiceId = String(bulkTransfer.serviceId || '').trim();
    if (!targetServiceId) return;
    await runBulkConversationAction({
      actionLabel: 'service',
      run: (conversation) =>
        requeueConversationForService(conversation.id, {
          sourceConversationIds: conversation.source_conversation_ids,
          matchingServiceIds: [targetServiceId],
          targetServiceId,
        }),
    });
    setBulkTransfer((current) => ({ ...current, serviceId: '' }));
  };

  const handleBulkTransferToUser = async () => {
    const targetUserId = String(bulkTransfer.userId || '').trim();
    if (!targetUserId) return;
    await runBulkConversationAction({
      actionLabel: 'user',
      run: (conversation) =>
        assignConversationToUser(conversation.id, targetUserId, {
          sourceConversationIds: conversation.source_conversation_ids,
          matchingServiceIds: resolveConversationServiceIds(conversation),
        }),
    });
    setBulkTransfer((current) => ({ ...current, userId: '' }));
  };

  const handleTransferToUser = async (conversation) => {
    const conversationId = String(conversation?.id || '').trim();
    const targetUserId = String(transferSelections[conversationId]?.userId || '').trim();
    if (!conversationId || !targetUserId || transferringKey) return;

    setTransferringKey(`${conversationId}:user`);
    try {
      const result = await assignConversationToUser(conversationId, targetUserId, {
        sourceConversationIds: conversation.source_conversation_ids,
        matchingServiceIds: conversation.matching_service_ids,
      });
      const assignedConversation = result?.conversation || {};
      setTransferSelections((current) => ({
        ...current,
        [conversationId]: {
          ...(current[conversationId] || {}),
          userId: '',
        },
      }));
      await refreshQueueQueries();
      toast.success(`Cliente transferido para ${assignedConversation.assigned_agent_name || 'o atendente selecionado'}.`);
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel transferir o cliente.');
    } finally {
      setTransferringKey('');
    }
  };

  const handleTransferToService = async (conversation) => {
    const conversationId = String(conversation?.id || '').trim();
    const targetServiceId = String(transferSelections[conversationId]?.serviceId || '').trim();
    if (!conversationId || !targetServiceId || transferringKey) return;

    const targetService = services.find((service) => String(service?.id || '').trim() === targetServiceId);
    setTransferringKey(`${conversationId}:service`);
    try {
      await requeueConversationForService(conversationId, {
        sourceConversationIds: conversation.source_conversation_ids,
        matchingServiceIds: [targetServiceId],
        targetServiceId,
      });
      setTransferSelections((current) => ({
        ...current,
        [conversationId]: {
          ...(current[conversationId] || {}),
          serviceId: '',
        },
      }));
      await refreshQueueQueries();
      toast.success(`Cliente enviado para ${targetService?.name || 'o servico selecionado'}.`);
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel enviar o cliente para o servico.');
    } finally {
      setTransferringKey('');
    }
  };

  const isLoading = loadingServices || loadingConversations;

  return (
    <PageShell>
      <PageHeader
        title="Filas & Serviços"
        description="Acompanhe as filas por serviço, agentes vinculados, agentes online e clientes aguardando atendimento."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={ListChecks} label="Serviços" value={totals.services} description="Serviços configurados para roteamento." />
        <StatCard icon={Clock3} label="Na fila" value={totals.queued} description="Clientes aguardando distribuição." />
        <StatCard icon={MessageSquare} label="Em atendimento" value={totals.assigned} description="Conversas atribuídas a agentes." />
        <StatCard icon={UserCheck} label="Agentes online" value={totals.onlineAgents} description="Usuários elegíveis em presença ativa." />
      </div>

      <section className="mt-6 rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Carga por atendente</h2>
            <p className="text-sm text-muted-foreground">Quantidade atual de conversas atribuidas a cada atendente.</p>
          </div>
          <Badge variant="outline" className="gap-2">
            <Users className="h-3.5 w-3.5" /> {agentLoadRows.length} atendentes
          </Badge>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-semibold">Atendente</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Conversas atuais</th>
                <th className="px-5 py-3 font-semibold">Servicos vinculados</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agentLoadRows.map((row) => (
                <tr key={row.user?.id || row.user?.email || row.name} className="hover:bg-muted/25">
                  <td className="px-5 py-4">
                    <div>
                      <p className="font-semibold text-foreground">{row.name}</p>
                      <p className="text-xs text-muted-foreground">{row.user?.email || '-'}</p>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <Badge
                      variant="outline"
                      className={cn(
                        row.active
                          ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700'
                          : 'border-muted bg-muted text-muted-foreground',
                      )}
                    >
                      {row.active ? 'Apto para receber' : 'Fora da distribuicao'}
                    </Badge>
                  </td>
                  <td className="px-5 py-4 text-lg font-semibold text-foreground">{row.assignedCount}</td>
                  <td className="px-5 py-4 text-muted-foreground">
                    {row.serviceNames.length ? row.serviceNames.join(', ') : 'Sem servico vinculado'}
                  </td>
                </tr>
              ))}

              {!agentLoadRows.length ? (
                <tr>
                  <td colSpan={4} className="px-5 py-10 text-center text-sm text-muted-foreground">
                    Nenhum atendente cadastrado para distribuicao.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Serviços configurados</h2>
            <p className="text-sm text-muted-foreground">A distribuição considera agentes online e vinculados ao serviço.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => openServiceQueue(allQueuesRow.service)}>
              <Filter className="mr-1.5 h-3.5 w-3.5" /> Ver todos
            </Button>
            {isLoading ? (
              <Badge variant="outline" className="gap-2">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Atualizando
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-semibold">Serviço</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Fila</th>
                <th className="px-5 py-3 font-semibold">Em atendimento</th>
                <th className="px-5 py-3 font-semibold">Agentes online</th>
                <th className="px-5 py-3 font-semibold">Agentes vinculados</th>
                <th className="px-5 py-3 font-semibold">Estratégia</th>
                <th className="px-5 py-3 font-semibold">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {serviceRows.map((row) => {
                const service = row.service;
                const active = service.active !== false && String(service.status || 'active') !== 'inactive';
                return (
                  <tr key={service.id} className="hover:bg-muted/25">
                    <td className="px-5 py-4">
                      <div className="flex items-start gap-3">
                        <ServiceIconBadge iconKey={service.icon_key} />
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground">{service.name || 'Serviço sem nome'}</p>
                          <p className="mt-1 max-w-[280px] truncate text-xs text-muted-foreground">{service.description || 'Sem descrição cadastrada.'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <Badge className={cn(active ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700' : 'border-muted bg-muted text-muted-foreground')} variant="outline">
                        {active ? 'Ativo' : 'Inativo'}
                      </Badge>
                    </td>
                    <td className="px-5 py-4 font-semibold text-foreground">{row.queuedConversations.length}</td>
                    <td className="px-5 py-4 font-semibold text-foreground">{row.assignedConversations.length}</td>
                    <td className="px-5 py-4">{row.onlineUsers.length}</td>
                    <td className="px-5 py-4">{row.linkedUsers.length}</td>
                    <td className="px-5 py-4 text-xs text-muted-foreground">Menor quantidade de atendimentos abertos</td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => openServiceQueue(service)}>
                          <Eye className="mr-1.5 h-3.5 w-3.5" /> Ver fila
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {!serviceRows.length ? (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-sm text-muted-foreground">
                    Nenhum serviço configurado até o momento.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={Boolean(selectedRow)} onOpenChange={(open) => !open && closeServiceQueue()}>
        <DialogContent className="max-h-[90vh] w-[96vw] max-w-7xl overflow-hidden p-0">
          <DialogHeader className="border-b border-border px-6 py-5">
            <DialogTitle>Fila — {selectedRow?.service?.name || 'Serviço'}</DialogTitle>
            <DialogDescription>
              Clientes aguardando, em atendimento ou relacionados a este serviço. Use esta visão para abrir conversas e acompanhar atribuições.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[68vh] overflow-y-auto px-6 py-5">
            <div className="mb-5 rounded-xl border border-border">
              <div className="border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold text-foreground">Atendentes desta fila</h3>
                <p className="text-xs text-muted-foreground">Carga atual considerando conversas deste servico.</p>
              </div>
              <div className="grid gap-0 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0 xl:grid-cols-3">
                {(selectedRow?.agentLoadRows || []).map((row) => (
                  <div key={row.user?.id || row.user?.email || row.name} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-foreground">{row.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{row.user?.email || '-'}</p>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          row.active
                            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700'
                            : 'border-muted bg-muted text-muted-foreground',
                        )}
                      >
                        {row.active ? 'Apto' : 'Fora'}
                      </Badge>
                    </div>
                    <p className="mt-3 text-2xl font-semibold text-foreground">{row.assignedCount}</p>
                    <p className="text-xs text-muted-foreground">conversas atribuidas</p>
                  </div>
                ))}

                {!selectedRow?.agentLoadRows?.length ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Nenhum atendente vinculado a este servico.
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mb-5 space-y-3 rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Clientes da fila</h3>
                  <p className="text-xs text-muted-foreground">
                    {filteredServiceConversations.length} cliente(s) filtrado(s), {selectedConversations.length} selecionado(s).
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => toggleFilteredSelection(!allFilteredSelected)}
                  disabled={!filteredConversationIds.length}
                >
                  {allFilteredSelected ? 'Limpar selecao' : 'Selecionar filtrados'}
                </Button>
              </div>

              <div className="grid gap-3 xl:grid-cols-[minmax(220px,1fr)_220px_220px_220px_auto]">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={queueFilters.search}
                    onChange={(event) => updateQueueFilter('search', event.target.value)}
                    placeholder="Buscar cliente, telefone, atendente ou mensagem"
                    className="pl-9"
                  />
                </div>

                <Select value={queueFilters.status} onValueChange={(value) => updateQueueFilter('status', value)}>
                  <SelectTrigger>
                    <Filter className="mr-2 h-4 w-4 text-muted-foreground" />
                    <SelectValue placeholder="Filtro" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os clientes</SelectItem>
                    <SelectItem value="queued">Clientes em fila</SelectItem>
                    <SelectItem value="assigned">Clientes atribuídos</SelectItem>
                    <SelectItem value="without_queue">Clientes sem fila</SelectItem>
                    <SelectItem value="stuck">Clientes presos</SelectItem>
                    <SelectItem value="offline_assigned">Usuário offline</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  value={bulkTransfer.userId}
                  onValueChange={(value) => setBulkTransfer((current) => ({ ...current, userId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Enviar para atendente" />
                  </SelectTrigger>
                  <SelectContent>
                    {bulkAssignableUsers.map((user) => (
                      <SelectItem key={user.id || user.email} value={String(user.id || '')}>
                        {getUserName(user)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={bulkTransfer.serviceId}
                  onValueChange={(value) => setBulkTransfer((current) => ({ ...current, serviceId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Enviar para servico" />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((service) => (
                      <SelectItem key={service.id} value={String(service.id || '')}>
                        {service.name || 'Servico sem nome'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex flex-wrap gap-2 xl:justify-end">
                  <Button
                    variant="outline"
                    onClick={handleBulkRedistributeCurrentQueue}
                    disabled={
                      !selectedConversations.length ||
                      Boolean(transferringKey) ||
                      String(selectedRow?.service?.id || '') === '__all__'
                    }
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Redistribuir
                  </Button>
                  <Button
                    onClick={handleBulkTransferToUser}
                    disabled={!selectedConversations.length || !bulkTransfer.userId || Boolean(transferringKey)}
                  >
                    <Send className="mr-2 h-4 w-4" />
                    Atendente
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={handleBulkTransferToService}
                    disabled={!selectedConversations.length || !bulkTransfer.serviceId || Boolean(transferringKey)}
                  >
                    <ArrowRightLeft className="mr-2 h-4 w-4" />
                    Servico
                  </Button>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border">
              <table className="w-full table-fixed text-left text-sm">
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[13%]" />
                  <col className="w-[8%]" />
                  <col className="w-[19%]" />
                  <col className="w-[18%]" />
                </colgroup>
                <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Checkbox
                          checked={allFilteredSelected || (partiallyFilteredSelected ? 'indeterminate' : false)}
                          onCheckedChange={(checked) => toggleFilteredSelection(Boolean(checked))}
                          aria-label="Selecionar clientes filtrados"
                        />
                        <span>Cliente</span>
                      </div>
                    </th>
                    <th className="px-4 py-3">Telefone</th>
                    <th className="px-4 py-3">Entrada</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Tempo</th>
                    <th className="px-4 py-3">Última mensagem</th>
                    <th className="px-4 py-3">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredServiceConversations.map((conversation) => {
                    const conversationFlags = getConversationOperationalFlags({
                      conversation,
                      users: teamUsers,
                      services,
                      activeUserKeys,
                    });
                    const assignmentStatus = conversationFlags.assignmentStatus;
                    const waitingSince = conversation.queued_at || conversation.created_date || conversation.last_message_time;
                    const assignableUsers = conversationFlags.assignableUsers;
                    const conversationId = String(conversation.id || '').trim();
                    const transferSelection = transferSelections[conversationId] || {};
                    const selected = selectedConversationIdSet.has(conversationId);
                    const isTransferringUser = transferringKey === `${conversationId}:user`;
                    const isTransferringService = transferringKey === `${conversationId}:service`;
                    return (
                      <tr key={conversation.id} className={cn('hover:bg-muted/25', selected ? 'bg-primary/5' : '')}>
                        <td className="px-4 py-3">
                          <div className="flex items-start gap-3">
                            <Checkbox
                              checked={selected}
                              onCheckedChange={(checked) => toggleConversationSelection(conversationId, Boolean(checked))}
                              aria-label={`Selecionar ${conversation.contact_name || conversation.customer?.name || 'cliente'}`}
                              className="mt-0.5"
                            />
                            <div className="min-w-0">
                              <p className="truncate font-medium text-foreground">
                                {conversation.contact_name || conversation.customer?.name || 'Cliente'}
                              </p>
                              {conversationFlags.assignedOffline ? (
                                <p className="mt-1 text-xs font-medium text-red-600">Atribuido a usuario offline</p>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{conversation.contact_phone || conversation.customer?.phone || '-'}</td>
                        <td className="px-4 py-3 text-muted-foreground">{conversation.display_phone_number || conversation.source_accounts?.[0]?.displayPhoneNumber || '-'}</td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={cn(assignmentStatus.badgeClassName)}>
                            {assignmentStatus.label}
                          </Badge>
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            {assignmentStatus.agentName ? `Resp.: ${assignmentStatus.agentName}` : assignmentStatus.detail || '-'}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {['queued', 'unclassified'].includes(assignmentStatus.status) ? formatWaitingTime(waitingSince) : '-'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="max-w-[220px] truncate text-foreground">{conversation.last_message || 'Sem mensagem'}</div>
                          <div className="text-xs text-muted-foreground">{formatDateTime(conversation.last_message_time || conversation.updated_date)}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="grid gap-2">
                            <Button size="sm" variant="outline" className="justify-center" onClick={() => openConversation(conversation)}>
                              <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> Abrir
                            </Button>
                            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                              <Select
                                value={transferSelection.userId || ''}
                                onValueChange={(value) => updateTransferSelection(conversationId, { userId: value })}
                              >
                                <SelectTrigger className="h-8 text-xs">
                                  <SelectValue placeholder="Atendente" />
                                </SelectTrigger>
                                <SelectContent>
                                  {assignableUsers.map((user) => (
                                    <SelectItem key={user.id || user.email} value={String(user.id || '')}>
                                      {getUserName(user)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                size="sm"
                                className="h-8 px-2"
                                onClick={() => handleTransferToUser(conversation)}
                                disabled={!transferSelection.userId || Boolean(transferringKey)}
                                title="Transferir para atendente"
                              >
                                <ArrowRightLeft className="h-3.5 w-3.5" />
                                <span className="sr-only">{isTransferringUser ? 'Transferindo' : 'Transferir para atendente'}</span>
                              </Button>
                            </div>
                            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                              <Select
                                value={transferSelection.serviceId || ''}
                                onValueChange={(value) => updateTransferSelection(conversationId, { serviceId: value })}
                              >
                                <SelectTrigger className="h-8 text-xs">
                                  <SelectValue placeholder="Servico" />
                                </SelectTrigger>
                                <SelectContent>
                                  {services.map((service) => (
                                    <SelectItem key={service.id} value={String(service.id || '')}>
                                      {service.name || 'Servico sem nome'}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-8 px-2"
                                onClick={() => handleTransferToService(conversation)}
                                disabled={!transferSelection.serviceId || Boolean(transferringKey)}
                                title="Enviar para servico"
                              >
                                <ArrowRightLeft className="h-3.5 w-3.5" />
                                <span className="sr-only">{isTransferringService ? 'Enviando' : 'Enviar para servico'}</span>
                              </Button>
                            </div>
                            {!assignableUsers.length ? (
                              <p className="text-xs text-muted-foreground">Sem atendente ativo disponivel.</p>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {!filteredServiceConversations.length ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                        Nenhum cliente encontrado nesta fila/serviço.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
