import "dotenv/config";
import crypto from "node:crypto";
import { readSqlStoreValue, upsertSqlStoreValue } from "./sql-store.js";

const STORE_KEY = "main_store";
const DEFAULT_LABELS_REFRESH_INTERVAL_MS = Number.parseInt(
  process.env.LABELS_DEFAULT_REFRESH_INTERVAL_MS || "1800000",
  10,
);

const DEFAULT_LABELS = [
  {
    id: "label-customer",
    systemKey: "customer",
    name: "Cliente",
    color: "#22C55E",
    visibleInFilter: true,
    isDefault: true,
    manualAssignable: false,
    sortOrder: 10,
  },
  {
    id: "label-lead",
    systemKey: "lead",
    name: "Lead",
    color: "#F59E0B",
    visibleInFilter: true,
    isDefault: true,
    manualAssignable: true,
    sortOrder: 20,
  },
  {
    id: "label-sql",
    systemKey: "sql",
    name: "SQL",
    color: "#0F766E",
    visibleInFilter: true,
    isDefault: true,
    manualAssignable: false,
    sortOrder: 25,
  },
  {
    id: "label-lead-test",
    systemKey: "lead_test",
    name: "Lead TESTE",
    color: "#EF4444",
    visibleInFilter: false,
    isDefault: true,
    manualAssignable: false,
    sortOrder: 30,
  },
  {
    id: "label-promoter",
    systemKey: "promoter",
    name: "PROMOTOR",
    color: "#22C55E",
    visibleInFilter: false,
    isDefault: true,
    manualAssignable: true,
    sortOrder: 40,
  },
  {
    id: "label-churn",
    systemKey: "churn",
    name: "Cancelados",
    color: "#F97316",
    visibleInFilter: true,
    isDefault: true,
    manualAssignable: false,
    sortOrder: 50,
  },
];

const nowIso = () => new Date().toISOString();
const randomId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const normalizePhone = (value) => String(value || "").replace(/\D/g, "");
const normalizeLabelNameKey = (value) => String(value || "").trim().toLowerCase();

const clone = (value) => {
  if (value == null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
};

const normalizeHexColor = (value, fallback = "#64748B") => {
  const normalized = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) return normalized.toUpperCase();
  return fallback;
};

const normalizeCampaignConfig = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? clone(value) : {};

const normalizeLabel = (label, index = 0) => {
  const id = String(label?.id || label?.systemKey || randomId("label")).trim();
  const name = String(label?.name || label?.title || "").trim();
  return {
    id,
    systemKey: label?.systemKey ? String(label.systemKey).trim() : null,
    name: name || "Etiqueta",
    color: normalizeHexColor(label?.color),
    visibleInFilter: label?.visibleInFilter !== false,
    isDefault: Boolean(label?.isDefault || label?.default || label?.systemKey),
    manualAssignable: Boolean(label?.manualAssignable),
    campaignConfig: normalizeCampaignConfig(label?.campaignConfig),
    sortOrder: Number.isFinite(Number(label?.sortOrder)) ? Number(label.sortOrder) : 1000 + index,
    createdAt: label?.createdAt || label?.created_at || nowIso(),
    updatedAt: label?.updatedAt || label?.updated_at || nowIso(),
  };
};

const emptyMainStore = () => ({
  labels: {
    customLabels: [],
    assignments: {},
    stageAssignments: {},
    updatedAt: null,
  },
  customers: [],
  conversations: {},
});

const readMainStore = async () => {
  const result = await readSqlStoreValue(STORE_KEY);
  const payload = result?.payload && typeof result.payload === "object" ? result.payload : emptyMainStore();
  return {
    ...emptyMainStore(),
    ...payload,
    labels: {
      ...emptyMainStore().labels,
      ...(payload.labels && typeof payload.labels === "object" ? payload.labels : {}),
    },
  };
};

const writeMainStore = async (store) => {
  await upsertSqlStoreValue(STORE_KEY, store && typeof store === "object" ? store : emptyMainStore());
};

