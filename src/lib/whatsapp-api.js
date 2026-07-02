import { buildWhatsappApiUrl, requestWhatsappJson } from './whatsapp-http';

import { requestChatJson } from '@/features/chat/api/chat-api';
import { ENABLE_NEW_CHAT_DATA_LAYER } from '@/lib/performance-config';

const SECTOR_TO_DEPARTMENT = {
  suporte: 'support',
  comercial: 'sales',
  financeiro: 'billing',
  retencao: 'general',
};

const DEFAULT_QUICK_REPLIES = [
  {
    id: 'default-greeting',
    title: 'Saudacao inicial',
    shortcut: '/oi',
    category: 'greeting',
    content: 'Ola. Recebi sua mensagem e vou te atender agora.',
  },
  {
    id: 'default-pix',
    title: 'Solicitar comprovante',
    shortcut: '/comprovante',
    category: 'support',
    content: 'Pode me enviar o comprovante de pagamento para eu conferir aqui?',
  },
  {
    id: 'default-transfer',
    title: 'Encaminhar setor',
    shortcut: '/setor',
    category: 'support',
    content: 'Vou encaminhar sua solicitacao para o setor responsavel e retorno em seguida.',
  },
];

const normalizeComparableText = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const normalizeRouteKey = (value) => String(value || '').trim().toLowerCase();

const conversationsResponseCache = new Map();

const parseJsonResponse = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const resolveDepartment = (sector) => {
  const key = String(sector || '').trim().toLowerCase();
  return SECTOR_TO_DEPARTMENT[key] || 'general';
};

const resolveMessageContent = (message) => {
  if (String(message?.content || message?.body || '').trim()) {
    return String(message.content || message.body);
  }

  const firstAttachment = Array.isArray(message?.attachments) ? message.attachments[0] : null;
  const attachmentType = String(firstAttachment?.type || message?.messageType || message?.message_type || message?.type || '').toLowerCase();

  if (attachmentType === 'image') return '[Imagem]';
  if (attachmentType === 'audio') return '[Audio]';
  if (attachmentType === 'video') return '[Video]';
  if (attachmentType === 'document') return '[Documento]';
  if (attachmentType === 'sticker') return '[Figurinha]';

  return '';
};

const resolveSenderType = (message) => {
  const type = String(message?.sender_type || message?.senderType || message?.from || '').toLowerCase();
  const direction = String(message?.direction || '').toLowerCase();

  if (type === 'agent' || direction === 'outbound') return 'agent';
  if (type === 'system') return 'system';
  return 'client';
};

const resolveIncomingMessageServerId = (message) =>
  String(
    message?.providerMessageId ||
      message?.provider_message_id ||
      message?.wamid ||
      message?.id ||
      message?.messageId ||
      message?.message_id ||
      message?.meta_message_id ||
      message?.raw?.id ||
      ''
  ).trim();

const isGenericAgentSenderName = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return ['agente', 'agent'].includes(normalized);
};

const resolveAgentSenderName = (message = {}) => {
  const raw = message?.raw || {};
  const candidates = [
    message?.agentName,
    message?.agent_name,
    message?.senderName,
    message?.sender_name,
    message?.operatorName,
    message?.operator_name,
    message?.attendantName,
    message?.attendant_name,
    message?.createdByName,
    message?.created_by_name,
    message?.userName,
    message?.user_name,
    message?.user?.full_name,
    message?.user?.name,
    message?.agent?.full_name,
    message?.agent?.name,
    raw?.agentName,
    raw?.agent_name,
    raw?.senderName,
    raw?.sender_name,
    raw?.operatorName,
    raw?.operator_name,
    raw?.attendantName,
    raw?.attendant_name,
    raw?.createdByName,
    raw?.created_by_name,
    raw?.userName,
    raw?.user_name,
    raw?.user?.full_name,
    raw?.user?.name,
    raw?.agent?.full_name,
    raw?.agent?.name,
  ];

  const resolvedName = candidates
    .map((candidate) => String(candidate || '').trim())
    .find((candidate) => candidate && !isGenericAgentSenderName(candidate));

  return resolvedName || 'Agente';
};

const normalizeAttachmentUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^data:/i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) {
    return buildWhatsappApiUrl(raw);
  }
  return raw;
};

const normalizeWhatsappAttachment = (attachment = {}) => ({
  ...attachment,
  id: attachment.id || attachment.mediaId || attachment.media_id || null,
  mediaId: attachment.mediaId || attachment.media_id || attachment.id || null,
  url: normalizeAttachmentUrl(
    attachment.thumbnailUrl ||
      attachment.thumbnail_url ||
      attachment.url ||
      (!(attachment.id || attachment.mediaId || attachment.media_id) ? attachment.originalUrl || attachment.original_url : ''),
  ),
  originalUrl: normalizeAttachmentUrl(attachment.originalUrl || attachment.original_url),
  thumbnailUrl: normalizeAttachmentUrl(attachment.thumbnailUrl || attachment.thumbnail_url),
  name: attachment.name || '',
  mimeType: attachment.mimeType || attachment.mime_type || attachment.mimetype || '',
});

const buildFallbackSourceLabel = (selector = {}, conversationId = '') => {
  const routeKey = normalizeRouteKey(selector?.routeKey || '');
  const byRoute =
    routeKey === 'vendas'
      ? 'numero Vendas'
      : routeKey === 'vendas2'
        ? 'numero Vendas2'
        : routeKey === 'default'
          ? 'numero Default'
          : '';
  const byPhone = String(selector?.displayPhoneNumber || selector?.sourcePhoneNumber || '').trim();
  if (byRoute && byPhone) return `${byRoute} (${byPhone})`;
  if (byRoute) return byRoute;
  if (byPhone) return `numero ${byPhone}`;
  const safeConversationId = String(conversationId || '').trim();
  return safeConversationId ? `canal ${safeConversationId}` : 'outro numero oficial';
};

const resolveConversationTimestampMs = (conversation = {}) =>
  Math.max(
    Date.parse(String(conversation.lastMessageTime || conversation.last_message_at || '')) || 0,
    Date.parse(String(conversation.updated_date || '')) || 0,
    Date.parse(String(conversation.createdAt || '')) || 0
  );

