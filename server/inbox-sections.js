const DAY_MS = 24 * 60 * 60 * 1000;
const OUTSIDE_WINDOW_BATCH_SIZE = 50;
const INITIAL_VISIBLE_CONVERSATIONS = 100;

const normalizeDigits = (value) => String(value || "").replace(/\D/g, "");

const parseReferenceDate = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  const fallback = Date.parse(`${year}-${month}-${day}T00:00:00-03:00`);
  return Number.isFinite(fallback) ? fallback : null;
};

const resolveCustomerCreatedAt = (row) => {
  const parsed = parseReferenceDate(
    row?.createdAtExternal || row?.createdAt || row?.created_at || null,
  );
  return Number.isFinite(parsed) ? new Date(parsed) : null;
};

const resolveCustomerExpiryAt = (row) => {
  const parsed = parseReferenceDate(
    row?.expiresAtExternal ||
      row?.expiresAtTz ||
      row?.expiresAt ||
      row?.expires_at ||
      row?.vencimento ||
      null,
  );
  return Number.isFinite(parsed) ? new Date(parsed) : null;
};

const isTesteCustomer = (row) => {
  if (Boolean(row?.isTeste)) return true;
  const plan = String(row?.packageName || row?.planoAtual || row?.plan || "").trim().toUpperCase();
  return plan.includes("TESTE");
};

const resolveChurnSystemKey = (row, now = Date.now()) => {
  if (!row || isTesteCustomer(row)) return null;
  const reference = resolveCustomerExpiryAt(row);
  if (!reference) return null;
  const diffDays = Math.floor((now - reference.getTime()) / DAY_MS);
  if (diffDays < 1) return null;
  return "churn";
};

const isRecentInstallCustomer = (row, now = Date.now()) => {
  if (!row || isTesteCustomer(row)) return false;
  const createdAt = resolveCustomerCreatedAt(row);
  if (!createdAt) return false;
  return now - createdAt.getTime() <= 30 * DAY_MS;
};

