import { requestLocalApiJson } from '@/lib/local-api';

const toQueryString = (params = {}) => {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : '';
};

export const TICKET_STATUS_LABELS = {
  open: 'Aberto',
  in_analysis: 'Em análise',
  waiting_customer: 'Aguardando cliente',
  resolved: 'Resolvido',
  cancelled: 'Cancelado',
};

export const TICKET_TYPE_LABELS = {
  content_problem: 'Problema de Conteúdo',
  add_content: 'Adicionar Conteúdo',
  activate_app: 'Ativar aplicativo',
};

export const TICKET_PRIORITY_LABELS = {
  low: 'Baixa',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
};

export const listTickets = (filters = {}) =>
  requestLocalApiJson(`/tickets${toQueryString(filters)}`, {}, 'Nao foi possivel carregar tickets.');

export const getTicket = (id) =>
  requestLocalApiJson(`/tickets/${encodeURIComponent(id)}`, {}, 'Nao foi possivel carregar o ticket.');

export const createTicket = (payload) =>
  requestLocalApiJson(
    '/tickets',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    },
    'Nao foi possivel criar o ticket.',
  );

export const updateTicket = (id, payload) =>
  requestLocalApiJson(
    `/tickets/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    },
    'Nao foi possivel atualizar o ticket.',
  );

export const listConversationTickets = (conversationId) =>
  requestLocalApiJson(
    `/tickets/conversation/${encodeURIComponent(conversationId)}`,
    {},
    'Nao foi possivel carregar tickets da conversa.',
  );

export const addTicketComment = (id, content) =>
  requestLocalApiJson(
    `/tickets/${encodeURIComponent(id)}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    },
    'Nao foi possivel comentar no ticket.',
  );

export const addTicketAttachment = (id, attachment) =>
  requestLocalApiJson(
    `/tickets/${encodeURIComponent(id)}/attachments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(attachment || {}),
    },
    'Nao foi possivel anexar arquivo ao ticket.',
  );