const resolveConversationPhone = (conversation = {}) => {
  const customer = conversation.customer || {};
  return (
    normalizePhone(customer.phone) ||
    normalizePhone(conversation.contact_phone) ||
    normalizePhone(conversation.phone) ||
    normalizePhone(customer.whatsapp) ||
    ''
  );
};

const resolveRouteSelectorFromConversation = (conversation = {}) => {
  const customer = conversation.customer || {};
  return {
    phoneNumberId:
      conversation.phone_number_id ||
      conversation.phoneNumberId ||
      customer.phone_number_id ||
      customer.phoneNumberId ||
      null,
    displayPhoneNumber:
      conversation.display_phone_number ||
      conversation.displayPhoneNumber ||
      customer.display_phone_number ||
      customer.displayPhoneNumber ||
      null,
    routeKey: normalizeRouteKey(conversation.meta_route_key || conversation.metaRouteKey || customer.meta_route_key || ''),
  };
};

const resolveMessageRouteSelector = (message = {}, fallbackSelector = null) => {
  const raw = message.raw || {};
  const fallback = fallbackSelector && typeof fallbackSelector === 'object' ? fallbackSelector : {};
  const selector = {
    phoneNumberId:
      message.phone_number_id ||
      message.phoneNumberId ||
      raw.phone_number_id ||
      raw.phoneNumberId ||
      raw.meta_phone_number_id ||
      raw.metadata?.phone_number_id ||
      fallback.phoneNumberId ||
      null,
    displayPhoneNumber:
      message.display_phone_number ||
      message.displayPhoneNumber ||
      raw.display_phone_number ||
      raw.displayPhoneNumber ||
      raw.meta_display_phone_number ||
      raw.metadata?.display_phone_number ||
      raw.from_phone_number ||
      fallback.displayPhoneNumber ||
      null,
    routeKey: normalizeRouteKey(
      message.route_key ||
      message.routeKey ||
      message.meta_route_key ||
      raw.meta_route_key ||
      raw.routeKey ||
      raw.sourceAccountKey ||
      fallback.routeKey ||
      '',
    ),
    sourceAccountId: String(
      raw.sourceAccountId ||
      raw.source_account_id ||
      raw.accountId ||
      raw.waba_id ||
      fallback.sourceAccountId ||
      ''
    ).trim(),
    sourceAccountName: String(
      raw.sourceAccountName ||
      raw.source_account_name ||
      raw.accountName ||
      fallback.sourceAccountName ||
      ''
    ).trim(),
    sourcePhoneNumber: String(
      raw.sourcePhoneNumber ||
      raw.source_phone_number ||
      raw.display_phone_number ||
      raw.displayPhoneNumber ||
      raw.from_phone_number ||
      fallback.sourcePhoneNumber ||
      ''
    ).trim(),
  };

  return selector;
};