const normalizeLabelState = (store) => {
  const state = store.labels && typeof store.labels === "object" ? store.labels : {};
  return {
    customLabels: Array.isArray(state.customLabels) ? state.customLabels : [],
    assignments: state.assignments && typeof state.assignments === "object" ? state.assignments : {},
    stageAssignments:
      state.stageAssignments && typeof state.stageAssignments === "object" ? state.stageAssignments : {},
    updatedAt: state.updatedAt || null,
  };
};

const listLabelsFromStore = (store) => {
  const state = normalizeLabelState(store);
  const byId = new Map();
  DEFAULT_LABELS.forEach((label, index) => byId.set(label.id, normalizeLabel(label, index)));
  state.customLabels.forEach((label, index) => {
    const normalized = normalizeLabel(label, index);
    byId.set(normalized.id, normalized);
  });
  return Array.from(byId.values()).sort(
    (left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0) || left.name.localeCompare(right.name),
  );
};

const saveLabelState = async (store, state) => {
  store.labels = {
    customLabels: Array.isArray(state.customLabels) ? state.customLabels : [],
    assignments: state.assignments && typeof state.assignments === "object" ? state.assignments : {},
    stageAssignments:
      state.stageAssignments && typeof state.stageAssignments === "object" ? state.stageAssignments : {},
    updatedAt: nowIso(),
  };
  await writeMainStore(store);
};

const getCustomersArray = (store) => {
  const customers = store.customers;
  if (Array.isArray(customers)) return customers;
  if (customers && typeof customers === "object") return Object.values(customers);
  return [];
};

const getConversationsArray = (store) => {
  const conversations = store.conversations;
  if (Array.isArray(conversations)) return conversations;
  if (conversations && typeof conversations === "object") return Object.values(conversations);
  return [];
};

const buildPhoneLookupKeys = (value) => {
  const digits = normalizePhone(value);
  if (!digits) return [];
  const keys = new Set([digits]);
  if (digits.startsWith("55") && digits.length > 11) keys.add(digits.slice(2));
  if (digits.length >= 11) keys.add(digits.slice(-11));
  if (digits.length >= 10) keys.add(digits.slice(-10));
  return Array.from(keys).filter(Boolean);
};

const buildLookupKey = (row) => {
  const phone = normalizePhone(row?.phone_digits || row?.number || row?.phone || row?.whatsapp || row?.waId || row?.wa_id || "");
  if (phone) return `phone:${phone}`;
  const customerId = String(row?.customerId || row?.id || row?.username || row?.usuario || "").trim();
  return customerId ? `missing:${customerId}` : `missing:${crypto.randomUUID()}`;
};

const buildContactFromRow = (row, fallback = {}, options = {}) => {
  const defaultExistsInBase = options.defaultExistsInBase !== false;
  const phone = normalizePhone(
    row?.phone_digits ||
      row?.number ||
      row?.phone ||
      row?.whatsapp ||
      row?.waId ||
      row?.wa_id ||
      fallback?.phone_digits ||
      fallback?.number ||
      ""
  );
  const lookupKey = buildLookupKey({ ...fallback, ...row });
  return {
    id: String(row?.contactId || row?.id || fallback?.id || lookupKey),
    lookupKey,
    name: String(row?.name || row?.customerName || row?.nome || fallback?.name || ""),
    number: phone || "n/a",
    existsInBase: Boolean(row?.existsInBase ?? row?.exists_in_base ?? defaultExistsInBase),
    isTeste: Boolean(row?.isTeste ?? row?.is_teste ?? row?.trial ?? row?.isTrial ?? row?.is_trial),
    conversationId: row?.conversationId || row?.conversation_id || fallback?.conversationId || null,
    lastInteractionAt: row?.lastInteractionAt || row?.last_interaction_at || row?.updated_date || null,
    lastClientMessageAt: row?.lastClientMessageAt || row?.last_client_message_at || null,
    createdAtExternal: row?.createdAtExternal || row?.created_at_external || row?.createdAt || row?.created_at || null,
    expiresAtExternal:
      row?.expiresAtExternal || row?.expires_at_external || row?.expiresAt || row?.expires_at || row?.vencimento || null,
    status: row?.status || row?.status_label || null,
    situacao: row?.situacao || null,
    notes: row?.notes || row?.note || row?.observacao || null,
  };
};

