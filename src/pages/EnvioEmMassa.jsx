import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Search,
  Send,
  ShieldCheck,
  Tags,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import PageHeader from '@/components/layout/PageHeader';
import PageSectionCard from '@/components/layout/PageSectionCard';
import PageShell from '@/components/layout/PageShell';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/AuthContext';
import { buildCustomerRows, isOpenConversation } from '@/lib/customer-base';
import { fetchPersistedCustomers } from '@/lib/customer-sync-api';
import { fetchLocalHsms, uploadHsmMedia } from '@/lib/hsm-api';
import { enrichConversationsWithLabels, getLabelBadgeStyle, SYSTEM_LABELS, useLabelCatalog } from '@/lib/labels';
import { CONVERSATION_BACKGROUND_SUMMARY_LIMIT, CONVERSATION_REFRESH_INTERVAL_MS } from '@/lib/performance-config';
import { createQuickReplySchedule } from '@/lib/quick-reply-schedules';
import { getQuickReplyActions, getQuickReplyPreviewText, listQuickReplies } from '@/lib/quick-replies';
import { cn } from '@/lib/utils';
import {
  fetchWhatsappConversations,
  sendWhatsappAudioMessage,
  sendWhatsappDocumentMessage,
  sendWhatsappImageMessage,
  sendWhatsappInteractiveMessage,
  sendWhatsappTemplateMessage,
  sendWhatsappTextMessage,
  sendWhatsappVideoMessage,
} from '@/lib/whatsapp-api';
import {
  buildPreviewFromTemplate,
  getTemplateBody,
  getTemplateButtons,
  getTemplateLanguage,
  getTemplateName,
  interpolateValue,
  isTemplateSendable,
} from '@/components/routines/utils';

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 300, 400];

const LABEL_ID_ALIASES = Object.freeze({
  'label-lead': ['system-lead'],
  'system-lead': ['label-lead'],
  'label-sql': ['system-sql'],
  'system-sql': ['label-sql'],
  'label-customer': ['system-cliente'],
  'system-cliente': ['label-customer'],
  'label-churn': ['system-cancelados'],
  'system-cancelados': ['label-churn'],
});

const LEGACY_LABEL_ID_TO_CANONICAL = Object.freeze({
  'label-lead': 'system-lead',
  'label-sql': 'system-sql',
  'label-customer': 'system-cliente',
  'label-churn': 'system-cancelados',
});

const SYSTEM_LABEL_IDS = new Set(SYSTEM_LABELS.map((label) => label.id));
const SORTABLE_COLUMNS = [
  { key: 'customer', label: 'Cliente' },
  { key: 'label', label: 'Etiqueta' },
  { key: 'phone', label: 'Telefone' },
  { key: 'lastInteraction', label: 'Última interação' },
  { key: 'window', label: 'Janela 24h' },
  { key: 'conversation', label: 'Conversa' },
];
const SORT_COLLATOR = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

const DEFAULT_FILTERS = {
  search: '',
  labelId: 'all',
  window: 'all',
  conversation: 'all',
};

const MASS_SEND_DELAY_MS = 5000;
const MASS_SEND_BATCH_SIZE = 20;
const MASS_SEND_BATCH_PAUSE_MS = 30000;
const MASS_SEND_AUDIT_STORAGE_KEY = 'saastv:mass-send:audit:v1';
const MAX_AUDIT_ENTRIES = 20;
const DEFAULT_HSM_ROUTE_SELECTOR = Object.freeze({ routeKey: 'default' });
const VARIABLE_SHORTCUTS = ['{#nome}', '{#telefone}', '{#usuario}', '{#plano}', '{#vencimento}', '{#data_hoje}'];

const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const normalizePhoneForDisplay = (value) => {
  const digits = normalizePhone(value);
  if (!digits) return '';
  if (digits.length === 13 && digits.startsWith('55')) return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  if (digits.length === 12 && digits.startsWith('55')) return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
  return digits;
};
const normalizeSearch = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const normalizeStringArray = (value) =>
  Array.from(new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean)));

const canonicalizeLabelId = (value) => {
  const safeId = String(value || '').trim();
  return LEGACY_LABEL_ID_TO_CANONICAL[safeId] || safeId;
};

const expandLabelIds = (value) =>
  Array.from(
    new Set(
      normalizeStringArray(value).flatMap((labelId) => {
        const canonicalLabelId = canonicalizeLabelId(labelId);
        return [canonicalLabelId, labelId, ...(LABEL_ID_ALIASES[labelId] || []), ...(LABEL_ID_ALIASES[canonicalLabelId] || [])];
      })
    )
  );

const isSystemLabelId = (value) => SYSTEM_LABEL_IDS.has(canonicalizeLabelId(value));

const compareText = (left, right) => SORT_COLLATOR.compare(String(left || ''), String(right || ''));

const getCustomerSortValue = (customer, key) => {
  if (key === 'customer') {
    return String(customer?.name || customer?.username || '').trim();
  }

  if (key === 'label') {
    return (Array.isArray(customer?.labels) ? customer.labels : [])
      .map((label) => String(label?.name || '').trim())
      .filter(Boolean)
      .join(' ');
  }

  if (key === 'phone') {
    return normalizePhone(customer?.phoneDigits || customer?.whatsapp);
  }

  if (key === 'lastInteraction') {
    const timestamp = Date.parse(String(customer?.lastClientInteractionAt || ''));
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (key === 'window') {
    return customer?.window24h === 'inside' ? 0 : 1;
  }

  if (key === 'conversation') {
    return customer?.conversationOpen ? Number(customer?.conversationCount || 1) : 0;
  }

  return '';
};

const compareCustomerSortValues = (left, right, key) => {
  const leftValue = getCustomerSortValue(left, key);
  const rightValue = getCustomerSortValue(right, key);
  const leftEmpty = leftValue === null || leftValue === undefined || String(leftValue).trim() === '';
  const rightEmpty = rightValue === null || rightValue === undefined || String(rightValue).trim() === '';

  if (leftEmpty && rightEmpty) return 0;
  if (leftEmpty) return 1;
  if (rightEmpty) return -1;

  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
    return leftValue === rightValue ? 0 : leftValue - rightValue;
  }

  return compareText(leftValue, rightValue);
};

const formatDateTime = (value) => {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(timestamp));
};

const formatRelativeTime = (value) => {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return '-';

  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
};

const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const toDateTime = (date, time) => new Date(`${date}T${time || '00:00'}:00`);

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const stripDataUrlPrefix = (dataUrl = '') => {
  const value = String(dataUrl || '');
  return value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
};

const extractDataUrlMimeType = (dataUrl = '') =>
  String(dataUrl || '').match(/^data:([^;]+);base64,/i)?.[1]?.toLowerCase() || '';

const safeTemplate = (template) => (template && typeof template === 'object' ? template : {});

const getTemplateId = (template = {}) => {
  const source = safeTemplate(template);
  return String(source.id || source.code || `${getTemplateName(source)}::${getTemplateLanguage(source)}`).trim();
};

const getHeaderKind = (template = {}) => {
  const source = safeTemplate(template);
  const type = String(source.headerType || '').trim().toLowerCase();
  const format = String(source.headerFormat || '').trim().toLowerCase();
  return type || format || 'none';
};

const isMediaHeaderKind = (template = {}) => ['image', 'video', 'document'].includes(getHeaderKind(template));

const getTemplateHeaderMediaValue = (template = {}) =>
  String(template?.headerMediaUrl || template?.headerExample || template?.headerValue || '').trim();

const getHeaderMediaAccept = (template = {}) => {
  const kind = getHeaderKind(template);
  if (kind === 'image') return 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
  if (kind === 'video') return 'video/mp4,video/3gpp,.mp4,.3gp';
  if (kind === 'document') return 'application/pdf,.pdf';
  return 'image/jpeg,image/png,image/webp,video/mp4,video/3gpp,.jpg,.jpeg,.png,.webp,.mp4,.3gp';
};

const getConfiguredVariableValue = (configured = [], index) => {
  const item = Array.isArray(configured) ? configured[index - 1] : null;
  if (item == null) return '';
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  return String(item.value || item.example || item.defaultValue || item.text || item.key || '').trim();
};

const buildInitialHsmVariables = (template, bodyIndexes = [], headerIndexes = [], buttonIndexes = []) => ({
  body: Object.fromEntries(bodyIndexes.map((index) => [index, getConfiguredVariableValue(template?.bodyVariables, index)])),
  header: Object.fromEntries(headerIndexes.map((index) => [index, getConfiguredVariableValue(template?.headerVariables, index)])),
  buttons: Object.fromEntries(buttonIndexes.map((index) => [index, getConfiguredVariableValue(template?.buttonVariables, index)])),
});

const extractVariableIndexes = (text, configured = []) => {
  const indexes = new Set();
  (Array.isArray(configured) ? configured : []).forEach((_, index) => indexes.add(index + 1));
  String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, index) => {
    indexes.add(Number(index));
    return '';
  });
  return Array.from(indexes).filter(Boolean).sort((left, right) => left - right);
};

const getButtonVariableIndexes = (template = {}) => {
  const source = safeTemplate(template);
  const buttonText = getTemplateButtons(source)
    .map((button) => [button.url, button.phoneNumber, button.offerCode].filter(Boolean).join(' '))
    .join('\n');
  return extractVariableIndexes(buttonText, source.buttonVariables);
};

