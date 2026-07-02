const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

export const buildCustomerPhoneLookupKeys = (value) => {
  const digits = digitsOnly(value);
  if (!digits) return [];

  const withoutCountry = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
  const keys = new Set([digits, withoutCountry]);
  if ([10, 11].includes(withoutCountry.length)) keys.add(`55${withoutCountry}`);
  if (withoutCountry.length === 11 && withoutCountry[2] === '9') {
    const legacyLocal = `${withoutCountry.slice(0, 2)}${withoutCountry.slice(3)}`;
    keys.add(legacyLocal);
    keys.add(`55${legacyLocal}`);
  }
  if (withoutCountry.length === 10) {
    const modernLocal = `${withoutCountry.slice(0, 2)}9${withoutCountry.slice(2)}`;
    keys.add(modernLocal);
    keys.add(`55${modernLocal}`);
  }
  return [...keys].filter(Boolean);
};

const canonicalPhone = (value) => {
  const digits = digitsOnly(value);
  const local = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
  return local.length === 10 ? `${local.slice(0, 2)}9${local.slice(2)}` : local;
};

const formatDate = (value) => {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(date);
};

const statusLabel = (customer = {}) => {
  const explicit = String(customer.status_label || customer.statusLabel || '').trim();
  if (explicit) return explicit;
  const status = String(customer.status || '').trim().toUpperCase();
  if (status === 'ACTIVE') return 'Ativo';
  if (status === 'EXPIRED') return 'Expirado';
  if (status === 'INACTIVE') return 'Inativo';
  if (status === 'BLOCKED' || status === 'SUSPENDED') return 'Bloqueado';
  return status || 'Desconhecido';
};

export const shapeCustomerSummary = (customer = {}) => {
  const phoneDigits = digitsOnly(customer.phone_digits || customer.phoneDigits || customer.whatsapp);
  const expiresAt = String(customer.expires_at || customer.expiresAt || '').trim();
  return {
    id: String(customer.id || '').trim() || null,
    name: String(customer.display_name || customer.name || customer.username || '').trim(),
    username: String(customer.username || '').trim(),
    phoneDigits,
    whatsapp: String(customer.whatsapp || phoneDigits).trim(),
    status: String(customer.status || 'UNKNOWN').trim().toUpperCase(),
    statusLabel: statusLabel(customer),
    expiresAt,
    dueDateLabel: formatDate(expiresAt),
    planName: String(customer.package || customer.planName || customer.plan || '').trim(),
    connections: Number.isFinite(Number(customer.connections)) ? Number(customer.connections) : 0,
    isTest: Boolean(customer.is_trial ?? customer.isTest),
    existsInBase: true,
  };
};

export const shapeCustomerListItem = (customer = {}) => ({
  id: String(customer.id || '').trim() || null,
  sync_key: String(customer.sync_key || '').trim(),
  username: String(customer.username || '').trim(),
  display_name: String(customer.display_name || customer.name || customer.username || '').trim(),
  whatsapp: String(customer.whatsapp || '').trim(),
  phone_digits: digitsOnly(customer.phone_digits || customer.whatsapp),
  reseller: String(customer.reseller || '').trim(),
  package: String(customer.package || '').trim(),
  connections: Number.isFinite(Number(customer.connections)) ? Number(customer.connections) : 0,
  expires_at: String(customer.expires_at || '').trim(),
  status: String(customer.status || 'UNKNOWN').trim().toUpperCase(),
  status_label: statusLabel(customer),
  is_trial: Boolean(customer.is_trial),
  synced_at: String(customer.synced_at || '').trim(),
});

const resolveCustomerPassword = (customer = {}) => String(
  customer.password ||
  customer.senha ||
  customer.pass ||
  customer.raw?.password ||
  customer.raw?.senha ||
  customer.raw?.pass ||
  '',
).trim();

export const shapeCustomerDetail = (customer = {}) => {
  const password = resolveCustomerPassword(customer);
  return {
    ...shapeCustomerListItem(customer),
    password,
    senha: password,
  };
};

let cachedIndex = null;

const customerRank = (customer = {}) => {
  const confirmed = customer.is_trial ? 0 : 1;
  const expiresAt = Date.parse(customer.expires_at || '') || 0;
  const timestamp = Date.parse(customer.synced_at || customer.updated_at || '') || 0;
  return { confirmed, expiresAt, timestamp };
};

const shouldReplace = (current, candidate) => {
  if (!current) return true;
  const left = customerRank(current);
  const right = customerRank(candidate);
  return right.confirmed > left.confirmed ||
    (right.confirmed === left.confirmed && right.expiresAt > left.expiresAt) ||
    (right.confirmed === left.confirmed && right.expiresAt === left.expiresAt && right.timestamp > left.timestamp);
};

const buildIndex = (store = {}) => {
  const customers = Array.isArray(store.customers) ? store.customers : [];
  if (cachedIndex?.customers === customers) return cachedIndex;

  const byId = new Map();
  const byPhone = new Map();
  for (const customer of customers) {
    const id = String(customer?.id || '').trim();
    if (id) byId.set(id, customer);
    const phone = customer?.phone_digits || customer?.whatsapp;
    const canonical = canonicalPhone(phone);
    for (const key of buildCustomerPhoneLookupKeys(phone)) {
      const existing = byPhone.get(key);
      if (!existing || (existing.canonical === canonical && shouldReplace(existing.customer, customer))) {
        byPhone.set(key, { canonical, customer });
      }
    }
  }
  cachedIndex = { customers, byId, byPhone };
  return cachedIndex;
};

export const resolveCustomerForConversation = (conversation = {}, store = {}) => {
  const index = buildIndex(store);
  const customerId = String(conversation.customer_id || conversation.customerId || '').trim();
  if (customerId && index.byId.has(customerId)) return index.byId.get(customerId);

  const phoneCandidates = [
    conversation.normalized_phone,
    conversation.contact_phone,
    conversation.customer?.phone,
    conversation.customer?.whatsapp,
  ];
  for (const phone of phoneCandidates) {
    for (const key of buildCustomerPhoneLookupKeys(phone)) {
      if (index.byPhone.has(key)) return index.byPhone.get(key).customer;
    }
  }
  return null;
};

export const enrichConversationsWithCustomerSummaries = (conversations = [], store = {}) =>
  (Array.isArray(conversations) ? conversations : []).map((conversation) => {
    const customer = resolveCustomerForConversation(conversation, store);
    return { ...conversation, customer_summary: customer ? shapeCustomerSummary(customer) : null };
  });

export const clearCustomerSummaryCache = () => {
  cachedIndex = null;
};
