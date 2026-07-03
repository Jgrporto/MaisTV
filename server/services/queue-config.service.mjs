import { withTransaction } from '../db/postgres.mjs';
import { deleteQueueConfiguration, listQueueConfigurations, reassignConversationsByLabelMappings, saveQueueConfiguration } from '../repositories/queue-config.repository.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';

const text = (value) => String(value || '').trim();
const strings = (value) => Array.from(new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean)));
const slug = (value) => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const queueListCache = new Map();
const queueListInFlight = new Map();
const queueCacheGeneration = new Map();

const clearQueueListCache = (tenantId) => {
  const key = String(tenantId || '').trim();
  queueListCache.delete(key);
  queueListInFlight.delete(key);
  queueCacheGeneration.set(key, (queueCacheGeneration.get(key) || 0) + 1);
};

export const clearQueueCaches = () => {
  queueListCache.clear();
  queueListInFlight.clear();
  queueCacheGeneration.clear();
};

export const listQueues = async ({ auth }) => {
  const tenantId = String(auth.tenantId || '').trim();
  const cached = queueListCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  if (queueListInFlight.has(tenantId)) return queueListInFlight.get(tenantId);
  const generation = queueCacheGeneration.get(tenantId) || 0;
  const pending = listQueueConfigurations({ tenantId })
    .then((rows) => rows.map((row) => ({
      id: row.id, name: row.name, description: row.description || '', icon_key: row.icon_key || 'headphones',
      is_active: row.is_active, priority: Number(row.priority || 100), phone_numbers: [],
      label_ids: row.label_ids || [], user_ids: row.user_ids || [], user_emails: row.user_emails || [],
      created_date: row.created_at, updated_date: row.updated_at,
    })))
    .then((items) => {
      const ttlMs = Math.max(1000, Number(process.env.QUEUE_LIST_CACHE_MS || 10000));
      if ((queueCacheGeneration.get(tenantId) || 0) === generation) {
        queueListCache.set(tenantId, { expiresAt: Date.now() + ttlMs, items });
      }
      return items;
    })
    .finally(() => {
      if (queueListInFlight.get(tenantId) === pending) queueListInFlight.delete(tenantId);
    });
  queueListInFlight.set(tenantId, pending);
  return pending;
};

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
  clearQueueListCache(auth.tenantId);
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
  clearQueueListCache(auth.tenantId);
  return { ok: true, id: queueId, deactivated: true };
};
