import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import '@fortawesome/fontawesome-free/css/all.min.css';
import { useQueryClient } from '@tanstack/react-query';
import { format, isToday, isYesterday } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { ArrowRightLeft, Building2, Check, CheckCheck, Circle, Pin, Search, SlidersHorizontal, Tag, UserRound } from 'lucide-react';
import { toast } from 'sonner';

import LabelBadge from '@/components/labels/LabelBadge';
import ServiceIconBadge from '@/components/services/ServiceIconBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { saveConversationPreference } from '@/lib/conversation-preferences';
import { assignConversationToUser, requeueConversationForService } from '@/lib/conversation-assignment-api';
import { resolveConversationAssignmentStatus } from '@/lib/conversation-assignment-status';
import { conversationMatchesQueueServiceFilter } from '@/lib/attendance-buckets';
import { buildLabelSummary, conversationHasLabel, toggleConversationCustomLabel } from '@/lib/labels';
import { cn } from '@/lib/utils';
import ContactAvatar from './ContactAvatar';

const priorityConfig = {
  urgent: { label: 'Urgente', class: 'bg-red-500/15 text-red-500 border-red-500/25' },
  high: { label: 'Alta', class: 'bg-amber-500/15 text-amber-500 border-amber-500/25' },
  medium: { label: 'Media', class: 'bg-blue-500/15 text-blue-500 border-blue-500/25' },
  low: { label: 'Baixa', class: 'bg-muted text-muted-foreground border-border' },
};

const TABS = [
  { value: 'all', label: 'Todos' },
  { value: 'unread', label: 'Não lidas' },
  { value: 'queue', label: 'Filas' },
  { value: 'resolved', label: 'Resolvidos' },
];

const ROW_HEIGHT = 96;
const OVERSCAN = 8;

const PAUSE_REASON_OPTIONS = [
  { value: 'lunch', label: 'Saida para almoço' },
  { value: 'end_of_shift', label: 'Final de Expediente' },
];

function formatTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isToday(date)) return format(date, 'HH:mm');
  if (isYesterday(date)) return 'Ontem';
  return format(date, 'dd/MM', { locale: ptBR });
}

function formatScheduleBadge(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';
  return format(date, 'dd/MM HH:mm', { locale: ptBR });
}

function formatPauseRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getConversationDisplayTime(conversation) {
  const candidates = [
    conversation?.last_message_time,
    conversation?.updated_date,
    conversation?.draft_sort_at,
  ]
    .map((value) => ({
      value,
      time: Date.parse(String(value || '')) || 0,
    }))
    .sort((left, right) => right.time - left.time);

  return candidates[0]?.value || '';
}

function getDraftPreview(conversation) {
  const preview = String(conversation?.draft_preview || '').trim();
  return preview || 'Rascunho pendente';
}

function getConversationPreviewText(conversation) {
  const raw = String(conversation?.last_message || '').trim();
  const type = String(conversation?.last_message_type || '').trim().toLowerCase();
  const normalizedRaw = raw.toLowerCase();

  if (type === 'audio' || normalizedRaw === '[audio]') return 'Audio';
  if (type === 'video' || normalizedRaw === '[video]') return 'Video';
  if (type === 'image' || type === 'sticker' || normalizedRaw === '[image]' || normalizedRaw === '[imagem]') {
    return 'Imagem';
  }

  return raw || 'Sem mensagens ainda';
}

function resolvePreviewMeta(conversation) {
  const lastSentAt = Date.parse(String(conversation?.last_sent_at || '')) || 0;
  const lastReceivedAt = Date.parse(String(conversation?.last_received_at || '')) || 0;
  const isOutgoing = lastSentAt > 0 && lastSentAt >= lastReceivedAt;
  const isRead = isOutgoing && lastReceivedAt > 0 && lastReceivedAt >= lastSentAt;
  const hasDeliverySignal = isOutgoing && lastReceivedAt > 0;

  return {
    isOutgoing,
    statusIcon: isOutgoing ? (hasDeliverySignal ? CheckCheck : Check) : null,
    statusClassName: isOutgoing ? (isRead ? 'text-sky-500' : 'text-muted-foreground') : '',
  };
}

