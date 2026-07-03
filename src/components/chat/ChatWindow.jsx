import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Clock,
  Info,
  Power,
  Search,
  TimerReset,
} from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { fetchChatbotEvents } from '@/lib/chatbot-flows-api';
import { buildConversationResolutionSystemMessage } from '@/lib/conversation-history';
import { subscribeLocalRealtimeEvent } from '@/lib/realtime-events';
import { assignConversationToUser, requeueConversationForService } from '@/lib/conversation-assignment-api';
import { resolveConversationAssignmentStatus } from '@/lib/conversation-assignment-status';
import {
  saveConversationPreference,
} from '@/lib/conversation-preferences';
import {
  fetchWhatsappHistoryMessages,
  fetchChatMessagesPage,
  fetchChatMediaUrl,
  fetchWhatsappAudioTranscription,
  fetchWhatsappMessages as fetchLegacyWhatsappMessages,
  markChatConversationRead,
  normalizeWhatsappMessage,
  markWhatsappConversationsRead,
  reactToWhatsappMessage,
  sendWhatsappAudioMessage,
  sendWhatsappDocumentMessage,
  sendWhatsappImageMessage,
  sendWhatsappInteractiveMessage,
  sendWhatsappTemplateMessage,
  sendWhatsappTextMessage,
  sendWhatsappVideoMessage,
  transcribeWhatsappAudioMessage,
} from '@/lib/whatsapp-api';
import { getQuickReplyActions, incrementQuickReplyUsage } from '@/lib/quick-replies';
import {
  deleteCachedDraft,
  promoteCachedDraft,
  readCachedDraft,
  readCachedMessages,
  writeCachedDraft,
  writeCachedMessages,
} from '@/lib/inbox-cache';
import { fetchLocalHsms } from '@/lib/hsm-api';
import { createNewbrTest, fetchActiveNewbrTest } from '@/lib/newbr-tests-api';
import { fetchCheckoutRenewalCustomerStatus } from '@/lib/checkout-renewals-api';
import { isLightboxAttachment, resolveAttachmentKind } from '@/lib/whatsapp-media';
import ChatMessage from './ChatMessage';
import ChatMediaLightbox from './ChatMediaLightbox';
import ContactAvatar from './ContactAvatar';
import ImagePreviewModal from './ImagePreviewModal';
import MessageInput from './MessageInput';
import QuickReplySidePanel from './QuickReplySidePanel';
import TavinhoSidePanel from './TavinhoSidePanel';
import TicketSidePanel from './TicketSidePanel';
import TicketStatusBadge from './TicketStatusBadge';
import LabelBadge from '@/components/labels/LabelBadge';
import { listConversationTickets } from '@/lib/tickets-api';
import VirtualizedMessageThread from '@/features/chat/components/VirtualizedMessageThread';
import { ENABLE_CHAT_VIRTUALIZATION, ENABLE_NEW_CHAT_DATA_LAYER, MESSAGE_PAGE_LIMIT } from '@/lib/performance-config';
import { useChatStore } from '@/features/chat/store/useChatStore';
import { flattenMessagePages, useMessages } from '@/features/chat/hooks/useMessages';
import { isAdminLikeUser } from '@/lib/navigation-permissions';
import { markConversationReadCaches, updateConversationCaches } from '@/features/chat/cache-updaters';
import { resolveConversationReplyRouteSelector } from '@/lib/conversation-channel';

const INITIAL_MESSAGE_PAGE_SIZE = MESSAGE_PAGE_LIMIT;
const OLDER_MESSAGE_PAGE_SIZE = MESSAGE_PAGE_LIMIT;
const RECENT_MESSAGE_POLL_TAIL_SIZE = MESSAGE_PAGE_LIMIT;
const NEWER_MESSAGES_POLL_INTERVAL_MS = 120000;
const HIDDEN_TAB_MESSAGES_POLL_INTERVAL_MS = 300000;
const OUTGOING_RECONCILE_WINDOW_MS = 2 * 60 * 1000;
const MESSAGE_CACHE_LIMIT = 160;
const VISIBLE_MESSAGE_DAY_LIMIT = 2;
const CHATBOT_EVENTS_IDLE_TTL_MS = 60_000;
const BACKGROUND_CHECKOUT_STATUS_DELAY_MS = 2_000;
const BACKGROUND_CHATBOT_EVENTS_DELAY_MS = 4_000;

const chatbotEventsPrefetchTimestamps = new Map();

function getMessageTimestamp(message) {
  return new Date(message?.created_date || message?.timestamp || 0).getTime();
}

function getMessageSortTimestamp(message) {
  return new Date(message?.client_sort_at || message?.created_date || message?.timestamp || 0).getTime();
}

function getMessageClientOrder(message) {
  const value = Number(message?.client_order);
  return Number.isFinite(value) ? value : null;
}

function normalizeComparableText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getFirstName(value, fallback = 'Mensagem') {
  const safeValue = String(value || '').trim();
  if (!safeValue) return fallback;
  return safeValue.split(/\s+/)[0] || fallback;
}

function buildReplyPreview(replyToMessage) {
  if (!replyToMessage) return null;

  const normalizedType = String(replyToMessage?.message_type || '').trim().toLowerCase();
  const normalizedContent = String(replyToMessage?.content || '').trim();

  let label = normalizedContent;
  let kind = normalizedType || 'text';

  if (!label) {
    if (normalizedType === 'audio') label = 'Audio';
    else if (normalizedType === 'image' || normalizedType === 'sticker') label = 'Imagem';
    else if (normalizedType === 'video') label = 'Video';
    else if (normalizedType === 'document') label = 'Documento';
  }

  const normalizedLabel = label.toLowerCase();
  if (normalizedLabel === '[audio]') {
    label = 'Audio';
    kind = 'audio';
  } else if (normalizedLabel === '[image]' || normalizedLabel === '[imagem]') {
    label = 'Imagem';
    kind = 'image';
  } else if (normalizedLabel === '[video]') {
    label = 'Video';
    kind = 'video';
  }

  return {
    senderName: getFirstName(replyToMessage?.sender_name, 'Mensagem'),
    text: label || 'Mensagem',
    kind,
  };
}

function hydrateReplyRelations(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const byId = new Map(
    safeMessages
      .map((message) => [String(message?.id || message?.temp_id || '').trim(), message])
      .filter(([id]) => id)
  );

  return safeMessages.map((message) => {
    if (message?.reply_preview) {
      return message;
    }

    const replyToId = String(message?.reply_to_id || '').trim();
    if (!replyToId) {
      return message;
    }

    const referencedMessage = byId.get(replyToId);
    if (!referencedMessage) {
      return message;
    }

    const replyPreview = buildReplyPreview(referencedMessage);
    if (!replyPreview) {
      return message;
    }

    return {
      ...message,
      reply_to: message.reply_to || referencedMessage.content || null,
      reply_preview: replyPreview,
    };
  });
}

function groupMessagesByDate(messages) {
  const groups = [];
  let currentDay = null;

  messages.forEach((msg) => {
    const date = msg.created_date ? new Date(msg.created_date) : new Date();
    let dayLabel;
    if (isToday(date)) dayLabel = 'Hoje';
    else if (isYesterday(date)) dayLabel = 'Ontem';
    else dayLabel = format(date, "dd 'de' MMMM", { locale: ptBR });

    if (dayLabel !== currentDay) {
      groups.push({ type: 'separator', label: dayLabel });
      currentDay = dayLabel;
    }

    groups.push({ type: 'message', data: msg });
  });

  return groups;
}

function sortMessagesChronologically(messages) {
  return [...messages].sort((left, right) => {
    const timestampDiff = getMessageSortTimestamp(left) - getMessageSortTimestamp(right);
    if (timestampDiff !== 0) return timestampDiff;

    const leftOrder = getMessageClientOrder(left);
    const rightOrder = getMessageClientOrder(right);
    if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return 0;
  });
}

function getReactionList(message) {
  return Array.isArray(message?.reactions) ? message.reactions : [];
}

function getAgentReactionEmoji(reactions) {
  return getReactionList({ reactions }).find((reaction) => reaction.from === 'agent')?.emoji || '';
}

function applyPendingAgentReaction(reactions, pendingEmoji) {
  if (typeof pendingEmoji !== 'string') return getReactionList({ reactions });
  return applyReactionChange(reactions, 'agent', pendingEmoji);
}

function resolveMergedReactions(currentMessage, incomingMessage) {
  const incomingReactions = getReactionList(incomingMessage);
  const pendingEmoji =
    typeof currentMessage?.pending_agent_reaction === 'string'
      ? currentMessage.pending_agent_reaction
      : null;

  if (pendingEmoji === null) {
    return {
      reactions: incomingReactions,
      pending_agent_reaction: null,
      pending_agent_reaction_at: null,
    };
  }

  const incomingAgentReaction = getAgentReactionEmoji(incomingReactions);
  if (incomingAgentReaction === pendingEmoji) {
    return {
      reactions: incomingReactions,
      pending_agent_reaction: null,
      pending_agent_reaction_at: null,
    };
  }

  return {
    reactions: applyPendingAgentReaction(incomingReactions, pendingEmoji),
    pending_agent_reaction: pendingEmoji,
    pending_agent_reaction_at: currentMessage.pending_agent_reaction_at,
  };
}

function applyReactionChange(reactions, from, emoji) {
  const normalizedEmoji = String(emoji || '').trim();
  const nextReactions = getReactionList({ reactions }).map((reaction) => ({ ...reaction }));
  const existingIndex = nextReactions.findIndex((reaction) => reaction.from === from);

  if (!normalizedEmoji) {
    if (existingIndex >= 0) {
      nextReactions.splice(existingIndex, 1);
    }
    return nextReactions;
  }

  if (existingIndex >= 0) {
    if (nextReactions[existingIndex].emoji === normalizedEmoji) {
      nextReactions.splice(existingIndex, 1);
    } else {
      nextReactions[existingIndex] = {
        ...nextReactions[existingIndex],
        emoji: normalizedEmoji,
        reacted_at: new Date().toISOString(),
      };
    }
    return nextReactions;
  }

  nextReactions.push({
    from,
    emoji: normalizedEmoji,
    reacted_at: new Date().toISOString(),
  });
  return nextReactions;
}

function buildTemplatePreview(template) {
  const content = String(template?.content || '').trim();
  const variables = Array.isArray(template?.bodyVariables) ? template.bodyVariables : [];

  return content.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, index) => {
    const value = variables[Number(index) - 1];
    return String(value || `var${index}`);
  });
}

function getTemplateButtons(template = {}) {
  if (Array.isArray(template.buttons) && template.buttons.length) return template.buttons;
  if (Array.isArray(template.buttonConfig) && template.buttonConfig.length) return template.buttonConfig;
  return [];
}

function normalizeTemplateItem(item) {
  return {
    ...item,
    name: String(item?.name || '').trim(),
    language: String(item?.language || 'pt_BR').trim(),
    content: String(item?.content || '').trim(),
    status: String(item?.status || '').trim().toLowerCase(),
    headerType: String(item?.headerType || 'none').trim().toLowerCase(),
    headerFormat: String(item?.headerFormat || '').trim().toUpperCase(),
    bodyVariables: Array.isArray(item?.bodyVariables) ? item.bodyVariables : [],
    buttonParameters: Array.isArray(item?.buttonVariables) ? item.buttonVariables : [],
    buttons: Array.isArray(item?.buttons) ? item.buttons : Array.isArray(item?.buttonConfig) ? item.buttonConfig : [],
    serviceId: String(item?.serviceId || item?.service_id || '').trim(),
    headerMediaUrl: String(item?.headerMediaUrl || item?.headerExample || '').trim(),
  };
}

function createOptimisticMessage({
  conversationId,
  clientMessageId,
  content,
  messageType = 'text',
  attachments = [],
  templateButtons = [],
  replyToMessage,
  replyPreview = null,
  senderName = 'Agente',
  status = 'pending',
  uploadProgress = 0,
  clientOrder = null,
}) {
  const resolvedClientMessageId =
    clientMessageId ||
    (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const tempId = `local-${resolvedClientMessageId}`;
  const createdAt = new Date().toISOString();
  return {
    id: tempId,
    temp_id: tempId,
    client_message_id: resolvedClientMessageId,
    conversation_id: conversationId,
    sender_type: 'agent',
    sender_name: senderName,
    message_type: messageType,
    status,
    content,
    reply_to: replyToMessage?.content || null,
    reply_preview: replyPreview,
    reactions: [],
    attachments,
    template_buttons: Array.isArray(templateButtons) ? templateButtons : [],
    upload_progress: uploadProgress,
    created_date: createdAt,
    client_sort_at: createdAt,
    client_order: clientOrder,
  };
}

function extractResponseMessageId(result) {
  return String(
    result?.messages?.[0]?.id ||
      result?.messages?.[0]?.wamid ||
      result?.messageId ||
      result?.message_id ||
      result?.item?.id ||
      result?.wamid ||
      ''
  ).trim() || null;
}

function fileToBase64Payload(file, errorMessage = 'Não foi possível ler o arquivo selecionado.') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(errorMessage));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl, fileName = 'arquivo', mimeType = 'application/octet-stream') {
  const raw = String(dataUrl || '');
  const commaIndex = raw.indexOf(',');
  const header = commaIndex >= 0 ? raw.slice(0, commaIndex) : '';
  const payload = commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw;
  const resolvedMimeType = mimeType || header.match(/^data:([^;]+)/)?.[1] || 'application/octet-stream';
  const binary = atob(payload || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName || 'arquivo', { type: resolvedMimeType });
}

const QUICK_REPLY_IMAGE_MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const QUICK_REPLY_VIDEO_MIME_BY_EXTENSION = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

const QUICK_REPLY_AUDIO_MIME_BY_EXTENSION = {
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  wav: 'audio/wav',
};

const QUICK_REPLY_DOCUMENT_MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function detectDataUrlMimeType(dataUrl) {
  return String(dataUrl || '').match(/^data:([^;]+);base64,/i)?.[1]?.toLowerCase() || '';
}

function detectFileExtension(fileName) {
  return String(fileName || '').split('.').pop()?.trim().toLowerCase() || '';
}

function fallbackQuickReplyMimeType(actionType, fileName) {
  const extension = detectFileExtension(fileName);
  if (actionType === 'image') return QUICK_REPLY_IMAGE_MIME_BY_EXTENSION[extension] || 'image/png';
  if (actionType === 'video') return QUICK_REPLY_VIDEO_MIME_BY_EXTENSION[extension] || 'video/mp4';
  if (actionType === 'audio') return QUICK_REPLY_AUDIO_MIME_BY_EXTENSION[extension] || 'audio/ogg';
  return QUICK_REPLY_DOCUMENT_MIME_BY_EXTENSION[extension] || 'application/octet-stream';
}

