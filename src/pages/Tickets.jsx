import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Eye, Filter, MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import PageHeader from '@/components/layout/PageHeader';
import PageShell from '@/components/layout/PageShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { fetchAllPersistedCustomers } from '@/lib/customer-sync-api';
import { fetchLocalUsers } from '@/lib/users-api';
import {
  getTicket,
  listTickets,
  TICKET_STATUS_LABELS,
  TICKET_TYPE_LABELS,
  updateTicket,
} from '@/lib/tickets-api';
import { cn } from '@/lib/utils';

const GENERAL_STATUS_LABELS = {
  open: 'Aberto',
  resolved: 'Resolvido',
  cancelled: 'Cancelado',
};

const statusClassNames = {
  open: 'border-amber-500/25 bg-amber-500/10 text-amber-700',
  resolved: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700',
  cancelled: 'border-slate-500/25 bg-slate-500/10 text-slate-600',
  in_analysis: 'border-blue-500/25 bg-blue-500/10 text-blue-700',
  waiting_customer: 'border-violet-500/25 bg-violet-500/10 text-violet-700',
};

const initialFilters = {
  status: '',
  type: '',
  assigned_to: '',
  created_from: '',
  created_to: '',
};

const formatDateTime = (value) => {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const getUserName = (user = {}) =>
  String(user.full_name || user.name || user.username || user.email || user.id || '').trim();

const firstText = (...values) => values.map((value) => String(value || '').trim()).find(Boolean) || '';

const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');

const ticketMetadata = (ticket = {}) => {
  const metadata = ticket.metadata && typeof ticket.metadata === 'object' ? ticket.metadata : {};
  return {
    customer_password: firstText(metadata.customer_password, metadata.customerPassword, ticket.customer_password, ticket.customerPassword),
    customer_label: firstText(metadata.customer_label, metadata.customerLabel, ticket.customer_label, ticket.customerLabel),
    content_name: firstText(metadata.content_name, metadata.contentName, ticket.content_name, ticket.contentName),
    problem_type: firstText(metadata.problem_type, metadata.problemType, ticket.problem_type, ticket.problemType),
    app_name: firstText(metadata.app_name, metadata.appName, ticket.app_name, ticket.appName),
    device: firstText(metadata.device, ticket.device),
    period: firstText(metadata.period, metadata.timePeriod, ticket.period, ticket.time_period),
    requested_content_name: firstText(metadata.requested_content_name, metadata.requestedContentName, ticket.requested_content_name),
    content_category: firstText(metadata.content_category, metadata.contentCategory, ticket.content_category),
    available_where: firstText(metadata.available_where, metadata.availableWhere, ticket.available_where),
    mac_or_device: firstText(metadata.mac_or_device, metadata.macOrDevice, ticket.mac_or_device),
    tv_code: firstText(metadata.tv_code, metadata.tvCode, ticket.tv_code),
    observation: firstText(metadata.observation, ticket.observation, ticket.description),
    attachments: Array.isArray(ticket.attachments)
      ? ticket.attachments
      : Array.isArray(metadata.attachments)
        ? metadata.attachments
        : [],
  };
};

const resolveTicketName = (ticket = {}) => {
  const metadata = ticketMetadata(ticket);
  return firstText(
    metadata.content_name,
    metadata.requested_content_name,
    metadata.app_name,
    ticket.title,
  );
};

const resolveTicketResponsible = (ticket = {}, usersById = new Map()) => {
  const user = usersById.get(String(ticket.created_by || '')) || usersById.get(String(ticket.created_by_name || ''));
  return user ? getUserName(user) : firstText(ticket.created_by_name, ticket.created_by, '-');
};

const resolveTicketCustomerPassword = (ticket = {}, customers = []) => {
  const metadata = ticketMetadata(ticket);
  const persistedPassword = firstText(metadata.customer_password, ticket.customer_password, ticket.customerPassword);
  const ticketPhone = normalizeDigits(ticket.customer_phone || ticket.customerPhone);

  if (!ticketPhone) return persistedPassword;

  const matchedCustomer = (Array.isArray(customers) ? customers : []).find((customer) => {
    const source = customer?.sourceCustomer || customer?.raw || customer || {};
    const candidatePhones = [
      customer?.phone_digits,
      customer?.phoneDigits,
      customer?.whatsapp,
      customer?.phone,
      source?.phone_digits,
      source?.phoneDigits,
      source?.whatsapp,
      source?.telefone,
      source?.phone,
      source?.mobile,
      source?.cellphone,
    ];

    return candidatePhones.some((candidate) => normalizeDigits(candidate) === ticketPhone);
  });

  if (!matchedCustomer) return persistedPassword;

  const source = matchedCustomer.sourceCustomer || matchedCustomer.raw || matchedCustomer;
  return firstText(
    source.senha,
    source.password,
    source.pass,
    matchedCustomer.senha,
    matchedCustomer.password,
    matchedCustomer.pass,
    persistedPassword,
  );
};

const SelectInput = ({ value, onChange, children, className = '' }) => (
  <select
    value={value}
    onChange={(event) => onChange(event.target.value)}
    className={cn('h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring', className)}
  >
    {children}
  </select>
);

function CustomerData({ ticket, customerPassword = '' }) {
  const metadata = ticketMetadata(ticket);
  const rows = [
    ['Nome', ticket.customer_name || '-'],
    ['Whatsapp', ticket.customer_phone || '-'],
    ['Usuario', ticket.customer_username || '-'],
    ['Senha', customerPassword || metadata.customer_password || '-'],
    ['Etiqueta', metadata.customer_label || '-'],
  ];

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Dados do Cliente</h3>
      <dl className="mt-3 grid gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[92px_1fr] gap-3">
            <dt className="text-muted-foreground">{label}:</dt>
            <dd className="min-w-0 break-words text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function AttachmentPreview({ attachment }) {
  const mimeType = String(attachment?.mimeType || '').toLowerCase();
  const dataUrl = attachment?.dataUrl || '';

  if (dataUrl && mimeType.startsWith('image/')) {
    return (
      <img
        src={dataUrl}
        alt={attachment.fileName || 'Anexo do ticket'}
        className="h-40 w-full rounded-md border border-border object-cover"
      />
    );
  }

  if (dataUrl && mimeType.startsWith('video/')) {
    return (
      <video
        src={dataUrl}
        controls
        className="h-40 w-full rounded-md border border-border bg-black object-contain"
      />
    );
  }

  if (dataUrl && mimeType === 'application/pdf') {
    return (
      <iframe
        src={dataUrl}
        title={attachment.fileName || 'PDF do ticket'}
        className="h-40 w-full rounded-md border border-border bg-background"
      />
    );
  }

  return (
    <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border bg-muted/30 text-xs text-muted-foreground">
      Previa indisponivel
    </div>
  );
}

function Gallery({ attachments = [] }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Galeria</h3>
      {attachments.length ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="overflow-hidden rounded-md border border-border bg-background p-2">
              <AttachmentPreview attachment={attachment} />
              <div className="mt-2 min-w-0">
                <a
                  href={attachment.dataUrl || '#'}
                  download={attachment.fileName}
                  className="block truncate text-sm font-medium text-foreground hover:underline"
                  title={attachment.fileName}
                >
                  {attachment.fileName}
                </a>
                <span className="text-xs text-muted-foreground">{attachment.mimeType || 'Arquivo'}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">Nenhum anexo registrado.</p>
      )}
    </section>
  );
}