const selectMostRecentContact = (rows = []) =>
  [...rows].sort((left, right) => {
    const leftTime = Date.parse(left?.expiresAtExternal || left?.lastInteractionAt || left?.createdAtExternal || "") || 0;
    const rightTime = Date.parse(right?.expiresAtExternal || right?.lastInteractionAt || right?.createdAtExternal || "") || 0;
    return rightTime - leftTime;
  })[0] || null;

const buildCustomerContactLookup = (customers = []) => {
  const grouped = new Map();
  customers.forEach((row) => {
    const contact = buildContactFromRow(row, {}, { defaultExistsInBase: true });
    const keys = buildPhoneLookupKeys(contact.number);
    if (keys.length === 0) return;
    const primaryKey = keys[0];
    const current = grouped.get(primaryKey) || [];
    current.push(contact);
    grouped.set(primaryKey, current);
  });

  const lookup = new Map();
  grouped.forEach((rows) => {
    const confirmedRows = rows.filter((row) => !row?.isTeste);
    const trialRows = rows.filter((row) => Boolean(row?.isTeste));
    const canonical = selectMostRecentContact(confirmedRows) || selectMostRecentContact(trialRows);
    if (!canonical) return;
    const aggregate = {
      ...canonical,
      existsInBase: true,
      hasConfirmedCustomer: confirmedRows.length > 0,
      hasExpiredTrial: trialRows.some((row) => String(row?.status || row?.situacao || "").trim().toUpperCase() === "EXPIRED"),
      sourceRows: rows,
    };
    buildPhoneLookupKeys(canonical.number).forEach((key) => {
      lookup.set(`phone:${key}`, aggregate);
    });
  });

  return lookup;
};

const buildContacts = (store, conversations = [], painelCustomers = []) => {
  const byLookup = buildCustomerContactLookup(getCustomersArray(store));
  painelCustomers.forEach((row) => {
    const contact = buildContactFromRow(row);
    buildPhoneLookupKeys(contact.number).forEach((key) => {
      byLookup.set(`phone:${key}`, { ...(byLookup.get(`phone:${key}`) || {}), ...contact });
    });
  });
  conversations.forEach((conversation) => {
    const contact = buildContactFromRow(conversation?.customer || conversation, {
      id: conversation?.id,
      conversationId: conversation?.id,
      name: conversation?.customer_name || conversation?.name,
      number: conversation?.wa_id || conversation?.waId || conversation?.phone,
    }, { defaultExistsInBase: false });
    const existingContact = byLookup.get(contact.lookupKey) || {};
    byLookup.set(contact.lookupKey, {
      ...contact,
      ...existingContact,
      conversationId: existingContact.conversationId || contact.conversationId || conversation?.id || null,
      lastInteractionAt:
        existingContact.lastInteractionAt || contact.lastInteractionAt || conversation?.updated_date || conversation?.last_message_at || null,
    });
  });
  return Array.from(byLookup.entries()).map(([lookupKey, contact]) => ({ ...contact, lookupKey }));
};

const resolveAutoDefaultLabelIds = (contact, labels) => {
  const ids = [];
  const labelsBySystemKey = new Map(labels.map((label) => [label.systemKey, label]));
  if (contact?.hasConfirmedCustomer || (contact?.existsInBase && !contact?.isTeste)) {
    if (labelsBySystemKey.get("customer")) ids.push(labelsBySystemKey.get("customer").id);
  } else if (contact?.hasExpiredTrial && labelsBySystemKey.get("sql")) {
    ids.push(labelsBySystemKey.get("sql").id);
  } else if (labelsBySystemKey.get("lead")) {
    ids.push(labelsBySystemKey.get("lead").id);
  }
  if (ids.length === 0 && labelsBySystemKey.get("customer")) {
    ids.push(labelsBySystemKey.get("customer").id);
  }
  const status = String(`${contact?.status || ""} ${contact?.situacao || ""} ${contact?.notes || ""}`).toLowerCase();
  if (
    labelsBySystemKey.get("churn") &&
    (status.includes("vencid") ||
      status.includes("inadimpl") ||
      status.includes("inativ") ||
      status.includes("suspens") ||
      status.includes("bloquead"))
  ) {
    ids.push(labelsBySystemKey.get("churn").id);
  }
  return Array.from(new Set(ids));
};

