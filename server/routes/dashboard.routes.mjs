const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = 'America/Sao_Paulo';

const emptyDashboardPayload = () => ({
  success: true,
  source: 'local-store',
  generatedAt: new Date().toISOString(),
  customers: {
    active: 0,
    delinquent: 0,
    cancelled: 0,
    ltvDays: 0,
    renewed: 0,
    contracted: 0,
    cancelledInRange: 0,
  },
  ads: {
    adCustomers: 0,
    testsGenerated: 0,
    contracted: 0,
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
    ads: [],
    bestAd: null,
    worstAd: null,
  },
  followup: {
    sent: 0,
    appointments: 0,
    recovered: 0,
    crc: 0,
    bestTemplate: null,
    worstTemplate: null,
    responseRate: 0,
    responses: 0,
    templates: [],
  },
  attendance: {
    totalConversations: 0,
    customerConversations: 0,
    leadConversations: 0,
    slices: [
      { label: 'Clientes', value: 0 },
      { label: 'Leads', value: 0 },
    ],
  },
  individual: {
    agents: [],
    salesRanking: [],
    supportRanking: [],
  },
  accessIssues: [],
});

const getSaoPauloDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

const parseDateMs = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (br) {
    const [, day, month, year, hour = '00', minute = '00', second = '00'] = br;
    const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}-03:00`);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const getNestedValue = (source, key) => {
  if (!source || typeof source !== 'object') return '';
  const value = source[key];
  if (value && typeof value === 'object') {
    return value.name || value.username || value.label || value.value || '';
  }
  return value;
};

const findDateMs = (customer, keys) => {
  const raw = customer?.raw && typeof customer.raw === 'object' ? customer.raw : {};
  for (const key of keys) {
    const direct = parseDateMs(customer?.[key]);
    if (direct) return direct;
    const rawValue = parseDateMs(getNestedValue(raw, key));
    if (rawValue) return rawValue;
  }
  return null;
};

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  return ['true', '1', 'yes', 'sim', 'trial', 'teste'].includes(normalized);
};

const isTrialCustomer = (customer) =>
  normalizeBoolean(customer?.is_trial ?? customer?.isTrial ?? customer?.raw?.is_trial ?? customer?.raw?.isTrial);

const isWithinRange = (timeMs, startMs, endMs) =>
  Number.isFinite(timeMs) && timeMs >= startMs && timeMs <= endMs;

const floorToUtcDayMs = (timeMs) => {
  const date = new Date(timeMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const buildCustomersDashboard = (customers, { startMs, endMs, todayMs }) => {
  const summary = emptyDashboardPayload().customers;
  let activeAgeTotal = 0;
  let activeAgeCount = 0;

  for (const customer of customers) {
    if (!customer || typeof customer !== 'object') continue;
    if (isTrialCustomer(customer)) continue;

    const expiryMs = findDateMs(customer, ['expires_at', 'expiresAt', 'expires_at_tz', 'expiration', 'expiry', 'due_date', 'dueDate', 'vencimento']);
    const createdMs = findDateMs(customer, ['created_at', 'createdAt', 'date_created', 'dateCreated', 'signup_at', 'signupAt']);
    const updatedMs = findDateMs(customer, ['updated_at', 'updatedAt', 'last_renewed_at', 'lastRenewedAt']);
    const status = String(customer.status || customer.raw?.status || '').trim().toUpperCase();
    const hasValidExpiry = Number.isFinite(expiryMs) && floorToUtcDayMs(expiryMs) >= todayMs;

    if (hasValidExpiry && (!status || status === 'ACTIVE')) {
      summary.active += 1;
      if (Number.isFinite(createdMs)) {
        activeAgeTotal += Math.max(0, Math.floor((todayMs - floorToUtcDayMs(createdMs)) / DAY_MS));
        activeAgeCount += 1;
      }
    } else if (Number.isFinite(expiryMs) && floorToUtcDayMs(expiryMs) < todayMs) {
      const overdueDays = Math.max(1, Math.floor((todayMs - floorToUtcDayMs(expiryMs)) / DAY_MS));
      if (overdueDays <= 5) {
        summary.delinquent += 1;
      } else {
        summary.cancelled += 1;
      }
      if (isWithinRange(expiryMs, startMs, endMs)) {
        summary.cancelledInRange += 1;
      }
    }

    if (isWithinRange(createdMs, startMs, endMs)) {
      summary.contracted += 1;
    }

    if (
      Number.isFinite(updatedMs) &&
      Number.isFinite(createdMs) &&
      updatedMs > createdMs + DAY_MS &&
      isWithinRange(updatedMs, startMs, endMs) &&
      hasValidExpiry
    ) {
      summary.renewed += 1;
    }
  }

  summary.ltvDays = activeAgeCount ? Math.round(activeAgeTotal / activeAgeCount) : 0;
  return summary;
};

const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');

const normalizeTextKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const dashboardEvents = (store) => {
  const state = store?.dashboardEvents;
  if (Array.isArray(state?.items)) return state.items;
  if (Array.isArray(state)) return state;
  return [];
};

const eventTimeMs = (event) => parseDateMs(event?.createdAt || event?.created_at || event?.timestamp);
const eventInRange = (event, startMs, endMs) => isWithinRange(eventTimeMs(event), startMs, endMs);

const getCustomerId = (customer) =>
  String(customer?.id || customer?.customer_id || customer?.uuid || customer?.username || customer?.raw?.id || '').trim();

const getCustomerPhone = (customer) =>
  normalizePhoneDigits(customer?.phone_digits || customer?.phone || customer?.whatsapp || customer?.raw?.phone || customer?.raw?.whatsapp);

const getConversationPhone = (conversation) =>
  normalizePhoneDigits(
    conversation?.phone ||
      conversation?.phone_digits ||
      conversation?.contact_phone ||
      conversation?.contactPhone ||
      conversation?.customer_phone ||
      conversation?.customerPhone ||
      conversation?.whatsapp ||
      conversation?.remote_jid ||
      conversation?.remoteJid,
  );

const buildCustomerLookup = (customers) => {
  const byId = new Map();
  const byPhone = new Map();
  for (const customer of customers) {
    const id = getCustomerId(customer);
    const phone = getCustomerPhone(customer);
    if (id && !byId.has(id)) byId.set(id, customer);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, customer);
  }
  return { byId, byPhone };
};

const resolveEventCustomer = (event, lookup) => {
  const customerId = String(event?.customerId || event?.customer_id || '').trim();
  const phone = normalizePhoneDigits(event?.phone || event?.customerPhone || event?.whatsapp);
  return (customerId && lookup.byId.get(customerId)) || (phone && lookup.byPhone.get(phone)) || null;
};

const customerEventKey = (event, lookup) => {
  const customer = resolveEventCustomer(event, lookup);
  const customerId = customer ? getCustomerId(customer) : String(event?.customerId || event?.customer_id || '').trim();
  const phone = customer ? getCustomerPhone(customer) : normalizePhoneDigits(event?.phone || event?.customerPhone || event?.whatsapp);
  const conversationId = String(event?.conversationId || event?.conversation_id || '').trim();
  return customerId || phone || conversationId || String(event?.id || '');
};

const isCurrentlyContracted = (customer, todayMs) => {
  if (!customer || isTrialCustomer(customer)) return false;
  const expiryMs = findDateMs(customer, ['expires_at', 'expiresAt', 'expires_at_tz', 'expiration', 'expiry', 'due_date', 'dueDate', 'vencimento']);
  const status = String(customer.status || customer.raw?.status || '').trim().toUpperCase();
  return Number.isFinite(expiryMs) && floorToUtcDayMs(expiryMs) >= todayMs && (!status || status === 'ACTIVE');
};

const incrementHour = (rows, timeMs) => {
  if (!Number.isFinite(timeMs)) return;
  const hour = new Date(timeMs).getHours();
  if (rows[hour]) rows[hour].count += 1;
};

const buildAdsDashboard = (store, customers, settings, { startMs, endMs, todayMs }) => {
  const lookup = buildCustomerLookup(customers);
  const events = dashboardEvents(store).filter((event) => eventInRange(event, startMs, endMs));
  const adEvents = events.filter((event) => String(event?.type || '').trim().toLowerCase() === 'ad_lead');
  const keywords = (Array.isArray(settings?.adKeywords) ? settings.adKeywords : []).map(normalizeTextKey).filter(Boolean);
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const leadMap = new Map();
  const adGroups = new Map();

  const addLead = (event, fallbackName = '') => {
    const key = customerEventKey(event, lookup);
    if (!key || leadMap.has(key)) return;
    leadMap.set(key, event);
    incrementHour(byHour, eventTimeMs(event));
    const name = String(event?.adName || event?.campaignName || fallbackName || 'Anuncio sem nome').trim();
    if (!adGroups.has(name)) adGroups.set(name, { name, leads: 0, testsGenerated: 0, contracted: 0 });
    adGroups.get(name).leads += 1;
  };

  adEvents.forEach((event) => addLead(event));

  if (keywords.length) {
    const conversations = Array.isArray(store.conversations) ? store.conversations : [];
    const messages = Array.isArray(store.messages) ? store.messages : [];
    const conversationHits = new Map();

    for (const conversation of conversations) {
      const text = normalizeTextKey([
        conversation?.source,
        conversation?.origin,
        conversation?.last_message,
        conversation?.lastMessage,
        conversation?.notes,
      ].join(' '));
      const matchedKeyword = keywords.find((keyword) => text.includes(keyword));
      if (!matchedKeyword) continue;
      const createdAt = conversation.created_date || conversation.createdAt || conversation.last_message_time || conversation.updated_date;
      const createdMs = parseDateMs(createdAt);
      if (!isWithinRange(createdMs, startMs, endMs)) continue;
      const event = {
        id: `conversation-${conversation.id || conversation.conversation_id || conversationHits.size}`,
        type: 'ad_lead',
        createdAt,
        phone: conversation.contact_phone || conversation.phone || conversation.whatsapp || '',
        conversationId: conversation.id || conversation.conversation_id || '',
        adName: matchedKeyword,
      };
      conversationHits.set(String(event.conversationId || event.id), event);
    }

    for (const message of messages) {
      const content = normalizeTextKey(message.content || message.body || message.text || message.message);
      const matchedKeyword = keywords.find((keyword) => content.includes(keyword));
      if (!matchedKeyword) continue;
      const createdAt = message.created_date || message.createdAt || message.timestamp || message.sent_at;
      const createdMs = parseDateMs(createdAt);
      if (!isWithinRange(createdMs, startMs, endMs)) continue;
      addLead({
        id: `message-${message.id || message.message_id || leadMap.size}`,
        type: 'ad_lead',
        createdAt,
        phone: message.contact_phone || message.phone || message.whatsapp || '',
        conversationId: message.conversation_id || message.conversationId || '',
        adName: matchedKeyword,
      }, matchedKeyword);
    }

    conversationHits.forEach((event) => addLead(event, event.adName));
  }

  for (const event of leadMap.values()) {
    const customer = resolveEventCustomer(event, lookup);
    const groupName = String(event?.adName || event?.campaignName || 'Anuncio sem nome').trim();
    const group = adGroups.get(groupName);
    if (!group) continue;
    if (customer && isTrialCustomer(customer)) group.testsGenerated += 1;
    if (customer && isCurrentlyContracted(customer, todayMs)) group.contracted += 1;
  }

  const explicitTrialKeys = new Set(events.filter((event) => String(event?.type || '') === 'trial_generated').map((event) => customerEventKey(event, lookup)));
  const explicitContractKeys = new Set(events.filter((event) => String(event?.type || '') === 'contracted').map((event) => customerEventKey(event, lookup)));
  const testsGenerated = Array.from(leadMap.values()).filter((event) => {
    const customer = resolveEventCustomer(event, lookup);
    const key = customerEventKey(event, lookup);
    return explicitTrialKeys.has(key) || (customer && isTrialCustomer(customer));
  }).length;
  const contracted = Array.from(leadMap.values()).filter((event) => {
    const customer = resolveEventCustomer(event, lookup);
    const key = customerEventKey(event, lookup);
    return explicitContractKeys.has(key) || (customer && isCurrentlyContracted(customer, todayMs));
  }).length;

  const ads = Array.from(adGroups.values()).sort((left, right) => right.leads - left.leads);
  return {
    adCustomers: leadMap.size,
    testsGenerated,
    contracted,
    byHour,
    ads,
    bestAd: ads[0] || null,
    worstAd: ads.length ? ads[ads.length - 1] : null,
  };
};

const addTemplateMetric = (templates, key, updates = {}) => {
  const templateKey = key || 'Template sem nome';
  if (!templates.has(templateKey)) {
    templates.set(templateKey, {
      key: templateKey,
      name: templateKey,
      sent: 0,
      responses: 0,
      appointments: 0,
      recovered: 0,
      cost: 0,
      responseRate: 0,
    });
  }
  const row = templates.get(templateKey);
  Object.entries(updates).forEach(([field, value]) => {
    row[field] = (Number(row[field]) || 0) + (Number(value) || 0);
  });
};

const buildFollowupDashboard = (store, { startMs, endMs }) => {
  const events = dashboardEvents(store).filter((event) => eventInRange(event, startMs, endMs));
  const templates = new Map();
  let sent = 0;
  let responses = 0;
  let appointments = 0;
  let recovered = 0;
  let cost = 0;

  const routineItems = Array.isArray(store?.routines?.items) ? store.routines.items : [];
  const routinesById = new Map(routineItems.map((routine) => [String(routine?.id || ''), routine]));
  const routineLogs = Array.isArray(store?.routines?.logs) ? store.routines.logs : [];

  for (const log of routineLogs) {
    const timeMs = parseDateMs(log?.createdAt || log?.created_at || log?.finishedAt || log?.timestamp);
    if (!isWithinRange(timeMs, startMs, endMs)) continue;
    const routine = routinesById.get(String(log?.routineId || '')) || {};
    const logSent = Number(log?.summary?.sent || log?.sent || 0) || 0;
    if (!logSent) continue;
    const templateName = String(log?.templateName || routine.templateName || routine.name || log?.routineName || '').trim() || 'Template sem nome';
    sent += logSent;
    addTemplateMetric(templates, templateName, { sent: logSent });
  }

  for (const event of events) {
    const type = String(event?.type || '').trim().toLowerCase();
    const templateName = String(event?.templateName || event?.routineName || event?.campaignName || '').trim() || 'Template sem nome';
    const eventCost = Number(event?.cost || 0) || 0;
    if (type === 'followup_sent') {
      sent += 1;
      cost += eventCost;
      addTemplateMetric(templates, templateName, { sent: 1, cost: eventCost });
    } else if (type === 'followup_response') {
      responses += 1;
      addTemplateMetric(templates, templateName, { responses: 1 });
    } else if (type === 'appointment_created') {
      appointments += 1;
      addTemplateMetric(templates, templateName, { appointments: 1 });
    } else if (type === 'recovered') {
      recovered += 1;
      addTemplateMetric(templates, templateName, { recovered: 1 });
    }
  }

  const rows = Array.from(templates.values()).map((template) => ({
    ...template,
    responseRate: template.sent ? template.responses / template.sent : 0,
  }));
  const byRecovered = [...rows].sort((left, right) => right.recovered - left.recovered || right.responses - left.responses || right.sent - left.sent);
  const responseRate = sent ? responses / sent : 0;

  return {
    sent,
    appointments,
    recovered,
    crc: recovered ? cost / recovered : 0,
    bestTemplate: byRecovered[0] || null,
    worstTemplate: byRecovered.length ? byRecovered[byRecovered.length - 1] : null,
    responseRate,
    responses,
    templates: rows.sort((left, right) => right.responseRate - left.responseRate || right.sent - left.sent),
  };
};

const resolveConversationKind = (conversation) => {
  const text = normalizeTextKey([
    conversation?.department,
    conversation?.department_key,
    conversation?.departmentKey,
    conversation?.service,
    conversation?.service_name,
    conversation?.queue,
    conversation?.queue_name,
    conversation?.tags,
    conversation?.labels,
  ].join(' '));
  if (text.includes('venda') || text.includes('sales') || text.includes('comercial')) return 'sales';
  if (text.includes('suporte') || text.includes('support') || text.includes('atendimento')) return 'support';
  return 'support';
};

const collectConversationLabelText = (conversation) => {
  const labels = [];
  const collect = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value === 'object') {
      labels.push(value.id, value.name, value.label, value.value);
      return;
    }
    labels.push(value);
  };
  collect(conversation?.label_ids);
  collect(conversation?.labelIds);
  collect(conversation?.labels);
  collect(conversation?.visible_labels);
  collect(conversation?.visibleLabels);
  collect(conversation?.custom_labels);
  collect(conversation?.customLabels);
  return normalizeTextKey(labels.filter(Boolean).join(' '));
};

const resolveConversationTimeMs = (conversation, messagesByConversation) => {
  const conversationId = String(conversation?.id || conversation?.conversation_id || conversation?.conversationId || '').trim();
  const messages = conversationId ? messagesByConversation.get(conversationId) || [] : [];
  let latestInboundMs = null;

  for (const message of messages) {
    const timeMs = parseDateMs(message?.created_date || message?.createdAt || message?.timestamp || message?.sent_at || message?.sentAt);
    if (!Number.isFinite(timeMs)) continue;
    const sender = String(message?.sender_type || message?.senderType || message?.type || message?.direction || '').trim().toLowerCase();
    const isInbound = ['contact', 'client', 'customer', 'inbound', 'received'].includes(sender) || message?.from_me === false || message?.fromMe === false;
    if (isInbound && (!Number.isFinite(latestInboundMs) || timeMs > latestInboundMs)) {
      latestInboundMs = timeMs;
    }
  }

  return (
    latestInboundMs ||
    parseDateMs(conversation?.last_client_message_time || conversation?.lastClientMessageTime || conversation?.last_received_at || conversation?.lastReceivedAt) ||
    parseDateMs(conversation?.created_date || conversation?.createdAt || conversation?.created_at) ||
    parseDateMs(conversation?.last_message_time || conversation?.lastMessageTime || conversation?.updated_date || conversation?.updatedAt)
  );
};

const resolveAttendanceAudience = (conversation, lookup) => {
  const phone = getConversationPhone(conversation);
  const customer = phone ? lookup.byPhone.get(phone) : null;
  const labelText = collectConversationLabelText(conversation);

  if (customer && !isTrialCustomer(customer)) return 'customer';
  if (labelText.includes('system-cliente') || labelText.includes('label-customer') || labelText.includes('cliente')) return 'customer';
  if (labelText.includes('system-pos-venda') || labelText.includes('pos venda') || labelText.includes('system-cancelados') || labelText.includes('cancelado')) {
    return 'customer';
  }
  return 'lead';
};

const buildAttendanceDashboard = (store, customers, { startMs, endMs }) => {
  const summary = emptyDashboardPayload().attendance;
  const conversations = Array.isArray(store.attendanceConversations)
    ? store.attendanceConversations
    : Array.isArray(store.conversations)
      ? store.conversations
      : [];
  const messages = Array.isArray(store.messages) ? store.messages : [];
  const lookup = buildCustomerLookup(customers);
  const messagesByConversation = messages.reduce((map, message) => {
    const conversationId = String(message?.conversation_id || message?.conversationId || '').trim();
    if (!conversationId) return map;
    if (!map.has(conversationId)) map.set(conversationId, []);
    map.get(conversationId).push(message);
    return map;
  }, new Map());
  const seen = new Set();

  for (const conversation of conversations) {
    if (!conversation || typeof conversation !== 'object') continue;
    const timeMs = resolveConversationTimeMs(conversation, messagesByConversation);
    if (!isWithinRange(timeMs, startMs, endMs)) continue;

    const conversationId = String(conversation.id || conversation.conversation_id || conversation.conversationId || '').trim();
    const phone = getConversationPhone(conversation);
    const key = conversationId || phone;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);

    summary.totalConversations += 1;
    if (resolveAttendanceAudience(conversation, lookup) === 'customer') {
      summary.customerConversations += 1;
    } else {
      summary.leadConversations += 1;
    }
  }

  summary.slices = [
    { label: 'Clientes', value: summary.customerConversations },
    { label: 'Leads', value: summary.leadConversations },
  ];
  return summary;
};

const buildIndividualDashboard = (store, settings, { startMs, endMs }) => {
  const users = Array.isArray(store.users) ? store.users : [];
  const conversations = Array.isArray(store.conversations) ? store.conversations : [];
  const messages = Array.isArray(store.messages) ? store.messages : [];
  const preferences = Array.isArray(store.conversationPreferences) ? store.conversationPreferences : [];
  const events = dashboardEvents(store).filter((event) => eventInRange(event, startMs, endMs));
  const salesGoals = settings?.salesGoalsByUserId && typeof settings.salesGoalsByUserId === 'object' ? settings.salesGoalsByUserId : {};
  const resolvedIds = new Set(
    preferences
      .filter((item) => String(item?.resolution_status || '').trim() === 'resolved')
      .map((item) => String(item?.conversation_id || item?.conversationId || '').trim())
      .filter(Boolean),
  );

  const messagesByConversation = messages.reduce((map, message) => {
    const conversationId = String(message?.conversation_id || message?.conversationId || '').trim();
    if (!conversationId) return map;
    if (!map.has(conversationId)) map.set(conversationId, []);
    map.get(conversationId).push(message);
    return map;
  }, new Map());

  const agents = users.map((user) => {
    const keys = [user.id, user.email, user.username, user.full_name, user.name].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
    const displayName = user.full_name || user.name || user.email || user.username || user.id || 'Usuario';
    const userConversations = conversations.filter((conversation) => {
      const assigned = [
        conversation.assigned_agent,
        conversation.assigned_agent_id,
        conversation.assigned_agent_email,
        conversation.assigned_agent_name,
      ].map((item) => String(item || '').trim().toLowerCase());
      const createdMs = parseDateMs(conversation.created_date || conversation.createdAt || conversation.last_message_time || conversation.updated_date);
      return assigned.some((item) => keys.includes(item)) && isWithinRange(createdMs, startMs, endMs);
    });
    const salesConversations = userConversations.filter((conversation) => resolveConversationKind(conversation) === 'sales');
    const supportConversations = userConversations.filter((conversation) => resolveConversationKind(conversation) === 'support');
    const finishedConversations = userConversations.filter((conversation) => {
      const status = String(conversation.status || conversation.queue_status || '').trim().toLowerCase();
      return ['resolved', 'closed', 'finished'].includes(status) || resolvedIds.has(String(conversation.id || ''));
    });
    const salesFinishedConversations = finishedConversations.filter((conversation) => resolveConversationKind(conversation) === 'sales');
    const supportFinishedConversations = finishedConversations.filter((conversation) => resolveConversationKind(conversation) === 'support');
    const userEvents = events.filter((event) => {
      const agentCandidates = [event?.agentId, event?.agentName, event?.agentEmail]
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean);
      return agentCandidates.some((item) => keys.includes(item));
    });
    let agentResponseTotalMs = 0;
    let agentResponseCount = 0;
    let leadDurationTotalMs = 0;
    let leadDurationCount = 0;

    for (const conversation of userConversations) {
      const conversationMessages = (messagesByConversation.get(String(conversation.id || '')) || [])
        .map((message) => ({
          ...message,
          timeMs: parseDateMs(message.created_date || message.createdAt || message.timestamp || message.sent_at),
          sender: String(message.sender_type || message.type || '').trim().toLowerCase(),
        }))
        .filter((message) => Number.isFinite(message.timeMs))
        .sort((left, right) => left.timeMs - right.timeMs);

      const first = conversationMessages[0]?.timeMs || parseDateMs(conversation.created_date || conversation.createdAt);
      const last = conversationMessages[conversationMessages.length - 1]?.timeMs || parseDateMs(conversation.updated_date || conversation.last_message_time);
      if (Number.isFinite(first) && Number.isFinite(last) && last >= first) {
        leadDurationTotalMs += last - first;
        leadDurationCount += 1;
      }

      let lastClientMs = null;
      for (const message of conversationMessages) {
        const isAgent = ['agent', 'outbound', 'me'].includes(message.sender) || message.from_me === true;
        const isClient = ['contact', 'client', 'customer', 'inbound'].includes(message.sender) || message.from_me === false;
        if (isClient) lastClientMs = message.timeMs;
        if (isAgent && Number.isFinite(lastClientMs) && message.timeMs >= lastClientMs) {
          agentResponseTotalMs += message.timeMs - lastClientMs;
          agentResponseCount += 1;
          lastClientMs = null;
        }
      }
    }

    const started = userConversations.length;
    const finished = finishedConversations.length;
    const completionScore = started ? (finished / started) * 100 : 0;
    const responseAvgMs = agentResponseCount ? agentResponseTotalMs / agentResponseCount : 0;
    const speedScore = responseAvgMs ? Math.max(0, 100 - (responseAvgMs / (10 * 60 * 1000)) * 100) : completionScore;
    const score = Math.round((completionScore + speedScore) / 2);
    const configuredGoal = keys.map((key) => Number(salesGoals[key] || 0)).find((value) => value > 0) || Number(user.salesGoal || user.sales_goal || 0) || 0;
    const eventSalesStarted = userEvents.filter((event) => event.type === 'sale_started').length;
    const eventSalesFinished = userEvents.filter((event) => event.type === 'sale_finished' || event.type === 'contracted').length;
    const eventSupportStarted = userEvents.filter((event) => event.type === 'support_started').length;
    const eventSupportFinished = userEvents.filter((event) => event.type === 'support_finished').length;
    const salesStarted = eventSalesStarted || salesConversations.length;
    const salesFinished = eventSalesFinished || salesFinishedConversations.length;
    const supportStarted = eventSupportStarted || supportConversations.length;
    const supportFinished = eventSupportFinished || supportFinishedConversations.length;

    return {
      key: String(user.id || user.email || displayName),
      name: displayName,
      email: user.email || '',
      salesStarted,
      salesFinished,
      supportStarted,
      supportFinished,
      salesGoal: configuredGoal,
      salesMonth: salesFinished,
      salesNeeded: Math.max(0, configuredGoal - salesFinished),
      tmlSeconds: leadDurationCount ? Math.round(leadDurationTotalMs / leadDurationCount / 1000) : 0,
      tmrSeconds: agentResponseCount ? Math.round(agentResponseTotalMs / agentResponseCount / 1000) : 0,
      score,
    };
  });

  const byScore = [...agents].sort((left, right) => right.score - left.score);
  const bySales = [...agents].sort((left, right) => right.salesMonth - left.salesMonth || right.score - left.score);
  return { agents, salesRanking: bySales, supportRanking: byScore };
};

const buildSaasTvDashboardPayload = async (url, { readStore, readAttendanceConversations }) => {
  const startKey = String(url.searchParams.get('start') || '').trim();
  const endKey = String(url.searchParams.get('end') || '').trim();
  const todayKey = getSaoPauloDateKey();
  const startMs = parseDateMs(startKey ? `${startKey}T00:00:00-03:00` : `${todayKey}T00:00:00-03:00`);
  const endMs = parseDateMs(endKey ? `${endKey}T23:59:59-03:00` : `${todayKey}T23:59:59-03:00`);
  const todayMs = floorToUtcDayMs(parseDateMs(`${todayKey}T00:00:00-03:00`));
  const store = await readStore();
  const customers = Array.isArray(store.customers) ? store.customers : [];
  const settings = store.dashboardSettings && typeof store.dashboardSettings === 'object' ? store.dashboardSettings : {};
  const attendanceConversations = typeof readAttendanceConversations === 'function'
    ? await readAttendanceConversations(store).catch(() => [])
    : [];
  const storeWithAttendance = attendanceConversations.length
    ? { ...store, attendanceConversations }
    : store;
  const payload = emptyDashboardPayload();

  payload.range = { start: startKey || todayKey, end: endKey || todayKey, timezone: TIME_ZONE };
  payload.customers = buildCustomersDashboard(customers, { startMs, endMs, todayMs });
  payload.ads = buildAdsDashboard(store, customers, settings, { startMs, endMs, todayMs });
  payload.followup = buildFollowupDashboard(store, { startMs, endMs });
  payload.attendance = buildAttendanceDashboard(storeWithAttendance, customers, { startMs, endMs });
  payload.individual = buildIndividualDashboard(store, settings, { startMs, endMs });

  if (!customers.length) {
    payload.accessIssues.push({
      area: 'customers',
      message: 'Base de clientes ainda nao sincronizada no store local.',
    });
  }

  if (!payload.ads.adCustomers) {
    payload.accessIssues.push({
      area: 'ads',
      message: 'Nenhum lead de anuncio encontrado no periodo. Importe eventos da Meta em /api/local/dashboard/events/import ou configure palavras-chave de anuncio.',
    });
  }

  if (!payload.followup.sent && !payload.followup.responses && !payload.followup.recovered) {
    payload.accessIssues.push({
      area: 'followup',
      message: 'Nenhum evento/log de recuperacao encontrado no periodo. Registre followup_sent, followup_response, appointment_created e recovered para alimentar DASH03.',
    });
  }

  if (!payload.attendance.totalConversations) {
    payload.accessIssues.push({
      area: 'attendance',
      message: 'Nenhuma conversa encontrada no periodo para alimentar a aba Atendimentos.',
    });
  }

  return payload;
};

export const handleDashboardRoutes = async (req, res, url, deps = {}) => {
  if (!req || !res || !url) return false;
  if (req.method !== 'GET') return false;

  const { sendJson, readStore, readAttendanceConversations } = deps;
  if (typeof sendJson !== 'function') {
    throw new Error('Dashboard route dependencies are incomplete.');
  }

  if (url.pathname === '/api/local/dashboard/saastv') {
    if (typeof readStore !== 'function') {
      throw new Error('SaaSTV dashboard route requires readStore.');
    }
    sendJson(res, 200, await buildSaasTvDashboardPayload(url, { readStore, readAttendanceConversations }));
    return true;
  }

  if (url.pathname === '/api/local/dashboard') {
    sendJson(res, 200, emptyDashboardPayload());
    return true;
  }

  const dashboardTypeMatch = url.pathname.match(/^\/api\/local\/dashboard\/([^/]+)$/);
  if (dashboardTypeMatch) {
    sendJson(res, 404, {
      success: false,
      type: decodeURIComponent(dashboardTypeMatch[1] || '').trim(),
      error: 'Dashboard nao encontrado.',
    });
    return true;
  }

  return false;
};