export const normalizeWhatsappConversation = (conversation = {}) => {
  const customer = conversation.customer || {};
  const labels = Array.isArray(conversation.labels) ? conversation.labels : [];
  const rawLabelIds = [
    ...(Array.isArray(conversation.label_ids) ? conversation.label_ids : []),
    ...(Array.isArray(conversation.labelIds) ? conversation.labelIds : []),
    conversation.service_label_override_id,
    conversation.serviceLabelOverrideId,
  ]
    .map((labelId) => String(labelId || '').trim())
    .filter(Boolean);
  const manualTags = Array.isArray(conversation.tags) ? conversation.tags : [];
  const normalizedLastMessage = conversation.lastMessage || conversation.last_message || '';
  const normalizedLastMessageType = String(
    conversation.lastMessageType ||
      conversation.last_message_type ||
      conversation.messageType ||
      ''
  )
    .trim()
    .toLowerCase();

  return {
    id: conversation.id,
    status: conversation.status || 'waiting',
    priority: conversation.priority || 'low',
    department: resolveDepartment(conversation.sector),
    contact_name: conversation.contact_name || customer.name || 'Contato sem nome',
    contact_phone: conversation.contact_phone || customer.phone || '',
    normalized_phone: conversation.normalized_phone || conversation.normalizedPhone || conversation.contact_phone || customer.phone || '',
    phone_number_id:
      conversation.phone_number_id ||
      conversation.phoneNumberId ||
      customer.phone_number_id ||
      customer.phoneNumberId ||
      null,
    display_phone_number:
      conversation.display_phone_number ||
      conversation.displayPhoneNumber ||
      customer.display_phone_number ||
      customer.displayPhoneNumber ||
      null,
    waba_id: conversation.waba_id || conversation.wabaId || null,
    meta_route_key: conversation.meta_route_key || conversation.metaRouteKey || conversation.route_key || conversation.routeKey || null,
    customer,
    sector: conversation.sector || '',
    tags: manualTags,
    labels,
    label_ids: Array.from(
      new Set([
        ...labels.map((label) => String(label?.id || '').trim()).filter(Boolean),
        ...rawLabelIds,
      ]),
    ),
    label_names: labels.map((label) => label?.name).filter(Boolean),
    service_label_override_id: conversation.service_label_override_id || conversation.serviceLabelOverrideId || '',
    service_label_override_service_id:
      conversation.service_label_override_service_id || conversation.serviceLabelOverrideServiceId || '',
    service_label_override_at: conversation.service_label_override_at || conversation.serviceLabelOverrideAt || '',
    last_message: normalizedLastMessage,
    last_message_type: normalizedLastMessageType,
    last_message_time: conversation.lastMessageTime || conversation.last_message_at || conversation.createdAt || null,
    last_message_at: conversation.last_message_at || conversation.lastMessageTime || null,
    created_date: conversation.createdAt || null,
    updated_date: conversation.lastMessageTime || conversation.last_message_at || conversation.createdAt || null,
    unread_count:
      Number.isFinite(Number(conversation.unread_count))
        ? Number(conversation.unread_count)
        : Number(conversation.unreadCount || 0),
    unreadCount:
      Number.isFinite(Number(conversation.unreadCount))
        ? Number(conversation.unreadCount)
        : Number(conversation.unread_count || 0),
    is_pending: Boolean(conversation.is_pending),
    is_in_attendance: Boolean(conversation.is_in_attendance),
    is_broadcast: Boolean(conversation.is_broadcast),
    last_read_at: conversation.last_read_at || null,
    last_received_at: conversation.last_received_at || null,
    last_sent_at: conversation.last_sent_at || null,
    last_client_message_time:
      conversation.lastClientMessageTime ||
      conversation.last_received_at ||
      conversation.lastMessageTime ||
      null,
    is_within_customer_window: (() => {
      if (typeof conversation.is24hWindowOpen === 'boolean') return conversation.is24hWindowOpen;
      const referenceTime =
        conversation.lastClientMessageTime ||
        conversation.last_received_at ||
        conversation.lastMessageTime ||
        '';
      const timeMs = Date.parse(String(referenceTime || ''));
      if (!Number.isFinite(timeMs)) return false;
      return Date.now() - timeMs <= 24 * 60 * 60 * 1000;
    })(),
    avatar_url:
      conversation.avatar_url ||
      customer.profilePictureUrl ||
      customer.profile_picture_url ||
      customer.avatarUrl ||
      customer.photoUrl ||
      null,
    assigned_agent: conversation.assigned_agent || conversation.assignedAgent || '',
    assigned_agent_id: conversation.assigned_agent_id || conversation.assignedAgentId || '',
    assigned_agent_email: conversation.assigned_agent_email || conversation.assignedAgentEmail || '',
    assigned_agent_name: conversation.assigned_agent_name || conversation.assignedAgentName || '',
    queue_id: conversation.queue_id || conversation.queueId || '',
    service_id: conversation.service_id || conversation.serviceId || '',
    assignment_status: conversation.assignment_status || conversation.assignmentStatus || '',
    standard_label: conversation.standard_label || conversation.standardLabel || '',
    standard_label_source: conversation.standard_label_source || conversation.standardLabelSource || '',
    standard_label_reason: conversation.standard_label_reason || conversation.standardLabelReason || '',
    standard_label_overridden: Boolean(conversation.standard_label_overridden || conversation.standardLabelOverridden),
    standard_label_updated_at: conversation.standard_label_updated_at || conversation.standardLabelUpdatedAt || '',
    last_inbound_route_key: conversation.last_inbound_route_key || conversation.lastInboundRouteKey || conversation.route_key || '',
    last_inbound_phone_number_id: conversation.last_inbound_phone_number_id || conversation.lastInboundPhoneNumberId || conversation.phone_number_id || '',
    last_24h_window_expires_at: conversation.last_24h_window_expires_at || conversation.windowExpiresAt || '',
    queue_status: conversation.queue_status || conversation.queueStatus || (conversation.assignment_status === 'queued' ? 'waiting' : conversation.assignment_status || ''),
    queued_service_id: conversation.queued_service_id || conversation.queue_id || conversation.service_id || '',
    queued_service_ids: Array.from(new Set([conversation.queue_id,conversation.service_id].map((value)=>String(value||'').trim()).filter(Boolean))),
    queued_service_name: conversation.queued_service_name || conversation.queuedServiceName || '',
    queued_service_names: Array.isArray(conversation.queued_service_names)
      ? conversation.queued_service_names
      : Array.isArray(conversation.queuedServiceNames)
        ? conversation.queuedServiceNames
        : [],
    matching_service_ids: Array.from(new Set([conversation.queue_id,conversation.service_id].map((value)=>String(value||'').trim()).filter(Boolean))),
    is_pinned: Boolean(conversation.is_pinned || conversation.isPinned),
    manual_unread: Boolean(conversation.manual_unread || conversation.manualUnread),
    source_accounts: Array.isArray(conversation.source_accounts) ? conversation.source_accounts : [],
    active_route_selector: conversation.active_route_selector || conversation.activeRouteSelector || null,
    default_route_selector: conversation.default_route_selector || conversation.defaultRouteSelector || null,
    assigned_at: conversation.assigned_at || conversation.assignedAt || '',
    assignment_source: conversation.assignment_source || conversation.assignmentSource || '',
    notes: conversation.notes || conversation.note || '',
    follow_up_at: conversation.follow_up_at || conversation.followUpAt || null,
    media_summary: {
      hasAudio:
        normalizedLastMessageType === 'audio' || normalizedLastMessage.includes('[Audio]') || normalizedLastMessage.includes('[audio]'),
      hasImage:
        normalizedLastMessageType === 'image' ||
        normalizedLastMessageType === 'sticker' ||
        normalizedLastMessage.includes('[Imagem]') ||
        normalizedLastMessage.includes('[image]') ||
        normalizedLastMessage.includes('[Figurinha]'),
      hasVideo:
        normalizedLastMessageType === 'video' || normalizedLastMessage.includes('[Video]') || normalizedLastMessage.includes('[video]'),
    },
    sourceConversation: conversation,
  };
};