const resolveConversationTimestamp = (value) => {
  if (!value) return 0;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const countUnread = (conversation) =>
  Number(conversation?.unreadCount ?? conversation?.unread_count ?? 0);

const resolveLastClientTime = (conversation) => conversation?.lastClientMessageTime || null;

const isIn24hWindow = (conversation, now = Date.now()) => {
  const lastClientTime = resolveLastClientTime(conversation);
  if (!lastClientTime) return false;
  const timestamp = resolveConversationTimestamp(lastClientTime);
  return timestamp > 0 && now - timestamp <= DAY_MS;
};

const getConversationSortTimestamp = (conversation) =>
  Math.max(
    resolveConversationTimestamp(conversation?.last_received_at),
    resolveConversationTimestamp(conversation?.last_sent_at),
    resolveConversationTimestamp(conversation?.lastClientMessageTime),
    resolveConversationTimestamp(conversation?.lastMessageTime),
    resolveConversationTimestamp(conversation?.last_message_at),
  );

const mergeContactLabels = (base = [], next = []) => {
  const result = new Map();
  [...base, ...next].forEach((label) => {
    if (!label?.id) return;
    result.set(String(label.id), label);
  });
  return Array.from(result.values());
};

const buildSyntheticConversation = ({
  id,
  phone,
  name,
  subtitle,
  labels = [],
  lastMessageTime,
  lastClientMessageTime = null,
  contactId = null,
  existsInBase = false,
  isTeste = false,
  usuario = "",
  username = "",
}) => {
  const safeLastMessageTime =
    lastMessageTime instanceof Date && Number.isFinite(lastMessageTime.getTime())
      ? lastMessageTime
      : new Date(0);
  const safeLastClientMessageTime =
    lastClientMessageTime instanceof Date && Number.isFinite(lastClientMessageTime.getTime())
      ? lastClientMessageTime
      : undefined;

  return {
    id,
    customer: {
      id: phone || id,
      name: String(name || phone || "Contato").trim() || "Contato",
      phone,
      contactId,
      existsInBase: Boolean(existsInBase),
      isTeste: Boolean(isTeste),
      usuario: usuario || undefined,
      username: username || undefined,
      jid: phone || null,
      isPrivateId: false,
      plan: "",
      planStatus: "active",
      city: "",
      activationDate: "",
      paymentStatus: "ok",
      churnScore: 0,
    },
    sector: "suporte",
    priority: "medium",
    status: "waiting",
    lastMessage: String(subtitle || "").trim(),
    lastMessageTime: safeLastMessageTime,
    lastClientMessageTime: safeLastClientMessageTime,
    unreadCount: 0,
    unread_count: 0,
    last_message_at: safeLastMessageTime.toISOString(),
    last_received_at: safeLastClientMessageTime ? safeLastClientMessageTime.toISOString() : null,
    last_sent_at: null,
    last_read_at: null,
    is_active_conversation: false,
    is_in_attendance: false,
    is_pending: true,
    is_broadcast: false,
    tags: [],
    labels,
    assignedTo: undefined,
    createdAt: safeLastMessageTime,
  };
};

const hasLabelInConversation = (conversation, labelIds) =>
  Array.isArray(conversation?.labels) &&
  conversation.labels.some((label) => labelIds.has(String(label?.id || "")));

const isConversationTeste = (conversation, customerByPhone) => {
  if (conversation?.customer?.isTeste) return true;
  const phone = normalizeDigits(
    conversation?.customer?.phone || conversation?.customer?.jid || conversation?.id || "",
  );
  const customer = phone ? customerByPhone.get(phone) : null;
  return Boolean(customer && isTesteCustomer(customer));
};

const filterBySearchAndLabels = ({ items, search = "", selectedLabelIds = [] }) => {
  const normalizedSearch = normalizeDigits(search);
  const searchLower = String(search || "").trim().toLowerCase();
  const hasSelectedLabelFilters = Array.isArray(selectedLabelIds) && selectedLabelIds.length > 0;
  return items.filter((conversation) => {
    const normalizedPhone = normalizeDigits(conversation?.customer?.phone || "");
    const panelUser = String(
      conversation?.customer?.username || conversation?.customer?.usuario || "",
    ).toLowerCase();
    const matchesSearch =
      !searchLower ||
      String(conversation?.customer?.name || "").toLowerCase().includes(searchLower) ||
      panelUser.includes(searchLower) ||
      String(conversation?.lastMessage || "").toLowerCase().includes(searchLower) ||
      (normalizedSearch && normalizedPhone.includes(normalizedSearch));

    const conversationLabelIds = Array.isArray(conversation?.labels)
      ? conversation.labels.map((label) => String(label?.id || ""))
      : [];
    const matchesSelectedLabels =
      !hasSelectedLabelFilters ||
      selectedLabelIds.some((labelId) => conversationLabelIds.includes(String(labelId)));

    return matchesSearch && matchesSelectedLabels;
  });
};

const orderConversations = (items) =>
  [...items]
    .map((conversation, index) => ({ conversation, index }))
    .sort((a, b) => {
      const timestampDiff =
        getConversationSortTimestamp(b.conversation) - getConversationSortTimestamp(a.conversation);
      if (timestampDiff !== 0) return timestampDiff;
      return a.index - b.index;
    })
    .map((item) => item.conversation);

export const buildInboxSectionPayload = ({
  conversations = [],
  customers = [],
  contacts = [],
  availableLabels = [],
  section = "attending",
  leadSelection = "lead",
  search = "",
  selectedLabelIds = [],
  outsideWindowChunks = 0,
  now = Date.now(),
}) => {
  const labelsBySystemKey = new Map(
    availableLabels
      .filter(Boolean)
      .map((label) => [String(label.systemKey || ""), label])
      .filter(([key]) => Boolean(key)),
  );
  const labelsByNormalizedName = new Map(
    availableLabels
      .filter(Boolean)
      .map((label) => [String(label.name || "").trim().toLowerCase(), label])
      .filter(([key]) => Boolean(key)),
  );
  const customerByPhone = new Map(
    customers
      .map((customer) => [normalizeDigits(customer?.whatsapp || customer?.phone || ""), customer])
      .filter(([phone]) => Boolean(phone)),
  );
  const actualConversationIds = new Set(
    conversations.map((conversation) => String(conversation?.id || "")).filter(Boolean),
  );
  const conversationByPhone = new Map();
  conversations.forEach((conversation) => {
    const phone = normalizeDigits(
      conversation?.customer?.phone || conversation?.customer?.jid || conversation?.id || "",
    );
    if (!phone) return;
    const existing = conversationByPhone.get(phone);
    if (!existing || getConversationSortTimestamp(conversation) >= getConversationSortTimestamp(existing)) {
      conversationByPhone.set(phone, conversation);
    }
  });
  const contactsByPhone = new Map();
  contacts.forEach((contact) => {
    const phone = normalizeDigits(contact?.number || "");
    if (!phone) return;
    contactsByPhone.set(phone, contact);
  });

  const leadOptions = [
    labelsBySystemKey.get("lead") || labelsByNormalizedName.get("lead"),
    labelsBySystemKey.get("teste01") || labelsByNormalizedName.get("teste01"),
    labelsBySystemKey.get("teste02") || labelsByNormalizedName.get("teste02"),
  ].filter(Boolean);
  const selectedLeadOption =
    leadOptions.find((label) => {
      const value = String(label.systemKey || label.name || "").trim().toLowerCase();
      return value === String(leadSelection || "").trim().toLowerCase();
    }) || leadOptions[0] || null;
  const leadLabelIds = new Set(leadOptions.map((label) => String(label.id || "")).filter(Boolean));

  const postSaleLabels = [
    labelsBySystemKey.get("promoter") || labelsByNormalizedName.get("promotor"),
    labelsBySystemKey.get("detractor") || labelsByNormalizedName.get("detrator"),
  ].filter(Boolean);
  const postSaleLabelIds = new Set(
    postSaleLabels.map((label) => String(label.id || "")).filter(Boolean),
  );

  const churnLabels = [labelsBySystemKey.get("churn")].filter(Boolean);
  const churnLabelIds = new Set(churnLabels.map((label) => String(label.id || "")).filter(Boolean));

  const customerAutoLabel =
    labelsBySystemKey.get("customer") || labelsByNormalizedName.get("cliente") || null;

  const recentInstallPhones = new Set(
    customers
      .filter((customer) => isRecentInstallCustomer(customer, now))
      .map((customer) => normalizeDigits(customer?.whatsapp || customer?.phone || ""))
      .filter(Boolean),
  );

  const leadDisplayConversations = contacts
    .filter((contact) => hasLabelInConversation(contact, leadLabelIds))
    .map((contact) => {
      const phone = normalizeDigits(contact?.number || "");
      const existingConversation = phone ? conversationByPhone.get(phone) : null;
      if (existingConversation) {
        return {
          ...existingConversation,
          labels: mergeContactLabels(existingConversation.labels || [], contact.labels || []),
        };
      }
      return buildSyntheticConversation({
        id: `lead-${contact.id}`,
        phone,
        name: contact?.name || phone,
        subtitle: "Contato classificado em lead sem conversa ativa",
        labels: Array.isArray(contact?.labels) ? contact.labels : [],
        lastMessageTime: contact?.lastInteractionAt ? new Date(contact.lastInteractionAt) : new Date(0),
        lastClientMessageTime: contact?.lastClientMessageAt ? new Date(contact.lastClientMessageAt) : null,
        contactId: contact?.id || null,
        existsInBase: Boolean(contact?.existsInBase),
        isTeste: Boolean(contact?.isTeste),
      });
    });

  const mergedPostSaleByPhone = new Map();
  customers
    .filter((customer) => isRecentInstallCustomer(customer, now))
    .forEach((customer) => {
      const phone = normalizeDigits(customer?.whatsapp || customer?.phone || "");
      if (!phone) return;
      mergedPostSaleByPhone.set(phone, {
        ...(mergedPostSaleByPhone.get(phone) || {}),
        customer,
      });
    });
  contacts
    .filter((contact) => hasLabelInConversation(contact, postSaleLabelIds))
    .forEach((contact) => {
      const phone = normalizeDigits(contact?.number || "");
      if (!phone) return;
      mergedPostSaleByPhone.set(phone, {
        ...(mergedPostSaleByPhone.get(phone) || {}),
        contact,
      });
    });

  const postSaleDisplayConversations = Array.from(mergedPostSaleByPhone.entries()).map(
    ([phone, entry]) => {
      const existingConversation = conversationByPhone.get(phone) || null;
      const customer = entry.customer || customerByPhone.get(phone) || null;
      const contact = entry.contact || contactsByPhone.get(phone) || null;
      const resolvedLabels = mergeContactLabels(
        contact?.labels || [],
        customerAutoLabel && customer ? [customerAutoLabel] : [],
      );

      if (existingConversation) {
        return {
          ...existingConversation,
          labels: mergeContactLabels(existingConversation.labels || [], resolvedLabels),
        };
      }

      return buildSyntheticConversation({
        id: `post-sale-${contact?.id || customer?.customerId || phone}`,
        phone,
        name:
          contact?.name ||
          String(customer?.username || customer?.usuario || phone).trim() ||
          phone,
        subtitle:
          String(
            customer?.planoAtual || customer?.packageName || contact?.status || "Cliente recente",
          ).trim() || "Cliente recente",
        labels: resolvedLabels,
        lastMessageTime:
          (customer && resolveCustomerCreatedAt(customer)) ||
          (contact?.lastInteractionAt ? new Date(contact.lastInteractionAt) : null) ||
          new Date(0),
        lastClientMessageTime: contact?.lastClientMessageAt ? new Date(contact.lastClientMessageAt) : null,
        contactId: contact?.id || (phone ? `contact-phone:${phone}` : null),
        existsInBase: true,
        isTeste: false,
        usuario: customer?.usuario || "",
        username: customer?.username || "",
      });
    },
  );

  const churnDisplayConversations = customers
    .filter((customer) => Boolean(resolveChurnSystemKey(customer, now)))
    .map((customer) => {
      const phone = normalizeDigits(customer?.whatsapp || customer?.phone || "");
      const existingConversation = phone ? conversationByPhone.get(phone) : null;
      const matchedContact = phone ? contactsByPhone.get(phone) : null;
      const churnSystemKey = resolveChurnSystemKey(customer, now);
      const churnLabel = churnSystemKey ? labelsBySystemKey.get(churnSystemKey) || null : null;
      const resolvedLabels = mergeContactLabels(
        matchedContact?.labels || [],
        churnLabel ? [churnLabel] : [],
      );

      if (existingConversation) {
        return {
          ...existingConversation,
          labels: mergeContactLabels(existingConversation.labels || [], resolvedLabels),
        };
      }

      return buildSyntheticConversation({
        id: `churn-${matchedContact?.id || customer?.customerId || phone}`,
        phone,
        name:
          matchedContact?.name ||
          String(customer?.username || customer?.usuario || phone).trim() ||
          phone,
        subtitle:
          String(customer?.status || customer?.situacao || matchedContact?.status || "Cliente vencido").trim() ||
          "Cliente vencido",
        labels: resolvedLabels,
        lastMessageTime:
          (matchedContact?.lastInteractionAt ? new Date(matchedContact.lastInteractionAt) : null) ||
          resolveCustomerExpiryAt(customer) ||
          new Date(0),
        lastClientMessageTime: matchedContact?.lastClientMessageAt ? new Date(matchedContact.lastClientMessageAt) : null,
        contactId: matchedContact?.id || (phone ? `contact-phone:${phone}` : null),
        existsInBase: true,
        isTeste: false,
        usuario: customer?.usuario || "",
        username: customer?.username || "",
      });
    });

  const mergedAllByKey = new Map();
  const upsertConversation = (conversation) => {
    const phone = normalizeDigits(
      conversation?.customer?.phone || conversation?.customer?.jid || conversation?.id || "",
    );
    const key = phone || `id:${conversation.id}`;
    const existing = mergedAllByKey.get(key);
    if (!existing) {
      mergedAllByKey.set(key, conversation);
      return;
    }
    const nextTimestamp = getConversationSortTimestamp(conversation);
    const existingTimestamp = getConversationSortTimestamp(existing);
    mergedAllByKey.set(key, {
      ...(nextTimestamp >= existingTimestamp ? conversation : existing),
      labels: mergeContactLabels(existing.labels || [], conversation.labels || []),
      unreadCount: Math.max(countUnread(existing), countUnread(conversation)),
      unread_count: Math.max(countUnread(existing), countUnread(conversation)),
      lastClientMessageTime:
        conversation?.lastClientMessageTime &&
        (!existing?.lastClientMessageTime ||
          resolveConversationTimestamp(conversation.lastClientMessageTime) >=
            resolveConversationTimestamp(existing.lastClientMessageTime))
          ? conversation.lastClientMessageTime
          : existing?.lastClientMessageTime,
    });
  };

  conversations.forEach(upsertConversation);
  leadDisplayConversations.forEach(upsertConversation);
  postSaleDisplayConversations.forEach(upsertConversation);
  churnDisplayConversations.forEach(upsertConversation);

  const allDisplayConversations = Array.from(mergedAllByKey.values());
  const attendingConversations = allDisplayConversations;
  const nonTestConversations = allDisplayConversations.filter(
    (conversation) => !isConversationTeste(conversation, customerByPhone),
  );

  const sectionConversations = {
    attending: attendingConversations,
    unread: attendingConversations.filter((conversation) => countUnread(conversation) > 0),
    lead: attendingConversations.filter((conversation) => hasLabelInConversation(conversation, leadLabelIds)),
    post_sale: nonTestConversations.filter((conversation) => {
      const phone = normalizeDigits(
        conversation?.customer?.phone || conversation?.customer?.jid || conversation?.id || "",
      );
      return recentInstallPhones.has(phone) || hasLabelInConversation(conversation, postSaleLabelIds);
    }),
    churn: nonTestConversations.filter((conversation) => {
      const phone = normalizeDigits(
        conversation?.customer?.phone || conversation?.customer?.jid || conversation?.id || "",
      );
      const customer = phone ? customerByPhone.get(phone) : null;
      return hasLabelInConversation(conversation, churnLabelIds) || Boolean(customer && resolveChurnSystemKey(customer, now));
    }),
  };

  let sourceConversations = sectionConversations.attending;
  if (section === "unread") {
    sourceConversations = sectionConversations.unread;
  } else if (section === "lead") {
    sourceConversations = selectedLeadOption
      ? attendingConversations.filter((conversation) =>
          hasLabelInConversation(conversation, new Set([String(selectedLeadOption.id)])),
        )
      : [];
  } else if (section === "post_sale") {
    sourceConversations = sectionConversations.post_sale;
  } else if (section === "churn") {
    sourceConversations = sectionConversations.churn;
  }

  const hasGlobalSearch = Boolean(String(search || "").trim());
  if (hasGlobalSearch) {
    sourceConversations = attendingConversations;
  }

  const filteredConversations = filterBySearchAndLabels({
    items: sourceConversations,
    search,
    selectedLabelIds,
  });
  const orderedConversations = orderConversations(filteredConversations);

  const safeChunkCount = Math.max(0, Number.parseInt(String(outsideWindowChunks || 0), 10) || 0);
  const visibleConversationLimit =
    INITIAL_VISIBLE_CONVERSATIONS + safeChunkCount * OUTSIDE_WINDOW_BATCH_SIZE;
  const limitedConversations = orderedConversations.slice(0, visibleConversationLimit);
  const hiddenOutsideWindowCount = Math.max(
    0,
    orderedConversations.length - limitedConversations.length,
  );

  const unreadCounts = Object.fromEntries(
    Object.entries(sectionConversations).map(([key, items]) => [
      key,
      items.filter((conversation) => countUnread(conversation) > 0).length,
    ]),
  );

  return {
    items: limitedConversations,
    unreadCounts,
    hiddenOutsideWindowCount,
    batchSize: OUTSIDE_WINDOW_BATCH_SIZE,
    totalFiltered: filteredConversations.length,
    totalAvailable: sourceConversations.length,
    searchScope: hasGlobalSearch ? "global" : "section",
    leadSelection: selectedLeadOption
      ? String(selectedLeadOption.systemKey || selectedLeadOption.name || "").trim().toLowerCase()
      : null,
  };
};