const getCustomerWindowReference = (customer) => {
  const conversations = Array.isArray(customer?.sourceConversations) ? customer.sourceConversations : [];
  const candidates = conversations
    .map((conversation) => ({
      value:
        conversation?.last_client_message_time ||
        conversation?.last_received_at ||
        conversation?.sourceConversation?.lastClientMessageTime ||
        conversation?.sourceConversation?.last_received_at ||
        '',
      forcedInside: Boolean(conversation?.is_within_customer_window),
      isOpen:
        typeof conversation?.is24hWindowOpen === 'boolean'
          ? conversation.is24hWindowOpen
          : Boolean(conversation?.is_within_customer_window),
      expiresAt: conversation?.windowExpiresAt || conversation?.last_24h_window_expires_at || '',
    }))
    .filter((item) => item.value || item.forcedInside)
    .sort((left, right) => (Date.parse(right.value || '') || 0) - (Date.parse(left.value || '') || 0));

  const latest = candidates[0] || null;
  return {
    timestamp: latest?.value || '',
    within24h: Boolean(latest?.isOpen || latest?.forcedInside),
    expiresAt: latest?.expiresAt || '',
  };
};

const getCustomerLabels = (customer, labelCatalog = []) => {
  const labelsByKey = new Map();
  const rawLabelIds = new Set();
  let primarySystemLabel = null;
  const labelsById = new Map(
    (Array.isArray(labelCatalog) ? labelCatalog : [])
      .filter((label) => label?.id && label?.name)
      .map((label) => [String(label.id), label])
  );

  (Array.isArray(customer?.sourceConversations) ? customer.sourceConversations : []).forEach((conversation) => {
    const labels = [
      ...(Array.isArray(conversation?.visible_labels) ? conversation.visible_labels : []),
      ...(Array.isArray(conversation?.custom_labels) ? conversation.custom_labels : []),
      ...(Array.isArray(conversation?.labels) ? conversation.labels : []),
      conversation?.system_label,
      conversation?.primary_label,
    ].filter(Boolean);

    [
      ...(Array.isArray(conversation?.label_ids) ? conversation.label_ids : []),
      ...(Array.isArray(conversation?.labelIds) ? conversation.labelIds : []),
    ].forEach((labelId) => {
      expandLabelIds([labelId]).forEach((expandedId) => rawLabelIds.add(expandedId));
      const catalogLabel = labelsById.get(canonicalizeLabelId(labelId)) || labelsById.get(String(labelId || '').trim());
      if (catalogLabel) labels.push(catalogLabel);
    });

    labels.forEach((label) => {
      const id = String(label?.id || '').trim();
      const name = String(label?.name || '').trim();
      if (!id || !name) return;

      const canonicalId = canonicalizeLabelId(id);
      const isSystemLabel = SYSTEM_LABEL_IDS.has(canonicalId) || label.kind === 'system';
      const normalizedLabel = isSystemLabel ? labelsById.get(canonicalId) || { ...label, id: canonicalId } : label;

      if (isSystemLabel) {
        if (!primarySystemLabel || label === conversation?.system_label || label === conversation?.primary_label) {
          primarySystemLabel = normalizedLabel;
        }
        return;
      }

      rawLabelIds.add(id);

      const key = normalizeSearch(name) || id;
      const current = labelsByKey.get(key);
      if (!current) {
        labelsByKey.set(key, label);
      }
    });
  });

  const sanitizedLabelIds = Array.from(rawLabelIds).filter((labelId) => !isSystemLabelId(labelId));
  if (primarySystemLabel?.id) {
    expandLabelIds([primarySystemLabel.id]).forEach((labelId) => sanitizedLabelIds.push(labelId));
  }

  return {
    labels: [primarySystemLabel, ...Array.from(labelsByKey.values())].filter(Boolean),
    labelIds: Array.from(new Set(sanitizedLabelIds)),
  };
};

const getInitials = (value) => {
  const words = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '--';
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase();
};

const buildPhoneLookupKeys = (value) => {
  const digits = normalizePhone(value);
  if (!digits) return [];
  const keys = new Set([digits]);
  if (digits.startsWith('55') && digits.length > 11) keys.add(digits.slice(2));
  if (digits.length >= 11) keys.add(digits.slice(-11));
  if (digits.length >= 10) keys.add(digits.slice(-10));
  return Array.from(keys);
};

const resolveConversationPhone = (conversation = {}) =>
  normalizePhone(
    conversation.contact_phone ||
      conversation.phone ||
      conversation.whatsapp ||
      conversation.wa_id ||
      conversation.waId ||
      conversation.customer?.phone ||
      conversation.customer?.whatsapp ||
      ''
  );

const resolveConversationName = (conversation = {}) =>
  String(
    conversation.contact_name ||
      conversation.customer_name ||
      conversation.name ||
      conversation.push_name ||
      conversation.customer?.name ||
      conversation.customer?.display_name ||
      conversation.customer?.username ||
      resolveConversationPhone(conversation) ||
      'Contato sem nome'
  ).trim();

const buildMassCustomerRows = (customers, conversations, labelCatalog = []) => {
  const customerRows = buildCustomerRows(customers, conversations).map((customer) => {
    const windowInfo = getCustomerWindowReference(customer);
    const { labels, labelIds } = getCustomerLabels(customer, labelCatalog);
    return {
      ...customer,
      initials: getInitials(customer.name || customer.username),
      labels,
      labelIds,
      window24h: windowInfo.within24h ? 'inside' : 'outside',
      lastClientInteractionAt: windowInfo.timestamp,
      windowExpiresAt: windowInfo.expiresAt,
    };
  });

  const knownCustomerPhoneKeys = new Set();
  customerRows.forEach((customer) => {
    buildPhoneLookupKeys(customer.phoneDigits || customer.whatsapp).forEach((key) => knownCustomerPhoneKeys.add(key));
  });

  const orphanConversations = [];
  (Array.isArray(conversations) ? conversations : []).forEach((conversation) => {
    const phoneDigits = resolveConversationPhone(conversation);
    if (!phoneDigits) return;
    const matchesCustomer = buildPhoneLookupKeys(phoneDigits).some((key) => knownCustomerPhoneKeys.has(key));
    if (matchesCustomer) return;
    orphanConversations.push(conversation);
  });

  const orphanRows = orphanConversations.map((conversation, index) => {
    const phoneDigits = resolveConversationPhone(conversation);
    const name = resolveConversationName(conversation);
    const windowInfo = getCustomerWindowReference({ sourceConversations: [conversation] });
    const { labels, labelIds } = getCustomerLabels({ sourceConversations: [conversation] }, labelCatalog);
    return {
      id: `conversation-${conversation.id || phoneDigits || index + 1}`,
      customerId: null,
      syncKey: '',
      name,
      username: conversation.customer?.username || phoneDigits || `contato-${index + 1}`,
      whatsapp: conversation.contact_phone || conversation.phone || conversation.whatsapp || phoneDigits,
      phoneDigits,
      reseller: '-',
      planName: '-',
      isTest: false,
      connections: 0,
      dueDate: null,
      dueDateLabel: '-',
      expiresAt: '',
      status: 'LEAD',
      statusLabel: 'Lead',
      statusClasses: 'border-amber-500/20 bg-amber-500/10 text-amber-700',
      conversationOpen: true,
      conversationLabel: 'Sim',
      hasOpenConversation: isOpenConversation(conversation?.status),
      conversationCount: 1,
      renewUrl: `whatsapp://${phoneDigits}`,
      playlist: `whatsapp://${phoneDigits}`,
      sourceCustomer: null,
      sourceConversations: [conversation],
      initials: getInitials(name),
      labels,
      labelIds,
      window24h: windowInfo.within24h ? 'inside' : 'outside',
      lastClientInteractionAt: windowInfo.timestamp,
      windowExpiresAt: windowInfo.expiresAt,
    };
  });

  return [...customerRows, ...orphanRows];
};

const buildCustomerSnapshot = (customer) => ({
  id: customer.customerId || customer.id,
  username: customer.username,
  display_name: customer.name,
  name: customer.name,
  whatsapp: customer.whatsapp,
  phone_digits: customer.phoneDigits,
  package: customer.planName,
  plan_name: customer.planName,
  expires_at: customer.expiresAt,
  status: customer.status,
  status_label: customer.statusLabel,
  connections: customer.connections,
  reseller: customer.reseller,
  raw: customer.sourceCustomer?.raw || {},
});

const extractManualRecipientItems = (value = '') => {
  const source = String(value || '').trim();
  if (!source) return [];

  const rawItems = source
    .split(/[\n;,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
  const fallbackItems = rawItems.length ? rawItems : [source];
  const byPhone = new Map();

  fallbackItems.forEach((item, index) => {
    const phoneMatch = item.match(/\+?\d[\d\s().-]{8,}\d/g);
    const candidates = phoneMatch?.length ? phoneMatch : [item];

    candidates.forEach((candidate) => {
      const digits = normalizePhone(candidate);
      if (digits.length < 10) return;

      const name = item
        .replace(candidate, '')
        .replace(/[-–—|:]+/g, ' ')
        .trim();
      const displayPhone = normalizePhoneForDisplay(digits);
      byPhone.set(digits, {
        id: `manual-${digits}`,
        customerId: null,
        syncKey: '',
        name: name || `Número manual ${index + 1}`,
        username: digits,
        whatsapp: displayPhone || digits,
        phoneDigits: digits,
        reseller: '-',
        planName: '-',
        isTest: false,
        connections: 0,
        dueDate: null,
        dueDateLabel: '-',
        expiresAt: '',
        status: 'MANUAL',
        statusLabel: 'Manual',
        statusClasses: 'border-blue-500/20 bg-blue-500/10 text-blue-500',
        conversationOpen: false,
        conversationLabel: 'Manual',
        hasOpenConversation: false,
        conversationCount: 0,
        renewUrl: `whatsapp://${digits}`,
        playlist: `whatsapp://${digits}`,
        sourceCustomer: null,
        sourceConversations: [],
        initials: 'NM',
        labels: [],
        labelIds: [],
        window24h: 'outside',
        lastClientInteractionAt: '',
        windowExpiresAt: '',
        isManualRecipient: true,
      });
    });
  });

  return Array.from(byPhone.values());
};

const loadMassSendAudit = () => {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MASS_SEND_AUDIT_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, MAX_AUDIT_ENTRIES) : [];
  } catch {
    return [];
  }
};