function defaultQuickReplyFileName(actionType, mimeType) {
  if (actionType === 'image') {
    const extension = mimeType === 'image/webp' ? 'webp' : mimeType === 'image/jpeg' ? 'jpg' : 'png';
    return `imagem.${extension}`;
  }
  if (actionType === 'video') {
    const extension = mimeType === 'video/webm' ? 'webm' : mimeType === 'video/quicktime' ? 'mov' : 'mp4';
    return `video.${extension}`;
  }
  if (actionType === 'audio') {
    const extension = mimeType === 'audio/mpeg' ? 'mp3' : mimeType === 'audio/wav' ? 'wav' : 'ogg';
    return `audio.${extension}`;
  }
  return 'documento';
}

function getQuickReplyBase64SizeKb(dataUrl) {
  const raw = String(dataUrl || '');
  const payload = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  return Math.max(0, Math.round((payload.length * 3) / 4 / 1024));
}

function resolveQuickReplyMediaPayload(action = {}) {
  const media = action.media || {};
  const dataUrl = String(media.dataUrl || media.base64 || '').trim();
  if (!dataUrl) return null;

  const actionType = String(action.type || '').trim().toLowerCase();
  const fileNameCandidate = String(media.fileName || media.filename || '').trim();
  const dataUrlMimeType = detectDataUrlMimeType(dataUrl);
  const explicitMimeType = String(media.mimeType || media.mimetype || '').trim().toLowerCase();
  const mimeType = explicitMimeType || dataUrlMimeType || fallbackQuickReplyMimeType(actionType, fileNameCandidate);
  const fileName = fileNameCandidate || defaultQuickReplyFileName(actionType, mimeType);
  const kind = ['image', 'video', 'audio', 'document'].includes(actionType) ? actionType : String(media.kind || '').trim().toLowerCase();
  const endpointByKind = {
    image: 'send-image',
    video: 'send-video',
    audio: 'send-audio',
    document: 'send-document',
  };

  return {
    dataUrl,
    mimeType,
    fileName,
    kind,
    caption: String(action.caption || media.caption || ''),
    endpoint: endpointByKind[kind] || 'send-document',
    approxSizeKb: getQuickReplyBase64SizeKb(dataUrl),
  };
}

function resolveQuickReplyUraPayload(action = {}, resolveText = (value) => value) {
  const ura = action.ura && typeof action.ura === 'object' ? action.ura : {};
  const metadata = action.metadata && typeof action.metadata === 'object' ? action.metadata : {};
  const rawOptions = Array.isArray(ura.options)
    ? ura.options
    : Array.isArray(metadata.uraOptions)
      ? metadata.uraOptions
      : [];
  const buttons = rawOptions
    .map((option, index) => {
      const label = String(option?.label || option?.title || option?.value || '').trim();
      if (!label) return null;
      return {
        id: String(option?.id || option?.value || `ura-option-${index + 1}`),
        title: resolveText(label).slice(0, 20),
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  return {
    text: resolveText(action.content || ura.description || metadata.description || 'Selecione uma opção:'),
    buttonText: resolveText(ura.buttonText || metadata.buttonText || 'Selecionar').slice(0, 20) || 'Selecionar',
    footer: resolveText(ura.footer || metadata.footer || ''),
    buttons,
  };
}

const delaySeconds = (seconds) =>
  new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Math.min(300, Number(seconds) || 0)) * 1000));

function findOptimisticMatch(messages, incomingMessage) {
  if (incomingMessage?.sender_type !== 'agent') return null;

  const incomingType = String(incomingMessage?.message_type || '').trim().toLowerCase();
  const incomingContent = normalizeComparableText(incomingMessage?.content);
  const incomingReply = normalizeComparableText(incomingMessage?.reply_to);
  const incomingTimestamp = getMessageTimestamp(incomingMessage);

  return (
    messages.find((message) => {
      if (!message?.temp_id) return false;
      if (message.sender_type !== 'agent') return false;
      if (String(message.message_type || '').trim().toLowerCase() !== incomingType) return false;
      if (normalizeComparableText(message.content) !== incomingContent) return false;
      if (normalizeComparableText(message.reply_to) !== incomingReply) return false;

      const currentTimestamp = getMessageTimestamp(message);
      return Math.abs(currentTimestamp - incomingTimestamp) <= OUTGOING_RECONCILE_WINDOW_MS;
    }) || null
  );
}

function isGenericAgentSenderName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['agente', 'agent'].includes(normalized);
}

function resolveAgentSenderName(message = {}) {
  const raw = message?.raw || {};
  const candidates = [
    message.sender_name,
    message.agentName,
    message.agent_name,
    message.senderName,
    message.operatorName,
    message.operator_name,
    message.attendantName,
    message.attendant_name,
    message.createdByName,
    message.created_by_name,
    message.userName,
    message.user_name,
    raw.sender_name,
    raw.agentName,
    raw.agent_name,
    raw.senderName,
    raw.operatorName,
    raw.operator_name,
    raw.attendantName,
    raw.attendant_name,
    raw.createdByName,
    raw.created_by_name,
    raw.userName,
    raw.user_name,
    raw.user?.full_name,
    raw.user?.name,
    raw.agent?.full_name,
    raw.agent?.name,
  ];

  return candidates
    .map((candidate) => String(candidate || '').trim())
    .find((candidate) => candidate && !isGenericAgentSenderName(candidate)) || '';
}

function resolveIncomingMessageIdentifier(message) {
  return String(
    message?.client_message_id ||
      message?.clientMessageId ||
      message?.provider_message_id ||
      message?.providerMessageId ||
      message?.server_message_id ||
      message?.id ||
      message?.message_key ||
      message?.temp_id ||
      ''
  ).trim();
}

function resolveMessageIdentifierCandidates(message = {}) {
  const attachmentIds = (Array.isArray(message.attachments) ? message.attachments : [])
    .flatMap((attachment) => {
      const values = [
        attachment?.id,
        attachment?.mediaId,
        attachment?.media_id,
        attachment?.providerMediaId,
        attachment?.provider_media_id,
      ];
      const rawUrl = String(attachment?.url || '').trim();
      if (rawUrl) {
        try {
          const parsed = new URL(rawUrl, window.location.origin);
          values.push(parsed.searchParams.get('id'));
        } catch {
          // ignore malformed attachment urls
        }
      }
      return values;
    });

  return [
    message.id,
    message.server_message_id,
    message.serverMessageId,
    message.provider_message_id,
    message.providerMessageId,
    message.client_message_id,
    message.clientMessageId,
    message.message_key,
    message.temp_id,
    message.wamid,
    message.raw?.id,
    ...attachmentIds,
  ]
    .map((value) => String(value || '').trim())
    .filter((value, index, list) => value && list.indexOf(value) === index);
}

function resolveServerMessageIdentifier(message) {
  return String(message?.server_message_id || '').trim();
}

function resolvePreferredSenderName(currentMessage, incomingMessage) {
  if (incomingMessage?.sender_type !== 'agent') {
    return incomingMessage?.sender_name || currentMessage?.sender_name || '';
  }

  const incomingSenderName = resolveAgentSenderName(incomingMessage);
  if (incomingSenderName) return incomingSenderName;

  const currentSenderName = resolveAgentSenderName(currentMessage);
  if (currentSenderName) return currentSenderName;

  return incomingMessage?.sender_name || currentMessage?.sender_name || 'Agente';
}

function buildServerMessageLookupKey(message) {
  const serverMessageId = resolveServerMessageIdentifier(message);
  if (!serverMessageId) {
    return '';
  }

  return serverMessageId;
}

function trimMessagesForCache(messages) {
  const safeMessages = (Array.isArray(messages) ? messages : []).filter((message) => !isLegacyHistoryMessage(message));
  if (safeMessages.length <= MESSAGE_CACHE_LIMIT) {
    return safeMessages;
  }

  return safeMessages.slice(-MESSAGE_CACHE_LIMIT);
}

function isLegacyHistoryMessage(message) {
  const origin = String(message?.origin || message?.raw?.origin || '').trim().toLowerCase();
  return origin === 'legacy-history' || Boolean(message?.legacy_history || message?.raw?.legacy_history);
}

function resolveMessageDateKey(message) {
  const timestamp = String(message?.created_date || message?.timestamp || '').trim();
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return format(date, 'yyyy-MM-dd');
}

function filterMostRecentMessageDays(messages, dayLimit = VISIBLE_MESSAGE_DAY_LIMIT) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const selectedDays = new Set();

  for (let index = safeMessages.length - 1; index >= 0; index -= 1) {
    const key = resolveMessageDateKey(safeMessages[index]);
    if (!key) continue;
    selectedDays.add(key);
    if (selectedDays.size >= dayLimit) break;
  }

  if (selectedDays.size === 0) return safeMessages;
  return safeMessages.filter((message) => {
    const key = resolveMessageDateKey(message);
    return !key || selectedDays.has(key);
  });
}

function resolveMessagePreviewContent(message) {
  const content = String(message?.content || '').trim();
  if (content) {
    return content;
  }

  const normalizedType = String(message?.message_type || '').trim().toLowerCase();
  if (normalizedType === 'audio') return '[Audio]';
  if (normalizedType === 'image') return '[Imagem]';
  if (normalizedType === 'video') return '[Video]';
  if (normalizedType === 'document') return '[Documento]';
  if (normalizedType === 'sticker') return '[Figurinha]';
  return '';
}

function buildConversationActivityPatch(currentConversation, message) {
  const activityCursor = String(message?.created_date || message?.timestamp || '').trim();
  if (!activityCursor) {
    return null;
  }

  const senderType = String(message?.sender_type || '').trim().toLowerCase();
  const messageType = String(message?.message_type || currentConversation?.last_message_type || 'text').trim().toLowerCase();

  return {
    last_message: resolveMessagePreviewContent(message),
    last_message_type: messageType,
    last_message_time: activityCursor,
    last_message_at: activityCursor,
    updated_date: activityCursor,
    last_sent_at: senderType === 'agent' ? activityCursor : currentConversation?.last_sent_at || '',
    last_received_at: senderType === 'client' ? activityCursor : currentConversation?.last_received_at || '',
    last_client_message_time:
      senderType === 'client' ? activityCursor : currentConversation?.last_client_message_time || '',
    unread_count: 0,
    unreadCount: 0,
    is_within_customer_window:
      senderType === 'client' ? true : Boolean(currentConversation?.is_within_customer_window),
  };
}

function updateConversationQueryCaches(queryClient, conversationId, updater) {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) {
    return;
  }

  queryClient.getQueriesData({ queryKey: ['conversations'] }).forEach(([queryKey, data]) => {
    if (!Array.isArray(data)) {
      return;
    }

    let hasChanges = false;
    const nextData = data.map((conversationItem) => {
      if (String(conversationItem?.id || '').trim() !== safeConversationId) {
        return conversationItem;
      }

      hasChanges = true;
      return updater(conversationItem);
    });

    if (hasChanges) {
      queryClient.setQueryData(queryKey, nextData);
    }
  });
}

function resolveRealtimeConversationId(payload = {}) {
  return String(
    payload.conversation_id ||
      payload.conversationId ||
      payload.message?.conversationId ||
      payload.message?.conversation_id ||
      payload.conversation?.id ||
      ''
  ).trim();
}

function resolveRealtimeMessageId(payload = {}) {
  return String(
    payload.message_id ||
      payload.messageId ||
      payload.message?.id ||
      payload.message?.serverMessageId ||
      payload.message?.server_message_id ||
      payload.message?.wamid ||
      ''
  ).trim();
}

function buildRealtimeConversationCandidates(conversation = {}) {
  const candidates = new Set();
  [conversation?.id, conversation?.conversation_id].forEach((value) => {
    const normalized = String(value || '').trim();
    if (normalized) candidates.add(normalized);
  });
  if (Array.isArray(conversation?.source_conversation_ids)) {
    conversation.source_conversation_ids.forEach((value) => {
      const normalized = String(value || '').trim();
      if (normalized) candidates.add(normalized);
    });
  }
  return candidates;
}

function isRealtimeEventForConversation(payload = {}, conversation = {}) {
  const eventConversationId = resolveRealtimeConversationId(payload);
  if (!eventConversationId) return false;
  return buildRealtimeConversationCandidates(conversation).has(eventConversationId);
}

function resolveRealtimeRouteSelector(payload = {}, conversation = {}) {
  const eventConversationId = resolveRealtimeConversationId(payload);
  const sourceAccount = Array.isArray(conversation?.source_accounts)
    ? conversation.source_accounts.find(
        (account) => String(account?.conversationId || '').trim() === eventConversationId,
      )
    : null;

  return payload.route_selector || payload.routeSelector || sourceAccount || null;
}

function normalizeRealtimeMessage(payload = {}, conversation = {}) {
  const rawMessage = payload.message && typeof payload.message === 'object' ? payload.message : null;
  if (!rawMessage) return null;

  const eventConversationId = resolveRealtimeConversationId(payload);
  return normalizeWhatsappMessage(
    {
      ...rawMessage,
      conversationId: rawMessage.conversationId || rawMessage.conversation_id || eventConversationId,
    },
    {
      routeSelector: resolveRealtimeRouteSelector(payload, conversation),
      sourceConversationId: eventConversationId,
    },
  );
}

