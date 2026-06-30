const OPEN_CONVERSATION_STATUSES = new Set(['waiting', 'in_progress']);

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseCustomerDate(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatCustomerDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '-';
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  return `${day}/${month}/${year}`;
}

export function isOpenConversation(status) {
  return OPEN_CONVERSATION_STATUSES.has(String(status || '').toLowerCase());
}

export function getCustomerStatusLabel(status, fallbackLabel = '') {
  const normalized = String(status || '').trim().toUpperCase();

  if (fallbackLabel) {
    return fallbackLabel;
  }

  if (normalized === 'ACTIVE') return 'Ativo';
  if (normalized === 'EXPIRED') return 'Vencido';
  if (normalized === 'INACTIVE') return 'Inativo';
  if (normalized === 'BLOCKED') return 'Bloqueado';
  if (normalized === 'SUSPENDED') return 'Suspenso';
  if (!normalized) return 'Sem status';
  return normalized;
}

export function getCustomerStatusClasses(status) {
  const normalized = String(status || '').trim().toUpperCase();

  if (normalized === 'ACTIVE') {
    return 'border-primary/20 bg-primary/10 text-primary';
  }

  if (normalized === 'EXPIRED') {
    return 'border-red-500/20 bg-red-500/10 text-red-600';
  }

  if (normalized === 'INACTIVE') {
    return 'border-slate-500/20 bg-slate-500/10 text-slate-600';
  }

  if (normalized === 'BLOCKED' || normalized === 'SUSPENDED') {
    return 'border-amber-500/20 bg-amber-500/10 text-amber-700';
  }

  return 'border-border bg-secondary/60 text-foreground';
}

export function buildCustomerRows(customers = [], conversations = []) {
  const safeCustomers = Array.isArray(customers) ? customers : [];
  const safeConversations = Array.isArray(conversations) ? conversations : [];
  const conversationsByPhone = new Map();

  safeConversations.forEach((conversation) => {
    const phoneDigits = normalizePhone(conversation?.contact_phone);
    if (!phoneDigits) return;
    const current = conversationsByPhone.get(phoneDigits) || [];
    current.push(conversation);
    conversationsByPhone.set(phoneDigits, current);
  });

  return safeCustomers.map((customer, index) => {
    const phoneDigits = normalizePhone(customer?.phone_digits || customer?.whatsapp);
    const matchingConversations = phoneDigits ? conversationsByPhone.get(phoneDigits) || [] : [];
    const dueDate = parseCustomerDate(customer?.expires_at);
    const hasConversation = matchingConversations.length > 0;
    const hasOpenConversation = matchingConversations.some((conversation) => isOpenConversation(conversation?.status));
    const password = String(customer?.senha || customer?.password || customer?.pass || '').trim();

    return {
      id: customer?.id || `customer-${index + 1}`,
      customerId: customer?.id || null,
      syncKey: customer?.sync_key || '',
      name: customer?.display_name || customer?.username || `Cliente ${index + 1}`,
      username: customer?.username || `cliente-${index + 1}`,
      password,
      senha: password,
      whatsapp: customer?.whatsapp || '-',
      phoneDigits,
      reseller: customer?.reseller || '-',
      planName: customer?.package || '-',
      isTest: Boolean(customer?.is_trial),
      connections: Number.isFinite(Number(customer?.connections)) ? Number(customer.connections) : 0,
      dueDate,
      dueDateLabel: formatCustomerDate(dueDate),
      expiresAt: customer?.expires_at || '',
      status: customer?.status || 'UNKNOWN',
      statusLabel: getCustomerStatusLabel(customer?.status, customer?.status_label || ''),
      statusClasses: getCustomerStatusClasses(customer?.status),
      conversationOpen: hasConversation,
      conversationLabel: hasConversation ? 'Sim' : 'Nao',
      hasOpenConversation,
      conversationCount: matchingConversations.length,
      renewUrl: `newbr://customer/${customer?.sync_key || customer?.id || index + 1}`,
      playlist: `whatsapp://${phoneDigits || customer?.sync_key || index + 1}`,
      sourceCustomer: customer,
      sourceConversations: matchingConversations,
    };
  });
}