function upsertPreferenceInCache(currentPreferences = [], conversationId, patch = {}) {
  const safeConversationId = String(conversationId || '').trim();
  const items = Array.isArray(currentPreferences) ? currentPreferences : [];
  let didUpdate = false;

  const nextItems = items.reduce((acc, preference) => {
    const preferenceConversationId = String(preference?.conversation_id || preference?.conversationId || preference?.id || '').trim();
    if (preferenceConversationId !== safeConversationId) {
      acc.push(preference);
      return acc;
    }

    if (!didUpdate) {
      acc.push({ ...preference, ...patch });
      didUpdate = true;
    }

    return acc;
  }, []);

  if (!didUpdate) {
    return [
      {
        id: safeConversationId,
        conversation_id: safeConversationId,
        is_pinned: false,
        pinned_at: '',
        pinned_by_id: '',
        pinned_by_name: '',
        manual_unread: false,
        manual_unread_at: '',
        manual_unread_by_id: '',
        manual_unread_by_name: '',
        ...patch,
      },
      ...nextItems,
    ];
  }

  return nextItems;
}

export default function ConversationList({
  conversations,
  services = [],
  selectedId,
  onSelect,
  searchTerm,
  onSearchChange,
  primaryFilter,
  onPrimaryFilterChange,
  serviceFilter,
  onServiceFilterChange,
  labelFilter,
  onLabelFilterChange,
  customLabels = [],
  currentUser = null,
  teamUsers = [],
  activeUsers = [],
  allServices = [],
  isLoading = false,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  onOpenStartConversation,
  isQueueDistributionPaused = false,
  queueDistributionPauseRemainingMs = 0,
  queueDistributionPauseReasonLabel = '',
  onPauseQueueDistribution,
  onResumeQueueDistribution,
}) {
  const queryClient = useQueryClient();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const scrollContainerRef = useRef(null);
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [pauseDialogOpen, setPauseDialogOpen] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [selectedPauseReason, setSelectedPauseReason] = useState(PAUSE_REASON_OPTIONS[0].value);
  const currentUserId = String(currentUser?.id || currentUser?.email || 'local-user');
  const currentUserName = String(currentUser?.full_name || currentUser?.name || 'Operador local');
  const isAdminUser =
    String(currentUser?.role || '').trim().toLowerCase() === 'admin' ||
    String(currentUser?.role_name || '').trim().toLowerCase() === 'administrador';
  const visibleTabs = isAdminUser
    ? TABS
    : TABS.filter((tab) => !['queue', 'resolved'].includes(tab.value));
  const nonAdminUsers = useMemo(
    () =>
      (Array.isArray(teamUsers) ? teamUsers : []).filter((user) => {
        const role = String(user?.role || '').trim().toLowerCase();
        const roleName = String(user?.role_name || '').trim().toLowerCase();
        return role !== 'admin' && roleName !== 'administrador';
      }),
    [teamUsers]
  );
  const activeUserIds = useMemo(
    () => new Set((Array.isArray(activeUsers) ? activeUsers : []).map((user) => String(user?.id || '').trim()).filter(Boolean)),
    [activeUsers]
  );

  useEffect(() => {
    const element = scrollContainerRef.current;
    if (!element) return undefined;

    const measure = () => setViewportHeight(element.clientHeight || 640);
    measure();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => measure());
      observer.observe(element);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    if (!isAdminUser && (primaryFilter === 'resolved' || primaryFilter === 'queue')) {
      onPrimaryFilterChange('all');
    }
  }, [isAdminUser, onPrimaryFilterChange, primaryFilter]);

  const filtered = useMemo(() => {
    const normalizedSearch = deferredSearchTerm.trim().toLowerCase();

    return conversations.filter((conversation) => {
      const previewText = conversation.has_draft ? getDraftPreview(conversation) : getConversationPreviewText(conversation);
      const matchSearch =
        !normalizedSearch ||
        conversation.contact_name?.toLowerCase().includes(normalizedSearch) ||
        conversation.contact_phone?.includes(normalizedSearch) ||
        previewText.toLowerCase().includes(normalizedSearch);
      const bucket = String(conversation.attendance_bucket || 'active');
      const matchPrimary =
        primaryFilter === 'resolved'
          ? bucket === 'resolved'
          : primaryFilter === 'queue'
            ? bucket === 'queue'
            : primaryFilter === 'unread'
              ? bucket === 'active' && Boolean(conversation.effective_unread)
              : bucket === 'active';
      const matchService =
        serviceFilter === 'all' ||
        (bucket === 'queue'
          ? conversationMatchesQueueServiceFilter(conversation, serviceFilter)
          : (conversation.accessible_service_ids || []).includes(serviceFilter));
      const matchLabel = conversationHasLabel(conversation, labelFilter);
      return matchSearch && matchPrimary && matchService && matchLabel;
    });
  }, [conversations, deferredSearchTerm, labelFilter, primaryFilter, serviceFilter]);

  const unreadConversationsCount = conversations.filter(
    (conversation) => String(conversation.attendance_bucket || 'active') === 'active' && Boolean(conversation.effective_unread),
  ).length;
  const labelOptions = useMemo(
    () => buildLabelSummary(conversations, customLabels),
    [conversations, customLabels]
  );
  const userPinnedCount = useMemo(
    () =>
      conversations.filter(
        (conversation) => conversation.is_pinned && String(conversation.pinned_by_id || '') === currentUserId
      ).length,
    [conversations, currentUserId]
  );
  const shouldVirtualize = filtered.length > 80;
  const startIndex = shouldVirtualize ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const visibleCount = shouldVirtualize
    ? Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
    : filtered.length;
  const endIndex = shouldVirtualize ? Math.min(filtered.length, startIndex + visibleCount) : filtered.length;
  const visibleConversations = filtered.slice(startIndex, endIndex);

  const handleTogglePinned = async (conversation) => {
    const nextPinned = !conversation.is_pinned;

    if (nextPinned && userPinnedCount >= 4 && !conversation.is_pinned) {
      toast.error('Cada usuario pode fixar ate 4 conversas.');
      return;
    }

    queryClient.setQueryData(['conversation-preferences'], (current = []) =>
      upsertPreferenceInCache(current, conversation.id, {
        is_pinned: nextPinned,
        pinned_at: nextPinned ? new Date().toISOString() : '',
        pinned_by_id: nextPinned ? currentUserId : '',
        pinned_by_name: nextPinned ? currentUserName : '',
      })
    );

    try {
      await saveConversationPreference(conversation.id, {
        is_pinned: nextPinned,
        pinned_at: nextPinned ? new Date().toISOString() : '',
        pinned_by_id: nextPinned ? currentUserId : '',
        pinned_by_name: nextPinned ? currentUserName : '',
      });
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: ['conversation-preferences'] });
      toast.error(error?.message || 'Nao foi possivel atualizar a fixacao da conversa.');
    }
  };

  const handleToggleManualUnread = async (conversation) => {
    const nextManualUnread = !conversation.manual_unread;

    queryClient.setQueryData(['conversation-preferences'], (current = []) =>
      upsertPreferenceInCache(current, conversation.id, {
        manual_unread: nextManualUnread,
        manual_unread_at: nextManualUnread ? new Date().toISOString() : '',
        manual_unread_by_id: nextManualUnread ? currentUserId : '',
        manual_unread_by_name: nextManualUnread ? currentUserName : '',
      })
    );

    try {
      await saveConversationPreference(conversation.id, {
        manual_unread: nextManualUnread,
        manual_unread_at: nextManualUnread ? new Date().toISOString() : '',
        manual_unread_by_id: nextManualUnread ? currentUserId : '',
        manual_unread_by_name: nextManualUnread ? currentUserName : '',
      });
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: ['conversation-preferences'] });
      toast.error(error?.message || 'Nao foi possivel atualizar o status de leitura.');
    }
  };

  const handleToggleCustomLabel = async (conversation, labelId, checked) => {
    try {
      await toggleConversationCustomLabel(conversation.id, labelId, Boolean(checked));
      toast.success(checked ? 'Etiqueta vinculada.' : 'Etiqueta removida.');
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel atualizar a etiqueta.');
    }
  };

  const resolveAssignableUsers = (conversation) => {
    const activeNonAdminUsers = nonAdminUsers.filter((user) => activeUserIds.has(String(user?.id || '').trim()));
    const matchingServiceIds = Array.isArray(conversation?.matching_service_ids) ? conversation.matching_service_ids : [];
    if (matchingServiceIds.length === 0) return activeNonAdminUsers;

    const matchingServices = (Array.isArray(allServices) ? allServices : []).filter((service) =>
      matchingServiceIds.includes(String(service?.id || ''))
    );
    if (matchingServices.length === 0) return activeNonAdminUsers;

    return activeNonAdminUsers.filter((user) => {
      const userId = String(user?.id || '').trim();
      const userEmail = String(user?.email || '').trim().toLowerCase();
      return matchingServices.some((service) => {
        const serviceUserIds = Array.isArray(service?.user_ids) ? service.user_ids.map(String) : [];
        const serviceUserEmails = Array.isArray(service?.user_emails)
          ? service.user_emails.map((email) => String(email || '').trim().toLowerCase())
          : [];
        return (userId && serviceUserIds.includes(userId)) || (userEmail && serviceUserEmails.includes(userEmail));
      });
    });
  };

  const resolveTransferableServices = (conversation) => {
    const currentServiceIds = new Set(
      [
        ...(Array.isArray(conversation?.matching_service_ids) ? conversation.matching_service_ids : []),
        ...(Array.isArray(conversation?.queued_service_ids) ? conversation.queued_service_ids : []),
      ]
        .map((serviceId) => String(serviceId || '').trim())
        .filter(Boolean),
    );

    return (Array.isArray(allServices) ? allServices : [])
      .filter((service) => {
        const serviceId = String(service?.id || '').trim();
        if (!serviceId || currentServiceIds.has(serviceId)) return false;
        const labelIds = Array.isArray(service?.label_ids) ? service.label_ids : service?.labelIds;
        return Array.isArray(labelIds) && labelIds.length > 0;
      })
      .sort((left, right) =>
        String(left?.name || '').localeCompare(String(right?.name || ''), 'pt-BR', { sensitivity: 'base' })
      );
  };

  const handleAssignConversation = async (conversation, user) => {
    try {
      const result = await assignConversationToUser(conversation.id, user.id, {
        sourceConversationIds: conversation.source_conversation_ids,
        matchingServiceIds: conversation.matching_service_ids,
      });
      const assignedConversation = result?.conversation || {};
      queryClient.setQueryData(['conversations', 'attendance'], (current = []) =>
        (Array.isArray(current) ? current : []).map((item) =>
          String(item?.id || '') === String(conversation.id || '')
            ? { ...item, ...assignedConversation }
            : item
        )
      );
      await queryClient.invalidateQueries({ queryKey: ['conversations', 'attendance'] });
      toast.success(`Conversa redirecionada para ${assignedConversation.assigned_agent_name || user.full_name || 'operador'}.`);
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel redirecionar a conversa.');
    }
  };

  const handleSendConversationToQueue = async (conversation) => {
    try {
      const result = await requeueConversationForService(conversation.id, {
        sourceConversationIds: conversation.source_conversation_ids,
        matchingServiceIds: conversation.matching_service_ids,
      });
      const queuedConversation = result?.conversation || {};
      queryClient.setQueryData(['conversations', 'attendance'], (current = []) =>
        (Array.isArray(current) ? current : []).map((item) =>
          String(item?.id || '') === String(conversation.id || '')
            ? { ...item, ...queuedConversation }
            : item
        )
      );
      await queryClient.invalidateQueries({ queryKey: ['conversations', 'attendance'] });
      await queryClient.invalidateQueries({ queryKey: ['presence', 'attending-users'] });
      toast.success('Conversa enviada para a fila do serviço.');
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel enviar a conversa para a fila.');
    }
  };

  const handleTransferConversationToService = async (conversation, service) => {
    const targetServiceId = String(service?.id || '').trim();
    if (!targetServiceId) return;

    try {
      const result = await requeueConversationForService(conversation.id, {
        sourceConversationIds: conversation.source_conversation_ids,
        matchingServiceIds: conversation.matching_service_ids,
        targetServiceId,
      });
      const queuedConversation = result?.conversation || {};
      queryClient.setQueryData(['conversations', 'attendance'], (current = []) =>
        (Array.isArray(current) ? current : []).map((item) =>
          String(item?.id || '') === String(conversation.id || '')
            ? { ...item, ...queuedConversation }
            : item
        )
      );
      await queryClient.invalidateQueries({ queryKey: ['conversations', 'attendance'] });
      await queryClient.invalidateQueries({ queryKey: ['presence', 'attending-users'] });
      toast.success(`Conversa transferida para ${service.name || 'o serviço selecionado'}.`);
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel transferir a conversa para o servico.');
    }
  };

  const handlePauseButtonClick = () => {
    if (isQueueDistributionPaused) {
      setResumeDialogOpen(true);
      return;
    }
    setPauseDialogOpen(true);
  };

  const handleConfirmPauseQueueDistribution = async () => {
    if (!onPauseQueueDistribution) return;
    try {
      await onPauseQueueDistribution(selectedPauseReason);
      setPauseDialogOpen(false);
      const selectedOption = PAUSE_REASON_OPTIONS.find((option) => option.value === selectedPauseReason);
      toast.success(`Distribuição da fila pausada por 10 minutos${selectedOption?.label ? `: ${selectedOption.label}` : '.'}`);
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel pausar a distribuicao da fila.');
    }
  };

  const handleConfirmResumeQueueDistribution = async () => {
    if (!onResumeQueueDistribution) return;
    try {
      await onResumeQueueDistribution();
      setResumeDialogOpen(false);
      toast.success('Pausa removida. Voce pode receber novos clientes da fila.');
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel sair da pausa da fila.');
    }
  };

  return (
    <>
    <div className="chat-panel w-[380px] xl:w-[400px] flex-shrink-0 border-r border-border flex h-full flex-col">
      <div className="chat-header px-4 pt-4 pb-3 border-b border-border space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-inter font-bold text-base text-foreground">Atendimentos</h2>
          <div className="flex items-center gap-2">
            {unreadConversationsCount > 0 && (
              <span className="bg-amber-500 text-white text-[10px] font-bold rounded-full px-2 py-0.5">
                {unreadConversationsCount} não lidas
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onOpenStartConversation?.()}
              title="Iniciar Conversa"
              aria-label="Iniciar Conversa"
            >
              <i className="fa-solid fa-paper-plane text-[14px]" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-8 w-8 relative',
                isQueueDistributionPaused
                  ? 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/15'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={handlePauseButtonClick}
              disabled={!onPauseQueueDistribution || (isQueueDistributionPaused && !onResumeQueueDistribution)}
              title={
                isQueueDistributionPaused
                  ? `Pausa ativa por ${formatPauseRemaining(queueDistributionPauseRemainingMs)}${queueDistributionPauseReasonLabel ? ` - ${queueDistributionPauseReasonLabel}` : ''}`
                  : 'Pausar distribuição da fila por 10 minutos'
              }
              aria-label="Pausa"
            >
              <i className="fa-solid fa-hourglass-half text-[14px]" />
              {isQueueDistributionPaused ? (
                <span className="absolute -right-1 -top-1 rounded-full bg-amber-500 px-1 text-[8px] font-bold leading-3 text-white">
                  {Math.max(1, Math.ceil(queueDistributionPauseRemainingMs / 60000))}
                </span>
              ) : null}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <SlidersHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  onClick={() => onServiceFilterChange('all')}
                  className={serviceFilter === 'all' ? 'bg-accent' : ''}
                >
                  Todos os serviços
                </DropdownMenuItem>
                {services.length ? <DropdownMenuSeparator /> : null}
                {services.map((service) => (
                  <DropdownMenuItem
                    key={service.id}
                    onClick={() => onServiceFilterChange(service.id)}
                    className={serviceFilter === service.id ? 'bg-accent' : ''}
                  >
                    {service.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Buscar conversa ou contato..."
            value={searchTerm}
            onChange={(event) => onSearchChange(event.target.value)}
            className="pl-8 h-9 text-xs bg-muted border-0 focus-visible:ring-1 rounded-full"
          />
        </div>

        <div className="flex gap-0.5 bg-muted rounded-lg p-0.5">
          {visibleTabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => onPrimaryFilterChange(tab.value)}
              className={cn(
                'flex-1 text-[11px] font-medium py-1 rounded-md transition-all',
                primaryFilter === tab.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <Select value={labelFilter} onValueChange={onLabelFilterChange}>
          <SelectTrigger className="h-9 rounded-full border-border bg-background text-xs">
            <SelectValue placeholder="Etiquetas" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as etiquetas</SelectItem>
            {labelOptions.map((label) => (
              <SelectItem key={label.id} value={label.id}>
                {label.name} ({label.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="px-4 py-2 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {filtered.length} conversa{filtered.length !== 1 ? 's' : ''}
        </span>
        {(labelFilter !== 'all' || serviceFilter !== 'all') && (
          <button
            onClick={() => {
              onLabelFilterChange('all');
              onServiceFilterChange('all');
            }}
            className="text-[11px] text-primary hover:underline"
          >
            Limpar filtro
          </button>
        )}
      </div>

      <div
        ref={scrollContainerRef}
        className="attendance-scrollbar flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          setScrollTop(element.scrollTop);
          if (hasMore && !isLoadingMore && element.scrollHeight - element.scrollTop - element.clientHeight < 320) {
            void onLoadMore?.();
          }
        }}
      >
        {isLoading ? (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <div className="h-6 w-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
            <p className="text-sm font-medium">Carregando conversas...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-2">
            <Search className="w-8 h-8 opacity-30" />
            <p className="text-sm">Nenhuma conversa encontrada</p>
          </div>
        ) : (
          <div
            className="relative"
            style={shouldVirtualize ? { height: `${filtered.length * ROW_HEIGHT}px` } : undefined}
          >
            {visibleConversations.map((conversation, index) => {
              const itemIndex = startIndex + index;
              const draftPreview = getDraftPreview(conversation);
              const showDraftIndicator = conversation.has_draft && selectedId !== conversation.id;
              const previewMeta = resolvePreviewMeta(conversation);
              const PreviewStatusIcon = previewMeta.statusIcon;
              const visibleServiceIcons =
                serviceFilter === 'all'
                  ? conversation.accessible_services || []
                  : (conversation.accessible_services || []).filter((service) => service.id === serviceFilter);
              const primaryService = visibleServiceIcons[0] || null;
              const assignmentStatus = resolveConversationAssignmentStatus({
                conversation,
                currentUser,
                users: teamUsers,
                services: allServices,
              });

              return (
                <ContextMenu key={conversation.id}>
                  <ContextMenuTrigger asChild>
                    <button
                      onClick={() => onSelect(conversation)}
                      className={cn(
                        'w-full flex items-start gap-3 px-4 py-3 text-left transition-all border-b border-border/40 hover:bg-muted/40 relative',
                        selectedId === conversation.id && 'bg-primary/8 border-l-[3px] border-l-primary pl-[13px]',
                        shouldVirtualize && 'absolute left-0 right-0 h-[96px]'
                      )}
                      style={shouldVirtualize ? { top: `${itemIndex * ROW_HEIGHT}px` } : undefined}
                    >
                      <div className="relative flex-shrink-0 mt-0.5">
                        <ContactAvatar
                          src={conversation.avatar_url}
                          name={conversation.contact_name}
                          className="w-11 h-11"
                          fallbackClassName="from-primary/70 to-primary"
                          textClassName="text-sm"
                        />
                        {primaryService ? (
                          <ServiceIconBadge
                            service={primaryService}
                            className="absolute -bottom-1 -right-1 h-5 w-5 border-2 border-card shadow-sm"
                            iconClassName="h-3 w-3"
                            title={primaryService.name}
                          />
                        ) : null}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2 mb-0.5">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="font-semibold text-sm text-foreground truncate leading-tight">
                              {conversation.contact_name}
                            </span>
                            {conversation.is_pinned ? (
                              <span
                                className="inline-flex"
                                title={`Fixado por ${conversation.pinned_by_name || 'Operador local'}`}
                              >
                                <Pin className="w-3 h-3 flex-shrink-0 text-primary" />
                              </span>
                            ) : null}
                          </div>
                          <span className="text-[10px] text-muted-foreground flex-shrink-0 mt-0.5">
                            {formatTime(getConversationDisplayTime(conversation))}
                          </span>
                        </div>

                        <div className="mb-1.5 flex items-center gap-1.5">
                          {showDraftIndicator ? (
                            <>
                              <span className="text-xs font-semibold text-destructive">Rascunho</span>
                              <p className="min-w-0 truncate text-xs leading-relaxed text-destructive/90">
                                {draftPreview}
                              </p>
                            </>
                          ) : (
                            <>
                              {PreviewStatusIcon ? (
                                <PreviewStatusIcon className={cn('h-3.5 w-3.5 flex-shrink-0', previewMeta.statusClassName)} />
                              ) : null}
                              <p className="min-w-0 truncate text-xs leading-relaxed text-muted-foreground">
                                {getConversationPreviewText(conversation)}
                              </p>
                            </>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap min-h-5">
                          {conversation.primary_label ? <LabelBadge label={conversation.primary_label} compact /> : null}

                          {conversation.custom_labels?.slice(conversation.primary_label ? 0 : 1, 1).map((label) => (
                            <LabelBadge key={label.id} label={label} compact />
                          ))}

                          {conversation.priority === 'urgent' || conversation.priority === 'high' ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[9px] px-1 py-0 h-3.5 font-semibold leading-none',
                                priorityConfig[conversation.priority]?.class
                              )}
                            >
                              {priorityConfig[conversation.priority]?.label}
                            </Badge>
                          ) : null}

                          {conversation.tags?.slice(0, conversation.primary_label ? 1 : 2).map((tag, tagIndex) => (
                            <Badge
                              key={`${conversation.id}-${tagIndex}`}
                              variant="outline"
                              className="text-[9px] px-1 py-0 h-3.5 leading-none"
                            >
                              {tag}
                            </Badge>
                          ))}

                          <Badge
                            variant="outline"
                            className={cn(
                            'text-[9px] px-1 py-0 h-3.5 leading-none',
                            conversation.is_within_customer_window
                              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700'
                              : 'border-amber-500/25 bg-amber-500/10 text-amber-700'
                          )}
                        >
                          {conversation.is_within_customer_window ? '24h' : 'HSM'}
                        </Badge>

                          {conversation.pending_quick_reply_schedule?.scheduledAt ? (
                            <Badge
                              variant="outline"
                              className="h-3.5 border-primary/25 bg-primary/10 px-1 py-0 text-[9px] leading-none text-primary"
                              title="Cliente possui agendamento pendente"
                            >
                              Agendado {formatScheduleBadge(conversation.pending_quick_reply_schedule.scheduledAt)}
                            </Badge>
                          ) : null}

                          {assignmentStatus?.label ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                'h-3.5 max-w-full px-1 py-0 text-[9px] leading-none',
                                assignmentStatus.badgeClassName
                              )}
                              title={assignmentStatus.detail || 'Status da atribuicao'}
                            >
                              <span className="truncate">{assignmentStatus.label}</span>
                            </Badge>
                          ) : null}

                          {conversation.unread_count > 0 ? (
                            <span className="ml-auto bg-primary text-primary-foreground text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                              {conversation.unread_count}
                            </span>
                          ) : conversation.manual_unread ? (
                            <span
                              className="ml-auto inline-flex items-center"
                              title={`Marcado como nao lida por ${conversation.manual_unread_by_name || 'Operador local'}`}
                            >
                              <Circle className="w-3 h-3 fill-current text-primary" />
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  </ContextMenuTrigger>

                  <ContextMenuContent className="w-64">
                    <ContextMenuLabel>{conversation.contact_name}</ContextMenuLabel>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => void handleTogglePinned(conversation)}>
                      <Pin className="mr-2 h-4 w-4" />
                      {conversation.is_pinned ? 'Desafixar conversa' : 'Fixar conversa'}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => void handleToggleManualUnread(conversation)}>
                      <Circle className="mr-2 h-4 w-4" />
                      {conversation.manual_unread ? 'Marcar como lida' : 'Marcar como nao lida'}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {isAdminUser ? (
                      <>
                        <ContextMenuSub>
                          <ContextMenuSubTrigger inset>
                            <ArrowRightLeft className="mr-2 h-4 w-4" />
                            Transferir atendimento
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent className="w-72">
                            <ContextMenuSub>
                              <ContextMenuSubTrigger>
                                <UserRound className="mr-2 h-4 w-4" />
                                Para agente
                              </ContextMenuSubTrigger>
                              <ContextMenuSubContent className="w-64">
                                {resolveAssignableUsers(conversation).length === 0 ? (
                                  <div className="px-2 py-2 text-xs text-muted-foreground">
                                    Nenhum usuario disponivel para esta fila.
                                  </div>
                                ) : (
                                  resolveAssignableUsers(conversation).map((user) => (
                                    <ContextMenuItem
                                      key={user.id}
                                      onClick={() => void handleAssignConversation(conversation, user)}
                                    >
                                      {user.full_name || user.username || user.email}
                                    </ContextMenuItem>
                                  ))
                                )}
                              </ContextMenuSubContent>
                            </ContextMenuSub>
                            <ContextMenuSub>
                              <ContextMenuSubTrigger>
                                <Building2 className="mr-2 h-4 w-4" />
                                Para serviço
                              </ContextMenuSubTrigger>
                              <ContextMenuSubContent className="w-64">
                                {resolveTransferableServices(conversation).length === 0 ? (
                                  <div className="px-2 py-2 text-xs text-muted-foreground">
                                    Nenhum outro serviço com etiqueta padrão configurada.
                                  </div>
                                ) : (
                                  resolveTransferableServices(conversation).map((service) => (
                                    <ContextMenuItem
                                      key={service.id}
                                      onClick={() => void handleTransferConversationToService(conversation, service)}
                                    >
                                      {service.name}
                                    </ContextMenuItem>
                                  ))
                                )}
                              </ContextMenuSubContent>
                            </ContextMenuSub>
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                        <ContextMenuItem onClick={() => void handleSendConversationToQueue(conversation)}>
                          <Building2 className="mr-2 h-4 w-4" />
                          Enviar para fila atual
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                      </>
                    ) : null}
                    <ContextMenuSub>
                      <ContextMenuSubTrigger inset>
                        <Tag className="mr-2 h-4 w-4" />
                        Etiquetas
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent className="w-72">
                        {conversation.system_label ? (
                          <>
                            <ContextMenuLabel>Automatica</ContextMenuLabel>
                            <ContextMenuCheckboxItem
                              checked
                              onCheckedChange={(checked) => {
                                if (!checked) {
                                  toast.error('A etiqueta padrao e automatica e nao pode ser removida manualmente.');
                                }
                              }}
                            >
                              {conversation.system_label.name}
                            </ContextMenuCheckboxItem>
                            <ContextMenuSeparator />
                          </>
                        ) : null}

                        <ContextMenuLabel>Personalizadas</ContextMenuLabel>
                        {customLabels.length === 0 ? (
                          <div className="px-2 py-2 text-xs text-muted-foreground">
                            Nenhuma etiqueta personalizada cadastrada.
                          </div>
                        ) : (
                          customLabels.map((label) => (
                            <ContextMenuCheckboxItem
                              key={label.id}
                              checked={Boolean(conversation.custom_labels?.some((item) => item.id === label.id))}
                              onCheckedChange={(checked) =>
                                handleToggleCustomLabel(conversation, label.id, checked)
                              }
                            >
                              {label.name}
                            </ContextMenuCheckboxItem>
                          ))
                        )}
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        )}
        {isLoadingMore ? (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            Carregando mais conversas...
          </div>
        ) : null}
      </div>
    </div>

    <Dialog open={pauseDialogOpen} onOpenChange={setPauseDialogOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pausar distribuição da fila</DialogTitle>
          <DialogDescription>
            Selecione o motivo da pausa. Durante 10 minutos voce continua atendendo seus clientes atuais, mas nao recebe novos clientes da fila.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {PAUSE_REASON_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setSelectedPauseReason(option.value)}
              className={cn(
                'flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors',
                selectedPauseReason === option.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background hover:bg-secondary/60'
              )}
            >
              <span className="text-sm font-medium">{option.label}</span>
              <span
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full border',
                  selectedPauseReason === option.value ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                )}
              >
                {selectedPauseReason === option.value ? <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" /> : null}
              </span>
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setPauseDialogOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={handleConfirmPauseQueueDistribution}>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={resumeDialogOpen} onOpenChange={setResumeDialogOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sair da pausa?</DialogTitle>
          <DialogDescription>
            Voce deseja sair da pausa? Com a confirmação, voce volta a receber novos clientes da fila.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={() => setResumeDialogOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={handleConfirmResumeQueueDistribution}>
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
