import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  createCustomLabelRecord,
  deleteCustomLabelRecord,
  fetchLabelCatalog,
  importLegacyLabelCatalog,
  normalizeLabelCatalog,
  saveConversationLabelAssignments,
  saveConversationLabelStage,
  updateCustomLabelRecord,
} from './labels-api';
import { queryClientInstance } from './query-client';
import { LABEL_REFRESH_INTERVAL_MS as CONFIGURED_LABEL_REFRESH_INTERVAL_MS } from './performance-config';

const LEGACY_CUSTOM_LABELS_STORAGE_KEY = 'saastv:labels:custom:v1';
const LEGACY_LABEL_ASSIGNMENTS_STORAGE_KEY = 'saastv:labels:assignments:v1';
const LEGACY_STAGE_ASSIGNMENTS_STORAGE_KEY = 'saastv:labels:stages:v1';
const LEGACY_LABEL_MIGRATION_KEY = 'saastv:labels:migrated-to-store:v1';
const LABELS_CHANGE_EVENT = 'saastv:labels:change';
const LABELS_QUERY_KEY = ['labels', 'catalog'];
const DAY_IN_MS = 24 * 60 * 60 * 1000;

export const LABEL_REFRESH_INTERVAL_MS = CONFIGURED_LABEL_REFRESH_INTERVAL_MS;
const LABEL_CATALOG_REFRESH_INTERVAL_MS = LABEL_REFRESH_INTERVAL_MS;

export const SYSTEM_LABELS = [
  {
    id: 'system-lead',
    name: 'Lead',
    description: 'Numero fora da base principal ou presente apenas como trial ainda nao vencido.',
    color: '#F59E0B',
    kind: 'system',
  },
  {
    id: 'system-sql',
    name: 'SQL',
    description: 'Numero presente apenas como trial vencido na base sincronizada.',
    color: '#0F766E',
    kind: 'system',
  },
  {
    id: 'system-cliente',
    name: 'Cliente',
    description: 'Cliente confirmado na base sincronizada, fora da janela de pos-venda e sem vencimento recente.',
    color: '#16A34A',
    kind: 'system',
  },
  {
    id: 'system-pos-venda',
    name: 'Pos-venda',
    description: 'Cliente recente na base sincronizada, dentro da janela de 30 dias.',
    color: '#2563EB',
    kind: 'system',
  },
  {
    id: 'system-cancelados',
    name: 'Cancelados',
    description: 'Cliente vencido ha pelo menos 1 dia.',
    color: '#F97316',
    kind: 'system',
  },
];

const SYSTEM_LABELS_BY_ID = new Map(SYSTEM_LABELS.map((label) => [label.id, label]));
const SERVICE_ROUTING_LABEL_IDS = new Set([
  ...SYSTEM_LABELS.map((label) => label.id),
  'label-lead',
  'label-sql',
  'label-customer',
  'label-churn',
]);

const LEGACY_LABEL_ID_TO_CANONICAL = Object.freeze({
  'label-lead': 'system-lead',
  'label-sql': 'system-sql',
  'label-customer': 'system-cliente',
  'label-churn': 'system-cancelados',
});

const canonicalizeLabelId = (value) => {
  const safeId = String(value || '').trim();
  return LEGACY_LABEL_ID_TO_CANONICAL[safeId] || safeId;
};

const normalizeLabelIdArray = (value) =>
  Array.from(new Set((Array.isArray(value) ? value : []).map((item) => canonicalizeLabelId(item)).filter(Boolean)));

const EMPTY_SNAPSHOT = normalizeLabelCatalog({});
let legacyMigrationPromise = null;
let legacyMigrationResolved = false;

const canUseStorage = () => typeof window !== 'undefined' && Boolean(window.localStorage);

const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');

function normalizeHexColor(value, fallback = '#14B8A6') {
  const raw = String(value || '').trim();
  const compact = raw.startsWith('#') ? raw.slice(1) : raw;

  if (/^[0-9a-fA-F]{6}$/.test(compact)) {
    return `#${compact.toUpperCase()}`;
  }

  if (/^[0-9a-fA-F]{3}$/.test(compact)) {
    return `#${compact
      .split('')
      .map((char) => `${char}${char}`)
      .join('')
      .toUpperCase()}`;
  }

  return fallback;
}