export const normalizeWhatsappMessage = (message = {}, options = {}) => {
  const senderType = resolveSenderType(message);
  const origin = String(message.origin || message.source || message.messageOrigin || '').trim().toLowerCase();
  const customerName = message.customerName || '';
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map(normalizeWhatsappAttachment)
    : message.media && typeof message.media === 'object'
      ? [normalizeWhatsappAttachment({ ...message.media, type: message.type || message.messageType || 'document' })]
      : [];
  const serverMessageId = resolveIncomingMessageServerId(message);
  const replyToId =
    message.reply_to_id ||
    message.replyTo?.id ||
    message.replyToId ||
    message.context?.id ||
    null;

  const routeSelector = resolveMessageRouteSelector(message, options.routeSelector);
  const sourceConversationId = String(
    options.sourceConversationId || message.conversationId || message.conversation_id || ''
  ).trim();
  const sourceConversationLabel = String(options.sourceConversationLabel || '').trim();

  return {
    id: message.clientMessageId || message.client_message_id || serverMessageId || message.id || message.message_key || '',
    server_message_id: serverMessageId,
    client_message_id: message.clientMessageId || message.client_message_id || null,
    provider_message_id: message.providerMessageId || message.provider_message_id || message.wamid || serverMessageId || null,
    conversation_id: message.conversationId || message.conversation_id || null,
    sender_type: senderType,
    origin,
    is_bot_message:
      senderType === 'agent' &&
      ['routine', 'chatbot', 'flow', 'scheduled-message', 'label-campaign', 'campaign-dispatch', 'routine-dispatch', 'bot', 'automation'].includes(origin),
    agentName: message.agentName || message.agent_name || null,
    agent_name: message.agent_name || message.agentName || null,
    senderName: message.senderName || message.sender_name || null,
    operatorName: message.operatorName || message.operator_name || null,
    attendantName: message.attendantName || message.attendant_name || null,
    createdByName: message.createdByName || message.created_by_name || null,
    userName: message.userName || message.user_name || null,
    sender_name:
      senderType === 'agent'
        ? resolveAgentSenderName(message)
        : senderType === 'system'
          ? 'Sistema'
          : customerName || 'Cliente',
    message_type: message.messageType || message.message_type || message.type || 'text',
    status: message.status || 'sent',
    content: resolveMessageContent(message),
    transcription:
      message.transcription && typeof message.transcription === 'object'
        ? message.transcription
        : message.audioTranscription && typeof message.audioTranscription === 'object'
          ? message.audioTranscription
          : null,
    reply_to: message.reply_to || null,
    reply_to_id: replyToId ? String(replyToId) : null,
    reply_preview: message.reply_preview || null,
    reactions: Array.isArray(message.reactions) ? message.reactions : [],
    attachments,
    template_buttons: Array.isArray(message.template_buttons)
      ? message.template_buttons
      : Array.isArray(message.templateButtons)
        ? message.templateButtons
        : [],
    templateButtons: Array.isArray(message.templateButtons)
      ? message.templateButtons
      : Array.isArray(message.template_buttons)
        ? message.template_buttons
        : [],
    created_date: message.created_at || message.timestamp || null,
    timestamp: message.timestamp || message.created_at || null,
    route_selector: routeSelector,
    source_conversation_id: sourceConversationId || null,
    source_conversation_label: sourceConversationLabel || null,
    phone_number_id: routeSelector.phoneNumberId || null,
    display_phone_number: routeSelector.displayPhoneNumber || null,
    meta_route_key: routeSelector.routeKey || null,
    source_account_id: routeSelector.sourceAccountId || null,
    source_account_name: routeSelector.sourceAccountName || null,
    source_phone_number: routeSelector.sourcePhoneNumber || null,
    is_read: Boolean(message.isRead),
    raw: message,
    fetch_index: message.__fetchIndex ?? null,
  };
};

const buildMessageBatchFingerprint = (message = {}) =>
  [
    normalizeComparableText(message?.server_message_id),
    normalizeComparableText(message?.created_date || message?.timestamp),
    normalizeComparableText(message?.sender_type),
    normalizeComparableText(message?.message_type),
    normalizeComparableText(message?.content),
    normalizeComparableText(
      (Array.isArray(message?.attachments) ? message.attachments : [])
        .map((attachment) => `${attachment?.type || ''}:${attachment?.url || ''}`)
        .join('|')
    ),
    normalizeComparableText(message?.reply_to_id),
  ].join('|');

const attachStableMessageKeys = (messages = []) => {
  const occurrences = new Map();

  return messages.map((message) => {
    const fingerprint = buildMessageBatchFingerprint(message);
    const currentOccurrence = (occurrences.get(fingerprint) || 0) + 1;
    occurrences.set(fingerprint, currentOccurrence);

    return {
      ...message,
      message_key: `${fingerprint}#${currentOccurrence}`,
      id:
        message.client_message_id ||
        message.provider_message_id ||
        message.server_message_id ||
        message.id ||
        `${fingerprint}#${currentOccurrence}`,
    };
  });
};

const resolveMessageTimeMs = (message = {}) =>
  Date.parse(String(message.created_date || message.timestamp || '')) || 0;

const buildMessageDedupKey = (message = {}) => {
  const serverId = String(message.server_message_id || message.id || '').trim();
  const routeSelector = message.route_selector || {};
  const routePart =
    String(routeSelector.phoneNumberId || '').trim() ||
    String(routeSelector.sourceAccountId || '').trim() ||
    String(routeSelector.sourcePhoneNumber || '').trim() ||
    String(message.meta_route_key || '').trim();
  if (serverId) return `sid:${serverId}|route:${routePart}`;

  return [
    'local',
    normalizeComparableText(message.source_conversation_id),
    normalizeComparableText(message.fetch_index),
    normalizeComparableText(message.sender_type),
    normalizeComparableText(message.created_date || message.timestamp),
    normalizeComparableText(routePart),
  ].join('|');
};