function mergeMessages(currentMessages, incomingMessages) {
  const nextMessages = [...currentMessages];
  const messageIndexById = new Map();
  const messageIndexByServerKey = new Map();

  nextMessages.forEach((message, index) => {
    const messageId = resolveIncomingMessageIdentifier(message);
    if (messageId) {
      messageIndexById.set(messageId, index);
    }

    const serverKey = buildServerMessageLookupKey(message);
    if (serverKey) {
      messageIndexByServerKey.set(serverKey, index);
    }
  });

  incomingMessages.forEach((incomingMessage) => {
    const incomingMessageId = resolveIncomingMessageIdentifier(incomingMessage);
    if (!incomingMessageId) return;

    const byIdIndex = messageIndexById.get(incomingMessageId) ?? -1;
    if (byIdIndex >= 0) {
      const reactionState = resolveMergedReactions(nextMessages[byIdIndex], incomingMessage);
      nextMessages[byIdIndex] = {
        ...nextMessages[byIdIndex],
        ...incomingMessage,
        ...reactionState,
        sender_name: resolvePreferredSenderName(nextMessages[byIdIndex], incomingMessage),
        reply_to: incomingMessage.reply_to || nextMessages[byIdIndex].reply_to || null,
        reply_preview: incomingMessage.reply_preview || nextMessages[byIdIndex].reply_preview || null,
        client_sort_at: nextMessages[byIdIndex].client_sort_at || incomingMessage.client_sort_at || '',
        client_order: nextMessages[byIdIndex].client_order ?? incomingMessage.client_order ?? null,
        status: incomingMessage.status || nextMessages[byIdIndex].status,
        upload_progress: 100,
      };
      messageIndexById.set(incomingMessageId, byIdIndex);
      const updatedServerKey = buildServerMessageLookupKey(nextMessages[byIdIndex]);
      if (updatedServerKey) {
        messageIndexByServerKey.set(updatedServerKey, byIdIndex);
      }
      return;
    }

    const incomingServerKey = buildServerMessageLookupKey(incomingMessage);
    if (incomingServerKey) {
      const byServerIdIndex = messageIndexByServerKey.get(incomingServerKey) ?? -1;
      if (byServerIdIndex >= 0) {
        const reactionState = resolveMergedReactions(nextMessages[byServerIdIndex], incomingMessage);
        nextMessages[byServerIdIndex] = {
          ...nextMessages[byServerIdIndex],
          ...incomingMessage,
          ...reactionState,
          sender_name: resolvePreferredSenderName(nextMessages[byServerIdIndex], incomingMessage),
          reply_to: incomingMessage.reply_to || nextMessages[byServerIdIndex].reply_to || null,
          reply_preview: incomingMessage.reply_preview || nextMessages[byServerIdIndex].reply_preview || null,
          client_sort_at: nextMessages[byServerIdIndex].client_sort_at || incomingMessage.client_sort_at || '',
          client_order: nextMessages[byServerIdIndex].client_order ?? incomingMessage.client_order ?? null,
          status: incomingMessage.status || nextMessages[byServerIdIndex].status,
          upload_progress: 100,
        };
        messageIndexById.set(resolveIncomingMessageIdentifier(nextMessages[byServerIdIndex]), byServerIdIndex);
        messageIndexByServerKey.set(incomingServerKey, byServerIdIndex);
        return;
      }
    }

    nextMessages.push(incomingMessage);
    messageIndexById.set(incomingMessageId, nextMessages.length - 1);
    if (incomingServerKey) {
      messageIndexByServerKey.set(incomingServerKey, nextMessages.length - 1);
    }
  });

  return hydrateReplyRelations(sortMessagesChronologically(nextMessages));
}

