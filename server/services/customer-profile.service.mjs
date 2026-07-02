import { withTransaction } from '../db/postgres.mjs';
import {
  applyProfileToConversations,
  applyAllProfilesToConversations,
  getCustomerProfile,
  resolveQueueForLabel,
  upsertCustomerProfile,
  upsertCustomerProfilesBulk,
} from '../repositories/customer-profiles.repository.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
import { normalizePhone } from '../utils/phone-normalization.mjs';

export const STANDARD_LABELS = Object.freeze({
  CANCELLED: 'system-cancelados',
  POST_SALE: 'system-pos-venda',
  CUSTOMER: 'system-cliente',
  SQL: 'system-sql',
  LEAD: 'system-lead',
});

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const rawOf = (row) => row?.raw && typeof row.raw === 'object' ? row.raw : {};
const first = (row, keys) => {
  const raw = rawOf(row);
  for (const key of keys) {
    const value = row?.[key] ?? raw?.[key];
    if (value !== undefined && value !== null && text(value)) return value;
  }
  return null;
};
const dateValue = (value) => {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const truthy = (value) => value === true || ['1', 'true', 'yes', 'sim'].includes(text(value).toLowerCase());

export const isTrialCustomerRow = (row = {}) => {
  const explicit = first(row, ['is_trial', 'isTrial', 'trial', 'teste']);
  if (explicit !== null) return truthy(explicit);
  return /\b(trial|teste|test)\b/i.test(text(first(row, ['package', 'package_name', 'packageName', 'plan', 'plano'])));
};

export const classifyCustomerRows = (rows = [], now = new Date()) => {
  const safeRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const confirmed = safeRows.find((row) => !isTrialCustomerRow(row)) || null;
  const trial = safeRows.find((row) => isTrialCustomerRow(row)) || null;
  if (confirmed) {
    const dueDate = dateValue(first(confirmed, ['expires_at', 'due_date', 'expiration_date', 'vencimento']));
    const createdAt = dateValue(first(confirmed, ['created_at', 'createdAt', 'created_date', 'installationDate', 'installedAt', 'synced_at']));
    const dueMs = Date.parse(String(dueDate || ''));
    const createdMs = Date.parse(String(createdAt || ''));
    const dayMs = 86_400_000;
    if (Number.isFinite(dueMs) && now.getTime() >= dueMs + dayMs) {
      return { label: STANDARD_LABELS.CANCELLED, reason: 'confirmed_customer_due_at_least_one_day', confirmed, trial, dueDate, createdAt };
    }
    const isNotExpired = !Number.isFinite(dueMs) || dueMs >= now.getTime();
    if (isNotExpired && Number.isFinite(createdMs) && now.getTime() >= createdMs && now.getTime() - createdMs <= 30 * dayMs) {
      return { label: STANDARD_LABELS.POST_SALE, reason: 'confirmed_customer_created_within_30_days', confirmed, trial, dueDate, createdAt };
    }
    return { label: STANDARD_LABELS.CUSTOMER, reason: 'confirmed_customer', confirmed, trial, dueDate, createdAt };
  }
  if (trial && upper(first(trial, ['status', 'trial_status', 'state'])) === 'EXPIRED') {
    return { label: STANDARD_LABELS.SQL, reason: 'expired_trial_only', confirmed: null, trial };
  }
  return { label: STANDARD_LABELS.LEAD, reason: trial ? 'non_expired_trial_only' : 'phone_not_found', confirmed: null, trial };
};

const customerId = (row) => text(first(row, ['id', 'customer_id', 'customerId', 'sync_key'])) || null;

export const ensureLeadCustomerProfile = async ({ tenantId, phone, executor = null }) => {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw Object.assign(new Error('Telefone do cliente invalido.'), { statusCode: 422 });
  const existing = await getCustomerProfile({ tenantId, normalizedPhone }, executor);
  if (existing) return existing;
  return upsertCustomerProfile({
    tenantId, normalizedPhone, displayPhone: phone, standardLabel: STANDARD_LABELS.LEAD,
    standardLabelSource: 'automatic', standardLabelReason: 'phone_not_found', lastSyncedAt: new Date().toISOString(),
  }, executor);
};

export const resolveOperationalProfile = async ({ tenantId, phone, executor = null }) => {
  const normalizedPhone = normalizePhone(phone);
  const profile = await ensureLeadCustomerProfile({ tenantId, phone, executor });
  const queue = await resolveQueueForLabel({ tenantId, labelKey: profile.standard_label }, executor);
  return { normalizedPhone, profile, queue };
};

export const syncCustomerProfilesFromRows = async ({ tenantId, rows, syncedAt = new Date().toISOString() }) => {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const phone = first(row, ['phone_digits', 'whatsapp', 'phone', 'telefone', 'phone_number']);
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) continue;
    if (!groups.has(normalizedPhone)) groups.set(normalizedPhone, []);
    groups.get(normalizedPhone).push(row);
  }
  const profiles = [];
  for (const [normalizedPhone, customerRows] of groups) {
    const classification = classifyCustomerRows(customerRows);
    profiles.push({
      normalized_phone: normalizedPhone,
      display_phone: first(customerRows[0], ['whatsapp', 'phone_digits', 'phone']),
      standard_label: classification.label,
      standard_label_source: 'automatic',
      standard_label_reason: classification.reason,
      confirmed_customer_id: customerId(classification.confirmed),
      trial_id: customerId(classification.trial),
      trial_status: classification.trial ? upper(first(classification.trial, ['status', 'trial_status', 'state'])) : null,
      customer_due_date: classification.dueDate || null,
      customer_created_at: classification.createdAt || null,
      last_synced_at: syncedAt,
    });
  }
  let changedConversations = [];
  await withTransaction(async (client) => {
    await upsertCustomerProfilesBulk({ tenantId, profiles }, client);
    changedConversations = await applyAllProfilesToConversations({ tenantId }, client);
  });
  for (const conversation of changedConversations) {
    await publishRealtimeEvent({
      tenantId, conversationId: conversation.id, queueId: conversation.queue_id,
      assignedAgentId: conversation.assigned_agent_id, customerPhone: conversation.contact_phone,
      type: 'conversation_updated', data: { conversationId: conversation.id, conversation },
    });
  }
  return { profiles: groups.size, updatedConversations: changedConversations.length };
};