const insertSourceSwitchNotices = (messages = [], aggregateConversation = null) => {
  const sorted = [...messages].sort((left, right) => resolveMessageTimeMs(left) - resolveMessageTimeMs(right));
  const output = [];
  let lastRouteDescriptor = '';

  for (const message of sorted) {
    const selector = message.route_selector || {};
    const routeDescriptor = [
      String(selector.routeKey || '').trim().toLowerCase(),
      String(selector.phoneNumberId || '').trim(),
      String(selector.sourceAccountId || '').trim(),
      String(selector.sourcePhoneNumber || '').trim(),
      String(selector.displayPhoneNumber || '').trim(),
    ]
      .filter(Boolean)
      .join('|');
    const sourceConversationDescriptor = String(message.source_conversation_id || '').trim();
    const effectiveDescriptor =
      routeDescriptor || (sourceConversationDescriptor ? `conv:${sourceConversationDescriptor}` : '');

    if (effectiveDescriptor && lastRouteDescriptor && effectiveDescriptor !== lastRouteDescriptor) {
      const accountLabel =
        selector.sourceAccountName ||
        buildFallbackSourceLabel(
          {
            routeKey: selector.routeKey,
            displayPhoneNumber: selector.displayPhoneNumber,
            sourcePhoneNumber: selector.sourcePhoneNumber,
          },
          sourceConversationDescriptor
        );
      const phoneLabel = selector.displayPhoneNumber || selector.sourcePhoneNumber || '';
      const isInbound = message.sender_type === 'client';
      const noticeText = isInbound
        ? `Cliente enviou mensagem pelo ${accountLabel}${phoneLabel && !accountLabel.includes(phoneLabel) ? ` (${phoneLabel})` : ''}. As proximas respostas deste trecho devem usar este numero.`
        : `Atendimento seguiu pelo ${accountLabel}${phoneLabel && !accountLabel.includes(phoneLabel) ? ` (${phoneLabel})` : ''}.`;
      const messageTime = message.created_date || message.timestamp || new Date().toISOString();
      output.push({
        id: `source-switch-${normalizeComparableText(aggregateConversation?.id || '')}-${output.length}-${message.id}`,
        message_key: `source-switch-${output.length}-${message.id}`,
        conversation_id: aggregateConversation?.id || message.conversation_id || '',
        sender_type: 'system',
        message_type: 'system',
        status: 'sent',
        content: noticeText,
        created_date: messageTime,
        timestamp: messageTime,
      });
    }

    output.push(message);
    if (effectiveDescriptor) lastRouteDescriptor = effectiveDescriptor;
  }

  return output;
};

const aggregateConversationsByCustomerPhone = (items = []) => {
  const byPhone = new Map();

  for (const rawConversation of items) {
    const phone = resolveConversationPhone(rawConversation);
    if (!phone) continue;

    const normalized = normalizeWhatsappConversation(rawConversation);
    const current = byPhone.get(phone);
    const normalizedTimestamp = resolveConversationTimestampMs(rawConversation);
    const normalizedRoute = resolveRouteSelectorFromConversation(rawConversation);
    const conversationId = String(rawConversation.id || normalized.id || '').trim();

    if (!current) {
      byPhone.set(phone, {
        ...normalized,
        id: `agg-${phone}`,
        aggregate_conversation_id: `agg-${phone}`,
        customer_phone_normalized: phone,
        source_conversation_ids: conversationId ? [conversationId] : [],
        source_accounts: [
          {
            conversationId,
            ...normalizedRoute,
          },
        ].filter((item) => item.conversationId || item.phoneNumberId || item.displayPhoneNumber || item.routeKey),
        active_route_selector: normalizedRoute,
        default_route_selector: null,
        _latestMs: normalizedTimestamp,
      });
      continue;
    }

    if (conversationId && !current.source_conversation_ids.includes(conversationId)) {
      current.source_conversation_ids.push(conversationId);
    }

    const routeFingerprint = [
      normalizedRoute.phoneNumberId || '',
      normalizedRoute.displayPhoneNumber || '',
      normalizedRoute.routeKey || '',
    ].join('|');
    const hasRoute = current.source_accounts.some((account) => [account.phoneNumberId || '', account.displayPhoneNumber || '', account.routeKey || ''].join('|') === routeFingerprint);
    if (!hasRoute && (normalizedRoute.phoneNumberId || normalizedRoute.displayPhoneNumber || normalizedRoute.routeKey)) {
      current.source_accounts.push({ conversationId, ...normalizedRoute });
    }

    current.unread_count = Number(current.unread_count || 0) + Number(normalized.unread_count || 0);
    current.unreadCount = Number(current.unread_count || 0);
    if (normalizedTimestamp >= current._latestMs) {
      Object.assign(current, {
        last_message: normalized.last_message,
        last_message_type: normalized.last_message_type,
        last_message_time: normalized.last_message_time,
        last_message_at: normalized.last_message_at,
        updated_date: normalized.updated_date,
        last_received_at: normalized.last_received_at || current.last_received_at,
        last_sent_at: normalized.last_sent_at || current.last_sent_at,
        last_client_message_time: normalized.last_client_message_time || current.last_client_message_time,
        active_route_selector: normalizedRoute,
        _latestMs: normalizedTimestamp,
      });
    }
  }

  for (const conversation of byPhone.values()) {
    const isSalesRoute = (routeKey) => ['vendas', 'vendas2'].includes(normalizeRouteKey(routeKey));
    const defaultAccount =
      conversation.source_accounts.find((account) => normalizeRouteKey(account.routeKey) === 'default') ||
      conversation.source_accounts.find((account) => !isSalesRoute(account.routeKey)) ||
      conversation.source_accounts[0] ||
      null;
    conversation.default_route_selector = defaultAccount
      ? {
          phoneNumberId: defaultAccount.phoneNumberId || null,
          displayPhoneNumber: defaultAccount.displayPhoneNumber || null,
          routeKey: defaultAccount.routeKey || null,
        }
      : null;
    delete conversation._latestMs;
  }

  return Array.from(byPhone.values());
};