function hexToRgba(hexColor, alpha) {
  const hex = normalizeHexColor(hexColor).slice(1);
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function normalizeCustomLabel(label = {}, index = 0) {
  const now = new Date().toISOString();

  return {
    id: String(label.id || `custom-label-${Date.now()}-${index + 1}`),
    name: String(label.name || label.title || '').trim(),
    description: String(label.description || '').trim(),
    color: normalizeHexColor(label.color || '#14B8A6'),
    kind: 'custom',
    createdAt: String(label.createdAt || now),
    updatedAt: String(label.updatedAt || now),
  };
}

function sortLabels(labels) {
  return [...labels].sort((left, right) =>
    String(left?.name || '').localeCompare(String(right?.name || ''), 'pt-BR', {
      sensitivity: 'base',
    })
  );
}

function readLegacyCustomLabelsSnapshot() {
  if (!canUseStorage()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_CUSTOM_LABELS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return sortLabels(
      parsed
        .map((item, index) => normalizeCustomLabel(item, index))
        .filter((item) => item.name)
    );
  } catch {
    return [];
  }
}

function readLegacyAssignmentsSnapshot() {
  if (!canUseStorage()) {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_LABEL_ASSIGNMENTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.entries(parsed).reduce((accumulator, [conversationId, labelIds]) => {
      const safeIds = Array.isArray(labelIds)
        ? Array.from(new Set(labelIds.map((value) => String(value || '').trim()).filter(Boolean)))
        : [];

      if (safeIds.length > 0) {
        accumulator[String(conversationId)] = safeIds;
      }

      return accumulator;
    }, {});
  } catch {
    return {};
  }
}

function readLegacyStageAssignmentsSnapshot() {
  if (!canUseStorage()) {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_STAGE_ASSIGNMENTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.entries(parsed).reduce((accumulator, [conversationId, labelId]) => {
      const safeConversationId = String(conversationId || '').trim();
      const safeLabelId = String(labelId || '').trim();

      if (safeConversationId && safeLabelId) {
        accumulator[safeConversationId] = safeLabelId;
      }

      return accumulator;
    }, {});
  } catch {
    return {};
  }
}

function emitLabelsChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(LABELS_CHANGE_EVENT));
}

function readLegacyLabelSnapshot() {
  return {
    customLabels: readLegacyCustomLabelsSnapshot(),
    assignments: readLegacyAssignmentsSnapshot(),
    stageAssignments: readLegacyStageAssignmentsSnapshot(),
  };
}

function hasLegacyLabelData(snapshot) {
  return (
    snapshot.customLabels.length > 0 ||
    Object.keys(snapshot.assignments).length > 0 ||
    Object.keys(snapshot.stageAssignments).length > 0
  );
}

async function refreshLabelCatalog() {
  await queryClientInstance.invalidateQueries({ queryKey: LABELS_QUERY_KEY });
  emitLabelsChange();
}

async function migrateLegacyLabelsIfNeeded() {
  if (!canUseStorage() || legacyMigrationResolved) {
    return null;
  }

  if (window.localStorage.getItem(LEGACY_LABEL_MIGRATION_KEY) === '1') {
    legacyMigrationResolved = true;
    return null;
  }

  const legacySnapshot = readLegacyLabelSnapshot();
  if (!hasLegacyLabelData(legacySnapshot)) {
    window.localStorage.setItem(LEGACY_LABEL_MIGRATION_KEY, '1');
    legacyMigrationResolved = true;
    return null;
  }

  if (!legacyMigrationPromise) {
    legacyMigrationPromise = importLegacyLabelCatalog(legacySnapshot)
      .then((nextSnapshot) => {
        window.localStorage.setItem(LEGACY_LABEL_MIGRATION_KEY, '1');
        legacyMigrationResolved = true;
        return normalizeLabelCatalog(nextSnapshot);
      })
      .catch((error) => {
        legacyMigrationPromise = null;
        throw error;
      });
  }

  return await legacyMigrationPromise;
}

function parseDate(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    const brazilianDate = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (brazilianDate) {
      const [, day, month, year, hour = '00', minute = '00', second = '00'] = brazilianDate;
      const parsedBrazilianDate = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      );
      return Number.isNaN(parsedBrazilianDate.getTime()) ? null : parsedBrazilianDate;
    }

    return null;
  }

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toBooleanFlag(value) {
  if (typeof value === 'boolean') return value;

  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  return ['1', 'true', 'yes', 'sim', 'trial', 'teste'].includes(normalized);
}

function resolveConversationTrialFlag(conversation, customerRow) {
  if (customerRow) {
    return !customerRow.hasConfirmedCustomer && Boolean(customerRow.sourceRows?.some((row) => row?.isTest));
  }

  return toBooleanFlag(
    conversation?.customer?.is_trial ??
      conversation?.customer?.isTrial ??
      conversation?.sourceConversation?.customer?.is_trial ??
      conversation?.sourceConversation?.customer?.isTrial
  );
}

