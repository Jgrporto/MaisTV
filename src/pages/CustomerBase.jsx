import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  History,
  Link2,
  List,
  Loader2,
  Logs,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

import { buildCustomerRows } from '@/lib/customer-base';
import {
  hasStoredBrowserSyncConfig,
  persistBrowserSyncConfig,
  readStoredBrowserSyncConfig,
  startCustomerBrowserSync,
  useCustomerBrowserSync,
} from '@/lib/customer-browser-sync';
import {
  fetchCustomerSyncLogs,
  fetchCustomerSyncState,
  fetchPersistedCustomers,
} from '@/lib/customer-sync-api';
import { CONVERSATION_BACKGROUND_SUMMARY_LIMIT, CONVERSATION_REFRESH_INTERVAL_MS } from '@/lib/performance-config';
import { cn } from '@/lib/utils';
import { fetchWhatsappConversations } from '@/lib/whatsapp-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import PageHeader from '@/components/layout/PageHeader';
import PageSectionCard from '@/components/layout/PageSectionCard';
import PageShell from '@/components/layout/PageShell';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const PAGE_SIZE = 20;

const DEFAULT_FILTERS = {
  search: '',
  startDate: '',
  endDate: '',
  status: 'all',
  plan: 'all',
  test: 'all',
  connections: 'all',
  conversation: 'all',
};

const booleanOptions = [
  { value: 'all', label: 'Todos' },
  { value: 'yes', label: 'Sim' },
  { value: 'no', label: 'Nao' },
];