export const fetchWhatsappConversations = async (options = {}) => {
  const headers = {};

  const params = new URLSearchParams();
  if (options.summary) params.set('summary', '1');
  if (options.page) params.set('page', String(options.page));
  if (options.limit) params.set('limit', String(options.limit));
  if (Array.isArray(options.labels) && options.labels.length > 0) {
    params.set('labels', options.labels.join(','));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const requestPath = `/api/whatsapp/conversations${suffix}`;
  const cachedResponse = conversationsResponseCache.get(requestPath) || null;
  if (cachedResponse?.etag) {
    headers['If-None-Match'] = cachedResponse.etag;
  }

  const response = await fetch(buildWhatsappApiUrl(requestPath), {
    method: 'GET',
    headers,
  });

  if (response.status === 304 && Array.isArray(cachedResponse?.items)) {
    return cachedResponse.items;
  }

  const data = await parseJsonResponse(response);
  if (!response.ok) {
    const error = new Error(data?.error || 'Falha na requisicao /api/whatsapp/conversations');
    error.status = response.status;
    error.payload = data;
    error.path = requestPath;
    throw error;
  }

  const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const items = aggregateConversationsByCustomerPhone(list);
  conversationsResponseCache.set(requestPath, {
    etag: response.headers.get('etag') || '',
    items,
  });
  while (conversationsResponseCache.size > 20) {
    const oldestKey = conversationsResponseCache.keys().next().value;
    conversationsResponseCache.delete(oldestKey);
  }
  return items;
};

const requestNewChatJson = async (path, fallback) => {
  try {
    return await requestChatJson(path, { method: 'GET' });
  } catch (error) {
    const status = Number(error?.status || 0);
    if (typeof fallback === 'function' && (!status || status >= 500 || [404, 405, 501].includes(status))) {
      return fallback();
    }
    throw error;
  }
};

export const fetchChatConversationsPage = async (options = {}) => {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit || 50));
  if (options.cursor) params.set('cursor', String(options.cursor));
  if (options.status) params.set('status', String(options.status));
  if (options.queueId) params.set('queueId', String(options.queueId));
  const path = `/api/conversations?${params.toString()}`;
  const data = await requestNewChatJson(path, async () => ({
    items: await fetchWhatsappConversations({ summary: true, limit: options.limit || 50 }),
    nextCursor: null,
    hasMore: false,
    source: 'legacy',
  }));
  const rawItems = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const isLegacySource = data?.source === 'legacy';
  return {
    items: isLegacySource ? aggregateConversationsByCustomerPhone(rawItems) : rawItems.map(normalizeWhatsappConversation),
    nextCursor: data?.nextCursor || data?.next_cursor || null,
    hasMore: Boolean(data?.hasMore ?? data?.has_more ?? data?.nextCursor ?? data?.next_cursor),
    source: data?.source || 'postgres',
  };
};

export const fetchChatMessagesPage = async (conversationId, options = {}) => {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) return { items: [], prevCursor: null, hasMore: false };
  const params = new URLSearchParams();
  params.set('limit', String(options.limit || 20));
  if (options.before) params.set('before', String(options.before));
  const path = `/api/conversations/${encodeURIComponent(safeConversationId)}/messages?${params.toString()}`;
  const data = await requestNewChatJson(path, async () => {
    const items = await fetchWhatsappMessages(safeConversationId, {
      tail: options.limit || 20,
      until: options.before || undefined,
      conversationIds: options.conversationIds,
      sourceAccounts: options.sourceAccounts,
    });
    return {
      items,
      prevCursor: items[0]?.created_date || items[0]?.timestamp || null,
      hasMore: items.length >= (options.limit || 20),
      source: 'legacy',
    };
  });
  const rawItems = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const items = rawItems.map((message, index) => normalizeWhatsappMessage({ ...message, __fetchIndex: index }));
  items.sort((left, right) => resolveMessageTimeMs(left) - resolveMessageTimeMs(right));
  return {
    items: attachStableMessageKeys(items),
    prevCursor: data?.prevCursor || data?.prev_cursor || null,
    hasMore: Boolean(data?.hasMore ?? data?.has_more),
    source: data?.source || 'postgres',
  };
};