export const overrideStandardLabel = async ({ tenantId, phone, label, actorUserId }) => {
  if (!Object.values(STANDARD_LABELS).includes(label)) {
    throw Object.assign(new Error('Etiqueta padrao invalida.'), { statusCode: 400 });
  }
  const result = await withTransaction(async (client) => {
    const normalizedPhone = normalizePhone(phone);
    const existing = await ensureLeadCustomerProfile({ tenantId, phone, executor: client });
    const profile = (await client.query(`
      UPDATE customer_profiles SET standard_label=$3,standard_label_source='manual',
        standard_label_reason=$4,standard_label_overridden=true,standard_label_updated_at=now(),updated_at=now()
      WHERE tenant_id=$1 AND normalized_phone=$2 RETURNING *
    `, [tenantId, normalizedPhone, label, `manual_override:${text(actorUserId) || 'unknown'}`])).rows[0] || existing;
    const queue = await resolveQueueForLabel({ tenantId, labelKey: profile.standard_label }, client);
    const conversations = await applyProfileToConversations({ tenantId, normalizedPhone, profile, queue }, client);
    return { profile, conversations };
  });
  for (const conversation of result.conversations) {
    await publishRealtimeEvent({
      tenantId, conversationId: conversation.id, queueId: conversation.queue_id,
      assignedAgentId: conversation.assigned_agent_id, customerPhone: conversation.contact_phone,
      type: 'conversation_updated', data: { conversationId: conversation.id, conversation },
    });
  }
  return result;
};