export default function ChatWindow({
  conversation,
  onUpdateConversation,
  onToggleInfo,
  showInfo,
  onClearConversation,
  currentUser,
  onOpenStartConversation,
  activeUsers = [],
  teamUsers = [],
  allServices = [],
}) {
  const [replyTo, setReplyTo] = useState(null);
  const [searchMode, setSearchMode] = useState(false);
  const [msgSearch, setMsgSearch] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [messages, setMessages] = useState([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [messagesReadyConversationId, setMessagesReadyConversationId] = useState('');
  const [checkoutStatusConversationId, setCheckoutStatusConversationId] = useState('');
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(true);
  const [hasHistoryMessages, setHasHistoryMessages] = useState(true);
  const [imageFiles, setImageFiles] = useState(null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxActiveId, setLightboxActiveId] = useState('');
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false);
  const [resolveType, setResolveType] = useState('resolved');
  const [isResolvingConversation, setIsResolvingConversation] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transferUserId, setTransferUserId] = useState('');
  const [transferServiceId, setTransferServiceId] = useState('');
  const [isTransferringConversation, setIsTransferringConversation] = useState(false);
  const chatSidePanel = useChatStore((state) => state.sidePanel);
  const sseStatus = useChatStore((state) => state.sseStatus);
  const setChatSidePanel = useChatStore((state) => state.setSidePanel);
  const quickReplyPanelOpen = chatSidePanel === 'quick-replies';
  const tavinhoPanelOpen = chatSidePanel === 'tavinho';
  const ticketPanelOpen = chatSidePanel === 'ticket';
  const buildPanelSetter = (panelName) => (update) => setChatSidePanel((currentPanel) => {
    const currentValue = currentPanel === panelName;
    const nextValue = typeof update === 'function' ? update(currentValue) : update;
    return nextValue ? panelName : (currentValue ? null : currentPanel);
  });
  const setQuickReplyPanelOpen = buildPanelSetter('quick-replies');
  const setTavinhoPanelOpen = buildPanelSetter('tavinho');
  const setTicketPanelOpen = buildPanelSetter('ticket');
  const [transcribingMessageIds, setTranscribingMessageIds] = useState(() => new Set());
  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const setScrollContainerElement = useCallback((element) => {
    scrollContainerRef.current = element;
  }, []);
  const activeConversationIdRef = useRef('');
  const latestDraftValueRef = useRef('');
  const shouldPromoteDraftOnExitRef = useRef(false);
  const shouldDeleteDraftOnExitRef = useRef(false);
  const markReadTimeoutRef = useRef(null);
  const lastMarkedReadKeyRef = useRef('');
  const outgoingQueueRef = useRef(Promise.resolve());
  const retryPayloadsRef = useRef(new Map());
  const nextOutgoingOrderRef = useRef(1);
  const queryClient = useQueryClient();
  const paginatedMessagesQuery = useMessages(conversation, {
    enabled: ENABLE_NEW_CHAT_DATA_LAYER && Boolean(conversation?.id),
    limit: INITIAL_MESSAGE_PAGE_SIZE,
  });
  const paginatedHasMoreRef = useRef(true);
  const currentUserId = String(currentUser?.id || currentUser?.email || '').trim();
  const currentUserName = String(currentUser?.full_name || currentUser?.name || currentUser?.username || 'Agente').trim();
  const messagesReady = messagesReadyConversationId === String(conversation?.id || '');
  const isCurrentUserAdmin = isAdminLikeUser(currentUser);
  const [testClock, setTestClock] = useState(() => Date.now());
  const assignmentStatus = useMemo(
    () =>
      resolveConversationAssignmentStatus({
        conversation,
        currentUser,
        users: [...(Array.isArray(activeUsers) ? activeUsers : []), ...(Array.isArray(teamUsers) ? teamUsers : [])],
        services: allServices,
      }),
    [activeUsers, allServices, conversation, currentUser, teamUsers],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setTestClock(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeNewbrTestQuery = useQuery({
    queryKey: ['newbr-test-active', conversation?.id, conversation?.contact_phone],
    queryFn: () => fetchActiveNewbrTest({ conversationId: conversation?.id, phone: conversation?.contact_phone }),
    enabled: quickReplyPanelOpen && Boolean(conversation?.id || conversation?.contact_phone),
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const conversationTicketsQuery = useQuery({
    queryKey: ['conversation-tickets', conversation?.id],
    queryFn: () => listConversationTickets(conversation.id),
    enabled: ticketPanelOpen && Boolean(conversation?.id),
    staleTime: 30000,
  });

  const renewalCustomerPhone = conversation?.contact_phone || conversation?.phone || conversation?.customer?.phone || '';
  const checkoutRenewalStatusQuery = useQuery({
    queryKey: ['checkout-renewal-customer-status', renewalCustomerPhone],
    queryFn: () => fetchCheckoutRenewalCustomerStatus(renewalCustomerPhone),
    enabled: checkoutStatusConversationId === String(conversation?.id || '') && Boolean(renewalCustomerPhone),
    staleTime: 30000,
    refetchInterval: 60000,
  });
  const checkoutRenewalAlert = checkoutRenewalStatusQuery.data?.hasAlert
    ? checkoutRenewalStatusQuery.data
    : null;

  const activeNewbrTest = activeNewbrTestQuery.data?.active ? activeNewbrTestQuery.data : null;
  const activeNewbrRemainingSeconds = activeNewbrTest?.expiresAt
    ? Math.max(0, Math.ceil((Date.parse(activeNewbrTest.expiresAt) - testClock) / 1000))
    : Number(activeNewbrTest?.remainingSeconds || 0);
  const activeNewbrRemainingLabel = activeNewbrTest
    ? activeNewbrRemainingSeconds > 0
      ? `${String(Math.floor(activeNewbrRemainingSeconds / 3600)).padStart(2, '0')}:${String(
          Math.floor((activeNewbrRemainingSeconds % 3600) / 60),
        ).padStart(2, '0')}`
      : 'expirado'
    : '';

  const { data: templates = [] } = useQuery({
    queryKey: ['chat-templates'],
    queryFn: async () => {
      const payload = await fetchLocalHsms();
      const items = Array.isArray(payload?.items) ? payload.items : [];
      return items
        .map(normalizeTemplateItem)
        .filter((item) => item.active && item.status === 'approved');
    },
    staleTime: 60000,
    enabled: !Boolean(conversation?.is_within_customer_window) || quickReplyPanelOpen,
  });

  const conversationTemplateServiceIds = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...(Array.isArray(conversation?.accessible_service_ids) ? conversation.accessible_service_ids : []),
            ...(Array.isArray(conversation?.matching_service_ids) ? conversation.matching_service_ids : []),
          ]
            .map((item) => String(item || '').trim())
            .filter(Boolean),
        ),
      ),
    [conversation?.accessible_service_ids, conversation?.matching_service_ids],
  );

  const visibleTemplates = useMemo(() => {
    if (!conversationTemplateServiceIds.length) return [];
    return templates.filter((template) => conversationTemplateServiceIds.includes(String(template.serviceId || '').trim()));
  }, [conversationTemplateServiceIds, templates]);

  const transferUsers = useMemo(() => {
    const currentAssignedId = String(conversation?.assigned_agent_id || '').trim();
    const currentAssignedEmail = String(conversation?.assigned_agent_email || '').trim().toLowerCase();
    const matchingServiceIds = Array.isArray(conversation?.matching_service_ids) ? conversation.matching_service_ids : [];
    const serviceMatches = (Array.isArray(allServices) ? allServices : []).filter((service) =>
      matchingServiceIds.includes(String(service?.id || ''))
    );
    const activeNonAdminUsers = (Array.isArray(activeUsers) ? activeUsers : []).filter((user) => {
      const userId = String(user?.id || '').trim();
      const userEmail = String(user?.email || '').trim().toLowerCase();
      return (
        !isAdminLikeUser(user) &&
        (!currentAssignedId || userId !== currentAssignedId) &&
        (!currentAssignedEmail || userEmail !== currentAssignedEmail)
      );
    });

    if (serviceMatches.length === 0) return activeNonAdminUsers;

    return activeNonAdminUsers.filter((user) => {
      const userId = String(user?.id || '').trim();
      const userEmail = String(user?.email || '').trim().toLowerCase();
      return serviceMatches.some((service) => {
        const serviceUserIds = Array.isArray(service?.user_ids) ? service.user_ids.map(String) : [];
        const serviceUserEmails = Array.isArray(service?.user_emails)
          ? service.user_emails.map((email) => String(email || '').trim().toLowerCase())
          : [];
        return (userId && serviceUserIds.includes(userId)) || (userEmail && serviceUserEmails.includes(userEmail));
      });
    });
  }, [
    activeUsers,
    allServices,
    conversation?.assigned_agent_email,
    conversation?.assigned_agent_id,
    conversation?.matching_service_ids,
  ]);

  const transferServices = useMemo(() => {
    const currentServiceIds = new Set(
      [
        ...(Array.isArray(conversation?.matching_service_ids) ? conversation.matching_service_ids : []),
        ...(Array.isArray(conversation?.queued_service_ids) ? conversation.queued_service_ids : []),
      ]
        .map((serviceId) => String(serviceId || '').trim())
        .filter(Boolean),
    );

    return (Array.isArray(allServices) ? allServices : [])
      .filter((service) => {
        const serviceId = String(service?.id || '').trim();
        if (!serviceId || currentServiceIds.has(serviceId)) return false;
        const labelIds = Array.isArray(service?.label_ids) ? service.label_ids : service?.labelIds;
        return Array.isArray(labelIds) && labelIds.length > 0;
      })
      .sort((left, right) =>
        String(left?.name || '').localeCompare(String(right?.name || ''), 'pt-BR', { sensitivity: 'base' })
      );
  }, [allServices, conversation?.matching_service_ids, conversation?.queued_service_ids]);

  const activeManualRouteSelector = useMemo(() => {
    return resolveConversationReplyRouteSelector({ conversation, messages });
  }, [conversation, messages]);

  const sourceConversationIdsKey = useMemo(
    () => (Array.isArray(conversation?.source_conversation_ids) ? conversation.source_conversation_ids.join('|') : ''),
    [conversation?.source_conversation_ids]
  );
  const sourceAccountsKey = useMemo(
    () =>
      (Array.isArray(conversation?.source_accounts) ? conversation.source_accounts : [])
        .map((account) =>
          [
            String(account?.conversationId || '').trim(),
            String(account?.phoneNumberId || '').trim(),
            String(account?.displayPhoneNumber || '').trim(),
            String(account?.routeKey || '').trim(),
          ].join('|')
        )
        .join('||'),
    [conversation?.source_accounts]
  );

  const fetchRecentMessagePage = useCallback(async (limit = INITIAL_MESSAGE_PAGE_SIZE) => {
    if (ENABLE_NEW_CHAT_DATA_LAYER) {
      const page = await fetchChatMessagesPage(conversation.id, {
        limit,
        conversationIds: conversation.source_conversation_ids,
        sourceAccounts: conversation.source_accounts,
      });
      return Array.isArray(page?.items) ? page.items : [];
    }
    return fetchLegacyWhatsappMessages(conversation.id, {
      tail: limit,
      markRead: true,
      conversationIds: conversation.source_conversation_ids,
      sourceAccounts: conversation.source_accounts,
    });
  }, [conversation?.id, sourceAccountsKey, sourceConversationIdsKey]);

  const isWithin24hWindow = Boolean(conversation?.is_within_customer_window);
  const windowStatusLabel = isWithin24hWindow
    ? 'Janela de 24h ativa. Texto livre liberado.'
    : 'Fora da janela de 24h. Envie um template HSM.';

  const lightboxItems = useMemo(
    () =>
      messages.flatMap((message) =>
        (Array.isArray(message?.attachments) ? message.attachments : [])
          .filter((attachment) => isLightboxAttachment(attachment))
          .map((attachment, index) => ({
            id: `${message.id}-attachment-${index}`,
            url: String(attachment?.url || '').trim(),
            mediaId: String(attachment?.mediaId || attachment?.media_id || attachment?.id || '').trim(),
            resolveUrl: attachment?.mediaId || attachment?.media_id || attachment?.id
              ? () => fetchChatMediaUrl(attachment.mediaId || attachment.media_id || attachment.id, 'original')
              : null,
            name: attachment?.name || message.content || 'Midia',
            mimeType: attachment?.mimeType || '',
            kind: resolveAttachmentKind(attachment) || 'image',
            caption: message.content || '',
            createdDate: message.created_date || message.timestamp || '',
            senderName: message.sender_name || '',
          }))
          .filter((item) => item.url || item.mediaId)
      ),
    [messages]
  );

  useEffect(() => {
    activeConversationIdRef.current = String(conversation?.id || '');
    latestDraftValueRef.current = draftValue;
  }, [conversation?.id, draftValue]);

  useEffect(() => {
    return () => {
      const conversationId = String(activeConversationIdRef.current || '');
      const currentDraftValue = String(latestDraftValueRef.current || '');

      if (
        shouldDeleteDraftOnExitRef.current &&
        conversationId &&
        currentDraftValue.trim().length === 0
      ) {
        void deleteCachedDraft(conversationId);
        return;
      }

      if (
        !shouldPromoteDraftOnExitRef.current ||
        !conversationId ||
        currentDraftValue.trim().length === 0
      ) {
        return;
      }

      void promoteCachedDraft(conversationId);
    };
  }, []);

  const handleDraftValueChange = (nextValue) => {
    const safeValue = String(nextValue || '');
    shouldPromoteDraftOnExitRef.current = safeValue.trim().length > 0;
    shouldDeleteDraftOnExitRef.current = safeValue.trim().length === 0;
    setDraftValue(nextValue);
  };

  const scheduleMarkConversationRead = useCallback((reason = 'visible', explicitMessageId = '') => {
    if (!conversation?.id || (messages.length === 0 && !explicitMessageId)) return;
    const latestVisibleMessage = [...messages]
      .reverse()
      .find((message) => String(message?.id || message?.server_message_id || '').trim());
    const latestVisibleMessageId = String(
      explicitMessageId || latestVisibleMessage?.server_message_id || latestVisibleMessage?.id || ''
    ).trim();
    const readKey = `${conversation.id}:${latestVisibleMessageId || 'latest'}:${reason}`;
    if (lastMarkedReadKeyRef.current === readKey) return;

    if (markReadTimeoutRef.current) {
      window.clearTimeout(markReadTimeoutRef.current);
    }

    markReadTimeoutRef.current = window.setTimeout(() => {
      lastMarkedReadKeyRef.current = readKey;
      const applyLocalRead = (unreadCount = 0) => {
        markConversationReadCaches(queryClient, conversation.id, unreadCount);
        onUpdateConversation?.({
          ...conversation,
          unread_count: unreadCount,
          unreadCount,
          isUnread: unreadCount > 0,
        });
      };

      if (ENABLE_NEW_CHAT_DATA_LAYER) {
        void markChatConversationRead(conversation.id, { lastReadMessageId: latestVisibleMessageId || null })
          .then((result) => applyLocalRead(result?.unreadCount ?? result?.unread_count ?? 0))
          .catch(() => {
            lastMarkedReadKeyRef.current = '';
          });
        return;
      }

      const targetIds = Array.isArray(conversation.source_conversation_ids) && conversation.source_conversation_ids.length > 0
        ? conversation.source_conversation_ids
        : [conversation.id];
      void markWhatsappConversationsRead(targetIds)
        .then(() => applyLocalRead(0))
        .catch(() => {
          lastMarkedReadKeyRef.current = '';
        });
    }, 700);
  }, [conversation, messages, onUpdateConversation, queryClient]);

  useEffect(() => {
    if (!conversation?.id || !conversation.unread_count || messages.length === 0) return undefined;
    scheduleMarkConversationRead('open');
    return undefined;
  }, [conversation?.id, conversation?.unread_count, messages.length, scheduleMarkConversationRead]);

  useEffect(() => () => {
    if (markReadTimeoutRef.current) {
      window.clearTimeout(markReadTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    if (!conversation?.id || !onClearConversation) {
      return undefined;
    }

    const handleConversationEscape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }

      if (resolveDialogOpen) {
        return;
      }

      onClearConversation();
    };

    window.addEventListener('keydown', handleConversationEscape);
    return () => window.removeEventListener('keydown', handleConversationEscape);
  }, [conversation?.id, onClearConversation, resolveDialogOpen]);

  useEffect(() => {
    if (!conversation?.id) {
      setMessages([]);
      setHasOlderMessages(true);
      setHasHistoryMessages(true);
      setIsLoadingMessages(false);
      setMessagesReadyConversationId('');
      setCheckoutStatusConversationId('');
      setIsLoadingOlder(false);
      setIsLoadingHistory(false);
      setDraftValue('');
      shouldPromoteDraftOnExitRef.current = false;
      shouldDeleteDraftOnExitRef.current = false;
      setImageFiles(null);
      setIsLightboxOpen(false);
      setLightboxActiveId('');
      setReplyTo(null);
      setSearchMode(false);
      setMsgSearch('');
      setResolveDialogOpen(false);
      setTransferDialogOpen(false);
      setTransferUserId('');
      setIsTransferringConversation(false);
      setQuickReplyPanelOpen(false);
      setTavinhoPanelOpen(false);
      return;
    }

    const conversationId = conversation.id;
    let active = true;

    const hydrateConversationState = async () => {
      shouldPromoteDraftOnExitRef.current = false;
      shouldDeleteDraftOnExitRef.current = false;
      setIsLightboxOpen(false);
      setLightboxActiveId('');
      setImageFiles(null);
      setReplyTo(null);
      setSearchMode(false);
      setMsgSearch('');
      setTransferDialogOpen(false);
      setTransferUserId('');
      setIsTransferringConversation(false);
      setQuickReplyPanelOpen(false);
      setTavinhoPanelOpen(false);
      setIsLoadingMessages(true);
      setMessagesReadyConversationId('');
      setCheckoutStatusConversationId('');
      setIsLoadingOlder(false);
      setIsLoadingHistory(false);
      setDraftValue('');
      setMessages([]);
      setHasOlderMessages(true);
      setHasHistoryMessages(true);
      stickToBottomRef.current = true;

      const [cachedMessages, cachedDraft] = await Promise.all([
        readCachedMessages(conversationId),
        readCachedDraft(conversationId),
      ]);

      if (active && cachedMessages.length > 0) {
        setMessages((currentMessages) => mergeMessages(currentMessages, filterMostRecentMessageDays(cachedMessages)));
      }

      if (active) {
        setDraftValue(cachedDraft);
      }

      if (ENABLE_NEW_CHAT_DATA_LAYER) return;

      try {
        const recentMessages = await fetchRecentMessagePage(INITIAL_MESSAGE_PAGE_SIZE);

        if (!active) return;

        const visibleRecentMessages = filterMostRecentMessageDays(recentMessages);
        setMessages((currentMessages) => {
          const mergedMessages = mergeMessages(currentMessages, visibleRecentMessages);
          void writeCachedMessages(conversationId, trimMessagesForCache(mergedMessages));
          return mergedMessages;
        });
        setHasOlderMessages(
          (ENABLE_NEW_CHAT_DATA_LAYER ? paginatedHasMoreRef.current : recentMessages.length >= INITIAL_MESSAGE_PAGE_SIZE) ||
            visibleRecentMessages.length < recentMessages.length,
        );
      } catch (error) {
        if (active && cachedMessages.length === 0) {
          toast.error(error?.message || 'Não foi possível carregar as mensagens.');
        }
      } finally {
        if (active) {
          setIsLoadingMessages(false);
          setMessagesReadyConversationId(String(conversationId));
          requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
          });
        }
      }
    };

    void hydrateConversationState();

    return () => {
      active = false;
    };
  }, [conversation?.id, sourceConversationIdsKey, sourceAccountsKey, fetchRecentMessagePage]);

  useEffect(() => {
    if (!ENABLE_NEW_CHAT_DATA_LAYER || !conversation?.id) return;
    if (!paginatedMessagesQuery.isSuccess) return;

    const conversationId = String(conversation.id);
    const recentMessages = flattenMessagePages(paginatedMessagesQuery.data);
    const visibleRecentMessages = filterMostRecentMessageDays(recentMessages);
    paginatedHasMoreRef.current = Boolean(paginatedMessagesQuery.hasNextPage);
    setMessages((currentMessages) => {
      const mergedMessages = mergeMessages(currentMessages, visibleRecentMessages);
      void writeCachedMessages(conversationId, trimMessagesForCache(mergedMessages));
      return mergedMessages;
    });
    setHasOlderMessages(
      Boolean(paginatedMessagesQuery.hasNextPage) || visibleRecentMessages.length < recentMessages.length,
    );
    setIsLoadingMessages(false);
    setMessagesReadyConversationId(conversationId);
    requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ behavior: 'auto' }));
  }, [
    conversation?.id,
    paginatedMessagesQuery.data,
    paginatedMessagesQuery.hasNextPage,
    paginatedMessagesQuery.isSuccess,
  ]);

  useEffect(() => {
    if (!ENABLE_NEW_CHAT_DATA_LAYER || !conversation?.id || !paginatedMessagesQuery.isError) return;
    setIsLoadingMessages(false);
    if (messages.length === 0) {
      toast.error(paginatedMessagesQuery.error?.message || 'Nao foi possivel carregar as mensagens.');
    }
  }, [conversation?.id, messages.length, paginatedMessagesQuery.error, paginatedMessagesQuery.isError]);

  useEffect(() => {
    if (!messagesReady || !conversation?.id) return undefined;
    let active = true;
    const conversationId = String(conversation.id);
    const checkoutDelayId = window.setTimeout(() => {
      if (!active || activeConversationIdRef.current !== conversationId) return;
      setCheckoutStatusConversationId(conversationId);
    }, BACKGROUND_CHECKOUT_STATUS_DELAY_MS);
    const chatbotDelayId = window.setTimeout(() => {
      if (!active || activeConversationIdRef.current !== conversationId) return;
      const lastChatbotFetchAt = Number(chatbotEventsPrefetchTimestamps.get(conversationId) || 0);
      if (Date.now() - lastChatbotFetchAt < CHATBOT_EVENTS_IDLE_TTL_MS) {
        return;
      }
      chatbotEventsPrefetchTimestamps.set(conversationId, Date.now());
      void fetchChatbotEvents(conversationId).then((chatbotEvents) => {
        if (!active || activeConversationIdRef.current !== conversationId || !Array.isArray(chatbotEvents)) return;
        setMessages((currentMessages) => mergeMessages(currentMessages, chatbotEvents));
      }).catch(() => {
        chatbotEventsPrefetchTimestamps.delete(conversationId);
      });
    }, BACKGROUND_CHATBOT_EVENTS_DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(checkoutDelayId);
      window.clearTimeout(chatbotDelayId);
    };
  }, [conversation?.id, messagesReady]);

  useEffect(() => {
    if (!conversation?.id) return;
    if (draftValue.trim().length === 0) {
      return;
    }
    void writeCachedDraft(conversation.id, draftValue);
  }, [conversation?.id, draftValue]);

  useEffect(() => {
    if (!conversation?.id || !messagesReady || sseStatus === 'connected') return undefined;

    let active = true;
    let timeoutId = null;
    let isPolling = false;

    const scheduleNextPoll = () => {
      if (!active) return;
      const nextDelay = document.visibilityState === 'hidden'
        ? HIDDEN_TAB_MESSAGES_POLL_INTERVAL_MS
        : NEWER_MESSAGES_POLL_INTERVAL_MS;
      timeoutId = window.setTimeout(() => {
        void pollRecentMessages();
      }, nextDelay);
    };

    const pollRecentMessages = async () => {
      if (!active || isPolling) return;
      isPolling = true;

      try {
        const recentMessages = await fetchRecentMessagePage(RECENT_MESSAGE_POLL_TAIL_SIZE);

        if (recentMessages.length > 0) {
          const latestIncomingMessage = recentMessages[recentMessages.length - 1];
          setMessages((currentMessages) => {
            const mergedMessages = mergeMessages(currentMessages, recentMessages);
            void writeCachedMessages(conversation.id, trimMessagesForCache(mergedMessages));
            return mergedMessages;
          });
          if (latestIncomingMessage) {
            updateConversationQueryCaches(queryClient, conversation.id, (currentConversation) => {
              const patch = buildConversationActivityPatch(currentConversation, latestIncomingMessage);
              return patch ? { ...currentConversation, ...patch } : currentConversation;
            });
          }
        }
      } catch {
        // Ignore background polling failures and keep UI stable.
      } finally {
        isPolling = false;
        scheduleNextPoll();
      }
    };

    const pollImmediately = () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      void pollRecentMessages();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        pollImmediately();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', pollImmediately);
    scheduleNextPoll();

    return () => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', pollImmediately);
    };
  }, [conversation?.id, messagesReady, queryClient, sourceConversationIdsKey, sourceAccountsKey, fetchRecentMessagePage, sseStatus]);

  useEffect(() => {
    if (!conversation?.id || messages.length === 0) return;
    void writeCachedMessages(conversation.id, trimMessagesForCache(messages));
  }, [conversation?.id, messages]);

  const updateMessage = (messageId, updater) => {
    setMessages((currentMessages) =>
      currentMessages.map((message) => {
        if (message.id !== messageId && message.temp_id !== messageId) return message;
        return typeof updater === 'function' ? updater(message) : { ...message, ...updater };
      })
    );
  };

  const updateMessageByIdentifiers = (identifiers, updater) => {
    const normalizedIdentifiers = new Set(
      (Array.isArray(identifiers) ? identifiers : [identifiers])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    );
    if (normalizedIdentifiers.size === 0) return;

    setMessages((currentMessages) =>
      currentMessages.map((message) => {
        const candidates = [
          message.id,
          message.server_message_id,
          message.provider_message_id,
          message.client_message_id,
          message.message_key,
          message.temp_id,
        ].map((value) => String(value || '').trim());
        if (!candidates.some((candidate) => normalizedIdentifiers.has(candidate))) return message;
        return typeof updater === 'function' ? updater(message) : { ...message, ...updater };
      })
    );
  };

  const refreshRecentMessages = async () => {
    if (!conversation?.id) return;

    const recentMessages = await fetchRecentMessagePage(INITIAL_MESSAGE_PAGE_SIZE).catch(() => []);

    if (recentMessages.length > 0) {
      const latestRecentMessage = recentMessages[recentMessages.length - 1];
      setMessages((currentMessages) => {
        const mergedMessages = mergeMessages(currentMessages, recentMessages);
        void writeCachedMessages(conversation.id, trimMessagesForCache(mergedMessages));
        return mergedMessages;
      });
      if (latestRecentMessage) {
        updateConversationQueryCaches(queryClient, conversation.id, (currentConversation) => {
          const patch = buildConversationActivityPatch(currentConversation, latestRecentMessage);
          return patch ? { ...currentConversation, ...patch } : currentConversation;
        });
      }
    }
  };

  useEffect(() => {
    if (!conversation?.id) return undefined;

    const handleMessageUpserted = (payload = {}) => {
      if (!isRealtimeEventForConversation(payload, conversation)) return;

      const realtimeMessage = normalizeRealtimeMessage(payload, conversation);
      if (!realtimeMessage) {
        void refreshRecentMessages();
        return;
      }

      setMessages((currentMessages) => {
        const mergedMessages = mergeMessages(currentMessages, [realtimeMessage]);
        void writeCachedMessages(conversation.id, trimMessagesForCache(mergedMessages));
        return mergedMessages;
      });

      updateConversationQueryCaches(queryClient, conversation.id, (currentConversation) => {
        const patch = buildConversationActivityPatch(currentConversation, realtimeMessage);
        return patch ? { ...currentConversation, ...patch } : currentConversation;
      });

      if (String(realtimeMessage.sender_type || '').trim().toLowerCase() === 'client') {
        const realtimeMessageId = String(realtimeMessage.server_message_id || realtimeMessage.id || '').trim();
        window.setTimeout(() => scheduleMarkConversationRead('realtime', realtimeMessageId), 0);
      }
    };

    const handleMessageStatusUpdated = (payload = {}) => {
      if (!isRealtimeEventForConversation(payload, conversation)) return;

      const targetMessageId = resolveRealtimeMessageId(payload);
      const nextStatus = String(payload.status || payload.message?.status || '').trim();
      if (!targetMessageId || !nextStatus) {
        void refreshRecentMessages();
        return;
      }

      setMessages((currentMessages) => {
        const nextMessages = currentMessages.map((message) => {
          const candidates = [
            message.id,
            message.server_message_id,
            message.provider_message_id,
            message.client_message_id,
          ].map((value) => String(value || '').trim());

          if (!candidates.includes(targetMessageId)) return message;
          return { ...message, status: nextStatus };
        });
        void writeCachedMessages(conversation.id, trimMessagesForCache(nextMessages));
        return nextMessages;
      });
    };

    const handleMessageReactionUpdated = (payload = {}) => {
      if (!isRealtimeEventForConversation(payload, conversation)) return;
      void refreshRecentMessages();
    };

    const unsubscribeMessage = subscribeLocalRealtimeEvent('conversation:message-upserted', handleMessageUpserted);
    const unsubscribeStatus = subscribeLocalRealtimeEvent('conversation:message-status-updated', handleMessageStatusUpdated);
    const unsubscribeReaction = subscribeLocalRealtimeEvent('conversation:message-reaction-updated', handleMessageReactionUpdated);

    return () => {
      unsubscribeMessage();
      unsubscribeStatus();
      unsubscribeReaction();
    };
  }, [conversation, queryClient, refreshRecentMessages, scheduleMarkConversationRead, sourceAccountsKey, sourceConversationIdsKey]);

  const loadHistoryMessages = async () => {
    if (!conversation?.id || isLoadingHistory || !hasHistoryMessages) {
      return;
    }

    const oldestTimestamp = messages[0]?.created_date || messages[0]?.timestamp || new Date().toISOString();
    const container = scrollContainerRef.current;
    const previousScrollHeight = container?.scrollHeight || 0;
    const previousScrollTop = container?.scrollTop || 0;

    setIsLoadingHistory(true);

    try {
      const historyMessages = await fetchWhatsappHistoryMessages(conversation, {
        tail: 1000,
        until: oldestTimestamp,
        windowDays: 7,
      });
      const loadedMessages = Array.isArray(historyMessages?.messages) ? historyMessages.messages : [];

      if (loadedMessages.length === 0) {
        setHasHistoryMessages(false);
        toast.info('Nenhum historico adicional encontrado.');
        return;
      }

      setMessages((currentMessages) => {
        const mergedMessages = mergeMessages(currentMessages, loadedMessages);
        return mergedMessages;
      });
      setHasHistoryMessages(Boolean(historyMessages.hasMore));

      requestAnimationFrame(() => {
        const nextContainer = scrollContainerRef.current;
        if (!nextContainer) return;
        const nextScrollHeight = nextContainer.scrollHeight;
        nextContainer.scrollTop = nextScrollHeight - previousScrollHeight + previousScrollTop;
      });
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel carregar o historico.');
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const loadOlderMessages = async () => {
    if (!conversation?.id || isLoadingOlder || !hasOlderMessages || messages.length === 0) {
      return;
    }

    const oldestTimestamp = messages[0]?.created_date || messages[0]?.timestamp;
    if (!oldestTimestamp) {
      setHasOlderMessages(false);
      return;
    }

    const container = scrollContainerRef.current;
    const previousScrollHeight = container?.scrollHeight || 0;
    const previousScrollTop = container?.scrollTop || 0;

    setIsLoadingOlder(true);

    try {
      let olderMessages;
      let hasMoreAfterPage;
      if (ENABLE_NEW_CHAT_DATA_LAYER) {
        const previousPageCount = paginatedMessagesQuery.data?.pages?.length || 0;
        const result = await paginatedMessagesQuery.fetchNextPage();
        if (result.error) throw result.error;
        const pages = Array.isArray(result.data?.pages) ? result.data.pages : [];
        const appendedPage = pages[previousPageCount] || null;
        olderMessages = Array.isArray(appendedPage?.items) ? appendedPage.items : [];
        hasMoreAfterPage = Boolean(result.hasNextPage);
      } else {
        olderMessages = await fetchLegacyWhatsappMessages(conversation.id, {
          tail: OLDER_MESSAGE_PAGE_SIZE,
          until: oldestTimestamp,
          conversationIds: conversation.source_conversation_ids,
          sourceAccounts: conversation.source_accounts,
        });
        hasMoreAfterPage = olderMessages.length >= OLDER_MESSAGE_PAGE_SIZE;
      }

      if (olderMessages.length === 0) {
        setHasOlderMessages(false);
        return;
      }

      setMessages((currentMessages) => mergeMessages(currentMessages, olderMessages));
      setHasOlderMessages(hasMoreAfterPage);

      requestAnimationFrame(() => {
        const nextContainer = scrollContainerRef.current;
        if (!nextContainer) return;
        const nextScrollHeight = nextContainer.scrollHeight;
        nextContainer.scrollTop = nextScrollHeight - previousScrollHeight + previousScrollTop;
      });
    } catch (error) {
      toast.error(error?.message || 'Não foi possível carregar mensagens antigas.');
    } finally {
      setIsLoadingOlder(false);
    }
  };

  const handleLoadMoreMessages = async () => {
    if (isLoadingOlder || isLoadingHistory) return;
    if (hasOlderMessages) {
      await loadOlderMessages();
      return;
    }
    await loadHistoryMessages();
  };

  const loadMoreButtonLabel = isLoadingOlder || isLoadingHistory
    ? 'Carregando historico...'
    : hasOlderMessages
      ? 'Ver mais mensagens'
      : 'Carregar historico antigo';

  const appendOptimisticMessage = (optimisticMessage) => {
    setMessages((currentMessages) => mergeMessages(currentMessages, [optimisticMessage]));
    return optimisticMessage.temp_id;
  };

  const createOrderedOptimisticMessage = (payload) =>
    createOptimisticMessage({
      ...payload,
      senderName: currentUserName,
      clientOrder: nextOutgoingOrderRef.current++,
    });

  const queueOutgoingRequest = (task) => {
    const nextTask = Promise.resolve().then(task);
    outgoingQueueRef.current = nextTask.catch(() => undefined);
    return nextTask;
  };

  const registerRetryPayload = (messageId, payload) => {
    const safeMessageId = String(messageId || '').trim();
    if (!safeMessageId || !payload) return;
    retryPayloadsRef.current.set(safeMessageId, payload);
  };

  const clearRetryPayload = (messageId) => {
    const safeMessageId = String(messageId || '').trim();
    if (!safeMessageId) return;
    retryPayloadsRef.current.delete(safeMessageId);
  };

  const scheduleOptimisticSentStatus = (messageId) => {
    const safeMessageId = String(messageId || '').trim();
    if (!safeMessageId) return;

    window.setTimeout(() => {
      updateMessage(safeMessageId, (message) => {
        const currentStatus = String(message?.status || '').trim().toLowerCase();
        if (!['pending', 'sending', 'uploading'].includes(currentStatus)) {
          return message;
        }

        return {
          ...message,
          status: 'sent',
          upload_progress: 100,
        };
      });
    }, 500);
  };

  const finalizeOutgoingMessage = async (lastMessageText) => {
    await refreshRecentMessages();

    if (onUpdateConversation) {
      onUpdateConversation({
        ...conversation,
        last_message: lastMessageText || conversation.last_message,
      });
    }
  };

  const commitSendSuccess = (optimisticId, result, lastMessageText) => {
    const responseMessageId = extractResponseMessageId(result);
    const retryPayload = retryPayloadsRef.current.get(String(optimisticId || '').trim()) || null;
    const responseStatus = String(result?.item?.status || '').trim().toLowerCase();

    updateMessage(optimisticId, (message) => ({
      ...message,
      server_message_id: responseMessageId || message.server_message_id || '',
      sender_name: currentUserName,
      status: responseStatus || 'sent',
      upload_progress: 100,
      reply_preview: message.reply_preview || null,
    }));

    clearRetryPayload(optimisticId);

    void finalizeOutgoingMessage(lastMessageText);
  };

  const commitSendFailure = (optimisticId, updates, fallbackMessage) => {
    updateMessage(optimisticId, (message) => ({
      ...message,
      status: 'failed',
      upload_progress: 0,
      ...updates,
    }));
    toast.error(fallbackMessage);
  };

  const clearComposerAfterSend = () => {
    shouldDeleteDraftOnExitRef.current = false;
    shouldPromoteDraftOnExitRef.current = false;
    if (conversation?.id) {
      void deleteCachedDraft(conversation.id);
    }
    setReplyTo(null);
  };

  const enqueueTextSend = ({ messageId, content, replyToMessage }) => {
    const optimisticMessage =
      messageId
        ? null
        : createOrderedOptimisticMessage({
            conversationId: conversation.id,
            content: content.trim(),
            replyToMessage,
            replyPreview: buildReplyPreview(replyToMessage),
            status: 'pending',
          });
    const targetMessageId =
      messageId ||
      appendOptimisticMessage(optimisticMessage);

    registerRetryPayload(targetMessageId, {
      kind: 'text',
      content,
      replyToMessage,
      optimisticMessage,
    });

    updateMessage(targetMessageId, { status: 'pending', upload_progress: 0 });
    if (!ENABLE_NEW_CHAT_DATA_LAYER) scheduleOptimisticSentStatus(targetMessageId);

    return queueOutgoingRequest(async () => {
      try {
      const retryOptimisticMessage = retryPayloadsRef.current.get(String(targetMessageId || '').trim())?.optimisticMessage;
      const result = await sendWhatsappTextMessage({
          conversationId: conversation.id,
          to: conversation.contact_phone,
          text: content.trim(),
          contextMessageId: replyToMessage?.id || null,
          replyTo: replyToMessage?.content || null,
          agentName: currentUserName,
          origin: 'panel',
          routeSelector: activeManualRouteSelector,
          clientMessageId: optimisticMessage?.client_message_id || retryOptimisticMessage?.client_message_id || String(targetMessageId || '').replace(/^local-/, ''),
        });

        commitSendSuccess(targetMessageId, result, content.trim());
      } catch (error) {
        commitSendFailure(targetMessageId, {}, error?.message || 'Não foi possível enviar a mensagem.');
      }
    });

    return targetMessageId;
  };

  const enqueueImageSend = ({ messageId, file, mimetype, caption, replyToMessage, previewUrl }) => {
    const optimisticMessage =
      messageId
        ? null
        : createOrderedOptimisticMessage({
            conversationId: conversation.id,
            content: caption || '',
            messageType: 'image',
            replyToMessage,
            replyPreview: buildReplyPreview(replyToMessage),
            status: 'uploading',
            uploadProgress: 20,
            attachments: previewUrl ? [{ type: 'image', url: previewUrl, name: 'Imagem' }] : [],
          });
    const targetMessageId =
      messageId ||
      appendOptimisticMessage(optimisticMessage);

    registerRetryPayload(targetMessageId, {
      kind: 'image',
      file,
      mimetype,
      caption,
      replyToMessage,
      previewUrl,
      optimisticMessage,
    });

    updateMessage(targetMessageId, { status: 'uploading', upload_progress: 20 });
    scheduleOptimisticSentStatus(targetMessageId);

    return queueOutgoingRequest(async () => {
      try {
        updateMessage(targetMessageId, (message) =>
          message.status === 'sent' ? message : { ...message, status: 'uploading', upload_progress: 45 },
        );
        const imageBase64 = await fileToBase64Payload(file, 'Não foi possível ler a imagem selecionada.');
        updateMessage(targetMessageId, (message) =>
          message.status === 'sent' ? message : { ...message, status: 'uploading', upload_progress: 75 },
        );

        const result = await sendWhatsappImageMessage({
          conversationId: conversation.id,
          to: conversation.contact_phone,
          imageBase64,
          mimetype: mimetype || file?.type || 'image/jpeg',
          caption,
          contextMessageId: replyToMessage?.id || null,
          replyTo: replyToMessage?.content || null,
          agentName: currentUserName,
          routeSelector: activeManualRouteSelector,
          clientMessageId: optimisticMessage?.client_message_id,
        });

        commitSendSuccess(targetMessageId, result, caption || 'Imagem');
      } catch (error) {
        commitSendFailure(
          targetMessageId,
          { status: 'failed', upload_progress: 0 },
          error?.message || 'Não foi possível enviar a imagem.'
        );
      }
    });

    return targetMessageId;
  };

  const enqueueAudioSend = ({ messageId, file, audioBase64, mimetype, replyToMessage }) => {
    const previewUrl = file ? URL.createObjectURL(file) : '';
    const optimisticMessage =
      messageId
        ? null
        : createOrderedOptimisticMessage({
            conversationId: conversation.id,
            content: '',
            messageType: 'audio',
            replyToMessage,
            replyPreview: buildReplyPreview(replyToMessage),
            status: 'uploading',
            uploadProgress: 25,
            attachments: previewUrl
              ? [
                  {
                    type: 'audio',
                    url: previewUrl,
                    name: file?.name || 'Audio',
                    mimeType: mimetype || file?.type || 'audio/ogg',
                  },
                ]
              : [],
          });
    const targetMessageId =
      messageId ||
      appendOptimisticMessage(optimisticMessage);

    registerRetryPayload(targetMessageId, {
      kind: 'audio',
      file,
      audioBase64,
      mimetype,
      replyToMessage,
      optimisticMessage,
    });

    updateMessage(targetMessageId, { status: 'uploading', upload_progress: 25 });
    scheduleOptimisticSentStatus(targetMessageId);

    return queueOutgoingRequest(async () => {
      try {
        updateMessage(targetMessageId, (message) =>
          message.status === 'sent' ? message : { ...message, status: 'uploading', upload_progress: 55 },
        );
        const payload =
          audioBase64 ||
          (await fileToBase64Payload(file, 'Não foi possível ler o audio selecionado.'));
        updateMessage(targetMessageId, (message) =>
          message.status === 'sent' ? message : { ...message, status: 'uploading', upload_progress: 80 },
        );

        const result = await sendWhatsappAudioMessage({
          conversationId: conversation.id,
          to: conversation.contact_phone,
          audioBase64: payload,
          mimetype: mimetype || file?.type || 'audio/ogg',
          ptt: true,
          contextMessageId: replyToMessage?.id || null,
          replyTo: replyToMessage?.content || null,
          agentName: currentUserName,
          routeSelector: activeManualRouteSelector,
          clientMessageId: optimisticMessage?.client_message_id,
        });

        commitSendSuccess(targetMessageId, result, 'Audio');
      } catch (error) {
        commitSendFailure(
          targetMessageId,
          { status: 'failed', upload_progress: 0 },
          error?.message || 'Não foi possível enviar o audio.'
        );
      }
    });

    return targetMessageId;
  };

  const enqueueDocumentSend = ({ messageId, file, mimetype, filename, caption, replyToMessage }) => {
    const previewUrl = file ? URL.createObjectURL(file) : '';
    const safeName = String(filename || file?.name || 'Documento').trim() || 'Documento';
    const optimisticMessage =
      messageId
        ? null
        : createOrderedOptimisticMessage({
            conversationId: conversation.id,
            content: caption || safeName,
            messageType: 'document',
            replyToMessage,
            replyPreview: buildReplyPreview(replyToMessage),
            status: 'uploading',
            uploadProgress: 20,
            attachments: previewUrl
              ? [
                  {
                    type: 'document',
                    url: previewUrl,
                    name: safeName,
                    mimeType: mimetype || file?.type || 'application/octet-stream',
                  },
                ]
              : [],
          });
    const targetMessageId =
      messageId ||
      appendOptimisticMessage(optimisticMessage);

    registerRetryPayload(targetMessageId, {
      kind: 'document',
      file,
      mimetype,
      filename: safeName,
      caption,
      replyToMessage,
      optimisticMessage,
    });

    updateMessage(targetMessageId, { status: 'uploading', upload_progress: 20 });
    scheduleOptimisticSentStatus(targetMessageId);

    return queueOutgoingRequest(async () => {
      try {
        updateMessage(targetMessageId, (message) =>
          message.status === 'sent' ? message : { ...message, status: 'uploading', upload_progress: 45 },
        );
        const documentBase64 = await fileToBase64Payload(file, 'Não foi possível ler o documento selecionado.');
        updateMessage(targetMessageId, (message) =>
          message.status === 'sent' ? message : { ...message, status: 'uploading', upload_progress: 75 },
        );

        const result = await sendWhatsappDocumentMessage({
          conversationId: conversation.id,
          to: conversation.contact_phone,
          documentBase64,
          mimetype: mimetype || file?.type || 'application/octet-stream',
          filename: safeName,
          caption,
          contextMessageId: replyToMessage?.id || null,
          replyTo: replyToMessage?.content || null,
          agentName: currentUserName,
          routeSelector: activeManualRouteSelector,
          clientMessageId: optimisticMessage?.client_message_id,
        });

        commitSendSuccess(targetMessageId, result, caption || safeName);
      } catch (error) {
        commitSendFailure(
          targetMessageId,
          { status: 'failed', upload_progress: 0 },
          error?.message || 'Não foi possível enviar o documento.'
        );
      }
    });

    return targetMessageId;
  };

  const enqueueVideoSend = ({ messageId, file, mimetype, filename, caption, replyToMessage, previewUrl }) => {
    const safeName = String(filename || file?.name || 'video').trim() || 'video';
    const optimisticMessage =
      messageId
        ? null
        : createOrderedOptimisticMessage({
            conversationId: conversation.id,
            content: caption || safeName,
            messageType: 'video',
            replyToMessage,
            replyPreview: buildReplyPreview(replyToMessage),
            status: 'uploading',
            uploadProgress: 20,
            attachments: previewUrl ? [{ type: 'video', url: previewUrl, name: safeName, mimeType: mimetype || file?.type || 'video/mp4' }] : [],
          });
    const targetMessageId = messageId || appendOptimisticMessage(optimisticMessage);

    registerRetryPayload(targetMessageId, {
      kind: 'video',
      file,
      mimetype,
      filename: safeName,
      caption,
      replyToMessage,
      optimisticMessage,
    });

    updateMessage(targetMessageId, { status: 'uploading', upload_progress: 20 });
    scheduleOptimisticSentStatus(targetMessageId);

    return queueOutgoingRequest(async () => {
      try {
        updateMessage(targetMessageId, (message) =>
          message.status === 'sent' ? message : { ...message, status: 'uploading', upload_progress: 45 },
        );
        const videoBase64 = await fileToBase64Payload(file, 'Não foi possível ler o vídeo selecionado.');
        updateMessage(targetMessageId, (message) =>
          message.status === 'sent' ? message : { ...message, status: 'uploading', upload_progress: 75 },
        );

        const result = await sendWhatsappVideoMessage({
          conversationId: conversation.id,
          to: conversation.contact_phone,
          videoBase64,
          mimetype: mimetype || file?.type || 'video/mp4',
          filename: safeName,
          caption,
          contextMessageId: replyToMessage?.id || null,
          replyTo: replyToMessage?.content || null,
          agentName: currentUserName,
          routeSelector: activeManualRouteSelector,
          clientMessageId: optimisticMessage?.client_message_id,
        });

        commitSendSuccess(targetMessageId, result, caption || safeName);
      } catch (error) {
        commitSendFailure(
          targetMessageId,
          { status: 'failed', upload_progress: 0 },
          error?.message || 'Não foi possível enviar o vídeo.'
        );
      }
    });
  };

  const enqueueTemplateSend = ({ messageId, template }) => {
    const previewText = buildTemplatePreview(template);
    const templateButtons = getTemplateButtons(template);
    const headerParameters =
      template.headerMediaUrl && template.headerFormat && template.headerFormat !== 'TEXT'
        ? [template.headerMediaUrl]
        : [];
    const optimisticMessage =
      messageId
        ? null
        : createOrderedOptimisticMessage({
            conversationId: conversation.id,
            content: previewText || `Template: ${template.name}`,
            messageType: 'template',
            attachments:
              template.headerType === 'image' && template.headerMediaUrl
                ? [{ type: 'image', url: template.headerMediaUrl, name: 'Template header image' }]
                : [],
            templateButtons,
            status: 'pending',
          });

    const targetMessageId =
      messageId ||
      appendOptimisticMessage(optimisticMessage);

    registerRetryPayload(targetMessageId, {
      kind: 'template',
      template,
      optimisticMessage,
    });

    updateMessage(targetMessageId, { status: 'pending', upload_progress: 0 });
    scheduleOptimisticSentStatus(targetMessageId);

    return queueOutgoingRequest(async () => {
      try {
        const result = await sendWhatsappTemplateMessage({
          to: conversation.contact_phone,
          templateName: template.name,
          language: template.language || 'pt_BR',
          parameters: Array.isArray(template.bodyVariables) ? template.bodyVariables : [],
          buttonParameters: Array.isArray(template.buttonParameters) ? template.buttonParameters : [],
          headerParameters,
          headerFormat: template.headerFormat || '',
          previewText,
          agentName: currentUserName,
        });

        commitSendSuccess(targetMessageId, result, previewText || `Template: ${template.name}`);
      } catch (error) {
        commitSendFailure(
          targetMessageId,
          {},
          error?.message || 'Não foi possível enviar o template.'
        );
      }
    });

    return targetMessageId;
  };

  const resolveQuickReplyText = (value, runtimeVariables = {}) => {
    const customer = conversation?.customer || {};
    const replacements = {
      nome: conversation?.contact_name || customer.name || '',
      telefone: conversation?.contact_phone || customer.phone || '',
      servico: conversation?.sector || conversation?.department || customer.service || '',
      protocolo: conversation?.protocol || conversation?.protocol_number || conversation?.id || '',
      atendente: currentUserName || '',
      usuario: customer.username || customer.user || customer.usuario || '',
      senha: customer.password || customer.senha || '',
      plano: customer.plan || customer.plano || '',
      vencimento: customer.dueDate || customer.vencimento || customer.expirationDate || '',
    };

    return String(value || '').replace(/\{#([^}]+)\}/g, (_, hashKey) => {
      const key = String(hashKey || '').trim().toLowerCase();
      const exactKey = `{#${String(hashKey || '').trim()}}`;
      return runtimeVariables[exactKey] ?? replacements[key] ?? '';
    });
  };

  const handleExecuteQuickReply = async (reply) => {
    if (!conversation?.id) {
      toast.error('Selecione uma conversa antes de enviar a resposta rápida.');
      return;
    }
    if (!isWithin24hWindow) {
      toast.error('A janela de 24h está fechada. Use um template HSM para retomar o contato.');
      return;
    }

    const actions = getQuickReplyActions(reply);
    if (!actions.length) {
      toast.error('Esta resposta rápida não possui ações configuradas.');
      return;
    }

    try {
      let runtimeVariables = {};
      for (const action of actions) {
        const typingDelay = Math.max(0, Math.min(300, Number(action.typingDelaySeconds) || 0));
        const nextDelay = Math.max(0, Math.min(300, Number(action.nextActionDelaySeconds) || 0));

        if (action.type === 'timer' || action.type === 'wait') {
          await delaySeconds(Math.max(nextDelay, Math.max(0, Math.min(300, Number(action.waitSeconds) || 0))));
          continue;
        }

        if (typingDelay > 0) {
          await delaySeconds(typingDelay);
        }

        if (action.type === 'newbr_test') {
          const result = await createNewbrTest({
            conversationId: conversation.id,
            customerName: conversation.contact_name || conversation.customer?.name || '',
            customerPhone: conversation.contact_phone || conversation.customer?.phone || '',
            devicePhone: conversation.display_phone_number || '',
            appName: action.label || 'Teste Completo 4 horas',
            durationMinutes: action.durationMinutes || 240,
            followUpEnabled: action.followUpEnabled !== false,
            followUpBeforeMinutes: action.followUpBeforeMinutes ?? 10,
            followUpMessage: action.followUpMessage || '',
            requestedBy: currentUser?.email || currentUser?.id || '',
            requestedByName: currentUserName,
            action,
          });
          const resultVariables = result?.variables && typeof result.variables === 'object' ? result.variables : {};
          const testCompleted = Boolean(result?.session || result?.test || result?.reply);
          if (!testCompleted) {
            throw new Error('Teste NewBR nao foi concluido. A resposta com usuario, senha e codigo nao foi enviada.');
          }
          runtimeVariables = { ...runtimeVariables, ...resultVariables };
          await queryClient.invalidateQueries({ queryKey: ['newbr-test-active', conversation?.id, conversation?.contact_phone] });
          toast.success('Teste NewBR criado.');
        } else if (action.type === 'text') {
          const content = resolveQuickReplyText(action.content, runtimeVariables);
          if (content.trim()) {
            await enqueueTextSend({ content, replyToMessage: null });
          }
        } else if (['image', 'video', 'audio', 'document'].includes(action.type)) {
          const mediaPayload = resolveQuickReplyMediaPayload(action);
          if (!mediaPayload?.dataUrl) {
            toast.message(`Ação "${action.type}" ignorada: nenhum arquivo configurado.`);
          } else {
            console.info(
              `Executando ação de ${mediaPayload.kind}: mimeType=${mediaPayload.mimeType}, endpoint=${mediaPayload.endpoint}, sizeKb=${mediaPayload.approxSizeKb}`
            );
            const file = dataUrlToFile(mediaPayload.dataUrl, mediaPayload.fileName, mediaPayload.mimeType);
            const caption = resolveQuickReplyText(mediaPayload.caption, runtimeVariables);
            if (mediaPayload.kind === 'image') {
              await enqueueImageSend({
                file,
                mimetype: mediaPayload.mimeType || file.type,
                caption,
                replyToMessage: null,
                previewUrl: mediaPayload.dataUrl,
              });
            } else if (mediaPayload.kind === 'video') {
              await enqueueVideoSend({
                file,
                mimetype: mediaPayload.mimeType || file.type,
                filename: mediaPayload.fileName || file.name,
                caption,
                replyToMessage: null,
                previewUrl: mediaPayload.dataUrl,
              });
            } else if (mediaPayload.kind === 'audio') {
              await enqueueAudioSend({
                file,
                mimetype: mediaPayload.mimeType || file.type,
                replyToMessage: null,
              });
            } else {
              await enqueueDocumentSend({
                file,
                mimetype: mediaPayload.mimeType || file.type,
                filename: mediaPayload.fileName || file.name,
                caption,
                replyToMessage: null,
              });
            }
          }
        } else if (action.type === 'ura') {
          const uraPayload = resolveQuickReplyUraPayload(action, (text) => resolveQuickReplyText(text, runtimeVariables));
          if (!uraPayload.buttons.length) {
            toast.message('URA ignorada: adicione ao menos uma opção válida.');
          } else {
            try {
              await sendWhatsappInteractiveMessage({
                conversationId: conversation.id,
                to: conversation.contact_phone,
                text: uraPayload.text,
                buttonText: uraPayload.buttonText,
                buttons: uraPayload.buttons,
                footer: uraPayload.footer,
                agentName: currentUserName,
                routeSelector: activeManualRouteSelector,
              });
              console.info(`URA enviada como botões com ${uraPayload.buttons.length} opções`);
            } catch (error) {
              console.warn('Envio de URA por botões ainda não possui integração ativa.', error);
              toast.message('Envio de URA por botões ainda não possui integração ativa. A sequência continuará.');
            }
          }
        } else if (action.type === 'transfer') {
          const customerMessage = resolveQuickReplyText(action.metadata?.customerMessage || '', runtimeVariables);
          if (customerMessage.trim()) {
            await enqueueTextSend({ content: customerMessage, replyToMessage: null });
          }
          toast.message('Transferência automática ainda precisa de integração. A sequência continuará.');
        } else {
          toast.message('Esta ação ainda não está disponível para envio.');
        }

        if (nextDelay > 0) {
          await delaySeconds(nextDelay);
        }
      }

      await incrementQuickReplyUsage(reply);
      queryClient.invalidateQueries({ queryKey: ['quick-replies'] });
    } catch (error) {
      toast.error(error?.message || 'Não foi possível executar a resposta rápida.');
    }
  };

  const handleSendText = async ({ content, replyToMessage }) => {
    if (!conversation?.id || !content.trim()) return;
    clearComposerAfterSend();
    enqueueTextSend({
      content,
      replyToMessage,
    });
  };

  const handleSendImage = async ({
    file,
    mimetype,
    caption,
    replyToMessage,
    previewUrl,
  }) => {
    if (!conversation?.id || !file) return;
    if (replyToMessage) {
      setReplyTo(null);
    }
    enqueueImageSend({
      file,
      mimetype,
      caption,
      replyToMessage,
      previewUrl,
    });
  };

  const handleSendAudio = async ({ file, audioBase64, mimetype, replyToMessage }) => {
    if (!conversation?.id || (!file && !audioBase64)) return;
    if (replyToMessage) {
      setReplyTo(null);
    }
    enqueueAudioSend({
      file,
      audioBase64,
      mimetype,
      replyToMessage,
    });
  };

  const handleSendDocument = async ({ file, mimetype, filename, caption, replyToMessage }) => {
    if (!conversation?.id || !file) return;
    if (replyToMessage) {
      setReplyTo(null);
    }
    enqueueDocumentSend({
      file,
      mimetype,
      filename,
      caption,
      replyToMessage,
    });
  };

  const handleSendVideo = async ({ file, mimetype, filename, caption, replyToMessage, previewUrl }) => {
    if (!conversation?.id || !file) return;
    if (replyToMessage) {
      setReplyTo(null);
    }
    enqueueVideoSend({
      file,
      mimetype,
      filename,
      caption,
      replyToMessage,
      previewUrl,
    });
  };

  const handleSendPreviewImages = async ({ items }) => {
    const safeItems = Array.isArray(items) ? items.filter((item) => item?.file) : [];
    if (!conversation?.id || safeItems.length === 0) return;

    const currentReplyTo = replyTo || null;

    setImageFiles(null);
    setReplyTo(null);

    safeItems.forEach((item, index) => {
      handleSendImage({
        file: item.file,
        mimetype: item.file.type || 'image/jpeg',
        caption: String(item.caption || '').trim(),
        replyToMessage: index === 0 ? currentReplyTo : null,
        previewUrl: item.url,
      });
    });
  };

  const handleSendTemplate = async (template) => {
    if (!conversation?.id || !template?.name) return;
    enqueueTemplateSend({ template });
  };

  const handleResolveConversation = async () => {
    if (!conversation?.id || isResolvingConversation) {
      return;
    }

    const resolvedAt = new Date().toISOString();
    const lastClientMessageAt =
      conversation.last_client_message_time ||
      conversation.last_received_at ||
      conversation.last_message_time ||
      resolvedAt;
    const lastClientMessageMs = Date.parse(String(lastClientMessageAt || ''));
    const resolvedUntil =
      Number.isFinite(lastClientMessageMs) && lastClientMessageMs > 0
        ? new Date(lastClientMessageMs + 24 * 60 * 60 * 1000).toISOString()
        : new Date(Date.parse(resolvedAt) + 24 * 60 * 60 * 1000).toISOString();
    const resolutionLabel = resolveType === 'lack_of_interaction' ? 'falta de interação' : 'atendimento encerrado';

    setIsResolvingConversation(true);

    try {
      const savedPreference = await saveConversationPreference(conversation.id, {
        resolution_status: 'resolved',
        resolution_type: resolveType,
        resolved_at: resolvedAt,
        resolved_until: resolvedUntil,
        resolved_by_id: currentUserId,
        resolved_by_name: currentUserName,
        sourceConversationIds: conversation.source_conversation_ids,
      });

      queryClient.setQueriesData({ queryKey: ['conversation-preferences'] }, (current = []) => {
        const nextItems = Array.isArray(current) ? [...current] : [];
        const currentIndex = nextItems.findIndex(
          (item) => String(item?.conversation_id || item?.id || '') === String(conversation.id)
        );

        if (currentIndex >= 0) {
          nextItems[currentIndex] = savedPreference;
        } else {
          nextItems.unshift(savedPreference);
        }

        return nextItems;
      });

      const resolutionMessage = buildConversationResolutionSystemMessage({
        conversationId: conversation.id,
        type: resolveType,
        agentName: currentUserName,
      });

      setMessages((currentMessages) => mergeMessages(currentMessages, [resolutionMessage]));

      if (onUpdateConversation) {
        onUpdateConversation({
          ...conversation,
          resolution_status: 'resolved',
          resolution_type: resolveType,
          resolved_at: resolvedAt,
          resolved_until: resolvedUntil,
          resolved_by_id: currentUserId,
          resolved_by_name: currentUserName,
          is_daily_resolved: false,
          attendance_bucket: 'resolved',
          attendance_bucket_reason: 'manual',
          resolution_kind: 'manual',
          assigned_agent: '',
          assigned_agent_id: '',
          assigned_agent_email: '',
          assigned_agent_name: '',
          assigned_at: '',
          assignment_source: 'resolved',
          queue_status: 'resolved',
          queued_at: '',
          queued_service_id: '',
          queued_service_ids: [],
          queued_service_name: '',
          queued_service_names: [],
          is_pending: false,
          is_in_attendance: false,
        });
      }

      setResolveDialogOpen(false);
      onClearConversation?.();
      toast.success(`Conversa encerrada como ${resolutionLabel}.`);
    } catch (error) {
      toast.error(error?.message || 'Não foi possível encerrar a conversa.');
    } finally {
      setIsResolvingConversation(false);
    }
  };

  const handleTransferConversation = async () => {
    if (!conversation?.id || !transferUserId || isTransferringConversation) {
      return;
    }

    setIsTransferringConversation(true);

    try {
      const result = await assignConversationToUser(conversation.id, transferUserId, {
        sourceConversationIds: conversation.source_conversation_ids,
        matchingServiceIds: conversation.matching_service_ids,
      });

      if (result?.conversation) {
        updateConversationCaches(queryClient, conversation.id, result.conversation);
        onUpdateConversation?.({
          ...conversation,
          ...result.conversation,
        });
      }

      setTransferDialogOpen(false);
      setTransferUserId('');
      setTransferServiceId('');

      if (!isCurrentUserAdmin) {
        onClearConversation?.();
      }

      toast.success('Atendimento transferido.');
    } catch (error) {
      toast.error(error?.message || 'Não foi possível transferir o atendimento.');
    } finally {
      setIsTransferringConversation(false);
    }
  };

  const handleSendConversationToQueue = async () => {
    if (!conversation?.id || isTransferringConversation) {
      return;
    }

    setIsTransferringConversation(true);

    try {
      const result = await requeueConversationForService(conversation.id, {
        sourceConversationIds: conversation.source_conversation_ids,
        matchingServiceIds: conversation.matching_service_ids,
      });

      if (result?.conversation) {
        updateConversationCaches(queryClient, conversation.id, result.conversation);
        onUpdateConversation?.({
          ...conversation,
          ...result.conversation,
        });
      }

      setTransferDialogOpen(false);
      setTransferUserId('');
      setTransferServiceId('');

      if (!isCurrentUserAdmin) {
        onClearConversation?.();
      }

      toast.success('Atendimento enviado para a fila do serviço.');
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel enviar o atendimento para a fila.');
    } finally {
      setIsTransferringConversation(false);
    }
  };

  const handleTransferConversationToService = async () => {
    if (!conversation?.id || !transferServiceId || isTransferringConversation) {
      return;
    }

    setIsTransferringConversation(true);

    try {
      const result = await requeueConversationForService(conversation.id, {
        sourceConversationIds: conversation.source_conversation_ids,
        matchingServiceIds: conversation.matching_service_ids,
        targetServiceId: transferServiceId,
      });

      if (result?.conversation) {
        updateConversationCaches(queryClient, conversation.id, result.conversation);
        onUpdateConversation?.({
          ...conversation,
          ...result.conversation,
        });
      }

      const targetService = transferServices.find((service) => String(service.id || '') === transferServiceId);
      setTransferDialogOpen(false);
      setTransferUserId('');
      setTransferServiceId('');

      if (!isCurrentUserAdmin) {
        onClearConversation?.();
      }

      toast.success(`Atendimento transferido para ${targetService?.name || 'o serviço selecionado'}.`);
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel transferir o atendimento para o servico.');
    } finally {
      setIsTransferringConversation(false);
    }
  };

  const handleRetryMessage = (message) => {
    const retryKey = String(message?.temp_id || message?.id || '').trim();
    if (!retryKey) return;

    const retryPayload = retryPayloadsRef.current.get(retryKey);
    if (!retryPayload) {
      toast.message('Não há dados suficientes para reenviar esta mensagem.');
      return;
    }

    if (retryPayload.kind === 'text') {
      enqueueTextSend({ ...retryPayload, messageId: retryKey });
      return;
    }

    if (retryPayload.kind === 'image') {
      enqueueImageSend({ ...retryPayload, messageId: retryKey });
      return;
    }

    if (retryPayload.kind === 'audio') {
      enqueueAudioSend({ ...retryPayload, messageId: retryKey });
      return;
    }

    if (retryPayload.kind === 'video') {
      enqueueVideoSend({ ...retryPayload, messageId: retryKey });
      return;
    }

    if (retryPayload.kind === 'document') {
      enqueueDocumentSend({ ...retryPayload, messageId: retryKey });
      return;
    }

    if (retryPayload.kind === 'template') {
      enqueueTemplateSend({ ...retryPayload, messageId: retryKey });
      return;
    }

    toast.message('Reenvio indisponível para este tipo de mensagem.');
  };

  const handleReact = async (message, emoji) => {
    const reactionMessageId = message?.server_message_id || message?.id;
    if (!conversation?.id || !reactionMessageId) return;

    const currentAgentReaction = getReactionList(message).find((reaction) => reaction.from === 'agent')?.emoji || '';
    const nextEmoji = currentAgentReaction === emoji ? '' : emoji;
    const previousReactions = getReactionList(message);

    updateMessage(message.id, {
      reactions: applyReactionChange(previousReactions, 'agent', nextEmoji),
      pending_agent_reaction: nextEmoji,
      pending_agent_reaction_at: new Date().toISOString(),
    });

    try {
      await reactToWhatsappMessage({
        conversationId: conversation.id,
        messageId: reactionMessageId,
        emoji: nextEmoji,
        from: 'agent',
      });
    } catch (error) {
      updateMessage(message.id, {
        reactions: previousReactions,
        pending_agent_reaction: null,
        pending_agent_reaction_at: null,
      });
      toast.error(error?.message || 'Não foi possível reagir a mensagem.');
    }
  };

  const handleTranscribeAudio = async (message) => {
    const messageId = resolveIncomingMessageIdentifier(message);
    if (!messageId) {
      toast.error('Nao foi possivel identificar a mensagem de audio.');
      return;
    }

    const identifiers = resolveMessageIdentifierCandidates(message);
    const conversationId = message.source_conversation_id || message.conversation_id || conversation?.id || '';
    const sourceConversationId = message.source_conversation_id || message.conversation_id || '';
    setTranscribingMessageIds((current) => new Set(current).add(messageId));
    updateMessageByIdentifiers(identifiers, {
      transcription: {
        ...(message.transcription || {}),
        status: 'processing',
        error: '',
        updatedAt: new Date().toISOString(),
      },
    });

    try {
      const result = await transcribeWhatsappAudioMessage({
        messageId,
        force: true,
        conversationId,
        sourceConversationId,
        identifiers,
      });
      updateMessageByIdentifiers(identifiers, {
        transcription: result?.transcription || null,
        audioTranscription: result?.transcription || null,
      });
      const maxAttempts = 90;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt < 10 ? 1500 : 3000));
        const statusResult = await fetchWhatsappAudioTranscription({
          messageId,
          conversationId,
          sourceConversationId,
          identifiers,
        });
        const transcription = statusResult?.transcription || null;
        updateMessageByIdentifiers(identifiers, {
          transcription,
          audioTranscription: transcription,
        });
        if (transcription?.status === 'completed' || transcription?.status === 'failed') {
          break;
        }
      }
    } catch (error) {
      updateMessageByIdentifiers(identifiers, {
        transcription: {
          status: 'failed',
          text: '',
          error: error?.message || 'Nao foi possivel transcrever o audio.',
          updatedAt: new Date().toISOString(),
        },
      });
      toast.error(error?.message || 'Nao foi possivel transcrever o audio.');
    } finally {
      setTranscribingMessageIds((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    }
  };

  const handleMessageInfo = (message) => {
    console.info('message_info', message);
    const createdAt = message?.created_date ? format(new Date(message.created_date), 'HH:mm') : '--:--';
    toast.message(`Mensagem ${message?.status || 'sem status'} enviada às ${createdAt}.`);
  };


  useEffect(() => {
    if (!searchMode && stickToBottomRef.current && !isLoadingOlder) {
      messagesEndRef.current?.scrollIntoView({
        behavior: messages.length > INITIAL_MESSAGE_PAGE_SIZE ? 'smooth' : 'auto',
      });
    }
  }, [messages, searchMode, isLoadingOlder]);

  const filteredMessages = msgSearch
    ? messages.filter((message) =>
        String(message.content || '').toLowerCase().includes(msgSearch.toLowerCase())
      )
    : messages;

  const grouped = groupMessagesByDate(filteredMessages);
  const visibleLabels = useMemo(() => {
    const primaryLabel = conversation?.primary_label || null;
    const labels = Array.isArray(conversation?.visible_labels) ? conversation.visible_labels : [];
    return Array.from(
      new Map(
        [primaryLabel, ...labels]
          .filter((label) => label?.id)
          .map((label) => [String(label.id), label]),
      ).values(),
    );
  }, [conversation?.primary_label, conversation?.visible_labels]);

  const renderThreadItem = (item, index) => {
    if (item.type === 'separator') {
      return (
        <div key={`sep-${item.label}-${index}`} className="flex justify-center py-3">
          <span className="text-[11px] text-muted-foreground bg-muted/80 px-3 py-1 rounded-full shadow-sm">
            {item.label}
          </span>
        </div>
      );
    }

    return (
      <ChatMessage
        key={
          item.data.client_message_id ||
          item.data.provider_message_id ||
          item.data.server_message_id ||
          item.data.id
        }
        message={item.data}
        contactAvatarUrl={conversation.avatar_url}
        contactName={conversation.contact_name}
        currentUserName={currentUserName}
        onReply={(message) => setReplyTo(message)}
        onReact={(message, emoji) => void handleReact(message, emoji)}
        onRetry={handleRetryMessage}
        onInfo={handleMessageInfo}
        onTranscribeAudio={(message) => void handleTranscribeAudio(message)}
        isTranscribingAudio={transcribingMessageIds.has(resolveIncomingMessageIdentifier(item.data))}
        onOpenMedia={(mediaItem) => {
          setLightboxActiveId(mediaItem.id);
          setIsLightboxOpen(true);
        }}
        onStartConversation={(phone) => onOpenStartConversation?.(phone)}
      />
    );
  };

  if (!conversation) {
    return (
      <div className="chat-app-shell flex-1 flex items-center justify-center bg-muted/20">
        <div className="text-center space-y-3">
          <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center mx-auto">
            <svg width="36" height="36" viewBox="0 0 28 28" fill="none">
              <rect x="11" y="2" width="6" height="24" rx="2.5" fill="url(#pg2)" />
              <rect x="2" y="11" width="24" height="6" rx="2.5" fill="url(#pg2)" />
              <defs>
                <linearGradient id="pg2" x1="2" y1="2" x2="26" y2="26" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#4ade80" />
                  <stop offset="100%" stopColor="#a855f7" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-lg text-foreground">Selecione uma conversa</h3>
            <p className="text-sm text-muted-foreground mt-1">Escolha um atendimento para começar</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-app-shell flex-1 flex flex-col h-full bg-background min-w-0">
      <div className="chat-header h-14 px-4 flex items-center justify-between border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative flex-shrink-0">
            <ContactAvatar
              src={conversation.avatar_url}
              name={conversation.contact_name || 'Contato'}
              className="w-9 h-9"
              textClassName="text-sm"
            />
          </div>
          <div data-chat-selection-surface="true" className="min-w-0 select-text">
            <h3
              data-chat-selection-surface="true"
              className="font-semibold text-sm text-foreground leading-tight truncate select-text"
            >
              {conversation.contact_name}
            </h3>
            <div data-chat-selection-surface="true" className="flex items-center gap-2 flex-wrap select-text">
              <span
                data-chat-selection-surface="true"
                className="text-[11px] text-muted-foreground select-text"
              >
                {conversation.contact_phone}
              </span>
              {assignmentStatus?.label ? (
                <Badge
                  variant="outline"
                  className={cn('h-5 max-w-[220px] text-[10px]', assignmentStatus.badgeClassName)}
                  title={[
                    assignmentStatus.detail,
                    assignmentStatus.serviceName ? `Fila: ${assignmentStatus.serviceName}` : '',
                    assignmentStatus.agentName ? `Responsavel: ${assignmentStatus.agentName}` : '',
                  ].filter(Boolean).join(' | ')}
                >
                  <span className="truncate">{assignmentStatus.label}</span>
                </Badge>
              ) : null}
              {visibleLabels.slice(0, 2).map((label) => (
                <LabelBadge key={label.id} label={label} compact />
              ))}
              {visibleLabels.length > 2 ? (
                <span
                  data-chat-selection-surface="true"
                  className="text-[10px] font-medium text-muted-foreground select-text"
                >
                  +{visibleLabels.length - 2}
                </span>
              ) : null}
              <Badge
                variant="outline"
                className={cn(
                  'h-5 text-[10px] gap-1',
                  isWithin24hWindow
                    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700'
                    : 'border-amber-500/25 bg-amber-500/10 text-amber-700'
                )}
              >
                <TimerReset className="w-3 h-3" />
                {isWithin24hWindow ? '24h aberta' : 'Somente HSM'}
              </Badge>
              <TicketStatusBadge
                summary={conversationTicketsQuery.data?.summary}
                onClick={() => {
                  setTicketPanelOpen(true);
                  setQuickReplyPanelOpen(false);
                  setTavinhoPanelOpen(false);
                }}
              />
              {activeNewbrTest ? (
                <Badge
                  variant="outline"
                  className={cn(
                    'h-5 text-[10px] gap-1',
                    activeNewbrRemainingSeconds > 0
                      ? 'border-violet-500/25 bg-violet-500/10 text-violet-700'
                      : 'border-slate-500/25 bg-slate-500/10 text-slate-600'
                  )}
                >
                  <Clock className="w-3 h-3" />
                  {activeNewbrRemainingSeconds > 0 ? `Teste: ${activeNewbrRemainingLabel}` : 'Teste expirado'}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0">

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              setSearchMode(!searchMode);
              setMsgSearch('');
            }}
            title="Buscar mensagens"
          >
            <Search className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8', showInfo && 'bg-accent text-accent-foreground')}
            onClick={onToggleInfo}
            title="Informações do contato"
          >
            <Info className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              setTransferUserId('');
              setTransferServiceId('');
              setTransferDialogOpen(true);
            }}
            title="Transferência"
          >
            <i className="fa-solid fa-arrow-right-arrow-left text-[14px]" aria-hidden="true" />
            <span className="sr-only">Transferência</span>
          </Button>
          <Button
            type="button"
            size="icon"
            className="h-8 w-8 rounded-full border border-destructive/30 bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"
            onClick={() => setResolveDialogOpen(true)}
            title="Encerrar atendimento"
          >
            <Power className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {checkoutRenewalAlert ? (
        <div className="border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-amber-900">
          <div className="flex min-w-0 items-start gap-2 text-xs font-medium leading-snug">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span className="min-w-0">{checkoutRenewalAlert.message}</span>
          </div>
        </div>
      ) : null}

      {searchMode && (
        <div className="chat-header px-4 py-2 border-b border-border flex-shrink-0">
          <Input
            autoFocus
            value={msgSearch}
            onChange={(event) => setMsgSearch(event.target.value)}
            placeholder="Buscar nas mensagens..."
            className="h-8 text-sm bg-background"
          />
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="relative h-full min-w-0 flex-1 transition-[flex-basis,width] duration-200 ease-out">
          {ENABLE_CHAT_VIRTUALIZATION && grouped.length > 0 ? (
            <VirtualizedMessageThread
              items={grouped}
              renderItem={renderThreadItem}
              onLoadOlder={handleLoadMoreMessages}
              hasOlderMessages={hasOlderMessages}
              isLoadingOlder={isLoadingOlder || isLoadingHistory}
              scrollerRef={setScrollContainerElement}
              stickToBottomRef={stickToBottomRef}
              className="chat-thread-surface attendance-scrollbar relative z-0 h-full overflow-x-hidden pl-4 pr-7 pt-4 space-y-0.5"
              style={{
                background:
                  'radial-gradient(circle at top left, hsl(var(--primary) / 0.12) 0%, transparent 36%), linear-gradient(180deg, hsl(var(--wa-background)) 0%, hsl(var(--background)) 100%)',
              }}
              topContent={(hasOlderMessages || hasHistoryMessages) ? (
                <div className="flex justify-center py-3">
                  <button
                    type="button"
                    onClick={() => void handleLoadMoreMessages()}
                    disabled={isLoadingOlder || isLoadingHistory}
                    className="text-[11px] text-muted-foreground bg-muted/80 px-3 py-1 rounded-full shadow-sm transition hover:bg-muted disabled:cursor-wait disabled:opacity-70"
                  >
                    {loadMoreButtonLabel}
                  </button>
                </div>
              ) : null}
            />
          ) : (
          <div
          ref={scrollContainerRef}
          data-chat-overlay-boundary="true"
          className="chat-thread-surface attendance-scrollbar relative z-0 h-full overflow-y-auto overflow-x-hidden pl-4 pr-7 pt-4 pb-28 space-y-0.5"
          style={{
            background:
              'radial-gradient(circle at top left, hsl(var(--primary) / 0.12) 0%, transparent 36%), linear-gradient(180deg, hsl(var(--wa-background)) 0%, hsl(var(--background)) 100%)',
          }}
          onScroll={(event) => {
            const element = event.currentTarget;
            const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
            stickToBottomRef.current = distanceFromBottom < 120;

            if (element.scrollTop < 120) {
              void loadOlderMessages();
            }
          }}
          >
          {(hasOlderMessages || hasHistoryMessages) && (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={() => void handleLoadMoreMessages()}
                disabled={isLoadingOlder || isLoadingHistory}
                className="text-[11px] text-muted-foreground bg-muted/80 px-3 py-1 rounded-full shadow-sm transition hover:bg-muted disabled:cursor-wait disabled:opacity-70"
              >
                {loadMoreButtonLabel}
              </button>
            </div>
          )}

          {isLoadingMessages && messages.length === 0 ? (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : grouped.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-16 text-muted-foreground">
              <Clock className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">{msgSearch ? 'Nenhuma mensagem encontrada' : 'Nenhuma mensagem ainda'}</p>
            </div>
          ) : (
            grouped.map(renderThreadItem)
          )}
          <div ref={messagesEndRef} />
          </div>
          )}

          <div className="absolute inset-x-0 bottom-0 z-30 pr-3">
          <MessageInput
            value={draftValue}
            onValueChange={handleDraftValueChange}
            onSendText={handleSendText}
            onSendAudio={handleSendAudio}
            onSendDocument={handleSendDocument}
            onSendVideo={handleSendVideo}
            onSendTemplate={handleSendTemplate}
            onImageFiles={setImageFiles}
            isPending={false}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            canSendFreeText={isWithin24hWindow}
            windowStatusLabel={windowStatusLabel}
            templates={visibleTemplates}
            focusKey={conversation.id}
            onEscapeToConversationList={onClearConversation}
            onOpenQuickReplies={() => {
              setQuickReplyPanelOpen(true);
              setTavinhoPanelOpen(false);
              setTicketPanelOpen(false);
            }}
            onOpenTicket={() => {
              setTicketPanelOpen((current) => !current);
              setQuickReplyPanelOpen(false);
              setTavinhoPanelOpen(false);
            }}
            onOpenTavinho={() => {
              setTavinhoPanelOpen((current) => !current);
              setQuickReplyPanelOpen(false);
              setTicketPanelOpen(false);
            }}
            ticketOpen={ticketPanelOpen}
            tavinhoOpen={tavinhoPanelOpen}
            onOpenStartConversation={() => onOpenStartConversation?.(conversation.contact_phone || conversation.phone || '')}
            />
          </div>

          {imageFiles?.length ? (
            <ImagePreviewModal
              files={imageFiles}
              onSend={handleSendPreviewImages}
              onClose={() => setImageFiles(null)}
            />
          ) : null}
        </div>

        <div
          className={cn(
            'h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out',
            quickReplyPanelOpen ? 'w-[min(86vw,390px)]' : 'w-0'
          )}
        >
          <QuickReplySidePanel
            open={quickReplyPanelOpen}
            onClose={() => setQuickReplyPanelOpen(false)}
            onExecute={(reply) => void handleExecuteQuickReply(reply)}
            conversation={conversation}
            currentUser={currentUser}
            templates={templates}
            isWithin24hWindow={isWithin24hWindow}
          />
        </div>

        <div
          className={cn(
            'h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out',
            ticketPanelOpen ? 'w-[min(92vw,430px)]' : 'w-0'
          )}
        >
          <TicketSidePanel
            open={ticketPanelOpen}
            onClose={() => setTicketPanelOpen(false)}
            conversation={conversation}
            currentUser={currentUser}
            isWithin24hWindow={isWithin24hWindow}
            onTicketCreated={() => {
              void queryClient.invalidateQueries({ queryKey: ['conversation-tickets', conversation?.id] });
            }}
          />
        </div>

        <div
          className={cn(
            'h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out',
            tavinhoPanelOpen ? 'w-[min(92vw,461px)]' : 'w-0'
          )}
        >
          <TavinhoSidePanel
            open={tavinhoPanelOpen}
            onClose={() => setTavinhoPanelOpen(false)}
            conversation={conversation}
            messages={messages}
            isWithin24hWindow={isWithin24hWindow}
            checkoutRenewalAlert={checkoutRenewalAlert}
            onUseSuggestion={(text) => {
              handleDraftValueChange(text);
              toast.success('Sugestão do Tavinho adicionada ao campo de mensagem.');
            }}
          />
        </div>
      </div>

      <ChatMediaLightbox
        open={isLightboxOpen}
        onOpenChange={setIsLightboxOpen}
        items={lightboxItems}
        activeId={lightboxActiveId}
        onActiveIdChange={setLightboxActiveId}
      />

      <Dialog open={resolveDialogOpen} onOpenChange={setResolveDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Encerrar atendimento</DialogTitle>
            <DialogDescription>
              Escolha como este atendimento deve ser encerrado.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setResolveType('resolved')}
              className={cn(
                'w-full rounded-xl border px-4 py-3 text-left transition-colors',
                resolveType === 'resolved' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
              )}
            >
              <p className="text-sm font-medium text-foreground">Resolvido</p>
              <p className="text-xs text-muted-foreground">Finaliza o atendimento com sucesso.</p>
            </button>

            <button
              type="button"
              onClick={() => setResolveType('lack_of_interaction')}
              className={cn(
                'w-full rounded-xl border px-4 py-3 text-left transition-colors',
                resolveType === 'lack_of_interaction'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/40'
              )}
            >
              <p className="text-sm font-medium text-foreground">Falta de interação</p>
              <p className="text-xs text-muted-foreground">Fecha o atendimento por ausência de resposta do cliente.</p>
            </button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveDialogOpen(false)} disabled={isResolvingConversation}>
              Cancelar
            </Button>
            <Button onClick={() => void handleResolveConversation()} disabled={isResolvingConversation}>
              {isResolvingConversation ? 'Encerrando...' : 'Confirmar encerramento'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={transferDialogOpen}
        onOpenChange={(open) => {
          setTransferDialogOpen(open);
          if (!open) {
            setTransferUserId('');
            setTransferServiceId('');
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Transferência</DialogTitle>
            <DialogDescription>
              Escolha se o atendimento vai para um agente online ou para a fila de outro serviço.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <i className="fa-regular fa-user text-[13px] text-muted-foreground" aria-hidden="true" />
              Transferir para agente
            </div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="transfer-user">
              Usuário disponível
            </label>
            <select
              id="transfer-user"
              value={transferUserId}
              onChange={(event) => setTransferUserId(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              disabled={isTransferringConversation}
            >
              <option value="">Selecione um usuário</option>
              {transferUsers.map((user) => (
                <option key={user.id || user.email} value={user.id || user.email}>
                  {user.full_name || user.name || user.email || user.id}
                </option>
              ))}
            </select>
            {transferUsers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nenhum usuário ativo disponível para este serviço no momento.
              </p>
            ) : null}
          </div>

          <div className="mt-3 space-y-2 rounded-md border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <i className="fa-solid fa-building-user text-[13px] text-muted-foreground" aria-hidden="true" />
              Transferir para serviço
            </div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="transfer-service">
              Serviço de destino
            </label>
            <select
              id="transfer-service"
              value={transferServiceId}
              onChange={(event) => setTransferServiceId(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              disabled={isTransferringConversation}
            >
              <option value="">Selecione um serviço</option>
              {transferServices.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
            {transferServices.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nenhum outro serviço com etiqueta padrão configurada.
              </p>
            ) : null}
          </div>

          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleSendConversationToQueue()}
              disabled={isTransferringConversation}
            >
              Enviar para fila atual
            </Button>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setTransferDialogOpen(false)}
                disabled={isTransferringConversation}
              >
                Cancelar
              </Button>
              <Button
                variant="secondary"
                onClick={() => void handleTransferConversationToService()}
                disabled={!transferServiceId || isTransferringConversation}
              >
                {isTransferringConversation ? 'Transferindo...' : 'Transferir para serviço'}
              </Button>
              <Button
                onClick={() => void handleTransferConversation()}
                disabled={!transferUserId || isTransferringConversation}
              >
                {isTransferringConversation ? 'Transferindo...' : 'Transferir para agente'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