export const markChatConversationRead = async (conversationId, options = {}) => {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) return null;
  return await requestChatJson(`/api/conversations/${encodeURIComponent(safeConversationId)}/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lastReadMessageId: options.lastReadMessageId || null,
    }),
  });
};

export const fetchChatMediaUrl = async (mediaId, variant = 'thumbnail') => {
  const safeMediaId = String(mediaId || '').trim();
  if (!safeMediaId) return null;
  const suffix = variant === 'original' ? 'signed-url' : 'thumbnail';
  const data = await requestChatJson(`/api/media/${encodeURIComponent(safeMediaId)}/${suffix}`, { method: 'GET' });
  return data?.url || data?.signedUrl || data?.signed_url || null;
};

export const fetchWhatsappConversationDetail = async (conversationOrId, options = {}) => {
  const sourceConversation =
    conversationOrId && typeof conversationOrId === 'object'
      ? conversationOrId
      : { id: String(conversationOrId || '') };
  const conversationId = String(sourceConversation?.id || '').trim();
  if (!conversationId) return null;

  const params = new URLSearchParams();
  const phone = normalizePhone(options.phone || resolveConversationPhone(sourceConversation));
  if (phone) params.set('phone', phone);
  if (Array.isArray(options.labels) && options.labels.length > 0) {
    params.set('labels', options.labels.join(','));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(
    buildWhatsappApiUrl(`/api/whatsapp/conversations/${encodeURIComponent(conversationId)}${suffix}`),
    { method: 'GET' },
  );
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    const error = new Error(data?.error || 'Falha na requisicao de detalhes da conversa');
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  const list = Array.isArray(data?.items)
    ? data.items
    : data?.conversation
      ? [data.conversation]
      : [];
  return aggregateConversationsByCustomerPhone(list)[0] || null;
};

export const fetchWhatsappMessages = async (conversationId, options = {}) => {
  if (!conversationId) return [];

  const requestedConversationIds = Array.isArray(options.conversationIds)
    ? options.conversationIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const targetConversationIds = requestedConversationIds.length > 0 ? requestedConversationIds : [String(conversationId)];
  const sourceAccountsByConversationId = new Map(
    (Array.isArray(options.sourceAccounts) ? options.sourceAccounts : [])
      .map((account) => [String(account?.conversationId || '').trim(), account])
      .filter(([id]) => id)
  );

  const params = new URLSearchParams();
  if (options.tail) {
    params.set('tail', String(options.tail));
  }

  if (options.markRead) {
    params.set('markRead', '1');
  }

  if (options.since) {
    params.set('since', String(options.since));
  }

  if (options.until) {
    params.set('until', String(options.until));
  }

  const batches = await Promise.all(
    targetConversationIds.map(async (currentConversationId) => {
      const scopedParams = new URLSearchParams(params);
      scopedParams.set('conversationId', currentConversationId);
      const data = await requestWhatsappJson(`/api/whatsapp/messages?${scopedParams.toString()}`, {
        method: 'GET',
      });
      const items = Array.isArray(data) ? data : [];
      const fallbackAccount = sourceAccountsByConversationId.get(String(currentConversationId || '').trim()) || null;
      return items.map((rawMessage, rawIndex) =>
        normalizeWhatsappMessage({
          ...rawMessage,
          __fetchIndex: rawIndex,
          conversationId: rawMessage?.conversationId || currentConversationId,
        }, {
          routeSelector: fallbackAccount,
          sourceConversationId: currentConversationId,
          sourceConversationLabel: buildFallbackSourceLabel(fallbackAccount || {}, currentConversationId),
        })
      );
    })
  );

  const deduped = new Map();
  for (const message of batches.flat()) {
    const key = buildMessageDedupKey(message);
    const current = deduped.get(key);
    if (!current || resolveMessageTimeMs(message) >= resolveMessageTimeMs(current)) {
      deduped.set(key, message);
    }
  }

  const sorted = Array.from(deduped.values()).sort((left, right) => resolveMessageTimeMs(left) - resolveMessageTimeMs(right));
  const withNotices = insertSourceSwitchNotices(sorted, { id: conversationId });
  return attachStableMessageKeys(withNotices);
};

export const fetchWhatsappHistoryMessages = async (conversation, options = {}) => {
  const conversationId = String(conversation?.id || conversation || '').trim();
  const phone = resolveConversationPhone(typeof conversation === 'object' ? conversation : {});
  if (!conversationId && !phone) return [];

  const params = new URLSearchParams();
  if (conversationId) params.set('conversationId', conversationId);
  if (phone) params.set('phone', phone);
  if (options.tail) params.set('tail', String(options.tail));
  if (options.until) params.set('until', String(options.until));
  if (options.windowDays) params.set('windowDays', String(options.windowDays));

  const data = await requestWhatsappJson(`/api/whatsapp/history/messages?${params.toString()}`, {
    method: 'GET',
  });

  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const normalized = items.map((rawMessage, rawIndex) =>
    normalizeWhatsappMessage({
      ...rawMessage,
      __fetchIndex: rawIndex,
      origin: rawMessage?.origin || 'legacy-history',
      conversationId: rawMessage?.conversationId || rawMessage?.conversation_id || conversationId,
    })
  );

  const deduped = new Map();
  for (const message of normalized) {
    const key = buildMessageDedupKey(message);
    const current = deduped.get(key);
    if (!current || resolveMessageTimeMs(message) >= resolveMessageTimeMs(current)) {
      deduped.set(key, message);
    }
  }

  const messages = attachStableMessageKeys(
    Array.from(deduped.values()).sort((left, right) => resolveMessageTimeMs(left) - resolveMessageTimeMs(right))
  );

  return {
    messages,
    hasMore: Boolean(data?.hasMore),
    windowStartMs: data?.windowStartMs || null,
    windowEndMs: data?.windowEndMs || null,
  };
};

export const markWhatsappConversationsRead = async (conversationIds) => {
  const safeIds = Array.isArray(conversationIds)
    ? conversationIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];

  if (safeIds.length === 0) {
    return { ok: true, count: 0 };
  }

  return await requestWhatsappJson('/api/whatsapp/conversations/mark-read', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ conversationIds: safeIds }),
  });
};

const withRouteSelectorPayload = (payload = {}, routeSelector = null) => {
  const selector = routeSelector && typeof routeSelector === 'object' ? routeSelector : {};
  return {
    ...payload,
    phoneNumberId: selector.phoneNumberId || null,
    displayPhoneNumber: selector.displayPhoneNumber || null,
    routeKey: selector.routeKey || null,
  };
};

export const sendWhatsappTextMessage = async ({ conversationId, to, text, contextMessageId, replyTo, agentName, origin, routeSelector, clientMessageId }) => {
  if (ENABLE_NEW_CHAT_DATA_LAYER && String(conversationId || '').trim()) {
    return await requestChatJson('/api/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        body: text,
        type: 'text',
        clientMessageId: clientMessageId || null,
        replyToMessageId: contextMessageId || null,
      }),
    });
  }
  return await requestWhatsappJson('/api/whatsapp/send-text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(withRouteSelectorPayload({
      to,
      text,
      contextMessageId: contextMessageId || null,
      replyTo: replyTo || null,
      agentName: agentName || null,
      origin: origin || 'panel',
      clientMessageId: clientMessageId || null,
    }, routeSelector)),
  });
};

export const sendWhatsappImageMessage = async ({
  conversationId,
  to,
  imageBase64,
  mimetype,
  caption,
  contextMessageId,
  replyTo,
  agentName,
  origin,
  routeSelector,
  clientMessageId,
}) => {
  if (ENABLE_NEW_CHAT_DATA_LAYER && String(conversationId || '').trim()) {
    return await requestChatJson('/api/media/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        type: 'image',
        dataBase64: imageBase64,
        mimeType: mimetype,
        caption: caption || '',
        replyToMessageId: contextMessageId || null,
        clientMessageId: clientMessageId || null,
      }),
    });
  }
  return await requestWhatsappJson('/api/whatsapp/send-image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(withRouteSelectorPayload({
      to,
      imageBase64,
      mimetype,
      caption: caption || '',
      contextMessageId: contextMessageId || null,
      replyTo: replyTo || null,
      agentName: agentName || null,
      origin: origin || 'panel',
      clientMessageId: clientMessageId || null,
    }, routeSelector)),
  });
};

export const sendWhatsappAudioMessage = async ({
  conversationId,
  to,
  audioBase64,
  mimetype,
  ptt = true,
  contextMessageId,
  replyTo,
  agentName,
  origin,
  routeSelector,
  clientMessageId,
}) => {
  if (ENABLE_NEW_CHAT_DATA_LAYER && String(conversationId || '').trim()) {
    return await requestChatJson('/api/media/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        type: 'audio',
        dataBase64: audioBase64,
        mimeType: mimetype,
        replyToMessageId: contextMessageId || null,
        clientMessageId: clientMessageId || null,
      }),
    });
  }
  return await requestWhatsappJson('/api/whatsapp/send-audio', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(withRouteSelectorPayload({
      to,
      audioBase64,
      mimetype,
      ptt,
      contextMessageId: contextMessageId || null,
      replyTo: replyTo || null,
      agentName: agentName || null,
      origin: origin || 'panel',
      clientMessageId: clientMessageId || null,
    }, routeSelector)),
  });
};

export const sendWhatsappDocumentMessage = async ({
  conversationId,
  to,
  documentBase64,
  mimetype,
  filename,
  caption,
  contextMessageId,
  replyTo,
  agentName,
  origin,
  routeSelector,
  clientMessageId,
}) => {
  if (ENABLE_NEW_CHAT_DATA_LAYER && String(conversationId || '').trim()) {
    return await requestChatJson('/api/media/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        type: 'document',
        dataBase64: documentBase64,
        mimeType: mimetype,
        filename: filename || '',
        caption: caption || '',
        replyToMessageId: contextMessageId || null,
        clientMessageId: clientMessageId || null,
      }),
    });
  }
  return await requestWhatsappJson('/api/whatsapp/send-document', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(withRouteSelectorPayload({
      to,
      documentBase64,
      mimetype,
      filename: filename || '',
      caption: caption || '',
      contextMessageId: contextMessageId || null,
      replyTo: replyTo || null,
      agentName: agentName || null,
      origin: origin || 'panel',
      clientMessageId: clientMessageId || null,
    }, routeSelector)),
  });
};

export const sendWhatsappVideoMessage = async ({
  conversationId,
  to,
  videoBase64,
  mimetype,
  filename,
  caption,
  contextMessageId,
  replyTo,
  agentName,
  origin,
  routeSelector,
  clientMessageId,
}) => {
  if (ENABLE_NEW_CHAT_DATA_LAYER && String(conversationId || '').trim()) {
    return await requestChatJson('/api/media/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        type: 'video',
        dataBase64: videoBase64,
        mimeType: mimetype,
        filename: filename || '',
        caption: caption || '',
        replyToMessageId: contextMessageId || null,
        clientMessageId: clientMessageId || null,
      }),
    });
  }
  return await requestWhatsappJson('/api/whatsapp/send-video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(withRouteSelectorPayload({
        to,
        videoBase64,
        mimetype,
        filename: filename || '',
        caption: caption || '',
        contextMessageId: contextMessageId || null,
        replyTo: replyTo || null,
        agentName: agentName || null,
        origin: origin || 'panel',
        clientMessageId: clientMessageId || null,
      }, routeSelector)),
  });
};

export const sendWhatsappInteractiveMessage = async ({
  to,
  text,
  buttonText = 'Selecionar',
  rows = [],
  buttons = [],
  footer = '',
  contextMessageId,
  replyTo,
  agentName,
  origin,
  routeSelector,
}) => {
  return await requestWhatsappJson('/api/whatsapp/send-interactive', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(withRouteSelectorPayload({
      to,
      text,
      buttonText,
      rows,
      buttons,
      footer,
      contextMessageId: contextMessageId || null,
      replyTo: replyTo || null,
      agentName: agentName || null,
      origin: origin || 'panel',
    }, routeSelector)),
  });
};

export const sendWhatsappTemplateMessage = async ({
  to,
  templateName,
  language = 'pt_BR',
  parameters = [],
  buttonParameters = [],
  headerParameters = [],
  headerFormat = '',
  headerType = '',
  headerMediaUrl = '',
  previewText = '',
  replyTo,
  agentName,
  origin,
  routeSelector,
}) => {
  return await requestWhatsappJson('/api/whatsapp/send-template', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(withRouteSelectorPayload({
      to,
      templateName,
      language,
      parameters,
      buttonParameters,
      headerParameters,
      headerFormat,
      headerType,
      headerMediaUrl,
      previewText,
      replyTo: replyTo || null,
      agentName: agentName || null,
      origin: origin || 'panel',
    }, routeSelector)),
  });
};

export const reactToWhatsappMessage = async ({ conversationId, messageId, emoji, from = 'agent' }) => {
  return await requestWhatsappJson('/api/whatsapp/messages/react', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      conversationId,
      messageId,
      emoji,
      from,
    }),
  });
};

export const fetchWhatsappAudioTranscription = async ({ messageId, conversationId, sourceConversationId, identifiers = [] }) => {
  const normalizedMessageId = encodeURIComponent(String(messageId || '').trim());
  if (ENABLE_NEW_CHAT_DATA_LAYER) {
    return await requestChatJson(`/api/messages/${normalizedMessageId}/transcription`, { method: 'GET' });
  }
  const params = new URLSearchParams();
  if (conversationId) params.set('conversationId', String(conversationId));
  if (sourceConversationId) params.set('sourceConversationId', String(sourceConversationId));
  const safeIdentifiers = (Array.isArray(identifiers) ? identifiers : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (safeIdentifiers.length > 0) params.set('identifiers', safeIdentifiers.join(','));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return await requestWhatsappJson(`/api/whatsapp/messages/${normalizedMessageId}/transcription${suffix}`, {
    method: 'GET',
  });
};

export const transcribeWhatsappAudioMessage = async ({
  messageId,
  force = true,
  conversationId,
  sourceConversationId,
  identifiers = [],
}) => {
  const normalizedMessageId = encodeURIComponent(String(messageId || '').trim());
  if (ENABLE_NEW_CHAT_DATA_LAYER) {
    return await requestChatJson(`/api/messages/${normalizedMessageId}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
  }
  return await requestWhatsappJson(`/api/whatsapp/messages/${normalizedMessageId}/transcribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      force,
      conversationId: conversationId || null,
      sourceConversationId: sourceConversationId || null,
      identifiers,
    }),
  });
};

export const fetchWhatsappSession = async (baseUrl = null) => {
  return await requestWhatsappJson('/api/whatsapp/session', {
    method: 'GET',
  }, baseUrl);
};

export const fetchWhatsappCoexistence = async (baseUrl = null) => {
  return await requestWhatsappJson('/api/whatsapp/coexistencia', {
    method: 'GET',
  }, baseUrl);
};

export const defaultQuickReplies = DEFAULT_QUICK_REPLIES;