function RequestDetails({ ticket }) {
  const metadata = ticketMetadata(ticket);
  const rows = [];

  if (ticket.type === 'content_problem') {
    rows.push(
      ['Nome do Conteudo', metadata.content_name || resolveTicketName(ticket)],
      ['Tipo de Problema', metadata.problem_type],
      ['Aplicativo Usado', metadata.app_name],
      ['Dispositivo', metadata.device],
      ['Horario/Periodo', metadata.period],
    );
  } else if (ticket.type === 'add_content') {
    rows.push(
      ['Nome do Conteudo', metadata.requested_content_name || resolveTicketName(ticket)],
      ['Categoria', metadata.content_category],
      ['Disponivel Onde?', metadata.available_where],
    );
  } else if (ticket.type === 'activate_app') {
    rows.push(
      ['Nome do Aplicativo', metadata.app_name || resolveTicketName(ticket)],
      ['MAC do Aparelho', metadata.mac_or_device],
      ['COD do Aparelho', metadata.tv_code],
    );
  }

  rows.push(['Observacao', metadata.observation || ticket.description]);

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Solicitação</h3>
      <dl className="mt-3 grid gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[160px_1fr] gap-3">
            <dt className="text-muted-foreground">{label}:</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{String(value || '-')}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function TicketDetailsDialog({ ticket, open, onOpenChange, onTicketUpdated }) {
  const queryClient = useQueryClient();
  const [treatment, setTreatment] = useState('');
  const ticketId = String(ticket?.id || '').trim();

  const { data: refreshedTicket } = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: () => getTicket(ticketId),
    enabled: open && Boolean(ticketId),
    staleTime: 0,
  });
  const { data: customersResponse } = useQuery({
    queryKey: ['persisted-customers', 'all'],
    queryFn: fetchAllPersistedCustomers,
    enabled: open,
    staleTime: 30000,
  });
  const activeTicket = refreshedTicket || ticket;

  const finishMutation = useMutation({
    mutationFn: async () => {
      const resolutionNote = treatment.trim();
      if (!resolutionNote) {
        throw new Error('Informe a tratativa antes de finalizar o ticket.');
      }
      return updateTicket(activeTicket.id, { status: 'resolved', resolution_note: resolutionNote });
    },
    onSuccess: async (updatedTicket) => {
      setTreatment('');
      onTicketUpdated?.(updatedTicket);
      await queryClient.invalidateQueries({ queryKey: ['tickets'] });
      await queryClient.invalidateQueries({ queryKey: ['ticket', updatedTicket.id] });
      await queryClient.invalidateQueries({ queryKey: ['conversation-tickets', updatedTicket.conversation_id] });
      toast.success('Ticket finalizado.');
    },
    onError: (error) => toast.error(error?.message || 'Nao foi possivel finalizar o ticket.'),
  });

  if (!activeTicket) return null;

  const attachments = ticketMetadata(activeTicket).attachments;
  const persistedCustomers = Array.isArray(customersResponse?.rows) ? customersResponse.rows : [];
  const customerPassword = resolveTicketCustomerPassword(activeTicket, persistedCustomers);
  const modalTitle = `Ticket - ${TICKET_TYPE_LABELS[activeTicket.type] || activeTicket.type} - ${activeTicket.customer_name || 'Cliente'}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[96vw] max-w-4xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>{modalTitle}</DialogTitle>
          <DialogDescription>
            {resolveTicketName(activeTicket) || 'Solicitacao sem nome'} - {GENERAL_STATUS_LABELS[activeTicket.status] || TICKET_STATUS_LABELS[activeTicket.status] || activeTicket.status}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
          <div className="grid gap-4">
            <CustomerData ticket={activeTicket} customerPassword={customerPassword} />
            <Gallery attachments={attachments} />
            <RequestDetails ticket={activeTicket} />

            <section className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold text-foreground">Tratativa</h3>
              <label className="mt-3 block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Descrição:</span>
                <Textarea
                  value={treatment}
                  onChange={(event) => setTreatment(event.target.value)}
                  rows={4}
                  placeholder="Descreva a tratativa antes de finalizar, se necessario."
                />
              </label>
              {Array.isArray(activeTicket.comments) && activeTicket.comments.length ? (
                <div className="mt-3 space-y-2">
                  {activeTicket.comments.map((comment) => (
                    <div key={comment.id} className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">
                      <p className="text-foreground">{comment.content}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{comment.created_by_name || comment.created_by || '-'} · {formatDateTime(comment.created_at)}</p>
                    </div>
                  ))}
                </div>
              ) : null}
              {activeTicket.resolved_by_name || activeTicket.resolved_by || activeTicket.resolved_at ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Finalizado por {activeTicket.resolved_by_name || activeTicket.resolved_by || '-'} em {formatDateTime(activeTicket.resolved_at)}
                </p>
              ) : null}
              <Button
                className="mt-3"
                disabled={activeTicket.status === 'resolved' || finishMutation.isPending || !treatment.trim()}
                onClick={() => finishMutation.mutate()}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Finalizar ticket
              </Button>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Tickets() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState(initialFilters);
  const [selectedTicket, setSelectedTicket] = useState(null);

  const { data: ticketsPayload = { items: [] }, isLoading } = useQuery({
    queryKey: ['tickets', filters],
    queryFn: () => listTickets(filters),
    staleTime: 10000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['settings', 'users'],
    queryFn: fetchLocalUsers,
    staleTime: 30000,
  });

  const tickets = Array.isArray(ticketsPayload.items) ? ticketsPayload.items : [];
  const usersById = useMemo(
    () => new Map(users.flatMap((user) => [[String(user.id || ''), user], [String(user.email || ''), user], [getUserName(user), user]])),
    [users],
  );

  const updateFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));

  return (
    <PageShell>
      <PageHeader
        title="Tickets"
        description="Central de chamados internos vinculados aos atendimentos."
      />

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-4 flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Filtros</h2>
        </div>

        <div className="grid gap-3 lg:grid-cols-[repeat(5,minmax(150px,1fr))_auto]">
          <SelectInput value={filters.status} onChange={(value) => updateFilter('status', value)}>
            <option value="">STATUS</option>
            {Object.entries(GENERAL_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectInput>
          <SelectInput value={filters.type} onChange={(value) => updateFilter('type', value)}>
            <option value="">TIPOS</option>
            {Object.entries(TICKET_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectInput>
          <SelectInput value={filters.assigned_to} onChange={(value) => updateFilter('assigned_to', value)}>
            <option value="">RESPONSÁVEL</option>
            {users.map((user) => <option key={user.id || user.email} value={user.id || user.email}>{getUserName(user)}</option>)}
          </SelectInput>
          <Input type="date" value={filters.created_from} onChange={(event) => updateFilter('created_from', event.target.value)} aria-label="Data inicio" />
          <Input type="date" value={filters.created_to} onChange={(event) => updateFilter('created_to', event.target.value)} aria-label="Data fim" />
          <Button type="button" variant="outline" onClick={() => setFilters(initialFilters)}>Limpar</Button>
        </div>
      </section>

      <section className="mt-5 overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Whatsapp</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Nome</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Responsável</th>
                <th className="px-4 py-3">Criado em</th>
                <th className="px-4 py-3">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">Carregando tickets...</td>
                </tr>
              ) : tickets.length ? (
                tickets.map((ticket, index) => (
                  <tr key={ticket.id} className="hover:bg-muted/25">
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{index + 1}</td>
                    <td className="px-4 py-3 font-medium text-foreground">{ticket.customer_name || '-'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{ticket.customer_phone || '-'}</td>
                    <td className="px-4 py-3">{TICKET_TYPE_LABELS[ticket.type] || ticket.type}</td>
                    <td className="max-w-[220px] truncate px-4 py-3" title={resolveTicketName(ticket)}>{resolveTicketName(ticket) || '-'}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={statusClassNames[ticket.status]}>
                        {GENERAL_STATUS_LABELS[ticket.status] || TICKET_STATUS_LABELS[ticket.status] || ticket.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{resolveTicketResponsible(ticket, usersById)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateTime(ticket.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setSelectedTicket(ticket)} title="Abrir">
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => {
                            if (ticket.conversation_id || ticket.customer_phone) {
                              navigate('/', {
                                state: {
                                  openConversation: {
                                    conversationId: ticket.conversation_id || '',
                                    phone: ticket.customer_phone || '',
                                    customerId: ticket.customer_username || '',
                                  },
                                },
                              });
                            }
                          }}
                          disabled={!ticket.conversation_id && !ticket.customer_phone}
                          title="Ir para conversa"
                        >
                          <MessageSquare className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">
                    Nenhum ticket encontrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <TicketDetailsDialog
        ticket={selectedTicket}
        open={Boolean(selectedTicket)}
        onOpenChange={(open) => {
          if (!open) setSelectedTicket(null);
        }}
        onTicketUpdated={setSelectedTicket}
      />
    </PageShell>
  );
}