function differenceInCalendarDaysFromToday(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const valueStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  return Math.floor((todayStart.getTime() - valueStart.getTime()) / DAY_IN_MS);
}

function findCreationDateInObject(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) {
    return null;
  }

  const keys = [
    'created_at',
    'createdAt',
    'created_date',
    'createdDate',
    'creation_date',
    'creationDate',
    'registered_at',
    'registeredAt',
    'cadastro',
    'data_cadastro',
  ];

  for (const key of keys) {
    const parsed = parseDate(value?.[key]);
    if (parsed) {
      return parsed;
    }
  }

  for (const key of ['raw', 'user', 'customer', 'account', 'profile']) {
    const parsed = findCreationDateInObject(value?.[key], depth + 1);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function resolveCustomerCreatedDate(customerRow) {
  return findCreationDateInObject(customerRow?.sourceCustomer || customerRow);
}

export function getLabelBadgeStyle(label) {
  const color = normalizeHexColor(label?.color || '#14B8A6');

  return {
    color,
    borderColor: hexToRgba(color, 0.28),
    backgroundColor: hexToRgba(color, 0.12),
  };
}

export function listCustomLabels() {
  const snapshot = normalizeLabelCatalog(queryClientInstance.getQueryData(LABELS_QUERY_KEY));
  return snapshot.customLabels;
}

export function getLabelById(labelId, customLabels = listCustomLabels()) {
  const safeLabelId = canonicalizeLabelId(labelId);
  if (SYSTEM_LABELS_BY_ID.has(safeLabelId)) {
    return SYSTEM_LABELS_BY_ID.get(safeLabelId) || null;
  }

  return customLabels.find((label) => label.id === safeLabelId) || null;
}

export async function saveCustomLabel(payload, existingId = null) {
  const nextLabel = existingId
    ? await updateCustomLabelRecord(existingId, payload)
    : await createCustomLabelRecord(payload);

  await refreshLabelCatalog();
  return nextLabel;
}

export async function deleteCustomLabel(labelId) {
  const safeLabelId = String(labelId || '').trim();
  if (!safeLabelId) return;

  await deleteCustomLabelRecord(safeLabelId);
  await refreshLabelCatalog();
}

export async function toggleConversationCustomLabel(conversationId, labelId, enabled) {
  const safeConversationId = String(conversationId || '').trim();
  const safeLabelId = String(labelId || '').trim();

  if (!safeConversationId || !safeLabelId) {
    return [];
  }

  const snapshot = normalizeLabelCatalog(queryClientInstance.getQueryData(LABELS_QUERY_KEY));
  const currentIds = new Set(snapshot.assignments[safeConversationId] || []);
  const shouldEnable = typeof enabled === 'boolean' ? enabled : !currentIds.has(safeLabelId);

  if (shouldEnable) {
    currentIds.add(safeLabelId);
  } else {
    currentIds.delete(safeLabelId);
  }

  const nextLabelIds = Array.from(currentIds);
  await saveConversationLabelAssignments(safeConversationId, nextLabelIds);
  await refreshLabelCatalog();
  return nextLabelIds;
}

export async function saveConversationStageLabel(conversationId, labelId, customLabels = listCustomLabels()) {
  const safeConversationId = String(conversationId || '').trim();
  const safeLabelId = String(labelId || '').trim();

  if (!safeConversationId) {
    return null;
  }

  if (!safeLabelId) {
    await saveConversationLabelStage(safeConversationId, '');
    await refreshLabelCatalog();
    return null;
  }

  const targetLabel = getLabelById(safeLabelId, customLabels);
  if (!targetLabel) {
    return null;
  }

  if (targetLabel.kind !== 'custom') {
    await saveConversationLabelStage(safeConversationId, '');
    await refreshLabelCatalog();
    return targetLabel;
  }

  await saveConversationLabelStage(safeConversationId, safeLabelId);
  await refreshLabelCatalog();
  return targetLabel;
}

function resolveAutomaticLabel(conversation, customerRow) {
  if (!customerRow) {
    return SYSTEM_LABELS_BY_ID.get('system-lead') || null;
  }

  if (customerRow.hasConfirmedCustomer) {
    const overdueDays = differenceInCalendarDaysFromToday(customerRow?.dueDate);

    if (Number.isFinite(overdueDays) && overdueDays >= 1) {
      return SYSTEM_LABELS_BY_ID.get('system-cancelados') || null;
    }

    const createdAt = resolveCustomerCreatedDate(customerRow);
    const accountAgeInDays = differenceInCalendarDaysFromToday(createdAt);

    if (Number.isFinite(accountAgeInDays) && accountAgeInDays >= 0 && accountAgeInDays <= 30) {
      return SYSTEM_LABELS_BY_ID.get('system-pos-venda') || null;
    }

    return SYSTEM_LABELS_BY_ID.get('system-cliente') || null;
  }

  if (customerRow.hasExpiredTrial) {
    return SYSTEM_LABELS_BY_ID.get('system-sql') || null;
  }

  return SYSTEM_LABELS_BY_ID.get('system-lead') || null;
}

function buildPhoneLookupKeys(value) {
  const digits = normalizePhoneDigits(value);
  if (!digits) {
    return [];
  }

  const keys = new Set([digits]);

  if (digits.startsWith('55') && digits.length > 11) {
    keys.add(digits.slice(2));
  }

  if (digits.length >= 11) {
    keys.add(digits.slice(-11));
  }

  if (digits.length >= 10) {
    keys.add(digits.slice(-10));
  }

  return Array.from(keys).filter(Boolean);
}

function selectMostRecentCustomer(rows = []) {
  return [...rows].sort((left, right) => {
    const leftDueDate = left?.dueDate instanceof Date ? left.dueDate.getTime() : 0;
    const rightDueDate = right?.dueDate instanceof Date ? right.dueDate.getTime() : 0;
    return rightDueDate - leftDueDate;
  })[0] || null;
}

function buildCustomerLookup(customerRows = []) {
  const groupedByPhone = new Map();

  customerRows.forEach((customer) => {
    const phoneKeys = buildPhoneLookupKeys(customer?.phoneDigits || customer?.whatsapp);
    const primaryKey = phoneKeys[0];
    if (!primaryKey) return;
    const current = groupedByPhone.get(primaryKey) || [];
    current.push(customer);
    groupedByPhone.set(primaryKey, current);
  });

  const lookup = new Map();
  groupedByPhone.forEach((rows) => {
    const confirmedRows = rows.filter((row) => !row?.isTest);
    const trialRows = rows.filter((row) => Boolean(row?.isTest));
    const canonicalRow = selectMostRecentCustomer(confirmedRows) || selectMostRecentCustomer(trialRows);
    if (!canonicalRow) return;
    const aggregateRow = {
      ...canonicalRow,
      hasConfirmedCustomer: confirmedRows.length > 0,
      hasExpiredTrial: trialRows.some((row) => String(row?.status || '').trim().toUpperCase() === 'EXPIRED'),
      sourceRows: rows,
    };
    buildPhoneLookupKeys(canonicalRow?.phoneDigits || canonicalRow?.whatsapp).forEach((key) => {
      lookup.set(key, aggregateRow);
    });
  });

  return lookup;
}

function findCustomerByConversationPhone(customerLookup, phone) {
  for (const key of buildPhoneLookupKeys(phone)) {
    const customer = customerLookup.get(key);
    if (customer) {
      return customer;
    }
  }

  return null;
}

export function enrichConversationsWithLabels(conversations = [], customerRows = [], options = {}) {
  const safeConversations = Array.isArray(conversations) ? conversations : [];
  const snapshot = normalizeLabelCatalog(queryClientInstance.getQueryData(LABELS_QUERY_KEY));
  const customLabels = Array.isArray(options.customLabels) ? options.customLabels : snapshot.customLabels;
  const assignments = options.assignments && typeof options.assignments === 'object' ? options.assignments : snapshot.assignments;
  const stageAssignments =
    options.stageAssignments && typeof options.stageAssignments === 'object'
      ? options.stageAssignments
      : snapshot.stageAssignments;
  const customerLookup = buildCustomerLookup(customerRows);
  const customLabelsById = new Map(customLabels.map((label) => [label.id, label]));
  const serviceRoutingLabelIds = new Set(normalizeLabelIdArray(options.serviceRoutingLabelIds || []));

  return safeConversations.map((conversation) => {
    const matchedCustomer = findCustomerByConversationPhone(customerLookup, conversation?.contact_phone);
    const serviceOverrideLabelId = canonicalizeLabelId(
      conversation?.service_label_override_id || conversation?.serviceLabelOverrideId || ''
    );
    const serviceOverrideLabel = serviceOverrideLabelId ? getLabelById(serviceOverrideLabelId, customLabels) : null;
    const automaticLabel = serviceOverrideLabel || resolveAutomaticLabel(conversation, matchedCustomer);
    const existingLabelIds = normalizeLabelIdArray([
      ...(Array.isArray(conversation?.label_ids) ? conversation.label_ids : []),
      ...(Array.isArray(conversation?.labelIds) ? conversation.labelIds : []),
    ]).filter((labelId) => {
      if (!serviceOverrideLabelId) return true;
      return labelId === serviceOverrideLabelId || (!SERVICE_ROUTING_LABEL_IDS.has(labelId) && !serviceRoutingLabelIds.has(labelId));
    });
    const existingLabels = existingLabelIds.map((labelId) => getLabelById(labelId, customLabels)).filter(Boolean);
    const assignedCustomLabels = (assignments[conversation.id] || [])
      .map((labelId) => customLabelsById.get(labelId))
      .filter((label) => {
        if (!label) return false;
        if (!serviceOverrideLabelId) return true;
        return label.id === serviceOverrideLabelId || !serviceRoutingLabelIds.has(label.id);
      });
    const assignedStageLabel = getLabelById(stageAssignments[conversation.id], customLabels);
    const stageLabel =
      assignedStageLabel?.kind === 'custom'
        ? assignedStageLabel
        : automaticLabel || assignedCustomLabels[0] || null;
    const visibleLabels = Array.from(
      new Map(
        [automaticLabel, ...existingLabels, ...assignedCustomLabels]
          .filter(Boolean)
          .map((label) => [label.id, label])
      ).values()
    );
    const isTrial = resolveConversationTrialFlag(conversation, matchedCustomer);
    const customerPassword =
      matchedCustomer?.password ||
      matchedCustomer?.senha ||
      conversation.customer?.password ||
      conversation.customer?.senha ||
      '';

    return {
      ...conversation,
      matched_customer: matchedCustomer,
      system_label: automaticLabel,
      custom_labels: assignedCustomLabels,
      visible_labels: visibleLabels,
      label_ids: normalizeLabelIdArray([...existingLabelIds, ...visibleLabels.map((label) => label.id)]),
      stage_label: stageLabel,
      stage_label_id: stageLabel?.id || '',
      primary_label: stageLabel || automaticLabel || assignedCustomLabels[0] || null,
      customer: {
        ...(conversation.customer || {}),
        existsInBase: Boolean(matchedCustomer),
        isTeste: Boolean(isTrial),
        username: matchedCustomer?.username || conversation.customer?.username || '',
        password: customerPassword,
        senha: customerPassword,
        plan: matchedCustomer?.planName || conversation.customer?.plan || '',
        planStatus: matchedCustomer?.statusLabel || conversation.customer?.planStatus || '',
        paymentStatus: matchedCustomer?.statusLabel || conversation.customer?.paymentStatus || '',
        dueDateLabel: matchedCustomer?.dueDateLabel || '',
      },
    };
  });
}

export function buildLabelSummary(conversations = [], customLabels = []) {
  const counts = new Map();
  const catalog = [...SYSTEM_LABELS, ...sortLabels(customLabels)];

  catalog.forEach((label) => counts.set(label.id, 0));

  conversations.forEach((conversation) => {
    const labelIds = Array.isArray(conversation?.label_ids) ? conversation.label_ids : [];

    labelIds.forEach((labelId) => {
      counts.set(labelId, (counts.get(labelId) || 0) + 1);
    });
  });

  return catalog.map((label) => ({
    ...label,
    count: counts.get(label.id) || 0,
  }));
}

export function conversationHasLabel(conversation, labelId) {
  if (!labelId || labelId === 'all') {
    return true;
  }

  const labelIds = Array.isArray(conversation?.label_ids) ? conversation.label_ids : [];
  return labelIds.includes(labelId);
}

export function useLabelCatalog() {
  const query = useQuery({
    queryKey: LABELS_QUERY_KEY,
    queryFn: fetchLabelCatalog,
    staleTime: 10000,
    refetchInterval: LABEL_CATALOG_REFRESH_INTERVAL_MS,
  });

  useEffect(() => {
    void migrateLegacyLabelsIfNeeded()
      .then((migratedSnapshot) => {
        if (!migratedSnapshot) {
          return;
        }

        queryClientInstance.setQueryData(LABELS_QUERY_KEY, migratedSnapshot);
        emitLabelsChange();
      })
      .catch(() => {});
  }, []);

  return normalizeLabelCatalog(query.data || EMPTY_SNAPSHOT);
}
