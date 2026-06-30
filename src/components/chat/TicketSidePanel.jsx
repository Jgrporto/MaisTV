import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileText, Loader2, MessageSquarePlus, Plus, Ticket, X } from 'lucide-react';
import { toast } from 'sonner';

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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  addTicketComment,
  createTicket,
  listConversationTickets,
  TICKET_STATUS_LABELS,
  TICKET_TYPE_LABELS,
} from '@/lib/tickets-api';

const PROBLEM_TYPE_OPTIONS = [
  'Sem imagem',
  'Sem audio',
  'Travando',
  'Conteudo errado',
  'Canal fora do ar',
  'Legenda/audio incorreto',
  'Outro',
];

const CONTENT_CATEGORY_OPTIONS = ['Filme', 'Serie', 'Canal'];

const initialForm = {
  type: 'content_problem',
  content_name: '',
  problem_type: 'Travando',
  app_name: '',
  device: '',
  period: '',
  observation: '',
  requested_content_name: '',
  content_category: 'Filme',
  available_where: '',
  activation_app_name: '',
  mac_or_device: '',
  tv_code: '',
};

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Nao foi possivel ler o anexo.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

const firstText = (...values) => values.map((value) => String(value || '').trim()).find(Boolean) || '';

function resolveLabels(conversation = {}) {
  const primaryLabel = conversation.primary_label;
  if (primaryLabel) {
    return firstText(primaryLabel.name, primaryLabel.label, primaryLabel.title, primaryLabel.value);
  }

  const fallbackLabel = conversation.stage_label || conversation.system_label;
  return firstText(fallbackLabel?.name, fallbackLabel?.label, fallbackLabel?.title, fallbackLabel?.value);
}

function resolveCustomerContext(conversation = {}) {
  const customer = conversation?.customer || {};
  return {
    conversationId: firstText(conversation?.id, conversation?.conversation_id),
    customerName: firstText(conversation?.contact_name, customer.name, customer.nome, conversation?.name),
    customerPhone: firstText(conversation?.contact_phone, conversation?.phone, customer.phone, customer.whatsapp),
    customerUsername: firstText(customer.username, customer.user, customer.usuario, conversation?.username),
    customerPassword: firstText(
      customer.password,
      customer.senha,
      customer.pass,
      customer.sourceCustomer?.senha,
      customer.sourceCustomer?.password,
      conversation?.password,
      conversation?.senha,
    ),
    customerLabels: firstText(
      resolveLabels(conversation),
      customer.etiqueta,
      customer.label,
      customer.statusLabel,
      conversation?.label_name,
      conversation?.label,
      'Sem etiqueta',
    ),
  };
}

function resolveTicketMainName(ticket = {}) {
  const metadata = ticket.metadata || {};
  return firstText(
    metadata.content_name,
    metadata.requested_content_name,
    metadata.app_name,
    ticket.title,
  );
}

function formatDateTime(value) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function resolveFormMainName(form = {}) {
  if (form.type === 'content_problem') return form.content_name;
  if (form.type === 'add_content') return form.requested_content_name;
  return form.activation_app_name;
}

function buildTicketTitle(form, customerName) {
  const typeLabel = TICKET_TYPE_LABELS[form.type] || 'Ticket';
  const name = resolveFormMainName(form);
  return [typeLabel, name, customerName].filter(Boolean).join(' - ');
}

function validateForm(form) {
  if (form.type === 'content_problem') {
    return Boolean(form.content_name.trim() && form.problem_type.trim() && form.app_name.trim() && form.device.trim());
  }
  if (form.type === 'add_content') {
    return Boolean(form.requested_content_name.trim() && form.content_category.trim() && form.available_where.trim());
  }
  if (form.type === 'activate_app') {
    return Boolean(form.activation_app_name.trim() && form.mac_or_device.trim() && form.tv_code.trim());
  }
  return false;
}

function Field({ label, required = false, children }) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        {label}{required ? ' *' : ''}
      </span>
      {children}
    </label>
  );
}

function SelectField({ value, onChange, children }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
    >
      {children}
    </select>
  );
}

