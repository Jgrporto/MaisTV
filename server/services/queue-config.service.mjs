import { withTransaction } from '../db/postgres.mjs';
import { deleteQueueConfiguration, listQueueConfigurations, reassignConversationsByLabelMappings, saveQueueConfiguration } from '../repositories/queue-config.repository.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';

const text = (value) => String(value || '').trim();
const strings = (value) => Array.from(new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean)));
const slug = (value) => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const listQueues = async ({ auth }) => (await listQueueConfigurations({ tenantId: auth.tenantId })).map((row) => ({
  id: row.id, name: row.name, description: row.description || '', icon_key: row.icon_key || 'headphones',
  is_active: row.is_active, priority: Number(row.priority || 100), phone_numbers: [],
  label_ids: row.label_ids || [], user_ids: row.user_ids || [], user_emails: row.user_emails || [],
  created_date: row.created_at, updated_date: row.updated_at,
}));

export const saveQueue = async ({ auth, queueId = '', input = {} }) => {
  const name = text(input.name);
  if (!name) throw Object.assign(new Error('Nome da fila e obrigatorio.'), { statusCode: 400 });
  const labelIds = strings(input.label_ids || input.labelIds);
  const userIds = strings(input.user_ids || input.userIds);
  if (!labelIds.length) throw Object.assign(new Error('Selecione ao menos uma etiqueta.'), { statusCode: 400 });
  const id = text(queueId || input.id) || `queue-${slug(name)}`;
  const changedConversations = await withTransaction(async (client) => {
    await saveQueueConfiguration({
      tenantId: auth.tenantId, id, name, description: text(input.description), iconKey: text(input.icon_key || input.iconKey),
      isActive: input.is_active !== false, priority: Math.max(1, Number(input.priority || 100)), labelIds, userIds,
    }, client);
    return reassignConversationsByLabelMappings({ tenantId: auth.tenantId }, client);
  });
  for (const conversation of changedConversations) {
    await publishRealtimeEvent({
      tenantId: auth.tenantId, conversationId: conversation.id, queueId: conversation.queue_id,
      assignedAgentId: conversation.assigned_agent_id, customerPhone: conversation.contact_phone,
      type: 'queue_updated', data: { conversationId: conversation.id, conversation },
    });
  }
  return (await listQueues({ auth })).find((queue) => queue.id === id);
};

export const removeQueue = async ({ auth, queueId }) => {
  const { queue, changedConversations } = await withTransaction(async (client) => {
    const deletedQueue = await deleteQueueConfiguration({ tenantId: auth.tenantId, id: queueId }, client);
    const changed = deletedQueue ? await reassignConversationsByLabelMappings({ tenantId: auth.tenantId }, client) : [];
    return { queue: deletedQueue, changedConversations: changed };
  });
  if (!queue) throw Object.assign(new Error('Fila nao encontrada.'), { statusCode: 404 });
  for (const conversation of changedConversations) {
    await publishRealtimeEvent({
      tenantId: auth.tenantId, conversationId: conversation.id, queueId: conversation.queue_id,
      assignedAgentId: conversation.assigned_agent_id, customerPhone: conversation.contact_phone,
      type: 'queue_updated', data: { conversationId: conversation.id, conversation },
    });
  }
  return { ok: true, id: queueId, deactivated: true };
};
