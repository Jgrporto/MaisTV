import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, ExternalLink, Loader2, MessageCircle, Megaphone, Plus, RefreshCw, Repeat2, Search, Tags, Trash2, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import PageHeader from '@/components/layout/PageHeader';
import PageSectionCard from '@/components/layout/PageSectionCard';
import PageShell from '@/components/layout/PageShell';
import RoutineCard from '@/components/routines/RoutineCard';
import RoutineForm from '@/components/routines/RoutineForm';
import RoutineRunPreviewDialog from '@/components/routines/RoutineRunPreviewDialog';
import StatsHeader from '@/components/routines/StatsHeader';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ROUTINE_TYPES, formatDateTime, getTemplateLanguage, getTemplateName, normalizeText } from '@/components/routines/utils';
import { fetchAllPersistedCustomers } from '@/lib/customer-sync-api';
import { fetchLocalHsms } from '@/lib/hsm-api';
import { SYSTEM_LABELS, useLabelCatalog } from '@/lib/labels';
import { listQuickReplies } from '@/lib/quick-replies';
import {
  clearRoutineLogs,
  createRoutine,
  deleteRoutine,
  fetchRoutineLogs,
  fetchRoutines,
  previewRoutine,
  retryRoutineFailedRun,
  runRoutineManually,
  updateRoutine,
} from '@/lib/routines-api';
import { buildLocalApiUrl } from '@/lib/local-api';
import { CONVERSATION_BACKGROUND_SUMMARY_LIMIT } from '@/lib/performance-config';
import { queryClientInstance } from '@/lib/query-client';
import { fetchWhatsappConversations, fetchWhatsappHistoryMessages, fetchWhatsappMessages } from '@/lib/whatsapp-api';

const getRoutineTypeFromLog = (log = {}) => {
  const raw = String(log.routineType || log.type || log.details?.routineType || log.details?.type || '').trim();
  if (raw === 'etiqueta' || raw === 'follow_up' || raw === 'disparo') return raw;
  const text = normalizeText(`${log.routineName || ''} ${log.message || ''}`);
  if (text.includes('follow up')) return 'follow_up';
  if (text.includes('etiqueta')) return 'etiqueta';
  return 'disparo';
};

