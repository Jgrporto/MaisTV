import { requestLocalApi } from '@/lib/local-api';

const requestLocalEntity = async (entityName, { method = 'GET', id = '', body, searchParams } = {}) => {
  const params = new URLSearchParams(searchParams || {});
  const query = params.toString();
  const target = `/entities/${entityName}${id ? `/${id}` : ''}${query ? `?${query}` : ''}`;
  const response = await requestLocalApi(target, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Falha ao acessar ${entityName}.`);
  }

  return payload;
};

export const normalizeQuickReplySchedule = (schedule = {}) => ({
  id: String(schedule.id || `quick-reply-schedule-${Date.now()}`),
  title: String(schedule.title || '').trim(),
  conversationId: String(schedule.conversationId || '').trim(),
  customerId: String(schedule.customerId || '').trim(),
  customerName: String(schedule.customerName || '').trim(),
  customerPhone: String(schedule.customerPhone || '').trim(),
  quickReplyId: String(schedule.quickReplyId || '').trim(),
  scheduledDate: String(schedule.scheduledDate || '').trim(),
  scheduledTime: String(schedule.scheduledTime || '').trim(),
  scheduledAt: String(schedule.scheduledAt || '').trim(),
  windowExpiresAt: String(schedule.windowExpiresAt || '').trim(),
  status: String(schedule.status || 'pending').trim() || 'pending',
  hsmTemplateId: String(schedule.hsmTemplateId || '').trim(),
  hsmTemplateName: String(schedule.hsmTemplateName || '').trim(),
  hsmLanguage: String(schedule.hsmLanguage || 'pt_BR').trim() || 'pt_BR',
  hsmVariables: schedule.hsmVariables && typeof schedule.hsmVariables === 'object' ? schedule.hsmVariables : {},
  hsmMedia: schedule.hsmMedia && typeof schedule.hsmMedia === 'object' ? schedule.hsmMedia : {},
  deliveryType: String(schedule.deliveryType || '').trim(),
  quickReplySnapshot: schedule.quickReplySnapshot && typeof schedule.quickReplySnapshot === 'object' ? schedule.quickReplySnapshot : null,
  conversationSnapshot: schedule.conversationSnapshot && typeof schedule.conversationSnapshot === 'object' ? schedule.conversationSnapshot : {},
  createdBy: String(schedule.createdBy || '').trim(),
  createdByName: String(schedule.createdByName || '').trim(),
  created_date: String(schedule.created_date || new Date().toISOString()),
  updated_date: String(schedule.updated_date || ''),
});

export const createQuickReplySchedule = async (payload) => {
  const schedule = normalizeQuickReplySchedule({
    ...payload,
    id: payload?.id || `quick-reply-schedule-${Date.now()}`,
    status: payload?.status || 'pending',
  });

  const response = await requestLocalEntity('QuickReplySchedule', {
    method: 'POST',
    body: schedule,
  });

  return normalizeQuickReplySchedule(response);
};

export const listQuickReplySchedules = async (searchParams = {}) => {
  const data = await requestLocalEntity('QuickReplySchedule', {
    method: 'GET',
    searchParams: { limit: 50, ...searchParams },
  });
  return Array.isArray(data) ? data.map(normalizeQuickReplySchedule) : [];
};