const buildAuditId = () => `mass-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;


const interpolateForCustomer = (value, customer) => interpolateValue(value, buildCustomerSnapshot(customer));

const resolveQuickReplyText = (value, customer, runtimeVariables = {}) =>
  String(value || '').replace(/\{#([^}]+)\}/g, (_, rawKey) => {
    const exact = `{#${String(rawKey || '').trim()}}`;
    if (runtimeVariables[exact] != null) return runtimeVariables[exact];
    return interpolateForCustomer(exact, customer);
  });

const resolveQuickReplyMediaPayload = (action = {}) => {
  const media = action.media || {};
  const dataUrl = String(media.dataUrl || media.base64 || '').trim();
  if (!dataUrl) return null;
  const type = String(action.type || media.kind || '').trim().toLowerCase();
  const mimeType = String(media.mimeType || media.mimetype || extractDataUrlMimeType(dataUrl) || '').trim();
  return {
    kind: ['image', 'video', 'audio', 'document'].includes(type) ? type : 'document',
    dataUrl,
    mimeType: mimeType || 'application/octet-stream',
    fileName: String(media.fileName || media.filename || 'arquivo').trim() || 'arquivo',
    caption: String(action.caption || media.caption || '').trim(),
  };
};

const resolveUraPayload = (action = {}, resolveText = (value) => value) => {
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
        id: String(option?.id || option?.value || `ura-option-${index + 1}`).slice(0, 256),
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
};

function SegmentControl({ value, options, onChange }) {
  return (
    <div className="grid h-10 grid-cols-3 overflow-hidden rounded-lg border border-input bg-background p-1">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md text-xs font-semibold transition-colors',
            value === option.value ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function StatCard({ icon: Icon, title, value, description, tone = 'primary' }) {
  const toneClasses = {
    primary: 'bg-primary/10 text-primary',
    blue: 'bg-blue-500/10 text-blue-500',
    danger: 'bg-red-500/10 text-red-500',
  };

  return (
    <PageSectionCard className="p-5">
      <div className="flex items-center gap-4">
        <div className={cn('flex h-12 w-12 items-center justify-center rounded-xl', toneClasses[tone])}>
          <Icon className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className={cn('mt-1 text-3xl font-bold text-foreground', tone === 'danger' && 'text-red-500', tone === 'primary' && 'text-primary')}>
            {value}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
    </PageSectionCard>
  );
}

function CustomerLabelBadges({ labels }) {
  if (!labels.length) {
    return <span className="text-xs text-muted-foreground">Sem etiqueta</span>;
  }

  return (
    <div className="flex max-w-[220px] flex-wrap gap-1.5">
      {labels.slice(0, 2).map((label) => (
        <Badge key={label.id} variant="outline" className="rounded-full border px-2 py-0.5 text-[11px]" style={getLabelBadgeStyle(label)}>
          {label.name}
        </Badge>
      ))}
      {labels.length > 2 ? (
        <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[11px]">
          +{labels.length - 2}
        </Badge>
      ) : null}
    </div>
  );
}

function WindowBadge({ value }) {
  const isInside = value === 'inside';
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full border px-2.5 py-0.5',
        isInside ? 'border-primary/20 bg-primary/10 text-primary' : 'border-red-500/20 bg-red-500/10 text-red-500'
      )}
    >
      {isInside ? 'Dentro' : 'Fora'}
    </Badge>
  );
}