const getDurationText = (durationMs) => {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  if (!totalSeconds) return '-';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`;
};

const getLogRunStatus = (entries = [], summary = {}) => {
  const statuses = entries.map((entry) => String(entry.status || '').toLowerCase());
  const hasRunning = statuses.some((status) => ['running', 'queued'].includes(status));
  const hasFinalSummary = Boolean(summary?.finishedAt || entries.some((entry) => entry.summary?.finishedAt || /finalizada|finalizado|conclu/i.test(entry.message || '')));
  if (hasRunning && !hasFinalSummary) return 'running';

  const success = Number(summary.sent || summary.changed || 0);
  const failed = Number(summary.failed || 0);
  const ignored = Number(summary.ignored ?? summary.skipped ?? 0);
  if (failed > 0 && success > 0) return 'partial';
  if (failed > 0 && success === 0) return 'failed';
  if (ignored > 0 && success > 0) return 'partial';
  if (statuses.includes('error')) return 'failed';
  if (statuses.includes('warning')) return success > 0 ? 'partial' : 'failed';
  return hasFinalSummary || statuses.includes('success') ? 'success' : 'running';
};

const buildOperationalRuns = (logs = []) => {
  const groups = new Map();
  logs.forEach((entry, index) => {
    const key = entry.runId ? `run-${entry.runId}` : `legacy-${entry.id || index}`;
    const current = groups.get(key) || {
      id: key,
      runId: entry.runId || null,
      routineId: entry.routineId || null,
      routineName: entry.routineName || 'Rotina',
      type: getRoutineTypeFromLog(entry),
      entries: [],
    };
    current.entries.push(entry);
    current.routineId = current.routineId || entry.routineId || null;
    current.routineName = current.routineName || entry.routineName || 'Rotina';
    current.type = current.type || getRoutineTypeFromLog(entry);
    groups.set(key, current);
  });

  return Array.from(groups.values()).map((run) => {
    const entries = run.entries.slice().sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
    const summaryEntry = entries.find((entry) => entry.summary?.finishedAt) || entries.find((entry) => entry.summary) || entries[entries.length - 1] || {};
    const summary = summaryEntry.summary || {};
    const startedAt = summary.startedAt || entries[0]?.createdAt || null;
    const finishedAt = summary.finishedAt || (getLogRunStatus(entries, summary) === 'running' ? null : entries[entries.length - 1]?.createdAt);
    const durationMs =
      Number(summary.durationMs) ||
      (startedAt && finishedAt ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()) : 0);
    const successTotal = Number(summary.sent ?? summary.changed ?? entries.filter((entry) => String(entry.status).toLowerCase() === 'success').length);
    const failedTotal = Number(summary.failed ?? entries.filter((entry) => String(entry.status).toLowerCase() === 'error').length);
    const ignoredTotal = Number(summary.ignored ?? summary.skipped ?? entries.filter((entry) => ['skipped', 'warning'].includes(String(entry.status).toLowerCase())).length);
    const processedTotal = Number(summary.total ?? successTotal + failedTotal + ignoredTotal);

    return {
      ...run,
      entries,
      summary,
      status: getLogRunStatus(entries, summary),
      startedAt,
      finishedAt,
      durationMs,
      processedTotal,
      successTotal,
      failedTotal,
      ignoredTotal,
    };
  });
};

const logStatusConfig = {
  running: {
    label: 'Em execução',
    className: 'border-primary/40 bg-primary/10 text-primary',
    cardClassName: 'border-primary/30 bg-primary/5',
  },
  success: {
    label: 'Sucesso',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
    cardClassName: 'border-emerald-500/20 bg-emerald-500/5',
  },
  partial: {
    label: 'Parcial',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
    cardClassName: 'border-amber-500/25 bg-amber-500/5',
  },
  failed: {
    label: 'Falha',
    className: 'border-destructive/30 bg-destructive/10 text-destructive',
    cardClassName: 'border-destructive/25 bg-destructive/10',
  },
};

const categorizeRunEntries = (entries = []) => ({
  success: entries.filter((entry) => String(entry.status || '').toLowerCase() === 'success'),
  failed: entries.filter((entry) => String(entry.status || '').toLowerCase() === 'error'),
  ignored: entries.filter((entry) => ['skipped', 'warning'].includes(String(entry.status || '').toLowerCase()) || /ignorado|inválido|invalido/i.test(entry.message || '')),
  technical: entries.filter((entry) => !['success', 'error', 'skipped', 'warning'].includes(String(entry.status || '').toLowerCase()) && !/ignorado|inválido|invalido/i.test(entry.message || '')),
});

const getLogEntryLine = (entry = {}) => {
  const details = entry.details || {};
  const subject = details.customerName || details.customerId || details.phone || entry.customerId || entry.phone || '';
  return [subject, entry.message || 'Evento de rotina.', formatDateTime(entry.createdAt)].filter(Boolean).join(' | ');
};

const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');

const getCustomerDisplayName = (customer = {}) =>
  String(customer.display_name || customer.name || customer.username || customer.raw?.nome || customer.raw?.name || '').trim();

const getEntryCustomerMeta = (entry = {}) => {
  const details = entry.details || {};
  const customerId = String(entry.customerId || details.customerId || details.customer_id || details.conversationId || '').trim();
  const phone = normalizePhoneDigits(entry.phone || details.phone || details.customerPhone || details.whatsapp || '');
  const name = String(details.customerName || details.customer || details.name || '').trim();
  if (!customerId && !phone && !name) return null;
  return { customerId, phone, name };
};

const buildCustomerLookups = (customers = [], conversations = []) => {
  const byId = new Map();
  const byPhone = new Map();
  const conversationById = new Map();
  const conversationByPhone = new Map();

  customers.forEach((customer) => {
    const id = String(customer?.id || '').trim();
    const phone = normalizePhoneDigits(customer?.whatsapp || customer?.phone_digits || customer?.raw?.telefone || customer?.raw?.phone || '');
    if (id) byId.set(id, customer);
    if (phone) byPhone.set(phone, customer);
  });

  conversations.forEach((conversation) => {
    const ids = [
      conversation?.id,
      conversation?.aggregate_conversation_id,
      ...(Array.isArray(conversation?.source_conversation_ids) ? conversation.source_conversation_ids : []),
    ].map((id) => String(id || '').trim()).filter(Boolean);
    const phone = normalizePhoneDigits(conversation?.contact_phone || conversation?.customer?.phone || conversation?.phone || '');
    ids.forEach((id) => conversationById.set(id, conversation));
    if (phone) conversationByPhone.set(phone, conversation);
  });

  return { byId, byPhone, conversationById, conversationByPhone };
};

const buildAffectedCustomers = (run = {}, lookups) => {
  const itemsByKey = new Map();
  (run.entries || []).forEach((entry) => {
    const meta = getEntryCustomerMeta(entry);
    if (!meta) return;
    const customer = (meta.customerId && lookups.byId.get(meta.customerId)) || (meta.phone && lookups.byPhone.get(meta.phone)) || null;
    const conversation =
      (meta.customerId && lookups.conversationById.get(meta.customerId)) ||
      (meta.phone && lookups.conversationByPhone.get(meta.phone)) ||
      null;
    const phone = meta.phone || normalizePhoneDigits(customer?.whatsapp || customer?.phone_digits || conversation?.contact_phone || conversation?.customer?.phone || '');
    const key = meta.customerId || phone || meta.name || entry.id;
    const current = itemsByKey.get(key) || {
      key,
      customerId: meta.customerId || customer?.id || '',
      conversationId: conversation?.id || meta.customerId || '',
      phone,
      name: meta.name || getCustomerDisplayName(customer) || conversation?.contact_name || phone || 'Cliente',
      status: 'info',
      messages: [],
      entryIds: [],
      conversation,
    };
    const status = String(entry.status || '').toLowerCase();
    if (status === 'error') current.status = 'error';
    else if (['success', 'skipped', 'warning', 'running'].includes(status) && current.status !== 'error') current.status = status;
    current.messages.push(entry.message || 'Evento de rotina.');
    current.entryIds.push(entry.id);
    current.conversation = current.conversation || conversation;
    itemsByKey.set(key, current);
  });
  return Array.from(itemsByKey.values());
};

const customerStatusConfig = {
  success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700',
  error: 'border-destructive/25 bg-destructive/10 text-destructive',
  warning: 'border-amber-500/25 bg-amber-500/10 text-amber-700',
  skipped: 'border-amber-500/25 bg-amber-500/10 text-amber-700',
  running: 'border-primary/25 bg-primary/10 text-primary',
  info: 'border-border bg-muted/40 text-muted-foreground',
};

const customerStatusLabel = {
  success: 'Sucesso',
  error: 'Falha',
  warning: 'Aviso',
  skipped: 'Ignorado',
  running: 'Em execução',
  info: 'Info',
};

const formatMessageTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
};

function CustomerConversationPreviewDialog({ customer, open, onClose, onOpenConversation }) {
  const conversation = customer?.conversation || null;
  const conversationId = String(conversation?.id || customer?.conversationId || '').trim();
  const phone = customer?.phone || '';

  const messagesQuery = useQuery({
    queryKey: ['routines', 'customer-conversation-preview', conversationId, phone],
    enabled: open && Boolean(conversationId || phone),
    queryFn: async () => {
      if (conversation?.id) {
        const recentMessages = await fetchWhatsappMessages(conversation.id, {
          tail: 40,
          conversationIds: conversation.source_conversation_ids,
          sourceAccounts: conversation.source_accounts,
        });
        if (recentMessages.length > 0) return recentMessages;
      }
      const historyResult = await fetchWhatsappHistoryMessages(conversation || { id: conversationId, contact_phone: phone, customer: { phone } }, {
        tail: 40,
        windowDays: 30,
      });
      return Array.isArray(historyResult?.messages) ? historyResult.messages : [];
    },
    staleTime: 15000,
    refetchOnWindowFocus: false,
  });

  const messages = Array.isArray(messagesQuery.data) ? messagesQuery.data : [];

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{customer?.name || 'Cliente'}</DialogTitle>
          <DialogDescription>{phone ? `Histórico do WhatsApp ${phone}` : 'Histórico do cliente'}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[420px] overflow-y-auto rounded-md border border-border bg-muted/20 p-3">
          {messagesQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando histórico...
            </div>
          ) : messages.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Nenhuma mensagem encontrada para este cliente.</div>
          ) : (
            <div className="space-y-2">
              {messages.map((message) => {
                const isClient = String(message.sender_type || '').toLowerCase() === 'client';
                return (
                  <div key={message.id || message.message_key || `${message.created_date}-${message.content}`} className={`flex ${isClient ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[82%] rounded-lg border px-3 py-2 text-sm shadow-sm ${isClient ? 'border-border bg-background text-foreground' : 'border-primary/20 bg-primary/10 text-foreground'}`}>
                      <div className="mb-1 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
                        <span>{isClient ? 'Cliente' : message.sender_name || 'Atendimento'}</span>
                        <span>{formatMessageTime(message.created_date || message.timestamp)}</span>
                      </div>
                      <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content || `[${message.message_type || 'mensagem'}]`}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted">
            Fechar
          </button>
          <button type="button" onClick={() => onOpenConversation(customer)} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            <ExternalLink className="h-4 w-4" />
            Ir para conversa
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Rotinas() {
  const navigate = useNavigate();
  const [editingRoutine, setEditingRoutine] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [createTypeOpen, setCreateTypeOpen] = useState(false);
  const [initialRoutineType, setInitialRoutineType] = useState('disparo');
  const [search, setSearch] = useState('');
  const [liveLogs, setLiveLogs] = useState([]);
  const [runningRoutineIds, setRunningRoutineIds] = useState(() => new Set());
  const [runPreviewRoutine, setRunPreviewRoutine] = useState(null);
  const [runPreviewData, setRunPreviewData] = useState(null);
  const [selectedLog, setSelectedLog] = useState(null);
  const [selectedCustomerPreview, setSelectedCustomerPreview] = useState(null);
  const [logsCleared, setLogsCleared] = useState(false);
  const logPanelRef = useRef(null);
  const { customLabels } = useLabelCatalog();

  const routinesQuery = useQuery({
    queryKey: ['routines'],
    queryFn: fetchRoutines,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const logsQuery = useQuery({
    queryKey: ['routines', 'logs'],
    queryFn: () => fetchRoutineLogs({ limit: 120 }),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const hsmsQuery = useQuery({
    queryKey: ['hsm', 'local'],
    queryFn: fetchLocalHsms,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const customersQuery = useQuery({
    queryKey: ['customers', 'persisted', 'routines'],
    queryFn: fetchAllPersistedCustomers,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const conversationsQuery = useQuery({
    queryKey: ['conversations', 'routines-log-preview', 'summary', CONVERSATION_BACKGROUND_SUMMARY_LIMIT],
    queryFn: () => fetchWhatsappConversations({ summary: true, limit: CONVERSATION_BACKGROUND_SUMMARY_LIMIT }),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const quickRepliesQuery = useQuery({
    queryKey: ['quick-replies', 'routines'],
    queryFn: listQuickReplies,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const routines = routinesQuery.data?.items || [];
  const templates = hsmsQuery.data?.items || [];
  const customers = customersQuery.data?.rows || [];
  const conversations = conversationsQuery.data || [];
  const quickReplies = quickRepliesQuery.data || [];
  const labels = useMemo(() => [...SYSTEM_LABELS, ...customLabels], [customLabels]);
  useEffect(() => {
    setLiveLogs(logsQuery.data?.logs || []);
  }, [logsQuery.data?.logs]);

  useEffect(() => {
    const source = new EventSource(buildLocalApiUrl('/routines/logs/stream'), { withCredentials: true });
    source.addEventListener('log', (event) => {
      try {
        const entry = JSON.parse(event.data || '{}');
        setLiveLogs((current) => {
          if (!entry?.id || current.some((item) => item.id === entry.id)) return current;
          return [entry, ...current].slice(0, 200);
        });
        if (entry?.routineId && ['success', 'error', 'warning'].includes(entry.status) && /finalizada|apagada|atualizada|criada/i.test(entry.message || '')) {
          setRunningRoutineIds((current) => {
            const next = new Set(current);
            next.delete(entry.routineId);
            return next;
          });
        }
      } catch {
        // SSE payload malformed; ignore this event without interrupting the UI.
      }
    });
    source.onerror = () => {};
    return () => source.close();
  }, []);

  useEffect(() => {
    logPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [liveLogs.length]);

  const logs = liveLogs;
  const operationalRuns = useMemo(() => buildOperationalRuns(logs), [logs]);
  const customerLookups = useMemo(() => buildCustomerLookups(customers, conversations), [customers, conversations]);
  const sampleCustomer = customers[0] || {};
  const selectedLogDetails =
    selectedLog?.entries?.length
      ? JSON.stringify(selectedLog.entries.map((entry) => ({ id: entry.id, status: entry.status, message: entry.message, createdAt: entry.createdAt, details: entry.details, summary: entry.summary })), null, 2)
      : selectedLog?.details && Object.keys(selectedLog.details).length > 0
        ? JSON.stringify(selectedLog.details, null, 2)
        : selectedLog?.summary
          ? JSON.stringify(selectedLog.summary, null, 2)
        : '';
  const selectedRunFailedCount = useMemo(() => {
    if (!selectedLog?.runId) return 0;
    const failedIds = new Set();
    (selectedLog.entries || liveLogs).forEach((entry) => {
      if (entry?.runId !== selectedLog.runId) return;
      if (String(entry?.status || '').toLowerCase() !== 'error') return;
      const customerId = String(entry?.customerId || entry?.details?.customerId || '').trim();
      if (customerId) failedIds.add(customerId);
    });
    return failedIds.size || Number(selectedLog?.summary?.failed || selectedLog?.failedTotal || 0);
  }, [liveLogs, selectedLog]);
  const canRetrySelectedLog = Boolean(selectedLog?.routineId && selectedLog?.runId && selectedRunFailedCount > 0);
  const selectedAffectedCustomers = useMemo(
    () => (selectedLog ? buildAffectedCustomers(selectedLog, customerLookups) : []),
    [customerLookups, selectedLog],
  );
  const selectedLogCategories = useMemo(
    () => (selectedLog ? categorizeRunEntries(selectedLog.entries || []) : { success: [], failed: [], ignored: [], technical: [] }),
    [selectedLog],
  );

  const templateById = useMemo(() => {
    const map = new Map();
    templates.forEach((template) => {
      map.set(String(template.id || template.code || ''), template);
      map.set(`${getTemplateName(template)}::${getTemplateLanguage(template)}`, template);
    });
    return map;
  }, [templates]);

  const filteredRoutines = useMemo(() => {
    const normalizedSearch = normalizeText(search);
    if (!normalizedSearch) return routines;
    return routines.filter((routine) =>
      normalizeText([routine.name, routine.type, routine.status, routine.templateName, routine.hsm?.templateName].join(' ')).includes(normalizedSearch),
    );
  }, [routines, search]);

  const saveMutation = useMutation({
    mutationFn: (payload) => (payload.id ? updateRoutine(payload.id, payload) : createRoutine(payload)),
    onSuccess: () => {
      toast.success('Rotina salva.');
      setFormOpen(false);
      setEditingRoutine(null);
      queryClientInstance.invalidateQueries({ queryKey: ['routines'] });
    },
    onError: (error) => toast.error(error?.message || 'Falha ao salvar rotina.'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ routine, nextStatus }) =>
      updateRoutine(routine.id, {
        ...routine,
        status: nextStatus,
      }),
    onMutate: async ({ routine, nextStatus }) => {
      await queryClientInstance.cancelQueries({ queryKey: ['routines'] });
      const previousRoutines = queryClientInstance.getQueryData(['routines']);

      queryClientInstance.setQueryData(['routines'], (current) => {
        if (!current?.items) return current;
        return {
          ...current,
          items: current.items.map((item) =>
            item.id === routine.id
              ? {
                  ...item,
                  status: nextStatus,
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
        };
      });

      return { previousRoutines };
    },
    onSuccess: (updatedRoutine) => {
      queryClientInstance.setQueryData(['routines'], (current) => {
        if (!current?.items) return current;
        return {
          ...current,
          items: current.items.map((item) => (item.id === updatedRoutine.id ? updatedRoutine : item)),
        };
      });
      toast.success(updatedRoutine.status === 'active' ? 'Rotina ativada.' : 'Rotina inativada.');
    },
    onError: (error, _variables, context) => {
      if (context?.previousRoutines) {
        queryClientInstance.setQueryData(['routines'], context.previousRoutines);
      }
      toast.error(error?.message || 'Falha ao alterar status da rotina.');
    },
    onSettled: () => {
      queryClientInstance.invalidateQueries({ queryKey: ['routines'] });
      queryClientInstance.invalidateQueries({ queryKey: ['routines', 'logs'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteRoutine,
    onSuccess: () => {
      toast.success('Rotina excluída.');
      queryClientInstance.invalidateQueries({ queryKey: ['routines'] });
      queryClientInstance.invalidateQueries({ queryKey: ['routines', 'logs'] });
    },
    onError: (error) => toast.error(error?.message || 'Falha ao excluir rotina.'),
  });

  const runPreviewMutation = useMutation({
    mutationFn: (routine) => previewRoutine(routine.id, routine),
    onSuccess: (data) => setRunPreviewData(data),
    onError: (error) => toast.error(error?.message || 'Falha ao calcular clientes afetados.'),
  });

  const manualRunMutation = useMutation({
    mutationFn: ({ routineId, payload }) => runRoutineManually(routineId, payload),
    onMutate: ({ routineId }) => {
      setRunningRoutineIds((current) => new Set(current).add(routineId));
    },
    onSuccess: (result, { routineId }) => {
      if (result?.queued) {
        toast.success('Envio manual enfileirado. Acompanhe o progresso no log operacional.');
      } else {
        toast.success(`Envio manual finalizado: ${result?.summary?.sent || 0} enviado(s).`);
        setRunningRoutineIds((current) => {
          const next = new Set(current);
          next.delete(routineId);
          return next;
        });
      }
      setRunPreviewRoutine(null);
      setRunPreviewData(null);
      queryClientInstance.invalidateQueries({ queryKey: ['routines'] });
      queryClientInstance.invalidateQueries({ queryKey: ['routines', 'logs'] });
    },
    onError: (error, { routineId }) => {
      setRunningRoutineIds((current) => {
        const next = new Set(current);
        next.delete(routineId);
        return next;
      });
      toast.error(error?.status === 409 ? 'Essa rotina já está em execução.' : error?.message || 'Falha no envio manual.');
    },
  });

  const retryFailedRunMutation = useMutation({
    mutationFn: ({ routineId, runId }) => retryRoutineFailedRun(routineId, runId),
    onMutate: ({ routineId }) => {
      setRunningRoutineIds((current) => new Set(current).add(routineId));
    },
    onSuccess: (result, { routineId }) => {
      if (result?.queued) {
        toast.success(`Reenvio enfileirado para ${result?.customerCount || 0} cliente(s) com falha.`);
      } else {
        toast.success('Reenvio das falhas concluido.');
        setRunningRoutineIds((current) => {
          const next = new Set(current);
          next.delete(routineId);
          return next;
        });
      }
      queryClientInstance.invalidateQueries({ queryKey: ['routines'] });
      queryClientInstance.invalidateQueries({ queryKey: ['routines', 'logs'] });
      setSelectedLog(null);
    },
    onError: (error, { routineId }) => {
      setRunningRoutineIds((current) => {
        const next = new Set(current);
        next.delete(routineId);
        return next;
      });
      toast.error(error?.status === 409 ? 'Essa rotina já está em execução.' : error?.message || 'Falha ao reenviar clientes com erro.');
    },
  });

  const clearLogsMutation = useMutation({
    mutationFn: clearRoutineLogs,
    onSuccess: (result) => {
      const remainingLogs = liveLogs.filter((entry) => {
        const run = operationalRuns.find((item) => item.entries.some((runEntry) => runEntry.id === entry.id));
        return run?.status === 'running';
      });
      setLiveLogs(remainingLogs);
      setLogsCleared(true);
      queryClientInstance.invalidateQueries({ queryKey: ['routines', 'logs'] });
      toast.success(`Logs limpos. ${result?.kept || remainingLogs.length} registro(s) em execução mantido(s).`);
      window.setTimeout(() => setLogsCleared(false), 1800);
    },
    onError: (error) => toast.error(error?.message || 'Falha ao limpar logs.'),
  });

  const openCreateForm = (type = 'disparo') => {
    setEditingRoutine(null);
    setInitialRoutineType(type);
    setCreateTypeOpen(false);
    setFormOpen(true);
  };

  const openEditForm = (routine) => {
    setEditingRoutine(routine);
    setFormOpen(true);
  };

  const openRunPreview = (routine) => {
    setRunPreviewRoutine(routine);
    setRunPreviewData(null);
    runPreviewMutation.mutate(routine);
  };

  const toggleRoutine = (routine) => {
    toggleMutation.mutate({
      routine,
      nextStatus: routine.status === 'active' ? 'inactive' : 'active',
    });
  };

  const refreshAll = () => {
    queryClientInstance.invalidateQueries({ queryKey: ['routines'] });
    queryClientInstance.invalidateQueries({ queryKey: ['routines', 'logs'] });
    queryClientInstance.invalidateQueries({ queryKey: ['hsm', 'local'] });
  };

  const clearLogsFromPersistence = () => {
    clearLogsMutation.mutate();
  };

  const openFullConversation = (customer) => {
    const conversation = customer?.conversation || null;
    navigate('/', {
      state: {
        openConversation: {
          conversationId: conversation?.id || customer?.conversationId || '',
          sourceConversationIds: conversation?.source_conversation_ids || [],
          customerId: customer?.customerId || '',
          phone: customer?.phone || '',
        },
      },
    });
  };

  return (
    <PageShell>
      <PageHeader
        title="Rotinas"
        description="Gerencie rotinas de disparo e rotinas de etiqueta."
        actions={
          <button type="button" onClick={() => setCreateTypeOpen(true)} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
            <Plus className="h-4 w-4" />
            Nova Rotina
          </button>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
        <div className="min-w-0 space-y-5">
          <StatsHeader routines={routines} />

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar rotinas..."
          className="w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-primary"
        />
      </div>

        <PageSectionCard className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-foreground">Rotinas cadastradas</h2>
            <span className="text-sm text-muted-foreground">{filteredRoutines.length} registro(s)</span>
          </div>

          {routinesQuery.isLoading ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Carregando rotinas...</div>
          ) : filteredRoutines.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Nenhuma rotina encontrada.</div>
          ) : (
            <div className="space-y-4">
              {filteredRoutines.map((routine) => {
                const template =
                  templateById.get(String(routine.hsm?.templateId || routine.templateId || '')) ||
                  templateById.get(`${routine.hsm?.templateName || routine.templateName}::${routine.hsm?.language || routine.templateLanguage}`);
                return (
                  <RoutineCard
                    key={routine.id}
                    routine={routine}
                    templateName={template ? getTemplateName(template) : routine.hsm?.templateName || routine.templateName}
                    labels={labels}
                    isRunning={runningRoutineIds.has(routine.id)}
                    isToggling={toggleMutation.isPending && toggleMutation.variables?.routine?.id === routine.id}
                    onEdit={() => openEditForm(routine)}
                    onDelete={() => {
                      if (window.confirm('Deseja apagar esta rotina? Essa ação não pode ser desfeita.')) {
                        deleteMutation.mutate(routine.id);
                      }
                    }}
                    onRun={() => openRunPreview(routine)}
                    onToggle={() => toggleRoutine(routine)}
                  />
                );
              })}
            </div>
          )}
        </PageSectionCard>
        </div>

        <PageSectionCard className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <h2 className="text-lg font-semibold text-foreground">Log operacional</h2>
            <div className="flex items-center gap-2">
              {logsCleared ? (
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Limpo
                </span>
              ) : null}
              <button type="button" onClick={clearLogsFromPersistence} disabled={clearLogsMutation.isPending} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-wait disabled:opacity-60">
                {clearLogsMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {clearLogsMutation.isPending ? 'Limpando' : 'Limpar'}
              </button>
              <button type="button" onClick={refreshAll} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                <RefreshCw className="h-3.5 w-3.5" />
                Atualizar
              </button>
            </div>
          </div>
          <div ref={logPanelRef} className="max-h-[680px] space-y-3 overflow-y-auto p-4">
            <p className="px-1 text-xs leading-relaxed text-muted-foreground">Execuções agrupadas por rotina. Abra um card para ver sucessos, falhas, ignorados e eventos técnicos.</p>
            {operationalRuns.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">Nenhum log de rotina registrado.</div>
            ) : (
              operationalRuns.map((run) => {
                const config = logStatusConfig[run.status] || logStatusConfig.running;
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => setSelectedLog(run)}
                    className={`block w-full rounded-lg border p-3 text-left text-sm transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/30 ${config.cardClassName}`}
                  >
                    <div className="block w-full text-left">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate font-semibold text-foreground">{run.routineName || 'Rotina'}</h3>
                          <p className="mt-1 text-xs text-muted-foreground">{ROUTINE_TYPES[run.type] || 'Rotina'}</p>
                        </div>
                        <span className={`inline-flex shrink-0 rounded-full border px-2 py-1 text-[11px] font-medium leading-none ${config.className}`}>{config.label}</span>
                      </div>

                      <div className="mt-3 grid gap-1.5 text-xs text-muted-foreground">
                        <span>Início: <strong className="font-medium text-foreground">{formatDateTime(run.startedAt)}</strong></span>
                        <span>Fim: <strong className="font-medium text-foreground">{formatDateTime(run.finishedAt)}</strong></span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          Duração: <strong className="font-medium text-foreground">{getDurationText(run.durationMs)}</strong>
                        </span>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 xl:grid-cols-2">
                        <span className="rounded-md border border-border/70 bg-background/70 px-2 py-1">Processados: <strong>{run.processedTotal}</strong></span>
                        <span className="rounded-md border border-border/70 bg-background/70 px-2 py-1">Sucesso: <strong>{run.successTotal}</strong></span>
                        <span className="rounded-md border border-border/70 bg-background/70 px-2 py-1">Falhas: <strong>{run.failedTotal}</strong></span>
                        <span className="rounded-md border border-border/70 bg-background/70 px-2 py-1">Ignorados: <strong>{run.ignoredTotal}</strong></span>
                      </div>

                      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">
                        <MessageCircle className="h-3.5 w-3.5" />
                        Abrir detalhes
                      </span>
                    </div>

                    {/*
                      <div className="mt-3 space-y-3 border-t border-border pt-3">
                        <div className="rounded-md border border-border bg-background/70 p-2 text-xs text-muted-foreground">
                          <div className="font-semibold uppercase tracking-[0.12em] text-foreground">Resumo</div>
                          <div className="mt-2 grid gap-1">
                            <span>ID da execução: <strong className="break-all text-foreground">{run.runId || run.id}</strong></span>
                            <span>Status final: <strong className="text-foreground">{config.label}</strong></span>
                            <span>Origem: <strong className="text-foreground">{run.entries.some((entry) => /manual/i.test(entry.message || '')) ? 'Manual' : 'Automática'}</strong></span>
                          </div>
                        </div>

                        {[
                          ['Sucessos', categories.success],
                          ['Falhas', categories.failed],
                          ['Ignorados', categories.ignored],
                          ['Eventos técnicos', categories.technical],
                        ].map(([title, items]) => (
                          <div key={title} className="rounded-md border border-border bg-background/70 p-2">
                            <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-foreground">
                              <span>{title}</span>
                              <span className="text-muted-foreground">{items.length}</span>
                            </div>
                            {items.length ? (
                              <div className="space-y-1.5">
                                {items.slice(0, 8).map((entry) => (
                                  <div key={entry.id} className="rounded border border-border/70 bg-card px-2 py-1.5 text-xs text-muted-foreground">
                                    {getLogEntryLine(entry)}
                                  </div>
                                ))}
                                {items.length > 8 ? <div className="text-xs text-muted-foreground">+ {items.length - 8} item(ns) no detalhe técnico.</div> : null}
                              </div>
                            ) : (
                              <div className="text-xs text-muted-foreground">Nenhum registro nesta categoria.</div>
                            )}
                          </div>
                        ))}

                        <button type="button" onClick={() => setSelectedLog(run)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                          <Info className="h-3.5 w-3.5" />
                          Abrir detalhe técnico
                        </button>
                      </div>
                    */}
                  </button>
                );
              })
            )}
          </div>
        </PageSectionCard>
      </div>

      <Dialog open={createTypeOpen} onOpenChange={setCreateTypeOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Nova rotina</DialogTitle>
            <DialogDescription>Selecione o tipo de rotina para abrir o formulário com o layout correto.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              {
                type: 'disparo',
                title: 'Rotina de Disparo',
                description: 'Envio por HSM com regras de vencimento, criação ou instalação.',
                icon: Megaphone,
              },
              {
                type: 'etiqueta',
                title: 'Rotina de Etiqueta',
                description: 'Aplica ou remove etiquetas automaticamente conforme a regra.',
                icon: Tags,
              },
              {
                type: 'follow_up',
                title: 'Rotina de Follow Up',
                description: 'Mensagens por janela e etiqueta, respeitando a regra de 24h.',
                icon: Repeat2,
              },
            ].map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.type}
                  type="button"
                  onClick={() => openCreateForm(option.type)}
                  className="rounded-lg border border-border bg-card p-4 text-left transition hover:border-primary/60 hover:bg-primary/5"
                >
                  <span className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="block text-sm font-semibold text-foreground">{option.title}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{option.description}</span>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {formOpen ? (
        <RoutineForm
          routine={editingRoutine}
          initialType={initialRoutineType}
          templates={templates}
          quickReplies={quickReplies}
          labels={labels}
          sampleCustomer={sampleCustomer}
          customers={customers}
          isSaving={saveMutation.isPending}
          isManualRunning={manualRunMutation.isPending}
          onRefreshTemplates={() => queryClientInstance.invalidateQueries({ queryKey: ['hsm', 'local'] })}
          onManualRun={(draft, customerIds) =>
            manualRunMutation.mutate({
              routineId: draft.id,
              payload: {
                customerIds,
                parameterOverrides: draft.hsm?.parameterOverrides,
                mediaOverride: draft.hsm?.mediaOverride,
              },
            })
          }
          onCancel={() => {
            setFormOpen(false);
            setEditingRoutine(null);
          }}
          onSubmit={(payload) => saveMutation.mutate(payload)}
        />
      ) : null}

      <RoutineRunPreviewDialog
        open={Boolean(runPreviewRoutine)}
        routine={runPreviewRoutine}
        template={
          runPreviewRoutine
            ? templateById.get(String(runPreviewRoutine.hsm?.templateId || runPreviewRoutine.templateId || '')) ||
              templateById.get(`${runPreviewRoutine.hsm?.templateName || runPreviewRoutine.templateName}::${runPreviewRoutine.hsm?.language || runPreviewRoutine.templateLanguage}`)
            : null
        }
        previewData={runPreviewData}
        isLoading={runPreviewMutation.isPending}
        isRunning={runPreviewRoutine ? runningRoutineIds.has(runPreviewRoutine.id) || manualRunMutation.isPending : false}
        onClose={() => {
          if (manualRunMutation.isPending) return;
          setRunPreviewRoutine(null);
          setRunPreviewData(null);
        }}
        onConfirm={(customerIds) => {
          if (!runPreviewRoutine?.id) return;
          if (runPreviewRoutine.type === 'follow_up') {
            manualRunMutation.mutate({
              routineId: runPreviewRoutine.id,
              payload: { customerIds, advanceWindow: Boolean(runPreviewData?.forecast?.isAdvanceWindow) },
            });
          } else {
            manualRunMutation.mutate({
              routineId: runPreviewRoutine.id,
              payload: {
                customerIds,
                parameterOverrides: runPreviewRoutine.hsm?.parameterOverrides,
                mediaOverride: runPreviewRoutine.hsm?.mediaOverride,
              },
            });
          }
        }}
      />

      <Dialog open={Boolean(selectedLog)} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{selectedLog?.routineName || 'Log da rotina'}</DialogTitle>
            <DialogDescription>
              {formatDateTime(selectedLog?.startedAt || selectedLog?.createdAt)} | Status: {logStatusConfig[selectedLog?.status]?.label || selectedLog?.status || '-'}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <div className="rounded-md border border-border bg-card p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Resumo</div>
              <div className="grid gap-2 text-sm text-foreground sm:grid-cols-2">
                <span>Tipo: {ROUTINE_TYPES[selectedLog?.type] || '-'}</span>
                <span>Duração: {getDurationText(selectedLog?.durationMs)}</span>
                <span>Processados: {selectedLog?.processedTotal ?? '-'}</span>
                <span>Sucesso: {selectedLog?.successTotal ?? '-'}</span>
                <span>Falhas: {selectedLog?.failedTotal ?? '-'}</span>
                <span>Ignorados: {selectedLog?.ignoredTotal ?? '-'}</span>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-border bg-card p-3 text-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Run ID</div>
                <div className="mt-1 break-all text-foreground">{selectedLog?.runId || '-'}</div>
              </div>
              <div className="rounded-md border border-border bg-card p-3 text-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Log ID</div>
                <div className="mt-1 break-all text-foreground">{selectedLog?.id || selectedLog?.entries?.[0]?.id || '-'}</div>
              </div>
            </div>

            <div className="rounded-md border border-border bg-card">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Clientes afetados</h3>
                  <p className="text-xs text-muted-foreground">{selectedAffectedCustomers.length} cliente(s) encontrados nos eventos desta execução.</p>
                </div>
                <UserRound className="h-4 w-4 text-muted-foreground" />
              </div>
              {selectedAffectedCustomers.length ? (
                <div className="divide-y divide-border">
                  {selectedAffectedCustomers.map((customer) => {
                    const statusClassName = customerStatusConfig[customer.status] || customerStatusConfig.info;
                    return (
                      <button
                        key={customer.key}
                        type="button"
                        onClick={() => setSelectedCustomerPreview(customer)}
                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">{customer.name}</span>
                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusClassName}`}>
                              {customerStatusLabel[customer.status] || 'Info'}
                            </span>
                          </div>
                          <p className="mt-1 truncate text-xs text-muted-foreground">{customer.phone || customer.customerId || 'Sem telefone identificado'}</p>
                          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{customer.messages[customer.messages.length - 1]}</p>
                        </div>
                        <MessageCircle className="h-4 w-4 shrink-0 text-primary" />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">Nenhum cliente identificado nos eventos desta execução.</div>
              )}
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Detalhes técnicos | OK {selectedLogCategories.success.length} | Falhas {selectedLogCategories.failed.length} | Ignorados {selectedLogCategories.ignored.length}
              </div>
              {selectedLogDetails ? (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 text-xs text-foreground">
                  {selectedLogDetails}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">Este evento não possui detalhes adicionais.</p>
              )}
            </div>
          </div>

          <DialogFooter>
            {canRetrySelectedLog ? (
              <button
                type="button"
                onClick={() => retryFailedRunMutation.mutate({ routineId: selectedLog.routineId, runId: selectedLog.runId })}
                disabled={retryFailedRunMutation.isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
              >
                {retryFailedRunMutation.isPending ? 'Reenviando falhas...' : `Reenviar falhas (${selectedRunFailedCount})`}
              </button>
            ) : null}
            <button type="button" onClick={() => setSelectedLog(null)} className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted">
              Fechar
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CustomerConversationPreviewDialog
        open={Boolean(selectedCustomerPreview)}
        customer={selectedCustomerPreview}
        onClose={() => setSelectedCustomerPreview(null)}
        onOpenConversation={openFullConversation}
      />
    </PageShell>
  );
}