const resolveLabelsForContact = (contact, labels, manualIds = []) => {
  const labelsById = new Map(labels.map((label) => [String(label.id), label]));
  const ids = [...resolveAutoDefaultLabelIds(contact, labels), ...manualIds.map(String)];
  return Array.from(new Set(ids)).map((id) => labelsById.get(id)).filter(Boolean);
};

export const syncContactsSnapshot = async () => ({ ok: true, skipped: false });

export const listLabels = async () => listLabelsFromStore(await readMainStore());

export const createLabel = async ({ name, color, visibleInFilter = true, campaignConfig = {} }) => {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Nome da etiqueta e obrigatorio");
  const store = await readMainStore();
  const labels = listLabelsFromStore(store);
  if (labels.some((label) => normalizeLabelNameKey(label.name) === normalizeLabelNameKey(trimmedName))) {
    throw new Error("Etiqueta com este nome ja existe");
  }
  const state = normalizeLabelState(store);
  const created = normalizeLabel({
    id: randomId("label"),
    name: trimmedName,
    color,
    visibleInFilter,
    isDefault: false,
    manualAssignable: true,
    campaignConfig,
    sortOrder: 1000 + state.customLabels.length,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  state.customLabels.push(created);
  await saveLabelState(store, state);
  return created;
};

export const updateLabelById = async (labelId, payload) => {
  const id = String(labelId || "").trim();
  const store = await readMainStore();
  const state = normalizeLabelState(store);
  const labels = listLabelsFromStore(store);
  const existing = labels.find((label) => String(label.id) === id);
  if (!existing) throw new Error("Etiqueta nao encontrada");
  if (existing.isDefault) throw new Error("Etiqueta padrao nao pode ser editada");
  const index = state.customLabels.findIndex((label) => String(label?.id || "") === id);
  if (index < 0) throw new Error("Etiqueta nao encontrada");
  const next = normalizeLabel({
    ...state.customLabels[index],
    name: payload?.name ?? state.customLabels[index]?.name,
    color: payload?.color ?? state.customLabels[index]?.color,
    visibleInFilter: payload?.visibleInFilter ?? state.customLabels[index]?.visibleInFilter,
    campaignConfig: payload?.campaignConfig ?? state.customLabels[index]?.campaignConfig,
    updatedAt: nowIso(),
  });
  state.customLabels[index] = next;
  await saveLabelState(store, state);
  return next;
};

export const deleteLabelById = async (labelId) => {
  const id = String(labelId || "").trim();
  const store = await readMainStore();
  const state = normalizeLabelState(store);
  const existing = listLabelsFromStore(store).find((label) => String(label.id) === id);
  if (!existing) throw new Error("Etiqueta nao encontrada");
  if (existing.isDefault) throw new Error("Etiqueta padrao nao pode ser removida");
  state.customLabels = state.customLabels.filter((label) => String(label?.id || "") !== id);
  Object.keys(state.assignments).forEach((contactId) => {
    state.assignments[contactId] = (Array.isArray(state.assignments[contactId]) ? state.assignments[contactId] : []).filter(
      (item) => String(item) !== id,
    );
  });
  await saveLabelState(store, state);
};

export const resolveConversationLabels = async ({ conversations = [], painelCustomers = [] }) => {
  const store = await readMainStore();
  const state = normalizeLabelState(store);
  const labels = listLabelsFromStore(store);
  const contacts = buildContacts(store, conversations, painelCustomers);
  const contactsByLookup = new Map(contacts.map((contact) => [contact.lookupKey, contact]));
  const result = new Map();
  conversations.forEach((conversation) => {
    const contact = buildContactFromRow(conversation?.customer || conversation, {
      id: conversation?.id,
      conversationId: conversation?.id,
      name: conversation?.customer_name || conversation?.name,
      number: conversation?.wa_id || conversation?.waId || conversation?.phone,
    }, { defaultExistsInBase: false });
    const resolved = contactsByLookup.get(contact.lookupKey) || contact;
    const contactId = String(resolved.id || resolved.lookupKey);
    result.set(conversation.id, {
      contactId,
      existsInBase: Boolean(resolved.existsInBase),
      isTeste: Boolean(resolved.isTeste),
      labels: resolveLabelsForContact(resolved, labels, state.assignments[contactId] || []),
    });
  });
  return result;
};

export const getContactLabelsById = async (contactId) => {
  const store = await readMainStore();
  const state = normalizeLabelState(store);
  const labels = listLabelsFromStore(store);
  const contact =
    buildContacts(store).find((item) => String(item.id || item.lookupKey) === String(contactId || "")) || {
      id: String(contactId || ""),
      lookupKey: String(contactId || ""),
      existsInBase: false,
    };
  return resolveLabelsForContact(contact, labels, state.assignments[String(contactId)] || []);
};

export const replaceContactManualLabels = async (contactId, labelIds = []) => {
  const store = await readMainStore();
  const state = normalizeLabelState(store);
  const labels = listLabelsFromStore(store);
  const validIds = new Set(labels.map((label) => String(label.id)));
  const nextIds = Array.from(new Set(labelIds.map(String).filter((id) => validIds.has(id))));
  state.assignments[String(contactId)] = nextIds;
  await saveLabelState(store, state);
  return getContactLabelsById(contactId);
};

export const addContactLabelsById = async (contactId, labelIds = []) => {
  const current = await getContactLabelsById(contactId);
  const manualIds = current.filter((label) => label.manualAssignable || !label.isDefault).map((label) => String(label.id));
  return replaceContactManualLabels(contactId, [...manualIds, ...labelIds]);
};

export const removeContactLabelsById = async (contactId, labelIds = []) => {
  const removeSet = new Set(labelIds.map(String));
  const store = await readMainStore();
  const state = normalizeLabelState(store);
  state.assignments[String(contactId)] = (Array.isArray(state.assignments[String(contactId)])
    ? state.assignments[String(contactId)]
    : []
  ).filter((id) => !removeSet.has(String(id)));
  await saveLabelState(store, state);
  return getContactLabelsById(contactId);
};

export const clearContactLabelsById = async (contactId) => replaceContactManualLabels(contactId, []);

export const listLabelContacts = async (labelId) => {
  const store = await readMainStore();
  const labels = listLabelsFromStore(store);
  const label = labels.find((item) => String(item.id) === String(labelId || ""));
  if (!label) throw new Error("Etiqueta nao encontrada");
  const state = normalizeLabelState(store);
  const contacts = buildContacts(store).map((contact) => ({
    ...contact,
    labels: resolveLabelsForContact(contact, labels, state.assignments[String(contact.id)] || []),
  }));
  return {
    label,
    contacts: contacts.filter((contact) => contact.labels.some((item) => String(item.id) === String(labelId))),
  };
};

export const listResolvedContacts = async () => {
  const store = await readMainStore();
  const labels = listLabelsFromStore(store);
  const state = normalizeLabelState(store);
  return buildContacts(store).map((contact) => ({
    ...contact,
    labels: resolveLabelsForContact(contact, labels, state.assignments[String(contact.id)] || []),
  }));
};

export const ensureLabelsReady = async () => {
  const store = await readMainStore();
  await writeMainStore(store);
  return true;
};

export const getDefaultLabelsRefreshIntervalMs = () =>
  Number.isFinite(DEFAULT_LABELS_REFRESH_INTERVAL_MS) && DEFAULT_LABELS_REFRESH_INTERVAL_MS > 0
    ? DEFAULT_LABELS_REFRESH_INTERVAL_MS
    : 1800000;