function formatDateInputValue(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function formatDateTime(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) {
    return '-';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function formatDuration(durationMs) {
  if (!Number.isFinite(Number(durationMs)) || Number(durationMs) <= 0) {
    return '-';
  }

  const totalSeconds = Math.round(Number(durationMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  return `${seconds}s`;
}

function formatCountdown(remainingMs) {
  if (!Number.isFinite(Number(remainingMs)) || Number(remainingMs) <= 0) {
    return 'agora';
  }

  const totalSeconds = Math.max(0, Math.floor(Number(remainingMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}


export default function CustomerBase() {
  const queryClient = useQueryClient();
  const previousSyncStatusRef = useRef(null);

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [logsOpen, setLogsOpen] = useState(false);
  const [browserSyncDialogOpen, setBrowserSyncDialogOpen] = useState(false);
  const [browserSyncProgress, setBrowserSyncProgress] = useState('');
  const [browserSyncErrorMessage, setBrowserSyncErrorMessage] = useState('');
  const [browserSyncConfig, setBrowserSyncConfig] = useState(() => readStoredBrowserSyncConfig());
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const browserSyncRuntime = useCustomerBrowserSync();

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations', 'customer-base', 'summary', CONVERSATION_BACKGROUND_SUMMARY_LIMIT],
    queryFn: () => fetchWhatsappConversations({ summary: true, limit: CONVERSATION_BACKGROUND_SUMMARY_LIMIT }),
    refetchInterval: CONVERSATION_REFRESH_INTERVAL_MS,
  });

  const {
    data: customersResponse,
    isLoading: isLoadingCustomers,
    isFetching: isFetchingCustomers,
  } = useQuery({
    queryKey: ['persisted-customers'],
    queryFn: fetchPersistedCustomers,
    staleTime: 60000,
  });

  const {
    data: syncState,
    isFetching: isFetchingSyncState,
  } = useQuery({
    queryKey: ['customer-sync-state'],
    queryFn: fetchCustomerSyncState,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 3000 : 30000),
  });

  const { data: logsResponse, isFetching: isFetchingLogs } = useQuery({
    queryKey: ['customer-sync-logs'],
    queryFn: fetchCustomerSyncLogs,
    enabled: logsOpen,
    refetchInterval: logsOpen ? 10000 : false,
  });

  const persistedCustomers = customersResponse?.rows || [];
  const customers = useMemo(() => buildCustomerRows(persistedCustomers, conversations), [persistedCustomers, conversations]);
  const syncMeta = syncState || customersResponse?.sync || null;
  const isSyncRunning = syncMeta?.status === 'running';
  const isBrowserSyncRunning = browserSyncRuntime.status === 'running';

  const planOptions = useMemo(
    () => Array.from(new Set(customers.map((customer) => customer.planName).filter(Boolean))).sort((left, right) => left.localeCompare(right)),
    [customers],
  );

  const connectionOptions = useMemo(
    () =>
      Array.from(new Set(customers.map((customer) => String(customer.connections)).filter(Boolean))).sort(
        (left, right) => Number(left) - Number(right),
      ),
    [customers],
  );

  const statusOptions = useMemo(() => {
    const options = customers.reduce((accumulator, customer) => {
      if (!customer.status || accumulator.some((item) => item.value === customer.status)) {
        return accumulator;
      }

      accumulator.push({
        value: customer.status,
        label: customer.statusLabel,
      });
      return accumulator;
    }, []);

    return [{ value: 'all', label: 'Todos' }, ...options.sort((left, right) => left.label.localeCompare(right.label))];
  }, [customers]);

  const filteredCustomers = useMemo(() => {
    return customers.filter((customer) => {
      const searchTerm = filters.search.trim().toLowerCase();
      const dueDateValue = formatDateInputValue(customer.dueDate);
      const matchesSearch =
        !searchTerm ||
        customer.name.toLowerCase().includes(searchTerm) ||
        customer.username.toLowerCase().includes(searchTerm) ||
        customer.planName.toLowerCase().includes(searchTerm) ||
        customer.whatsapp.toLowerCase().includes(searchTerm) ||
        customer.reseller.toLowerCase().includes(searchTerm);

      const matchesStartDate = !filters.startDate || dueDateValue >= filters.startDate;
      const matchesEndDate = !filters.endDate || dueDateValue <= filters.endDate;
      const matchesStatus = filters.status === 'all' || customer.status === filters.status;
      const matchesPlan = filters.plan === 'all' || customer.planName === filters.plan;
      const matchesTest =
        filters.test === 'all' ||
        (filters.test === 'yes' && customer.isTest) ||
        (filters.test === 'no' && !customer.isTest);
      const matchesConnections =
        filters.connections === 'all' || String(customer.connections) === String(filters.connections);
      const matchesConversation =
        filters.conversation === 'all' ||
        (filters.conversation === 'yes' && customer.conversationOpen) ||
        (filters.conversation === 'no' && !customer.conversationOpen);

      return (
        matchesSearch &&
        matchesStartDate &&
        matchesEndDate &&
        matchesStatus &&
        matchesPlan &&
        matchesTest &&
        matchesConnections &&
        matchesConversation
      );
    });
  }, [customers, filters]);

  const totalPages = Math.max(1, Math.ceil(filteredCustomers.length / PAGE_SIZE));
  const pageStart = (page - 1) * PAGE_SIZE;
  const paginatedCustomers = filteredCustomers.slice(pageStart, pageStart + PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [filters]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  useEffect(() => {
    const currentStatus = syncMeta?.status || null;
    const previousStatus = previousSyncStatusRef.current;

    if (previousStatus === 'running' && currentStatus === 'success') {
      void queryClient.invalidateQueries({ queryKey: ['persisted-customers'] });
      void queryClient.invalidateQueries({ queryKey: ['customer-sync-logs'] });
    }

    if (previousStatus === 'running' && currentStatus === 'error') {
      void queryClient.invalidateQueries({ queryKey: ['customer-sync-logs'] });
    }

    previousSyncStatusRef.current = currentStatus;
  }, [queryClient, syncMeta]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setCountdownNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timerId);
  }, []);

  const setFilterValue = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const handleClearFilters = () => {
    setFilters(DEFAULT_FILTERS);
  };

  const handleSyncCustomers = async () => {
    setBrowserSyncConfig(readStoredBrowserSyncConfig());
    setBrowserSyncErrorMessage('');
    setBrowserSyncProgress('');
    setBrowserSyncDialogOpen(true);
  };

  const handleSubmitBrowserSync = async () => {
    const baseUrl = String(browserSyncConfig.baseUrl || '').trim();
    const username = String(browserSyncConfig.username || '').trim();
    const password = String(browserSyncConfig.password || '');

    if (!baseUrl || !username || !password) {
      toast.error('Informe base URL, usuario e senha do NewBr.');
      return;
    }

    setBrowserSyncErrorMessage('');

    try {
      persistBrowserSyncConfig({ baseUrl, username, password });
      startCustomerBrowserSync({
        baseUrl,
        username,
        password,
        mode: 'browser_manual',
      });

      setBrowserSyncDialogOpen(false);
      setBrowserSyncProgress('');
      toast.message('Sincronizacao iniciada no navegador em segundo plano.');
    } catch (error) {
      const message = error?.message || 'Nao foi possivel sincronizar clientes pelo navegador.';
      setBrowserSyncErrorMessage(message);
      toast.error(message);
    }
  };

  useEffect(() => {
    if (browserSyncRuntime.status === 'running') {
      setBrowserSyncProgress(browserSyncRuntime.progress || 'Sincronizando clientes...');
      return;
    }

    if (browserSyncRuntime.status === 'error') {
      setBrowserSyncErrorMessage(browserSyncRuntime.error || 'Nao foi possivel sincronizar clientes pelo navegador.');
      setBrowserSyncProgress('');
      return;
    }

    if (browserSyncRuntime.status === 'success') {
      setBrowserSyncErrorMessage('');
      setBrowserSyncProgress('');
    }
  }, [browserSyncRuntime.error, browserSyncRuntime.progress, browserSyncRuntime.status]);

  const handleCopyText = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copiado.`);
    } catch {
      toast.error(`Nao foi possivel copiar ${label.toLowerCase()}.`);
    }
  };

  const handleActionClick = (action, customer) => {
    if (action === 'history') {
      toast.message(`Historico de ${customer.name} sera ligado ao fluxo NewBr em uma etapa posterior.`);
      return;
    }

    if (action === 'edit') {
      toast.message(`Edicao de ${customer.name} depende da proxima integracao de escrita com o NewBr.`);
      return;
    }

    if (action === 'renew') {
      toast.message(`Renovacao de ${customer.name} preparada para a fase de acoes do NewBr.`);
      return;
    }

    if (action === 'renew-link') {
      void handleCopyText(customer.renewUrl, 'Referencia NewBr');
      return;
    }

    if (action === 'playlist') {
      void handleCopyText(customer.playlist, 'Referencia de conversa');
      return;
    }  };

  const authErrorMessage = browserSyncErrorMessage || syncMeta?.authErrorMessage || syncMeta?.lastError || '';
  const browserCredentialsSaved = hasStoredBrowserSyncConfig();
  const lastSyncLabel = syncMeta?.lastSuccessfulSyncAt ? formatDateTime(syncMeta.lastSuccessfulSyncAt) : 'Nunca';
  const nextSyncTimestamp = Date.parse(String(syncMeta?.nextScheduledAt || ''));
  const nextSyncLabel = Number.isFinite(nextSyncTimestamp) ? formatDateTime(syncMeta.nextScheduledAt) : 'Nao agendada';
  const nextSyncCountdown = Number.isFinite(nextSyncTimestamp)
    ? formatCountdown(Math.max(0, nextSyncTimestamp - countdownNow))
    : '';
  const logs = logsResponse?.logs || [];

  return (
    <PageShell>
      <PageHeader
        title="Base de Clientes"
        description="Clientes persistidos do NewBr com filtros operacionais, estado de sincronizacao e vinculo com conversas do WhatsApp para atendimento."
        actions={
          <div className="flex flex-col items-stretch gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => setLogsOpen(true)} className="gap-2">
                <Logs className="w-4 h-4" />
                Logs
              </Button>
              <Button onClick={handleSyncCustomers} disabled={isBrowserSyncRunning} className="gap-2">
                <RefreshCw className={cn('w-4 h-4', isBrowserSyncRunning && 'animate-spin')} />
                Sincronizar NewBr
              </Button>
            </div>
            {authErrorMessage ? (
              <div className="max-w-[360px] space-y-1">
                <p className="text-xs font-medium text-red-600">{authErrorMessage}</p>
                <p className="text-xs text-muted-foreground">
                  Proxima sincronizacao automatica: {nextSyncLabel}
                  {nextSyncCountdown ? ` (${nextSyncCountdown})` : ''}
                </p>
              </div>
            ) : (
              <div className="max-w-[360px] space-y-1 text-xs text-muted-foreground">
                <p>Sincronizacao via navegador. Ultima sincronizacao valida: {lastSyncLabel}</p>
                <p>
                  Proxima sincronizacao automatica: {nextSyncLabel}
                  {nextSyncCountdown ? ` (${nextSyncCountdown})` : ''}
                </p>
              </div>
            )}
          </div>
        }
      />

      <PageSectionCard className="p-5 space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1.5 xl:col-span-2">
            <label className="text-sm font-medium text-foreground">Buscar</label>
            <Input
              value={filters.search}
              onChange={(event) => setFilterValue('search', event.target.value)}
              placeholder="Buscar por usuario, WhatsApp, revendedor ou plano"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Data Inicial</label>
            <Input
              type="date"
              value={filters.startDate}
              onChange={(event) => setFilterValue('startDate', event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Data Final</label>
            <Input
              type="date"
              value={filters.endDate}
              onChange={(event) => setFilterValue('endDate', event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Status</label>
            <Select value={filters.status} onValueChange={(value) => setFilterValue('status', value)}>
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Planos</label>
            <Select value={filters.plan} onValueChange={(value) => setFilterValue('plan', value)}>
              <SelectTrigger>
                <SelectValue placeholder="Planos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                {planOptions.map((plan) => (
                  <SelectItem key={plan} value={plan}>
                    {plan}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Teste</label>
            <Select value={filters.test} onValueChange={(value) => setFilterValue('test', value)}>
              <SelectTrigger>
                <SelectValue placeholder="Teste" />
              </SelectTrigger>
              <SelectContent>
                {booleanOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Conexoes</label>
            <Select value={filters.connections} onValueChange={(value) => setFilterValue('connections', value)}>
              <SelectTrigger>
                <SelectValue placeholder="Conexoes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas</SelectItem>
                {connectionOptions.map((connection) => (
                  <SelectItem key={connection} value={connection}>
                    {connection}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Conversa</label>
            <Select value={filters.conversation} onValueChange={(value) => setFilterValue('conversation', value)}>
              <SelectTrigger>
                <SelectValue placeholder="Conversa" />
              </SelectTrigger>
              <SelectContent>
                {booleanOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="text-sm text-muted-foreground">
            {filteredCustomers.length} cliente(s) encontrados
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={handleClearFilters}>
              Limpar Filtros
            </Button>
          </div>
        </div>
      </PageSectionCard>

      <PageSectionCard className="overflow-hidden">
        <div className="flex flex-col gap-2 border-b border-border px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Clientes</h2>
            <p className="text-sm text-muted-foreground">
              Mostrando {filteredCustomers.length === 0 ? 0 : pageStart + 1} a {Math.min(pageStart + PAGE_SIZE, filteredCustomers.length)} de{' '}
              {filteredCustomers.length}
            </p>
          </div>
          {(isLoadingCustomers || isFetchingCustomers || isFetchingSyncState) && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              {isSyncRunning ? 'Sincronizando NewBr...' : 'Atualizando base...'}
            </div>
          )}
        </div>

        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/60">
              <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Usuario</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">WhatsApp</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Revendedor</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Plano</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Conexoes</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Vencimento</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Status</TableHead>
              <TableHead className="w-[190px] text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Acoes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!isLoadingCustomers && paginatedCustomers.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  {persistedCustomers.length === 0
                    ? 'Nenhum cliente sincronizado ainda. Execute a primeira sincronizacao manual do NewBr.'
                    : 'Nenhum cliente encontrado para os filtros atuais.'}
                </TableCell>
              </TableRow>
            )}
            {paginatedCustomers.map((customer) => (
              <TableRow key={customer.id} className="hover:bg-secondary/20">
                <TableCell>
                  <div className="space-y-1">
                    <div className="font-medium text-foreground">@{customer.username}</div>
                    <div className="text-xs text-muted-foreground">{customer.name}</div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <div className="text-sm text-foreground">{customer.whatsapp}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {customer.conversationOpen ? `${customer.conversationCount} conversa(s)` : 'Sem conversa vinculada'}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-foreground">{customer.reseller}</TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <div className="text-sm text-foreground">{customer.planName}</div>
                    {customer.isTest && (
                      <Badge variant="outline" className="rounded-full border-[#FFF8E1] bg-[#FFF8E1] text-[#FFC107]">
                        Teste
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm font-medium text-foreground">{customer.connections}</TableCell>
                <TableCell className="text-sm text-foreground">{customer.dueDateLabel}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={cn('rounded-full font-medium', customer.statusClasses)}>
                    {customer.statusLabel}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="icon" title="Historico" onClick={() => handleActionClick('history', customer)}>
                      <History className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title="Editar" onClick={() => handleActionClick('edit', customer)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title="Renovar" onClick={() => handleActionClick('renew', customer)}>
                      <RefreshCw className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title="Referencia NewBr" onClick={() => handleActionClick('renew-link', customer)}>
                      <Link2 className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title="Referencia de conversa" onClick={() => handleActionClick('playlist', customer)}>
                      <List className="w-4 h-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="flex flex-col gap-3 border-t border-border px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="text-sm text-muted-foreground">
            Pagina {page} de {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}>
              Anterior
            </Button>
            <Button variant="outline" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages}>
              Proxima
            </Button>
          </div>
        </div>
      </PageSectionCard>

      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Logs da sincronizacao NewBr</DialogTitle>
            <DialogDescription>
              Historico das execucoes, erros e resumo dos dados persistidos na VPS.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Status atual</div>
              <div className="mt-2 text-lg font-semibold text-foreground">{syncMeta?.status || 'idle'}</div>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Clientes</div>
              <div className="mt-2 text-lg font-semibold text-foreground">{syncMeta?.summary?.total || 0}</div>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Ativos</div>
              <div className="mt-2 text-lg font-semibold text-foreground">{syncMeta?.summary?.active || 0}</div>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Ultima sync valida</div>
              <div className="mt-2 text-sm font-semibold text-foreground">{lastSyncLabel}</div>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Proxima sync</div>
              <div className="mt-2 text-sm font-semibold text-foreground">{nextSyncCountdown || nextSyncLabel}</div>
            </div>
          </div>

          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <div className="text-sm font-medium text-foreground">Execucoes recentes</div>
                <div className="text-xs text-muted-foreground">
                  {browserCredentialsSaved
                    ? 'Credenciais do navegador salvas neste dispositivo.'
                    : 'Credenciais do navegador ainda nao foram salvas neste dispositivo.'}
                </div>
              </div>
              {isFetchingLogs && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            </div>
            <div className="max-h-[360px] overflow-y-auto">
              {logs.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">Nenhuma execucao registrada ainda.</div>
              ) : (
                <div className="divide-y divide-border">
                  {logs.map((entry) => (
                    <div key={entry.id} className="space-y-2 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={cn(
                            'rounded-full font-medium',
                            entry.status === 'success'
                              ? 'border-primary/20 bg-primary/10 text-primary'
                              : 'border-red-500/20 bg-red-500/10 text-red-600',
                          )}
                        >
                          {entry.status === 'success' ? 'Sucesso' : 'Erro'}
                        </Badge>
                        <span className="text-sm font-medium text-foreground">{entry.mode || 'manual'}</span>
                        <span className="text-xs text-muted-foreground">{formatDateTime(entry.finishedAt || entry.startedAt)}</span>
                      </div>
                      <div className="text-sm text-foreground">{entry.message || '-'}</div>
                      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                        <span>Duracao: {formatDuration(entry.durationMs)}</span>
                        <span>Clientes: {entry.totalRows || 0}</span>
                        <span>Paginas: {entry.pagesLoaded || 0}</span>
                        <span>Ativos: {entry.summary?.active || 0}</span>
                        {entry.errorCode ? <span>Codigo: {entry.errorCode}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={browserSyncDialogOpen} onOpenChange={setBrowserSyncDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Sincronizar NewBr no Navegador</DialogTitle>
            <DialogDescription>
              Esse fluxo usa o navegador atual para autenticar no painel NewBr, coletar `/api/customers` e importar a base resultante para a VPS.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Base URL</label>
              <Input
                value={browserSyncConfig.baseUrl}
                onChange={(event) =>
                  setBrowserSyncConfig((current) => ({ ...current, baseUrl: event.target.value }))
                }
                placeholder="https://painel.newbr.top"
                disabled={isBrowserSyncRunning}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Usuario</label>
              <Input
                value={browserSyncConfig.username}
                onChange={(event) =>
                  setBrowserSyncConfig((current) => ({ ...current, username: event.target.value }))
                }
                placeholder="suportemaistv"
                disabled={isBrowserSyncRunning}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Senha</label>
              <Input
                type="password"
                value={browserSyncConfig.password}
                onChange={(event) =>
                  setBrowserSyncConfig((current) => ({ ...current, password: event.target.value }))
                }
                placeholder="Senha do painel NewBr"
                disabled={isBrowserSyncRunning}
              />
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
              <p>Se o NewBr ainda bloquear o login, abra `painel.newbr.top` nesse mesmo navegador, conclua o desafio do Cloudflare e tente novamente.</p>
            </div>
            {browserSyncProgress ? (
              <div className="rounded-lg border border-border bg-secondary/40 p-3 text-sm text-foreground">
                {browserSyncProgress}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBrowserSyncDialogOpen(false)}>
              {isBrowserSyncRunning ? 'Fechar' : 'Cancelar'}
            </Button>
            <Button onClick={handleSubmitBrowserSync} disabled={isBrowserSyncRunning} className="gap-2">
              {isBrowserSyncRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {isBrowserSyncRunning ? 'Sincronizando...' : 'Executar no Navegador'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


    </PageShell>
  );
}