function SortableTableHead({ columnKey, label, sortConfig, onSort, className }) {
  const isActive = sortConfig.key === columnKey;
  const directionLabel = isActive && sortConfig.direction === 'desc' ? 'decrescente' : 'crescente';
  const Icon = !isActive ? ArrowUpDown : sortConfig.direction === 'asc' ? ArrowUp : ArrowDown;

  return (
    <th className={cn('px-4 py-3 font-semibold', className)} aria-sort={isActive ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        className="group inline-flex min-h-7 items-center gap-1.5 rounded-md text-left font-semibold transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        title={`Ordenar ${label}`}
      >
        <span>{label}</span>
        <Icon className={cn('h-3.5 w-3.5', isActive ? 'text-primary' : 'text-muted-foreground/70 group-hover:text-foreground')} />
        <span className="sr-only">
          {isActive ? `Ordenado em ordem ${directionLabel}` : `Ordenar ${label} em ordem crescente`}
        </span>
      </button>
    </th>
  );
}

export default function EnvioEmMassa() {
  const queryClient = useQueryClient();
  const { effectiveUser } = useAuth();
  const { customLabels, assignments, stageAssignments } = useLabelCatalog();

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sortConfig, setSortConfig] = useState({ key: 'customer', direction: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [messageType, setMessageType] = useState('hsm');
  const [quickReplyMode, setQuickReplyMode] = useState('saved');
  const [quickReplyId, setQuickReplyId] = useState('');
  const [customQuickReplyText, setCustomQuickReplyText] = useState('');
  const [hsmTemplateId, setHsmTemplateId] = useState('');
  const [hsmVariables, setHsmVariables] = useState({ body: {}, header: {}, buttons: {} });
  const [hsmHeaderMediaValue, setHsmHeaderMediaValue] = useState('');
  const [hsmHeaderMediaUpload, setHsmHeaderMediaUpload] = useState({ loading: false, error: '' });
  const [manualRecipientsInput, setManualRecipientsInput] = useState('');
  const [executionAudit, setExecutionAudit] = useState(loadMassSendAudit);
  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [sendRows, setSendRows] = useState([]);
  const [sendState, setSendState] = useState('idle');
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(todayKey());
  const [scheduledTime, setScheduledTime] = useState('');
  const [scheduleCreating, setScheduleCreating] = useState(false);
  const controlRef = useRef({ paused: false, canceled: false });
  const hsmHeaderMediaInputRef = useRef(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(MASS_SEND_AUDIT_STORAGE_KEY, JSON.stringify(executionAudit.slice(0, MAX_AUDIT_ENTRIES)));
    } catch {
      // Auditoria local nao deve bloquear a tela de envio.
    }
  }, [executionAudit]);

  const { data: conversations = [], isLoading: isLoadingConversations } = useQuery({
    queryKey: ['conversations', 'envio-em-massa', 'summary', CONVERSATION_BACKGROUND_SUMMARY_LIMIT],
    queryFn: () => fetchWhatsappConversations({ summary: true, limit: CONVERSATION_BACKGROUND_SUMMARY_LIMIT }),
    staleTime: 10000,
    refetchInterval: CONVERSATION_REFRESH_INTERVAL_MS,
  });

  const { data: customersResponse, isLoading: isLoadingCustomers } = useQuery({
    queryKey: ['persisted-customers'],
    queryFn: fetchPersistedCustomers,
    staleTime: 60000,
    refetchInterval: 60000,
  });

  const { data: quickReplies = [] } = useQuery({
    queryKey: ['quick-replies'],
    queryFn: listQuickReplies,
    staleTime: 15000,
  });

  const { data: hsmSnapshot } = useQuery({
    queryKey: ['hsm', 'local'],
    queryFn: fetchLocalHsms,
    staleTime: 15000,
  });

  const persistedCustomers = Array.isArray(customersResponse?.rows) ? customersResponse.rows : [];
  const labelCatalog = useMemo(
    () => [...SYSTEM_LABELS, ...customLabels].filter((label) => label?.id && label?.name),
    [customLabels]
  );
  const enrichedConversations = useMemo(
    () => enrichConversationsWithLabels(conversations, buildCustomerRows(persistedCustomers, conversations), {
      customLabels,
      assignments,
      stageAssignments,
    }),
    [assignments, conversations, customLabels, persistedCustomers, stageAssignments]
  );
  const customers = useMemo(
    () => buildMassCustomerRows(persistedCustomers, enrichedConversations, labelCatalog),
    [persistedCustomers, enrichedConversations, labelCatalog]
  );
  const labelOptions = useMemo(() => {
    const grouped = new Map();

    labelCatalog.forEach((label) => {
      const id = String(label?.id || '').trim();
      const name = String(label?.name || '').trim();
      if (!id || !name) return;

      const key = normalizeSearch(name) || id;
      const current = grouped.get(key);
      const matchIds = expandLabelIds([...(current?.matchIds || []), id]);

      if (!current || label.kind === 'system') {
        grouped.set(key, { ...label, id, name, matchIds });
        return;
      }

      grouped.set(key, { ...current, matchIds });
    });

    return Array.from(grouped.values());
  }, [labelCatalog]);
  const hsmTemplates = useMemo(
    () => (Array.isArray(hsmSnapshot?.items) ? hsmSnapshot.items : []).filter(isTemplateSendable),
    [hsmSnapshot]
  );

  const selectedQuickReply = useMemo(
    () => quickReplies.find((reply) => String(reply.id) === String(quickReplyId)) || null,
    [quickReplies, quickReplyId]
  );
  const selectedTemplate = useMemo(
    () => hsmTemplates.find((template) => getTemplateId(template) === hsmTemplateId) || null,
    [hsmTemplateId, hsmTemplates]
  );

  const bodyIndexes = useMemo(
    () => extractVariableIndexes(getTemplateBody(safeTemplate(selectedTemplate)), selectedTemplate?.bodyVariables),
    [selectedTemplate]
  );
  const headerIndexes = useMemo(
    () => extractVariableIndexes(selectedTemplate?.headerText, selectedTemplate?.headerVariables),
    [selectedTemplate]
  );
  const buttonIndexes = useMemo(() => getButtonVariableIndexes(selectedTemplate), [selectedTemplate]);

  const filteredCustomers = useMemo(() => {
    const search = normalizeSearch(filters.search);

    const nextCustomers = customers.filter((customer) => {
      const matchesSearch =
        !search ||
        normalizeSearch(`${customer.name} ${customer.username} ${customer.whatsapp} ${customer.phoneDigits} ${customer.planName}`).includes(search);
      const labelFilter = labelOptions.find((label) => String(label.id) === String(filters.labelId));
      const labelFilterIds = labelFilter?.matchIds || expandLabelIds([filters.labelId]);
      const matchesLabel = filters.labelId === 'all' || labelFilterIds.some((labelId) => customer.labelIds.includes(labelId));
      const matchesWindow = filters.window === 'all' || customer.window24h === filters.window;
      const matchesConversation =
        filters.conversation === 'all' ||
        (filters.conversation === 'yes' && customer.conversationOpen) ||
        (filters.conversation === 'no' && !customer.conversationOpen);

      return matchesSearch && matchesLabel && matchesWindow && matchesConversation;
    });

    if (!sortConfig.key) {
      return nextCustomers;
    }

    const directionMultiplier = sortConfig.direction === 'desc' ? -1 : 1;
    return nextCustomers
      .map((customer, index) => ({ customer, index }))
      .sort((left, right) => {
        const result = compareCustomerSortValues(left.customer, right.customer, sortConfig.key);
        return result === 0 ? left.index - right.index : result * directionMultiplier;
      })
      .map((item) => item.customer);
  }, [customers, filters, labelOptions, sortConfig]);

  const totalPages = Math.max(1, Math.ceil(filteredCustomers.length / pageSize));
  const pageStart = (page - 1) * pageSize;
  const paginatedCustomers = filteredCustomers.slice(pageStart, pageStart + pageSize);
  const filteredIds = useMemo(() => filteredCustomers.map((customer) => customer.id), [filteredCustomers]);
  const pageIds = useMemo(() => paginatedCustomers.map((customer) => customer.id), [paginatedCustomers]);
  const selectedCustomers = useMemo(
    () => filteredCustomers.filter((customer) => selectedIds.has(customer.id)),
    [filteredCustomers, selectedIds]
  );
  const manualRecipients = useMemo(() => extractManualRecipientItems(manualRecipientsInput), [manualRecipientsInput]);
  const deliveryTargets = useMemo(() => {
    const byPhone = new Map();
    [...selectedCustomers, ...manualRecipients].forEach((customer) => {
      const phone = customer.phoneDigits || normalizePhone(customer.whatsapp);
      if (!phone || byPhone.has(phone)) return;
      byPhone.set(phone, customer);
    });
    return Array.from(byPhone.values());
  }, [manualRecipients, selectedCustomers]);
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));

  const selectedInside = deliveryTargets.filter((customer) => customer.window24h === 'inside').length;
  const selectedOutside = deliveryTargets.filter((customer) => customer.window24h === 'outside').length;
  const totalInside = filteredCustomers.filter((customer) => customer.window24h === 'inside').length;
  const totalOutside = filteredCustomers.length - totalInside;
  const isLoading = isLoadingCustomers || isLoadingConversations;

  useEffect(() => {
    setPage(1);
  }, [filters, pageSize, sortConfig]);

  useEffect(() => {
    setSelectedIds((current) => new Set([...current].filter((id) => filteredIds.includes(id))));
    if (page > totalPages) setPage(totalPages);
  }, [filteredIds, page, totalPages]);

  useEffect(() => {
    if (messageType === 'quick_reply' && selectedInside === 0) {
      setMessageType('hsm');
    }
  }, [messageType, selectedInside]);

  useEffect(() => {
    if (!quickReplyId && quickReplies.length > 0) setQuickReplyId(quickReplies[0].id);
  }, [quickReplies, quickReplyId]);

  useEffect(() => {
    if (!hsmTemplateId && hsmTemplates.length > 0) setHsmTemplateId(getTemplateId(hsmTemplates[0]));
  }, [hsmTemplateId, hsmTemplates]);

  useEffect(() => {
    if (!selectedTemplate) {
      setHsmVariables({ body: {}, header: {}, buttons: {} });
      setHsmHeaderMediaValue('');
      setHsmHeaderMediaUpload({ loading: false, error: '' });
      return;
    }

    setHsmVariables(buildInitialHsmVariables(selectedTemplate, bodyIndexes, headerIndexes, buttonIndexes));
    setHsmHeaderMediaValue(isMediaHeaderKind(selectedTemplate) ? getTemplateHeaderMediaValue(selectedTemplate) : '');
    setHsmHeaderMediaUpload({ loading: false, error: '' });
  }, [bodyIndexes, buttonIndexes, headerIndexes, selectedTemplate]);

  const patchFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  const toggleSort = (key) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };
  const clearSelection = () => setSelectedIds(new Set());

  const togglePageSelection = (checked) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      pageIds.forEach((id) => {
        if (checked) next.add(id);
        else next.delete(id);
      });
      return next;
    });
  };

  const toggleCustomerSelection = (customerId, checked) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(customerId);
      else next.delete(customerId);
      return next;
    });
  };

  const addAuditEntry = (entry) => {
    setExecutionAudit((current) => [{ id: buildAuditId(), ...entry }, ...current].slice(0, MAX_AUDIT_ENTRIES));
  };

  const clearExecutionAudit = () => {
    setExecutionAudit([]);
    toast.success('Auditoria local limpa.');
  };

  const resolveActiveRouteSelector = (customer) =>
    customer?.sourceConversations?.[0]?.active_route_selector ||
    customer?.sourceConversations?.[0]?.default_route_selector ||
    null;

  const resolveDeliveryTypeForCustomer = (customer) => {
    if (messageType === 'quick_reply') return 'quick_reply';
    return customer.window24h === 'inside' ? 'quick_reply' : 'hsm';
  };

  const patchHsmVariable = (group, index, value) => {
    setHsmVariables((current) => ({
      ...current,
      [group]: {
        ...(current[group] || {}),
        [index]: value,
      },
    }));
  };

  const handleHsmHeaderMediaUpload = async (file) => {
    if (!file) return;

    setHsmHeaderMediaUpload({ loading: true, error: '' });
    try {
      const uploaded = await uploadHsmMedia(file);
      const url = String(uploaded?.url || uploaded?.mediaUrl || uploaded?.fileUrl || uploaded?.path || '').trim();
      if (!url) throw new Error('Upload concluido sem URL de midia.');
      setHsmHeaderMediaValue(url);
      toast.success('Midia do cabecalho enviada para a VPS.');
    } catch (error) {
      const message = error?.message || 'Falha ao enviar a midia do cabecalho.';
      setHsmHeaderMediaUpload({ loading: false, error: message });
      toast.error(message);
      return;
    }

    setHsmHeaderMediaUpload({ loading: false, error: '' });
  };

  const hsmParameterArrays = useMemo(() => ({
    body: bodyIndexes.map((index) => String(hsmVariables.body?.[index] || '')),
    header: headerIndexes.map((index) => String(hsmVariables.header?.[index] || '')),
    buttons: buttonIndexes.map((index) => ({ type: 'text', value: String(hsmVariables.buttons?.[index] || '') })),
  }), [bodyIndexes, buttonIndexes, headerIndexes, hsmVariables]);

  const sampleCustomer = selectedCustomers[0] || filteredCustomers[0] || {};
  const hsmPreview = useMemo(() => {
    if (!selectedTemplate) return null;
    return buildPreviewFromTemplate(
      selectedTemplate,
      {
        hsm: {
          parameterOverrides: hsmParameterArrays,
          mediaOverride: isMediaHeaderKind(selectedTemplate) && hsmHeaderMediaValue
            ? { url: interpolateForCustomer(hsmHeaderMediaValue, sampleCustomer) }
            : {},
        },
      },
      buildCustomerSnapshot(sampleCustomer)
    );
  }, [hsmHeaderMediaValue, hsmParameterArrays, sampleCustomer, selectedTemplate]);

  const selectedQuickReplyPreview = quickReplyMode === 'custom'
    ? customQuickReplyText
    : getQuickReplyPreviewText(selectedQuickReply || {});

  const validateCurrentConfiguration = () => {
    if (deliveryTargets.length === 0) return 'Selecione pelo menos um cliente ou informe um número manual.';

    if (messageType === 'quick_reply') {
      if (selectedInside === 0) return 'Resposta rápida só pode ser enviada para clientes dentro da janela de 24h.';
      if (quickReplyMode === 'custom' && !customQuickReplyText.trim()) return 'Informe a resposta rápida personalizada.';
      if (quickReplyMode === 'saved' && !selectedQuickReply) return 'Selecione uma resposta rápida configurada.';
      return '';
    }

    if (selectedInside > 0 && !selectedQuickReply) return 'Selecione a resposta rápida que será usada para clientes dentro da janela de 24h.';
    if (selectedOutside > 0 && !selectedTemplate) return 'Selecione um HSM.';
    const missingBody = selectedOutside > 0 ? bodyIndexes.find((index) => !String(hsmVariables.body?.[index] || '').trim()) : null;
    const missingHeader = selectedOutside > 0 ? headerIndexes.find((index) => !String(hsmVariables.header?.[index] || '').trim()) : null;
    const missingButton = selectedOutside > 0 ? buttonIndexes.find((index) => !String(hsmVariables.buttons?.[index] || '').trim()) : null;
    if (missingBody) return `Preencha a variável {{${missingBody}}} do corpo do HSM.`;
    if (missingHeader) return `Preencha a variável {{${missingHeader}}} do cabeçalho do HSM.`;
    if (missingButton) return `Preencha a variável {{${missingButton}}} do botão do HSM.`;
    return '';
  };

  const mediaHeaderError =
    messageType === 'hsm' && selectedOutside > 0 && selectedTemplate && isMediaHeaderKind(selectedTemplate) && !String(hsmHeaderMediaValue || '').trim()
      ? 'Preencha a midia do cabecalho do HSM.'
      : '';

  const sendQuickReplyToCustomer = async (customer, options = {}) => {
    if (customer.window24h !== 'inside') {
      throw new Error('Cliente fora da janela de 24h.');
    }
    const to = customer.phoneDigits || normalizePhone(customer.whatsapp);
    if (!to) throw new Error('Cliente sem WhatsApp válido.');

    const mode = options.mode || quickReplyMode;
    const reply = options.quickReply || selectedQuickReply;
    const routeSelector = resolveActiveRouteSelector(customer);
    const origin = options.origin || 'mass-quick-reply';

    if (mode === 'custom') {
      await sendWhatsappTextMessage({
        to,
        text: interpolateForCustomer(customQuickReplyText, customer),
        agentName: effectiveUser?.full_name || effectiveUser?.name || effectiveUser?.username || '',
        origin,
        routeSelector,
      });
      return { deliveryType: 'quick_reply', label: 'Resposta rápida personalizada' };
    }

    const actions = getQuickReplyActions(reply);
    if (!actions.length) throw new Error('Resposta rápida sem ações configuradas.');

    let runtimeVariables = {};
    for (const action of actions) {
      const waitSeconds = action.type === 'timer' || action.type === 'wait'
        ? Number(action.waitSeconds || action.nextActionDelaySeconds || 0)
        : Number(action.typingDelaySeconds || 0);
      if (waitSeconds > 0) await sleep(Math.min(300, Math.max(0, waitSeconds)) * 1000);

      if (action.type === 'timer' || action.type === 'wait') continue;
      if (action.type === 'newbr_test') {
        throw new Error('Ação NewBR não está disponível no disparo em massa.');
      }

      if (action.type === 'text') {
        const text = resolveQuickReplyText(action.content, customer, runtimeVariables);
        if (text.trim()) {
          await sendWhatsappTextMessage({ to, text, agentName: effectiveUser?.full_name || '', origin, routeSelector });
        }
      } else if (['image', 'video', 'audio', 'document'].includes(action.type)) {
        const media = resolveQuickReplyMediaPayload(action);
        if (!media?.dataUrl) throw new Error(`Ação ${action.type} sem mídia configurada.`);
        const payload = stripDataUrlPrefix(media.dataUrl);
        if (media.kind === 'image') {
          await sendWhatsappImageMessage({ to, imageBase64: payload, mimetype: media.mimeType, caption: resolveQuickReplyText(media.caption, customer, runtimeVariables), agentName: effectiveUser?.full_name || '', origin, routeSelector });
        } else if (media.kind === 'video') {
          await sendWhatsappVideoMessage({ to, videoBase64: payload, mimetype: media.mimeType, filename: media.fileName, caption: resolveQuickReplyText(media.caption, customer, runtimeVariables), agentName: effectiveUser?.full_name || '', origin, routeSelector });
        } else if (media.kind === 'audio') {
          await sendWhatsappAudioMessage({ to, audioBase64: payload, mimetype: media.mimeType, ptt: true, agentName: effectiveUser?.full_name || '', origin, routeSelector });
        } else {
          await sendWhatsappDocumentMessage({ to, documentBase64: payload, mimetype: media.mimeType, filename: media.fileName, caption: resolveQuickReplyText(media.caption, customer, runtimeVariables), agentName: effectiveUser?.full_name || '', origin, routeSelector });
        }
      } else if (action.type === 'ura') {
        const ura = resolveUraPayload(action, (text) => resolveQuickReplyText(text, customer, runtimeVariables));
        if (!ura.buttons.length) throw new Error('URA sem opções configuradas.');
        await sendWhatsappInteractiveMessage({
          to,
          text: ura.text,
          buttonText: ura.buttonText,
          buttons: ura.buttons,
          footer: ura.footer,
          agentName: effectiveUser?.full_name || '',
          origin,
          routeSelector,
        });
      } else if (action.type === 'transfer') {
        const text = resolveQuickReplyText(action.metadata?.customerMessage || '', customer, runtimeVariables);
        if (text.trim()) await sendWhatsappTextMessage({ to, text, agentName: effectiveUser?.full_name || '', origin, routeSelector });
      } else {
        throw new Error(`Ação ${action.type} não suportada no disparo em massa.`);
      }
      runtimeVariables = { ...runtimeVariables };
    }

    return { deliveryType: 'quick_reply', label: options.label || 'Resposta rápida configurada' };
  };

  const sendHsmToCustomer = async (customer) => {
    const to = customer.phoneDigits || normalizePhone(customer.whatsapp);
    if (!to) throw new Error('Cliente sem WhatsApp válido.');

    if (customer.window24h === 'inside') {
      return await sendQuickReplyToCustomer(customer, {
        mode: 'saved',
        quickReply: selectedQuickReply,
        origin: 'mass-hsm-window-quick-reply',
        label: 'Resposta rápida no lugar do HSM',
      });
    }

    if (!selectedTemplate) throw new Error('HSM não selecionado.');

    const isMediaHeader = isMediaHeaderKind(selectedTemplate);
    const headerMediaUrl = isMediaHeader ? interpolateForCustomer(hsmHeaderMediaValue, customer) : '';

    await sendWhatsappTemplateMessage({
      to,
      templateName: getTemplateName(selectedTemplate),
      language: getTemplateLanguage(selectedTemplate),
      parameters: hsmParameterArrays.body.map((value) => interpolateForCustomer(value, customer)),
      headerParameters: isMediaHeader
        ? [headerMediaUrl]
        : hsmParameterArrays.header.map((value) => interpolateForCustomer(value, customer)),
      buttonParameters: hsmParameterArrays.buttons.map((button) => ({
        ...button,
        value: interpolateForCustomer(button.value, customer),
      })),
      headerFormat: selectedTemplate.headerFormat || selectedTemplate.headerType || '',
      headerType: selectedTemplate.headerType || selectedTemplate.headerFormat || '',
      headerMediaUrl,
      previewText: hsmPreview?.body || '',
      agentName: effectiveUser?.full_name || effectiveUser?.name || effectiveUser?.username || '',
      origin: 'mass-hsm',
      routeSelector: DEFAULT_HSM_ROUTE_SELECTOR,
    });

    return { deliveryType: 'hsm', label: 'HSM pelo número Default' };
  };

  const updateSendRow = (customerId, patch) => {
    setSendRows((current) => current.map((row) => (row.customer.id === customerId ? { ...row, ...patch } : row)));
  };

  const runSendQueue = async (targets) => {
    setSendState('running');
    controlRef.current = { paused: false, canceled: false };
    const startedAt = new Date().toISOString();
    const auditRows = [];

    for (let index = 0; index < targets.length; index += 1) {
      const customer = targets[index];
      while (controlRef.current.paused && !controlRef.current.canceled) {
        setSendState('paused');
        await sleep(250);
      }

      if (controlRef.current.canceled) {
        const canceledResult = { status: 'canceled', message: 'Cancelado antes do envio.', deliveryType: resolveDeliveryTypeForCustomer(customer) };
        auditRows.push({ customer, ...canceledResult });
        updateSendRow(customer.id, canceledResult);
        continue;
      }

      const plannedDeliveryType = resolveDeliveryTypeForCustomer(customer);
      updateSendRow(customer.id, {
        status: 'sending',
        deliveryType: plannedDeliveryType,
        message: plannedDeliveryType === 'hsm' ? 'Enviando HSM pelo Default...' : 'Enviando resposta rápida...',
      });

      try {
        const result = messageType === 'quick_reply'
          ? await sendQuickReplyToCustomer(customer)
          : await sendHsmToCustomer(customer);
        const successResult = {
          status: 'success',
          deliveryType: result?.deliveryType || plannedDeliveryType,
          message: result?.label || 'Enviado com sucesso.',
        };
        auditRows.push({ customer, ...successResult });
        updateSendRow(customer.id, successResult);
      } catch (error) {
        const errorResult = {
          status: 'error',
          deliveryType: plannedDeliveryType,
          message: error?.message || 'Erro no envio.',
        };
        auditRows.push({ customer, ...errorResult });
        updateSendRow(customer.id, errorResult);
      }

      if (index < targets.length - 1) {
        await sleep(MASS_SEND_DELAY_MS);
        if ((index + 1) % MASS_SEND_BATCH_SIZE === 0) {
          await sleep(MASS_SEND_BATCH_PAUSE_MS);
        }
      }
    }

    const finishedAt = new Date().toISOString();
    const summary = auditRows.reduce(
      (acc, row) => {
        acc.total += 1;
        acc[row.status] = (acc[row.status] || 0) + 1;
        if (row.deliveryType === 'hsm') acc.hsm += 1;
        if (row.deliveryType === 'quick_reply') acc.quickReply += 1;
        if (row.customer?.isManualRecipient) acc.manual += 1;
        return acc;
      },
      { total: 0, success: 0, error: 0, canceled: 0, hsm: 0, quickReply: 0, manual: 0 }
    );

    addAuditEntry({
      kind: 'immediate',
      status: controlRef.current.canceled ? 'canceled' : summary.error > 0 ? 'partial' : 'success',
      messageType,
      startedAt,
      finishedAt,
      summary,
      rows: auditRows.slice(0, 100).map((row) => ({
        name: row.customer?.name || '',
        phone: row.customer?.phoneDigits || normalizePhone(row.customer?.whatsapp),
        status: row.status,
        deliveryType: row.deliveryType,
        message: row.message,
      })),
    });

    setSendState(controlRef.current.canceled ? 'canceled' : 'finished');
    await queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };

  const handleSendNow = () => {
    const error = validateCurrentConfiguration();
    const configurationError = error || mediaHeaderError;
    if (configurationError) {
      toast.error(configurationError);
      return;
    }

    const targets = messageType === 'quick_reply'
      ? deliveryTargets.filter((customer) => customer.window24h === 'inside')
      : deliveryTargets;

    setSendRows(targets.map((customer) => ({
      customer,
      status: 'pending',
      deliveryType: resolveDeliveryTypeForCustomer(customer),
      message: customer.isManualRecipient ? 'Número manual na fila.' : 'Na fila.',
    })));
    setSendModalOpen(true);
    void runSendQueue(targets);
  };

  const handlePause = () => {
    controlRef.current.paused = true;
    setSendState('paused');
  };

  const handleResume = () => {
    controlRef.current.paused = false;
    setSendState('running');
  };

  const handleCancelSend = () => {
    controlRef.current.canceled = true;
    controlRef.current.paused = false;
    setCancelConfirmOpen(false);
    setSendState('canceled');
  };

  const openScheduleModal = () => {
    const error = validateCurrentConfiguration();
    const configurationError = error || mediaHeaderError;
    if (configurationError) {
      toast.error(configurationError);
      return;
    }
    setScheduledDate(todayKey());
    setScheduledTime('');
    setScheduleOpen(true);
  };

  const createScheduleForCustomer = async (customer, scheduledAt) => {
    const syntheticConversationId = customer.sourceConversations?.[0]?.id || `customer-${customer.id}`;
    const deliveryType = resolveDeliveryTypeForCustomer(customer);
    const useSavedQuickReply = deliveryType === 'quick_reply' && (messageType === 'hsm' || quickReplyMode === 'saved');
    const useCustomQuickReply = deliveryType === 'quick_reply' && messageType === 'quick_reply' && quickReplyMode === 'custom';
    const hsmPayload = deliveryType === 'hsm' && selectedTemplate
      ? {
          hsmTemplateId: getTemplateId(selectedTemplate),
          hsmTemplateName: getTemplateName(selectedTemplate),
          hsmLanguage: getTemplateLanguage(selectedTemplate),
          hsmVariables: {
            body: Object.fromEntries(bodyIndexes.map((index) => [index, hsmVariables.body?.[index] || ''])),
            header: Object.fromEntries(headerIndexes.map((index) => [index, hsmVariables.header?.[index] || ''])),
            buttons: Object.fromEntries(buttonIndexes.map((index) => [index, hsmVariables.buttons?.[index] || ''])),
          },
          hsmMedia: isMediaHeaderKind(selectedTemplate) && hsmHeaderMediaValue
            ? { url: interpolateForCustomer(hsmHeaderMediaValue, customer) }
            : {},
          routeSelector: DEFAULT_HSM_ROUTE_SELECTOR,
        }
      : {};

    return await createQuickReplySchedule({
      title: `Envio em massa - ${customer.name}`,
      conversationId: syntheticConversationId,
      customerId: customer.customerId || customer.id,
      customerName: customer.name,
      customerPhone: customer.phoneDigits || customer.whatsapp,
      deliveryType,
      quickReplyId: useSavedQuickReply ? selectedQuickReply?.id || '' : '',
      quickReplySnapshot:
        useCustomQuickReply
          ? {
              id: `mass-custom-${Date.now()}`,
              title: 'Resposta personalizada do envio em massa',
              actions: [{ id: `custom-action-${Date.now()}`, type: 'text', content: customQuickReplyText }],
            }
          : useSavedQuickReply
            ? selectedQuickReply || null
            : null,
      scheduledDate,
      scheduledTime,
      scheduledAt: scheduledAt.toISOString(),
      windowExpiresAt: customer.windowExpiresAt || '',
      status: 'pending',
      ...hsmPayload,
      conversationSnapshot: {
        id: syntheticConversationId,
        contact_name: customer.name,
        contact_phone: customer.phoneDigits || customer.whatsapp,
        customer: buildCustomerSnapshot(customer),
        last_client_message_time: customer.lastClientInteractionAt || '',
        phone_number_id: deliveryType === 'hsm' ? null : customer.sourceConversations?.[0]?.phone_number_id || null,
        display_phone_number: deliveryType === 'hsm' ? null : customer.sourceConversations?.[0]?.display_phone_number || null,
        meta_route_key: deliveryType === 'hsm' ? 'default' : customer.sourceConversations?.[0]?.meta_route_key || null,
      },
      createdBy: effectiveUser?.id || effectiveUser?.email || '',
      createdByName: effectiveUser?.full_name || effectiveUser?.name || effectiveUser?.username || 'Agente',
    });
  };

  const handleCreateSchedules = async () => {
    const scheduledAt = scheduledDate && scheduledTime ? toDateTime(scheduledDate, scheduledTime) : null;
    if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
      toast.error('Informe data e hora válidas para o agendamento.');
      return;
    }
    if (scheduledAt.getTime() < Date.now() - 30000) {
      toast.error('A data e hora não podem estar no passado.');
      return;
    }

    setScheduleCreating(true);
    let success = 0;
    let failed = 0;

    const targets = messageType === 'quick_reply'
      ? deliveryTargets.filter((customer) => customer.window24h === 'inside')
      : deliveryTargets;
    const scheduleRows = [];
    for (const customer of targets) {
      try {
        await createScheduleForCustomer(customer, scheduledAt);
        success += 1;
        scheduleRows.push({ customer, status: 'success', deliveryType: resolveDeliveryTypeForCustomer(customer), message: 'Agendamento criado.' });
      } catch (error) {
        failed += 1;
        scheduleRows.push({ customer, status: 'error', deliveryType: resolveDeliveryTypeForCustomer(customer), message: error?.message || 'Falha ao criar agendamento.' });
      }
    }

    addAuditEntry({
      kind: 'scheduled',
      status: failed > 0 ? 'partial' : 'success',
      messageType,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      scheduledAt: scheduledAt.toISOString(),
      summary: {
        total: scheduleRows.length,
        success,
        error: failed,
        canceled: 0,
        hsm: scheduleRows.filter((row) => row.deliveryType === 'hsm').length,
        quickReply: scheduleRows.filter((row) => row.deliveryType === 'quick_reply').length,
        manual: scheduleRows.filter((row) => row.customer?.isManualRecipient).length,
      },
      rows: scheduleRows.slice(0, 100).map((row) => ({
        name: row.customer?.name || '',
        phone: row.customer?.phoneDigits || normalizePhone(row.customer?.whatsapp),
        status: row.status,
        deliveryType: row.deliveryType,
        message: row.message,
      })),
    });

    setScheduleCreating(false);
    setScheduleOpen(false);
    await queryClient.invalidateQueries({ queryKey: ['quick-reply-schedules'] });

    if (success > 0) toast.success(`Agendamentos criados: ${success}. Falhas: ${failed}.`);
    else toast.error('Nenhum agendamento foi criado.');
  };

  const renderVariableFields = (group, indexes, label) => {
    if (!indexes.length) return null;
    return (
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
        {indexes.map((index) => (
          <div key={`${group}-${index}`} className="grid gap-2 sm:grid-cols-[1fr_135px]">
            <Input
              value={hsmVariables[group]?.[index] || ''}
              onChange={(event) => patchHsmVariable(group, index, event.target.value)}
              placeholder={`Valor de {{${index}}}`}
              className="h-9"
            />
            <Select value="" onValueChange={(value) => patchHsmVariable(group, index, value)}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Variável" />
              </SelectTrigger>
              <SelectContent>
                {VARIABLE_SHORTCUTS.map((shortcut) => (
                  <SelectItem key={shortcut} value={shortcut}>
                    {shortcut}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
    );
  };

  const statusClasses = {
    pending: 'border-muted bg-muted/40 text-muted-foreground',
    sending: 'border-blue-500/20 bg-blue-500/10 text-blue-500',
    success: 'border-primary/20 bg-primary/10 text-primary',
    error: 'border-red-500/20 bg-red-500/10 text-red-500',
    canceled: 'border-amber-500/20 bg-amber-500/10 text-amber-600',
  };

  return (
    <PageShell>
      <PageHeader
        title="Envio em Massa"
        description="Selecione clientes reais da base sincronizada, respeite a janela de 24h e prepare disparos por resposta rápida ou HSM."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Tags} title="Etiquetas" value={labelOptions.length} description="Configuradas no catálogo" />
        <StatCard icon={Users} title="Clientes filtrados" value={filteredCustomers.length.toLocaleString('pt-BR')} description="Base sincronizada atual" tone="blue" />
        <StatCard icon={Clock3} title="Dentro da janela" value={totalInside.toLocaleString('pt-BR')} description="Com última mensagem do cliente em 24h" />
        <StatCard icon={CalendarClock} title="Fora da janela" value={totalOutside.toLocaleString('pt-BR')} description="Exigem HSM aprovado" tone="danger" />
      </div>

      <PageSectionCard className="p-4">
        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Buscar cliente</label>
            <div className="flex h-10 items-center gap-2 rounded-lg border border-input bg-background px-3">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                value={filters.search}
                onChange={(event) => patchFilter('search', event.target.value)}
                placeholder="Nome, usuário, número ou plano..."
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Etiqueta</label>
            <Select value={filters.labelId} onValueChange={(value) => patchFilter('labelId', value)}>
              <SelectTrigger className="h-10">
                <SelectValue placeholder="Etiqueta" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as etiquetas</SelectItem>
                {labelOptions.map((label) => (
                  <SelectItem key={label.id} value={label.id}>
                    {label.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Janela 24h</label>
            <SegmentControl
              value={filters.window}
              onChange={(value) => patchFilter('window', value)}
              options={[
                { value: 'all', label: 'Todos' },
                { value: 'inside', label: 'Dentro' },
                { value: 'outside', label: 'Fora' },
              ]}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Conversa</label>
            <SegmentControl
              value={filters.conversation}
              onChange={(value) => patchFilter('conversation', value)}
              options={[
                { value: 'all', label: 'Todos' },
                { value: 'yes', label: 'Sim' },
                { value: 'no', label: 'Não' },
              ]}
            />
          </div>
        </div>
      </PageSectionCard>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(360px,0.95fr)]">
        <PageSectionCard className="flex h-[680px] min-h-[680px] flex-col overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              {selectedCustomers.length} selecionados
              {isLoading ? <span className="ml-2 inline-flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Atualizando</span> : null}
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <button type="button" onClick={clearSelection} className="font-semibold text-red-400 hover:text-red-300">
                Limpar seleção
              </button>
              <span>{filteredCustomers.length.toLocaleString('pt-BR')} clientes</span>
            </div>
          </div>

          <div className="attendance-scrollbar min-h-0 flex-1 overflow-auto">
            <table className="min-w-[760px] w-full text-left">
              <thead className="sticky top-0 z-10 bg-muted text-xs uppercase tracking-[0.08em] text-muted-foreground">
                <tr>
                  <th className="w-12 px-4 py-3">
                    <Checkbox checked={pageAllSelected} onCheckedChange={(checked) => togglePageSelection(Boolean(checked))} aria-label="Selecionar clientes da página" />
                  </th>
                  {SORTABLE_COLUMNS.map((column) => (
                    <SortableTableHead
                      key={column.key}
                      columnKey={column.key}
                      label={column.label}
                      sortConfig={sortConfig}
                      onSort={toggleSort}
                    />
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {!isLoading && paginatedCustomers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      {customers.length === 0 ? 'Nenhum cliente sincronizado na base atual.' : 'Nenhum cliente encontrado para os filtros atuais.'}
                    </td>
                  </tr>
                ) : null}
                {paginatedCustomers.map((customer) => (
                  <tr key={customer.id} className="transition-colors hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <Checkbox
                        checked={selectedIds.has(customer.id)}
                        onCheckedChange={(checked) => toggleCustomerSelection(customer.id, Boolean(checked))}
                        aria-label={`Selecionar ${customer.name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                          {customer.initials}
                        </div>
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">{customer.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">@{customer.username}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <CustomerLabelBadges labels={customer.labels} />
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{customer.whatsapp}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      <div>{formatRelativeTime(customer.lastClientInteractionAt)}</div>
                      <div className="text-[11px]">{formatDateTime(customer.lastClientInteractionAt)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <WindowBadge value={customer.window24h} />
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {customer.conversationOpen ? `${customer.conversationCount} conversa(s)` : 'Não'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="shrink-0 border-t border-border bg-card px-4 py-4 text-sm text-muted-foreground">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-2">
              <span className="block">
                Mostrando {filteredCustomers.length === 0 ? 0 : pageStart + 1} a {Math.min(pageStart + pageSize, filteredCustomers.length)} de {filteredCustomers.length.toLocaleString('pt-BR')}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-[0.08em]">Clientes por pagina</span>
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    variant={pageSize === option ? 'default' : 'outline'}
                    size="sm"
                    className="h-8 min-w-12 px-3"
                    onClick={() => setPageSize(option)}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 self-start sm:self-center">
              <Button variant="outline" size="sm" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}>
                Anterior
              </Button>
              <span className="px-2">Página {page} de {totalPages}</span>
              <Button variant="outline" size="sm" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages}>
                Próxima
              </Button>
            </div>
            </div>
          </div>
        </PageSectionCard>

        <PageSectionCard className="p-5">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-primary/10 p-2 text-primary">
              <Send className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Configuração do envio</h2>
              <p className="mt-1 text-xs text-muted-foreground">Use resposta rápida para clientes dentro da janela ou HSM para qualquer selecionado.</p>
            </div>
          </div>

          <div className="mt-5 space-y-2">
            <div className="text-sm font-medium text-foreground">Tipo de mensagem</div>
            <div className="grid grid-cols-2 rounded-lg border border-input bg-background p-1">
              <button
                type="button"
                onClick={() => selectedInside > 0 && setMessageType('quick_reply')}
                disabled={selectedInside === 0}
                className={cn(
                  'rounded-md py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  messageType === 'quick_reply' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Resposta Rápida
              </button>
              <button
                type="button"
                onClick={() => setMessageType('hsm')}
                className={cn(
                  'rounded-md py-2 text-sm font-semibold transition-colors',
                  messageType === 'hsm' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                HSM
              </button>
            </div>
            {selectedInside === 0 ? (
              <p className="text-xs text-muted-foreground">Resposta rápida só aparece quando há cliente selecionado dentro da janela de 24h.</p>
            ) : null}
          </div>

          <div className="mt-5 space-y-2">
            <label className="text-sm font-medium text-foreground">Números individuais</label>
            <Textarea
              value={manualRecipientsInput}
              onChange={(event) => setManualRecipientsInput(event.target.value)}
              placeholder="Cole um número por linha. Ex: 5524999999999"
              rows={4}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{manualRecipients.length} número(s) manual(is) adicionados. Eles entram como fora da janela de 24h.</span>
              {manualRecipients.length > 0 ? (
                <button type="button" onClick={() => setManualRecipientsInput('')} className="font-semibold text-red-400 hover:text-red-300">
                  Limpar números
                </button>
              ) : null}
            </div>
          </div>

          {messageType === 'quick_reply' ? (
            <div className="mt-5 space-y-4">
              <div className="grid grid-cols-2 rounded-lg border border-input bg-background p-1">
                <button
                  type="button"
                  onClick={() => setQuickReplyMode('saved')}
                  className={cn('rounded-md py-2 text-sm font-semibold', quickReplyMode === 'saved' ? 'bg-primary/15 text-primary' : 'text-muted-foreground')}
                >
                  Configurada
                </button>
                <button
                  type="button"
                  onClick={() => setQuickReplyMode('custom')}
                  className={cn('rounded-md py-2 text-sm font-semibold', quickReplyMode === 'custom' ? 'bg-primary/15 text-primary' : 'text-muted-foreground')}
                >
                  Personalizada
                </button>
              </div>
              {quickReplyMode === 'saved' ? (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Resposta rápida</label>
                  <Select value={quickReplyId} onValueChange={setQuickReplyId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione uma resposta rápida" />
                    </SelectTrigger>
                    <SelectContent>
                      {quickReplies.map((reply) => (
                        <SelectItem key={reply.id} value={reply.id}>
                          {reply.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Resposta personalizada</label>
                  <Textarea
                    value={customQuickReplyText}
                    onChange={(event) => setCustomQuickReplyText(event.target.value)}
                    placeholder="Digite a resposta para este disparo. Variáveis como {#nome} serão preenchidas por cliente."
                    rows={6}
                  />
                </div>
              )}
              <div className="rounded-xl border border-input bg-background p-3">
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Prévia para WhatsApp</span>
                  <MessageSquare className="h-4 w-4" />
                </div>
                <div className="whitespace-pre-wrap text-sm leading-6 text-foreground">
                  {selectedQuickReplyPreview || 'Selecione ou crie uma resposta rápida.'}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">HSM</label>
                <Select value={hsmTemplateId} onValueChange={setHsmTemplateId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione um HSM aprovado" />
                  </SelectTrigger>
                  <SelectContent>
                    {hsmTemplates.map((template) => (
                      <SelectItem key={getTemplateId(template)} value={getTemplateId(template)}>
                        {getTemplateName(template)} · {getTemplateLanguage(template)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">HSM sempre sai pelo número Default, mesmo se o cliente falou por outro número.</p>
              </div>

              <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-3">
                <label className="text-sm font-medium text-foreground">Resposta rápida para quem está dentro das 24h</label>
                <Select value={quickReplyId} onValueChange={setQuickReplyId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione a resposta rápida" />
                  </SelectTrigger>
                  <SelectContent>
                    {quickReplies.map((reply) => (
                      <SelectItem key={reply.id} value={reply.id}>
                        {reply.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Ao escolher HSM, clientes dentro da janela recebem esta resposta rápida. Clientes fora recebem o HSM pelo Default.
                </p>
              </div>

              {selectedTemplate ? (
                <div className="space-y-4 rounded-xl border border-border bg-muted/15 p-3">
                  {renderVariableFields('body', bodyIndexes, 'Variáveis do corpo')}
                  {renderVariableFields('header', headerIndexes, 'Variáveis do cabeçalho')}
                  {renderVariableFields('buttons', buttonIndexes, 'Variáveis de botão')}
                  {isMediaHeaderKind(selectedTemplate) ? (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Midia do cabecalho ({getHeaderKind(selectedTemplate)})
                      </div>
                      <div className="grid gap-2 sm:grid-cols-[1fr_135px]">
                        <Input
                          value={hsmHeaderMediaValue}
                          onChange={(event) => setHsmHeaderMediaValue(event.target.value)}
                          placeholder="URL ou variavel da midia"
                          className="h-9"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 border-border bg-background text-xs text-foreground hover:bg-muted"
                          disabled={hsmHeaderMediaUpload.loading}
                          onClick={() => hsmHeaderMediaInputRef.current?.click()}
                        >
                          {hsmHeaderMediaUpload.loading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Upload className="h-3.5 w-3.5" />
                          )}
                          {hsmHeaderMediaUpload.loading ? 'Enviando' : 'Upload'}
                        </Button>
                        <input
                          ref={hsmHeaderMediaInputRef}
                          type="file"
                          className="hidden"
                          accept={getHeaderMediaAccept(selectedTemplate)}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            void handleHsmHeaderMediaUpload(file);
                            event.target.value = '';
                          }}
                        />
                      </div>
                      {hsmHeaderMediaUpload.error ? <p className="text-xs text-destructive">{hsmHeaderMediaUpload.error}</p> : null}
                      <p className="text-xs text-muted-foreground">
                        Use a midia padrao do HSM, informe uma URL ou envie uma foto/video para usar neste disparo.
                      </p>
                    </div>
                  ) : null}
                  <div className="rounded-xl border border-input bg-background p-3">
                    <div className="mb-2 text-xs text-muted-foreground">Prévia do HSM</div>
                    <div className="whitespace-pre-wrap text-sm leading-6 text-foreground">{hsmPreview?.body || getTemplateBody(selectedTemplate) || 'HSM sem corpo configurado.'}</div>
                    {hsmPreview?.footer ? <div className="mt-3 text-xs text-muted-foreground">{hsmPreview.footer}</div> : null}
                    {getHeaderKind(selectedTemplate) !== 'none' ? (
                      <div className="mt-3 text-xs text-muted-foreground">Cabeçalho: {hsmPreview?.headerText || selectedTemplate.headerText || getHeaderKind(selectedTemplate)}</div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                  Nenhum HSM aprovado/local encontrado.
                </div>
              )}
            </div>
          )}

          <div className="mt-5 rounded-xl border border-border bg-muted/20 p-4">
            <h3 className="text-sm font-semibold text-foreground">Resumo do envio</h3>
            <div className="mt-4 grid grid-cols-2 gap-4 divide-x divide-border">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-primary">
                  <CheckCircle2 className="h-4 w-4" />
                  Podem receber resposta rápida
                </div>
                <p className="mt-1 text-3xl font-bold text-primary">{selectedInside}</p>
                <p className="text-xs text-muted-foreground">Dentro da janela 24h · usam resposta rápida</p>
              </div>
              <div className="pl-4">
                <div className="flex items-center gap-2 text-xs font-medium text-red-500">
                  <CalendarClock className="h-4 w-4" />
                  Exigem HSM
                </div>
                <p className="mt-1 text-3xl font-bold text-red-500">{selectedOutside}</p>
                <p className="text-xs text-muted-foreground">Fora da janela 24h · HSM pelo Default</p>
              </div>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between">
            <span className="text-base font-semibold text-foreground">Total de destinatários</span>
            <span className="text-3xl font-bold text-foreground">{deliveryTargets.length}</span>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <Button className="h-11 text-sm font-semibold" onClick={handleSendNow} disabled={deliveryTargets.length === 0}>
              <Send className="h-4 w-4" />
              Enviar agora
            </Button>
            <Button variant="outline" className="h-11 border-border bg-card text-foreground hover:bg-muted" onClick={openScheduleModal} disabled={deliveryTargets.length === 0}>
              <CalendarClock className="h-4 w-4" />
              Agendar envio
            </Button>
          </div>

          <div className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 text-primary" />
            <span>HSM sai sempre pelo número Default. Destinatários dentro da janela recebem a resposta rápida configurada; fora da janela recebem HSM.</span>
          </div>

          <div className="mt-5 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Auditoria das execuções</h3>
                <p className="mt-1 text-xs text-muted-foreground">Últimos envios e agendamentos feitos nesta tela.</p>
              </div>
              {executionAudit.length > 0 ? (
                <Button type="button" variant="outline" size="sm" className="h-8" onClick={clearExecutionAudit}>
                  Limpar
                </Button>
              ) : null}
            </div>
            <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
              {executionAudit.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  Nenhuma execução registrada ainda.
                </div>
              ) : (
                executionAudit.slice(0, 6).map((entry) => (
                  <div key={entry.id} className="rounded-lg border border-border bg-background px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-foreground">
                        {entry.kind === 'scheduled' ? 'Agendamento' : 'Envio imediato'} · {entry.status === 'success' ? 'Concluído' : entry.status === 'partial' ? 'Parcial' : 'Cancelado'}
                      </div>
                      <div className="text-[11px] text-muted-foreground">{formatDateTime(entry.finishedAt || entry.startedAt)}</div>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                      <span>Total: {entry.summary?.total || 0}</span>
                      <span>Sucesso: {entry.summary?.success || 0}</span>
                      <span>Falhas: {entry.summary?.error || 0}</span>
                      <span>HSM: {entry.summary?.hsm || 0}</span>
                      <span>Resposta rápida: {entry.summary?.quickReply || 0}</span>
                      <span>Manuais: {entry.summary?.manual || 0}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </PageSectionCard>
      </div>

      <Dialog open={sendModalOpen} onOpenChange={setSendModalOpen}>
        <DialogContent className="max-h-[92vh] overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Envio em andamento</DialogTitle>
            <DialogDescription>Você pode fechar apenas este modal, mas mantenha a página aberta até terminar. Use pausar, retomar ou cancelar quando necessário.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-border">
            {sendRows.map((row) => (
              <div key={row.customer.id} className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{row.customer.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{row.customer.whatsapp}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{row.deliveryType === 'hsm' ? 'HSM · Default' : 'Resposta rápida'}</div>
                </div>
                <div className="flex min-w-[190px] items-center justify-end gap-2">
                  {row.status === 'sending' ? <Loader2 className="h-4 w-4 animate-spin text-blue-500" /> : null}
                  <Badge variant="outline" className={cn('rounded-full', statusClasses[row.status])}>
                    {row.status === 'pending' ? 'Na fila' : row.status === 'sending' ? 'Enviando' : row.status === 'success' ? 'Sucesso' : row.status === 'canceled' ? 'Cancelado' : 'Erro'}
                  </Badge>
                  <span className="max-w-[160px] truncate text-xs text-muted-foreground">{row.message}</span>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={() => setSendModalOpen(false)}>
              Fechar
            </Button>
            <div className="flex flex-wrap gap-2">
              {sendState === 'paused' ? (
                <Button onClick={handleResume} className="gap-2">
                  <Play className="h-4 w-4" />
                  Retomar envio
                </Button>
              ) : (
                <Button variant="outline" onClick={handlePause} disabled={!['running'].includes(sendState)} className="gap-2">
                  <Pause className="h-4 w-4" />
                  Pausar envio
                </Button>
              )}
              <Button variant="destructive" onClick={() => setCancelConfirmOpen(true)} disabled={['finished', 'canceled'].includes(sendState)} className="gap-2">
                <X className="h-4 w-4" />
                Cancelar envio
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={cancelConfirmOpen} onOpenChange={setCancelConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar envio em massa?</AlertDialogTitle>
            <AlertDialogDescription>Os clientes ainda não enviados serão cancelados. Mensagens já enviadas não podem ser desfeitas.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={handleCancelSend} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Sim, cancelar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={scheduleOpen} onOpenChange={(open) => !scheduleCreating && setScheduleOpen(open)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Agendar envio em massa</DialogTitle>
            <DialogDescription>
              O agendamento será criado para cada cliente selecionado usando a configuração atual.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
              <div className="font-medium text-foreground">{deliveryTargets.length} destinatário(s) selecionado(s)</div>
              <div className="mt-1">
                Tipo: {messageType === 'quick_reply' ? 'Resposta rápida' : 'HSM'} ·{' '}
                {messageType === 'quick_reply'
                  ? quickReplyMode === 'custom'
                    ? 'Personalizada'
                    : selectedQuickReply?.title || 'Sem resposta'
                  : selectedTemplate
                    ? getTemplateName(selectedTemplate)
                    : 'Sem HSM'}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Data</label>
                <Input type="date" min={todayKey()} value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Hora</label>
                <Input type="time" value={scheduledTime} onChange={(event) => setScheduledTime(event.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setScheduleOpen(false)} disabled={scheduleCreating}>
              Cancelar
            </Button>
            <Button onClick={handleCreateSchedules} disabled={scheduleCreating}>
              {scheduleCreating ? 'Criando...' : 'Criar agendamentos'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