function CustomerData({ customerContext }) {
  const rows = [
    ['Nome', customerContext.customerName || '-'],
    ['Whatsapp', customerContext.customerPhone || '-'],
    ['Usuario', customerContext.customerUsername || '-'],
    ['Senha', customerContext.customerPassword || '-'],
    ['Etiqueta', customerContext.customerLabels || '-'],
  ];

  return (
    <section className="rounded-lg border border-border bg-background/60 p-3">
      <div className="mb-2 text-xs font-semibold text-foreground">Dados do Cliente</div>
      <dl className="grid gap-2 text-xs text-muted-foreground">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[78px_1fr] gap-2">
            <dt>{label}:</dt>
            <dd className="min-w-0 truncate font-medium text-foreground" title={value}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function HistoryTicketInfo({ ticket, onOpen, onAddInfo }) {
  const canAddInfo = ticket.status !== 'resolved' && ticket.status !== 'cancelled';

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-semibold text-foreground">{resolveTicketMainName(ticket) || ticket.title}</span>
        <Badge variant="outline" className="text-[10px]">{TICKET_STATUS_LABELS[ticket.status] || ticket.status}</Badge>
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground">{TICKET_TYPE_LABELS[ticket.type] || ticket.type}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">Criado em {formatDateTime(ticket.created_at)}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onOpen(ticket)}>
          <Eye className="mr-1.5 h-3.5 w-3.5" />
          Abrir
        </Button>
        {canAddInfo ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onAddInfo(ticket)}>
            <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" />
            Adicionar informações
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TicketHistoryDialog({ ticket, open, onOpenChange }) {
  if (!ticket) return null;
  const metadata = ticket.metadata || {};
  const attachments = Array.isArray(ticket.attachments)
    ? ticket.attachments
    : Array.isArray(metadata.attachments)
      ? metadata.attachments
      : [];
  const details = [
    ['Cliente', ticket.customer_name],
    ['Whatsapp', ticket.customer_phone],
    ['Usuário', ticket.customer_username],
    ['Tipo', TICKET_TYPE_LABELS[ticket.type] || ticket.type],
    ['Status', TICKET_STATUS_LABELS[ticket.status] || ticket.status],
    ['Nome', resolveTicketMainName(ticket)],
    ['Problema', metadata.problem_type],
    ['Aplicativo', metadata.app_name],
    ['Dispositivo', metadata.device],
    ['Período', metadata.period],
    ['Categoria', metadata.content_category],
    ['Disponível onde', metadata.available_where],
    ['MAC', metadata.mac_or_device],
    ['Código', metadata.tv_code],
    ['Observação', metadata.observation || ticket.description],
  ].filter(([, value]) => String(value || '').trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{resolveTicketMainName(ticket) || ticket.title || 'Ticket'}</DialogTitle>
          <DialogDescription>
            {TICKET_STATUS_LABELS[ticket.status] || ticket.status} - criado em {formatDateTime(ticket.created_at)}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[68vh] overflow-y-auto px-5 py-4">
          <dl className="grid gap-2 text-sm">
            {details.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[120px_1fr] gap-3">
                <dt className="text-muted-foreground">{label}:</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{value}</dd>
              </div>
            ))}
          </dl>

          {attachments.length ? (
            <section className="mt-4 rounded-lg border border-border bg-muted/20 p-3">
              <div className="text-xs font-semibold text-foreground">Anexos</div>
              <div className="mt-2 space-y-1">
                {attachments.map((attachment) => (
                  <a
                    key={attachment.id || attachment.fileName}
                    href={attachment.dataUrl || '#'}
                    download={attachment.fileName}
                    className="block truncate text-xs text-primary hover:underline"
                    title={attachment.fileName}
                  >
                    {attachment.fileName || 'Arquivo'}
                  </a>
                ))}
              </div>
            </section>
          ) : null}

          <section className="mt-4 rounded-lg border border-border bg-muted/20 p-3">
            <div className="text-xs font-semibold text-foreground">Tratativa</div>
            {Array.isArray(ticket.comments) && ticket.comments.length ? (
              <div className="mt-2 space-y-2">
                {ticket.comments.map((comment) => (
                  <div key={comment.id} className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                    <p className="whitespace-pre-wrap text-foreground">{comment.content}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {comment.created_by_name || comment.created_by || '-'} - {formatDateTime(comment.created_at)}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Nenhuma tratativa registrada.</p>
            )}
            {ticket.resolved_by_name || ticket.resolved_by || ticket.resolved_at ? (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Finalizado por {ticket.resolved_by_name || ticket.resolved_by || '-'} em {formatDateTime(ticket.resolved_at)}
              </p>
            ) : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function TicketSidePanel({
  open,
  onClose,
  conversation,
  currentUser,
  onTicketCreated,
}) {
  const [form, setForm] = useState(initialForm);
  const [attachments, setAttachments] = useState([]);
  const [commentTicket, setCommentTicket] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [historyTicket, setHistoryTicket] = useState(null);
  const queryClient = useQueryClient();
  const customerContext = useMemo(() => resolveCustomerContext(conversation), [conversation]);

  const ticketsQuery = useQuery({
    queryKey: ['conversation-tickets', customerContext.conversationId],
    queryFn: () => listConversationTickets(customerContext.conversationId),
    enabled: open && Boolean(customerContext.conversationId),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const uploadedAttachments = await Promise.all(
        attachments.map(async (attachment) => ({
          fileName: attachment.name,
          mimeType: attachment.type || 'application/octet-stream',
          size: attachment.size,
          dataUrl: await fileToDataUrl(attachment),
        })),
      );

      const metadata = {
        customer_password: customerContext.customerPassword,
        customer_label: customerContext.customerLabels,
        content_name: form.type === 'content_problem' ? form.content_name : undefined,
        problem_type: form.type === 'content_problem' ? form.problem_type : undefined,
        app_name: form.type === 'content_problem' ? form.app_name : form.type === 'activate_app' ? form.activation_app_name : undefined,
        device: form.type === 'content_problem' ? form.device : undefined,
        period: form.type === 'content_problem' ? form.period : undefined,
        requested_content_name: form.type === 'add_content' ? form.requested_content_name : undefined,
        content_category: form.type === 'add_content' ? form.content_category : undefined,
        available_where: form.type === 'add_content' ? form.available_where : undefined,
        mac_or_device: form.type === 'activate_app' ? form.mac_or_device : undefined,
        tv_code: form.type === 'activate_app' ? form.tv_code : undefined,
        observation: form.observation,
        attachments: uploadedAttachments,
      };

      return createTicket({
        conversation_id: customerContext.conversationId,
        customer_name: customerContext.customerName,
        customer_phone: customerContext.customerPhone,
        customer_username: customerContext.customerUsername,
        type: form.type,
        title: buildTicketTitle(form, customerContext.customerName),
        description: form.observation,
        priority: 'normal',
        attachments: uploadedAttachments,
        ...metadata,
        metadata,
      });
    },
    onSuccess: async (ticket) => {
      toast.success('Ticket criado.');
      setForm(initialForm);
      setAttachments([]);
      await queryClient.invalidateQueries({ queryKey: ['conversation-tickets', customerContext.conversationId] });
      await queryClient.invalidateQueries({ queryKey: ['tickets'] });
      onTicketCreated?.(ticket);
    },
    onError: (error) => toast.error(error?.message || 'Nao foi possivel criar o ticket.'),
  });

  const commentMutation = useMutation({
    mutationFn: () => addTicketComment(commentTicket.id, commentText),
    onSuccess: async () => {
      toast.success('Informacao adicionada.');
      setCommentTicket(null);
      setCommentText('');
      await queryClient.invalidateQueries({ queryKey: ['conversation-tickets', customerContext.conversationId] });
      await queryClient.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (error) => toast.error(error?.message || 'Nao foi possivel adicionar informacao.'),
  });

  const updateForm = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const historyTickets = Array.isArray(ticketsQuery.data?.tickets)
    ? ticketsQuery.data.tickets
    : [];
  const canCreate = validateForm(form) && Boolean(customerContext.conversationId);

  if (!open) return null;

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-l border-border bg-card shadow-2xl animate-in slide-in-from-right-4 duration-200">
      <div className="shrink-0 border-b border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Ticket className="h-4 w-4" />
              </div>
              <h2 className="text-sm font-semibold text-foreground">Novo Ticket</h2>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <CustomerData customerContext={customerContext} />

        <section className="mt-4 rounded-lg border border-border bg-background/60 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-foreground">Histórico</div>
            <Badge variant="outline" className="text-[10px]">{historyTickets.length}</Badge>
          </div>
          {ticketsQuery.isLoading ? (
            <div className="text-xs text-muted-foreground">Carregando tickets...</div>
          ) : historyTickets.length ? (
            <div className="space-y-2">
              {historyTickets.map((ticket) => (
                <HistoryTicketInfo
                  key={ticket.id}
                  ticket={ticket}
                  onOpen={setHistoryTicket}
                  onAddInfo={setCommentTicket}
                />
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">Nenhum ticket registrado para esta conversa.</div>
          )}

          {commentTicket ? (
            <div className="mt-3 rounded-md border border-border bg-card p-3">
              <p className="mb-2 text-xs font-semibold text-foreground">Adicionar informacoes</p>
              <Textarea value={commentText} onChange={(event) => setCommentText(event.target.value)} rows={3} />
              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => { setCommentTicket(null); setCommentText(''); }}>
                  Cancelar
                </Button>
                <Button type="button" size="sm" disabled={!commentText.trim() || commentMutation.isPending} onClick={() => commentMutation.mutate()}>
                  Salvar
                </Button>
              </div>
            </div>
          ) : null}
        </section>

        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) createMutation.mutate();
          }}
        >
          <Field label="Tipo de Chamado" required>
            <SelectField value={form.type} onChange={(value) => updateForm('type', value)}>
              {Object.entries(TICKET_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </SelectField>
          </Field>

          {form.type === 'content_problem' ? (
            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
              <Field label="Nome do Conteudo" required>
                <Input value={form.content_name} onChange={(event) => updateForm('content_name', event.target.value)} />
              </Field>
              <Field label="Tipo de Problema" required>
                <SelectField value={form.problem_type} onChange={(value) => updateForm('problem_type', value)}>
                  {PROBLEM_TYPE_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                </SelectField>
              </Field>
              <Field label="Aplicativo Usado" required>
                <Input value={form.app_name} onChange={(event) => updateForm('app_name', event.target.value)} />
              </Field>
              <Field label="Dispositivo" required>
                <Input value={form.device} onChange={(event) => updateForm('device', event.target.value)} />
              </Field>
              <Field label="Horario/Periodo">
                <Input value={form.period} onChange={(event) => updateForm('period', event.target.value)} />
              </Field>
            </div>
          ) : null}

          {form.type === 'add_content' ? (
            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
              <Field label="Nome do Conteudo" required>
                <Input value={form.requested_content_name} onChange={(event) => updateForm('requested_content_name', event.target.value)} />
              </Field>
              <Field label="Categoria" required>
                <SelectField value={form.content_category} onChange={(value) => updateForm('content_category', value)}>
                  {CONTENT_CATEGORY_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                </SelectField>
              </Field>
              <Field label="Disponivel Onde?" required>
                <Input value={form.available_where} onChange={(event) => updateForm('available_where', event.target.value)} placeholder="Cole o link ou nome do local" />
              </Field>
            </div>
          ) : null}

          {form.type === 'activate_app' ? (
            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
              <Field label="Nome do Aplicativo" required>
                <Input value={form.activation_app_name} onChange={(event) => updateForm('activation_app_name', event.target.value)} />
              </Field>
              <Field label="MAC do Aparelho" required>
                <Input value={form.mac_or_device} onChange={(event) => updateForm('mac_or_device', event.target.value)} />
              </Field>
              <Field label="COD do Aparelho" required>
                <Input value={form.tv_code} onChange={(event) => updateForm('tv_code', event.target.value)} />
              </Field>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="ticket-attachment">Anexos</Label>
            <Input
              id="ticket-attachment"
              type="file"
              multiple
              onChange={(event) => setAttachments(Array.from(event.target.files || []))}
            />
            {attachments.length ? (
              <div className="space-y-1">
                {attachments.map((attachment) => (
                  <div key={`${attachment.name}-${attachment.size}`} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <FileText className="h-3.5 w-3.5" />
                    <span className="truncate">{attachment.name}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <Field label="Observacao">
            <Textarea value={form.observation} onChange={(event) => updateForm('observation', event.target.value)} rows={3} />
          </Field>
        </form>
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Fechar</Button>
          <Button
            type="button"
            className={cn('gap-2', createMutation.isPending && 'cursor-wait')}
            disabled={!canCreate || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Criar ticket
          </Button>
        </div>
      </div>

      <TicketHistoryDialog
        ticket={historyTicket}
        open={Boolean(historyTicket)}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setHistoryTicket(null);
        }}
      />
    </aside>
  );
}
