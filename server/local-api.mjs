import http from 'node:http';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readJsonBackedStore, writeJsonBackedStore } from './sql-store.js';
import {
  isWhatsappSqliteStoreEnabled,
  listWhatsappSqliteConversations,
  readWhatsappSqliteStore,
  writeWhatsappSqliteStore,
} from './whatsapp-sqlite-store.js';
import { resolveConversationLabels } from './labels-store.js';
import {
  deleteSqlAuthSessionByTokenHash,
  deleteSqlAuthSessionsByUserId,
  getSqlAuthSessionByTokenHash,
  isSqlAuthSessionStoreEnabled,
  listSqlAuthSessions,
  upsertSqlAuthSession,
  updateSqlAuthSessionLastSeen,
} from './modules/auth/session-store.js';
import {
  deleteSqlAttendancePresenceByUserId,
  getSqlAttendancePresenceByUserId,
  isSqlAttendancePresenceStoreEnabled,
  listSqlAttendancePresence,
  upsertSqlAttendancePresence,
} from './modules/attendance/presence-store.js';
import {
  claimNextAssignmentRecoveryJob,
  completeAssignmentRecoveryJob,
  enqueueAssignmentRecoveryJob,
  failAssignmentRecoveryJob,
  isAssignmentRecoveryJobStoreEnabled,
} from './modules/assignment/recovery-job-store.mjs';
import {
  handleCoreUtilityRoutes,
  handleCoreEventRoutes,
  publishLocalEvent as publishLocalEventToClients,
} from './modules/core/events-bus.js';
import {
  startRegisteredInterval,
  stopAllSchedulers,
  stopRegisteredInterval,
} from './modules/schedulers/scheduler-registry.js';
import {
  cancelRoutineDispatchJob,
  claimNextRoutineDispatchJob,
  completeRoutineDispatchJob,
  enqueueRoutineDispatchJob,
  failRoutineDispatchJob,
  hasActiveRoutineDispatchJob,
  listActiveRoutineDispatchJobs,
} from './modules/dispatch/routine-dispatch-queue.mjs';
import { attachSlowRouteLogger } from './middlewares/slow-route-logger.mjs';
import { handleCustomerReadRoutes } from './routes/customers.routes.mjs';
import { handleDashboardRoutes } from './routes/dashboard.routes.mjs';
import { createLogoutAssignmentRecoveryService } from './services/logout-assignment-recovery.service.mjs';
import { askTavinho, getTavinhoKnowledgeSummary } from './tavinho/service.mjs';
import { DEFAULT_TAVINHO_SETTINGS, normalizeTavinhoSettings } from './tavinho/settings.mjs';
import {
  finishPerfMeasure,
  logPerf,
  parsePositiveInt,
  shouldLogDuration,
  startPerfMeasure,
} from './utils/perf-log.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || '5053', 10);
const LOCAL_API_RUNTIME_ROLE = String(process.env.MAISTV_LOCAL_API_ROLE || process.env.MAISTV_RUNTIME_ROLE || '')
  .trim()
  .toLowerCase();
const IS_ROUTINE_WORKER_ROLE = ['routine-worker', 'local-routine-worker', 'dispatch-worker'].includes(LOCAL_API_RUNTIME_ROLE);
const IS_AUTH_API_ROLE = ['auth-api', 'local-auth-api'].includes(LOCAL_API_RUNTIME_ROLE);
const IS_ASSIGNMENT_WORKER_ROLE = ['assignment-worker', 'local-assignment-worker'].includes(LOCAL_API_RUNTIME_ROLE);
const LOCAL_API_HTTP_ENABLED =
  String(process.env.LOCAL_API_HTTP_ENABLED || (IS_ROUTINE_WORKER_ROLE || IS_ASSIGNMENT_WORKER_ROLE ? 'false' : 'true')).toLowerCase() !==
  'false';
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const WHATSAPP_STORE_PATH = process.env.WHATSAPP_STORE_PATH || path.join(DATA_DIR, 'whatsapp-store.json');
const PYTHON_SYNC_BRIDGE_PATH = path.join(__dirname, 'newbr-sync-bridge.py');
const execFileAsync = promisify(execFile);

const NEWBR_SYNC_BASE_URL = process.env.NEWBR_SYNC_BASE_URL || process.env.API_BASE || 'https://painel.newbr.top';
const NEWBR_SYNC_USERNAME = process.env.NEWBR_SYNC_USERNAME || process.env.NEWBR_USERNAME || '';
const NEWBR_SYNC_PASSWORD = process.env.NEWBR_SYNC_PASSWORD || process.env.NEWBR_PASSWORD || '';
const DEFAULT_NEWBR_BROWSER_SYNC_USERNAME = 'suportemaistv';
const DEFAULT_NEWBR_BROWSER_SYNC_PASSWORD = 'suporte+TV1';
const NEWBR_SYNC_PER_PAGE = Number.parseInt(process.env.NEWBR_SYNC_PER_PAGE || '100', 10);
const NEWBR_SYNC_MAX_PAGES = Number.parseInt(process.env.NEWBR_SYNC_MAX_PAGES || '500', 10);
const NEWBR_SYNC_TIMEOUT_MS = Number.parseInt(process.env.NEWBR_SYNC_TIMEOUT_MS || '60000', 10);
const OUTBOUND_API_PERF_THRESHOLD_MS = parsePositiveInt(process.env.OUTBOUND_API_PERF_THRESHOLD_MS, 1000);
const OUTBOUND_API_PERF_LOG_SENDS = String(process.env.OUTBOUND_API_PERF_LOG_SENDS || 'true').toLowerCase() !== 'false';
const LOCAL_STORE_WRITE_PERF_THRESHOLD_MS = parsePositiveInt(process.env.LOCAL_STORE_WRITE_PERF_THRESHOLD_MS, 250);
const WHATSAPP_INTERNAL_CONVERSATION_SUMMARY_LIMIT = parsePositiveInt(
  process.env.WHATSAPP_INTERNAL_CONVERSATION_SUMMARY_LIMIT,
  1000,
);
const DEFAULT_NEWBR_TEST_URL = 'https://painel.newbr.top/api/chatbot/V01pz25DdO/o231qzL4qz';
const NEWBR_TEST_URL = String(process.env.NEWBR_TEST_URL || process.env.NEWBR_URL || DEFAULT_NEWBR_TEST_URL).trim();
const NEWBR_TEST_AUTH_USER = String(process.env.NEWBR_TEST_AUTH_USER || process.env.NEWBR_AUTH_USER || '').trim();
const NEWBR_TEST_AUTH_PASS = String(process.env.NEWBR_TEST_AUTH_PASS || process.env.NEWBR_AUTH_PASS || '').trim();
const NEWBR_TEST_TIMEOUT_MS = Number.parseInt(process.env.NEWBR_TEST_TIMEOUT_MS || '30000', 10);
const NEWBR_TEST_SESSION_SCHEDULER_INTERVAL_MS = Number.parseInt(
  process.env.NEWBR_TEST_SESSION_SCHEDULER_INTERVAL_MS || '60000',
  10,
);
const NEWBR_TEST_SESSION_SCHEDULER_ENABLED = String(process.env.NEWBR_TEST_SESSION_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
const DEFAULT_CUSTOMER_AUTO_SYNC_INTERVAL_MS = Number.parseInt(
  process.env.CUSTOMER_AUTO_SYNC_INTERVAL_MS || `${60 * 60 * 1000}`,
  10,
);
const CUSTOMER_SYNC_RETRY_INTERVAL_MS = Number.parseInt(process.env.CUSTOMER_SYNC_RETRY_INTERVAL_MS || `${5 * 60 * 1000}`, 10);
const CUSTOMER_SYNC_LOG_LIMIT = Number.parseInt(process.env.CUSTOMER_SYNC_LOG_LIMIT || '60', 10);
const ROUTINE_LOG_LIMIT = Number.parseInt(process.env.ROUTINE_LOG_LIMIT || '600', 10);
const ROUTINE_LOG_FLUSH_INTERVAL_MS = parsePositiveInt(process.env.ROUTINE_LOG_FLUSH_INTERVAL_MS, 1500);
const ROUTINE_LOG_FLUSH_BATCH_SIZE = parsePositiveInt(process.env.ROUTINE_LOG_FLUSH_BATCH_SIZE, 25);
const ROUTINE_SCHEDULER_INTERVAL_MS = Number.parseInt(process.env.ROUTINE_SCHEDULER_INTERVAL_MS || '60000', 10);
const ROUTINE_DEFAULT_INTERVAL_MS = Number.parseInt(process.env.ROUTINE_DEFAULT_INTERVAL_MS || '1500', 10);
const ROUTINE_SCHEDULER_ENABLED = String(process.env.ROUTINE_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
const ROUTINE_DISPATCH_QUEUE_ENABLED = String(process.env.ROUTINE_DISPATCH_QUEUE_ENABLED || 'false').toLowerCase() === 'true';
const ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED =
  String(process.env.ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED || (IS_ROUTINE_WORKER_ROLE ? 'true' : 'false')).toLowerCase() === 'true';
const ROUTINE_DISPATCH_QUEUE_INTERVAL_MS = Math.max(
  1000,
  Number.parseInt(process.env.ROUTINE_DISPATCH_QUEUE_INTERVAL_MS || '3000', 10) || 3000,
);
const ROUTINE_DISPATCH_WORKER_ID = String(
  process.env.ROUTINE_DISPATCH_WORKER_ID || `${LOCAL_API_RUNTIME_ROLE || 'local-api'}-${process.pid}`,
).trim();
const ROUTINE_RENOVADOS_ERRADO_VALIDATION_ENABLED = ['true', '1', 'yes', 'sim'].includes(
  String(process.env.ROUTINE_RENOVADOS_ERRADO_VALIDATION_ENABLED || '').trim().toLowerCase(),
);
const ROUTINE_RENOVADOS_ERRADO_LABEL_NAME = String(process.env.ROUTINE_RENOVADOS_ERRADO_LABEL_NAME || 'RENOVADOS ERRADO').trim();
const QUICK_REPLY_SCHEDULE_INTERVAL_MS = Number.parseInt(process.env.QUICK_REPLY_SCHEDULE_INTERVAL_MS || '60000', 10);
const QUICK_REPLY_SCHEDULE_ENABLED = String(process.env.QUICK_REPLY_SCHEDULE_ENABLED || 'true').toLowerCase() !== 'false';
const ATTENDANCE_PRESENCE_TTL_MS = Number.parseInt(
  process.env.ATTENDANCE_PRESENCE_TTL_MS || `${3 * 60 * 1000}`,
  10,
);
const ATTENDANCE_PRESENCE_TTL_ENFORCED = ['true', '1', 'yes', 'sim'].includes(
  String(process.env.ATTENDANCE_PRESENCE_TTL_ENFORCED || '').trim().toLowerCase(),
);
const ASSIGNMENT_OFFLINE_REQUEUE_GRACE_MS = (() => {
  const parsed = Number.parseInt(
    process.env.ASSIGNMENT_OFFLINE_REQUEUE_GRACE_MS || `${5 * 60 * 1000}`,
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : ATTENDANCE_PRESENCE_TTL_MS;
})();
const ATTENDANCE_DISTRIBUTION_PAUSE_MS = Number.parseInt(
  process.env.ATTENDANCE_DISTRIBUTION_PAUSE_MS || `${10 * 60 * 1000}`,
  10,
);

const ATTENDANCE_DISTRIBUTION_PAUSE_REASONS = {
  lunch: 'Saida para almoco',
  end_of_shift: 'Final de Expediente',
};

const ATTENDANCE_PRESENCE_TOUCH_INTERVAL_MS = Math.max(
  15_000,
  Math.min(
    Number.parseInt(process.env.ATTENDANCE_PRESENCE_TOUCH_INTERVAL_MS || '60000', 10),
    Math.max(30_000, Math.floor(ATTENDANCE_PRESENCE_TTL_MS / 2)),
  ),
);
const AUTH_ACTIVITY_ASSIGNMENT_DRAIN_ENABLED = ['true', '1', 'yes', 'sim'].includes(
  String(process.env.AUTH_ACTIVITY_ASSIGNMENT_DRAIN_ENABLED || '').trim().toLowerCase(),
);
const AUTH_TOUCHES_ATTENDANCE_PRESENCE_ENABLED = ['true', '1', 'yes', 'sim'].includes(
  String(process.env.AUTH_TOUCHES_ATTENDANCE_PRESENCE_ENABLED || 'true').trim().toLowerCase(),
);
const AUTH_LOGOUT_ENDS_ATTENDANCE_ENABLED = ['true', '1', 'yes', 'sim'].includes(
  String(process.env.AUTH_LOGOUT_ENDS_ATTENDANCE_ENABLED || 'true').trim().toLowerCase(),
);
const ASSIGNMENT_RECOVERY_WORKER_ENABLED =
  String(process.env.ASSIGNMENT_RECOVERY_WORKER_ENABLED || (IS_ASSIGNMENT_WORKER_ROLE ? 'true' : 'false')).toLowerCase() === 'true';
const ASSIGNMENT_RECOVERY_WORKER_INTERVAL_MS = Math.max(
  1000,
  Number.parseInt(process.env.ASSIGNMENT_RECOVERY_WORKER_INTERVAL_MS || '3000', 10) || 3000,
);
const ASSIGNMENT_RECOVERY_WORKER_ID = String(
  process.env.ASSIGNMENT_RECOVERY_WORKER_ID || `${LOCAL_API_RUNTIME_ROLE || 'assignment-worker'}-${process.pid}`,
).trim();

const normalizeAttendanceDistributionPauseReason = (value) => {
  const normalized = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(ATTENDANCE_DISTRIBUTION_PAUSE_REASONS, normalized)
    ? normalized
    : 'lunch';
};
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/135.0.0.0 Safari/537.36';

const entityMap = {
  Conversation: 'conversations',
  ConversationPreference: 'conversationPreferences',
  Message: 'messages',
  QuickReply: 'quickReplies',
  QuickReplyCategory: 'quickReplyCategories',
  QuickReplySchedule: 'quickReplySchedules',
  Role: 'roles',
  Service: 'services',
  Ticket: 'tickets',
  User: 'users',
};

const CUSTOMER_SYNC_DEFAULT_STATE = {
  status: 'idle',
  lastAttemptAt: null,
  lastSyncAt: null,
  lastSuccessfulSyncAt: null,
  lastMode: null,
  currentRunStartedAt: null,
  nextScheduledAt: null,
  hasCompletedInitialSync: false,
  lastError: null,
  lastErrorCode: null,
  authErrorMessage: null,
  pagesLoaded: 0,
  totalRows: 0,
  lastPage: null,
  summary: {
    total: 0,
    active: 0,
    expired: 0,
    trials: 0,
    withWhatsapp: 0,
  },
};

const CUSTOMER_SYNC_CONTEXT_DEFAULT = {
  browserAuth: null,
};

const ROUTINES_DEFAULT_STATE = {
  items: [],
  logs: [],
  lastSchedulerRunAt: null,
};

const TICKET_STATUSES = new Set(['open', 'in_analysis', 'waiting_customer', 'resolved', 'cancelled']);
const TICKET_STATUS_RELEVANCE = ['waiting_customer', 'in_analysis', 'open'];
const TICKET_TYPES = new Set(['content_problem', 'add_content', 'activate_app']);
const TICKET_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

const normalizeTicketStatus = (value, fallback = 'open') => {
  const normalized = String(value || '').trim().toLowerCase();
  return TICKET_STATUSES.has(normalized) ? normalized : fallback;
};

const normalizeTicketType = (value, fallback = 'content_problem') => {
  const normalized = String(value || '').trim().toLowerCase();
  return TICKET_TYPES.has(normalized) ? normalized : fallback;
};

const normalizeTicketPriority = (value, fallback = 'normal') => {
  const normalized = String(value || '').trim().toLowerCase();
  return TICKET_PRIORITIES.has(normalized) ? normalized : fallback;
};

const normalizeTicketMetadata = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [String(key || '').trim(), entryValue])
      .filter(([key]) => key),
  );
};

const buildTicketMetadata = (ticket = {}) => {
  const directMetadata = normalizeTicketMetadata(ticket.metadata);
  let jsonMetadata = {};
  try {
    jsonMetadata = normalizeTicketMetadata(
      typeof ticket.metadata_json === 'string' ? JSON.parse(ticket.metadata_json || '{}') : ticket.metadata_json,
    );
  } catch {
    jsonMetadata = {};
  }

  const aliases = {
    customer_password: ticket.customer_password || ticket.customerPassword,
    customer_label: ticket.customer_label || ticket.customerLabel,
    content_name: ticket.content_name || ticket.contentName,
    problem_type: ticket.problem_type || ticket.problemType,
    app_name: ticket.app_name || ticket.appName || ticket.activation_app_name || ticket.activationAppName,
    device: ticket.device,
    period: ticket.period || ticket.time_period || ticket.timePeriod,
    requested_content_name: ticket.requested_content_name || ticket.requestedContentName,
    content_category: ticket.content_category || ticket.contentCategory,
    available_where: ticket.available_where || ticket.availableWhere,
    mac_or_device: ticket.mac_or_device || ticket.macOrDevice,
    tv_code: ticket.tv_code || ticket.tvCode,
    observation: ticket.observation,
  };

  return {
    ...jsonMetadata,
    ...Object.fromEntries(Object.entries(aliases).filter(([, value]) => value !== undefined && value !== null && value !== '')),
    ...directMetadata,
  };
};

const normalizeTicketAttachments = (value) => {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .map((attachment) => {
      if (!attachment || typeof attachment !== 'object') return null;
      const dataUrl = String(attachment.dataUrl || '').trim();
      const fileName = String(attachment.fileName || attachment.name || 'arquivo').trim() || 'arquivo';
      const mimeType = String(attachment.mimeType || attachment.mimetype || 'application/octet-stream').trim() || 'application/octet-stream';
      return {
        id: String(attachment.id || `ticket-attachment-${crypto.randomUUID()}`).trim(),
        fileName,
        mimeType,
        size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : null,
        dataUrl,
        created_at: String(attachment.created_at || attachment.createdAt || nowIso()),
      };
    })
    .filter(Boolean)
    .slice(0, 10);
};

const parseTicketMetadataJson = (ticket = {}) => {
  if (ticket.metadata && typeof ticket.metadata === 'object' && !Array.isArray(ticket.metadata)) {
    return normalizeTicketMetadata(ticket.metadata);
  }

  try {
    const parsed = JSON.parse(String(ticket.metadata_json || '{}'));
    return normalizeTicketMetadata(parsed);
  } catch {
    return {};
  }
};

const normalizeTicketForStorage = (ticket = {}, existing = null, timestamp = nowIso()) => {
  if (!ticket || typeof ticket !== 'object') return null;

  const metadata = {
    ...parseTicketMetadataJson(existing || {}),
    ...buildTicketMetadata(ticket),
  };
  const attachments = normalizeTicketAttachments(ticket.attachments || metadata.attachments);
  if (attachments.length) metadata.attachments = attachments;
  else delete metadata.attachments;

  const createdAt = String(existing?.created_at || existing?.createdAt || ticket.created_at || ticket.createdAt || timestamp);
  const status = normalizeTicketStatus(ticket.status, normalizeTicketStatus(existing?.status, 'open'));
  const isResolved = status === 'resolved';
  return {
    id: String(existing?.id || ticket.id || `ticket-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`).trim(),
    conversation_id: String(ticket.conversation_id || ticket.conversationId || existing?.conversation_id || '').trim(),
    customer_name: String(ticket.customer_name || ticket.customerName || existing?.customer_name || '').trim(),
    customer_phone: String(ticket.customer_phone || ticket.customerPhone || existing?.customer_phone || '').trim(),
    customer_username: String(ticket.customer_username || ticket.customerUsername || existing?.customer_username || '').trim(),
    type: normalizeTicketType(ticket.type, normalizeTicketType(existing?.type, 'content_problem')),
    title: String(ticket.title || existing?.title || '').trim(),
    description: String(ticket.description || existing?.description || '').trim(),
    priority: normalizeTicketPriority(ticket.priority, normalizeTicketPriority(existing?.priority, 'normal')),
    status,
    assigned_to: String(ticket.assigned_to || ticket.assignedTo || existing?.assigned_to || '').trim(),
    created_by: String(existing?.created_by || existing?.createdBy || ticket.created_by || ticket.createdBy || '').trim(),
    created_by_name: String(existing?.created_by_name || existing?.createdByName || ticket.created_by_name || ticket.createdByName || '').trim(),
    created_at: createdAt,
    updated_at: String(ticket.updated_at || ticket.updatedAt || timestamp),
    resolved_at: isResolved
      ? String(ticket.resolved_at || ticket.resolvedAt || existing?.resolved_at || timestamp)
      : status === 'cancelled'
        ? String(ticket.resolved_at || ticket.resolvedAt || existing?.resolved_at || '')
        : '',
    resolved_by: isResolved
      ? String(ticket.resolved_by || ticket.resolvedBy || existing?.resolved_by || existing?.resolvedBy || '').trim()
      : '',
    resolved_by_name: isResolved
      ? String(ticket.resolved_by_name || ticket.resolvedByName || existing?.resolved_by_name || existing?.resolvedByName || '').trim()
      : '',
    metadata_json: JSON.stringify(metadata),
    comments: Array.isArray(existing?.comments) ? existing.comments : Array.isArray(ticket.comments) ? ticket.comments : [],
  };
};

const sanitizeTicketForClient = (ticket = {}) => {
  const metadata = parseTicketMetadataJson(ticket);
  return {
    ...ticket,
    metadata,
    attachments: normalizeTicketAttachments(metadata.attachments),
    comments: Array.isArray(ticket.comments) ? ticket.comments : [],
    metadata_json: undefined,
  };
};

const getTicketMatchesConversation = (ticket, conversationId) => {
  const target = String(conversationId || '').trim();
  return target && String(ticket?.conversation_id || '').trim() === target;
};

const buildTicketConversationSummary = (tickets = []) => {
  const counts = {
    open: 0,
    in_analysis: 0,
    waiting_customer: 0,
    resolved: 0,
    cancelled: 0,
  };

  tickets.forEach((ticket) => {
    const status = normalizeTicketStatus(ticket.status);
    counts[status] = (counts[status] || 0) + 1;
  });

  const mostRelevantStatus = TICKET_STATUS_RELEVANCE.find((status) => counts[status] > 0) || null;
  return {
    total: tickets.length,
    ...counts,
    has_active_ticket: Boolean(mostRelevantStatus),
    most_relevant_status: mostRelevantStatus,
  };
};

const filterTicketsForRequest = (tickets = [], url = new URL('http://localhost')) => {
  const status = String(url.searchParams.get('status') || '').trim();
  const type = String(url.searchParams.get('type') || '').trim();
  const priority = String(url.searchParams.get('priority') || '').trim();
  const assignedTo = String(url.searchParams.get('assigned_to') || '').trim();
  const customerPhone = String(url.searchParams.get('customer_phone') || '').replace(/\D/g, '');
  const conversationId = String(url.searchParams.get('conversation_id') || '').trim();
  const createdFromMs = Date.parse(String(url.searchParams.get('created_from') || ''));
  const createdToRaw = String(url.searchParams.get('created_to') || '').trim();
  const createdToMs = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(createdToRaw) ? `${createdToRaw}T23:59:59.999` : createdToRaw);
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
  const withAttachment = String(url.searchParams.get('with_attachment') || '').trim().toLowerCase();

  return tickets.filter((ticket) => {
    if (status && normalizeTicketStatus(ticket.status) !== status) return false;
    if (type && normalizeTicketType(ticket.type) !== type) return false;
    if (priority && normalizeTicketPriority(ticket.priority) !== priority) return false;
    if (
      assignedTo &&
      ![
        ticket.assigned_to,
        ticket.assignedTo,
        ticket.created_by,
        ticket.createdBy,
        ticket.created_by_name,
        ticket.createdByName,
      ].some((value) => String(value || '') === assignedTo)
    ) return false;
    if (conversationId && String(ticket.conversation_id || '') !== conversationId) return false;
    if (customerPhone && !String(ticket.customer_phone || '').replace(/\D/g, '').includes(customerPhone)) return false;

    const createdMs = Date.parse(String(ticket.created_at || ''));
    if (Number.isFinite(createdFromMs) && (!Number.isFinite(createdMs) || createdMs < createdFromMs)) return false;
    if (Number.isFinite(createdToMs) && (!Number.isFinite(createdMs) || createdMs > createdToMs)) return false;

    if (withAttachment === 'true' || withAttachment === '1') {
      const attachments = sanitizeTicketForClient(ticket).attachments;
      if (!attachments.length) return false;
    }

    if (q) {
      const haystack = [
        ticket.id,
        ticket.title,
        ticket.description,
        ticket.customer_name,
        ticket.customer_phone,
        ticket.customer_username,
      ].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
};

const buildTicketListSummary = (tickets = [], now = new Date()) => {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  return tickets.reduce(
    (summary, ticket) => {
      const status = normalizeTicketStatus(ticket.status);
      if (status === 'open') summary.open += 1;
      if (status === 'in_analysis') summary.in_analysis += 1;
      if (status === 'waiting_customer') summary.waiting_customer += 1;
      if (status === 'resolved') {
        const resolvedMs = Date.parse(String(ticket.resolved_at || ticket.updated_at || ''));
        if (Number.isFinite(resolvedMs) && resolvedMs >= todayMs) summary.resolved_today += 1;
      }
      summary.total += 1;
      return summary;
    },
    { open: 0, in_analysis: 0, waiting_customer: 0, resolved_today: 0, total: 0 },
  );
};

const addTicketComment = (ticket, payload = {}, user = null, timestamp = nowIso()) => {
  const content = String(payload.content || payload.comment || '').trim();
  if (!content) throw new SyncError('Informe o comentario interno.', 400, 'invalid_ticket_comment');
  return {
    ...ticket,
    comments: [
      ...(Array.isArray(ticket.comments) ? ticket.comments : []),
      {
        id: `ticket-comment-${crypto.randomUUID()}`,
        content,
        created_by: String(user?.id || user?.email || payload.created_by || '').trim(),
        created_by_name: String(user?.full_name || user?.name || user?.username || payload.created_by_name || '').trim(),
        created_at: timestamp,
      },
    ],
    updated_at: timestamp,
  };
};

const addTicketAttachment = (ticket, payload = {}, timestamp = nowIso()) => {
  const attachment = normalizeTicketAttachments({
    ...payload,
    created_at: timestamp,
  })[0];
  if (!attachment?.dataUrl) throw new SyncError('Arquivo invalido para o ticket.', 400, 'invalid_ticket_attachment');

  const metadata = parseTicketMetadataJson(ticket);
  const attachments = [...normalizeTicketAttachments(metadata.attachments), attachment].slice(0, 10);
  return {
    ...ticket,
    metadata_json: JSON.stringify({ ...metadata, attachments }),
    updated_at: timestamp,
  };
};

const NOTIFICATION_SETTINGS_DEFAULT = {
  alertNewConversations: true,
  enableBrowserSound: true,
  defaultAudioName: '',
  defaultAudioDataUrl: '',
  customAudioLabelId: '',
  customAudioName: '',
  customAudioDataUrl: '',
};

const CUSTOMER_SYNC_INTERVAL_MINUTES_MIN = 15;
const CUSTOMER_SYNC_INTERVAL_MINUTES_MAX = 24 * 60;
const CUSTOMER_SYNC_SETTINGS_DEFAULT = {
  autoSyncIntervalMinutes: Math.min(
    CUSTOMER_SYNC_INTERVAL_MINUTES_MAX,
    Math.max(
      CUSTOMER_SYNC_INTERVAL_MINUTES_MIN,
      Math.round(DEFAULT_CUSTOMER_AUTO_SYNC_INTERVAL_MS / (60 * 1000)) || 60,
    ),
  ),
};

const DASHBOARD_SETTINGS_DEFAULT = {
  adKeywords: [],
  appointmentAttributionWindowDays: 7,
  newCustomerWindowDays: 30,
  templateResponseWindowDays: 3,
  templateRecoveryWindowDays: 30,
  salesGoalsByUserId: {},
};

const DASHBOARD_EVENT_LIMIT = Number.parseInt(process.env.DASHBOARD_EVENT_LIMIT || '10000', 10);
const DASHBOARD_EVENTS_DEFAULT = {
  items: [],
};

const DASHBOARD_EVENT_TYPES = new Set([
  'ad_lead',
  'trial_generated',
  'contracted',
  'followup_sent',
  'followup_response',
  'appointment_created',
  'recovered',
  'sale_started',
  'sale_finished',
  'support_started',
  'support_finished',
]);

const SCHEDULE_SETTINGS_DEFAULT = {
  hsmTemplateId: '',
  hsmTemplateName: '',
  hsmLanguage: 'pt_BR',
  hsmVariables: { body: {}, header: {}, buttons: {} },
  hsmMedia: {},
};

const LABELS_DEFAULT_STATE = {
  customLabels: [],
  assignments: {},
  stageAssignments: {},
  updatedAt: null,
};

const CHATBOT_FLOW_DEFAULT_STATE = {
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};
const CHATBOT_START_NODE_ID = 'chatbot-start';
const CHATBOT_ASSET_MAX_BYTES = Number.parseInt(process.env.CHATBOT_ASSET_MAX_BYTES || `${25 * 1024 * 1024}`, 10);
const CHATBOT_TRIGGER_FRESH_WINDOW_MS = Number.parseInt(process.env.CHATBOT_TRIGGER_FRESH_WINDOW_MS || `${10 * 60 * 1000}`, 10);
const CHATBOT_PROCESS_CACHE_TTL_MS = Number.parseInt(process.env.CHATBOT_PROCESS_CACHE_TTL_MS || '30000', 10);
const CHATBOT_PROCESS_CACHE_LIMIT = Number.parseInt(process.env.CHATBOT_PROCESS_CACHE_LIMIT || '1000', 10);
const CHATBOT_WHATSAPP_TIMEOUT_MS = Number.parseInt(process.env.CHATBOT_WHATSAPP_TIMEOUT_MS || '10000', 10);
const ROUTINE_WHATSAPP_TIMEOUT_MS = Number.parseInt(
  process.env.ROUTINE_WHATSAPP_TIMEOUT_MS || `${Math.max(CHATBOT_WHATSAPP_TIMEOUT_MS, 45000)}`,
  10,
);
const ROUTINE_CHECKOUT_TIMEOUT_MS = Number.parseInt(
  process.env.ROUTINE_CHECKOUT_TIMEOUT_MS || `${Math.max(CHATBOT_WHATSAPP_TIMEOUT_MS, 15000)}`,
  10,
);
const CHATBOT_BACKEND_RUNTIME_ENABLED = String(process.env.CHATBOT_BACKEND_RUNTIME_ENABLED || 'true').toLowerCase() !== 'false';
const CHATBOT_BACKEND_POLL_INTERVAL_MS = Number.parseInt(process.env.CHATBOT_BACKEND_POLL_INTERVAL_MS || '30000', 10);
const CHATBOT_BACKEND_MAX_CANDIDATES = Number.parseInt(process.env.CHATBOT_BACKEND_MAX_CANDIDATES || '8', 10);
const CHATBOT_FRONTEND_PROCESSING_ENABLED = String(process.env.CHATBOT_FRONTEND_PROCESSING_ENABLED || 'false').toLowerCase() === 'true';
const CHATBOT_WHATSAPP_STORE_PATH = String(
  process.env.CHATBOT_WHATSAPP_STORE_PATH || '/root/tv-assist-studio/server/data/whatsapp-store.json',
);
const CHATBOT_DEBUG = String(process.env.CHATBOT_DEBUG || '').toLowerCase() === 'true';
const WHATSAPP_API_BASE_URL = String(
  process.env.LOCAL_WHATSAPP_API_BASE_URL ||
    process.env.WHATSAPP_API_BASE_URL ||
    process.env.VITE_WHATSAPP_API_BASE_URL ||
    process.env.VITE_API_BASE_URL ||
    'http://127.0.0.1:5050',
).replace(/\/+$/, '');
const CHECKOUT_API_BASE_URL = String(
  process.env.LOCAL_CHECKOUT_API_BASE_URL ||
    process.env.CHECKOUT_API_BASE_URL ||
    process.env.VITE_CHECKOUT_API_BASE_URL ||
    process.env.VITE_API_BASE_URL ||
    'http://127.0.0.1:5051',
).replace(/\/+$/, '');
const CHECKOUT_TOKEN_API_BASE_URL = String(
  process.env.LOCAL_CHECKOUT_TOKEN_API_BASE_URL ||
    process.env.CHECKOUT_TOKEN_API_BASE_URL ||
    process.env.LOCAL_WHATSAPP_API_BASE_URL ||
    process.env.WHATSAPP_API_BASE_URL ||
    process.env.VITE_WHATSAPP_API_BASE_URL ||
    process.env.VITE_API_BASE_URL ||
    'http://127.0.0.1:5050',
).replace(/\/+$/, '');
const CHECKOUT_PUBLIC_URL = String(process.env.CHECKOUT_PUBLIC_URL || process.env.VITE_CHECKOUT_PUBLIC_URL || '').trim();

const AUTH_DEFAULT_STATE = {
  sessions: [],
  loginAttempts: {},
};

const DEFAULT_SERVICE_PHONE_NUMBER = '+55 24 99966-3511';
const DEFAULT_SERVICE_ICON_KEY = 'headphones';
const AUTH_COOKIE_NAME = 'saastv_session';
const DEFAULT_ADMIN_PASSWORD = 'admin';
const LOCAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOCAL_REMEMBER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_LOCK_BASE_MS = 60 * 1000;
const LOGIN_FAILURE_LOCK_MAX_MS = 15 * 60 * 1000;

let storeWriteQueue = Promise.resolve();
let customerSyncRunning = false;
let storeCache = null;
const chatbotProcessCache = new Map();
const chatbotProcessInFlight = new Map();
let chatbotBackendRuntimeRunning = false;
let chatbotBackendRuntimeTimer = null;
const routineInFlight = new Set();
const routineQueued = new Set();
let routineDispatchQueue = Promise.resolve();
let routineSchedulerRunning = false;
let routineSchedulerTimer = null;
let quickReplyScheduleRunning = false;
let quickReplyScheduleTimer = null;
let newbrTestSessionSchedulerRunning = false;
let newbrTestSessionSchedulerTimer = null;
const routineLogClients = new Set();

const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();

const hashToken = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const digest = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
};

const verifyPassword = (password, storedHash) => {
  const raw = String(storedHash || '').trim();
  if (!raw) return false;

  const [scheme, salt, digest] = raw.split('$');
  if (scheme !== 'scrypt' || !salt || !digest) {
    return false;
  }

  const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  const left = Buffer.from(derived, 'hex');
  const right = Buffer.from(digest, 'hex');

  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const normalizePasswordHash = (value, fallbackPassword = '') => {
  const raw = String(value || '').trim();
  if (raw.startsWith('scrypt$')) {
    return raw;
  }

  const fallback = String(fallbackPassword || '').trim();
  return fallback ? hashPassword(fallback) : '';
};

const parseCookies = (headerValue) =>
  String(headerValue || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((accumulator, entry) => {
      const separatorIndex = entry.indexOf('=');
      const key = separatorIndex >= 0 ? entry.slice(0, separatorIndex).trim() : entry.trim();
      const value = separatorIndex >= 0 ? entry.slice(separatorIndex + 1).trim() : '';
      if (key) {
        accumulator[key] = decodeURIComponent(value || '');
      }
      return accumulator;
    }, {});

const isSecureRequest = (req) =>
  Boolean(req?.socket?.encrypted) || String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase().includes('https');

const serializeCookie = (name, value, options = {}) => {
  const segments = [`${name}=${encodeURIComponent(String(value || ''))}`];

  if (options.maxAge != null) {
    segments.push(`Max-Age=${Math.max(0, Math.floor(Number(options.maxAge) || 0))}`);
  }
  if (options.expires instanceof Date) {
    segments.push(`Expires=${options.expires.toUTCString()}`);
  }

  segments.push(`Path=${options.path || '/'}`);

  if (options.httpOnly !== false) {
    segments.push('HttpOnly');
  }
  if (options.sameSite) {
    segments.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    segments.push('Secure');
  }

  return segments.join('; ');
};

const toSlug = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';

const log = (message) => {
  const timestamp = new Date().toISOString();
  console.log(`[saastv-local-api] ${timestamp} ${message}`);
};

const chatbotDebugLog = (message) => {
  if (CHATBOT_DEBUG) {
    log(`[chatbot] ${message}`);
  }
};

const normalizeBaseUrl = (url) => {
  const raw = String(url || '').trim();
  if (!raw) {
    throw new SyncError('Base URL do NewBr nao informada.', 500, 'config');
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withProtocol);
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
  } catch {
    throw new SyncError(`Base URL do NewBr invalida: ${raw}`, 500, 'config');
  }
};

const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const normalizePhoneDisplay = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return raw;
  const digits = normalizePhone(raw);
  return digits ? `+${digits}` : raw;
};

const normalizeStringArray = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );

const sameStringArrayValues = (left = [], right = []) => {
  const normalizedLeft = normalizeStringArray(left);
  const normalizedRight = normalizeStringArray(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  const rightSet = new Set(normalizedRight);
  return normalizedLeft.every((item) => rightSet.has(item));
};

const normalizeDashboardSettings = (value = {}) => {
  const source = value && typeof value === 'object' ? value : {};
  const positiveInteger = (candidate, fallback) => {
    const parsed = Number.parseInt(String(candidate ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const salesGoalsSource = source.salesGoalsByUserId && typeof source.salesGoalsByUserId === 'object'
    ? source.salesGoalsByUserId
    : {};
  const salesGoalsByUserId = Object.fromEntries(
    Object.entries(salesGoalsSource)
      .map(([key, value]) => {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        return [String(key || '').trim(), Number.isFinite(parsed) && parsed > 0 ? parsed : 0];
      })
      .filter(([key]) => key),
  );

  return {
    ...DASHBOARD_SETTINGS_DEFAULT,
    ...source,
    adKeywords: normalizeStringArray(source.adKeywords),
    appointmentAttributionWindowDays: positiveInteger(
      source.appointmentAttributionWindowDays,
      DASHBOARD_SETTINGS_DEFAULT.appointmentAttributionWindowDays,
    ),
    newCustomerWindowDays: positiveInteger(source.newCustomerWindowDays, DASHBOARD_SETTINGS_DEFAULT.newCustomerWindowDays),
    templateResponseWindowDays: positiveInteger(source.templateResponseWindowDays, DASHBOARD_SETTINGS_DEFAULT.templateResponseWindowDays),
    templateRecoveryWindowDays: positiveInteger(source.templateRecoveryWindowDays, DASHBOARD_SETTINGS_DEFAULT.templateRecoveryWindowDays),
    salesGoalsByUserId,
    updatedAt: source.updatedAt ? String(source.updatedAt) : null,
  };
};

const normalizeDashboardEventType = (value) => {
  const type = String(value || '').trim().toLowerCase();
  return DASHBOARD_EVENT_TYPES.has(type) ? type : 'ad_lead';
};

const normalizeDashboardEvent = (event = {}, index = 0) => {
  const timestamp = nowIso();
  const type = normalizeDashboardEventType(event?.type);
  const id = String(event?.id || `dashboard-event-${Date.now().toString(36)}-${index}`).trim();
  const metadata = event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata
    : {};

  return {
    id,
    type,
    createdAt: String(event?.createdAt || event?.created_at || event?.timestamp || timestamp),
    phone: normalizePhone(event?.phone || event?.customerPhone || event?.whatsapp || ''),
    customerId: String(event?.customerId || event?.customer_id || '').trim(),
    conversationId: String(event?.conversationId || event?.conversation_id || '').trim(),
    adId: String(event?.adId || event?.ad_id || '').trim(),
    adName: String(event?.adName || event?.ad_name || event?.campaignName || event?.campaign_name || '').trim(),
    campaignName: String(event?.campaignName || event?.campaign_name || '').trim(),
    templateId: String(event?.templateId || event?.template_id || '').trim(),
    templateName: String(event?.templateName || event?.template_name || '').trim(),
    routineId: String(event?.routineId || event?.routine_id || '').trim(),
    routineName: String(event?.routineName || event?.routine_name || '').trim(),
    agentId: String(event?.agentId || event?.agent_id || '').trim(),
    agentName: String(event?.agentName || event?.agent_name || '').trim(),
    value: Number(event?.value || 0) || 0,
    cost: Number(event?.cost || 0) || 0,
    metadata,
    importedAt: String(event?.importedAt || event?.imported_at || timestamp),
  };
};

const normalizeDashboardEventsState = (value = {}) => {
  const source = value && typeof value === 'object' ? value : {};
  const limit = Number.isFinite(DASHBOARD_EVENT_LIMIT) && DASHBOARD_EVENT_LIMIT > 0 ? DASHBOARD_EVENT_LIMIT : 10000;
  const items = Array.isArray(source.items) ? source.items : Array.isArray(value) ? value : [];
  return {
    ...DASHBOARD_EVENTS_DEFAULT,
    ...source,
    items: items
      .map((item, index) => normalizeDashboardEvent(item, index))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, limit),
    updatedAt: source.updatedAt ? String(source.updatedAt) : null,
  };
};

const LEGACY_LABEL_ID_TO_CANONICAL = Object.freeze({
  'label-lead': 'system-lead',
  'label-sql': 'system-sql',
  'label-customer': 'system-cliente',
  'label-churn': 'system-cancelados',
  'system-cancelado-10': 'system-cancelados',
  'system-cancelado-20': 'system-cancelados',
  'system-cancelado-30': 'system-cancelados',
});

const SYSTEM_LABEL_METADATA_BY_ID = Object.freeze({
  'system-lead': { id: 'system-lead', name: 'Lead', color: '#F59E0B', kind: 'system' },
  'system-sql': { id: 'system-sql', name: 'SQL', color: '#0F766E', kind: 'system' },
  'system-cliente': { id: 'system-cliente', name: 'Cliente', color: '#16A34A', kind: 'system' },
  'system-pos-venda': { id: 'system-pos-venda', name: 'Pos-venda', color: '#2563EB', kind: 'system' },
  'system-cancelados': { id: 'system-cancelados', name: 'Cancelados', color: '#F97316', kind: 'system' },
});

const canonicalizeLabelId = (value) => {
  const safeId = String(value || '').trim();
  return LEGACY_LABEL_ID_TO_CANONICAL[safeId] || safeId;
};

const canonicalizeLabelIds = (value) => Array.from(new Set(normalizeStringArray(value).map(canonicalizeLabelId).filter(Boolean)));

const normalizeLabelNameKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const isLegacySystemLabelRecord = (label = {}) => {
  const safeId = String(label?.id || '').trim();
  const canonicalId = canonicalizeLabelId(safeId);
  const systemLabel = SYSTEM_LABEL_METADATA_BY_ID[canonicalId];
  return Boolean(systemLabel && canonicalId !== safeId && normalizeLabelNameKey(label?.name) === normalizeLabelNameKey(systemLabel.name));
};

const canonicalizeLabelRecord = (label = {}) => {
  const safeId = String(label?.id || '').trim();
  const canonicalId = canonicalizeLabelId(safeId);
  return SYSTEM_LABEL_METADATA_BY_ID[canonicalId] && canonicalId !== safeId
    ? { ...SYSTEM_LABEL_METADATA_BY_ID[canonicalId] }
    : label;
};

const canonicalizeLabelRecords = (labels = []) => {
  const byKey = new Map();
  (Array.isArray(labels) ? labels : []).forEach((label) => {
    const normalized = canonicalizeLabelRecord(label);
    const id = String(normalized?.id || '').trim();
    const name = String(normalized?.name || '').trim();
    if (!id || !name) return;
    byKey.set(`${id}:${normalizeLabelNameKey(name)}`, normalized);
  });
  return Array.from(byKey.values());
};

const normalizeConversationLabelFields = (conversation = {}) => {
  if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) {
    return conversation;
  }

  return {
    ...conversation,
    label_ids: canonicalizeLabelIds(conversation.label_ids || conversation.labelIds),
    labels: canonicalizeLabelRecords(conversation.labels),
    visible_labels: canonicalizeLabelRecords(conversation.visible_labels),
    custom_labels: canonicalizeLabelRecords(conversation.custom_labels).filter((label) => label?.kind !== 'system'),
  };
};

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

const expandServiceLabelIds = (value) =>
  Array.from(
    new Set(
      normalizeStringArray(value).flatMap((labelId) => {
        const canonicalLabelId = canonicalizeLabelId(labelId);
        return [canonicalLabelId, labelId, ...(LABEL_ID_ALIASES[labelId] || []), ...(LABEL_ID_ALIASES[canonicalLabelId] || [])];
      }),
    ),
  );

const resolveServiceRoutingLabelIds = (store = {}) =>
  expandServiceLabelIds(
    (Array.isArray(store.services) ? store.services : [])
      .flatMap((service) => service?.label_ids || service?.labelIds || []),
  );

const normalizeHexColor = (value, fallback = '#14B8A6') => {
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
};

const sortLabels = (labels) =>
  [...labels].sort((left, right) =>
    String(left?.name || '').localeCompare(String(right?.name || ''), 'pt-BR', {
      sensitivity: 'base',
    }),
  );

const normalizeCustomLabel = (label = {}, fallbackId = '') => {
  const timestamp = nowIso();
  const safeId = String(label.id || fallbackId || `custom-label-${Date.now().toString(36)}`).trim();

  return {
    id: safeId || `custom-label-${Date.now().toString(36)}`,
    name: String(label.name || label.title || '').trim(),
    description: String(label.description || '').trim(),
    color: normalizeHexColor(label.color || '#14B8A6'),
    kind: 'custom',
    createdAt: String(label.createdAt || timestamp),
    updatedAt: String(label.updatedAt || timestamp),
  };
};

const normalizeLabelAssignments = (assignments, customLabels = []) => {
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
    return {};
  }

  const allowedLabelIds = new Set(customLabels.map((label) => String(label?.id || '').trim()).filter(Boolean));

  return Object.entries(assignments).reduce((accumulator, [conversationId, labelIds]) => {
    const safeConversationId = String(conversationId || '').trim();
    if (!safeConversationId) {
      return accumulator;
    }

    const safeIds = Array.isArray(labelIds)
      ? Array.from(
          new Set(
            labelIds
              .map((value) => String(value || '').trim())
              .filter((value) => value && allowedLabelIds.has(value)),
          ),
        )
      : [];

    if (safeIds.length > 0) {
      accumulator[safeConversationId] = safeIds;
    }

    return accumulator;
  }, {});
};

const normalizeStageAssignments = (assignments, customLabels = []) => {
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
    return {};
  }

  const allowedLabelIds = new Set(customLabels.map((label) => String(label?.id || '').trim()).filter(Boolean));

  return Object.entries(assignments).reduce((accumulator, [conversationId, labelId]) => {
    const safeConversationId = String(conversationId || '').trim();
    const safeLabelId = String(labelId || '').trim();

    if (safeConversationId && safeLabelId && allowedLabelIds.has(safeLabelId)) {
      accumulator[safeConversationId] = safeLabelId;
    }

    return accumulator;
  }, {});
};

const normalizeLabelsState = (value) => {
  const base = value && typeof value === 'object' ? value : {};
  const customLabels = sortLabels(
    (Array.isArray(base.customLabels) ? base.customLabels : [])
      .map((label, index) => normalizeCustomLabel(label, `custom-label-${index + 1}`))
      .filter((label) => label.name && !isLegacySystemLabelRecord(label)),
  );

  return {
    ...LABELS_DEFAULT_STATE,
    customLabels,
    assignments: normalizeLabelAssignments(base.assignments, customLabels),
    stageAssignments: normalizeStageAssignments(base.stageAssignments, customLabels),
    updatedAt: base.updatedAt ? String(base.updatedAt) : null,
  };
};

const buildLabelRecordsForConversation = (labelIds = [], customLabels = []) =>
  canonicalizeLabelIds(labelIds)
    .map((labelId) => {
      const systemLabel = SYSTEM_LABEL_METADATA_BY_ID[labelId];
      if (systemLabel) return { ...systemLabel };
      const customLabel = customLabels.find((label) => String(label?.id || '').trim() === labelId);
      return customLabel ? { ...customLabel } : null;
    })
    .filter(Boolean);

const resolveConversationAssignmentKeys = (conversationId = '', conversation = {}) => {
  const keys = new Set(normalizeStringArray([conversationId, conversation?.id]));
  const phoneCandidates = normalizeStringArray([
    conversation?.contact_phone,
    conversation?.contactPhone,
    conversation?.phone,
    conversation?.customer?.phone,
    conversation?.customer?.number,
    conversation?.customer_phone,
    conversation?.customerPhone,
  ]);

  phoneCandidates.forEach((phone) => {
    const digits = normalizePhone(phone);
    if (digits) {
      keys.add(digits);
      keys.add(`agg-${digits}`);
    }
  });

  return Array.from(keys).filter(Boolean);
};

const syncServiceCustomLabelAssignments = (store = {}, conversationId = '', conversation = {}, nextLabelIds = []) => {
  const labelsState = normalizeLabelsState(store.labels);
  const customLabelIds = new Set(labelsState.customLabels.map((label) => String(label?.id || '').trim()).filter(Boolean));
  const serviceLabelIds = new Set(resolveServiceRoutingLabelIds(store));
  const nextCustomIds = canonicalizeLabelIds(nextLabelIds).filter((labelId) => customLabelIds.has(labelId));
  const assignmentKeys = resolveConversationAssignmentKeys(conversationId, conversation);

  assignmentKeys.forEach((key) => {
    const currentIds = normalizeStringArray(labelsState.assignments[key]);
    const keptIds = currentIds.filter((labelId) => !serviceLabelIds.has(canonicalizeLabelId(labelId)));
    const mergedIds = Array.from(new Set([...keptIds, ...nextCustomIds]));
    if (mergedIds.length > 0) {
      labelsState.assignments[key] = mergedIds;
    } else {
      delete labelsState.assignments[key];
    }
  });

  return {
    ...store,
    labels: {
      ...labelsState,
      updatedAt: nowIso(),
    },
  };
};

const applyServiceTransferLabels = (store = {}, conversation = {}, targetService = null, timestamp = nowIso()) => {
  if (!targetService) {
    return {
      conversation,
      labelIds: canonicalizeLabelIds(conversation.label_ids || conversation.labelIds),
      defaultLabelId: '',
    };
  }

  const targetLabelIds = canonicalizeLabelIds(targetService.label_ids || targetService.labelIds);
  const defaultLabelId = targetLabelIds[0] || '';
  if (!defaultLabelId) {
    return { error: 'Servico de destino sem etiqueta padrao configurada.' };
  }

  const serviceLabelIds = new Set(resolveServiceRoutingLabelIds(store));
  const currentLabelIds = canonicalizeLabelIds(conversation.label_ids || conversation.labelIds);
  const nextLabelIds = Array.from(
    new Set([
      ...currentLabelIds.filter((labelId) => !serviceLabelIds.has(labelId)),
      defaultLabelId,
    ]),
  );
  const labels = buildLabelRecordsForConversation(nextLabelIds, normalizeLabelsState(store.labels).customLabels);

  return {
    labelIds: nextLabelIds,
    defaultLabelId,
    conversation: {
      ...conversation,
      label_ids: nextLabelIds,
      labelIds: nextLabelIds,
      labels,
      visible_labels: labels,
      custom_labels: labels.filter((label) => label?.kind !== 'system'),
      service_label_override_id: defaultLabelId,
      service_label_override_service_id: String(targetService.id || '').trim(),
      service_label_override_at: timestamp,
    },
  };
};

const normalizeChatbotFlowState = (state = {}) => {
  const source = state && typeof state === 'object' ? state : {};
  const viewport = source.viewport && typeof source.viewport === 'object' ? source.viewport : CHATBOT_FLOW_DEFAULT_STATE.viewport;
  const sourceNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const startIndex = sourceNodes.findIndex(
    (node) => node?.id === CHATBOT_START_NODE_ID || node?.data?.componentType === 'start',
  );
  const startSource = startIndex >= 0 ? sourceNodes[startIndex] : {};
  const startNode = {
    id: CHATBOT_START_NODE_ID,
    type: 'chatbotNode',
    position: startSource.position || { x: 40, y: 120 },
    deletable: false,
    ...startSource,
    id: CHATBOT_START_NODE_ID,
    type: 'chatbotNode',
    deletable: false,
    data: {
      ...(startSource.data && typeof startSource.data === 'object' ? startSource.data : {}),
      componentType: 'start',
      name: String(startSource.data?.name || 'inicio fluxo').trim() || 'inicio fluxo',
      rule: String(startSource.data?.rule || 'contains').trim() || 'contains',
      triggerValue: String(startSource.data?.triggerValue || '').trim(),
    },
  };
  const nodes = [
    startNode,
    ...sourceNodes.filter((_, index) => index !== startIndex && sourceNodes[index]?.data?.componentType !== 'start'),
  ];
  const validNodeIds = new Set(nodes.map((node) => String(node?.id || '')).filter(Boolean));

  return {
    nodes,
    edges: (Array.isArray(source.edges) ? source.edges : []).filter(
      (edge) => validNodeIds.has(String(edge?.source || '')) && validNodeIds.has(String(edge?.target || '')),
    ),
    viewport: {
      x: Number.isFinite(Number(viewport.x)) ? Number(viewport.x) : 0,
      y: Number.isFinite(Number(viewport.y)) ? Number(viewport.y) : 0,
      zoom: Number.isFinite(Number(viewport.zoom)) ? Number(viewport.zoom) : 1,
    },
  };
};

const normalizeChatbotFlow = (flow = {}, index = 0, fallbackCode = null) => {
  const timestamp = nowIso();
  const code = Number.isFinite(Number(flow.code)) && Number(flow.code) > 0 ? Number(flow.code) : fallbackCode || index + 1;
  const state = normalizeChatbotFlowState(flow.state || flow.flow || flow);

  return {
    id: String(flow.id || `flow-${code}`).trim() || `flow-${code}`,
    code,
    name: String(flow.name || flow.title || `Flow ${code}`).trim() || `Flow ${code}`,
    active: Boolean(flow.active),
    state,
    created_date: String(flow.created_date || flow.createdAt || timestamp),
    updated_date: String(flow.updated_date || flow.updatedAt || timestamp),
  };
};

const sortChatbotFlows = (flows = []) =>
  [...flows].sort((left, right) => Number(left?.code || 0) - Number(right?.code || 0));

const normalizeChatbotFlows = (flows = []) =>
  sortChatbotFlows(
    (Array.isArray(flows) ? flows : [])
      .map((flow, index) => normalizeChatbotFlow(flow, index))
      .filter((flow) => flow.name),
  );

const getNextChatbotFlowCode = (flows = []) =>
  flows.reduce((highest, flow) => Math.max(highest, Number(flow?.code || 0)), 0) + 1;

const resolveChatbotFlowIndex = (flows = [], flowRef = '') => {
  const safeRef = decodeURIComponent(String(flowRef || '').trim());
  const codeMatch = safeRef.match(/^flow-?(\d+)$/i);
  const codeRef = codeMatch ? Number(codeMatch[1]) : Number.NaN;

  return flows.findIndex(
    (flow) =>
      String(flow?.id || '') === safeRef ||
      String(flow?.code || '') === safeRef ||
      (Number.isFinite(codeRef) && Number(flow?.code || 0) === codeRef),
  );
};

const sanitizeChatbotFlowForClient = (flow) => normalizeChatbotFlow(flow, 0);

const sanitizeChatbotFlowSummaryForClient = (flow) => {
  const normalized = normalizeChatbotFlow(flow, 0);
  return {
    id: normalized.id,
    code: normalized.code,
    name: normalized.name,
    active: normalized.active,
    created_date: normalized.created_date,
    updated_date: normalized.updated_date,
    node_count: normalized.state.nodes.length,
    edge_count: normalized.state.edges.length,
  };
};

const buildChatbotRuntimeState = (store = {}) => {
  const activeFlows = normalizeChatbotFlows(store.chatbotFlows)
    .filter((flow) => flow.active)
    .map((flow) => {
      const startNode = getNodeById(flow, CHATBOT_START_NODE_ID);
      return {
        id: flow.id,
        code: flow.code,
        name: flow.name,
        startRule: String(startNode?.data?.rule || 'contains').trim() || 'contains',
        triggerValue: String(startNode?.data?.triggerValue || '').trim(),
        updated_date: flow.updated_date,
      };
    });

  const executions = store.chatbotExecutions && typeof store.chatbotExecutions === 'object' ? store.chatbotExecutions : {};
  const sessions = executions.sessions && typeof executions.sessions === 'object' ? executions.sessions : {};
  const activeSessionConversationIds = [];
  const waitingTimerConversationIds = [];
  const awaitingUraConversationIds = [];

  Object.entries(sessions).forEach(([conversationId, session]) => {
    const safeConversationId = String(conversationId || '').trim();
    const status = String(session?.status || '').trim();
    if (!safeConversationId || !['active', 'awaiting_ura', 'waiting_timer'].includes(status)) {
      return;
    }

    activeSessionConversationIds.push(safeConversationId);
    if (status === 'waiting_timer') {
      waitingTimerConversationIds.push(safeConversationId);
    }
    if (status === 'awaiting_ura') {
      awaitingUraConversationIds.push(safeConversationId);
    }
  });

  return {
    activeFlows,
    activeSessionConversationIds,
    waitingTimerConversationIds,
    awaitingUraConversationIds,
  };
};

const normalizeChatbotText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const normalizeChatbotVariableKey = (value) =>
  String(value || '')
    .trim()
    .replace(/^\{#/, '')
    .replace(/\}$/, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

const stripDataUrlPrefix = (dataUrl = '') => {
  const raw = String(dataUrl || '');
  const commaIndex = raw.indexOf(',');
  return commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw;
};

const getApproxBase64Bytes = (base64 = '') => Math.floor((String(base64 || '').length * 3) / 4);

const resolveConversationPhone = (conversation = {}) =>
  normalizePhone(
    conversation.contact_phone ||
      conversation.phone ||
      conversation.customer?.phone ||
      conversation.customer?.whatsapp ||
      conversation.sourceConversation?.customer?.phone ||
      '',
  );

const resolveMessageKey = (conversation = {}) =>
  [
    conversation.id,
    conversation.last_message_time || conversation.last_message_at || conversation.updated_date || '',
    conversation.last_message || '',
    conversation.last_message_type || '',
  ].join('|');

const resolveChatbotProcessCacheKey = (conversation = {}) =>
  `${conversation.id || ''}|${resolveMessageKey(conversation)}`;

const pruneChatbotProcessCache = () => {
  const timestamp = Date.now();
  for (const [key, value] of chatbotProcessCache.entries()) {
    if (!value?.at || timestamp - value.at > CHATBOT_PROCESS_CACHE_TTL_MS) {
      chatbotProcessCache.delete(key);
    }
  }

  while (chatbotProcessCache.size > CHATBOT_PROCESS_CACHE_LIMIT) {
    const oldestKey = chatbotProcessCache.keys().next().value;
    chatbotProcessCache.delete(oldestKey);
  }
};

const getRouteSelectorFromConversation = (conversation = {}) => ({
  phoneNumberId: conversation.phone_number_id || conversation.phoneNumberId || conversation.customer?.phone_number_id || null,
  displayPhoneNumber: conversation.display_phone_number || conversation.displayPhoneNumber || conversation.customer?.display_phone_number || null,
  routeKey: conversation.meta_route_key || conversation.metaRouteKey || null,
});

const normalizeWhatsappConversationForChatbot = (conversation = {}) => {
  const customer = conversation.customer || {};
  const lastMessage = conversation.lastMessage || conversation.last_message || '';
  const lastMessageTime = conversation.lastMessageTime || conversation.last_message_at || conversation.updated_date || conversation.createdAt || null;
  const lastReceivedAt = conversation.last_received_at || conversation.lastClientMessageTime || null;

  return normalizeConversationLabelFields({
    id: String(conversation.id || '').trim(),
    contact_name: customer.name || conversation.contact_name || '',
    contact_phone: customer.phone || conversation.contact_phone || conversation.phone || '',
    phone_number_id: conversation.phone_number_id || conversation.phoneNumberId || customer.phone_number_id || null,
    display_phone_number: conversation.display_phone_number || conversation.displayPhoneNumber || customer.display_phone_number || null,
    meta_route_key: conversation.meta_route_key || conversation.metaRouteKey || null,
    customer,
    last_message: String(lastMessage || '').trim(),
    last_message_type: String(conversation.lastMessageType || conversation.last_message_type || conversation.messageType || 'text').trim().toLowerCase(),
    last_message_time: lastMessageTime,
    last_message_at: conversation.last_message_at || lastMessageTime,
    updated_date: lastMessageTime,
    last_received_at: lastReceivedAt,
    last_client_message_time: conversation.lastClientMessageTime || lastReceivedAt,
    last_sent_at: conversation.last_sent_at || null,
    labels: Array.isArray(conversation.labels) ? conversation.labels : [],
    visible_labels: Array.isArray(conversation.visible_labels) ? conversation.visible_labels : [],
    custom_labels: Array.isArray(conversation.custom_labels) ? conversation.custom_labels : [],
    label_ids: Array.isArray(conversation.label_ids) ? conversation.label_ids : [],
    label_names: Array.isArray(conversation.label_names) ? conversation.label_names : [],
    tags: Array.isArray(conversation.tags) ? conversation.tags : [],
    unread_count: Number.isFinite(Number(conversation.unread_count)) ? Number(conversation.unread_count) : Number(conversation.unreadCount || 0),
  });
};

const normalizeIncomingChatbotConversationPayload = (payload = {}) => {
  const rawConversation = payload.conversation && typeof payload.conversation === 'object' ? payload.conversation : {};
  const phone = payload.phone || rawConversation.phone || rawConversation.contact_phone || rawConversation.customer?.phone || '';
  const content = payload.content ?? payload.last_message ?? rawConversation.last_message ?? rawConversation.lastMessage ?? '';
  const timestamp =
    payload.timestamp ||
    payload.last_message_time ||
    rawConversation.last_message_time ||
    rawConversation.lastMessageTime ||
    rawConversation.last_received_at ||
    rawConversation.lastClientMessageTime ||
    nowIso();

  return normalizeWhatsappConversationForChatbot({
    ...rawConversation,
    id: rawConversation.id || payload.conversationId || payload.conversation_id || (phone ? `wa-${normalizePhone(phone)}` : ''),
    phone,
    customer: {
      ...(rawConversation.customer || {}),
      phone: rawConversation.customer?.phone || rawConversation.contact_phone || phone,
    },
    lastMessage: content,
    lastMessageType: payload.messageType || payload.last_message_type || rawConversation.lastMessageType || rawConversation.last_message_type || 'text',
    lastMessageTime: timestamp,
    last_message_at: rawConversation.last_message_at || timestamp,
    updated_date: rawConversation.updated_date || timestamp,
    last_received_at: rawConversation.last_received_at || rawConversation.lastClientMessageTime || timestamp,
    lastClientMessageTime: rawConversation.lastClientMessageTime || rawConversation.last_received_at || timestamp,
  });
};

const buildChatbotConversationSnapshot = (conversation = {}) => ({
  id: String(conversation.id || '').trim(),
  contact_name: conversation.contact_name || conversation.customer?.name || '',
  contact_phone: conversation.contact_phone || conversation.customer?.phone || conversation.phone || '',
  phone_number_id: conversation.phone_number_id || conversation.phoneNumberId || conversation.customer?.phone_number_id || null,
  display_phone_number: conversation.display_phone_number || conversation.displayPhoneNumber || conversation.customer?.display_phone_number || null,
  meta_route_key: conversation.meta_route_key || conversation.metaRouteKey || null,
  customer: {
    ...(conversation.customer && typeof conversation.customer === 'object' ? conversation.customer : {}),
    phone: conversation.customer?.phone || conversation.contact_phone || conversation.phone || '',
  },
  last_message: conversation.last_message || conversation.lastMessage || '',
  last_message_type: conversation.last_message_type || conversation.lastMessageType || 'text',
  last_message_time: conversation.last_message_time || conversation.lastMessageTime || conversation.updated_date || nowIso(),
  last_message_at: conversation.last_message_at || conversation.lastMessageTime || conversation.last_message_time || nowIso(),
  updated_date: conversation.updated_date || conversation.last_message_time || conversation.lastMessageTime || nowIso(),
  last_received_at: conversation.last_received_at || conversation.lastClientMessageTime || conversation.last_client_message_time || '',
  last_client_message_time: conversation.last_client_message_time || conversation.lastClientMessageTime || conversation.last_received_at || '',
  last_sent_at: conversation.last_sent_at || null,
});

const readWhatsappStoreConversationsForChatbot = async () => {
  const raw = await fs.readFile(CHATBOT_WHATSAPP_STORE_PATH, 'utf8');
  const store = JSON.parse(raw);
  return Object.values(store.conversations || {}).map(normalizeWhatsappConversationForChatbot);
};

const hasNewClientChatbotMessage = (conversation = {}) => {
  const lastMessage = String(conversation.last_message || '').trim();
  if (!conversation.id || !lastMessage) return false;

  const lastClientMessageMs = Date.parse(conversation.last_client_message_time || conversation.last_received_at || '');
  const lastSentMs = Date.parse(conversation.last_sent_at || '');
  const lastMessageMs = Date.parse(conversation.last_message_time || conversation.last_message_at || conversation.updated_date || '');

  if (!Number.isFinite(lastClientMessageMs)) return false;
  if (Number.isFinite(lastSentMs) && lastSentMs >= lastClientMessageMs) return false;
  if (Number.isFinite(lastMessageMs) && lastClientMessageMs + 2000 < lastMessageMs) return false;
  if (Date.now() - lastClientMessageMs > CHATBOT_TRIGGER_FRESH_WINDOW_MS) return false;

  return true;
};

const evaluateChatbotRule = (rule, sourceValue, expectedValue) => {
  const left = normalizeChatbotText(sourceValue);
  const right = normalizeChatbotText(expectedValue);
  if (!right) return false;

  if (rule === 'not_equal') return left !== right;
  if (rule === 'equals') return left === right;
  if (rule === 'gte' || rule === 'gt' || rule === 'lte' || rule === 'lt') {
    const leftNumber = Number(left.replace(',', '.'));
    const rightNumber = Number(right.replace(',', '.'));
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
    if (rule === 'gte') return leftNumber >= rightNumber;
    if (rule === 'gt') return leftNumber > rightNumber;
    if (rule === 'lte') return leftNumber <= rightNumber;
    return leftNumber < rightNumber;
  }
  return left.includes(right);
};

const interpolateChatbotText = (template = '', variables = {}) =>
  String(template || '').replace(/\{#([A-Za-z0-9_]+)\}/g, (_, key) => {
    const normalizedKey = normalizeChatbotVariableKey(key);
    return variables[normalizedKey] != null ? String(variables[normalizedKey]) : '';
  });

const buildDefaultChatbotVariables = (conversation = {}) => {
  const customer = conversation.customer || conversation.sourceCustomer || {};
  const source = customer.sourceCustomer || customer.raw || customer;
  return {
    usuario: String(source.usuario || source.user || source.username || source.login || source.name || customer.name || '').trim(),
    senha: String(source.senha || source.password || source.pass || '').trim(),
    plano: String(source.plano || source.plan || source.package || customer.plan || '').trim(),
    vencimento: String(source.vencimento || source.due_date || source.expiration_date || source.data_vencimento || '').trim(),
  };
};

const requestApiJson = async (baseUrl, pathName, payload = {}, options = {}) => {
  const timeoutMs = Math.max(1, Number.parseInt(String(options.timeoutMs ?? CHATBOT_WHATSAPP_TIMEOUT_MS), 10) || CHATBOT_WHATSAPP_TIMEOUT_MS);
  const debugScope = String(options.debugScope || 'api').trim() || 'api';
  const startedAt = Date.now();
  const measure = startPerfMeasure();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let responseStatus = '';
  let outcome = 'success';

  chatbotDebugLog(`${debugScope} request started path=${pathName} timeoutMs=${timeoutMs}`);
  try {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    responseStatus = response.status;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      outcome = 'error';
      const error = new Error(data?.error || `Falha na requisicao WhatsApp ${pathName}.`);
      error.status = response.status;
      error.payload = data;
      error.pathName = pathName;
      throw error;
    }
    chatbotDebugLog(`${debugScope} request finished path=${pathName} durationMs=${Date.now() - startedAt}`);
    return data;
  } catch (error) {
    outcome = error?.name === 'AbortError' ? 'timeout' : 'error';
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`Timeout na requisicao ${pathName} apos ${timeoutMs}ms.`);
      timeoutError.name = 'TimeoutError';
      timeoutError.code = 'ETIMEDOUT';
      timeoutError.isTimeout = true;
      timeoutError.status = 504;
      timeoutError.pathName = pathName;
      timeoutError.baseUrl = baseUrl;
      timeoutError.timeoutMs = timeoutMs;
      chatbotDebugLog(`${debugScope} request error path=${pathName} message=timeout`);
      throw timeoutError;
    }
    chatbotDebugLog(`${debugScope} request error path=${pathName} message=${error?.message || 'error'}`);
    if (error && typeof error === 'object') {
      error.pathName = error.pathName || pathName;
      error.baseUrl = error.baseUrl || baseUrl;
      error.timeoutMs = error.timeoutMs || timeoutMs;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    const perf = finishPerfMeasure(measure);
    const shouldLogSend = OUTBOUND_API_PERF_LOG_SENDS && /^\/api\/whatsapp\/send-/.test(String(pathName || ''));
    const shouldLogSlow = shouldLogDuration(perf.durationMs, OUTBOUND_API_PERF_THRESHOLD_MS, 1000);
    if (shouldLogSend || shouldLogSlow) {
      logPerf('outbound-api-perf', {
        source: debugScope,
        path: pathName,
        origin: payload?.origin || '',
        outcome,
        status: responseStatus || '',
        durationMs: perf.durationMs,
        timeoutMs,
        cpuUserMs: perf.cpuUserMs,
        cpuSystemMs: perf.cpuSystemMs,
        rssMb: perf.rssMb,
        heapUsedMb: perf.heapUsedMb,
      }, { level: shouldLogSlow || outcome !== 'success' ? 'warn' : 'info' });
    }
  }
};

const requestWhatsappApiJson = async (pathName, payload = {}, options = {}) => {
  return requestApiJson(WHATSAPP_API_BASE_URL, pathName, payload, {
    debugScope: 'whatsapp',
    timeoutMs: CHATBOT_WHATSAPP_TIMEOUT_MS,
    ...options,
  });
};

const requestCheckoutApiJson = (pathName, payload = {}, options = {}) =>
  requestApiJson(CHECKOUT_API_BASE_URL, pathName, payload, {
    debugScope: 'checkout',
    timeoutMs: ROUTINE_CHECKOUT_TIMEOUT_MS,
    ...options,
  });

const requestCheckoutApiGetJson = async (pathName, options = {}) => {
  const timeoutMs = Math.max(1, Number.parseInt(String(options.timeoutMs ?? ROUTINE_CHECKOUT_TIMEOUT_MS), 10) || ROUTINE_CHECKOUT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${CHECKOUT_API_BASE_URL}${pathName}`, {
      method: 'GET',
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error || `Falha na requisicao checkout ${pathName}.`);
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
};

const requestCheckoutTokenApiJson = (pathName, payload = {}, options = {}) =>
  requestApiJson(CHECKOUT_TOKEN_API_BASE_URL, pathName, payload, {
    debugScope: 'checkout-token',
    timeoutMs: ROUTINE_CHECKOUT_TIMEOUT_MS,
    ...options,
  });

const requestWhatsappApiGetJson = async (pathName) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHATBOT_WHATSAPP_TIMEOUT_MS);
  try {
    const response = await fetch(`${WHATSAPP_API_BASE_URL}${pathName}`, {
      method: 'GET',
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error || `Falha na requisicao WhatsApp ${pathName}.`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
};

const readDashboardAttendanceConversations = async (store = {}) => {
  const persisted = [];
  if (isWhatsappSqliteStoreEnabled()) {
    let sqlitePage = 1;
    let sqliteHasMore = true;

    while (sqliteHasMore) {
      const pageData = await listWhatsappSqliteConversations({
        page: sqlitePage,
        limit: 1000,
        fallbackLoader: loadLegacyWhatsappStore,
      }).catch(() => null);
      const items = Array.isArray(pageData?.items) ? pageData.items : [];
      persisted.push(...items);
      sqliteHasMore = Boolean(pageData?.hasMore) && items.length > 0;
      sqlitePage += 1;
    }
  }

  const remote = [];
  let page = 1;
  let hasMore = persisted.length === 0;

  while (hasMore) {
    const data = await requestWhatsappApiGetJson(`/api/whatsapp/conversations?summary=1&page=${page}&limit=1000`).catch(() => null);
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    remote.push(...items);
    hasMore = Boolean(data?.hasMore) && items.length > 0;
    page += 1;
  }

  const local = Array.isArray(store?.conversations) ? store.conversations : [];
  const byId = new Map();
  [...local, ...remote, ...persisted].forEach((conversation) => {
    const normalized = normalizeWhatsappConversationForChatbot(conversation);
    const key = String(normalized.id || normalized.contact_phone || '').trim();
    if (key) byId.set(key, normalized);
  });
  return Array.from(byId.values());
};

const sendChatbotText = (conversation, text) =>
  requestWhatsappApiJson('/api/whatsapp/send-text', {
    to: resolveConversationPhone(conversation),
    text,
    origin: 'chatbot',
    agentName: 'Bot',
    ...getRouteSelectorFromConversation(conversation),
  });

const sendChatbotMedia = async (conversation, nodeData, variables) => {
  const asset = nodeData.headerAsset || {};
  const basePayload = {
    to: resolveConversationPhone(conversation),
    mimetype: asset.mimeType || 'application/octet-stream',
    caption: interpolateChatbotText(nodeData.text || '', variables),
    origin: 'chatbot',
    agentName: 'Bot',
    ...getRouteSelectorFromConversation(conversation),
  };

  if (nodeData.headerType === 'image') {
    const imageBase64 = stripDataUrlPrefix(asset.dataUrl);
    try {
      return await requestWhatsappApiJson('/api/whatsapp/send-image', {
        ...basePayload,
        imageBase64,
      });
    } catch (error) {
      chatbotDebugLog(`whatsapp image send fallback message=${error?.message || 'error'}`);
      let payload = null;
      let emptyBodyParameters = [];
      let emptyHeaderParameters = [];
      let emptyButtonParameters = [];
      try {
        return await requestWhatsappApiJson('/api/whatsapp/send-document', {
          ...basePayload,
          documentBase64: imageBase64,
          filename: asset.fileName || 'imagem.png',
        });
      } catch (fallbackError) {
        chatbotDebugLog(`whatsapp image document fallback failed message=${fallbackError?.message || 'error'}`);
        if (basePayload.caption) {
          return sendChatbotText(conversation, basePayload.caption);
        }
        throw fallbackError;
      }
    }
  }
  if (nodeData.headerType === 'document') {
    try {
      return await requestWhatsappApiJson('/api/whatsapp/send-document', {
        ...basePayload,
        documentBase64: stripDataUrlPrefix(asset.dataUrl),
        filename: asset.fileName || 'documento',
      });
    } catch (error) {
      chatbotDebugLog(`whatsapp document send fallback message=${error?.message || 'error'}`);
      if (basePayload.caption) {
        return sendChatbotText(conversation, basePayload.caption);
      }
      throw error;
    }
  }
  if (nodeData.headerType === 'video') {
    try {
      return await requestWhatsappApiJson('/api/whatsapp/send-video', {
        ...basePayload,
        videoBase64: stripDataUrlPrefix(asset.dataUrl),
        filename: asset.fileName || 'video',
      });
    } catch (error) {
      if (Number(error.status) !== 404) throw error;
      return requestWhatsappApiJson('/api/whatsapp/send-document', {
        ...basePayload,
        documentBase64: stripDataUrlPrefix(asset.dataUrl),
        filename: asset.fileName || 'video',
      });
    }
  }
  return sendChatbotText(conversation, basePayload.caption);
};

const sendChatbotAudio = (conversation, nodeData) => {
  const asset = nodeData.audioAsset || {};
  return requestWhatsappApiJson('/api/whatsapp/send-audio', {
    to: resolveConversationPhone(conversation),
    audioBase64: stripDataUrlPrefix(asset.dataUrl),
    mimetype: asset.mimeType || 'audio/ogg',
    ptt: true,
    origin: 'chatbot',
    agentName: 'Bot',
    ...getRouteSelectorFromConversation(conversation),
  });
};

const sendChatbotInteractive = async (conversation, nodeData, edges, variables) => {
  const options = edges
    .filter((edge) => (edge.data?.connectionType || 'option') === 'option')
    .map((edge, index) => ({
      id: String(edge.id || `option-${index + 1}`),
      title: String(edge.data?.description || `Opcao ${index + 1}`).trim(),
      description: String(edge.data?.description || '').trim(),
    }))
    .filter((option) => option.title);
  const text = interpolateChatbotText(nodeData.text || nodeData.body || 'Selecione uma opcao:', variables);
  const selector = getRouteSelectorFromConversation(conversation);

  if (nodeData.displayAs === 'buttons') {
    try {
      return await requestWhatsappApiJson('/api/whatsapp/send-interactive', {
        to: resolveConversationPhone(conversation),
        text,
        buttons: options.slice(0, 3),
        origin: 'chatbot',
        agentName: 'Bot',
        ...selector,
      });
    } catch (error) {
      if (Number(error.status) !== 404) throw error;
    }
  }

  if (nodeData.displayAs === 'list') {
    try {
      return await requestWhatsappApiJson('/api/whatsapp/send-interactive', {
        to: resolveConversationPhone(conversation),
        text,
        buttonText: nodeData.listTitle || 'MENU',
        rows: options.slice(0, 10),
        origin: 'chatbot',
        agentName: 'Bot',
        ...selector,
      });
    } catch (error) {
      if (Number(error.status) !== 404) throw error;
    }
  }

  const fallbackText = [text, ...options.map((option, index) => `${index + 1}. ${option.title}`)].join('\n');
  return sendChatbotText(conversation, fallbackText);
};

const getOutgoingEdges = (flow, nodeId) =>
  (Array.isArray(flow?.state?.edges) ? flow.state.edges : []).filter((edge) => String(edge.source) === String(nodeId));

const getNodeById = (flow, nodeId) =>
  (Array.isArray(flow?.state?.nodes) ? flow.state.nodes : []).find((node) => String(node.id) === String(nodeId)) || null;

const getFirstTargetNodeId = (flow, nodeId) => getOutgoingEdges(flow, nodeId)[0]?.target || '';

const applyChatbotLabels = (store, conversationId, nodeData) => {
  const labelsState = normalizeLabelsState(store.labels);
  const allowedCustomIds = new Set(labelsState.customLabels.map((label) => label.id));
  const currentIds = new Set(labelsState.assignments[conversationId] || []);

  if (nodeData.removeAllCustom) {
    currentIds.clear();
  }
  if (allowedCustomIds.has(String(nodeData.removeLabelId || ''))) {
    currentIds.delete(String(nodeData.removeLabelId));
  }
  if (allowedCustomIds.has(String(nodeData.addLabelId || ''))) {
    currentIds.add(String(nodeData.addLabelId));
  }

  store.labels = {
    ...labelsState,
    assignments: {
      ...labelsState.assignments,
      [conversationId]: Array.from(currentIds),
    },
    updatedAt: nowIso(),
  };
};

const finishChatbotConversation = (store, conversationId, nodeData) => {
  const timestamp = nowIso();
  const preferences = Array.isArray(store.conversationPreferences) ? store.conversationPreferences : [];
  const index = preferences.findIndex((item) => String(item?.conversation_id || item?.conversationId || '') === String(conversationId));
  const nextPreference = {
    ...(index >= 0 ? preferences[index] : {}),
    id: index >= 0 ? preferences[index].id : `preference-${crypto.randomUUID()}`,
    conversation_id: conversationId,
    resolution_status: 'resolved',
    resolution_type: nodeData.finishType === 'no_interaction' ? 'no_interaction' : 'resolved',
    resolved_at: timestamp,
    resolved_until: null,
    updated_date: timestamp,
    created_date: index >= 0 ? preferences[index].created_date || timestamp : timestamp,
  };
  if (index >= 0) {
    preferences[index] = nextPreference;
  } else {
    preferences.push(nextPreference);
  }
  store.conversationPreferences = preferences;
};

const appendChatbotEvent = (store, event = {}) => {
  const conversationId = String(event.conversationId || event.conversation_id || '').trim();
  const flowId = String(event.flowId || event.flow_id || '').trim();
  const type = String(event.type || '').trim();
  if (!conversationId || !flowId || !type) return null;

  const timestamp = nowIso();
  const createdEvent = {
    id: `chatbot-event-${crypto.randomUUID()}`,
    conversation_id: conversationId,
    flow_id: flowId,
    flowName: String(event.flowName || '').trim(),
    type,
    created_date: timestamp,
    updated_date: timestamp,
  };

  const currentEvents = Array.isArray(store.chatbotEvents) ? store.chatbotEvents : [];
  store.chatbotEvents = [...currentEvents, createdEvent].slice(-1000);
  return createdEvent;
};

const runChatbotFlow = async ({ store, flow, conversation, session }) => {
  const conversationId = String(conversation.id || '').trim();
  const executions = store.chatbotExecutions && typeof store.chatbotExecutions === 'object' ? store.chatbotExecutions : {};
  const sessions = executions.sessions && typeof executions.sessions === 'object' ? executions.sessions : {};
  const activeSession = {
    status: 'active',
    flowId: flow.id,
    nodeId: session?.nodeId || getFirstTargetNodeId(flow, CHATBOT_START_NODE_ID),
    variables: {
      ...buildDefaultChatbotVariables(conversation),
      ...(session?.variables && typeof session.variables === 'object' ? session.variables : {}),
    },
    lastMessageKey: resolveMessageKey(conversation),
    updatedAt: nowIso(),
    ...session,
    conversationSnapshot: session?.conversationSnapshot || buildChatbotConversationSnapshot(conversation),
  };

  let guard = 0;
  while (activeSession.nodeId && guard < 50) {
    guard += 1;
    const node = getNodeById(flow, activeSession.nodeId);
    if (!node) break;
    const data = node.data || {};
    const outgoingEdges = getOutgoingEdges(flow, node.id);
    let nextNodeId = outgoingEdges[0]?.target || '';

    if (data.componentType === 'message') {
      if (data.headerType && data.headerType !== 'none' && data.headerAsset?.dataUrl) {
        await sendChatbotMedia(conversation, data, activeSession.variables).catch((error) => {
          chatbotDebugLog(`node media send failed conversationId=${conversationId} nodeId=${node.id} message=${error?.message || 'error'}`);
        });
      } else {
        const text = interpolateChatbotText(data.text || '', activeSession.variables);
        if (text) await sendChatbotText(conversation, text);
      }
    } else if (data.componentType === 'audio' && data.audioAsset?.dataUrl) {
      await sendChatbotAudio(conversation, data);
    } else if (data.componentType === 'label') {
      applyChatbotLabels(store, conversationId, data);
    } else if (data.componentType === 'finish') {
      finishChatbotConversation(store, conversationId, data);
      appendChatbotEvent(store, {
        conversationId,
        flowId: flow.id,
        flowName: flow.name,
        type: 'finished',
      });
      activeSession.status = 'finished';
      activeSession.nodeId = '';
      delete activeSession.waitingSince;
      delete activeSession.timeoutAt;
      delete activeSession.resumeAt;
      delete activeSession.resumeNodeId;
      break;
    } else if (data.componentType === 'variables') {
      for (const variable of Array.isArray(data.variables) ? data.variables : []) {
        const key = normalizeChatbotVariableKey(variable.key);
        if (key) {
          activeSession.variables[key] = interpolateChatbotText(variable.value || '', activeSession.variables);
        }
      }
    } else if (data.componentType === 'redirect') {
      nextNodeId = data.destinationNodeId || nextNodeId;
    } else if (data.componentType === 'wait') {
      activeSession.status = 'waiting_timer';
      activeSession.nodeId = node.id;
      activeSession.resumeNodeId = nextNodeId;
      activeSession.resumeAt = new Date(Date.now() + Math.max(1, Number(data.waitSeconds || 1)) * 1000).toISOString();
      break;
    } else if (data.componentType === 'ura') {
      await sendChatbotInteractive(conversation, data, outgoingEdges, activeSession.variables);
      activeSession.status = 'awaiting_ura';
      activeSession.nodeId = node.id;
      activeSession.waitingSince = nowIso();
      activeSession.timeoutAt = new Date(Date.now() + Math.max(1, Number(data.waitMinutes || 1)) * 60 * 1000).toISOString();
      break;
    }

    activeSession.nodeId = nextNodeId;
  }

  activeSession.updatedAt = nowIso();
  sessions[conversationId] = activeSession;
  store.chatbotExecutions = { ...executions, sessions };
  return activeSession;
};

const processChatbotConversationInStore = async (store, conversation = {}, options = {}) => {
  const conversationId = String(conversation.id || '').trim();
  const lastMessage = String(conversation.last_message || '').trim();
  const messageKey = String(options.messageKey || '').trim() || resolveMessageKey(conversation);
  if (!conversationId || !lastMessage || !resolveConversationPhone(conversation)) {
    chatbotDebugLog(`skipped conversation_incomplete conversationId=${conversationId || 'missing'}`);
    return { ok: true, skipped: true, reason: 'conversation_incomplete' };
  }
  if (
    hasPendingQuickReplyScheduleForTarget(store, {
      conversationId,
      phone: resolveConversationPhone(conversation),
      customerId: conversation.customer?.id || conversation.customer_id || '',
    })
  ) {
    chatbotDebugLog(`skipped pending_quick_reply_schedule conversationId=${conversationId}`);
    return { ok: true, skipped: true, reason: 'pending_quick_reply_schedule' };
  }

  const flows = normalizeChatbotFlows(store.chatbotFlows).filter((flow) => flow.active);
  const executions = store.chatbotExecutions && typeof store.chatbotExecutions === 'object' ? store.chatbotExecutions : {};
  const sessions = executions.sessions && typeof executions.sessions === 'object' ? executions.sessions : {};
  let currentSession = sessions[conversationId] || null;

  const clearCurrentSession = (reason) => {
    delete sessions[conversationId];
    store.chatbotExecutions = { ...executions, sessions };
    currentSession = null;
    chatbotDebugLog(`cleared session conversationId=${conversationId} reason=${reason}`);
  };

  if (currentSession?.status === 'waiting_timer') {
    const flow = flows.find((item) => item.id === currentSession.flowId);
    const resumeAt = Date.parse(currentSession.resumeAt || '');
    if (!flow || !getNodeById(flow, currentSession.nodeId)) {
      clearCurrentSession('waiting_timer_orphan');
    } else if (Number.isFinite(resumeAt) && Date.now() - resumeAt > CHATBOT_TRIGGER_FRESH_WINDOW_MS) {
      clearCurrentSession('waiting_timer_expired');
    }
  }

  if (currentSession?.status === 'awaiting_ura') {
    const flow = flows.find((item) => item.id === currentSession.flowId);
    const node = flow ? getNodeById(flow, currentSession.nodeId) : null;
    const timeoutAt = Date.parse(currentSession.timeoutAt || '');
    if (!flow || !node) {
      clearCurrentSession('awaiting_ura_orphan');
    } else if (Number.isFinite(timeoutAt) && Date.now() >= timeoutAt) {
      const timeoutEdge = getOutgoingEdges(flow, node.id).find((edge) => edge.data?.connectionType === 'timeout');
      if (!timeoutEdge) {
        clearCurrentSession('awaiting_ura_timeout_without_edge');
      }
    }
  }

  if (currentSession?.status === 'waiting_timer') {
    const resumeAt = Date.parse(currentSession.resumeAt || '');
    if (Number.isFinite(resumeAt) && Date.now() < resumeAt) {
      chatbotDebugLog(`skipped waiting_timer conversationId=${conversationId}`);
      return { ok: true, skipped: true, reason: 'waiting_timer' };
    }
    const flow = flows.find((item) => item.id === currentSession.flowId);
    if (!flow) return { ok: true, skipped: true, reason: 'flow_missing' };
    if (options.dryRun) return { ok: true, mutated: true, reason: 'resume_timer_ready' };
    return {
      ok: true,
      mutated: true,
      session: await runChatbotFlow({ store, flow, conversation, session: { ...currentSession, status: 'active', nodeId: currentSession.resumeNodeId } }),
    };
  }

  if (currentSession?.status === 'awaiting_ura') {
    const flow = flows.find((item) => item.id === currentSession.flowId);
    if (!flow) return { ok: true, skipped: true, reason: 'flow_missing' };
    const node = getNodeById(flow, currentSession.nodeId);
    const timeoutAt = Date.parse(currentSession.timeoutAt || '');
    const edges = getOutgoingEdges(flow, node?.id);
    const isTimeoutReady = Number.isFinite(timeoutAt) && Date.now() >= timeoutAt;
    const isTimerRun = Boolean(options.timerRun);
    const selectedEdge = isTimerRun && isTimeoutReady
      ? edges.find((edge) => edge.data?.connectionType === 'timeout')
      : edges.find((edge) => (edge.data?.connectionType || 'option') === 'option' && normalizeChatbotText(edge.data?.description) === normalizeChatbotText(lastMessage))
        || edges.find((edge) => edge.data?.connectionType === 'invalid');

    if (!selectedEdge || (!isTimerRun && currentSession.lastMessageKey === messageKey)) {
      chatbotDebugLog(`skipped awaiting_ura conversationId=${conversationId}`);
      return { ok: true, skipped: true, reason: 'awaiting_ura' };
    }
    if (options.dryRun) return { ok: true, mutated: true, reason: isTimerRun ? 'ura_timeout_ready' : 'ura_reply_ready' };
    return {
      ok: true,
      mutated: true,
      session: await runChatbotFlow({ store, flow, conversation, session: { ...currentSession, status: 'active', nodeId: selectedEdge.target, lastMessageKey: messageKey } }),
    };
  }

  if (currentSession?.lastMessageKey === messageKey) {
    chatbotDebugLog(`skipped already_processed conversationId=${conversationId}`);
    return { ok: true, skipped: true, reason: 'already_processed' };
  }

  const lastClientMessageMs = Date.parse(
    conversation.last_client_message_time ||
      conversation.last_received_at ||
      conversation.last_message_time ||
      conversation.updated_date ||
      '',
  );
  if (!Number.isFinite(lastClientMessageMs) || Date.now() - lastClientMessageMs > CHATBOT_TRIGGER_FRESH_WINDOW_MS) {
    chatbotDebugLog(`skipped stale_message conversationId=${conversationId}`);
    return { ok: true, skipped: true, reason: 'stale_message' };
  }

  const matchedFlow = flows.find((flow) => {
    const startNode = getNodeById(flow, CHATBOT_START_NODE_ID);
    return evaluateChatbotRule(startNode?.data?.rule || 'contains', lastMessage, startNode?.data?.triggerValue || '');
  });
  if (!matchedFlow) {
    chatbotDebugLog(`skipped no_trigger conversationId=${conversationId}`);
    return { ok: true, skipped: true, reason: 'no_trigger' };
  }
  chatbotDebugLog(`trigger matched conversationId=${conversationId} flowId=${matchedFlow.id}`);
  if (options.dryRun) {
    return { ok: true, mutated: true, reason: 'trigger_matched', flowId: matchedFlow.id };
  }

  return {
    ok: true,
    mutated: true,
    session: await (async () => {
      appendChatbotEvent(store, {
        conversationId,
        flowId: matchedFlow.id,
        flowName: matchedFlow.name,
        type: 'started',
      });
      return runChatbotFlow({
      store,
      flow: matchedFlow,
      conversation,
      session: { flowId: matchedFlow.id, lastMessageKey: messageKey },
      });
    })(),
  };
};

const processChatbotConversationRequest = async (conversation = {}, options = {}) => {
  const startedAt = Date.now();
  const conversationId = String(conversation?.id || '').trim();
  const requestMessageKey = String(options.messageKey || '').trim();
  const cacheKey = `${conversationId}|${requestMessageKey || resolveChatbotProcessCacheKey(conversation)}`;
  pruneChatbotProcessCache();

  if (chatbotProcessInFlight.has(cacheKey)) {
    chatbotDebugLog(`skipped already_in_flight conversationId=${conversationId || 'missing'}`);
    return { ok: true, skipped: true, reason: 'already_in_flight' };
  }

  const cached = chatbotProcessCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CHATBOT_PROCESS_CACHE_TTL_MS) {
    chatbotDebugLog(`skipped cached conversationId=${conversationId || 'missing'} reason=${cached.result?.reason || 'cached'}`);
    return cached.result;
  }

  chatbotProcessInFlight.set(cacheKey, startedAt);
  try {
    const snapshot = await readStore();
    let result = await processChatbotConversationInStore(snapshot, conversation, {
      dryRun: true,
      messageKey: requestMessageKey,
      timerRun: Boolean(options.timerRun),
    });

    if (result?.mutated) {
      await updateStore(async (store) => {
        result = await processChatbotConversationInStore(store, conversation, {
          messageKey: requestMessageKey,
          timerRun: Boolean(options.timerRun),
        });
        return result?.mutated ? store : false;
      });
    }

    const responseResult = result || { ok: true, skipped: true };
    if (!responseResult.mutated) {
      chatbotProcessCache.set(cacheKey, { at: Date.now(), result: responseResult });
      pruneChatbotProcessCache();
    }

    chatbotDebugLog(`processing duration ms=${Date.now() - startedAt} conversationId=${conversationId || 'missing'} reason=${responseResult.reason || 'processed'}`);
    return responseResult;
  } finally {
    chatbotProcessInFlight.delete(cacheKey);
  }
};

const runChatbotBackendRuntimeOnce = async (options = {}) => {
  const store = await readStore();
  const runtimeState = buildChatbotRuntimeState(store);
  const executions = store.chatbotExecutions && typeof store.chatbotExecutions === 'object' ? store.chatbotExecutions : {};
  const sessions = executions.sessions && typeof executions.sessions === 'object' ? executions.sessions : {};
  const timedOutUraIds = new Set(
    Object.entries(sessions)
      .filter(([, session]) => {
        if (String(session?.status || '') !== 'awaiting_ura') return false;
        const timeoutAt = Date.parse(session?.timeoutAt || '');
        return Number.isFinite(timeoutAt) && Date.now() >= timeoutAt;
      })
      .map(([conversationId]) => String(conversationId || '').trim())
      .filter(Boolean),
  );
  const hasRuntimeWork =
    runtimeState.activeFlows.length > 0 ||
    runtimeState.activeSessionConversationIds.length > 0 ||
    runtimeState.waitingTimerConversationIds.length > 0 ||
    timedOutUraIds.size > 0;

  if (!hasRuntimeWork) {
    return;
  }

  const activeSessionIds = new Set(runtimeState.activeSessionConversationIds.map(String));
  const waitingTimerIds = new Set(runtimeState.waitingTimerConversationIds.map(String));
  const conversationsSource = Array.isArray(options.conversations)
    ? options.conversations
    : await requestWhatsappApiGetJson(`/api/whatsapp/conversations?summary=1&limit=${WHATSAPP_INTERNAL_CONVERSATION_SUMMARY_LIMIT}`)
        .then((conversationsData) =>
          Array.isArray(conversationsData)
            ? conversationsData
            : Array.isArray(conversationsData?.items)
              ? conversationsData.items
              : [],
        )
        .catch(() => readWhatsappStoreConversationsForChatbot().catch(() => []));
  const conversations = conversationsSource
    .map(normalizeWhatsappConversationForChatbot)
    .filter((conversation) => conversation.id);
  for (const [conversationId, session] of Object.entries(sessions)) {
    if (!waitingTimerIds.has(conversationId) && !timedOutUraIds.has(conversationId)) {
      continue;
    }
    if (conversations.some((conversation) => String(conversation.id) === String(conversationId))) {
      continue;
    }
    if (session?.conversationSnapshot?.id) {
      conversations.push(normalizeWhatsappConversationForChatbot(session.conversationSnapshot));
    }
  }

  const candidates = [];
  for (const conversation of conversations) {
    const conversationId = String(conversation.id || '').trim();
    const messageKey = resolveMessageKey(conversation);

    if (waitingTimerIds.has(conversationId)) {
      candidates.push({
        conversation,
        messageKey: `${messageKey}|timer:${Math.floor(Date.now() / Math.max(1000, CHATBOT_BACKEND_POLL_INTERVAL_MS))}`,
        timerRun: true,
      });
    } else if (timedOutUraIds.has(conversationId)) {
      candidates.push({
        conversation,
        messageKey: `${messageKey}|ura-timeout:${Math.floor(Date.now() / Math.max(1000, CHATBOT_BACKEND_POLL_INTERVAL_MS))}`,
        timerRun: true,
      });
    } else if (activeSessionIds.has(conversationId)) {
      if (hasNewClientChatbotMessage(conversation)) {
        candidates.push({ conversation, messageKey });
      }
    } else if (hasNewClientChatbotMessage(conversation)) {
      const matchedFlow = runtimeState.activeFlows.find((flow) =>
        evaluateChatbotRule(flow.startRule || 'contains', conversation.last_message, flow.triggerValue || ''),
      );
      if (matchedFlow) {
        candidates.push({ conversation, messageKey });
      }
    }

    if (candidates.length >= CHATBOT_BACKEND_MAX_CANDIDATES) {
      break;
    }
  }

  for (const candidate of candidates) {
    await processChatbotConversationRequest(candidate.conversation, {
      messageKey: candidate.messageKey,
      timerRun: candidate.timerRun,
    });
  }
};

const scheduleChatbotBackendRuntime = () => {
  if (!CHATBOT_BACKEND_RUNTIME_ENABLED) {
    return;
  }

  const runSafely = async (options = {}) => {
    if (chatbotBackendRuntimeRunning) {
      return;
    }

    chatbotBackendRuntimeRunning = true;
    try {
      await runChatbotBackendRuntimeOnce(options);
    } catch (error) {
      chatbotDebugLog(`backend runtime error message=${error?.message || 'error'}`);
    } finally {
      chatbotBackendRuntimeRunning = false;
    }
  };

  void runSafely({ bootRun: true });

  chatbotBackendRuntimeTimer = startRegisteredInterval('chatbot-backend-runtime', async () => {
    await runSafely();
  }, Math.max(5000, CHATBOT_BACKEND_POLL_INTERVAL_MS));
};


const ROLE_PERMISSION_KEYS = [
  'attendance',
  'bulkSend',
  'queuesServices',
  'quickReplies',
  'customerBase',
  'labels',
  'chatbot',
  'routines',
  'hsms',
  'dashboard',
  'settings',
];

const DEFAULT_ROLE_PERMISSIONS = ROLE_PERMISSION_KEYS.reduce((accumulator, key) => {
  accumulator[key] = ['attendance', 'labels'].includes(key);
  return accumulator;
}, {});

const ADMIN_ROLE_PERMISSIONS = ROLE_PERMISSION_KEYS.reduce((accumulator, key) => {
  accumulator[key] = true;
  return accumulator;
}, {});

const normalizeRolePermissions = (permissions = {}, fallback = DEFAULT_ROLE_PERMISSIONS) => {
  const source = permissions && typeof permissions === 'object' ? permissions : {};
  return ROLE_PERMISSION_KEYS.reduce((accumulator, key) => {
    accumulator[key] = Boolean(source[key] ?? fallback?.[key] ?? false);
    return accumulator;
  }, {});
};

const buildDefaultRoles = (createdAt = nowIso()) => [
  {
    id: 'role-admin',
    name: 'Administrador',
    description: 'Acesso completo a toda a plataforma e configuracoes do sistema.',
    department_key: 'administracao',
    permissions: { ...ADMIN_ROLE_PERMISSIONS },
    created_date: createdAt,
    updated_date: createdAt,
  },
  {
    id: 'role-sales',
    name: 'Comercial',
    description: 'Responsavel por leads, etiquetas e acompanhamento do funil.',
    department_key: 'comercial',
    permissions: {
      ...DEFAULT_ROLE_PERMISSIONS,
      attendance: true,
      dashboard: true,
      labels: true,
      bulkSend: true,
      quickReplies: true,
      customerBase: false,
      chatbot: false,
      routines: false,
      hsms: false,
      settings: false,
    },
    created_date: createdAt,
    updated_date: createdAt,
  },
  {
    id: 'role-support',
    name: 'Suporte',
    description: 'Atua no atendimento e no acompanhamento operacional das conversas.',
    department_key: 'suporte',
    permissions: {
      ...DEFAULT_ROLE_PERMISSIONS,
      attendance: true,
      dashboard: true,
      labels: true,
      bulkSend: false,
      quickReplies: true,
      customerBase: false,
      chatbot: false,
      routines: false,
      hsms: false,
      settings: false,
    },
    created_date: createdAt,
    updated_date: createdAt,
  },
];

const normalizeService = (service = {}, index = 0) => {
  const timestamp = nowIso();

  return {
    id: String(service.id || `service-${index + 1}`),
    name: String(service.name || '').trim(),
    description: String(service.description || '').trim(),
    phone_numbers: normalizeStringArray(service.phone_numbers || service.phoneNumbers).map(normalizePhoneDisplay).filter(Boolean),
    user_ids: normalizeStringArray(service.user_ids || service.userIds),
    user_emails: normalizeStringArray(service.user_emails || service.userEmails).map((email) => email.toLowerCase()),
    label_ids: canonicalizeLabelIds(service.label_ids || service.labelIds),
    icon_key: String(service.icon_key || service.iconKey || DEFAULT_SERVICE_ICON_KEY).trim() || DEFAULT_SERVICE_ICON_KEY,
    created_date: String(service.created_date || service.createdAt || timestamp),
    updated_date: String(service.updated_date || service.updatedAt || timestamp),
  };
};

const sortServices = (services = []) =>
  [...services].sort((left, right) =>
    String(left?.name || '').localeCompare(String(right?.name || ''), 'pt-BR', {
      sensitivity: 'base',
    }),
  );

const buildDefaultServices = (users = [], createdAt = nowIso()) => {
  const adminUser = Array.isArray(users) ? users.find((user) => String(user?.id || '').trim()) || users[0] : null;
  const adminUserId = String(adminUser?.id || '').trim();
  const adminUserEmail = String(adminUser?.email || '').trim().toLowerCase();
  const sharedPayload = {
    phone_numbers: [DEFAULT_SERVICE_PHONE_NUMBER],
    user_ids: adminUserId ? [adminUserId] : [],
    user_emails: adminUserEmail ? [adminUserEmail] : [],
    created_date: createdAt,
    updated_date: createdAt,
  };

  return sortServices([
    normalizeService(
      {
        ...sharedPayload,
        id: 'service-support',
        name: 'Suporte',
        description: 'Servico Padrao da Aplicacao a respeito de Suporte.',
        label_ids: ['system-cliente'],
        icon_key: 'headphones',
      },
      0,
    ),
    normalizeService(
      {
        ...sharedPayload,
        id: 'service-onboarding',
        name: 'Onboarding',
        description: 'Servico Padrao da Aplicacao a respeito de Onboarding.',
        label_ids: ['system-pos-venda', 'system-cancelados'],
        icon_key: 'briefcase',
      },
      1,
    ),
    normalizeService(
      {
        ...sharedPayload,
        id: 'service-sales',
        name: 'Vendas',
        description: 'Servico Padrao da Aplicacao a respeito de Vendas.',
        label_ids: ['system-lead'],
        icon_key: 'megaphone',
      },
      2,
    ),
    normalizeService(
      {
        ...sharedPayload,
        id: 'service-sales-2',
        name: 'Vendas2',
        description: 'Servico Padrao da Aplicacao a respeito de Vendas2.',
        label_ids: ['system-lead'],
        icon_key: 'megaphone',
      },
      3,
    ),
  ]);
};

const normalizeUserRecord = (user = {}, index = 0, fallbackCreatedAt = nowIso()) => {
  const createdAt = String(user.created_date || user.createdAt || fallbackCreatedAt || nowIso());
  const updatedAt = String(user.updated_date || user.updatedAt || createdAt);
  const inferredAdminUser = String(user.id || '').trim() === 'user-admin';
  const username = String(user.username || (inferredAdminUser ? 'admin' : '')).trim();
  const normalizedRole = String(user.role || user.role_name || '').trim() || (inferredAdminUser ? 'admin' : '');
  const normalizedRoleName =
    String(user.role_name || '').trim() ||
    (inferredAdminUser && normalizedRole.toLowerCase() === 'admin' ? 'Administrador' : normalizedRole);
  const fallbackPassword =
    String(user.password || '').trim() ||
    (inferredAdminUser || username.toLowerCase() === 'admin' ? DEFAULT_ADMIN_PASSWORD : '');

  return {
    id: String(user.id || `user-${index + 1}`),
    full_name: String(user.full_name || user.name || '').trim(),
    email: String(user.email || (username ? `${toSlug(username)}@saastv.local` : '')).trim().toLowerCase(),
    role: normalizedRole || 'admin',
    role_id: String(user.role_id || '').trim() || (inferredAdminUser ? 'role-admin' : ''),
    role_name: normalizedRoleName,
    username,
    description: String(user.description || '').trim(),
    password_hash: normalizePasswordHash(user.password_hash || user.passwordHash, fallbackPassword),
    created_date: createdAt,
    updated_date: updatedAt,
  };
};

const sanitizeUserForClient = (user = {}) => ({
  id: String(user.id || '').trim(),
  full_name: String(user.full_name || '').trim(),
  email: String(user.email || '').trim(),
  role: String(user.role || '').trim(),
  role_id: String(user.role_id || '').trim(),
  role_name: String(user.role_name || '').trim(),
  username: String(user.username || '').trim(),
  description: String(user.description || '').trim(),
  created_date: String(user.created_date || '').trim(),
  updated_date: String(user.updated_date || '').trim(),
  has_password: Boolean(String(user.password_hash || '').trim()),
});

const normalizeSessionRecord = (session = {}) => ({
  id: String(session.id || '').trim(),
  user_id: String(session.user_id || session.userId || '').trim(),
  token_hash: String(session.token_hash || session.tokenHash || '').trim(),
  remember: Boolean(session.remember),
  created_at: String(session.created_at || session.createdAt || '').trim(),
  last_seen_at: String(session.last_seen_at || session.lastSeenAt || session.created_at || session.createdAt || '').trim(),
  expires_at: String(session.expires_at || session.expiresAt || '').trim(),
  ip: String(session.ip || '').trim(),
  user_agent: String(session.user_agent || session.userAgent || '').trim(),
});

const normalizeAttendancePresenceRecord = (record = {}) => {
  const source = record && typeof record === 'object' ? record : {};
  return {
    user_id: String(source.user_id || source.userId || '').trim(),
    user_name: String(source.user_name || source.userName || '').trim(),
    role: String(source.role || '').trim(),
    status: String(source.status || 'attending').trim() || 'attending',
    paused_until: String(source.paused_until || source.pausedUntil || '').trim(),
    pause_reason: String(source.pause_reason || source.pauseReason || '').trim(),
    pause_reason_label: String(source.pause_reason_label || source.pauseReasonLabel || '').trim(),
    last_seen_at: String(source.last_seen_at || source.lastSeenAt || '').trim(),
    updated_at: String(source.updated_at || source.updatedAt || source.last_seen_at || '').trim(),
  };
};

const normalizeAttendancePresence = (value = []) =>
  (Array.isArray(value) ? value : [])
    .map(normalizeAttendancePresenceRecord)
    .filter((record) => record.user_id && record.last_seen_at);

const mergeAttendancePresence = (items = []) => {
  const byUserId = new Map();
  items.forEach((presence) => {
    const record = normalizeAttendancePresenceRecord(presence);
    if (!record.user_id || !record.last_seen_at) return;
    const previous = byUserId.get(record.user_id);
    const previousUpdatedMs = Date.parse(previous?.updated_at || previous?.last_seen_at || '');
    const currentUpdatedMs = Date.parse(record.updated_at || record.last_seen_at || '');
    if (
      !previous ||
      (Number.isFinite(currentUpdatedMs) && (!Number.isFinite(previousUpdatedMs) || currentUpdatedMs >= previousUpdatedMs))
    ) {
      byUserId.set(record.user_id, record);
    }
  });
  return [...byUserId.values()];
};

const getLegacyAttendancePresence = (store = {}) => normalizeAttendancePresence(store?.attendancePresence);

const getPersistedAttendancePresence = (store = {}) =>
  mergeAttendancePresence([...listSqlAttendancePresence(), ...getLegacyAttendancePresence(store)]);

const getPersistedAttendancePresenceForUser = (store = {}, userId = '') => {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return null;
  const sqlPresence = getSqlAttendancePresenceByUserId(safeUserId);
  const legacyPresence = getLegacyAttendancePresence(store).find((presence) => presence.user_id === safeUserId) || null;
  const presence = mergeAttendancePresence([sqlPresence, legacyPresence])[0] || null;
  if (!sqlPresence && legacyPresence && isSqlAttendancePresenceStoreEnabled()) {
    upsertSqlAttendancePresence(legacyPresence);
  }
  return presence;
};

const normalizeAuthState = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  const loginAttemptsSource =
    source.loginAttempts && typeof source.loginAttempts === 'object' && !Array.isArray(source.loginAttempts)
      ? source.loginAttempts
      : {};

  const sessions = (Array.isArray(source.sessions) ? source.sessions : [])
    .map((session) => normalizeSessionRecord(session))
    .filter((session) => session.id && session.user_id && session.token_hash && session.expires_at)
    .filter((session) => {
      const expiresAt = Date.parse(session.expires_at);
      return Number.isFinite(expiresAt) && expiresAt > nowMs();
    });

  const loginAttempts = Object.entries(loginAttemptsSource).reduce((accumulator, [key, attempt]) => {
    if (!key) {
      return accumulator;
    }

    accumulator[String(key).trim().toLowerCase()] = {
      count: Math.max(0, Number.parseInt(attempt?.count || '0', 10) || 0),
      lastFailedAt: String(attempt?.lastFailedAt || '').trim() || null,
      lockedUntil: String(attempt?.lockedUntil || '').trim() || null,
    };
    return accumulator;
  }, {});

  return {
    ...AUTH_DEFAULT_STATE,
    sessions,
    loginAttempts,
  };
};

const normalizeCustomerSyncSettings = (value) => {
  const rawMinutes = Number.parseInt(
    String(value?.autoSyncIntervalMinutes ?? value?.intervalMinutes ?? value?.syncIntervalMinutes ?? ''),
    10,
  );

  return {
    ...CUSTOMER_SYNC_SETTINGS_DEFAULT,
    autoSyncIntervalMinutes:
      Number.isFinite(rawMinutes) && rawMinutes > 0
        ? Math.min(CUSTOMER_SYNC_INTERVAL_MINUTES_MAX, Math.max(CUSTOMER_SYNC_INTERVAL_MINUTES_MIN, rawMinutes))
        : CUSTOMER_SYNC_SETTINGS_DEFAULT.autoSyncIntervalMinutes,
    updatedAt: String(value?.updatedAt || '').trim() || null,
  };
};

const normalizeScheduleSettings = (value = {}) => ({
  ...SCHEDULE_SETTINGS_DEFAULT,
  ...(value && typeof value === 'object' ? value : {}),
  hsmTemplateId: String(value?.hsmTemplateId || '').trim(),
  hsmTemplateName: String(value?.hsmTemplateName || '').trim(),
  hsmLanguage: String(value?.hsmLanguage || 'pt_BR').trim() || 'pt_BR',
  hsmVariables:
    value?.hsmVariables && typeof value.hsmVariables === 'object'
      ? value.hsmVariables
      : { body: {}, header: {}, buttons: {} },
  hsmMedia: value?.hsmMedia && typeof value.hsmMedia === 'object' ? value.hsmMedia : {},
});

const normalizeLocalTavinhoSettings = (value = {}) => normalizeTavinhoSettings(value);

const getCustomerAutoSyncIntervalMs = (store) =>
  normalizeCustomerSyncSettings(store?.customerSyncSettings).autoSyncIntervalMinutes * 60 * 1000;

const resolveCustomerSyncRescheduleDelayMs = (store, referenceMs = Date.now()) => {
  const intervalMs = getCustomerAutoSyncIntervalMs(store);

  if (!store?.customerSync?.hasCompletedInitialSync) {
    const lastAttemptAt = Date.parse(store?.customerSync?.lastAttemptAt || '');
    if (Number.isFinite(lastAttemptAt)) {
      const remainingMs = intervalMs - (referenceMs - lastAttemptAt);
      return remainingMs > 0 ? remainingMs : 5000;
    }
    return null;
  }

  const lastSuccessfulAt = Date.parse(store?.customerSync?.lastSuccessfulSyncAt || '');
  if (!Number.isFinite(lastSuccessfulAt)) {
    return 5000;
  }

  const elapsedMs = referenceMs - lastSuccessfulAt;
  const remainingMs = intervalMs - elapsedMs;
  return remainingMs > 0 ? remainingMs : 5000;
};

const normalizeRoutineStatus = (value) => {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'paused') return 'inactive';
  return ['active', 'inactive', 'draft'].includes(status) ? status : 'inactive';
};

const normalizeRoutineArray = (value) =>
  Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

const FOLLOW_UP_PERIODS = [
  { key: 'morning', label: 'Manha', defaultTime: '07:00' },
  { key: 'afternoon', label: 'Tarde', defaultTime: '12:00' },
  { key: 'night', label: 'Noite', defaultTime: '19:00' },
];

const FOLLOW_UP_MODEL_KEYS = ['model1', 'model2'];
const FOLLOW_UP_LEAD_DEFAULT_TIMES = ['07:00', '12:00', '19:00', '11:00', '20:00'];
const FOLLOW_UP_SQL_DEFAULT_TIMES = ['07:00', '12:00', '20:00', '11:00'];

const normalizeTimeValue = (value, fallback = '09:00') => {
  const raw = String(value || '').trim().slice(0, 5);
  return /^\d{2}:\d{2}$/.test(raw) ? raw : fallback;
};

const normalizeFollowUpPeriodConfig = (value = {}, fallbackTime = '09:00') => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalizeAction = (action = {}, index = 0) => {
    const actionSource = action && typeof action === 'object' && !Array.isArray(action) ? action : {};
    const type = String(actionSource.type || 'text').trim().toLowerCase();
    return {
      ...actionSource,
      id: String(actionSource.id || `follow-up-action-${Date.now()}-${index}`),
      type,
      title: String(actionSource.title || '').trim(),
      content: String(actionSource.content || '').trim(),
      caption: String(actionSource.caption || '').trim(),
      media:
        actionSource.media && typeof actionSource.media === 'object'
          ? {
              dataUrl: String(actionSource.media.dataUrl || actionSource.media.base64 || ''),
              fileName: String(actionSource.media.fileName || actionSource.media.filename || ''),
              mimeType: String(actionSource.media.mimeType || actionSource.media.mimetype || ''),
              kind: String(actionSource.media.kind || type),
            }
          : { dataUrl: '', fileName: '', mimeType: '', kind: type },
      typingDelaySeconds: Math.max(0, Math.min(300, Number(actionSource.typingDelaySeconds) || 0)),
      nextActionDelaySeconds: Math.max(0, Math.min(300, Number(actionSource.nextActionDelaySeconds ?? actionSource.waitSeconds) || 0)),
      waitSeconds: Math.max(0, Math.min(300, Number(actionSource.waitSeconds ?? actionSource.nextActionDelaySeconds) || 0)),
      metadata: actionSource.metadata && typeof actionSource.metadata === 'object' ? actionSource.metadata : {},
      sortOrder: Number.isFinite(Number(actionSource.sortOrder)) ? Number(actionSource.sortOrder) : index,
    };
  };
  const snapshot = source.quickReplySnapshot && typeof source.quickReplySnapshot === 'object' && !Array.isArray(source.quickReplySnapshot)
    ? {
        id: String(source.quickReplySnapshot.id || '').trim(),
        title: String(source.quickReplySnapshot.title || '').trim(),
        category: String(source.quickReplySnapshot.category || source.quickReplySnapshot.categoryName || '').trim(),
        categoryId: String(source.quickReplySnapshot.categoryId || '').trim(),
        actions: Array.isArray(source.quickReplySnapshot.actions) ? source.quickReplySnapshot.actions.map(normalizeAction) : [],
      }
    : null;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    time: normalizeTimeValue(source.time, fallbackTime),
    message: String(source.message || '').trim(),
    quickReplyId: String(source.quickReplyId || '').trim(),
    quickReplyTitle: String(source.quickReplyTitle || snapshot?.title || '').trim(),
    quickReplySnapshot: snapshot,
    additionalActions: Array.isArray(source.additionalActions) ? source.additionalActions.map(normalizeAction) : [],
  };
};

const normalizeFollowUpAction = (action = {}, index = 0) => {
  const actionSource = action && typeof action === 'object' && !Array.isArray(action) ? action : {};
  const type = String(actionSource.type || 'text').trim().toLowerCase();
  return {
    ...actionSource,
    id: String(actionSource.id || `follow-up-action-${Date.now()}-${index}`),
    type,
    title: String(actionSource.title || '').trim(),
    content: String(actionSource.content || '').trim(),
    caption: String(actionSource.caption || '').trim(),
    media:
      actionSource.media && typeof actionSource.media === 'object'
        ? {
            dataUrl: String(actionSource.media.dataUrl || actionSource.media.base64 || ''),
            fileName: String(actionSource.media.fileName || actionSource.media.filename || ''),
            mimeType: String(actionSource.media.mimeType || actionSource.media.mimetype || ''),
            kind: String(actionSource.media.kind || type),
          }
        : { dataUrl: '', fileName: '', mimeType: '', kind: type },
    typingDelaySeconds: Math.max(0, Math.min(300, Number(actionSource.typingDelaySeconds) || 0)),
    nextActionDelaySeconds: Math.max(0, Math.min(300, Number(actionSource.nextActionDelaySeconds ?? actionSource.waitSeconds) || 0)),
    waitSeconds: Math.max(0, Math.min(300, Number(actionSource.waitSeconds ?? actionSource.nextActionDelaySeconds) || 0)),
    metadata: actionSource.metadata && typeof actionSource.metadata === 'object' ? actionSource.metadata : {},
    sortOrder: Number.isFinite(Number(actionSource.sortOrder)) ? Number(actionSource.sortOrder) : index,
  };
};

const normalizeFollowUpQuickReplySnapshot = (snapshot = null) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return {
    id: String(snapshot.id || '').trim(),
    title: String(snapshot.title || '').trim(),
    category: String(snapshot.category || snapshot.categoryName || '').trim(),
    categoryId: String(snapshot.categoryId || '').trim(),
    actions: Array.isArray(snapshot.actions) ? snapshot.actions.map(normalizeFollowUpAction) : [],
  };
};

const normalizeFollowUpStepConfig = (value = {}, index = 0, fallbackTime = '09:00') => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const snapshot = normalizeFollowUpQuickReplySnapshot(source.quickReplySnapshot);
  return {
    id: String(source.id || `follow-up-step-${index + 1}`).trim(),
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    order: Math.max(1, Number.parseInt(String(source.order ?? index + 1), 10) || index + 1),
    label: String(source.label || `Mensagem ${index + 1}`).trim() || `Mensagem ${index + 1}`,
    time: normalizeTimeValue(source.time, fallbackTime),
    message: String(source.message || '').trim(),
    quickReplyId: String(source.quickReplyId || '').trim(),
    quickReplyTitle: String(source.quickReplyTitle || snapshot?.title || '').trim(),
    quickReplySnapshot: snapshot,
    additionalActions: Array.isArray(source.additionalActions) ? source.additionalActions.map(normalizeFollowUpAction) : [],
  };
};

const buildLegacyFollowUpSteps = (models = {}, fallbackTimes = FOLLOW_UP_LEAD_DEFAULT_TIMES) => {
  const legacyPeriods = [];
  for (const modelKey of FOLLOW_UP_MODEL_KEYS) {
    for (const period of FOLLOW_UP_PERIODS) {
      const config = models?.[modelKey]?.[period.key];
      if (!config || typeof config !== 'object') continue;
      legacyPeriods.push({
        ...config,
        time: config.time || period.defaultTime,
      });
    }
  }
  const source = legacyPeriods.filter((item) => item.enabled !== false);
  const base = source.length ? source : fallbackTimes.map((time) => ({ time, enabled: true }));
  return base.slice(0, Math.max(fallbackTimes.length, source.length)).map((item, index) =>
    normalizeFollowUpStepConfig(
      {
        ...item,
        label: item.label || `Mensagem ${index + 1}`,
        order: index + 1,
      },
      index,
      fallbackTimes[index % fallbackTimes.length] || '09:00',
    ),
  );
};

const createDefaultFollowUpModelConfig = () =>
  FOLLOW_UP_PERIODS.reduce((accumulator, period) => {
    accumulator[period.key] = normalizeFollowUpPeriodConfig({}, period.defaultTime);
    return accumulator;
  }, {});

const normalizeFollowUpConfig = (value = {}) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const models = source.models && typeof source.models === 'object' ? source.models : {};
  const targetLabelId = canonicalizeLabelId(source.targetLabelId || 'system-lead') || 'system-lead';
  const targetLabelName = String(source.targetLabelName || (targetLabelId === 'system-sql' ? 'SQL' : 'LEAD')).trim() || 'LEAD';
  const defaultTimes = normalizeRoutineText(`${targetLabelId} ${targetLabelName}`).includes('sql')
    ? FOLLOW_UP_SQL_DEFAULT_TIMES
    : FOLLOW_UP_LEAD_DEFAULT_TIMES;
  const normalizedSteps = (Array.isArray(source.steps) && source.steps.length ? source.steps : buildLegacyFollowUpSteps(models, defaultTimes))
    .map((step, index) => normalizeFollowUpStepConfig(step, index, defaultTimes[index % defaultTimes.length] || '09:00'))
    .filter((step) => step.enabled !== false || step.quickReplyId || step.additionalActions.length || step.message)
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));

  return {
    targetLabelId,
    targetLabelName,
    minHoursWithoutInteraction: Math.max(1, Number.parseInt(String(source.minHoursWithoutInteraction ?? 1), 10) || 1),
    maxHoursWithoutInteraction: Math.max(1, Number.parseInt(String(source.maxHoursWithoutInteraction ?? 0), 10) || 0),
    maxSendsPerCustomer: Math.max(1, Number.parseInt(String(source.maxSendsPerCustomer ?? normalizedSteps.length), 10) || normalizedSteps.length),
    toleranceMinutes: Math.max(1, Number.parseInt(String(source.toleranceMinutes ?? 5), 10) || 5),
    completionLabel: String(source.completionLabel || 'Encerrado por desistencia').trim() || 'Encerrado por desistencia',
    steps: normalizedSteps,
    models: {},
  };
};

const normalizeFollowUpState = (value = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.entries(value).reduce((accumulator, [key, state]) => {
    const safeKey = String(key || '').trim();
    if (!safeKey || !state || typeof state !== 'object' || Array.isArray(state)) return accumulator;
    accumulator[safeKey] = {
      customerKey: safeKey,
      routineId: String(state.routineId || '').trim(),
      count: Math.max(0, Number.parseInt(String(state.count ?? 0), 10) || 0),
      lastFollowUpAt: state.lastFollowUpAt ? String(state.lastFollowUpAt) : null,
      lastModel: String(state.lastModel || '').trim() || null,
      lastPeriod: String(state.lastPeriod || '').trim() || null,
      status: String(state.status || 'pending').trim() || 'pending',
      completedAt: state.completedAt ? String(state.completedAt) : null,
      updatedAt: state.updatedAt ? String(state.updatedAt) : null,
    };
    return accumulator;
  }, {});
};

const normalizeRoutineAudience = (value = {}) => {
  const type = String(value?.type || '').trim().toLowerCase() === 'manual' ? 'manual' : 'filters';
  const filters = value?.filters && typeof value.filters === 'object' ? value.filters : {};

  return {
    type,
    customerIds: normalizeRoutineArray(value?.customerIds),
    filters: {
      search: String(filters.search || '').trim(),
      status: normalizeRoutineArray(filters.status),
      plans: normalizeRoutineArray(filters.plans),
      tags: normalizeRoutineArray(filters.tags),
      customFields: Array.isArray(filters.customFields)
        ? filters.customFields
            .map((filter) => ({
              field: String(filter?.field || '').trim(),
              operator: String(filter?.operator || 'contains').trim() || 'contains',
              value: String(filter?.value || '').trim(),
            }))
            .filter((filter) => filter.field && filter.value)
        : [],
    },
  };
};

const normalizeRoutineVariables = (value = {}) => ({
  body: Array.isArray(value?.body) ? value.body.map((item) => String(item ?? '').trim()) : [],
  header: Array.isArray(value?.header) ? value.header.map((item) => String(item ?? '').trim()) : [],
  buttons: Array.isArray(value?.buttons)
    ? value.buttons.map((button) => ({
        index: Number.isFinite(Number(button?.index)) ? Number(button.index) : 0,
        type: String(button?.type || '').trim(),
        value: String(button?.value || '').trim(),
      }))
    : [],
});

const ROUTINE_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const LEGACY_WEEKDAY_MAP = {
  mon: 'mon',
  monday: 'mon',
  seg: 'mon',
  tue: 'tue',
  tuesday: 'tue',
  ter: 'tue',
  wed: 'wed',
  wednesday: 'wed',
  qua: 'wed',
  thu: 'thu',
  thursday: 'thu',
  qui: 'thu',
  fri: 'fri',
  friday: 'fri',
  sex: 'fri',
  sat: 'sat',
  saturday: 'sat',
  sab: 'sat',
  'sáb': 'sat',
  sun: 'sun',
  sunday: 'sun',
  dom: 'sun',
};

const normalizeRoutineType = (value) => {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'etiqueta' || type === 'label') return 'etiqueta';
  if (type === 'follow_up' || type === 'followup' || type === 'follow-up') return 'follow_up';
  return 'disparo';
};

const normalizeRoutineRule = (value) => {
  const rule = String(value || '').trim().toLowerCase();
  return ['before_due', 'after_due', 'after_installation'].includes(rule) ? rule : 'before_due';
};

const normalizeRoutineWeeklySchedule = (value = {}, legacyWeekdays = [], legacyTime = '09:00') => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const legacyEnabled = new Set(
    normalizeRoutineArray(legacyWeekdays).map((weekday) => LEGACY_WEEKDAY_MAP[String(weekday).toLowerCase()] || String(weekday).toLowerCase()),
  );
  const hasLegacyWeekdays = legacyEnabled.size > 0;
  const fallbackTime = String(legacyTime || '09:00').slice(0, 5) || '09:00';

  return ROUTINE_WEEKDAYS.reduce((schedule, weekday) => {
    const day = source[weekday] && typeof source[weekday] === 'object' ? source[weekday] : {};
    schedule[weekday] = {
      enabled:
        typeof day.enabled === 'boolean'
          ? day.enabled
          : hasLegacyWeekdays
            ? legacyEnabled.has(weekday)
            : ['mon', 'tue', 'wed', 'thu', 'fri'].includes(weekday),
      time: String(day.time || fallbackTime).slice(0, 5) || fallbackTime,
    };
    return schedule;
  }, {});
};

const normalizeRoutineExceptions = (value) =>
  normalizeRoutineArray(value).filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));

const normalizeRoutineHsm = (value = {}, routine = {}) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    templateId: String(source.templateId || routine?.templateId || '').trim(),
    templateName: String(source.templateName || routine?.templateName || '').trim(),
    language: String(source.language || routine?.templateLanguage || routine?.language || 'pt_BR').trim() || 'pt_BR',
    parameterOverrides: source.parameterOverrides && typeof source.parameterOverrides === 'object' ? source.parameterOverrides : {},
    mediaOverride: source.mediaOverride && typeof source.mediaOverride === 'object' ? source.mediaOverride : {},
  };
};

const normalizeRoutineLabelActions = (value = {}) => ({
  add: canonicalizeLabelIds(value?.add),
  remove: canonicalizeLabelIds(value?.remove),
});

const normalizeRoutine = (routine = {}, index = 0) => {
  const timestamp = nowIso();
  const id = String(routine?.id || `routine-${Date.now().toString(36)}-${index}`).trim();
  const sendIntervalMs = Number.parseInt(String(routine?.sendIntervalMs ?? routine?.intervalMs ?? ''), 10);
  const sendIntervalSeconds = Number.parseInt(String(routine?.sendIntervalSeconds ?? ''), 10);
  const type = normalizeRoutineType(routine?.type);
  const hsm = normalizeRoutineHsm(routine?.hsm, routine);
  const sendMs =
    Number.isFinite(sendIntervalSeconds) && sendIntervalSeconds > 0
      ? sendIntervalSeconds * 1000
      : Number.isFinite(sendIntervalMs) && sendIntervalMs > 0
        ? sendIntervalMs
        : ROUTINE_DEFAULT_INTERVAL_MS;

  return {
    id,
    name: String(routine?.name || `Rotina ${index + 1}`).trim(),
    description: String(routine?.description || '').trim(),
    type,
    status: normalizeRoutineStatus(routine?.status || (routine?.active ? 'active' : 'paused')),
    rule: normalizeRoutineRule(routine?.rule),
    ruleDays: Math.max(0, Number.parseInt(String(routine?.ruleDays ?? 0), 10) || 0),
    templateId: hsm.templateId,
    templateName: hsm.templateName,
    templateLanguage: hsm.language,
    scheduledTime: String(routine?.scheduledTime || routine?.time || '09:00').trim() || '09:00',
    timezone: String(routine?.timezone || 'America/Sao_Paulo').trim() || 'America/Sao_Paulo',
    weekdays: normalizeRoutineArray(routine?.weekdays),
    weeklySchedule: normalizeRoutineWeeklySchedule(routine?.weeklySchedule, routine?.weekdays, routine?.scheduledTime || routine?.time),
    exceptions: normalizeRoutineExceptions(routine?.exceptions),
    audience: normalizeRoutineAudience(routine?.audience),
    variables: normalizeRoutineVariables(routine?.variables),
    sendIntervalMs: sendMs,
    sendIntervalSeconds: Math.max(1, Math.round(sendMs / 1000)),
    hsm: type === 'disparo' ? hsm : null,
    quickReplyId: type === 'disparo' ? String(routine?.quickReplyId || '').trim() || null : null,
    labelActions: type === 'etiqueta' ? normalizeRoutineLabelActions(routine?.labelActions) : { add: [], remove: [] },
    followUp: type === 'follow_up' ? normalizeFollowUpConfig(routine?.followUp) : normalizeFollowUpConfig({}),
    followUpState: type === 'follow_up' ? normalizeFollowUpState(routine?.followUpState) : {},
    lastRunAt: routine?.lastRunAt || null,
    lastRunKey: routine?.lastRunKey || null,
    nextRunAt: routine?.nextRunAt || null,
    lastRunSummary: routine?.lastRunSummary && typeof routine.lastRunSummary === 'object' ? routine.lastRunSummary : null,
    createdAt: String(routine?.createdAt || routine?.created_date || timestamp),
    updatedAt: String(routine?.updatedAt || routine?.updated_date || timestamp),
  };
};

const normalizeRoutinesState = (value = {}) => ({
  ...ROUTINES_DEFAULT_STATE,
  ...(value && typeof value === 'object' ? value : {}),
  items: Array.isArray(value?.items) ? value.items.map((item, index) => normalizeRoutine(item, index)) : [],
  logs: Array.isArray(value?.logs) ? value.logs.slice(0, ROUTINE_LOG_LIMIT) : [],
});


const normalizeStore = (store) => {
  const base = store && typeof store === 'object' ? store : {};
  const users = (Array.isArray(base.users) ? base.users : []).map((user, index) => normalizeUserRecord(user, index));
  const createdAt = users?.[0]?.created_date || nowIso();
  const roles = (Array.isArray(base.roles) ? base.roles : buildDefaultRoles(createdAt)).map((role) => ({
    ...role,
    permissions: normalizeRolePermissions(
      role?.permissions,
      String(role?.name || '').trim().toLowerCase() === 'administrador' ||
      String(role?.department_key || '').trim().toLowerCase() === 'administracao'
        ? ADMIN_ROLE_PERMISSIONS
        : DEFAULT_ROLE_PERMISSIONS,
    ),
  }));
  const services = Array.isArray(base.services)
    ? sortServices(base.services.map((service, index) => normalizeService(service, index)).filter((service) => service.name))
    : buildDefaultServices(users, createdAt);

  return {
    ...base,
    users,
    roles,
    services,
    labels: normalizeLabelsState(base.labels),
    notificationSettings: {
      ...NOTIFICATION_SETTINGS_DEFAULT,
      ...(base.notificationSettings && typeof base.notificationSettings === 'object' ? base.notificationSettings : {}),
    },
    dashboardSettings: normalizeDashboardSettings(base.dashboardSettings),
    dashboardEvents: normalizeDashboardEventsState(base.dashboardEvents),
    customerSyncSettings: normalizeCustomerSyncSettings(base.customerSyncSettings),
    scheduleSettings: normalizeScheduleSettings(base.scheduleSettings),
    tavinhoSettings: normalizeLocalTavinhoSettings(base.tavinhoSettings),
    conversations: Array.isArray(base.conversations) ? base.conversations.map(normalizeConversationLabelFields) : [],
    conversationPreferences: Array.isArray(base.conversationPreferences) ? base.conversationPreferences : [],
    messages: Array.isArray(base.messages) ? base.messages : [],
    tickets: Array.isArray(base.tickets) ? base.tickets.map(normalizeTicketForStorage).filter(Boolean) : [],
    quickReplies: Array.isArray(base.quickReplies) ? base.quickReplies : [],
    quickReplyCategories: Array.isArray(base.quickReplyCategories) ? base.quickReplyCategories : [],
    quickReplySchedules: Array.isArray(base.quickReplySchedules) ? base.quickReplySchedules : [],
    newbrTestSessions: Array.isArray(base.newbrTestSessions) ? base.newbrTestSessions : [],
    newbrTestRequests: Array.isArray(base.newbrTestRequests) ? base.newbrTestRequests : [],
    chatbotFlows: normalizeChatbotFlows(base.chatbotFlows),
    chatbotAssets: Array.isArray(base.chatbotAssets) ? base.chatbotAssets : [],
    chatbotExecutions: base.chatbotExecutions && typeof base.chatbotExecutions === 'object' ? base.chatbotExecutions : {},
    chatbotEvents: Array.isArray(base.chatbotEvents) ? base.chatbotEvents : [],
    customers: Array.isArray(base.customers) ? base.customers : [],
    routines: normalizeRoutinesState(base.routines),
    customerSync: {
      ...CUSTOMER_SYNC_DEFAULT_STATE,
      ...(base.customerSync && typeof base.customerSync === 'object' ? base.customerSync : {}),
      summary: {
        ...CUSTOMER_SYNC_DEFAULT_STATE.summary,
        ...(base.customerSync?.summary && typeof base.customerSync.summary === 'object' ? base.customerSync.summary : {}),
      },
    },
    customerSyncContext: {
      ...CUSTOMER_SYNC_CONTEXT_DEFAULT,
      ...(base.customerSyncContext && typeof base.customerSyncContext === 'object' ? base.customerSyncContext : {}),
    },
    customerSyncLogs: Array.isArray(base.customerSyncLogs) ? base.customerSyncLogs : [],
    attendancePresence: normalizeAttendancePresence(base.attendancePresence),
    auth: normalizeAuthState(base.auth),
  };
};

const seedStore = () => {
  const createdAt = nowIso();
  const users = [
    {
      id: 'user-admin',
      full_name: 'Administrador SaaSTV',
      email: 'admin@saastv.local',
      role: 'admin',
      role_id: 'role-admin',
      role_name: 'Administrador',
      username: 'admin',
      description: 'Usuario principal da instancia local.',
      password_hash: hashPassword(DEFAULT_ADMIN_PASSWORD),
      created_date: createdAt,
      updated_date: createdAt,
    },
  ];
  const roles = buildDefaultRoles(createdAt);
  const services = buildDefaultServices(users, createdAt);

  const conversations = [
    {
      id: 'conv-1',
      contact_name: 'Mariana Costa',
      contact_phone: '+55 11 99876-1122',
      status: 'waiting',
      assigned_agent: users[0].email,
      assigned_agent_name: users[0].full_name,
      department: 'sales',
      priority: 'high',
      last_message: 'Gostaria de entender os planos disponiveis.',
      last_message_time: createdAt,
      unread_count: 2,
      tags: ['lead', 'site'],
      notes: 'Veio da landing page.',
      created_date: createdAt,
      updated_date: createdAt,
    },
    {
      id: 'conv-2',
      contact_name: 'Carlos Lima',
      contact_phone: '+55 21 98765-7788',
      status: 'in_progress',
      assigned_agent: users[0].email,
      assigned_agent_name: users[0].full_name,
      department: 'support',
      priority: 'medium',
      last_message: 'A conexao oscilou ontem a noite.',
      last_message_time: createdAt,
      unread_count: 0,
      tags: ['suporte'],
      notes: 'Cliente ativo.',
      created_date: createdAt,
      updated_date: createdAt,
    },
    {
      id: 'conv-3',
      contact_name: 'Fernanda Rocha',
      contact_phone: '+55 31 99988-4455',
      status: 'resolved',
      assigned_agent: users[0].email,
      assigned_agent_name: users[0].full_name,
      department: 'billing',
      priority: 'low',
      last_message: 'Link de renovacao enviado com sucesso.',
      last_message_time: createdAt,
      unread_count: 0,
      tags: ['financeiro'],
      notes: '',
      created_date: createdAt,
      updated_date: createdAt,
    },
    {
      id: 'conv-4',
      contact_name: 'Joao Pedro',
      contact_phone: '+55 85 98811-2299',
      status: 'closed',
      assigned_agent: users[0].email,
      assigned_agent_name: users[0].full_name,
      department: 'general',
      priority: 'urgent',
      last_message: 'Atendimento finalizado.',
      last_message_time: createdAt,
      unread_count: 0,
      tags: ['vip'],
      notes: 'Atender com prioridade em novos contatos.',
      created_date: createdAt,
      updated_date: createdAt,
    },
  ];

  const messages = [
    {
      id: 'msg-1',
      conversation_id: 'conv-1',
      content: 'Ola, gostaria de entender os planos disponiveis.',
      sender_type: 'contact',
      sender_name: 'Mariana Costa',
      message_type: 'text',
      status: 'read',
      created_date: createdAt,
      updated_date: createdAt,
    },
    {
      id: 'msg-2',
      conversation_id: 'conv-2',
      content: 'A conexao oscilou ontem a noite.',
      sender_type: 'contact',
      sender_name: 'Carlos Lima',
      message_type: 'text',
      status: 'read',
      created_date: createdAt,
      updated_date: createdAt,
    },
    {
      id: 'msg-3',
      conversation_id: 'conv-2',
      content: 'Ja validamos o seu chamado e estamos acompanhando.',
      sender_type: 'agent',
      sender_name: 'Agente',
      message_type: 'text',
      status: 'sent',
      created_date: createdAt,
      updated_date: createdAt,
    },
    {
      id: 'msg-4',
      conversation_id: 'conv-3',
      content: 'Segue o link de renovacao para pagamento.',
      sender_type: 'agent',
      sender_name: 'Agente',
      message_type: 'text',
      status: 'delivered',
      created_date: createdAt,
      updated_date: createdAt,
    },
  ];

  const quickReplies = [
    {
      id: 'qr-1',
      title: 'Boas-vindas',
      content: 'Ola. Seja bem-vindo(a) ao atendimento da SaaSTV. Como posso ajudar?',
      shortcut: '/boasvindas',
      category: 'greeting',
      created_date: createdAt,
      updated_date: createdAt,
    },
    {
      id: 'qr-2',
      title: 'Link de renovacao',
      content: 'Perfeito. Vou gerar e te enviar o link de renovacao agora mesmo.',
      shortcut: '/renovacao',
      category: 'support',
      created_date: createdAt,
      updated_date: createdAt,
    },
  ];

  return normalizeStore({
    users,
    roles,
    services,
    labels: LABELS_DEFAULT_STATE,
    notificationSettings: NOTIFICATION_SETTINGS_DEFAULT,
    dashboardSettings: DASHBOARD_SETTINGS_DEFAULT,
    dashboardEvents: DASHBOARD_EVENTS_DEFAULT,
    customerSyncSettings: CUSTOMER_SYNC_SETTINGS_DEFAULT,
    scheduleSettings: SCHEDULE_SETTINGS_DEFAULT,
    tavinhoSettings: DEFAULT_TAVINHO_SETTINGS,
    conversations,
    conversationPreferences: [],
    messages,
    quickReplies,
    quickReplyCategories: [],
    quickReplySchedules: [],
    chatbotFlows: [],
    chatbotAssets: [],
    chatbotExecutions: {},
    chatbotEvents: [],
    customers: [],
    tickets: [],
    routines: ROUTINES_DEFAULT_STATE,
    customerSync: CUSTOMER_SYNC_DEFAULT_STATE,
    customerSyncContext: CUSTOMER_SYNC_CONTEXT_DEFAULT,
    customerSyncLogs: [],
    auth: AUTH_DEFAULT_STATE,
  });
};

const cloneStoreSnapshot = (store) => structuredClone(normalizeStore(store));

const ensureStore = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!storeCache) {
    const readFromJsonFile = async () => {
      try {
        const raw = await fs.readFile(STORE_PATH, 'utf8');
        return JSON.parse(raw);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return seedStore();
        }
        throw error;
      }
    };
    storeCache = normalizeStore(
      await readJsonBackedStore(STORE_PATH, seedStore(), readFromJsonFile),
    );
  }
};

const readStore = async () => {
  await ensureStore();
  return storeCache;
};

const writeStore = async (store) => {
  const measure = startPerfMeasure();
  await fs.mkdir(DATA_DIR, { recursive: true });
  const nextStore = normalizeStore(store);
  const writeToJsonFile = async () => {
    const tempPath = `${STORE_PATH}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tempPath, JSON.stringify(nextStore, null, 2), 'utf8');

    try {
      await fs.rename(tempPath, STORE_PATH);
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) {
        await fs.copyFile(tempPath, STORE_PATH);
        await fs.unlink(tempPath).catch(() => {});
      } else {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
    }
  };

  try {
    await writeJsonBackedStore(STORE_PATH, nextStore, writeToJsonFile);
    storeCache = nextStore;
    return nextStore;
  } finally {
    const perf = finishPerfMeasure(measure);
    if (shouldLogDuration(perf.durationMs, LOCAL_STORE_WRITE_PERF_THRESHOLD_MS, 250)) {
      logPerf('local-store-perf', {
        durationMs: perf.durationMs,
        cpuUserMs: perf.cpuUserMs,
        cpuSystemMs: perf.cpuSystemMs,
        rssMb: perf.rssMb,
        heapUsedMb: perf.heapUsedMb,
        routines: Array.isArray(nextStore?.routines?.items) ? nextStore.routines.items.length : '',
        routineLogs: Array.isArray(nextStore?.routines?.logs) ? nextStore.routines.logs.length : '',
      });
    }
  }
};

const emptyWhatsappStore = () => ({
  conversations: {},
  messages: {},
  session: {
    status: 'disconnected',
    qrCode: null,
    lastConnectedAt: null,
    updatedAt: null,
  },
});

const readWhatsappStore = async () => {
  const readFromJsonFile = async () => {
    try {
      const raw = await fs.readFile(WHATSAPP_STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : emptyWhatsappStore();
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyWhatsappStore();
      throw error;
    }
  };

  const legacyLoader = async () =>
    readJsonBackedStore(WHATSAPP_STORE_PATH, emptyWhatsappStore(), readFromJsonFile);
  const store = isWhatsappSqliteStoreEnabled()
    ? await readWhatsappSqliteStore({ fallbackLoader: legacyLoader })
    : await legacyLoader();
  return {
    ...emptyWhatsappStore(),
    ...(store && typeof store === 'object' ? store : {}),
    conversations:
      store?.conversations && typeof store.conversations === 'object' && !Array.isArray(store.conversations)
        ? store.conversations
        : {},
    messages:
      store?.messages && typeof store.messages === 'object' && !Array.isArray(store.messages)
        ? store.messages
        : {},
  };
};

const writeWhatsappStore = async (store, { conversationIds = null, fullReplace = false } = {}) => {
  const nextStore = {
    ...emptyWhatsappStore(),
    ...(store && typeof store === 'object' ? store : {}),
    conversations:
      store?.conversations && typeof store.conversations === 'object' && !Array.isArray(store.conversations)
        ? store.conversations
        : {},
    messages:
      store?.messages && typeof store.messages === 'object' && !Array.isArray(store.messages)
        ? store.messages
        : {},
  };
  const writeToJsonFile = async () => {
    await fs.mkdir(path.dirname(WHATSAPP_STORE_PATH), { recursive: true });
    const tempPath = `${WHATSAPP_STORE_PATH}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tempPath, JSON.stringify(nextStore, null, 2), 'utf8');
    await fs.rename(tempPath, WHATSAPP_STORE_PATH);
  };

  if (isWhatsappSqliteStoreEnabled()) {
    await writeWhatsappSqliteStore(nextStore, { conversationIds, fullReplace });
    return nextStore;
  }

  await writeJsonBackedStore(WHATSAPP_STORE_PATH, nextStore, writeToJsonFile);
  return nextStore;
};

const resolveConversationIdCandidates = (conversationId, extraIds = []) =>
  Array.from(
    new Set(
      [conversationId, ...(Array.isArray(extraIds) ? extraIds : [])]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    )
  );

const findWhatsappConversationByIds = (whatsappStore, conversationIds = []) => {
  for (const conversationId of conversationIds) {
    const conversation = whatsappStore.conversations?.[conversationId];
    if (conversation) {
      return { conversationId, conversation };
    }
  }
  return { conversationId: '', conversation: null };
};

const normalizeAssignmentKey = (value) => String(value || '').trim().toLowerCase();

const getLocalUserAssignmentKeys = (user = {}) =>
  [user.id, user.email, user.username].map(normalizeAssignmentKey).filter(Boolean);

const isWhatsappConversationAssignedToLocalUser = (conversation = {}, user = {}) => {
  const userKeys = getLocalUserAssignmentKeys(user);
  const assignedKeys = [
    conversation.assigned_agent,
    conversation.assigned_agent_id,
    conversation.assigned_agent_email,
  ].map(normalizeAssignmentKey).filter(Boolean);
  return assignedKeys.some((key) => userKeys.includes(key));
};

const getConversationAssignmentExclusionKeys = (conversation = {}) =>
  Array.from(
    new Set(
      [
        ...normalizeStringArray(conversation.assignment_excluded_user_ids || conversation.assignmentExcludedUserIds),
        ...normalizeStringArray(conversation.assignment_excluded_user_emails || conversation.assignmentExcludedUserEmails),
        ...normalizeStringArray(conversation.assignment_excluded_usernames || conversation.assignmentExcludedUsernames),
      ]
        .map(normalizeAssignmentKey)
        .filter(Boolean),
    ),
  );

const isUserExcludedFromConversationAssignment = (conversation = {}, user = {}) => {
  const excludedKeys = getConversationAssignmentExclusionKeys(conversation);
  if (!excludedKeys.length) return false;
  const userKeys = getLocalUserAssignmentKeys(user?.sourceUser || user);
  return userKeys.some((key) => excludedKeys.includes(key));
};

const buildAssignmentExclusionPatch = (...users) => {
  const userIds = [];
  const userEmails = [];
  const usernames = [];

  users.filter(Boolean).forEach((user) => {
    const id = String(user?.id || '').trim();
    const email = String(user?.email || '').trim().toLowerCase();
    const username = String(user?.username || '').trim();
    if (id) userIds.push(id);
    if (email) userEmails.push(email);
    if (username) usernames.push(username);
  });

  return {
    assignment_excluded_user_ids: normalizeStringArray(userIds),
    assignment_excluded_user_emails: normalizeStringArray(userEmails),
    assignment_excluded_usernames: normalizeStringArray(usernames),
  };
};

const clearAssignmentExclusionPatch = {
  assignment_excluded_user_ids: [],
  assignment_excluded_user_emails: [],
  assignment_excluded_usernames: [],
  assignment_exclusion_reason: '',
};

const isBroadcastAwaitingCustomerReply = (conversation = {}) => {
  const tags = Array.isArray(conversation.tags)
    ? conversation.tags.map((tag) => normalizeAssignmentKey(tag))
    : [];
  if (!tags.includes('disparo') && !conversation.is_broadcast) return false;

  const lastClientMs = Date.parse(
    String(conversation.lastClientMessageTime || conversation.last_client_message_time || conversation.last_received_at || ''),
  );
  const lastSentMs = Date.parse(String(conversation.last_sent_at || conversation.lastMessageTime || conversation.last_message_at || ''));

  if (!Number.isFinite(lastClientMs) || lastClientMs <= 0) return true;
  if (!Number.isFinite(lastSentMs) || lastSentMs <= 0) return true;
  return lastSentMs >= lastClientMs;
};

const getUserServiceIds = (store = {}, user = {}) => {
  const userId = String(user?.id || '').trim();
  const userEmail = String(user?.email || '').trim().toLowerCase();
  return (Array.isArray(store.services) ? store.services : [])
    .filter((service) => {
      const serviceUserIds = normalizeStringArray(service.user_ids || service.userIds);
      const serviceUserEmails = normalizeStringArray(service.user_emails || service.userEmails).map((email) =>
        email.toLowerCase(),
      );
      return (userId && serviceUserIds.includes(userId)) || (userEmail && serviceUserEmails.includes(userEmail));
    })
    .map((service) => String(service.id || '').trim())
    .filter(Boolean);
};

const conversationMatchesLocalService = (conversation = {}, service = {}) => {
  const serviceLabelIds = expandServiceLabelIds(service.label_ids || service.labelIds);
  if (!serviceLabelIds.length) return false;

  const conversationLabelIds = expandServiceLabelIds(conversation.label_ids || conversation.labelIds);
  return serviceLabelIds.some((labelId) => conversationLabelIds.includes(labelId));
};

const resolveWhatsappConversationServiceIds = (store = {}, conversation = {}) => {
  const services = Array.isArray(store.services) ? store.services : [];
  return services
    .filter((service) => conversationMatchesLocalService(conversation, service))
    .map((service) => String(service.id || '').trim())
    .filter(Boolean);
};

const resolveWhatsappConversationLabelIds = async (conversation = {}) => {
  try {
    const labelConversation = {
      ...conversation,
      phone: conversation.phone || conversation.contact_phone || conversation.contactPhone || conversation.wa_id || conversation.waId || '',
      wa_id: conversation.wa_id || conversation.waId || conversation.contact_phone || conversation.contactPhone || conversation.phone || '',
      customer: {
        ...(conversation.customer && typeof conversation.customer === 'object' ? conversation.customer : {}),
        phone:
          conversation.customer?.phone ||
          conversation.customer?.number ||
          conversation.contact_phone ||
          conversation.contactPhone ||
          conversation.phone ||
          '',
      },
    };
    const resolvedByConversationId = await resolveConversationLabels({ conversations: [labelConversation] });
    const resolved = resolvedByConversationId.get(String(conversation?.id || '').trim()) || null;
    const labels = Array.isArray(resolved?.labels) ? resolved.labels : [];
    return labels.map((label) => String(label?.id || '').trim()).filter(Boolean);
  } catch (error) {
    log(`Falha ao resolver etiquetas da fila: ${error?.message || error}`);
    return normalizeStringArray(conversation.label_ids || conversation.labelIds);
  }
};

const buildWhatsappQueueMetadata = (store = {}, conversation = {}, queuedAt = nowIso(), options = {}) => {
  const targetServiceId = String(options.targetServiceId || '').trim();
  const explicitServiceIds =
    targetServiceId
      ? [targetServiceId]
      : String(conversation?.assignment_source || '').trim() === 'manual_service_queue'
        ? normalizeStringArray(conversation.queued_service_ids || conversation.queuedServiceIds)
        : [];
  const serviceIds = explicitServiceIds.length ? explicitServiceIds : resolveWhatsappConversationServiceIds(store, conversation);
  const services = Array.isArray(store.services) ? store.services : [];
  const serviceNames = serviceIds
    .map((serviceId) => services.find((service) => String(service?.id || '').trim() === serviceId)?.name || '')
    .filter(Boolean);

  return {
    serviceIds,
    patch: {
      queued_service_ids: serviceIds,
      queued_service_id: serviceIds[0] || '',
      queued_service_name: serviceNames[0] || '',
      queued_service_names: serviceNames,
      queue_status: serviceIds.length ? 'waiting' : 'unclassified',
      queued_at: queuedAt,
    },
  };
};

const hasWhatsappConversationAssignment = (conversation = {}) =>
  [
    conversation.assigned_agent,
    conversation.assigned_agent_id,
    conversation.assigned_agent_email,
    conversation.assigned_agent_name,
  ].some((value) => String(value || '').trim());

const getWhatsappAssignedLocalUser = (store = {}, conversation = {}) =>
  (Array.isArray(store.users) ? store.users : []).find((user) =>
    isWhatsappConversationAssignedToLocalUser(conversation, user),
  ) || null;

const getWhatsappAssignmentActivityMs = (conversation = {}) => {
  const timestamps = [
    conversation.assigned_at,
    conversation.assignedAt,
    conversation.last_agent_message_at,
    conversation.lastAgentMessageAt,
    conversation.last_sent_at,
    conversation.lastSentAt,
  ]
    .map((value) => Date.parse(String(value || '')))
    .filter((value) => Number.isFinite(value) && value > 0);
  return timestamps.length ? Math.max(...timestamps) : 0;
};

const hasRecentWhatsappAssignmentActivity = (conversation = {}, referenceMs = nowMs()) => {
  const lastActivityMs = getWhatsappAssignmentActivityMs(conversation);
  return lastActivityMs > 0 && referenceMs - lastActivityMs < ASSIGNMENT_OFFLINE_REQUEUE_GRACE_MS;
};

const shouldRequeueInactiveWhatsappAssignment = ({
  store = {},
  conversation = {},
  activeUsers = [],
  referenceMs = nowMs(),
} = {}) => {
  if (!hasWhatsappConversationAssignment(conversation)) return false;
  const activeAssignedUser = activeUsers.find((user) => isWhatsappConversationAssignedToLocalUser(conversation, user));
  if (activeAssignedUser) return false;

  const assignedUser = getWhatsappAssignedLocalUser(store, conversation);
  if (assignedUser) {
    const activeUserIds = new Set(activeUsers.map((user) => String(user?.id || '').trim()).filter(Boolean));
    if (activeUserIds.has(String(assignedUser.id || '').trim())) return false;
  }

  return !hasRecentWhatsappAssignmentActivity(conversation, referenceMs);
};

const clearInactiveWhatsappAssignment = (conversation = {}, timestamp = nowIso()) => ({
  ...conversation,
  previous_assigned_agent: conversation.assigned_agent || '',
  previous_assigned_agent_id: conversation.assigned_agent_id || '',
  previous_assigned_agent_email: conversation.assigned_agent_email || '',
  previous_assigned_agent_name: conversation.assigned_agent_name || '',
  assignment_requeued_at: timestamp,
  assigned_agent: '',
  assigned_agent_id: '',
  assigned_agent_email: '',
  assigned_agent_name: '',
  assigned_at: '',
  assignment_source: 'agent_logout_queue',
  assignment_exclusion_reason: 'offline_requeue',
});

const getConversationPreferenceKey = (preference = {}) =>
  String(preference?.conversation_id || preference?.conversationId || preference?.id || '').trim();

const getConversationPreferenceTime = (preference = {}) => {
  const candidates = [
    preference?.updated_date,
    preference?.created_date,
    preference?.pinned_at,
    preference?.manual_unread_at,
    preference?.resolved_at,
  ];
  return Math.max(
    0,
    ...candidates.map((value) => {
      const time = Date.parse(String(value || ''));
      return Number.isFinite(time) ? time : 0;
    }),
  );
};

const buildConversationPreferenceMap = (store = {}) => {
  const map = new Map();
  (Array.isArray(store.conversationPreferences) ? store.conversationPreferences : []).forEach((preference) => {
    const conversationId = getConversationPreferenceKey(preference);
    if (!conversationId) return;

    const current = map.get(conversationId);
    if (!current || getConversationPreferenceTime(preference) > getConversationPreferenceTime(current)) {
      map.set(conversationId, preference);
    }
  });
  return map;
};

const isConversationResolutionActive = (preference = null, conversation = {}) => {
  if (!preference || String(preference?.resolution_status || '').trim() !== 'resolved') return false;
  const resolvedAtMs = Date.parse(String(preference.resolved_at || ''));
  if (!Number.isFinite(resolvedAtMs) || resolvedAtMs <= 0) return false;
  const lastClientMs = Date.parse(
    String(conversation.lastClientMessageTime || conversation.last_client_message_time || conversation.last_received_at || ''),
  );
  return !(Number.isFinite(lastClientMs) && lastClientMs > resolvedAtMs);
};

const getActiveAttendingUsers = (store = {}) => {
  const usersById = new Map((Array.isArray(store.users) ? store.users : []).map((user) => [String(user.id || '').trim(), user]));

  return [...getActiveAttendingUserIds(store)]
    .map((userId) => {
      const user = usersById.get(userId);
      if (!user) return null;
      return {
        id: String(user.id || userId).trim(),
        email: String(user.email || '').trim().toLowerCase(),
        name: String(user.full_name || user.username || user.email || '').trim() || 'Operador',
        sourceUser: user,
      };
    })
    .filter(Boolean);
};

const countOpenAssignedWhatsappConversations = (whatsappStore = {}, store = {}, activeUsers = []) => {
  const preferenceMap = buildConversationPreferenceMap(store);
  const counts = new Map(activeUsers.map((user) => [user.id, 0]));

  Object.values(whatsappStore.conversations || {}).forEach((conversation) => {
    const preference = preferenceMap.get(String(conversation?.id || '').trim());
    if (isConversationResolutionActive(preference, conversation)) return;
    const assignedUser = activeUsers.find((user) => isWhatsappConversationAssignedToLocalUser(conversation, user));
    if (!assignedUser) return;
    counts.set(assignedUser.id, (counts.get(assignedUser.id) || 0) + 1);
  });

  return counts;
};

const chooseBalancedActiveUser = (candidates = [], counts = new Map()) => {
  if (!candidates.length) return null;
  const minCount = Math.min(...candidates.map((user) => counts.get(user.id) || 0));
  const balancedCandidates = candidates.filter((user) => (counts.get(user.id) || 0) === minCount);
  return balancedCandidates[Math.floor(Math.random() * balancedCandidates.length)] || null;
};

const removeAttendancePresenceForUser = async (userId) => {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return false;

  const sqlRemoved = deleteSqlAttendancePresenceByUserId(safeUserId);
  const legacyRemoved = await removeLegacyAttendancePresenceForUser(safeUserId);
  return sqlRemoved > 0 || legacyRemoved;
};

const removeLegacyAttendancePresenceForUser = async (userId) => {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return false;
  let removed = false;
  await updateStore((store) => {
    const currentPresence = normalizeAttendancePresence(store.attendancePresence);
    const nextPresence = currentPresence.filter((presence) => presence.user_id !== safeUserId);
    removed = nextPresence.length !== currentPresence.length;
    store.attendancePresence = nextPresence;
    return removed ? store : false;
  });
  return removed;
};

const requeueWhatsappAssignmentsForLogout = async (store = {}, user = {}) => {
  const userKeys = getLocalUserAssignmentKeys(user);
  if (!userKeys.length) return [];

  const whatsappStore = await readWhatsappStore();
  const preferenceMap = buildConversationPreferenceMap(store);
  const changed = [];
  const timestamp = nowIso();

  for (const [conversationId, conversation] of Object.entries(whatsappStore.conversations || {})) {
    if (!isWhatsappConversationAssignedToLocalUser(conversation, user)) continue;
    const preference = preferenceMap.get(String(conversation?.id || conversationId).trim());
    if (isConversationResolutionActive(preference, conversation)) continue;

    const labelIds = normalizeStringArray(conversation.label_ids || conversation.labelIds);
    const queuedConversationBase = {
      ...conversation,
      label_ids: labelIds.length > 0 ? labelIds : await resolveWhatsappConversationLabelIds(conversation),
    };
    const queueMetadata = buildWhatsappQueueMetadata(store, queuedConversationBase, timestamp);

    whatsappStore.conversations[conversationId] = {
      ...queuedConversationBase,
      ...queueMetadata.patch,
      previous_assigned_agent: conversation.assigned_agent || '',
      previous_assigned_agent_id: conversation.assigned_agent_id || '',
      previous_assigned_agent_email: conversation.assigned_agent_email || '',
      previous_assigned_agent_name: conversation.assigned_agent_name || '',
      assignment_requeued_at: timestamp,
      assigned_agent: '',
      assigned_agent_id: '',
      assigned_agent_email: '',
      assigned_agent_name: '',
      assigned_at: '',
      assignment_source: queueMetadata.serviceIds.length ? 'agent_logout_queue' : 'unclassified_queue',
      assignment_exclusion_reason: 'logout_requeue',
    };
    changed.push(conversationId);
  }

  if (changed.length > 0) {
    await writeWhatsappStore(whatsappStore, { conversationIds: changed });
    publishLocalEvent('conversation:assignment-updated', {
      action: 'agent_logout_queue',
      conversation_ids: changed,
      user_id: String(user?.id || '').trim(),
    });
  }

  return changed;
};

const requeueWhatsappConversationForService = async ({
  store = {},
  conversationId = '',
  sourceConversationIds = [],
  requester = null,
  assignmentSource = 'manual_service_queue',
  targetServiceId = '',
} = {}) => {
  const whatsappStore = await readWhatsappStore();
  const resolved = findWhatsappConversationByIds(
    whatsappStore,
    resolveConversationIdCandidates(conversationId, sourceConversationIds),
  );

  if (!resolved.conversation) {
    return { ok: false, status: 404, error: 'Conversa nao encontrada.' };
  }

  const assignedUser = (Array.isArray(store.users) ? store.users : []).find((user) =>
    isWhatsappConversationAssignedToLocalUser(resolved.conversation, user),
  );
  const labelIds = normalizeStringArray(resolved.conversation.label_ids || resolved.conversation.labelIds);
  let nextConversationBase = {
    ...resolved.conversation,
    label_ids: labelIds.length > 0 ? labelIds : await resolveWhatsappConversationLabelIds(resolved.conversation),
  };
  const safeTargetServiceId = String(targetServiceId || '').trim();
  let targetService = null;
  if (safeTargetServiceId) {
    targetService = (Array.isArray(store.services) ? store.services : []).find(
      (service) => String(service?.id || '').trim() === safeTargetServiceId,
    );
    if (!targetService) {
      return { ok: false, status: 404, error: 'Servico de destino nao encontrado.' };
    }
  }
  const queuedAt = nowIso();
  const serviceTransferLabels = applyServiceTransferLabels(store, nextConversationBase, targetService, queuedAt);
  if (serviceTransferLabels.error) {
    return { ok: false, status: 422, error: serviceTransferLabels.error };
  }
  nextConversationBase = serviceTransferLabels.conversation;
  if (targetService) {
    store = syncServiceCustomLabelAssignments(store, resolved.conversationId, nextConversationBase, serviceTransferLabels.labelIds);
    await writeStore(store);
  }
  const queueMetadata = buildWhatsappQueueMetadata(store, nextConversationBase, queuedAt, {
    targetServiceId: safeTargetServiceId,
  });
  const exclusionPatch = buildAssignmentExclusionPatch(requester, assignedUser);

  const queuedConversation = {
    ...nextConversationBase,
    ...queueMetadata.patch,
    ...exclusionPatch,
    previous_assigned_agent: resolved.conversation.assigned_agent || '',
    previous_assigned_agent_id: resolved.conversation.assigned_agent_id || '',
    previous_assigned_agent_email: resolved.conversation.assigned_agent_email || '',
    previous_assigned_agent_name: resolved.conversation.assigned_agent_name || '',
    assigned_agent: '',
    assigned_agent_id: '',
    assigned_agent_email: '',
    assigned_agent_name: '',
    assigned_at: '',
    assignment_source: queueMetadata.serviceIds.length ? assignmentSource : 'unclassified_queue',
    assignment_exclusion_reason: 'manual_requeue',
  };

  whatsappStore.conversations[resolved.conversationId] = queuedConversation;
  await writeWhatsappStore(whatsappStore, { conversationIds: [resolved.conversationId] });

  publishLocalEvent('conversation:assignment-updated', {
    action: assignmentSource,
    conversation_ids: [resolved.conversationId],
    queued_conversation_ids: queueMetadata.serviceIds.length ? [resolved.conversationId] : [],
    unclassified_conversation_ids: queueMetadata.serviceIds.length ? [] : [resolved.conversationId],
    excluded_user_ids: exclusionPatch.assignment_excluded_user_ids,
    excluded_user_emails: exclusionPatch.assignment_excluded_user_emails,
  });

  await assignQueuedWhatsappConversations(store);
  const refreshedWhatsappStore = await readWhatsappStore();
  const refreshed = findWhatsappConversationByIds(refreshedWhatsappStore, [resolved.conversationId]);

  return {
    ok: true,
    status: 200,
    conversationId: resolved.conversationId,
    conversation: refreshed.conversation || queuedConversation,
  };
};

const assignQueuedWhatsappConversations = async (store = {}) => {
  const activeUsers = getActiveAttendingUsers(store);

  const whatsappStore = await readWhatsappStore();
  const preferenceMap = buildConversationPreferenceMap(store);
  const counts = countOpenAssignedWhatsappConversations(whatsappStore, store, activeUsers);
  const assigned = [];
  const queued = [];
  const unclassified = [];
  const requeued = [];
  const assignedAt = nowIso();
  const referenceMs = nowMs();

  for (const [conversationId, conversation] of Object.entries(whatsappStore.conversations || {})) {
    const hadAssignment = hasWhatsappConversationAssignment(conversation);
    if (
      hadAssignment &&
      !shouldRequeueInactiveWhatsappAssignment({ store, conversation, activeUsers, referenceMs })
    ) {
      continue;
    }
    const preference = preferenceMap.get(String(conversation?.id || conversationId).trim());
    if (isConversationResolutionActive(preference, conversation)) continue;

    const queueCandidate = hadAssignment ? clearInactiveWhatsappAssignment(conversation, assignedAt) : conversation;
    if (hadAssignment) {
      requeued.push(conversationId);
    }

    const currentLabelIds = normalizeStringArray(queueCandidate.label_ids || queueCandidate.labelIds);
    if (
      currentLabelIds.length === 0 &&
      String(queueCandidate?.assignment_source || '').trim() === 'unclassified_queue' &&
      String(queueCandidate?.queue_status || '').trim() === 'unclassified'
    ) {
      continue;
    }

    const labelIds = currentLabelIds.length > 0 ? currentLabelIds : await resolveWhatsappConversationLabelIds(queueCandidate);
    const nextConversation = {
      ...queueCandidate,
      label_ids: labelIds.length > 0 ? labelIds : normalizeStringArray(queueCandidate.label_ids || queueCandidate.labelIds),
    };

    const queueMetadata = buildWhatsappQueueMetadata(store, nextConversation, nextConversation.queued_at || assignedAt);
    Object.assign(nextConversation, queueMetadata.patch);

    if (!queueMetadata.serviceIds.length) {
      if (
        String(queueCandidate?.assignment_source || '').trim() === 'unclassified_queue' &&
        String(queueCandidate?.queue_status || '').trim() === 'unclassified'
      ) {
        continue;
      }
      nextConversation.assignment_source = 'unclassified_queue';
      whatsappStore.conversations[conversationId] = nextConversation;
      unclassified.push(conversationId);
      continue;
    }

    if (isBroadcastAwaitingCustomerReply(nextConversation)) {
      if (
        String(queueCandidate?.queue_status || '').trim() === 'waiting' &&
        String(queueCandidate?.assignment_source || '').trim() === 'broadcast_service_queue' &&
        sameStringArrayValues(queueCandidate.queued_service_ids, queueMetadata.serviceIds)
      ) {
        continue;
      }
      nextConversation.assignment_source = 'broadcast_service_queue';
      whatsappStore.conversations[conversationId] = nextConversation;
      queued.push(conversationId);
      continue;
    }

    const candidates = activeUsers.filter((user) => {
      if (isUserExcludedFromConversationAssignment(nextConversation, user)) return false;
      const userServiceIds = getUserServiceIds(store, user.sourceUser || user);
      return queueMetadata.serviceIds.some((serviceId) => userServiceIds.includes(serviceId));
    });

    if (!candidates.length) {
      if (
        String(queueCandidate?.queue_status || '').trim() === 'waiting' &&
        ['service_queue', 'agent_logout_queue'].includes(String(queueCandidate?.assignment_source || '').trim()) &&
        sameStringArrayValues(queueCandidate.queued_service_ids, queueMetadata.serviceIds)
      ) {
        continue;
      }
      nextConversation.assignment_source =
        String(nextConversation.assignment_source || '').trim() === 'agent_logout_queue'
          ? 'agent_logout_queue'
          : 'service_queue';
      whatsappStore.conversations[conversationId] = nextConversation;
      queued.push(conversationId);
      continue;
    }

    const selectedUser = chooseBalancedActiveUser(candidates, counts);
    if (!selectedUser) {
      nextConversation.assignment_source = 'service_queue';
      whatsappStore.conversations[conversationId] = nextConversation;
      queued.push(conversationId);
      continue;
    }

    whatsappStore.conversations[conversationId] = {
      ...nextConversation,
      ...clearAssignmentExclusionPatch,
      assigned_agent: selectedUser.email || selectedUser.id,
      assigned_agent_id: selectedUser.id,
      assigned_agent_email: selectedUser.email || '',
      assigned_agent_name: selectedUser.name,
      assigned_at: assignedAt,
      assignment_source: 'agent_login_distribution',
      queue_status: 'assigned',
      queued_at: '',
    };
    counts.set(selectedUser.id, (counts.get(selectedUser.id) || 0) + 1);
    assigned.push({
      conversation_id: conversationId,
      assigned_agent_id: selectedUser.id,
      assigned_agent_email: selectedUser.email,
      assigned_agent_name: selectedUser.name,
    });
  }

  if (assigned.length > 0 || queued.length > 0 || unclassified.length > 0 || requeued.length > 0) {
    const changedConversationIds = [
      ...assigned.map((item) => item.conversation_id),
      ...queued,
      ...unclassified,
      ...requeued,
    ];
    await writeWhatsappStore(whatsappStore, { conversationIds: changedConversationIds });
    publishLocalEvent('conversation:assignment-updated', {
      action: assigned.length > 0 ? 'agent_login_distribution' : 'service_queue_updated',
      assignments: assigned,
      conversation_ids: assigned.map((item) => item.conversation_id),
      queued_conversation_ids: queued,
      unclassified_conversation_ids: unclassified,
      requeued_conversation_ids: requeued,
    });
  }

  return assigned;
};

const clearWhatsappConversationAssignment = async (conversationIds = []) => {
  const safeIds = resolveConversationIdCandidates('', conversationIds);
  if (!safeIds.length) return false;

  const whatsappStore = await readWhatsappStore();
  let mutated = false;
  for (const conversationId of safeIds) {
    const conversation = whatsappStore.conversations?.[conversationId];
    if (!conversation) continue;
    whatsappStore.conversations[conversationId] = {
      ...conversation,
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
    };
    mutated = true;
  }

  if (mutated) {
    await writeWhatsappStore(whatsappStore, { conversationIds: safeIds });
  }
  return mutated;
};

const updateStore = async (mutate) => {
  const operation = storeWriteQueue.then(async () => {
    const current = await readStore();
    const workingCopy = cloneStoreSnapshot(current);
    const mutationResult = await mutate(workingCopy);
    if (mutationResult === false) {
      return current;
    }
    const next = mutationResult || workingCopy;
    return await writeStore(next);
  });

  storeWriteQueue = operation.catch(() => {});
  return await operation;
};

const sendJson = (res, statusCode, payload, headers = {}) => {
  const requestOrigin = res.req?.headers?.origin;
  const allowOrigin = requestOrigin || '*';

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
    ...headers,
  });
  res.end(JSON.stringify(payload));
};

const sendJsonText = (res, statusCode, jsonText, headers = {}) => {
  const requestOrigin = res.req?.headers?.origin;
  const allowOrigin = requestOrigin || '*';

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
    ...headers,
  });
  res.end(jsonText);
};

const publishLocalEvent = (eventName, payload = {}) =>
  publishLocalEventToClients(eventName, payload, { nowIso });

const publishConversationPreferenceEvent = (preference = {}, action = 'updated') => {
  const conversationId = String(preference?.conversation_id || preference?.id || '').trim();
  if (!conversationId) return;
  publishLocalEvent('conversation:preference-updated', {
    action,
    conversation_id: conversationId,
    preference,
  });
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

const isInternalLoopbackRequest = (req) => {
  const remoteAddress = req.socket?.remoteAddress || '';
  const isLoopback =
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1';

  return Boolean(isLoopback && !req.headers.origin && !req.headers['x-forwarded-for']);
};

const getCollectionName = (entityName) => entityMap[entityName] || null;

const sortItems = (items, sortBy) => {
  if (!sortBy) return items;
  const descending = String(sortBy).startsWith('-');
  const field = descending ? String(sortBy).slice(1) : String(sortBy);
  return [...items].sort((left, right) => {
    const leftValue = left?.[field];
    const rightValue = right?.[field];
    if (leftValue == null && rightValue == null) return 0;
    if (leftValue == null) return descending ? 1 : -1;
    if (rightValue == null) return descending ? -1 : 1;
    if (field.endsWith('_date') || field.endsWith('_time') || field.endsWith('_at')) {
      const leftTime = Date.parse(leftValue) || 0;
      const rightTime = Date.parse(rightValue) || 0;
      return descending ? rightTime - leftTime : leftTime - rightTime;
    }
    const result = String(leftValue).localeCompare(String(rightValue), 'pt-BR', { numeric: true, sensitivity: 'base' });
    return descending ? result * -1 : result;
  });
};

const applyLimit = (items, limitRaw) => {
  const limit = Number.parseInt(limitRaw || '', 10);
  return Number.isFinite(limit) && limit > 0 ? items.slice(0, limit) : items;
};

const createId = (entityName, payload) => {
  const base =
    entityName === 'QuickReply'
      ? payload?.title
      : entityName === 'QuickReplySchedule'
        ? payload?.title || payload?.conversationId || payload?.quickReplyId
      : entityName === 'Conversation'
        ? payload?.contact_name
        : entityName === 'Role'
          ? payload?.name
          : entityName === 'Service'
            ? payload?.name
        : entityName === 'User'
          ? payload?.full_name
          : payload?.conversation_id || entityName;
  return `${entityName.toLowerCase()}-${toSlug(base)}-${Date.now().toString(36)}`;
};

const mergeEntity = (existing, patch) => ({
  ...existing,
  ...patch,
  updated_date: nowIso(),
});

const findEntityItemIndex = (items = [], entityName, itemId, payload = {}) => {
  if (entityName !== 'ConversationPreference') {
    return items.findIndex((item) => String(item?.id) === String(itemId));
  }

  const candidates = [
    itemId,
    payload?.id,
    payload?.conversation_id,
    payload?.conversationId,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!candidates.length) return -1;
  const candidateSet = new Set(candidates);

  return items.findIndex((item) => {
    const itemIdValue = String(item?.id || '').trim();
    const itemConversationId = getConversationPreferenceKey(item);
    return candidateSet.has(itemIdValue) || candidateSet.has(itemConversationId);
  });
};

const normalizeConversationPreferenceForStorage = (payload = {}, existing = null, fallbackId = '', timestamp = nowIso()) => {
  const conversationId = String(
    payload?.conversation_id ||
      payload?.conversationId ||
      existing?.conversation_id ||
      existing?.conversationId ||
      fallbackId ||
      payload?.id ||
      existing?.id ||
      '',
  ).trim();
  const id = String(existing?.id || payload?.id || conversationId || createId('ConversationPreference', payload)).trim();

  return {
    ...(existing || {}),
    ...payload,
    id,
    conversation_id: conversationId || id,
    created_date: existing?.created_date || payload?.created_date || timestamp,
    updated_date: timestamp,
  };
};

const upsertConversationPreferenceInItems = (items = [], payload = {}, { itemId = '', timestamp = nowIso() } = {}) => {
  const index = findEntityItemIndex(items, 'ConversationPreference', itemId, payload);
  const existing = index >= 0 ? items[index] : null;
  const item = normalizeConversationPreferenceForStorage(payload, existing, itemId, timestamp);
  const itemConversationId = getConversationPreferenceKey(item);
  let inserted = false;

  const nextItems = items.reduce((acc, current, currentIndex) => {
    const currentConversationId = getConversationPreferenceKey(current);
    const isSameConversation = itemConversationId && currentConversationId === itemConversationId;
    const isSelectedItem = currentIndex === index;

    if (isSameConversation || isSelectedItem) {
      if (!inserted) {
        acc.push(item);
        inserted = true;
      }
      return acc;
    }

    acc.push(current);
    return acc;
  }, []);

  if (!inserted) {
    nextItems.unshift(item);
  }

  return { item, items: nextItems, existed: index >= 0 };
};

const normalizeQuickReplyScheduleForStorage = (payload = {}, existing = null, timestamp = nowIso()) => {
  const scheduledAt = String(payload.scheduledAt || '').trim();
  const scheduledMs = Date.parse(scheduledAt);
  if (!String(payload.conversationId || '').trim()) {
    throw new SyncError('Agendamento precisa estar vinculado a uma conversa.', 400, 'invalid_quick_reply_schedule');
  }
  if (!String(payload.quickReplyId || '').trim() && !String(payload.hsmTemplateId || payload.hsmTemplateName || '').trim()) {
    throw new SyncError('Selecione uma resposta rápida.', 400, 'invalid_quick_reply_schedule');
  }
  if (!String(payload.scheduledDate || '').trim()) {
    throw new SyncError('Informe a data do agendamento.', 400, 'invalid_quick_reply_schedule');
  }
  if (!String(payload.scheduledTime || '').trim()) {
    throw new SyncError('Informe a hora do agendamento.', 400, 'invalid_quick_reply_schedule');
  }
  if (!Number.isFinite(scheduledMs) || scheduledMs < Date.now() - 30000) {
    throw new SyncError('Data e hora do agendamento inválidas.', 400, 'invalid_quick_reply_schedule');
  }
  const windowExpiresMs = Date.parse(String(payload.windowExpiresAt || ''));
  if (Number.isFinite(windowExpiresMs) && scheduledMs > windowExpiresMs && !String(payload.hsmTemplateId || payload.hsmTemplateName || '').trim()) {
    throw new SyncError('Selecione um HSM para envio fora das 24h.', 400, 'invalid_quick_reply_schedule');
  }

  return {
    ...existing,
    ...payload,
    id: existing?.id || payload.id || createId('QuickReplySchedule', payload),
    title: String(payload.title || '').trim(),
    conversationId: String(payload.conversationId || '').trim(),
    customerId: String(payload.customerId || '').trim(),
    customerName: String(payload.customerName || '').trim(),
    customerPhone: String(payload.customerPhone || '').trim(),
    quickReplyId: String(payload.quickReplyId || '').trim(),
    scheduledDate: String(payload.scheduledDate || '').trim(),
    scheduledTime: String(payload.scheduledTime || '').trim(),
    scheduledAt,
    status: String(payload.status || existing?.status || 'pending').trim() || 'pending',
    deliveryType: String(payload.deliveryType || existing?.deliveryType || '').trim(),
    quickReplySnapshot: payload.quickReplySnapshot && typeof payload.quickReplySnapshot === 'object' ? payload.quickReplySnapshot : null,
    hsmVariables: payload.hsmVariables && typeof payload.hsmVariables === 'object' ? payload.hsmVariables : {},
    hsmMedia: payload.hsmMedia && typeof payload.hsmMedia === 'object' ? payload.hsmMedia : {},
    conversationSnapshot: payload.conversationSnapshot && typeof payload.conversationSnapshot === 'object' ? payload.conversationSnapshot : {},
    created_date: existing?.created_date || payload.created_date || timestamp,
    updated_date: timestamp,
  };
};

const prepareUserForStorage = (payload = {}, existingUser = null, timestamp = nowIso()) => {
  const rawPassword = String(payload?.password || '').trim();
  const inheritedPasswordHash = String(existingUser?.password_hash || payload?.password_hash || payload?.passwordHash || '').trim();
  const nextPasswordHash = rawPassword ? hashPassword(rawPassword) : inheritedPasswordHash;

  if (!nextPasswordHash) {
    throw new SyncError('Informe uma senha inicial para este usuário.', 400, 'invalid_user');
  }

  return normalizeUserRecord(
    {
      ...existingUser,
      ...payload,
      password_hash: nextPasswordHash,
      password: '',
      created_date: existingUser?.created_date || payload?.created_date || timestamp,
      updated_date: timestamp,
    },
    0,
    timestamp,
  );
};

const getLabelsState = (store) => normalizeLabelsState(store?.labels);

const persistLabelsState = async (mutate) => {
  let savedState = LABELS_DEFAULT_STATE;

  await updateStore((store) => {
    const currentState = getLabelsState(store);
    const nextState = mutate(currentState, store) || currentState;
    savedState = {
      ...normalizeLabelsState(nextState),
      updatedAt: nowIso(),
    };
    store.labels = savedState;
    return store;
  });

  return savedState;
};

const mergeImportedLabelsState = (currentState, payload) => {
  const incomingState = normalizeLabelsState(payload);
  const labelMap = new Map();

  currentState.customLabels.forEach((label) => {
    labelMap.set(label.id, label);
  });

  incomingState.customLabels.forEach((label) => {
    labelMap.set(label.id, label);
  });

  const mergedCustomLabels = sortLabels(Array.from(labelMap.values()));
  const allowedLabelIds = new Set(mergedCustomLabels.map((label) => label.id));
  const mergedAssignments = {};
  const mergedAssignmentEntries = [
    ...Object.entries(currentState.assignments || {}),
    ...Object.entries(incomingState.assignments || {}),
  ];

  mergedAssignmentEntries.forEach(([conversationId, labelIds]) => {
    const safeConversationId = String(conversationId || '').trim();
    if (!safeConversationId) {
      return;
    }

    const nextIds = new Set(mergedAssignments[safeConversationId] || []);
    (Array.isArray(labelIds) ? labelIds : []).forEach((labelId) => {
      const safeLabelId = String(labelId || '').trim();
      if (safeLabelId && allowedLabelIds.has(safeLabelId)) {
        nextIds.add(safeLabelId);
      }
    });

    if (nextIds.size > 0) {
      mergedAssignments[safeConversationId] = Array.from(nextIds);
    }
  });

  return normalizeLabelsState({
    customLabels: mergedCustomLabels,
    assignments: mergedAssignments,
    stageAssignments: {
      ...(currentState.stageAssignments || {}),
      ...(incomingState.stageAssignments || {}),
    },
  });
};

const findUserRole = (store, user) =>
  (Array.isArray(store?.roles) ? store.roles : []).find(
    (role) =>
      String(role?.id || '').trim() === String(user?.role_id || '').trim() ||
      String(role?.name || '').trim() === String(user?.role_name || user?.role || '').trim(),
  ) || null;

const canManageTeamSessions = (store, user) => {
  const role = findUserRole(store, user);
  return Boolean(
    user &&
      (String(user.role || '').trim().toLowerCase() === 'admin' ||
        String(user.role_name || '').trim().toLowerCase() === 'administrador' ||
        role?.permissions?.settings),
  );
};

const isAdminUser = (store, user) => {
  const role = findUserRole(store, user);
  return Boolean(
    user &&
      (String(user.role || '').trim().toLowerCase() === 'admin' ||
        String(user.role_name || '').trim().toLowerCase() === 'administrador' ||
        String(role?.name || '').trim().toLowerCase() === 'administrador' ||
        String(role?.department_key || '').trim().toLowerCase() === 'administracao')
  );
};


const sanitizeAuthenticatedUserForClient = (store, user = {}) => {
  const role = findUserRole(store, user);
  const admin = isAdminUser(store, user);
  const permissions = admin
    ? { ...ADMIN_ROLE_PERMISSIONS }
    : normalizeRolePermissions(role?.permissions, DEFAULT_ROLE_PERMISSIONS);
  const settingsAccess = role?.settings_access || role?.settingsAccess || null;

  return {
    ...sanitizeUserForClient(user),
    role_id: String(user.role_id || role?.id || '').trim(),
    role_name: String(user.role_name || user.role || role?.name || '').trim(),
    department_key: String(role?.department_key || '').trim(),
    role_permissions: permissions,
    permissions,
    settings_access: settingsAccess,
  };
};

const isPresenceDistributionPaused = (presence = {}, referenceMs = nowMs()) => {
  const pausedUntilMs = Date.parse(String(presence?.paused_until || presence?.pausedUntil || ''));
  return Number.isFinite(pausedUntilMs) && pausedUntilMs > referenceMs;
};

const getPresencePauseRemainingMs = (presence = {}, referenceMs = nowMs()) => {
  const pausedUntilMs = Date.parse(String(presence?.paused_until || presence?.pausedUntil || ''));
  return Number.isFinite(pausedUntilMs) ? Math.max(0, pausedUntilMs - referenceMs) : 0;
};

const buildAttendancePresenceRecord = (store, user, previousPresence = null) => {
  const timestamp = nowIso();
  const paused = previousPresence && isPresenceDistributionPaused(previousPresence);
  return {
    user_id: String(user?.id || '').trim(),
    user_name:
      String(user?.full_name || user?.name || user?.username || user?.email || '').trim() ||
      'Operador',
    role: String(user?.role_name || user?.role || '').trim(),
    status: isAdminUser(store, user) ? 'admin' : paused ? 'paused' : 'attending',
    paused_until: paused ? String(previousPresence.paused_until || '').trim() : '',
    pause_reason: paused ? String(previousPresence.pause_reason || 'distribution_pause').trim() : '',
    pause_reason_label: paused ? String(previousPresence.pause_reason_label || ATTENDANCE_DISTRIBUTION_PAUSE_REASONS[previousPresence.pause_reason] || '').trim() : '',
    last_seen_at: timestamp,
    updated_at: timestamp,
  };
};

const attendancePresenceTouchCache = new Map();
let queuedAssignmentDrainTimer = null;

const persistAttendancePresenceRecord = async (record) => {
  if (!record?.user_id || !record?.last_seen_at) return false;
  if (upsertSqlAttendancePresence(record)) {
    return true;
  }

  await updateStore((store) => {
    const currentItems = normalizeAttendancePresence(store.attendancePresence);
    store.attendancePresence = [
      ...currentItems.filter((item) => item.user_id !== record.user_id),
      record,
    ];
    return store;
  });
  return true;
};

const touchAttendancePresenceForUser = async (storeSnapshot = {}, user = {}, options = {}) => {
  const safeUserId = String(user?.id || '').trim();
  if (!safeUserId) return null;

  if (isAdminUser(storeSnapshot, user)) {
    attendancePresenceTouchCache.delete(safeUserId);
    await removeAttendancePresenceForUser(safeUserId);
    return null;
  }

  const force = options?.force === true;
  const currentMs = nowMs();
  const previousTouchMs = attendancePresenceTouchCache.get(safeUserId) || 0;
  if (!force && currentMs - previousTouchMs < ATTENDANCE_PRESENCE_TOUCH_INTERVAL_MS) {
    return getPersistedAttendancePresenceForUser(storeSnapshot, safeUserId);
  }

  const previousPresence = getPersistedAttendancePresenceForUser(storeSnapshot, safeUserId);
  const nextPresence = buildAttendancePresenceRecord(storeSnapshot, user, previousPresence);
  await persistAttendancePresenceRecord(nextPresence);
  attendancePresenceTouchCache.set(safeUserId, currentMs);
  return nextPresence;
};

const scheduleQueuedWhatsappAssignmentDrain = (reason = 'presence_touch') => {
  if (queuedAssignmentDrainTimer) return;
  queuedAssignmentDrainTimer = setTimeout(() => {
    queuedAssignmentDrainTimer = null;
    void (async () => {
      try {
        const startedAt = nowMs();
        const refreshedStore = await readStore();
        const assignments = await assignQueuedWhatsappConversations(refreshedStore);
        const elapsedMs = nowMs() - startedAt;
        if (assignments.length > 0) {
          log(`Redistribuicao de fila concluida (${reason}): ${assignments.length} conversa(s) em ${elapsedMs}ms.`);
        } else if (elapsedMs >= 1500) {
          log(`Redistribuicao de fila sem novas atribuicoes (${reason}) levou ${elapsedMs}ms.`);
        }
      } catch (error) {
        log(`Falha ao redistribuir fila (${reason}): ${error?.message || error}`);
      }
    })();
  }, 250);
  if (typeof queuedAssignmentDrainTimer.unref === 'function') {
    queuedAssignmentDrainTimer.unref();
  }
};

const { scheduleLogoutAssignmentRecovery } = createLogoutAssignmentRecoveryService({
  assignQueuedWhatsappConversations,
  log,
  nowMs,
  readStore,
  requeueWhatsappAssignmentsForLogout,
});

const enqueueLogoutAssignmentRecovery = (user = {}, reason = 'attendance_stop') => {
  if (!isAssignmentRecoveryJobStoreEnabled()) {
    const scheduled = scheduleLogoutAssignmentRecovery(user, reason);
    return {
      queued: false,
      scheduled,
      job: null,
      fallback: scheduled ? 'in_process' : '',
    };
  }

  const job = enqueueAssignmentRecoveryJob({
    user,
    reason,
    payload: {
      requestedAt: nowIso(),
    },
  });

  return {
    queued: Boolean(job),
    scheduled: false,
    job,
    fallback: '',
  };
};

const processNextAssignmentRecoveryJob = async () => {
  const job = claimNextAssignmentRecoveryJob({
    workerId: ASSIGNMENT_RECOVERY_WORKER_ID,
  });
  if (!job) return false;

  const startedAt = nowMs();
  try {
    const storeSnapshot = await readStore();
    const currentUser =
      (Array.isArray(storeSnapshot.users) ? storeSnapshot.users : []).find(
        (item) => String(item?.id || '').trim() === String(job.user_id || '').trim(),
      ) ||
      job.payload?.user ||
      {};

    if (!currentUser?.id) {
      throw new Error(`Usuario nao encontrado para redistribuicao: ${job.user_id}`);
    }

    const requeuedConversationIds = await requeueWhatsappAssignmentsForLogout(storeSnapshot, currentUser);
    let reassignedConversations = [];

    if (requeuedConversationIds.length > 0) {
      const refreshedStore = await readStore();
      reassignedConversations = await assignQueuedWhatsappConversations(refreshedStore);
    }

    completeAssignmentRecoveryJob(job.id);
    log(
      `Assignment recovery job concluido (${job.reason}): job=${job.id} user=${job.user_id} requeued=${requeuedConversationIds.length} reassigned=${reassignedConversations.length} em ${nowMs() - startedAt}ms.`,
    );
    return true;
  } catch (error) {
    failAssignmentRecoveryJob(job.id, error?.message || String(error));
    log(`Falha no assignment recovery job ${job.id}: ${error?.message || error}`);
    return true;
  }
};

const initializeAssignmentRecoveryWorker = () => {
  if (!ASSIGNMENT_RECOVERY_WORKER_ENABLED) return;
  if (!isAssignmentRecoveryJobStoreEnabled()) {
    log('Assignment recovery worker desativado: SQLITE_DB_PATH/SQL_STORE_SQLITE_PATH nao configurado.');
    return;
  }

  startRegisteredInterval(
    'assignment-recovery-worker',
    () => {
      void processNextAssignmentRecoveryJob().catch((error) => {
        log(`Falha no ciclo do assignment recovery worker: ${error?.message || error}`);
      });
    },
    ASSIGNMENT_RECOVERY_WORKER_INTERVAL_MS,
    { unref: false },
  );
  log(`Assignment recovery worker ativo: worker=${ASSIGNMENT_RECOVERY_WORKER_ID} interval=${ASSIGNMENT_RECOVERY_WORKER_INTERVAL_MS}ms.`);
};

const pauseAttendanceDistributionForUser = async (storeSnapshot = {}, user = {}, reason = 'lunch') => {
  const safeUserId = String(user?.id || '').trim();
  if (!safeUserId) return null;
  const timestamp = nowIso();
  const pauseReason = normalizeAttendanceDistributionPauseReason(reason);
  const pausedUntil = new Date(nowMs() + Math.max(60_000, ATTENDANCE_DISTRIBUTION_PAUSE_MS)).toISOString();
  const previousPresence = getPersistedAttendancePresenceForUser(storeSnapshot, safeUserId);
  const baseRecord = buildAttendancePresenceRecord(storeSnapshot, user, previousPresence);
  const nextPresence = {
    ...baseRecord,
    status: isAdminUser(storeSnapshot, user) ? 'admin' : 'paused',
    paused_until: pausedUntil,
    pause_reason: pauseReason,
    pause_reason_label: ATTENDANCE_DISTRIBUTION_PAUSE_REASONS[pauseReason] || '',
    last_seen_at: timestamp,
    updated_at: timestamp,
  };

  await persistAttendancePresenceRecord(nextPresence);
  attendancePresenceTouchCache.set(safeUserId, nowMs());
  return nextPresence;
};


const resumeAttendanceDistributionForUser = async (user = {}) => {
  const safeUserId = String(user?.id || '').trim();
  if (!safeUserId) return null;
  const storeSnapshot = await readStore();
  const previousPresence = getPersistedAttendancePresenceForUser(storeSnapshot, safeUserId);
  const baseRecord = buildAttendancePresenceRecord(storeSnapshot, user, previousPresence);
  const timestamp = nowIso();
  const nextPresence = {
    ...baseRecord,
    status: isAdminUser(storeSnapshot, user) ? 'admin' : 'attending',
    paused_until: '',
    pause_reason: '',
    pause_reason_label: '',
    last_seen_at: timestamp,
    updated_at: timestamp,
  };

  await persistAttendancePresenceRecord(nextPresence);
  attendancePresenceTouchCache.set(safeUserId, nowMs());
  return nextPresence;
};

const getActiveAttendingUserIds = (store) => {
  const usersById = new Map((Array.isArray(store?.users) ? store.users : []).map((user) => [String(user.id || '').trim(), user]));
  const sessionUserIds = new Set(
    getPersistedAuthSessions(store?.auth)
      .filter((session) => {
        const userId = String(session?.user_id || '').trim();
        const expiresAtMs = Date.parse(session?.expires_at || '');
        return userId && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs();
      })
      .map((session) => String(session.user_id || '').trim()),
  );
  const activePresenceUserIds = getPersistedAttendancePresence(store)
    .filter((session) => {
      const userId = String(session?.user_id || '').trim();
      const lastSeenAtMs = Date.parse(session?.last_seen_at || '');
      if (!userId || !sessionUserIds.has(userId)) return false;
      if (String(session?.status || '').trim() !== 'attending') return false;
      if (ATTENDANCE_PRESENCE_TTL_ENFORCED && (!Number.isFinite(lastSeenAtMs) || nowMs() - lastSeenAtMs > ATTENDANCE_PRESENCE_TTL_MS)) {
        return false;
      }
      const user = usersById.get(userId);
      return Boolean(user && !isAdminUser(store, user));
    })
    .map((session) => String(session.user_id || '').trim());
  return new Set(activePresenceUserIds);
};

const sanitizeLoginIdentifier = (value) => String(value || '').trim().toLowerCase().slice(0, 160);

const findUserByLogin = (store, login) => {
  const normalized = sanitizeLoginIdentifier(login);
  if (!normalized) {
    return null;
  }

  return (
    (Array.isArray(store?.users) ? store.users : []).find((user) => {
      const usernames = [user?.username, user?.email].map((entry) => sanitizeLoginIdentifier(entry));
      return usernames.includes(normalized);
    }) || null
  );
};

const buildSessionCookie = (req, token, remember) =>
  serializeCookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: remember ? Math.floor(LOCAL_REMEMBER_SESSION_TTL_MS / 1000) : undefined,
  });

const buildExpiredSessionCookie = (req) =>
  serializeCookie(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: 0,
    expires: new Date(0),
  });

const getSessionTokenFromRequest = (req) => {
  const cookies = parseCookies(req?.headers?.cookie || '');
  return String(cookies[AUTH_COOKIE_NAME] || '').trim();
};

const pruneAuthState = (auth) => normalizeAuthState(auth);

const getLegacyAuthSessions = (auth) => pruneAuthState(auth).sessions;

const mergeAuthSessions = (sessions = []) => {
  const byTokenHash = new Map();
  sessions.forEach((session) => {
    const record = normalizeSessionRecord(session);
    if (!record.id || !record.user_id || !record.token_hash || !record.expires_at) return;
    const expiresAtMs = Date.parse(record.expires_at || '');
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs()) return;
    const previous = byTokenHash.get(record.token_hash);
    const previousSeenMs = Date.parse(previous?.last_seen_at || previous?.created_at || '');
    const currentSeenMs = Date.parse(record.last_seen_at || record.created_at || '');
    if (!previous || (Number.isFinite(currentSeenMs) && currentSeenMs >= previousSeenMs)) {
      byTokenHash.set(record.token_hash, record);
    }
  });
  return [...byTokenHash.values()];
};

const getPersistedAuthSessions = (auth) => mergeAuthSessions([...listSqlAuthSessions(), ...getLegacyAuthSessions(auth)]);

const removeLegacySessionByTokenHash = async (tokenHash) => {
  const safeTokenHash = String(tokenHash || '').trim();
  if (!safeTokenHash) return 0;

  let removedCount = 0;
  await updateStore((store) => {
    store.auth = pruneAuthState(store.auth);
    const previousLength = store.auth.sessions.length;
    store.auth.sessions = store.auth.sessions.filter((session) => session.token_hash !== safeTokenHash);
    removedCount = previousLength - store.auth.sessions.length;
    return removedCount > 0 ? store : false;
  });
  return removedCount;
};

const removeLegacySessionsByUserId = async (userId) => {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return 0;

  let removedCount = 0;
  await updateStore((store) => {
    store.auth = pruneAuthState(store.auth);
    const previousLength = store.auth.sessions.length;
    store.auth.sessions = store.auth.sessions.filter((session) => session.user_id !== safeUserId);
    removedCount = previousLength - store.auth.sessions.length;
    return removedCount > 0 ? store : false;
  });
  return removedCount;
};

const recordFailedLoginAttempt = (auth, loginKey) => {
  const safeKey = sanitizeLoginIdentifier(loginKey);
  if (!safeKey) {
    return pruneAuthState(auth);
  }

  const nextAuth = pruneAuthState(auth);
  const previous = nextAuth.loginAttempts[safeKey] || { count: 0, lastFailedAt: null, lockedUntil: null };
  const nextCount = previous.count + 1;
  const now = nowMs();
  const shouldLock = nextCount >= LOGIN_FAILURE_LIMIT;
  const lockDurationMs = shouldLock
    ? Math.min(LOGIN_FAILURE_LOCK_MAX_MS, LOGIN_FAILURE_LOCK_BASE_MS * 2 ** Math.max(0, nextCount - LOGIN_FAILURE_LIMIT))
    : 0;

  nextAuth.loginAttempts[safeKey] = {
    count: nextCount,
    lastFailedAt: new Date(now).toISOString(),
    lockedUntil: shouldLock ? new Date(now + lockDurationMs).toISOString() : null,
  };

  return nextAuth;
};

const clearFailedLoginAttempt = (auth, loginKey) => {
  const safeKey = sanitizeLoginIdentifier(loginKey);
  const nextAuth = pruneAuthState(auth);
  if (safeKey) {
    delete nextAuth.loginAttempts[safeKey];
  }
  return nextAuth;
};

const getActiveLoginAttempt = (auth, loginKey) => {
  const safeKey = sanitizeLoginIdentifier(loginKey);
  if (!safeKey) {
    return null;
  }

  const attempt = pruneAuthState(auth).loginAttempts[safeKey];
  if (!attempt) {
    return null;
  }

  const lockedUntilMs = Date.parse(attempt.lockedUntil || '');
  if (!Number.isFinite(lockedUntilMs) || lockedUntilMs <= nowMs()) {
    return null;
  }

  return attempt;
};

const createSessionRecord = (req, userId, remember) => {
  const createdAtMs = nowMs();
  const expiresAtMs = createdAtMs + (remember ? LOCAL_REMEMBER_SESSION_TTL_MS : LOCAL_SESSION_TTL_MS);
  const token = crypto.randomBytes(32).toString('base64url');

  return {
    token,
    record: normalizeSessionRecord({
      id: `session-${createdAtMs.toString(36)}-${crypto.randomBytes(6).toString('hex')}`,
      user_id: userId,
      token_hash: hashToken(token),
      remember: Boolean(remember),
      created_at: new Date(createdAtMs).toISOString(),
      last_seen_at: new Date(createdAtMs).toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
      ip: String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim(),
      user_agent: String(req?.headers?.['user-agent'] || '').slice(0, 500),
    }),
  };
};

const stripSensitiveEntity = (entityName, value) => {
  if (entityName === 'User') {
    return Array.isArray(value) ? value.map((user) => sanitizeUserForClient(user)) : sanitizeUserForClient(value);
  }

  return value;
};

const resolveSessionContext = async (store, req) => {
  const token = getSessionTokenFromRequest(req);
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const sqlSession = getSqlAuthSessionByTokenHash(tokenHash);
  const legacySession = getLegacyAuthSessions(store?.auth).find((entry) => entry.token_hash === tokenHash) || null;
  const session = normalizeSessionRecord(sqlSession || legacySession);
  if (!session.id || !session.user_id || !session.token_hash || !session.expires_at) {
    return null;
  }

  const expiresAtMs = Date.parse(session.expires_at || '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs()) {
    return null;
  }

  const user = (Array.isArray(store?.users) ? store.users : []).find((entry) => String(entry?.id || '') === session.user_id) || null;
  if (!user) {
    return null;
  }

  if (!sqlSession && legacySession && isSqlAuthSessionStoreEnabled()) {
    upsertSqlAuthSession(session);
  }

  return { token, session, user };
};

const requireAuthenticatedSession = async (req) => {
  const store = await readStore();
  const context = await resolveSessionContext(store, req);
  if (!context) {
    throw new SyncError('Sessao expirada ou inexistente.', 401, 'auth_required');
  }

  return {
    store,
    ...context,
  };
};

const invalidateSessionToken = async (token) => {
  const tokenHash = String(token || '').trim() ? hashToken(token) : '';
  if (!tokenHash) {
    return;
  }

  deleteSqlAuthSessionByTokenHash(tokenHash);
  await removeLegacySessionByTokenHash(tokenHash);
};

const invalidateUserSessions = async (userId) => {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) {
    return 0;
  }

  const sqlRemoved = deleteSqlAuthSessionsByUserId(safeUserId);
  const legacyRemoved = await removeLegacySessionsByUserId(safeUserId);
  return sqlRemoved + legacyRemoved;
};

const updateUserLastSeenSession = async (sessionId) => {
  const safeSessionId = String(sessionId || '').trim();
  if (!safeSessionId) {
    return;
  }

  const updatedSqlRows = updateSqlAuthSessionLastSeen(safeSessionId, nowIso());
  if (updatedSqlRows > 0 || isSqlAuthSessionStoreEnabled()) {
    return;
  }

  await updateStore((store) => {
    store.auth = pruneAuthState(store.auth);
    const index = store.auth.sessions.findIndex((session) => session.id === safeSessionId);
    if (index < 0) {
      return false;
    }

    const currentSession = store.auth.sessions[index];
    const lastSeenAtMs = Date.parse(currentSession.last_seen_at || '');
    if (Number.isFinite(lastSeenAtMs) && nowMs() - lastSeenAtMs < 5 * 60 * 1000) {
      return false;
    }

    store.auth.sessions[index] = {
      ...currentSession,
      last_seen_at: nowIso(),
    };
    return store;
  });
};

class SyncError extends Error {
  constructor(message, status = 500, code = 'sync_error', payload = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

const looksLikeCloudflare = (text) => {
  const snippet = String(text || '').slice(0, 4000).toLowerCase();
  return ['just a moment', 'cloudflare', 'cf-browser-verification', 'challenge-platform', 'attention required'].some(
    (marker) => snippet.includes(marker),
  );
};

const parseJsonResponse = async (response) => {
  try {
    return await response.json();
  } catch {
    const snippet = await response.text();
    if (looksLikeCloudflare(snippet)) {
      throw new SyncError(
        'O servidor respondeu com uma pagina de protecao anti-bot/Cloudflare em vez de JSON.',
        403,
        'auth',
        { html: snippet.slice(0, 500) },
      );
    }
    throw new SyncError(`Resposta nao-JSON em ${response.url}`, response.status || 502, 'invalid_response', {
      raw: snippet.slice(0, 500),
    });
  }
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = NEWBR_SYNC_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new SyncError('A sincronizacao com o NewBr excedeu o tempo limite.', 504, 'timeout');
    }
    throw new SyncError(error?.message || 'Falha de rede ao acessar o NewBr.', 502, 'network');
  } finally {
    clearTimeout(timeoutId);
  }
};

const findNumberDeep = (inputValue, preferredKeys = []) => {
  if (inputValue == null) return null;
  if (typeof inputValue === 'number') return inputValue;
  if (typeof inputValue === 'string') {
    const normalized = inputValue.replace(/\./g, '').replace(',', '.').trim();
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Array.isArray(inputValue)) {
    for (const item of inputValue) {
      const found = findNumberDeep(item, preferredKeys);
      if (found != null) return found;
    }
    return null;
  }
  if (inputValue && typeof inputValue === 'object') {
    for (const key of preferredKeys) {
      if (key in inputValue) {
        const found = findNumberDeep(inputValue[key], preferredKeys);
        if (found != null) return found;
      }
    }
    for (const value of Object.values(inputValue)) {
      const found = findNumberDeep(value, preferredKeys);
      if (found != null) return found;
    }
  }
  return null;
};

const extractRows = (payload) => {
  if (Array.isArray(payload)) {
    return payload.filter((item) => item && typeof item === 'object');
  }

  if (payload && typeof payload === 'object') {
    for (const key of ['data', 'rows', 'items', 'customers', 'results']) {
      const value = payload[key];
      if (Array.isArray(value)) {
        return value.filter((item) => item && typeof item === 'object');
      }
    }

    if (payload.data && typeof payload.data === 'object') {
      for (const key of ['data', 'rows', 'items', 'customers', 'results']) {
        const value = payload.data[key];
        if (Array.isArray(value)) {
          return value.filter((item) => item && typeof item === 'object');
        }
      }
    }
  }

  return [];
};

const extractMetaContainer = (payload) => {
  if (payload && typeof payload === 'object') {
    if (payload.meta && typeof payload.meta === 'object') return payload.meta;
    if (payload.data && typeof payload.data === 'object' && payload.data.meta && typeof payload.data.meta === 'object') {
      return payload.data.meta;
    }
  }
  return {};
};

const extractLastPage = (payload) => {
  const meta = extractMetaContainer(payload);
  const value = findNumberDeep(meta, ['last_page', 'lastPage']) ?? findNumberDeep(payload, ['last_page', 'lastPage']);
  return value != null ? Number(value) : null;
};

const extractCurrentPage = (payload) => {
  const meta = extractMetaContainer(payload);
  const value =
    findNumberDeep(meta, ['current_page', 'currentPage', 'page']) ??
    findNumberDeep(payload, ['current_page', 'currentPage', 'page']);
  return value != null ? Number(value) : null;
};

const extractPerPage = (payload) => {
  const meta = extractMetaContainer(payload);
  const value = findNumberDeep(meta, ['per_page', 'perPage']) ?? findNumberDeep(payload, ['per_page', 'perPage']);
  return value != null ? Number(value) : null;
};

const extractTotal = (payload) => {
  const meta = extractMetaContainer(payload);
  const value = findNumberDeep(meta, ['total']) ?? findNumberDeep(payload, ['total']);
  return value != null ? Number(value) : null;
};

const findFirstValue = (inputValue, preferredKeys = []) => {
  if (inputValue == null) return null;

  if (inputValue && typeof inputValue === 'object' && !Array.isArray(inputValue)) {
    for (const key of preferredKeys) {
      if (key in inputValue) {
        const value = inputValue[key];
        if (value !== '' && value != null) return value;
      }
    }

    for (const value of Object.values(inputValue)) {
      const found = findFirstValue(value, preferredKeys);
      if (found !== '' && found != null) return found;
    }
  }

  if (Array.isArray(inputValue)) {
    for (const item of inputValue) {
      const found = findFirstValue(item, preferredKeys);
      if (found !== '' && found != null) return found;
    }
  }

  return null;
};

const stringifyCell = (value) => {
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyCell(item).trim())
      .filter(Boolean)
      .join(', ');
  }
  if (value && typeof value === 'object') {
    return stringifyCell(findFirstValue(value, ['name', 'title', 'description', 'username', 'phone', 'telefone', 'number']));
  }
  return String(value).trim();
};

const extractCustomerField = (
  customer,
  keys,
  nestedKeys = ['user', 'customer', 'account', 'package', 'plan', 'reseller', 'seller', 'owner'],
) => {
  const direct = findFirstValue(customer, keys);
  if (direct !== '' && direct != null) {
    return stringifyCell(direct);
  }

  for (const nestedKey of nestedKeys) {
    const nested = customer?.[nestedKey];
    if (nested && typeof nested === 'object') {
      const nestedValue = findFirstValue(nested, keys);
      if (nestedValue !== '' && nestedValue != null) {
        return stringifyCell(nestedValue);
      }
    }
  }

  return '';
};

const parseDateAny = (value) => {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw.replace('Z', '+00:00');
  const isoTime = Date.parse(normalized);
  if (Number.isFinite(isoTime)) {
    return new Date(isoTime);
  }

  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const [, day, month, year, hour = '00', minute = '00', second = '00'] = match;
    const candidate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    return Number.isNaN(candidate.getTime()) ? null : candidate;
  }

  return null;
};

const findExpiryDate = (customer) => {
  const keys = ['expires_at_tz', 'expires_at', 'expiration', 'expiry', 'expiresAt', 'expiration_date', 'due_date', 'dueDate', 'vencimento'];
  for (const key of keys) {
    if (key in customer) {
      const parsed = parseDateAny(customer[key]);
      if (parsed) return parsed;
    }
  }

  for (const nestedKey of ['user', 'customer', 'account']) {
    const nested = customer?.[nestedKey];
    if (nested && typeof nested === 'object') {
      for (const key of keys) {
        if (key in nested) {
          const parsed = parseDateAny(nested[key]);
          if (parsed) return parsed;
        }
      }
    }
  }

  return null;
};

const toBooleanFlag = (value) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return ['yes', 'sim', 'true', '1', 'trial', 'teste'].includes(normalized);
};

const toNullableInteger = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const mapStatusLabel = (status) => {
  switch (String(status || '').trim().toUpperCase()) {
    case 'ACTIVE':
      return 'Ativo';
    case 'EXPIRED':
      return 'Vencido';
    case 'INACTIVE':
      return 'Inativo';
    case 'BLOCKED':
      return 'Bloqueado';
    case 'SUSPENDED':
      return 'Suspenso';
    default:
      return stringifyCell(status) || 'Sem status';
  }
};

const normalizeBrowserAuth = (input) => {
  if (!input || typeof input !== 'object') return null;

  const baseUrlRaw = String(input.baseUrl || '').trim();
  const token = String(input.token || '').trim();
  if (!baseUrlRaw || !token) return null;

  return {
    baseUrl: normalizeBaseUrl(baseUrlRaw),
    token,
    capturedAt: String(input.capturedAt || nowIso()).trim() || nowIso(),
    source: String(input.source || 'browser-login').trim() || 'browser-login',
  };
};

const extractToken = (payload) => {
  if (!payload || typeof payload !== 'object') return null;

  return (
    payload.token ||
    payload.accessToken ||
    payload.access_token ||
    payload.jwt ||
    (payload.data && typeof payload.data === 'object' ? payload.data.token : null) ||
    (payload.data && typeof payload.data === 'object' ? payload.data.accessToken : null) ||
    (payload.data && typeof payload.data === 'object' ? payload.data.access_token : null) ||
    null
  );
};

const buildNewbrHeaders = (baseUrl, token = '', session = {}) => {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': String(session?.userAgent || USER_AGENT).trim() || USER_AGENT,
    Origin: baseUrl,
    Referer: `${baseUrl}/`,
    locale: 'pt',
  };

  if (session?.appVersion) {
    headers['x-app-version'] = String(session.appVersion).trim();
  }

  if (session?.cookieHeader) {
    headers.Cookie = String(session.cookieHeader).trim();
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
};

const getNewbrConfig = () => ({
  baseUrl: normalizeBaseUrl(NEWBR_SYNC_BASE_URL),
  username: String(NEWBR_SYNC_USERNAME || DEFAULT_NEWBR_BROWSER_SYNC_USERNAME || '').trim(),
  password: String(NEWBR_SYNC_PASSWORD || DEFAULT_NEWBR_BROWSER_SYNC_PASSWORD || ''),
  perPage: Number.isFinite(NEWBR_SYNC_PER_PAGE) && NEWBR_SYNC_PER_PAGE > 0 ? NEWBR_SYNC_PER_PAGE : 100,
  maxPages: Number.isFinite(NEWBR_SYNC_MAX_PAGES) && NEWBR_SYNC_MAX_PAGES > 0 ? NEWBR_SYNC_MAX_PAGES : 500,
});

const mergeNewbrConfig = (overrides = {}) => {
  const base = getNewbrConfig();
  const credentials = overrides?.credentials && typeof overrides.credentials === 'object' ? overrides.credentials : {};
  const session = overrides?.session && typeof overrides.session === 'object' ? overrides.session : {};
  const cookieHeader = String(session.cookieHeader || '').trim();
  const cfClearance = String(session.cfClearance || '').trim();

  return {
    ...base,
    baseUrl: normalizeBaseUrl(credentials.baseUrl || base.baseUrl),
    username: String(credentials.username || base.username || '').trim(),
    password: String(credentials.password || base.password || ''),
    session: {
      userAgent: String(session.userAgent || '').trim(),
      appVersion: String(session.appVersion || '').trim(),
      cookieHeader: cookieHeader || (cfClearance ? `cf_clearance=${cfClearance}` : ''),
      cfClearance,
    },
  };
};

const getSharedNewbrBrowserAuthConfig = () => {
  const base = getNewbrConfig();
  return {
    baseUrl: normalizeBaseUrl(base.baseUrl || NEWBR_SYNC_BASE_URL || 'https://painel.newbr.top'),
    username: String(base.username || DEFAULT_NEWBR_BROWSER_SYNC_USERNAME || '').trim(),
    password: String(base.password || DEFAULT_NEWBR_BROWSER_SYNC_PASSWORD || ''),
    source: base.username && base.password ? 'env' : 'default',
    configured: Boolean(String(base.username || DEFAULT_NEWBR_BROWSER_SYNC_USERNAME || '').trim() && String(base.password || DEFAULT_NEWBR_BROWSER_SYNC_PASSWORD || '').trim()),
  };
};

const getPythonBinary = () => {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  return process.platform === 'win32' ? 'python' : 'python3';
};

const loginToNewbr = async (config) => {
  if (!config.username || !config.password) {
    throw new SyncError('Credenciais do NewBr nao configuradas na VPS.', 500, 'config');
  }

  const loginUrl = `${config.baseUrl}/api/auth/login`;
  const candidatePayloads = [
    {
      captcha: 'not-a-robot',
      captchaChecked: true,
      username: config.username,
      password: config.password,
      twofactor_code: '',
      twofactor_recovery_code: '',
      twofactor_trusted_device_id: '',
    },
    { username: config.username, password: config.password, captchaToken: '', twofactor: '' },
    { username: config.username, password: config.password, captcha: null, twofactor: null },
  ];

  let lastError = null;

  for (const payload of candidatePayloads) {
    const response = await fetchWithTimeout(
      loginUrl,
      {
        method: 'POST',
        headers: buildNewbrHeaders(config.baseUrl, '', config.session),
        body: JSON.stringify(payload),
      },
      NEWBR_SYNC_TIMEOUT_MS,
    );

    if (response.status >= 400) {
      let detail = null;
      try {
        detail = await parseJsonResponse(response);
      } catch (error) {
        detail = error?.payload || null;
      }
      lastError = new SyncError('Falha no login do NewBr.', response.status, response.status === 401 || response.status === 403 ? 'auth' : 'login_failed', {
        detail,
      });
      continue;
    }

    const data = await parseJsonResponse(response);
    const token = extractToken(data);
    if (!token) {
      lastError = new SyncError('Login do NewBr respondeu sem token reconhecivel.', 502, 'auth', { raw: data });
      continue;
    }

    return token;
  }

  throw lastError || new SyncError('Falha no login do NewBr.', 401, 'auth');
};

const getNewbrJson = async (config, token, endpoint) => {
  const response = await fetchWithTimeout(
    `${config.baseUrl}${endpoint}`,
    {
      method: 'GET',
      headers: buildNewbrHeaders(config.baseUrl, token, config.session),
    },
    NEWBR_SYNC_TIMEOUT_MS,
  );

  if (response.status >= 400) {
    let payload = null;
    try {
      payload = await parseJsonResponse(response);
    } catch (error) {
      payload = error?.payload || null;
    }
    throw new SyncError(`Falha ao consultar ${endpoint}`, response.status, response.status === 401 || response.status === 403 ? 'auth' : 'request_failed', payload);
  }

  return await parseJsonResponse(response);
};

const fetchAllCustomersWithToken = async (config, token) => {
  const allRows = [];
  let pagesLoaded = 0;
  let lastPageSeen = null;

  for (let page = 1; page <= config.maxPages; page += 1) {
    const params = new URLSearchParams({
      page: String(page),
      username: '',
      serverId: '',
      packageId: '',
      expiryFrom: '',
      expiryTo: '',
      status: '',
      isTrial: '',
      connections: '',
      perPage: String(config.perPage),
    });

    const payload = await getNewbrJson(config, token, `/api/customers?${params.toString()}`);
    const pageRows = extractRows(payload);
    allRows.push(...pageRows);
    pagesLoaded += 1;

    const currentPage = extractCurrentPage(payload) || page;
    lastPageSeen = extractLastPage(payload) || lastPageSeen;
    const totalSeen = extractTotal(payload);
    const perPageSeen = extractPerPage(payload) || config.perPage;

    if (lastPageSeen && currentPage >= lastPageSeen) break;
    if (totalSeen != null && allRows.length >= totalSeen) break;
    if (pageRows.length === 0 || pageRows.length < perPageSeen) break;
  }

  return {
    rows: allRows,
    pagesLoaded,
    lastPage: lastPageSeen,
    totalRows: allRows.length,
  };
};

const readPersistedBrowserAuth = async (baseUrl) => {
  const store = await readStore();
  const auth = normalizeBrowserAuth(store.customerSyncContext?.browserAuth);
  if (!auth) return null;
  return auth.baseUrl === normalizeBaseUrl(baseUrl) ? auth : null;
};

const fetchAllCustomersFromNewbr = async (overrides = {}) => {
  const config = mergeNewbrConfig(overrides);
  const explicitBrowserAuth = normalizeBrowserAuth(overrides?.auth);

  if (explicitBrowserAuth?.token && explicitBrowserAuth.baseUrl === normalizeBaseUrl(config.baseUrl)) {
    try {
      log('trying browser token supplied by manual sync');
      return await fetchAllCustomersWithToken(config, explicitBrowserAuth.token);
    } catch (error) {
      const tokenError = classifySyncError(error);
      log(`supplied browser token rejected (${tokenError.code}); falling back to persisted token/login`);
    }
  }

  const persistedBrowserAuth = await readPersistedBrowserAuth(config.baseUrl);

  if (persistedBrowserAuth?.token) {
    try {
      log('trying persisted browser token for automatic NewBr sync');
      return await fetchAllCustomersWithToken(config, persistedBrowserAuth.token);
    } catch (error) {
      const tokenError = classifySyncError(error);
      log(`persisted browser token rejected (${tokenError.code}); falling back to login`);
    }
  }

  try {
    const token = await loginToNewbr(config);
    return await fetchAllCustomersWithToken(config, token);
  } catch (error) {
    const syncError = classifySyncError(error);
    const shouldUsePythonFallback =
      syncError.code === 'auth' ||
      syncError.code === 'invalid_response' ||
      String(syncError.message || '').toLowerCase().includes('cloudflare');

    if (!shouldUsePythonFallback) {
      throw syncError;
    }

    log(`native NewBr sync blocked (${syncError.code}); trying python fallback`);
    return await fetchAllCustomersFromPythonBridge(config);
  }
};

const fetchAllCustomersFromPythonBridge = async (config) => {
  try {
    const { stdout } = await execFileAsync(
      getPythonBinary(),
      [PYTHON_SYNC_BRIDGE_PATH],
      {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          NEWBR_SYNC_BASE_URL: config.baseUrl,
          NEWBR_SYNC_USERNAME: config.username,
          NEWBR_SYNC_PASSWORD: config.password,
          NEWBR_SYNC_PER_PAGE: String(config.perPage),
          NEWBR_SYNC_MAX_PAGES: String(config.maxPages),
          NEWBR_SYNC_TIMEOUT_MS: String(NEWBR_SYNC_TIMEOUT_MS),
          NEWBR_SYNC_USER_AGENT: String(config.session?.userAgent || ''),
          NEWBR_SYNC_APP_VERSION: String(config.session?.appVersion || ''),
          NEWBR_SYNC_COOKIE_HEADER: String(config.session?.cookieHeader || ''),
          NEWBR_SYNC_CF_CLEARANCE: String(config.session?.cfClearance || ''),
        },
        timeout: Math.max(NEWBR_SYNC_TIMEOUT_MS * 2, 120000),
        maxBuffer: 50 * 1024 * 1024,
      },
    );

    const parsed = JSON.parse(stdout || '{}');
    return {
      rows: Array.isArray(parsed?.rows) ? parsed.rows : [],
      pagesLoaded: Number(parsed?.pagesLoaded || 0),
      lastPage: Number.isFinite(Number(parsed?.lastPage)) ? Number(parsed.lastPage) : null,
      totalRows: Number(parsed?.totalRows || 0),
    };
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    if (stderr) {
      try {
        const payload = JSON.parse(stderr);
        throw new SyncError(payload?.error || 'Falha na sincronizacao Python do NewBr.', Number(payload?.status || 500), payload?.code || 'python_sync', payload);
      } catch (parseError) {
        if (parseError instanceof SyncError) {
          throw parseError;
        }
      }
    }

    if (error?.code === 'ENOENT') {
      throw new SyncError('Python nao encontrado no servidor para o fallback da sincronizacao NewBr.', 500, 'python_missing');
    }

    throw new SyncError(error?.message || 'Falha na sincronizacao Python do NewBr.', 500, 'python_sync');
  }
};

const buildCustomerStableKey = (customer, fallbackIndex) => {
  const explicitId = extractCustomerField(customer, ['id', 'customer_id', 'customerId', 'uuid', '_id']);
  if (explicitId) return explicitId;

  const username = extractCustomerField(customer, ['username', 'user_name', 'login', 'user']);
  const phone = normalizePhone(
    extractCustomerField(customer, ['whatsapp', 'telefone', 'phone', 'phone_number', 'mobile', 'cellphone']),
  );

  if (username || phone) {
    return `${username || 'sem-usuario'}-${phone || 'sem-telefone'}`;
  }

  return `customer-${fallbackIndex + 1}`;
};

const normalizeCustomerRow = (customer, index, syncedAt) => {
  const expiresAt = findExpiryDate(customer);
  const status = extractCustomerField(customer, ['status', 'situation', 'state']).trim().toUpperCase();
  const username = extractCustomerField(customer, ['username', 'user_name', 'login', 'user', 'nome', 'name']);
  const displayName = extractCustomerField(customer, ['name', 'nome', 'full_name', 'fullName', 'username']);
  const whatsapp = extractCustomerField(customer, ['whatsapp', 'telefone', 'phone', 'phone_number', 'mobile', 'cellphone']);
  const reseller = extractCustomerField(customer, ['reseller', 'reseller_name', 'revendedor', 'seller', 'owner', 'parent_name']);
  const packageName = extractCustomerField(
    customer,
    ['package', 'package_name', 'packageName', 'plano', 'plan', 'plan_name', 'description', 'name'],
    ['package', 'plan'],
  );
  const trialRaw = extractCustomerField(customer, ['is_trial', 'isTrial', 'trial', 'teste']);
  const connections =
    toNullableInteger(extractCustomerField(customer, ['connections', 'connection', 'connectionCount', 'max_connections'])) || 0;

  return {
    id: `newbr-${toSlug(buildCustomerStableKey(customer, index))}`,
    sync_key: buildCustomerStableKey(customer, index),
    username: username || displayName || `cliente-${index + 1}`,
    display_name: displayName || username || `Cliente ${index + 1}`,
    whatsapp: whatsapp || '',
    phone_digits: normalizePhone(whatsapp),
    reseller: reseller || '-',
    package: packageName || '-',
    connections,
    expires_at: expiresAt ? expiresAt.toISOString() : '',
    status: status || 'UNKNOWN',
    status_label: mapStatusLabel(status),
    is_trial: toBooleanFlag(trialRaw),
    synced_at: syncedAt,
    raw: customer,
  };
};

const buildCustomerSyncSummary = (customers) => {
  return customers.reduce(
    (summary, customer) => {
      const status = String(customer?.status || '').toUpperCase();
      summary.total += 1;
      if (status === 'ACTIVE') summary.active += 1;
      if (status === 'EXPIRED') summary.expired += 1;
      if (customer?.is_trial) summary.trials += 1;
      if (customer?.phone_digits) summary.withWhatsapp += 1;
      return summary;
    },
    {
      total: 0,
      active: 0,
      expired: 0,
      trials: 0,
      withWhatsapp: 0,
    },
  );
};

const appendCustomerSyncLog = (logs, entry) => [entry, ...logs].slice(0, CUSTOMER_SYNC_LOG_LIMIT);

const appendRoutineLog = (logs, entry) => [entry, ...(Array.isArray(logs) ? logs : [])].slice(0, ROUTINE_LOG_LIMIT);

const normalizeRoutineLogEntry = (entry = {}) => ({
  id: String(entry.id || `routine-log-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`),
  routineId: entry.routineId ? String(entry.routineId) : null,
  routineName: String(entry.routineName || 'Rotina'),
  level: String(entry.level || entry.status || 'info').trim() || 'info',
  status: String(entry.status || entry.level || 'info').trim() || 'info',
  message: String(entry.message || '').trim() || 'Evento de rotina.',
  details: entry.details && typeof entry.details === 'object' ? entry.details : {},
  createdAt: String(entry.createdAt || nowIso()),
  runId: entry.runId || null,
  summary: entry.summary && typeof entry.summary === 'object' ? entry.summary : undefined,
});

const isRoutineLogGroupRunning = (entries = []) => {
  const items = Array.isArray(entries) ? entries : [];
  const statuses = items.map((entry) => String(entry?.status || entry?.level || '').trim().toLowerCase());
  const hasRunning = statuses.some((status) => status === 'running' || status === 'queued');
  const hasFinalSummary = items.some((entry) => Boolean(entry?.summary?.finishedAt));
  const hasFinalMessage = items.some((entry) => /finalizada|finalizado|conclu[ií]d|apagada|atualizada|criada/i.test(String(entry?.message || '')));
  const hasTerminalStatus = statuses.some((status) => ['success', 'error', 'warning', 'skipped'].includes(status));
  return hasRunning && !hasFinalSummary && !hasFinalMessage && !hasTerminalStatus;
};

const keepOnlyRunningRoutineLogs = (logs = []) => {
  const groups = new Map();
  const order = [];

  (Array.isArray(logs) ? logs : []).forEach((entry, index) => {
    const key = entry?.runId ? `run-${entry.runId}` : `entry-${entry?.id || index}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(entry);
  });

  return order.flatMap((key) => {
    const entries = groups.get(key) || [];
    return isRoutineLogGroupRunning(entries) ? entries : [];
  });
};

const broadcastRoutineLog = (entry) => {
  const payload = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const client of routineLogClients) {
    try {
      client.write(payload);
    } catch {
      routineLogClients.delete(client);
    }
  }
};

const pendingRoutineLogs = [];
let routineLogFlushTimer = null;
let routineLogFlushQueue = Promise.resolve();

const appendRoutineLogs = (logs = [], entries = []) => {
  let nextLogs = Array.isArray(logs) ? logs : [];
  for (const entry of entries) {
    nextLogs = appendRoutineLog(nextLogs, entry);
  }
  return nextLogs;
};

const flushPendingRoutineLogs = async () => {
  if (routineLogFlushTimer) {
    clearTimeout(routineLogFlushTimer);
    routineLogFlushTimer = null;
  }

  const entries = pendingRoutineLogs.splice(0, pendingRoutineLogs.length);
  if (!entries.length) {
    return [];
  }

  routineLogFlushQueue = routineLogFlushQueue
    .catch(() => {})
    .then(async () => {
      await updateStore((current) => {
        const routines = normalizeRoutinesState(current.routines);
        current.routines = {
          ...routines,
          logs: appendRoutineLogs(routines.logs, entries),
        };
        return current;
      });
      return entries;
    })
    .catch((error) => {
      pendingRoutineLogs.unshift(...entries);
      log(`Falha ao persistir lote de logs de rotina: ${error?.message || error}`);
      return [];
    });

  return await routineLogFlushQueue;
};

const scheduleRoutineLogFlush = () => {
  if (routineLogFlushTimer) return;
  routineLogFlushTimer = setTimeout(() => {
    routineLogFlushTimer = null;
    void flushPendingRoutineLogs();
  }, ROUTINE_LOG_FLUSH_INTERVAL_MS);
  if (typeof routineLogFlushTimer.unref === 'function') {
    routineLogFlushTimer.unref();
  }
};

const persistRoutineLog = async (entry = {}) => {
  const normalized = normalizeRoutineLogEntry(entry);
  pendingRoutineLogs.push(normalized);
  broadcastRoutineLog(normalized);
  if (pendingRoutineLogs.length >= ROUTINE_LOG_FLUSH_BATCH_SIZE) {
    await flushPendingRoutineLogs();
  } else {
    scheduleRoutineLogFlush();
  }
  return normalized;
};

const normalizeRoutineText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const formatRoutineDateVariable = (value) => {
  const dateKey = parseDateOnly(value);
  if (!dateKey) return String(value || '').trim();
  const [year, month, day] = dateKey.split('-');
  return year && month && day ? `${day}/${month}/${year}` : String(value || '').trim();
};

const getCustomerVariableSource = (customer = {}) => {
  const raw = customer?.raw && typeof customer.raw === 'object' ? customer.raw : {};
  const dueDateValue =
    customer.routineRenovadosErradoValidation?.effectiveDueDateKey ||
    customer.expires_at ||
    customer.due_date ||
    raw.expires_at_tz ||
    raw.vencimento ||
    raw.due_date ||
    raw.expiration_date ||
    raw.expires_at ||
    '';
  const customerName = String(raw.nome || raw.name || customer.name || customer.display_name || customer.username || '').trim();
  return {
    ...raw,
    id: customer.id || raw.id || '',
    nome: customerName,
    name: customerName,
    cliente: customerName,
    nome_cliente: customerName,
    usuario: customer.username || raw.username || raw.user || raw.login || '',
    username: customer.username || raw.username || raw.user || raw.login || '',
    telefone: customer.whatsapp || raw.whatsapp || raw.telefone || raw.phone || '',
    phone: customer.whatsapp || raw.whatsapp || raw.telefone || raw.phone || '',
    whatsapp: customer.whatsapp || raw.whatsapp || raw.telefone || raw.phone || '',
    documento: raw.documento || raw.cpf || raw.cnpj || raw.document || '',
    plano: customer.package || customer.plan_name || raw.plano || raw.plan || raw.package || '',
    plan: customer.package || customer.plan_name || raw.plan || raw.plano || raw.package || '',
    vencimento: formatRoutineDateVariable(dueDateValue),
    data_vencimento: formatRoutineDateVariable(dueDateValue),
    status: customer.status_label || customer.status || raw.status || '',
    revendedor: customer.reseller || raw.revendedor || raw.reseller || '',
    conexoes: customer.connections ?? raw.connections ?? '',
    dia_hoje: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date()),
    data_hoje: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date()),
  };
};

const resolveCustomerValue = (customer, key, extraValues = {}) => {
  const source = getCustomerVariableSource(customer);
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return '';
  if (extraValues && extraValues[normalizedKey] != null) return extraValues[normalizedKey];
  if (source[normalizedKey] != null) return source[normalizedKey];
  const lowerKey = normalizedKey.toLowerCase();
  const extraKey = Object.keys(extraValues || {}).find((candidate) => candidate.toLowerCase() === lowerKey);
  if (extraKey) return extraValues[extraKey];
  const matchedKey = Object.keys(source).find((candidate) => candidate.toLowerCase() === lowerKey);
  return matchedKey ? source[matchedKey] : '';
};

const interpolateRoutineValue = (value, customer, extraValues = {}) =>
  String(value ?? '').replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\{#\s*([A-Za-z0-9_.-]+)\s*\}|\{\s*([A-Za-z0-9_.-]+)\s*\}/g, (_, keyA, keyB, keyC) => {
    const key = keyA || keyB || keyC;
    const resolved = resolveCustomerValue(customer, key, extraValues);
    return resolved == null ? '' : String(resolved);
  });

const normalizeSchedulePhone = (value) => normalizePhone(value);

const getPendingQuickReplyScheduleForTarget = (store, target = {}) => {
  const schedules = Array.isArray(store?.quickReplySchedules) ? store.quickReplySchedules : [];
  const conversationId = String(target.conversationId || target.conversation_id || '').trim();
  const customerId = String(target.customerId || target.customer_id || '').trim();
  const phone = normalizeSchedulePhone(target.phone || target.whatsapp || target.contact_phone || '');

  return schedules.find((schedule) => {
    if (String(schedule?.status || '').trim() !== 'pending') return false;
    const schedulePhone = normalizeSchedulePhone(schedule?.customerPhone || schedule?.phone || schedule?.conversationPhone || '');
    return (
      (conversationId && String(schedule?.conversationId || '') === conversationId) ||
      (customerId && String(schedule?.customerId || '') === customerId) ||
      (phone && schedulePhone && schedulePhone === phone)
    );
  }) || null;
};

const hasPendingQuickReplyScheduleForTarget = (store, target = {}) =>
  Boolean(getPendingQuickReplyScheduleForTarget(store, target));

const replaceTemplateParameters = (text, parameters = []) =>
  String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, indexText) => {
    const index = Number.parseInt(indexText, 10) - 1;
    return parameters[index] != null ? String(parameters[index]) : '';
  });

const getTemplateButtons = (template = {}) => {
  if (Array.isArray(template.buttons) && template.buttons.length > 0) return template.buttons;
  if (Array.isArray(template.buttonConfig) && template.buttonConfig.length > 0) {
    return template.buttonConfig.map((button, index) => ({
      id: button.id || `button-${index}`,
      type: button.type || button.buttonType || 'quick_reply',
      label: button.label || button.text || '',
      url: button.url || '',
      phoneNumber: button.phoneNumber || button.phone_number || '',
      offerCode: button.offerCode || button.offer_code || '',
      flowId: button.flowId || '',
      orderReference: button.orderReference || '',
    }));
  }
  const buttonComponent = Array.isArray(template.components)
    ? template.components.find((component) => String(component?.type || '').toUpperCase() === 'BUTTONS')
    : null;
  if (Array.isArray(buttonComponent?.buttons) && buttonComponent.buttons.length > 0) {
    return buttonComponent.buttons.map((button, index) => ({
      id: button.id || `button-${index}`,
      type: button.type || button.buttonType || 'quick_reply',
      label: button.label || button.text || '',
      url: button.url || '',
      phoneNumber: button.phoneNumber || button.phone_number || '',
      offerCode: button.offerCode || button.offer_code || '',
      flowId: button.flowId || '',
      orderReference: button.orderReference || '',
    }));
  }
  return [];
};

const getTemplateName = (template = {}) => String(template.name || template.identifier || template.templateName || '').trim();
const getTemplateLanguage = (template = {}) => String(template.language || 'pt_BR').trim() || 'pt_BR';
const getTemplateBody = (template = {}) => String(template.content || template.body || '').trim();

const fetchLocalHsmItemsForRoutines = async () => {
  const data = await requestWhatsappApiGetJson('/api/whatsapp/templates/local');
  return Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
};

const templateMatchesRoutine = (template, routine) => {
  const templateId = String(template?.id || template?.code || '').trim();
  const routineTemplateId = String(routine?.hsm?.templateId || routine?.templateId || '').trim();
  const routineTemplateName = String(routine?.hsm?.templateName || routine?.templateName || '').trim();
  const routineLanguage = String(routine?.hsm?.language || routine?.templateLanguage || 'pt_BR').trim();
  const nameMatches = getTemplateName(template) && getTemplateName(template) === routineTemplateName;
  const languageMatches = getTemplateLanguage(template) === routineLanguage;
  return (routineTemplateId && templateId === routineTemplateId) || (nameMatches && languageMatches);
};

const findRoutineTemplate = (templates, routine) =>
  (Array.isArray(templates) ? templates : []).find((template) => templateMatchesRoutine(template, routine)) || null;

const buildRoutineTemplatePayload = (template, routine, customer, options = {}) => {
  const extraValues = options.extraValues && typeof options.extraValues === 'object' ? options.extraValues : {};
  const variables = normalizeRoutineVariables(routine?.variables);
  const overrides = routine?.hsm?.parameterOverrides && typeof routine.hsm.parameterOverrides === 'object' ? routine.hsm.parameterOverrides : {};
  const overrideBody = Array.isArray(overrides.body) ? overrides.body : variables.body;
  const overrideHeader = Array.isArray(overrides.header) ? overrides.header : variables.header;
  const overrideButtons = Array.isArray(overrides.buttons) ? overrides.buttons : variables.buttons;
  const templateButtons = getTemplateButtons(template);
  const checkoutButtonOverrides = templateButtons
    .map((button, index) => {
      const buttonUrl = String(button?.url || '').trim();
      if (/\{\{\s*checkoutlink\s*\}\}/i.test(buttonUrl)) {
        return { index, type: button.type || 'url', value: '{{checkoutlink}}' };
      }
      if (/\{\{\s*(checkoutoken|checkouttoken)\s*\}\}/i.test(buttonUrl)) {
        return { index, type: button.type || 'url', value: '{{checkouttoken}}' };
      }
      return null;
    })
    .filter(Boolean);
  const effectiveButtonOverrides = overrideButtons.length > 0 ? overrideButtons : checkoutButtonOverrides;
  const resolveButtonParameterValue = (button, index) => {
    const configuredValue = String(button?.value ?? '').trim();
    if (configuredValue) return interpolateRoutineValue(configuredValue, customer, extraValues);

    const templateButton = templateButtons[index] || {};
    const buttonUrl = String(templateButton?.url || '').trim();
    if (/\{\{\s*checkoutlink\s*\}\}/i.test(buttonUrl)) {
      return String(resolveCustomerValue(customer, 'checkoutlink', extraValues) || '');
    }
    if (/\{\{\s*(checkoutoken|checkouttoken)\s*\}\}/i.test(buttonUrl)) {
      return String(resolveCustomerValue(customer, 'checkouttoken', extraValues) || resolveCustomerValue(customer, 'checkoutoken', extraValues) || '');
    }

    return '';
  };
  const bodyParameters = variables.body.map((value) => interpolateRoutineValue(value, customer, extraValues));
  const headerParameters = overrideHeader.map((value) => interpolateRoutineValue(value, customer, extraValues));
  const buttonParameters = effectiveButtonOverrides.map((button, index) => ({
    index: Number.isFinite(Number(button.index)) ? Number(button.index) : index,
    type: button.type,
    value: resolveButtonParameterValue(button, Number.isFinite(Number(button.index)) ? Number(button.index) : index),
  }));
  const buttonParameterValues = buttonParameters
    .filter((button) => String(button.value || '').trim())
    .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
    .map((button) => String(button.value || '').trim());
  bodyParameters.splice(0, bodyParameters.length, ...overrideBody.map((value) => interpolateRoutineValue(value, customer, extraValues)));
  const body = replaceTemplateParameters(getTemplateBody(template), bodyParameters);
  const headerText = replaceTemplateParameters(String(template?.headerText || ''), headerParameters);
  const headerFormat = String(template?.headerFormat || '').trim().toUpperCase();
  const headerType = String(template?.headerType || '').trim().toLowerCase();
  const headerMediaUrl = String(routine?.hsm?.mediaOverride?.url || template?.headerMediaUrl || template?.headerExample || '').trim();
  const isMediaHeader =
    ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) || ['image', 'video', 'document'].includes(headerType);
  const effectiveHeaderParameters = isMediaHeader && headerMediaUrl ? [headerMediaUrl] : headerParameters;

  return {
    templateName: getTemplateName(template),
    language: getTemplateLanguage(template),
    parameters: bodyParameters,
    bodyParameters,
    headerParameters: effectiveHeaderParameters,
    textHeaderParameters: headerParameters,
    buttonParameters,
    buttonParameterValues,
    headerFormat,
    headerType,
    headerText,
    headerMediaUrl,
    previewText: body,
    body,
    footer: String(template?.footer || '').trim(),
    buttons: templateButtons,
  };
};

const buildScheduleCustomerSource = (schedule = {}, conversation = {}) => ({
  id: schedule.customerId || conversation.customer?.id || '',
  name: schedule.customerName || conversation.contact_name || conversation.customer?.name || '',
  display_name: schedule.customerName || conversation.contact_name || conversation.customer?.name || '',
  whatsapp: schedule.customerPhone || conversation.contact_phone || conversation.customer?.phone || '',
  phone_digits: normalizePhone(schedule.customerPhone || conversation.contact_phone || conversation.customer?.phone || ''),
  raw: {
    nome: schedule.customerName || conversation.contact_name || conversation.customer?.name || '',
    telefone: schedule.customerPhone || conversation.contact_phone || conversation.customer?.phone || '',
    protocolo: schedule.conversationId || conversation.id || '',
    atendente: schedule.createdByName || '',
  },
});

const resolveQuickReplyScheduledText = (value, schedule = {}, conversation = {}, runtimeVariables = {}) => {
  const source = {
    nome: schedule.customerName || conversation.contact_name || conversation.customer?.name || '',
    telefone: schedule.customerPhone || conversation.contact_phone || conversation.customer?.phone || '',
    protocolo: schedule.conversationId || conversation.id || '',
    atendente: schedule.createdByName || '',
    servico: conversation.department || conversation.sector || '',
  };
  return String(value || '').replace(/\{#([^}]+)\}/g, (_, key) => {
    const normalized = String(key || '').trim().toLowerCase();
    const exactKey = `{#${String(key || '').trim()}}`;
    return runtimeVariables[exactKey] ?? source[normalized] ?? '';
  });
};

const getQuickReplyScheduledActions = (reply = {}) => {
  if (Array.isArray(reply.actions) && reply.actions.length > 0) return reply.actions;
  const content = String(reply.content || '').trim();
  return content
    ? [{
        id: `legacy-${reply.id || 'reply'}`,
        type: 'text',
        content,
        typingDelaySeconds: 0,
        nextActionDelaySeconds: 0,
      }]
    : [];
};

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

const detectQuickReplyDataUrlMimeType = (dataUrl = '') =>
  String(dataUrl || '').match(/^data:([^;]+);base64,/i)?.[1]?.toLowerCase() || '';

const detectQuickReplyFileExtension = (fileName = '') =>
  String(fileName || '').split('.').pop()?.trim().toLowerCase() || '';

const fallbackQuickReplyMimeType = (actionType, fileName) => {
  const extension = detectQuickReplyFileExtension(fileName);
  if (actionType === 'image') return QUICK_REPLY_IMAGE_MIME_BY_EXTENSION[extension] || 'image/png';
  if (actionType === 'video') return QUICK_REPLY_VIDEO_MIME_BY_EXTENSION[extension] || 'video/mp4';
  if (actionType === 'audio') return QUICK_REPLY_AUDIO_MIME_BY_EXTENSION[extension] || 'audio/ogg';
  return QUICK_REPLY_DOCUMENT_MIME_BY_EXTENSION[extension] || 'application/octet-stream';
};

const defaultQuickReplyFileName = (actionType, mimeType) => {
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
};

const getQuickReplyBase64SizeKb = (dataUrl = '') => {
  const raw = String(dataUrl || '');
  const payload = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  return Math.max(0, Math.round((payload.length * 3) / 4 / 1024));
};

const resolveScheduledQuickReplyMediaPayload = (action = {}) => {
  const media = action.media || {};
  const dataUrl = String(media.dataUrl || media.base64 || '').trim();
  if (!dataUrl) return null;
  const actionType = String(action.type || '').trim().toLowerCase();
  const fileNameCandidate = String(media.fileName || media.filename || '').trim();
  const mimeType = String(media.mimeType || media.mimetype || '').trim().toLowerCase()
    || detectQuickReplyDataUrlMimeType(dataUrl)
    || fallbackQuickReplyMimeType(actionType, fileNameCandidate);
  const fileName = fileNameCandidate || defaultQuickReplyFileName(actionType, mimeType);
  const kind = ['image', 'video', 'audio', 'document'].includes(actionType)
    ? actionType
    : String(media.kind || '').trim().toLowerCase();
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
    endpoint: endpointByKind[kind] || 'send-document',
    approxSizeKb: getQuickReplyBase64SizeKb(dataUrl),
  };
};

const resolveScheduledQuickReplyUraPayload = (action = {}, schedule = {}, conversation = {}, runtimeVariables = {}) => {
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
        title: resolveQuickReplyScheduledText(label, schedule, conversation, runtimeVariables).slice(0, 20),
      };
    })
    .filter(Boolean)
    .slice(0, 3);
  return {
    text: resolveQuickReplyScheduledText(action.content || ura.description || metadata.description || 'Selecione uma opção:', schedule, conversation, runtimeVariables),
    buttonText: resolveQuickReplyScheduledText(ura.buttonText || metadata.buttonText || 'Selecionar', schedule, conversation, runtimeVariables).slice(0, 20) || 'Selecionar',
    footer: resolveQuickReplyScheduledText(ura.footer || metadata.footer || '', schedule, conversation, runtimeVariables),
    buttons,
  };
};

const executeScheduledQuickReplyAction = async (schedule, reply, conversation) => {
  const phone = normalizePhone(schedule.customerPhone || conversation?.contact_phone || conversation?.customer?.phone || '');
  if (!phone) throw new Error('Agendamento sem telefone do cliente.');
  const selector = getRouteSelectorFromConversation(conversation || {});
  let runtimeVariables = {};

  for (const action of getQuickReplyScheduledActions(reply)) {
    const typingDelay = Math.max(0, Math.min(300, Number(action.typingDelaySeconds) || 0));
    const nextDelay = Math.max(0, Math.min(300, Number(action.nextActionDelaySeconds ?? action.waitSeconds) || 0));
    if (action.type === 'timer' || action.type === 'wait') {
      await delay(Math.max(nextDelay, Number(action.waitSeconds) || 0) * 1000);
      continue;
    }
    if (typingDelay > 0) await delay(typingDelay * 1000);

    if (action.type === 'newbr_test') {
      const result = await createNewbrTestForConversation({
        conversation,
        payload: {
          conversationId: schedule.conversationId || conversation.id || '',
          customerName: schedule.customerName || conversation.contact_name || conversation.customer?.name || '',
          customerPhone: phone,
          appName: action.label || 'Teste Completo 4 horas',
          durationMinutes: action.durationMinutes || 240,
          followUpEnabled: action.followUpEnabled !== false,
          followUpBeforeMinutes: action.followUpBeforeMinutes ?? 10,
          followUpMessage: action.followUpMessage || '',
          action,
        },
      });
      runtimeVariables = { ...runtimeVariables, ...(result?.variables || {}) };
    } else if (action.type === 'text') {
      const text = resolveQuickReplyScheduledText(action.content, schedule, conversation, runtimeVariables);
      if (text.trim()) {
        await requestWhatsappApiJson('/api/whatsapp/send-text', {
          to: phone,
          text,
          origin: 'scheduled-quick-reply',
          agentName: schedule.createdByName || 'Bot',
          ...selector,
        });
      }
    } else if (['image', 'video', 'audio', 'document'].includes(action.type)) {
      const mediaPayload = resolveScheduledQuickReplyMediaPayload(action);
      if (!mediaPayload?.dataUrl) continue;
      log(
        `Executando ação de ${mediaPayload.kind}: mimeType=${mediaPayload.mimeType}, endpoint=${mediaPayload.endpoint}, sizeKb=${mediaPayload.approxSizeKb}`,
      );
      const basePayload = {
        to: phone,
        mimetype: mediaPayload.mimeType,
        caption: resolveQuickReplyScheduledText(action.caption || '', schedule, conversation, runtimeVariables),
        origin: 'scheduled-quick-reply',
        agentName: schedule.createdByName || 'Bot',
        ...selector,
      };
      if (mediaPayload.kind === 'image') {
        await requestWhatsappApiJson('/api/whatsapp/send-image', { ...basePayload, imageBase64: stripDataUrlPrefix(mediaPayload.dataUrl) });
      } else if (mediaPayload.kind === 'audio') {
        await requestWhatsappApiJson('/api/whatsapp/send-audio', { ...basePayload, audioBase64: stripDataUrlPrefix(mediaPayload.dataUrl), ptt: true });
      } else if (mediaPayload.kind === 'video') {
        try {
          await requestWhatsappApiJson('/api/whatsapp/send-video', {
            ...basePayload,
            videoBase64: stripDataUrlPrefix(mediaPayload.dataUrl),
            filename: mediaPayload.fileName,
          });
        } catch (error) {
          if (![404, 501].includes(Number(error.status))) throw error;
          log(`Fallback aplicado: endpoint de vídeo indisponível, envio como documento. mimeType=${mediaPayload.mimeType}`);
          await requestWhatsappApiJson('/api/whatsapp/send-document', {
            ...basePayload,
            documentBase64: stripDataUrlPrefix(mediaPayload.dataUrl),
            filename: mediaPayload.fileName,
          });
        }
      } else {
        await requestWhatsappApiJson('/api/whatsapp/send-document', {
          ...basePayload,
          documentBase64: stripDataUrlPrefix(mediaPayload.dataUrl),
          filename: mediaPayload.fileName,
        });
      }
    } else if (action.type === 'ura') {
      const uraPayload = resolveScheduledQuickReplyUraPayload(action, schedule, conversation, runtimeVariables);
      if (!uraPayload.buttons.length) {
        log('URA ignorada: nenhuma opção válida configurada.');
      } else {
        try {
          await requestWhatsappApiJson('/api/whatsapp/send-interactive', {
            to: phone,
            text: uraPayload.text,
            buttonText: uraPayload.buttonText,
            buttons: uraPayload.buttons,
            footer: uraPayload.footer,
            origin: 'scheduled-quick-reply',
            agentName: schedule.createdByName || 'Bot',
            ...selector,
          });
          log(`URA enviada como botões com ${uraPayload.buttons.length} opções`);
        } catch (error) {
          if (![404, 501].includes(Number(error.status))) throw error;
          log('Envio de URA por botões ainda não possui integração ativa. A sequência continuará.');
        }
      }
    }

    if (nextDelay > 0) await delay(nextDelay * 1000);
  }
};

const executeQuickReplyActionChain = async ({
  actions = [],
  schedule = {},
  reply = {},
  conversation = {},
  phone: explicitPhone = '',
  origin = 'routine-follow-up',
  agentName = 'Bot',
  routeSelector = {},
} = {}) => {
  const phone = normalizePhone(explicitPhone || schedule.customerPhone || conversation?.contact_phone || conversation?.customer?.phone || '');
  if (!phone) throw new Error('Cadeia de resposta rápida sem telefone do cliente.');
  const selector = routeSelector && typeof routeSelector === 'object' ? routeSelector : getRouteSelectorFromConversation(conversation || {});
  const normalizedActions = Array.isArray(actions) && actions.length ? actions : getQuickReplyScheduledActions(reply);
  const sentTypes = [];
  let runtimeVariables = {};

  for (const [actionIndex, action] of normalizedActions.entries()) {
    const actionType = String(action.type || 'text').trim().toLowerCase();
    const typingDelay = Math.max(0, Math.min(300, Number(action.typingDelaySeconds) || 0));
    const nextDelay = Math.max(0, Math.min(300, Number(action.nextActionDelaySeconds ?? action.waitSeconds) || 0));
    if (actionType === 'timer' || actionType === 'wait') {
      sentTypes.push(actionType);
      await delay(Math.max(nextDelay, Number(action.waitSeconds) || 0) * 1000);
      continue;
    }
    if (typingDelay > 0) await delay(typingDelay * 1000);

    if (actionType === 'newbr_test') {
      const result = await createNewbrTestForConversation({
        conversation,
        payload: {
          conversationId: schedule.conversationId || conversation.id || '',
          customerName: schedule.customerName || conversation.contact_name || conversation.customer?.name || '',
          customerPhone: phone,
          appName: action.label || 'Teste Completo 4 horas',
          durationMinutes: action.durationMinutes || 240,
          followUpEnabled: action.followUpEnabled !== false,
          followUpBeforeMinutes: action.followUpBeforeMinutes ?? 10,
          followUpMessage: action.followUpMessage || '',
          action,
        },
      });
      runtimeVariables = { ...runtimeVariables, ...(result?.variables || {}) };
      sentTypes.push(actionType);
    } else if (actionType === 'text') {
      const text = resolveQuickReplyScheduledText(action.content, schedule, conversation, runtimeVariables);
      if (text.trim()) {
        await requestWhatsappApiJson('/api/whatsapp/send-text', {
          to: phone,
          text,
          origin,
          agentName,
          ...selector,
        });
        sentTypes.push(actionType);
      }
    } else if (['image', 'video', 'audio', 'document'].includes(actionType)) {
      const mediaPayload = resolveScheduledQuickReplyMediaPayload({ ...action, type: actionType });
      if (!mediaPayload?.dataUrl) {
        log(`Ação de ${actionType} ignorada no follow up: mídia ausente.`);
        continue;
      }
      const basePayload = {
        to: phone,
        mimetype: mediaPayload.mimeType,
        caption: resolveQuickReplyScheduledText(action.caption || '', schedule, conversation, runtimeVariables),
        origin,
        agentName,
        ...selector,
      };
      if (mediaPayload.kind === 'image') {
        await requestWhatsappApiJson('/api/whatsapp/send-image', { ...basePayload, imageBase64: stripDataUrlPrefix(mediaPayload.dataUrl) });
      } else if (mediaPayload.kind === 'audio') {
        await requestWhatsappApiJson('/api/whatsapp/send-audio', { ...basePayload, audioBase64: stripDataUrlPrefix(mediaPayload.dataUrl), ptt: true });
      } else if (mediaPayload.kind === 'video') {
        try {
          await requestWhatsappApiJson('/api/whatsapp/send-video', {
            ...basePayload,
            videoBase64: stripDataUrlPrefix(mediaPayload.dataUrl),
            filename: mediaPayload.fileName,
          });
        } catch (error) {
          if (![404, 501].includes(Number(error.status))) {
            error.actionIndex = actionIndex;
            error.actionType = actionType;
            throw error;
          }
          await requestWhatsappApiJson('/api/whatsapp/send-document', {
            ...basePayload,
            documentBase64: stripDataUrlPrefix(mediaPayload.dataUrl),
            filename: mediaPayload.fileName,
          });
        }
      } else {
        await requestWhatsappApiJson('/api/whatsapp/send-document', {
          ...basePayload,
          documentBase64: stripDataUrlPrefix(mediaPayload.dataUrl),
          filename: mediaPayload.fileName,
        });
      }
      sentTypes.push(actionType);
    } else if (actionType === 'ura') {
      const uraPayload = resolveScheduledQuickReplyUraPayload(action, schedule, conversation, runtimeVariables);
      if (!uraPayload.buttons.length) {
        log('URA ignorada no follow up: nenhuma opção válida configurada.');
      } else {
        try {
          await requestWhatsappApiJson('/api/whatsapp/send-interactive', {
            to: phone,
            text: uraPayload.text,
            buttonText: uraPayload.buttonText,
            buttons: uraPayload.buttons,
            footer: uraPayload.footer,
            origin,
            agentName,
            ...selector,
          });
          sentTypes.push(actionType);
        } catch (error) {
          if (![404, 501].includes(Number(error.status))) {
            error.actionIndex = actionIndex;
            error.actionType = actionType;
            throw error;
          }
          log('Envio de URA no follow up ainda não possui integração ativa. A sequência continuará.');
        }
      }
    } else if (actionType === 'transfer') {
      log('Ação de transferência ignorada no follow up: execução automática não transfere atendimento.');
    } else {
      log(`Ação ${actionType || 'desconhecida'} ignorada no follow up: tipo não suportado.`);
    }

    if (nextDelay > 0) await delay(nextDelay * 1000);
  }

  return { sentTypes, totalSent: sentTypes.length };
};

const NEWBR_TEST_DEFAULT_URLS = Object.freeze({
  url: 'http://kyup.top',
  alternativeUrl: 'http://bludx.top',
  alternativeUrl1: 'http://levi25.biz',
});

const NEWBR_TEST_VARIABLE_KEYS = Object.freeze({
  username: '{#usuarioTeste}',
  password: '{#senhaTeste}',
  code: '{#codigoTeste}',
  provider: '{#provedorTeste}',
  url: '{#urlTeste}',
  alternativeUrl: '{#urlTesteAlternativo}',
  alternativeUrl1: '{#urlTesteAlternativo1}',
  expiresAt: '{#vencimentoTeste}',
  remaining: '{#tempoRestanteTeste}',
});

const addMinutes = (date, minutes) => new Date(date.getTime() + Number(minutes || 0) * 60 * 1000);

const extractRegexValue = (text, patterns = []) => {
  const source = String(text || '');
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return String(match[1]).trim();
  }
  return '';
};

const extractUrls = (text) => {
  const urls = String(text || '').match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return urls.map((url) => url.replace(/[),.;]+$/, ''));
};

const normalizeNewbrTestResponse = ({ raw, startedAt = new Date(), durationMinutes = 240 } = {}) => {
  const reply = String(raw?.reply || raw?.message || raw?.text || raw?.data?.reply || '');
  const source = `${reply}\n${JSON.stringify(raw || {})}`;
  const urls = extractUrls(source);
  const username =
    raw?.username ||
    raw?.user ||
    raw?.login ||
    raw?.data?.username ||
    raw?.data?.user ||
    extractRegexValue(source, [/(?:usu[aá]rio|usuario|login|user)\s*[:\-]\s*([^\s\n\r]+)/i]);
  const password =
    raw?.password ||
    raw?.pass ||
    raw?.senha ||
    raw?.data?.password ||
    raw?.data?.senha ||
    extractRegexValue(source, [/(?:senha|password|pass)\s*[:\-]\s*([^\s\n\r]+)/i]);
  const code =
    raw?.code ||
    raw?.codigo ||
    raw?.cod ||
    raw?.data?.code ||
    raw?.data?.codigo ||
    extractRegexValue(source, [/(?:c[oó]digo|codigo|cod)\s*[:\-]\s*([^\s\n\r]+)/i]);
  const provider =
    raw?.provider ||
    raw?.provedor ||
    raw?.data?.provider ||
    raw?.data?.provedor ||
    extractRegexValue(source, [/(?:provedor|provider)\s*[:\-]\s*([^\n\r]+)/i]);
  const dnsUrl = raw?.dns || raw?.url || raw?.data?.dns || raw?.data?.url || urls[0] || '';
  const rawExpiresAt = raw?.expiresAt || raw?.expires_at || raw?.expiration || raw?.data?.expiresAt || raw?.data?.expires_at || '';
  const parsedExpiresAt = Date.parse(rawExpiresAt);
  const expiresAt = Number.isFinite(parsedExpiresAt) ? new Date(parsedExpiresAt).toISOString() : addMinutes(startedAt, durationMinutes).toISOString();
  const test = {
    username: String(username || '').trim(),
    password: String(password || '').trim(),
    code: String(code || '').trim(),
    provider: String(provider || '').trim(),
    url: String(dnsUrl || NEWBR_TEST_DEFAULT_URLS.url).trim(),
    alternativeUrl: String(raw?.alternativeUrl || raw?.alternative_url || urls[1] || NEWBR_TEST_DEFAULT_URLS.alternativeUrl).trim(),
    alternativeUrl1: String(raw?.alternativeUrl1 || raw?.alternative_url_1 || urls[2] || NEWBR_TEST_DEFAULT_URLS.alternativeUrl1).trim(),
    startedAt: startedAt.toISOString(),
    expiresAt,
    durationMinutes,
  };
  const remainingMs = Math.max(0, Date.parse(test.expiresAt) - Date.now());
  const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
  const variables = {
    [NEWBR_TEST_VARIABLE_KEYS.username]: test.username,
    [NEWBR_TEST_VARIABLE_KEYS.password]: test.password,
    [NEWBR_TEST_VARIABLE_KEYS.code]: test.code,
    [NEWBR_TEST_VARIABLE_KEYS.provider]: test.provider,
    [NEWBR_TEST_VARIABLE_KEYS.url]: test.url,
    [NEWBR_TEST_VARIABLE_KEYS.alternativeUrl]: test.alternativeUrl,
    [NEWBR_TEST_VARIABLE_KEYS.alternativeUrl1]: test.alternativeUrl1,
    [NEWBR_TEST_VARIABLE_KEYS.expiresAt]: test.expiresAt,
    [NEWBR_TEST_VARIABLE_KEYS.remaining]: remainingMinutes > 0 ? `${remainingMinutes} min` : '',
  };
  return { reply, test, variables };
};

const buildNewbrTestPayload = ({
  appName = 'Teste Completo 4 horas',
  customerName = '',
  customerPhone = '',
  devicePhone = '',
} = {}) => ({
  appName,
  messageDateTime: Math.floor(Date.now() / 1000),
  devicePhone: normalizePhoneDisplay(devicePhone || customerPhone),
  deviceName: 'MaisTV Device',
  senderMessage: 'Gerado com SaasTV',
  senderPhone: normalizePhoneDisplay(customerPhone),
  customerWhatsapp: normalizePhoneDisplay(customerPhone),
  senderName: String(customerName || '').trim(),
  customerName: String(customerName || '').trim(),
  userAgent: '+TV',
});

const extractPhoneFromConversationId = (conversationId = '') => {
  const raw = String(conversationId || '').trim();
  const aggregateMatch = raw.match(/^(?:agg|wa)-(\d{10,15})$/i);
  if (aggregateMatch) return aggregateMatch[1];
  const jidMatch = raw.match(/^(\d{10,15})@/);
  if (jidMatch) return jidMatch[1];
  return '';
};

const resolveNewbrCustomerPhone = ({ payload = {}, conversation = {} } = {}) => {
  const candidates = [
    payload.customerPhone,
    payload.phone,
    payload.whatsapp,
    conversation.contact_phone,
    conversation.contactPhone,
    conversation.phone,
    conversation.customer_phone,
    conversation.customerPhone,
    conversation.customer_phone_normalized,
    conversation.wa_id,
    conversation.waId,
    conversation.remoteJid,
    conversation.customer?.phone,
    conversation.customer?.whatsapp,
    conversation.customer?.number,
    conversation.sourceConversation?.customer?.phone,
    extractPhoneFromConversationId(payload.conversationId || conversation.id),
  ];
  const phone = candidates.find((candidate) => normalizePhone(candidate));
  return normalizePhoneDisplay(phone || '');
};

const buildNewbrTestBasicAuthHeader = () => {
  if (!NEWBR_TEST_AUTH_USER || !NEWBR_TEST_AUTH_PASS) {
    throw new SyncError(
      'Credenciais NEWBR_TEST_AUTH_USER/NEWBR_TEST_AUTH_PASS nao configuradas.',
      500,
      'newbr_test_basic_auth_missing'
    );
  }

  return `Basic ${Buffer.from(`${NEWBR_TEST_AUTH_USER}:${NEWBR_TEST_AUTH_PASS}`).toString('base64')}`;
};

const callNewbrTestApi = async (payload) => {
  if (!NEWBR_TEST_URL) {
    throw new SyncError('NEWBR_TEST_URL nao configurada.', 500, 'newbr_config');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NEWBR_TEST_TIMEOUT_MS);

  try {
    const response = await fetch(NEWBR_TEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Authorization: buildNewbrTestBasicAuthHeader(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const rawText = await response.text().catch(() => '');
    let raw = null;

    try {
      raw = rawText ? JSON.parse(rawText) : {};
    } catch {
      raw = { reply: rawText };
    }

    if (!response.ok) {
      const error = new SyncError(
        raw?.error || raw?.message || `Falha NewBR (${response.status}).`,
        response.status,
        'newbr_request_failed'
      );
      error.payload = raw;
      throw error;
    }

    return raw;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new SyncError(
        'Tempo limite excedido ao criar teste NewBR.',
        504,
        'newbr_test_timeout'
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const normalizeNewbrTestSession = (session = {}, index = 0) => {
  const now = nowIso();
  const durationMinutes = Number.isFinite(Number(session.durationMinutes)) ? Number(session.durationMinutes) : 240;
  const startedAt = session.startedAt || now;
  const expiresAt = session.expiresAt || addMinutes(new Date(startedAt), durationMinutes).toISOString();
  return {
    id: String(session.id || `newbr-test-session-${Date.now()}-${index}`),
    conversationId: String(session.conversationId || ''),
    customerPhone: normalizePhoneDisplay(session.customerPhone || ''),
    customerName: String(session.customerName || ''),
    username: String(session.username || ''),
    password: String(session.password || ''),
    code: String(session.code || ''),
    provider: String(session.provider || ''),
    url: String(session.url || NEWBR_TEST_DEFAULT_URLS.url),
    alternativeUrl: String(session.alternativeUrl || NEWBR_TEST_DEFAULT_URLS.alternativeUrl),
    alternativeUrl1: String(session.alternativeUrl1 || NEWBR_TEST_DEFAULT_URLS.alternativeUrl1),
    rawResponse: session.rawResponse && typeof session.rawResponse === 'object' ? session.rawResponse : {},
    startedAt,
    expiresAt,
    durationMinutes,
    followUpAt: session.followUpAt || null,
    followUpMessage: String(session.followUpMessage || ''),
    followUpEnabled: session.followUpEnabled !== false,
    followUpSentAt: session.followUpSentAt || null,
    status: String(session.status || 'trial'),
    createdAt: String(session.createdAt || now),
    updatedAt: String(session.updatedAt || now),
  };
};

const getNewbrTestSessionVariables = (session = {}) => {
  const expiresAtMs = Date.parse(session.expiresAt || '');
  const remainingMinutes = Number.isFinite(expiresAtMs) ? Math.max(0, Math.ceil((expiresAtMs - Date.now()) / (60 * 1000))) : 0;
  return {
    [NEWBR_TEST_VARIABLE_KEYS.username]: session.username || '',
    [NEWBR_TEST_VARIABLE_KEYS.password]: session.password || '',
    [NEWBR_TEST_VARIABLE_KEYS.code]: session.code || '',
    [NEWBR_TEST_VARIABLE_KEYS.provider]: session.provider || '',
    [NEWBR_TEST_VARIABLE_KEYS.url]: session.url || NEWBR_TEST_DEFAULT_URLS.url,
    [NEWBR_TEST_VARIABLE_KEYS.alternativeUrl]: session.alternativeUrl || NEWBR_TEST_DEFAULT_URLS.alternativeUrl,
    [NEWBR_TEST_VARIABLE_KEYS.alternativeUrl1]: session.alternativeUrl1 || NEWBR_TEST_DEFAULT_URLS.alternativeUrl1,
    [NEWBR_TEST_VARIABLE_KEYS.expiresAt]: session.expiresAt || '',
    [NEWBR_TEST_VARIABLE_KEYS.remaining]: remainingMinutes > 0 ? `${remainingMinutes} min` : '',
  };
};

const findActiveNewbrTestSession = (store = {}, { conversationId = '', phone = '' } = {}) => {
  const phoneDigits = normalizePhone(phone);
  const now = Date.now();
  return (Array.isArray(store.newbrTestSessions) ? store.newbrTestSessions : [])
    .map((session, index) => normalizeNewbrTestSession(session, index))
    .filter((session) => {
      if (['converted', 'cancelled', 'completed'].includes(String(session.status || '').toLowerCase())) return false;
      const expiresAt = Date.parse(session.expiresAt || '');
      if (Number.isFinite(expiresAt) && expiresAt <= now) return false;
      return (
        (conversationId && String(session.conversationId || '') === String(conversationId)) ||
        (phoneDigits && normalizePhone(session.customerPhone) === phoneDigits)
      );
    })
    .sort((left, right) => (Date.parse(right.startedAt || '') || 0) - (Date.parse(left.startedAt || '') || 0))[0] || null;
};

const upsertNewbrTestSession = async ({ conversationId, customerPhone, customerName, test, raw, action = {} }) => {
  const startedAt = new Date(test.startedAt || Date.now());
  const durationMinutes = Number.isFinite(Number(action.durationMinutes)) ? Number(action.durationMinutes) : Number(test.durationMinutes || 240);
  const followUpEnabled = action.followUpEnabled !== false;
  const followUpBeforeMinutes = Number.isFinite(Number(action.followUpBeforeMinutes)) ? Number(action.followUpBeforeMinutes) : 10;
  const followUpAt = followUpEnabled ? addMinutes(startedAt, Math.max(0, durationMinutes - followUpBeforeMinutes)).toISOString() : null;
  const session = normalizeNewbrTestSession({
    id: `newbr-test-session-${crypto.randomUUID()}`,
    conversationId,
    customerPhone,
    customerName,
    username: test.username,
    password: test.password,
    code: test.code,
    provider: test.provider,
    url: test.url,
    alternativeUrl: test.alternativeUrl,
    alternativeUrl1: test.alternativeUrl1,
    rawResponse: raw,
    startedAt: startedAt.toISOString(),
    expiresAt: test.expiresAt,
    durationMinutes,
    followUpAt,
    followUpMessage: String(action.followUpMessage || 'Seu teste esta quase acabando. Ainda posso te ajudar a ativar o acesso definitivo?'),
    followUpEnabled,
    status: 'trial',
  });
  const phoneDigits = normalizePhone(customerPhone);
  await updateStore((store) => {
    const sessions = Array.isArray(store.newbrTestSessions) ? store.newbrTestSessions : [];
    store.newbrTestSessions = [
      session,
      ...sessions.map((item, index) => {
        const normalized = normalizeNewbrTestSession(item, index);
        const sameTarget =
          (conversationId && String(normalized.conversationId || '') === String(conversationId)) ||
          (phoneDigits && normalizePhone(normalized.customerPhone) === phoneDigits);
        if (!sameTarget || !['trial', 'active'].includes(String(normalized.status || '').toLowerCase())) return normalized;
        return { ...normalized, status: 'completed', updatedAt: nowIso() };
      }),
    ];
    return store;
  });
  return session;
};

const createNewbrTestForConversation = async ({ conversation = {}, payload = {} } = {}) => {
  const customerName = String(payload.customerName || conversation.contact_name || conversation.customer?.name || '').trim();
  const customerPhone = resolveNewbrCustomerPhone({ payload, conversation });
  if (!normalizePhone(customerPhone)) {
    throw new SyncError('Telefone do cliente nao informado para criar teste.', 400, 'missing_customer_phone');
  }
  const durationMinutes = Number.isFinite(Number(payload.durationMinutes)) ? Number(payload.durationMinutes) : 240;
  const requestPayload = buildNewbrTestPayload({
    appName: payload.appName || 'Teste Completo 4 horas',
    customerName,
    customerPhone,
    devicePhone: payload.devicePhone || conversation.display_phone_number || conversation.sourcePhoneNumber || '',
  });
  const raw = await callNewbrTestApi(requestPayload);
  const normalized = normalizeNewbrTestResponse({ raw, startedAt: new Date(), durationMinutes });
  if (!normalized.test.username && !normalized.test.password && !normalized.reply) {
    throw new SyncError('NewBR retornou uma resposta sem dados de teste.', 502, 'newbr_empty_response');
  }
  const session = await upsertNewbrTestSession({
    conversationId: payload.conversationId || conversation.id || '',
    customerPhone,
    customerName,
    test: normalized.test,
    raw,
    action: payload.action || payload,
  });
  const variables = {
    ...normalized.variables,
    ...getNewbrTestSessionVariables(session),
  };
  return {
    success: true,
    raw,
    reply: normalized.reply,
    test: normalized.test,
    session,
    variables,
  };
};

const normalizeNewbrTestRequest = (request = {}, index = 0) => ({
  id: String(request.id || `newbr-test-request-${Date.now()}-${index}`),
  status: String(request.status || 'pending_browser').trim(),
  conversationId: String(request.conversationId || ''),
  customerPhone: normalizePhoneDisplay(request.customerPhone || ''),
  customerName: String(request.customerName || ''),
  testUrl: String(request.testUrl || NEWBR_TEST_URL || DEFAULT_NEWBR_TEST_URL).trim(),
  requestPayload: request.requestPayload && typeof request.requestPayload === 'object' ? request.requestPayload : {},
  action: request.action && typeof request.action === 'object' ? request.action : {},
  durationMinutes: Number.isFinite(Number(request.durationMinutes)) ? Number(request.durationMinutes) : 240,
  requestedBy: String(request.requestedBy || ''),
  requestedByName: String(request.requestedByName || ''),
  rawResponse: request.rawResponse && typeof request.rawResponse === 'object' ? request.rawResponse : null,
  error: request.error ? String(request.error) : null,
  sessionId: request.sessionId ? String(request.sessionId) : null,
  createdAt: String(request.createdAt || nowIso()),
  updatedAt: String(request.updatedAt || nowIso()),
  finishedAt: request.finishedAt ? String(request.finishedAt) : null,
});

const prepareNewbrTestRequestForConversation = async ({ conversation = {}, payload = {} } = {}) => {
  const customerName = String(payload.customerName || conversation.contact_name || conversation.customer?.name || '').trim();
  const customerPhone = resolveNewbrCustomerPhone({ payload, conversation });
  if (!normalizePhone(customerPhone)) {
    throw new SyncError('Telefone do cliente nao informado para criar teste.', 400, 'missing_customer_phone');
  }
  const durationMinutes = Number.isFinite(Number(payload.durationMinutes)) ? Number(payload.durationMinutes) : 240;
  const requestPayload = buildNewbrTestPayload({
    appName: payload.appName || 'Teste Completo 4 horas',
    customerName,
    customerPhone,
    devicePhone: payload.devicePhone || conversation.display_phone_number || conversation.sourcePhoneNumber || '',
  });
  const request = normalizeNewbrTestRequest({
    id: `newbr-test-request-${crypto.randomUUID()}`,
    status: 'pending_browser',
    conversationId: payload.conversationId || conversation.id || '',
    customerPhone,
    customerName,
    testUrl: NEWBR_TEST_URL || DEFAULT_NEWBR_TEST_URL,
    requestPayload,
    action: payload.action || payload,
    durationMinutes,
    requestedBy: payload.requestedBy || '',
    requestedByName: payload.requestedByName || '',
  });
  await updateStore((store) => {
    const requests = Array.isArray(store.newbrTestRequests) ? store.newbrTestRequests : [];
    store.newbrTestRequests = [request, ...requests].slice(0, 500);
    return store;
  });
  return {
    success: true,
    mode: 'browser_authorization',
    request,
    requestId: request.id,
    testUrl: request.testUrl,
    requestPayload: request.requestPayload,
  };
};

const completeNewbrTestRequest = async ({ requestId, raw, error = '', success = true } = {}) => {
  const store = await readStore();
  const requests = Array.isArray(store.newbrTestRequests) ? store.newbrTestRequests.map((item, index) => normalizeNewbrTestRequest(item, index)) : [];
  const request = requests.find((item) => item.id === requestId);
  if (!request) {
    throw new SyncError('Solicitacao de teste NewBR nao encontrada.', 404, 'newbr_test_request_not_found');
  }
  if (!success) {
    const message = String(error || raw?.reply || raw?.message || 'Falha ao gerar teste NewBR pelo navegador.');
    await updateStore((current) => {
      current.newbrTestRequests = (Array.isArray(current.newbrTestRequests) ? current.newbrTestRequests : []).map((item, index) => {
        const normalized = normalizeNewbrTestRequest(item, index);
        return normalized.id === requestId
          ? { ...normalized, status: 'failed', rawResponse: raw || null, error: message, updatedAt: nowIso(), finishedAt: nowIso() }
          : normalized;
      });
      return current;
    });
    throw new SyncError(message, 502, 'newbr_browser_request_failed');
  }
  const normalized = normalizeNewbrTestResponse({ raw, startedAt: new Date(), durationMinutes: request.durationMinutes });
  if (!normalized.test.username && !normalized.test.password && !normalized.reply) {
    throw new SyncError('NewBR retornou uma resposta sem dados de teste.', 502, 'newbr_empty_response');
  }
  const session = await upsertNewbrTestSession({
    conversationId: request.conversationId,
    customerPhone: request.customerPhone,
    customerName: request.customerName,
    test: normalized.test,
    raw,
    action: request.action,
  });
  await updateStore((current) => {
    current.newbrTestRequests = (Array.isArray(current.newbrTestRequests) ? current.newbrTestRequests : []).map((item, index) => {
      const normalizedRequest = normalizeNewbrTestRequest(item, index);
      return normalizedRequest.id === requestId
        ? {
            ...normalizedRequest,
            status: 'done',
            rawResponse: raw || null,
            error: null,
            sessionId: session.id,
            updatedAt: nowIso(),
            finishedAt: nowIso(),
          }
        : normalizedRequest;
    });
    return current;
  });
  const variables = {
    ...normalized.variables,
    ...getNewbrTestSessionVariables(session),
  };
  return {
    success: true,
    mode: 'browser_authorization',
    raw,
    reply: normalized.reply,
    test: normalized.test,
    session,
    variables,
  };
};

const completeDirectNewbrTestResult = async ({ payload = {} } = {}) => {
  const raw = payload?.raw && typeof payload.raw === 'object' ? payload.raw : {};
  const success = payload?.success !== false;
  const customerName = String(payload.customerName || '').trim();
  const customerPhone = resolveNewbrCustomerPhone({ payload, conversation: {} });
  if (!normalizePhone(customerPhone)) {
    throw new SyncError('Telefone do cliente nao informado para salvar teste.', 400, 'missing_customer_phone');
  }
  const durationMinutes = Number.isFinite(Number(payload.durationMinutes)) ? Number(payload.durationMinutes) : 240;
  const auditRequest = normalizeNewbrTestRequest({
    id: `newbr-test-direct-${crypto.randomUUID()}`,
    status: success ? 'done' : 'failed',
    conversationId: payload.conversationId || '',
    customerPhone,
    customerName,
    testUrl: payload.testUrl || NEWBR_TEST_URL || DEFAULT_NEWBR_TEST_URL,
    requestPayload: payload.requestPayload && typeof payload.requestPayload === 'object' ? payload.requestPayload : {},
    action: payload.action || payload,
    durationMinutes,
    requestedBy: payload.requestedBy || '',
    requestedByName: payload.requestedByName || '',
    rawResponse: raw,
    error: success ? null : String(payload.error || raw?.reply || raw?.message || raw?.error || 'Falha ao gerar teste NewBR pelo navegador.'),
    finishedAt: nowIso(),
  });

  if (!success) {
    await updateStore((store) => {
      const requests = Array.isArray(store.newbrTestRequests) ? store.newbrTestRequests : [];
      store.newbrTestRequests = [auditRequest, ...requests].slice(0, 500);
      return store;
    });
    return {
      success: false,
      mode: 'browser_direct',
      request: auditRequest,
      error: auditRequest.error,
      raw,
    };
  }

  const normalized = normalizeNewbrTestResponse({ raw, startedAt: new Date(), durationMinutes });
  if (!normalized.test.username && !normalized.test.password && !normalized.reply) {
    throw new SyncError('NewBR retornou uma resposta sem dados de teste.', 502, 'newbr_empty_response');
  }
  const session = await upsertNewbrTestSession({
    conversationId: payload.conversationId || '',
    customerPhone,
    customerName,
    test: normalized.test,
    raw,
    action: payload.action || payload,
  });
  await updateStore((store) => {
    const requests = Array.isArray(store.newbrTestRequests) ? store.newbrTestRequests : [];
    store.newbrTestRequests = [
      {
        ...auditRequest,
        sessionId: session.id,
        updatedAt: nowIso(),
        finishedAt: nowIso(),
      },
      ...requests,
    ].slice(0, 500);
    return store;
  });
  const variables = {
    ...normalized.variables,
    ...getNewbrTestSessionVariables(session),
  };
  return {
    success: true,
    mode: 'browser_direct',
    raw,
    reply: normalized.reply,
    test: normalized.test,
    session,
    variables,
  };
};

const findCustomerByPhone = (customers = [], phone = '') => {
  const target = normalizePhone(phone);
  if (!target) return null;
  return (Array.isArray(customers) ? customers : []).find((customer) => {
    const values = [
      customer?.phone_digits,
      customer?.whatsapp,
      customer?.phone,
      customer?.number,
      customer?.customerWhatsapp,
    ];
    return values.some((value) => normalizePhone(value) === target);
  }) || null;
};

const isTrialCustomer = (customer = null) => {
  if (!customer) return null;
  const value = customer.is_trial ?? customer.isTrial ?? customer.trial ?? customer.istrial ?? customer.isTeste ?? customer.is_test;
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'sim', 'trial', 'teste'].includes(normalized);
};

const replaceNewbrSessionVariables = (text = '', session = {}, conversation = {}) => {
  const variables = {
    '{#nome}': session.customerName || conversation.contact_name || conversation.customer?.name || '',
    '{#telefone}': session.customerPhone || conversation.contact_phone || conversation.customer?.phone || '',
    ...getNewbrTestSessionVariables(session),
  };
  return String(text || '').replace(/\{#([^}]+)\}/g, (match) => variables[match] ?? '');
};

const runNewbrTestSessionSchedulerOnce = async () => {
  if (newbrTestSessionSchedulerRunning) return;
  newbrTestSessionSchedulerRunning = true;
  try {
    const store = await readStore();
    const dueSessions = (Array.isArray(store.newbrTestSessions) ? store.newbrTestSessions : [])
      .map((session, index) => normalizeNewbrTestSession(session, index))
      .filter((session) => {
        if (!session.followUpEnabled || session.followUpSentAt) return false;
        if (['converted', 'cancelled', 'completed'].includes(String(session.status || '').toLowerCase())) return false;
        return Date.parse(session.followUpAt || '') <= Date.now();
      })
      .slice(0, 5);

    for (const session of dueSessions) {
      const customer = findCustomerByPhone(store.customers, session.customerPhone);
      const trialState = isTrialCustomer(customer);
      if (customer && trialState === false) {
        await updateStore((current) => {
          current.newbrTestSessions = (Array.isArray(current.newbrTestSessions) ? current.newbrTestSessions : []).map((item) =>
            String(item.id) === String(session.id) ? { ...item, status: 'converted', updatedAt: nowIso() } : item,
          );
          return current;
        });
        continue;
      }

      const conversation =
        (Array.isArray(store.conversations) ? store.conversations : []).find((item) => String(item.id || '') === String(session.conversationId || '')) || {};
      try {
        await requestWhatsappApiJson('/api/whatsapp/send-text', {
          to: normalizePhone(session.customerPhone),
          text: replaceNewbrSessionVariables(session.followUpMessage, session, conversation),
          origin: 'newbr-test-follow-up',
          agentName: 'Bot',
          ...getRouteSelectorFromConversation(conversation || {}),
        });
        await updateStore((current) => {
          current.newbrTestSessions = (Array.isArray(current.newbrTestSessions) ? current.newbrTestSessions : []).map((item) =>
            String(item.id) === String(session.id) ? { ...item, followUpSentAt: nowIso(), updatedAt: nowIso() } : item,
          );
          return current;
        });
      } catch (error) {
        log(`[newbr-test] falha ao enviar follow-up para ${session.customerPhone}: ${error?.message || 'erro'}`);
        await updateStore((current) => {
          current.newbrTestSessions = (Array.isArray(current.newbrTestSessions) ? current.newbrTestSessions : []).map((item) =>
            String(item.id) === String(session.id) ? { ...item, lastError: error?.message || 'Falha ao enviar follow-up', followUpBlockedAt: item.followUpBlockedAt || null, updatedAt: nowIso() } : item,
          );
          return current;
        });
      }
    }
  } finally {
    newbrTestSessionSchedulerRunning = false;
  }
};

const initializeNewbrTestSessionScheduler = () => {
  if (!NEWBR_TEST_SESSION_SCHEDULER_ENABLED) return;
  if (newbrTestSessionSchedulerTimer) return;
  newbrTestSessionSchedulerTimer = setInterval(() => {
    void runNewbrTestSessionSchedulerOnce().catch((error) => {
      log(`[newbr-test] scheduler error: ${error?.message || error}`);
    });
  }, Math.max(15000, NEWBR_TEST_SESSION_SCHEDULER_INTERVAL_MS));
  if (typeof newbrTestSessionSchedulerTimer.unref === 'function') {
    newbrTestSessionSchedulerTimer.unref();
  }
  void runNewbrTestSessionSchedulerOnce().catch(() => {});
};

const buildScheduleTemplateRoutine = (schedule = {}, template = {}) => {
  const variables = schedule.hsmVariables && typeof schedule.hsmVariables === 'object' ? schedule.hsmVariables : {};
  const bodyMap = variables.body && typeof variables.body === 'object' ? variables.body : {};
  const headerMap = variables.header && typeof variables.header === 'object' ? variables.header : {};
  const buttonsMap = variables.buttons && typeof variables.buttons === 'object' ? variables.buttons : {};
  const toOrderedArray = (map) =>
    Object.entries(map)
      .sort((left, right) => Number(left[0]) - Number(right[0]))
      .map(([, value]) => String(value || ''));

  return {
    id: schedule.id,
    hsm: {
      templateId: schedule.hsmTemplateId || template.id || template.code || '',
      templateName: schedule.hsmTemplateName || getTemplateName(template),
      language: schedule.hsmLanguage || getTemplateLanguage(template),
      parameterOverrides: {
        body: toOrderedArray(bodyMap),
        header: toOrderedArray(headerMap),
        buttons: Object.entries(buttonsMap).map(([index, value]) => ({ index: Number(index) - 1, type: 'url', value })),
      },
      mediaOverride: schedule.hsmMedia?.dataUrl || schedule.hsmMedia?.url
        ? { url: schedule.hsmMedia.dataUrl || schedule.hsmMedia.url }
        : {},
    },
    variables: {
      body: toOrderedArray(bodyMap),
      header: toOrderedArray(headerMap),
      buttons: Object.entries(buttonsMap).map(([index, value]) => ({ index: Number(index) - 1, type: 'url', value })),
    },
  };
};

const executeScheduledHsm = async (schedule, template, conversation) => {
  const phone = normalizePhone(schedule.customerPhone || conversation?.contact_phone || conversation?.customer?.phone || '');
  if (!phone) throw new Error('Agendamento sem telefone do cliente.');
  const customer = buildScheduleCustomerSource(schedule, conversation);
  const routineLike = buildScheduleTemplateRoutine(schedule, template);
  const payload = buildRoutineTemplatePayload(template, routineLike, customer);
  const routeSelector = schedule.routeSelector && typeof schedule.routeSelector === 'object'
    ? schedule.routeSelector
    : { routeKey: 'default' };
  await requestWhatsappApiJson('/api/whatsapp/send-template', {
    to: phone,
    templateName: payload.templateName,
    language: payload.language,
    parameters: payload.bodyParameters,
    buttonParameters: payload.buttonParameterValues,
    headerParameters: payload.headerParameters,
    headerFormat: payload.headerFormat,
    headerType: payload.headerType,
    headerMediaUrl: payload.headerMediaUrl,
    previewText: payload.previewText,
    origin: 'scheduled-quick-reply',
    agentName: schedule.createdByName || 'Bot',
    routeKey: routeSelector.routeKey || 'default',
    phoneNumberId: routeSelector.phoneNumberId || null,
    displayPhoneNumber: routeSelector.displayPhoneNumber || null,
  }, {
    timeoutMs: ROUTINE_WHATSAPP_TIMEOUT_MS,
  });
};

const isConversationWithinScheduleWindow = (schedule = {}, conversation = {}) => {
  const expiresAt = Date.parse(schedule.windowExpiresAt || '');
  if (Number.isFinite(expiresAt)) return Date.now() <= expiresAt;
  const lastClientMs = Date.parse(
    conversation?.last_client_message_time ||
      conversation?.last_received_at ||
      conversation?.lastClientMessageTime ||
      conversation?.last_message_time ||
      '',
  );
  return Number.isFinite(lastClientMs) && Date.now() - lastClientMs <= 24 * 60 * 60 * 1000;
};

const executeDueQuickReplySchedule = async (schedule, store) => {
  const conversation =
    (Array.isArray(store.conversations) ? store.conversations : []).find((item) => String(item.id || '') === String(schedule.conversationId || '')) ||
    schedule.conversationSnapshot ||
    {};
  const schedulePhone = normalizePhone(schedule.customerPhone || conversation?.contact_phone || conversation?.customer?.phone || '');
  const reply = (Array.isArray(store.quickReplies) ? store.quickReplies : []).find((item) => String(item.id || '') === String(schedule.quickReplyId || ''));
  const quickReplySource =
    reply ||
    (schedule.quickReplySnapshot && typeof schedule.quickReplySnapshot === 'object' ? schedule.quickReplySnapshot : null);
  const deliveryType = String(schedule.deliveryType || '').trim().toLowerCase();
  if (deliveryType === 'hsm') {
    const templates = await fetchLocalHsmItemsForRoutines();
    const template = (Array.isArray(templates) ? templates : []).find((item) => {
      const templateId = String(item?.id || item?.code || '').trim();
      const scheduleTemplateId = String(schedule.hsmTemplateId || '').trim();
      const nameMatches = getTemplateName(item) && getTemplateName(item) === String(schedule.hsmTemplateName || '').trim();
      return (templateId && scheduleTemplateId && templateId === scheduleTemplateId) || nameMatches;
    });
    if (!template) throw new Error('HSM obrigatório para envio agendado não encontrado.');
    await executeScheduledHsm(schedule, template, conversation);
    return { mode: 'hsm' };
  }
  if (!reply && quickReplySource) {
    if (isConversationWithinScheduleWindow(schedule, conversation)) {
      await executeScheduledQuickReplyAction(schedule, quickReplySource, conversation);
      return { mode: 'quick_reply' };
    }

    const templates = await fetchLocalHsmItemsForRoutines();
    const template = (Array.isArray(templates) ? templates : []).find((item) => {
      const templateId = String(item?.id || item?.code || '').trim();
      const scheduleTemplateId = String(schedule.hsmTemplateId || '').trim();
      const nameMatches = getTemplateName(item) && getTemplateName(item) === String(schedule.hsmTemplateName || '').trim();
      return (templateId && scheduleTemplateId && templateId === scheduleTemplateId) || nameMatches;
    });
    if (!template) throw new Error('HSM obrigatório para envio fora das 24h não encontrado.');
    await executeScheduledHsm(schedule, template, conversation);
    return { mode: 'hsm' };
  }
  if (!reply) throw new Error('Resposta rápida do agendamento não encontrada.');

  if (isConversationWithinScheduleWindow(schedule, conversation)) {
    await executeScheduledQuickReplyAction(schedule, quickReplySource || reply, conversation);
    return { mode: 'quick_reply' };
  }

  const templates = await fetchLocalHsmItemsForRoutines();
  const template = (Array.isArray(templates) ? templates : []).find((item) => {
    const templateId = String(item?.id || item?.code || '').trim();
    const scheduleTemplateId = String(schedule.hsmTemplateId || '').trim();
    const nameMatches = getTemplateName(item) && getTemplateName(item) === String(schedule.hsmTemplateName || '').trim();
    return (templateId && scheduleTemplateId && templateId === scheduleTemplateId) || nameMatches;
  });
  if (!template) throw new Error('HSM obrigatório para envio fora das 24h não encontrado.');
  await executeScheduledHsm(schedule, template, conversation);
  return { mode: 'hsm' };
};

const runQuickReplyScheduleSchedulerOnce = async () => {
  if (quickReplyScheduleRunning) return;
  quickReplyScheduleRunning = true;
  try {
    const store = await readStore();
    const dueSchedules = (Array.isArray(store.quickReplySchedules) ? store.quickReplySchedules : [])
      .filter((schedule) => String(schedule?.status || '') === 'pending' && Date.parse(schedule?.scheduledAt || '') <= Date.now())
      .slice(0, 5);

    for (const schedule of dueSchedules) {
      const startedAt = nowIso();
      try {
        const result = await executeDueQuickReplySchedule(schedule, store);
        await updateStore((current) => {
          current.quickReplySchedules = (Array.isArray(current.quickReplySchedules) ? current.quickReplySchedules : []).map((item) =>
            String(item.id) === String(schedule.id)
              ? { ...item, status: 'sent', sentAt: nowIso(), executionMode: result.mode, lastError: '', updated_date: nowIso() }
              : item,
          );
          return current;
        });
      } catch (error) {
        await updateStore((current) => {
          current.quickReplySchedules = (Array.isArray(current.quickReplySchedules) ? current.quickReplySchedules : []).map((item) =>
            String(item.id) === String(schedule.id)
              ? {
                  ...item,
                  status: 'failed',
                  failedAt: nowIso(),
                  blockedAt: item.blockedAt || null,
                  lastError: error?.message || 'Falha ao executar agendamento.',
                  startedAt,
                  updated_date: nowIso(),
                }
              : item,
          );
          return current;
        });
      }
    }
  } finally {
    quickReplyScheduleRunning = false;
  }
};

const initializeQuickReplyScheduleScheduler = () => {
  if (!QUICK_REPLY_SCHEDULE_ENABLED) return;
  if (quickReplyScheduleTimer) stopRegisteredInterval('quick-reply-scheduler');
  quickReplyScheduleTimer = startRegisteredInterval('quick-reply-scheduler', () => {
    void runQuickReplyScheduleSchedulerOnce().catch((error) => {
      console.error(`[local-api] quick reply schedule error: ${error?.message || error}`);
    });
  }, QUICK_REPLY_SCHEDULE_INTERVAL_MS, { replace: true });
  void runQuickReplyScheduleSchedulerOnce().catch(() => {});
};

const routineNeedsCheckoutToken = (routine = {}, template = null) => {
  const values = [
    ...(Array.isArray(routine?.variables?.body) ? routine.variables.body : []),
    ...(Array.isArray(routine?.variables?.header) ? routine.variables.header : []),
    ...(Array.isArray(routine?.variables?.buttons) ? routine.variables.buttons.map((button) => button?.value) : []),
    ...(Array.isArray(routine?.hsm?.parameterOverrides?.body) ? routine.hsm.parameterOverrides.body : []),
    ...(Array.isArray(routine?.hsm?.parameterOverrides?.header) ? routine.hsm.parameterOverrides.header : []),
    ...(Array.isArray(routine?.hsm?.parameterOverrides?.buttons) ? routine.hsm.parameterOverrides.buttons.map((button) => button?.value) : []),
    ...(template ? getTemplateButtons(template).flatMap((button) => [button?.url, button?.label, button?.text]) : []),
  ].join('\n');
  return /\{\{\s*checkoutoken\s*\}\}/i.test(values) || /\{\{\s*checkouttoken\s*\}\}/i.test(values) || /\{\{\s*checkoutlink\s*\}\}/i.test(values);
};

const parseRoutinePlanMonths = (customer = {}) => {
  const raw = customer.raw && typeof customer.raw === 'object' ? customer.raw : {};
  const direct = Number(customer.planMonths ?? raw.planMonths ?? raw.plan_months ?? raw.plan ?? raw.planoMeses);
  if (Number.isFinite(direct) && direct > 0) return Math.min(24, Math.max(1, Math.round(direct)));
  const text = String(customer.package || customer.plan_name || raw.plano || raw.package || raw.packageName || raw.planoAtual || '');
  const match = text.match(/(\d{1,2})\s*(?:m[eê]s|meses|month)/i) || text.match(/\b(\d{1,2})\b/);
  const parsed = match ? Number(match[1]) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(24, Math.max(1, Math.round(parsed))) : 1;
};

const buildRoutineCheckoutData = async (customer = {}) => {
  const phone = getRoutineCustomerPhone(customer);
  if (!phone) throw new Error('Cliente sem telefone para gerar checkout.');
  const user = String(customer.username || customer.raw?.username || customer.raw?.user || customer.raw?.login || customer.display_name || phone).trim();
  const connectionsRaw = Number(customer.connections ?? customer.raw?.connections ?? customer.raw?.conexoes ?? 1);
  const connections = Number.isFinite(connectionsRaw) ? Math.min(4, Math.max(1, Math.round(connectionsRaw))) : 1;
  const planMonths = parseRoutinePlanMonths(customer);
  const created = await requestCheckoutTokenApiJson('/api/checkout/token', {
    phone,
    whatsapp: phone,
    user,
    customerId: customer.id || customer.customerId || customer.raw?.customerId || customer.raw?.id || undefined,
    customer_id: customer.id || customer.customerId || customer.raw?.customerId || customer.raw?.id || undefined,
    plan: planMonths,
    planMonths,
    connections,
  }, {
    timeoutMs: ROUTINE_CHECKOUT_TIMEOUT_MS,
  });
  const token = String(created?.token || '').trim();
  if (!token) throw new Error('Checkout sem token retornado.');
  const checkoutLink = String(created?.checkoutLink || created?.checkoutUrl || created?.url || (CHECKOUT_PUBLIC_URL ? `${CHECKOUT_PUBLIC_URL}?token=${encodeURIComponent(token)}` : '')).trim();
  return { token, checkoutLink, expiresAt: created?.expiresAt || null };
};

const customerMatchesRoutineFilters = (customer, filters = {}) => {
  const search = normalizeRoutineText(filters.search);
  if (search) {
    const haystack = normalizeRoutineText(
      [customer.display_name, customer.username, customer.whatsapp, customer.package, customer.status_label].join(' '),
    );
    if (!haystack.includes(search)) return false;
  }

  const statuses = normalizeRoutineArray(filters.status).map(normalizeRoutineText);
  if (statuses.length && !statuses.includes(normalizeRoutineText(customer.status)) && !statuses.includes(normalizeRoutineText(customer.status_label))) {
    return false;
  }

  const plans = normalizeRoutineArray(filters.plans).map(normalizeRoutineText);
  if (plans.length && !plans.includes(normalizeRoutineText(customer.package || customer.plan_name))) {
    return false;
  }

  return (Array.isArray(filters.customFields) ? filters.customFields : []).every((filter) => {
    const left = normalizeRoutineText(resolveCustomerValue(customer, filter.field));
    const right = normalizeRoutineText(filter.value);
    if (!right) return true;
    if (filter.operator === 'equals') return left === right;
    if (filter.operator === 'not_equal') return left !== right;
    return left.includes(right);
  });
};

const isRoutineTestCustomer = (customer = {}) => {
  const raw = customer.raw && typeof customer.raw === 'object' ? customer.raw : {};
  const planLabel = normalizeRoutineText(
    [customer.package, customer.plan_name, customer.planLabel, raw.plano, raw.plan, raw.package, raw.packageName, raw.planoAtual].join(' '),
  );
  return planLabel.includes('teste');
};

const resolveRoutineCustomers = (store, routine) => {
  const customers = Array.isArray(store?.customers) ? store.customers : [];
  const audience = normalizeRoutineAudience(routine?.audience);
  const selected =
    audience.type === 'manual'
      ? customers.filter((customer) => audience.customerIds.includes(String(customer?.id || '')))
      : customers.filter((customer) => customerMatchesRoutineFilters(customer, audience.filters));
  const seenPhones = new Set();

  return selected.filter((customer) => {
    if (isRoutineTestCustomer(customer)) return false;
    const phone = normalizePhone(customer?.whatsapp || customer?.phone_digits || customer?.raw?.whatsapp || '');
    if (!phone || seenPhones.has(phone)) return false;
    seenPhones.add(phone);
    return true;
  });
};

const parseDateOnly = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const addDaysToDateKey = (dateKey, days) => {
  const parsed = new Date(`${dateKey}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return parsed.toISOString().slice(0, 10);
};

const addMonthsToDateKey = (dateKey, monthsDelta) => {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const delta = Number.parseInt(String(monthsDelta || 0), 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(delta)) {
    return null;
  }
  const targetMonthIndex = year * 12 + (month - 1) + delta;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonthZero = targetMonthIndex - targetYear * 12;
  const targetMonth = targetMonthZero + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
};

const getCustomerDueDateKey = (customer = {}) =>
  parseDateOnly(
    customer.expires_at ||
      customer.due_date ||
      customer.raw?.vencimento ||
      customer.raw?.due_date ||
      customer.raw?.expiration_date ||
      customer.raw?.expires_at,
  );

const getCustomerCreatedDateKey = (customer = {}) =>
  parseDateOnly(
    customer.created_at ||
      customer.createdAt ||
      customer.created_date ||
      customer.raw?.created_at ||
      customer.raw?.createdAt ||
      customer.raw?.createdDate ||
      customer.raw?.dataCriacao ||
      customer.raw?.installationDate ||
      customer.raw?.installedAt ||
      customer.synced_at,
  );

const getRoutineCustomerTargetDateKey = (routine = {}, customer = {}, context = null) => {
  const ruleDays = Math.max(0, Number.parseInt(String(routine.ruleDays ?? 0), 10) || 0);
  if (routine.rule === 'after_installation') {
    const createdDate = getCustomerCreatedDateKey(customer);
    return createdDate ? addDaysToDateKey(createdDate, ruleDays) : null;
  }

  const dueDate = getRoutineDueDateKey(customer, context);
  if (!dueDate) return null;
  return addDaysToDateKey(dueDate, routine.rule === 'before_due' ? -ruleDays : ruleDays);
};

const filterRoutineCustomersForToday = (customers = [], routine = {}, dateKey = getSaoPauloDateParts().dateKey, context = null) =>
  customers
    .filter((customer) => getRoutineCustomerTargetDateKey(routine, customer, context) === dateKey)
    .map((customer) => applyRenovadosErradoRoutineCorrection(customer, context));

const resolveManualRoutineCustomers = (store, customerIds = []) => {
  const allowedIds = new Set(normalizeRoutineArray(customerIds));
  const seenPhones = new Set();
  const customers = (Array.isArray(store?.customers) ? store.customers : []).filter((customer) => allowedIds.has(String(customer?.id || '')));
  let duplicates = 0;
  let ignored = 0;
  const selected = [];

  customers.forEach((customer) => {
    const phone = normalizePhone(customer?.whatsapp || customer?.phone_digits || customer?.raw?.whatsapp || '');
    if (!phone) {
      ignored += 1;
      return;
    }
    if (seenPhones.has(phone)) {
      duplicates += 1;
      return;
    }
    seenPhones.add(phone);
    selected.push(customer);
  });

  return { customers: selected, ignored, duplicates };
};

const getRoutineCustomerDisplayName = (customer = {}) =>
  String(customer.display_name || customer.name || customer.username || customer.raw?.nome || customer.raw?.name || 'Cliente sem nome').trim();

const getRoutineCustomerPhone = (customer = {}) =>
  normalizePhone(customer?.whatsapp || customer?.phone_digits || customer?.raw?.whatsapp || customer?.raw?.telefone || customer?.raw?.phone || '');

const buildRoutinePhoneLookupKeys = (value) => {
  const digits = normalizePhone(value);
  if (!digits) return [];
  const keys = new Set([digits]);
  if (digits.startsWith('55') && digits.length > 11) keys.add(digits.slice(2));
  if (digits.length >= 11) keys.add(digits.slice(-11));
  if (digits.length >= 10) keys.add(digits.slice(-10));
  return Array.from(keys).filter(Boolean);
};

const buildRoutineCustomerIdentityKeys = (customer = {}) => {
  const raw = customer.raw && typeof customer.raw === 'object' ? customer.raw : {};
  const phone = getRoutineCustomerPhone(customer);
  return Array.from(
    new Set(
      [
        customer.id,
        customer.customerId,
        customer.customer_id,
        customer.username,
        customer.sync_key,
        raw.id,
        raw.customerId,
        raw.customer_id,
        raw.username,
        raw.usuario,
        raw.sync_key,
        ...buildRoutinePhoneLookupKeys(phone).map((key) => `phone:${key}`),
      ]
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
};

const buildRenovadosErradoRoutineContext = (store = {}) => {
  if (!ROUTINE_RENOVADOS_ERRADO_VALIDATION_ENABLED) {
    return { enabled: false, label: null, phones: new Set(), identityKeys: new Set(), assignmentCount: 0 };
  }
  const labelsState = normalizeLabelsState(store?.labels);
  const expectedLabelName = normalizeRoutineText(ROUTINE_RENOVADOS_ERRADO_LABEL_NAME).replace(/\s+/g, ' ');
  const label =
    labelsState.customLabels.find((item) => normalizeRoutineText(item?.name).replace(/\s+/g, ' ') === expectedLabelName) ||
    null;
  if (!label?.id) {
    return { enabled: true, label: null, phones: new Set(), identityKeys: new Set(), assignmentCount: 0 };
  }

  const phones = new Set();
  const identityKeys = new Set();
  const rememberKey = (key) => {
    const safeKey = String(key || '').trim();
    if (!safeKey) return;
    identityKeys.add(safeKey);
    buildRoutinePhoneLookupKeys(safeKey).forEach((phoneKey) => {
      phones.add(phoneKey);
      identityKeys.add(`phone:${phoneKey}`);
    });
  };
  let assignmentCount = 0;

  Object.entries(labelsState.assignments || {}).forEach(([targetKey, labelIds]) => {
    const ids = Array.isArray(labelIds) ? labelIds.map(String) : [];
    if (!ids.includes(String(label.id))) return;
    assignmentCount += 1;
    rememberKey(targetKey);
  });

  Object.entries(labelsState.stageAssignments || {}).forEach(([targetKey, labelId]) => {
    if (String(labelId || '') !== String(label.id)) return;
    assignmentCount += 1;
    rememberKey(targetKey);
  });

  return { enabled: true, label, phones, identityKeys, assignmentCount };
};

const customerMatchesRenovadosErradoContext = (customer = {}, context = null) => {
  if (!context?.enabled || !context?.label) return false;
  const phoneKeys = buildRoutinePhoneLookupKeys(getRoutineCustomerPhone(customer));
  if (phoneKeys.some((key) => context.phones?.has(key))) return true;
  return buildRoutineCustomerIdentityKeys(customer).some((key) => context.identityKeys?.has(key));
};

const parseRenovadosErradoRoutinePlanMonths = (customer = {}) => {
  const raw = customer.raw && typeof customer.raw === 'object' ? customer.raw : {};
  const direct = Number(
    customer.checkoutPlanMonths ??
      customer.planMonths ??
      customer.plan_months ??
      raw.checkoutPlanMonths ??
      raw.planMonths ??
      raw.plan_months ??
      raw.planoMeses,
  );
  if (Number.isFinite(direct) && direct > 0) return Math.min(24, Math.max(1, Math.round(direct)));
  const text = String(
    [
      customer.checkoutPlanLabel,
      customer.planLabel,
      customer.package,
      customer.plan_name,
      raw.plano,
      raw.plan,
      raw.package,
      raw.packageName,
      raw.planoAtual,
    ]
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .join(' '),
  );
  const match = text.match(/(\d{1,2})\s*(?:m[eê]s|meses|month)/i) || text.match(/\b(1|2|3|6|12)\b/);
  const parsed = match ? Number(match[1]) : null;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(24, Math.max(1, Math.round(parsed))) : null;
};

const buildRenovadosErradoRoutineCorrection = (customer = {}, context = null) => {
  if (!customerMatchesRenovadosErradoContext(customer, context)) return null;
  const originalDueDateKey = getCustomerDueDateKey(customer);
  const planMonths = parseRenovadosErradoRoutinePlanMonths(customer);
  const effectiveDueDateKey =
    originalDueDateKey && planMonths ? addMonthsToDateKey(originalDueDateKey, -planMonths) : null;
  if (!effectiveDueDateKey) {
    return {
      applies: true,
      labelId: context?.label?.id || null,
      labelName: context?.label?.name || ROUTINE_RENOVADOS_ERRADO_LABEL_NAME,
      planMonths: planMonths || null,
      originalDueDateKey: originalDueDateKey || null,
      effectiveDueDateKey: null,
      reason: originalDueDateKey ? 'missing_plan_months' : 'missing_due_date',
    };
  }
  return {
    applies: true,
    labelId: context?.label?.id || null,
    labelName: context?.label?.name || ROUTINE_RENOVADOS_ERRADO_LABEL_NAME,
    planMonths,
    originalDueDateKey,
    effectiveDueDateKey,
    reason: 'adjusted_by_plan_months',
  };
};

const applyRenovadosErradoRoutineCorrection = (customer = {}, context = null) => {
  const correction = buildRenovadosErradoRoutineCorrection(customer, context);
  return correction?.effectiveDueDateKey
    ? { ...customer, routineRenovadosErradoValidation: correction }
    : customer;
};

const getRoutineDueDateKey = (customer = {}, context = null) => {
  const correction = buildRenovadosErradoRoutineCorrection(customer, context);
  if (correction) return correction.effectiveDueDateKey || null;
  return getCustomerDueDateKey(customer);
};

const getRoutineBaseDateKey = (routine = {}, customer = {}, context = null) =>
  routine.rule === 'after_installation' ? getCustomerCreatedDateKey(customer) : getRoutineDueDateKey(customer, context);

const getRoutineReferenceTargetDateKey = (routine = {}, referenceDateKey = getSaoPauloDateParts().dateKey) => {
  const ruleDays = Math.max(0, Number.parseInt(String(routine.ruleDays ?? 0), 10) || 0);
  if (routine.rule === 'before_due') return addDaysToDateKey(referenceDateKey, ruleDays);
  if (routine.rule === 'after_due' || routine.rule === 'after_installation') return addDaysToDateKey(referenceDateKey, -ruleDays);
  return referenceDateKey;
};

const buildRoutineDispatchForecast = (store, routine, options = {}) => {
  const referenceDate = String(options.referenceDate || getSaoPauloDateParts().dateKey);
  const limit = Math.max(1, Math.min(1000, Number.parseInt(String(options.limit || 20), 10) || 20));
  const audience = normalizeRoutineAudience(routine?.audience);
  const allCustomers = Array.isArray(store?.customers) ? store.customers : [];
  const renovadosErradoContext = buildRenovadosErradoRoutineContext(store);
  const rawCandidates =
    audience.type === 'manual'
      ? allCustomers.filter((customer) => audience.customerIds.includes(String(customer?.id || '')))
      : allCustomers.filter((customer) => customerMatchesRoutineFilters(customer, audience.filters));
  const seenPhones = new Set();
  const ignored = {
    invalidPhone: 0,
    duplicates: 0,
    missingDate: 0,
    outsideDate: 0,
    testPlan: 0,
    renovadosErradoAdjusted: 0,
    renovadosErradoMissingData: 0,
  };
  const affected = [];
  const skippedByException = normalizeRoutineExceptions(routine?.exceptions).includes(referenceDate);

  if (skippedByException) {
    return {
      type: 'disparo',
      referenceDate,
      targetDate: getRoutineReferenceTargetDateKey(routine, referenceDate),
      totalCandidates: rawCandidates.length,
      affectedCount: 0,
      readyCount: 0,
      failedCount: 0,
      ignored,
      skippedByException: true,
      hasMore: false,
      items: [],
    };
  }

  rawCandidates.forEach((customer) => {
    if (isRoutineTestCustomer(customer)) {
      ignored.testPlan += 1;
      return;
    }
    const phone = getRoutineCustomerPhone(customer);
    if (!phone) {
      ignored.invalidPhone += 1;
      return;
    }
    if (seenPhones.has(phone)) {
      ignored.duplicates += 1;
      return;
    }
    seenPhones.add(phone);
    const correction =
      routine.rule === 'after_installation'
        ? null
        : buildRenovadosErradoRoutineCorrection(customer, renovadosErradoContext);
    if (correction && !correction.effectiveDueDateKey) {
      ignored.renovadosErradoMissingData += 1;
      ignored.missingDate += 1;
      return;
    }
    const correctedCustomer = correction?.effectiveDueDateKey
      ? { ...customer, routineRenovadosErradoValidation: correction }
      : customer;
    const baseDate = getRoutineBaseDateKey(routine, correctedCustomer, renovadosErradoContext);
    const executionDate = getRoutineCustomerTargetDateKey(routine, correctedCustomer, renovadosErradoContext);
    if (!baseDate || !executionDate) {
      ignored.missingDate += 1;
      return;
    }
    if (executionDate !== referenceDate) {
      ignored.outsideDate += 1;
      return;
    }
    if (correction?.effectiveDueDateKey) ignored.renovadosErradoAdjusted += 1;
    affected.push({
      customerId: customer?.id || null,
      name: getRoutineCustomerDisplayName(customer),
      phone,
      baseDate,
      executionDate,
      originalDueDate: correction?.originalDueDateKey || null,
      effectiveDueDate: correction?.effectiveDueDateKey || null,
      renovadosErradoValidation: correction || null,
      status: 'ready',
    });
  });

  return {
    type: 'disparo',
    referenceDate,
    targetDate: getRoutineReferenceTargetDateKey(routine, referenceDate),
    totalCandidates: rawCandidates.length,
    affectedCount: affected.length,
    readyCount: affected.length,
    failedCount: ignored.invalidPhone + ignored.missingDate,
    ignored,
    skippedByException: false,
    hasMore: affected.length > limit,
    items: affected.slice(0, limit),
  };
};

const buildRoutineLabelForecast = (store, routine, options = {}) => {
  const referenceDate = String(options.referenceDate || getSaoPauloDateParts().dateKey);
  const limit = Math.max(1, Math.min(1000, Number.parseInt(String(options.limit || 20), 10) || 20));
  const actions = normalizeRoutineLabelActions(routine?.labelActions);
  const labelsState = normalizeLabelsState(store?.labels);
  const assignments = labelsState.assignments || {};
  const targetConversationIds = new Set();
  const skippedByException = normalizeRoutineExceptions(routine?.exceptions).includes(referenceDate);

  if (skippedByException) {
    return {
      type: 'etiqueta',
      referenceDate,
      totalCandidates: 0,
      affectedCount: 0,
      readyCount: 0,
      failedCount: 0,
      ignored: { outsideDate: 0 },
      skippedByException: true,
      hasMore: false,
      items: [],
    };
  }

  Object.entries(assignments).forEach(([conversationId, labelIds]) => {
    const currentIds = Array.isArray(labelIds) ? labelIds : [];
    if (actions.remove.length === 0 || actions.remove.some((labelId) => currentIds.includes(labelId))) {
      targetConversationIds.add(conversationId);
    }
  });

  if (targetConversationIds.size === 0 && actions.add.length > 0) {
    (Array.isArray(store?.conversations) ? store.conversations : []).forEach((conversation) => {
      if (conversation?.id) targetConversationIds.add(String(conversation.id));
    });
  }

  const conversationsById = new Map((Array.isArray(store?.conversations) ? store.conversations : []).map((conversation) => [String(conversation.id), conversation]));
  const items = Array.from(targetConversationIds).map((conversationId) => {
    const conversation = conversationsById.get(conversationId) || {};
    return {
      customerId: conversationId,
      name: String(conversation.customer_name || conversation.name || conversation.push_name || conversationId),
      phone: normalizePhone(conversation.customer_phone || conversation.phone || conversation.whatsapp || conversationId),
      status: 'ready',
    };
  });

  return {
    type: 'etiqueta',
    referenceDate,
    totalCandidates: items.length,
    affectedCount: items.length,
    readyCount: items.length,
    failedCount: 0,
    ignored: { outsideDate: 0 },
    skippedByException: false,
    hasMore: items.length > limit,
    items: items.slice(0, limit),
  };
};

const normalizeComparablePhone = (value) => normalizePhone(value);

const buildFollowUpPhoneLookupKeys = (value) => {
  const digits = normalizeComparablePhone(value);
  if (!digits) return [];
  const keys = new Set([digits]);
  if (digits.startsWith('55') && digits.length > 11) keys.add(digits.slice(2));
  if (digits.length >= 11) keys.add(digits.slice(-11));
  if (digits.length >= 10) keys.add(digits.slice(-10));
  return Array.from(keys).filter(Boolean);
};

const buildFollowUpCustomerLookup = (customers = []) => {
  const lookup = new Map();
  const ambiguous = new Set();
  for (const customer of Array.isArray(customers) ? customers : []) {
    const phone = customer?.phoneDigits || customer?.phone_digits || customer?.whatsapp || customer?.raw?.whatsapp || customer?.raw?.telefone || '';
    for (const key of buildFollowUpPhoneLookupKeys(phone)) {
      if (ambiguous.has(key)) continue;
      if (lookup.has(key) && lookup.get(key) !== customer) {
        lookup.delete(key);
        ambiguous.add(key);
        continue;
      }
      lookup.set(key, customer);
    }
  }
  return lookup;
};

const findFollowUpCustomerByPhone = (lookup, phone) => {
  for (const key of buildFollowUpPhoneLookupKeys(phone)) {
    if (lookup.has(key)) return lookup.get(key);
  }
  return null;
};

const isFollowUpTrialCustomer = (conversation = {}, customer = null) => {
  const values = customer
    ? [
        customer.is_trial,
        customer.isTrial,
        customer.isTest,
        customer.trial,
        customer.teste,
        customer.raw?.is_trial,
        customer.raw?.isTrial,
        customer.raw?.isTest,
        customer.raw?.trial,
        customer.raw?.teste,
      ]
    : [
        conversation?.customer?.is_trial,
        conversation?.customer?.isTrial,
        conversation?.customer?.isTest,
        conversation?.customer?.trial,
        conversation?.customer?.teste,
        conversation?.sourceConversation?.customer?.is_trial,
        conversation?.sourceConversation?.customer?.isTrial,
        conversation?.sourceConversation?.customer?.isTest,
        conversation?.sourceConversation?.customer?.trial,
        conversation?.sourceConversation?.customer?.teste,
      ];
  return values.some((value) => toBooleanFlag(value));
};

const getConversationLabelTokens = (conversation = {}, labelsState = normalizeLabelsState({})) => {
  const tokens = [];
  const collect = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value === 'object') {
      collect(value.id);
      collect(value.name);
      collect(value.title);
      return;
    }
    const text = normalizeRoutineText(value);
    if (text) tokens.push(text);
  };

  collect(conversation.labels);
  collect(conversation.visible_labels);
  collect(conversation.custom_labels);
  collect(conversation.label_ids);
  collect(conversation.label_names);
  collect(conversation.tags);

  const conversationId = String(conversation?.id || '').trim();
  const customLabelsById = new Map((labelsState.customLabels || []).map((label) => [String(label.id), label]));
  const assignedIds = [
    ...(Array.isArray(labelsState.assignments?.[conversationId]) ? labelsState.assignments[conversationId] : []),
    labelsState.stageAssignments?.[conversationId],
  ].filter(Boolean);
  assignedIds.forEach((labelId) => {
    collect(labelId);
    collect(customLabelsById.get(String(labelId))?.name);
  });

  return tokens;
};

const conversationHasTargetLabel = (
  conversation = {},
  labelsState = normalizeLabelsState({}),
  followUpConfig = normalizeFollowUpConfig({}),
) => {
  const tokens = getConversationLabelTokens(conversation, labelsState);
  const targetTokens = [
    followUpConfig.targetLabelId,
    followUpConfig.targetLabelName,
  ]
    .map((token) => normalizeRoutineText(token))
    .filter(Boolean);
  return targetTokens.some((token) => tokens.includes(token));
};

const getConversationLastInteractionMs = (conversation = {}) => {
  const values = [
    conversation.last_message_time,
    conversation.lastMessageTime,
    conversation.last_message_at,
    conversation.updated_date,
    conversation.updatedAt,
    conversation.last_received_at,
    conversation.lastClientMessageTime,
    conversation.last_client_message_time,
    conversation.last_sent_at,
    conversation.createdAt,
  ];
  return values.reduce((latest, value) => {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
};

const getConversationLastClientMessageMs = (conversation = {}) => {
  const values = [
    conversation.last_received_at,
    conversation.lastClientMessageTime,
    conversation.last_client_message_time,
  ];
  return values.reduce((latest, value) => {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
};

const timeToMinutes = (value) => {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return (Number(match[1]) || 0) * 60 + (Number(match[2]) || 0);
};

const getSaoPauloDateTimeMs = (dateKey, time) => {
  const parsed = Date.parse(`${dateKey}T${String(time || '00:00').slice(0, 5)}:00-03:00`);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getActiveFollowUpPeriod = (routine = {}, dateParts = getSaoPauloDateParts()) => {
  const config = normalizeFollowUpConfig(routine.followUp);
  const currentMinutes = timeToMinutes(dateParts.time);
  if (!Number.isFinite(currentMinutes)) return null;

  for (const step of config.steps) {
    const configuredTime = normalizeTimeValue(step.time, '09:00');
    const scheduledMinutes = timeToMinutes(configuredTime);
    if (!step.enabled || !Number.isFinite(scheduledMinutes)) continue;
    if (currentMinutes >= scheduledMinutes && currentMinutes <= scheduledMinutes + config.toleranceMinutes) {
      return {
        key: step.id,
        label: step.label,
        time: configuredTime,
        dateKey: dateParts.dateKey,
        scheduledAt: new Date(getSaoPauloDateTimeMs(dateParts.dateKey, configuredTime)).toISOString(),
        scheduledAtMs: getSaoPauloDateTimeMs(dateParts.dateKey, configuredTime),
        isUpcoming: false,
      };
    }
  }
  return null;
};

const getNextFollowUpPeriod = (routine = {}, dateParts = getSaoPauloDateParts()) => {
  const config = normalizeFollowUpConfig(routine.followUp);
  const currentMinutes = timeToMinutes(dateParts.time);
  if (!Number.isFinite(currentMinutes)) return null;

  const periods = config.steps
    .map((step) => {
      const configuredTime = normalizeTimeValue(step.time, '09:00');
      const scheduledMinutes = timeToMinutes(configuredTime);
      return step.enabled && Number.isFinite(scheduledMinutes)
        ? { key: step.id, label: step.label, time: configuredTime, scheduledMinutes }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.scheduledMinutes - right.scheduledMinutes);

  if (!periods.length) return null;
  const nextToday = periods.find((period) => period.scheduledMinutes > currentMinutes + config.toleranceMinutes);
  const selected = nextToday || periods[0];
  const dateKey = nextToday ? dateParts.dateKey : addDaysToDateKey(dateParts.dateKey, 1);
  const scheduledAtMs = getSaoPauloDateTimeMs(dateKey, selected.time);

  return {
    key: selected.key,
    label: selected.label,
    time: selected.time,
    dateKey,
    scheduledAt: scheduledAtMs ? new Date(scheduledAtMs).toISOString() : null,
    scheduledAtMs,
    isUpcoming: true,
  };
};

const getNextEnabledFollowUpPeriodText = (routine = {}) => {
  const config = normalizeFollowUpConfig(routine.followUp);
  return config.steps
    .filter((step) => step.enabled)
    .map((step) => `${step.label} ${step.time}`)
    .join(' | ') || 'Nenhum periodo ativo';
};

const resolveFollowUpConversationSource = async (store) => {
  const remote = await requestWhatsappApiGetJson(`/api/whatsapp/conversations?summary=1&limit=${WHATSAPP_INTERNAL_CONVERSATION_SUMMARY_LIMIT}`)
    .then((data) => (Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []))
    .catch(() => []);
  const local = Array.isArray(store?.conversations) ? store.conversations : [];
  const byId = new Map();
  [...local, ...remote].forEach((conversation) => {
    const normalized = normalizeWhatsappConversationForChatbot(conversation);
    if (normalized.id) byId.set(String(normalized.id), normalized);
  });
  return Array.from(byId.values());
};

const getFollowUpConversationRouteKey = (conversation = {}) =>
  String(conversation.meta_route_key || conversation.metaRouteKey || conversation.customer?.meta_route_key || '').trim().toLowerCase();

const isFollowUpVendasConversation = (conversation = {}) => {
  const routeKey = getFollowUpConversationRouteKey(conversation);
  return routeKey === 'vendas' || routeKey === 'vendas2';
};

const chooseFollowUpConversationForPhone = (items = []) => {
  const conversations = Array.isArray(items) ? items.filter(Boolean) : [];
  if (conversations.length <= 1) return conversations[0] || null;
  return conversations.find((conversation) => !isFollowUpVendasConversation(conversation)) || conversations[0] || null;
};

const resolveFollowUpPeriodActionChain = (store = {}, periodConfig = {}) => {
  const reply =
    String(periodConfig.quickReplyId || '').trim()
      ? (Array.isArray(store.quickReplies) ? store.quickReplies : []).find((item) => String(item.id || '') === String(periodConfig.quickReplyId || '')) || null
      : null;
  const snapshot = periodConfig.quickReplySnapshot && typeof periodConfig.quickReplySnapshot === 'object' ? periodConfig.quickReplySnapshot : null;
  const baseActions = reply ? getQuickReplyScheduledActions(reply) : snapshot ? getQuickReplyScheduledActions(snapshot) : [];
  const additionalActions = Array.isArray(periodConfig.additionalActions) ? periodConfig.additionalActions : [];
  const legacyMessage = String(periodConfig.message || '').trim();
  const actions = [
    ...baseActions,
    ...additionalActions,
    ...(baseActions.length || additionalActions.length || !legacyMessage
      ? []
      : [{ id: 'legacy-follow-up-message', type: 'text', content: legacyMessage, typingDelaySeconds: 0, nextActionDelaySeconds: 0 }]),
  ];

  return {
    reply,
    baseTitle: reply?.title || periodConfig.quickReplyTitle || snapshot?.title || '',
    baseActions,
    additionalActions,
    actions,
    actionTypes: actions.map((action) => String(action.type || 'text').trim().toLowerCase()),
  };
};

const buildFollowUpForecast = async (store, routine, options = {}) => {
  const dateParts = options.dateParts || getSaoPauloDateParts();
  const config = normalizeFollowUpConfig(routine.followUp);
  const activePeriod = getActiveFollowUpPeriod(routine, dateParts);
  const period = activePeriod || (options.allowUpcomingPeriod ? getNextFollowUpPeriod(routine, dateParts) : null);
  const conversations = await resolveFollowUpConversationSource(store);
  const labelsState = normalizeLabelsState(store?.labels);
  const customerLookup = buildFollowUpCustomerLookup(store?.customers);
  const state = normalizeFollowUpState(routine.followUpState);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const referenceMs = period?.isUpcoming && Number.isFinite(Number(period.scheduledAtMs)) ? Number(period.scheduledAtMs) : nowMs;
  const minMs = config.minHoursWithoutInteraction * 60 * 60 * 1000;
  const limit = Math.max(1, Math.min(1000, Number.parseInt(String(options.limit || 1000), 10) || 1000));
  const selectedIds = new Set(normalizeRoutineArray(options.customerIds));
  const ignored = {
    noLead: 0,
    noPeriod: period ? 0 : 0,
    invalidPhone: 0,
    belowMinimumTime: 0,
    aboveMaximumTime: 0,
    outsideMetaWindow: 0,
    maxSendsReached: 0,
    respondedAfterFollowUp: 0,
    pendingSchedule: 0,
    missingMessage: 0,
    inactiveModelPeriod: 0,
  };
  const leadCandidates = [];
  const eligible = [];
  const conversationsByPhone = new Map();

  for (const conversation of conversations) {
    const phone = resolveConversationPhone(conversation);
    if (!phone) {
      ignored.invalidPhone += 1;
      continue;
    }
    const list = conversationsByPhone.get(phone) || [];
    list.push(conversation);
    conversationsByPhone.set(phone, list);
  }

  for (const [phone, groupedConversations] of conversationsByPhone.entries()) {
    const hasDefaultLine = groupedConversations.some((conversation) => !isFollowUpVendasConversation(conversation));
    const hasVendasLine = groupedConversations.some((conversation) => isFollowUpVendasConversation(conversation));
    const labelConversation = groupedConversations.find((conversation) =>
      conversationHasTargetLabel(
        conversation,
        labelsState,
        config,
      ),
    );
    const conversation = chooseFollowUpConversationForPhone(groupedConversations);
    if (!conversation) continue;

    const matchedCustomer = findFollowUpCustomerByPhone(customerLookup, phone);
    if (!labelConversation && !conversationHasTargetLabel(conversation, labelsState, config)) {
      ignored.noLead += 1;
      continue;
    }

    leadCandidates.push(conversation);
    const customerKey = phone;
    const currentState = state[customerKey] || {};
    const count = Math.max(0, Number.parseInt(String(currentState.count || 0), 10) || 0);
    const lastFollowUpMs = Date.parse(String(currentState.lastFollowUpAt || ''));
    const lastClientMs = Math.max(...groupedConversations.map((item) => getConversationLastClientMessageMs(item)));
    const lastInteractionMs = Math.max(...groupedConversations.map((item) => getConversationLastInteractionMs(item)));

    if (!Number.isFinite(lastInteractionMs) || lastInteractionMs <= 0) {
      ignored.missingMessage += 1;
      continue;
    }
    if (Number.isFinite(lastFollowUpMs) && Number.isFinite(lastClientMs) && lastClientMs > lastFollowUpMs + 2000) {
      ignored.respondedAfterFollowUp += 1;
      continue;
    }
    if (count >= config.steps.length || count >= config.maxSendsPerCustomer) {
      ignored.maxSendsReached += 1;
      continue;
    }

    const idleMs = referenceMs - lastInteractionMs;
    if (idleMs <= minMs) {
      ignored.belowMinimumTime += 1;
      continue;
    }
    if (
      hasPendingQuickReplyScheduleForTarget(store, {
        conversationId: conversation.id,
        customerId: customerKey,
        phone,
      })
    ) {
      ignored.pendingSchedule += 1;
      continue;
    }
    if (!period) {
      ignored.noPeriod += 1;
      continue;
    }

    const stepConfig = config.steps[count] || null;
    if (!stepConfig?.enabled) {
      ignored.inactiveModelPeriod += 1;
      continue;
    }
    const actionChain = resolveFollowUpPeriodActionChain(store, stepConfig);
    if (!actionChain.actions.length) {
      ignored.missingMessage += 1;
      continue;
    }

    eligible.push({
      customerKey,
      customerId: customerKey,
      conversationId: conversation.id,
      name: getRoutineCustomerDisplayName({
        display_name: conversation.contact_name || conversation.customer?.name || conversation.customer?.push_name || '',
        username: conversation.contact_name || conversation.customer?.name || '',
      }),
      phone,
      modelKey: stepConfig.id,
      modelLabel: stepConfig.label || `Mensagem ${count + 1}`,
      periodKey: period.key,
      periodLabel: period.label,
      periodTime: period.time,
      message: String(stepConfig.message || '').trim(),
      actionChain: actionChain.actions,
      quickReplyId: String(stepConfig.quickReplyId || '').trim(),
      quickReplyTitle: actionChain.baseTitle,
      baseActionCount: actionChain.baseActions.length,
      additionalActionCount: actionChain.additionalActions.length,
      actionTypes: actionChain.actionTypes,
      sentCount: count,
      routeSelector: getRouteSelectorFromConversation(conversation),
      conversation: {
        id: conversation.id,
        contact_name: conversation.contact_name || conversation.customer?.name || '',
        contact_phone: phone,
        department: conversation.department || conversation.sector || '',
        meta_route_key: conversation.meta_route_key || conversation.metaRouteKey || '',
      },
      routeKey: getFollowUpConversationRouteKey(conversation) || null,
      routeRule: hasDefaultLine && hasVendasLine ? 'default_preferred' : hasVendasLine ? 'vendas_only' : 'default_only',
      lastFollowUpAt: currentState.lastFollowUpAt || null,
      lastInteractionAt: new Date(lastInteractionMs).toISOString(),
      idleHours: Math.round((idleMs / (60 * 60 * 1000)) * 10) / 10,
      status: 'ready',
    });
  }

  return {
    type: 'follow_up',
    referenceDate: period?.dateKey || dateParts.dateKey,
    referenceTime: period?.time || dateParts.time,
    currentDate: dateParts.dateKey,
    currentTime: dateParts.time,
    period,
    isAdvanceWindow: Boolean(period?.isUpcoming),
    totalCandidates: leadCandidates.length,
    affectedCount: eligible.length,
    readyCount: eligible.length,
    failedCount: 0,
    ignored,
    skippedByException: false,
    hasMore: eligible.length > limit,
    items: (selectedIds.size ? eligible.filter((item) => selectedIds.has(item.customerKey) || selectedIds.has(item.conversationId) || selectedIds.has(item.phone)) : eligible).slice(0, limit),
  };
};

const buildRoutineForecast = (store, routine, options = {}) =>
  normalizeRoutineType(routine?.type) === 'etiqueta'
    ? buildRoutineLabelForecast(store, routine, options)
    : normalizeRoutineType(routine?.type) === 'follow_up'
      ? buildFollowUpForecast(store, routine, options)
      : buildRoutineDispatchForecast(store, routine, options);

const getSaoPauloDateParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  })
    .formatToParts(date)
    .reduce((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: String(parts.weekday || '').toLowerCase(),
  };
};

const isRoutineDueNow = (routine, dateParts = getSaoPauloDateParts()) => {
  if (normalizeRoutineStatus(routine?.status) !== 'active') return false;
  if (normalizeRoutineType(routine?.type) === 'follow_up') {
    const period = getActiveFollowUpPeriod(routine, dateParts);
    if (!period) return false;
    return String(routine?.lastRunKey || '') !== `${dateParts.dateKey}:follow_up:${period.key}:${period.time}`;
  }
  const schedule = normalizeRoutineWeeklySchedule(routine?.weeklySchedule, routine?.weekdays, routine?.scheduledTime);
  const today = schedule[dateParts.weekday] || {};
  if (!today.enabled) return false;
  if (normalizeRoutineExceptions(routine?.exceptions).includes(dateParts.dateKey)) return false;
  const scheduledTime = String(today.time || routine?.scheduledTime || '').slice(0, 5);
  if (!scheduledTime || scheduledTime !== dateParts.time) return false;
  return String(routine?.lastRunKey || '') !== `${dateParts.dateKey}:${scheduledTime}`;
};

const getRoutineRunKeyForNow = (routine, dateParts = getSaoPauloDateParts()) => {
  if (normalizeRoutineType(routine?.type) === 'follow_up') {
    const period = getActiveFollowUpPeriod(routine, dateParts);
    return period ? `${dateParts.dateKey}:follow_up:${period.key}:${period.time}` : `${dateParts.dateKey}:follow_up`;
  }
  const todayTime = normalizeRoutineWeeklySchedule(routine.weeklySchedule, routine.weekdays, routine.scheduledTime)?.[dateParts.weekday]?.time;
  return `${dateParts.dateKey}:${String(todayTime || routine.scheduledTime || '').slice(0, 5)}`;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

const executeLabelRoutineNow = async (routine, runId, startedAt, options = {}) => {
  const timestamp = nowIso();
  let summary = { total: 0, changed: 0, failed: 0, skipped: 0, startedAt, finishedAt: timestamp, durationMs: 0 };

  await updateStore((current) => {
    const routines = normalizeRoutinesState(current.routines);
    const labelsState = normalizeLabelsState(current.labels);
    const actions = normalizeRoutineLabelActions(routine.labelActions);
    const allowedLabels = new Set(labelsState.customLabels.map((label) => label.id));
    const add = actions.add.filter((labelId) => allowedLabels.has(labelId));
    const remove = actions.remove.filter((labelId) => allowedLabels.has(labelId));
    const assignments = { ...(labelsState.assignments || {}) };
    const manualIds = normalizeRoutineArray(options.customerIds);
    const targetConversationIds = new Set(manualIds);

    if (!manualIds.length) {
      Object.entries(assignments).forEach(([conversationId, labelIds]) => {
        if (remove.length === 0 || remove.some((labelId) => (Array.isArray(labelIds) ? labelIds : []).includes(labelId))) {
          targetConversationIds.add(conversationId);
        }
      });

      if (targetConversationIds.size === 0 && add.length > 0) {
        (Array.isArray(current.conversations) ? current.conversations : []).forEach((conversation) => {
          if (conversation?.id) targetConversationIds.add(String(conversation.id));
        });
      }
    }

    let changed = 0;
    targetConversationIds.forEach((conversationId) => {
      const currentIds = new Set(Array.isArray(assignments[conversationId]) ? assignments[conversationId] : []);
      const before = Array.from(currentIds).sort().join('|');
      remove.forEach((labelId) => currentIds.delete(labelId));
      add.forEach((labelId) => currentIds.add(labelId));
      const nextIds = Array.from(currentIds).filter((labelId) => allowedLabels.has(labelId));
      const after = nextIds.slice().sort().join('|');
      if (before !== after) changed += 1;
      if (nextIds.length > 0) assignments[conversationId] = nextIds;
      else delete assignments[conversationId];
    });

    const finishedAt = nowIso();
    summary = {
      total: targetConversationIds.size,
      changed,
      failed: 0,
      skipped: Math.max(0, targetConversationIds.size - changed),
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    };

    current.labels = {
      ...labelsState,
      assignments,
      updatedAt: finishedAt,
    };
    current.routines = {
      ...routines,
      items: routines.items.map((item) =>
        item.id === routine.id
          ? {
              ...item,
              lastRunAt: finishedAt,
              lastRunKey: options.runKey || item.lastRunKey,
              lastRunSummary: summary,
              updatedAt: finishedAt,
            }
          : item,
      ),
      logs: appendRoutineLog(routines.logs, {
        id: `${runId}-summary`,
        runId,
        routineId: routine.id,
        routineName: routine.name,
        status: 'success',
        createdAt: finishedAt,
        summary,
        message: `Rotina de etiqueta finalizada: ${changed} contato(s) alterado(s).`,
      }),
    };

    return current;
  });

  await persistRoutineLog({
    id: `${runId}-summary-live`,
    runId,
    routineId: routine.id,
    routineName: routine.name,
    level: 'success',
    status: 'success',
    summary,
    message: `Rotina de etiqueta finalizada. Total: ${summary.total} | Alterados: ${summary.changed} | Ignorados: ${summary.skipped}.`,
  });

  return { ok: true, summary };
};

const markRoutineExecutionSummary = async (routineId, summary, runKey = null, finishedAt = nowIso()) => {
  await updateStore((current) => {
    const routines = normalizeRoutinesState(current.routines);
    current.routines = {
      ...routines,
      items: routines.items.map((item) =>
        item.id === routineId
          ? {
              ...item,
              lastRunAt: finishedAt,
              lastRunKey: runKey || item.lastRunKey,
              lastRunSummary: summary,
              updatedAt: finishedAt,
            }
          : item,
      ),
    };
    return current;
  });
};

const executeFollowUpRoutineNow = async (routine, runId, startedAt, options = {}) => {
  const store = await readStore();
  const dateParts = getSaoPauloDateParts();
  const forecast = await buildFollowUpForecast(store, routine, {
    dateParts,
    customerIds: options.customerIds,
    allowUpcomingPeriod: Boolean(options.advanceWindow),
  });

  await persistRoutineLog({
    routineId: routine.id,
    routineName: routine.name,
    level: 'info',
    status: 'info',
    runId,
    message: `Clientes com etiqueta LEAD encontrados: ${forecast.totalCandidates}.`,
    details: { ignored: forecast.ignored, referenceTime: forecast.referenceTime, period: forecast.period },
  });

  if (!forecast.period) {
    const finishedAt = nowIso();
    const summary = {
      total: forecast.totalCandidates,
      sent: 0,
      failed: 0,
      skipped: forecast.totalCandidates,
      ignored: forecast.ignored,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      status: 'waiting_window',
    };
    await markRoutineExecutionSummary(routine.id, summary, options.runKey || null, finishedAt);
    await persistRoutineLog({
      id: `${runId}-waiting-window`,
      runId,
      routineId: routine.id,
      routineName: routine.name,
      level: 'info',
      status: 'info',
      summary,
      message: 'Nenhum disparo realizado: fora da janela configurada. Aguardando proxima janela.',
    });
    return { ok: true, summary, forecast };
  }

  if (forecast.isAdvanceWindow) {
    await persistRoutineLog({
      routineId: routine.id,
      routineName: routine.name,
      level: 'info',
      status: 'info',
      runId,
      message: `Disparo manual adiantado para a janela ${forecast.period.label} ${forecast.period.time}.`,
      details: { period: forecast.period, currentTime: forecast.currentTime, referenceDate: forecast.referenceDate },
    });
  }

  await persistRoutineLog({
    routineId: routine.id,
    routineName: routine.name,
    level: 'info',
    status: 'info',
    runId,
    message: `Clientes elegiveis com mais de ${routine.followUp.minHoursWithoutInteraction || 10}h sem interacao: ${forecast.readyCount}.`,
    details: { period: forecast.period, ignored: forecast.ignored },
  });

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const stateUpdates = {};
  const detailLogs = [];

  for (const item of forecast.items) {
    if (
      hasPendingQuickReplyScheduleForTarget(store, {
        conversationId: item.conversationId,
        customerId: item.customerKey,
        phone: item.phone,
      })
    ) {
      skipped += 1;
      await persistRoutineLog({
        routineId: routine.id,
        routineName: routine.name,
        level: 'info',
        status: 'skipped',
        runId,
        message: 'Envio ignorado: cliente possui agendamento pendente.',
        details: { phone: item.phone, customerId: item.customerKey, source: 'quick_reply_schedule' },
      });
      continue;
    }

    await persistRoutineLog({
      routineId: routine.id,
      routineName: routine.name,
      level: 'running',
      status: 'running',
      runId,
      message: `Cliente ${item.name || item.phone} elegivel para follow up.`,
      details: {
        phone: item.phone,
        model: item.modelLabel,
        period: item.periodLabel,
        idleHours: item.idleHours,
      },
    });

    try {
      const response = await executeQuickReplyActionChain({
        actions: item.actionChain,
        schedule: {
          customerId: item.customerKey,
          customerName: item.name,
          customerPhone: item.phone,
          conversationId: item.conversationId,
          createdByName: 'Bot',
        },
        conversation: item.conversation || { id: item.conversationId, contact_name: item.name, contact_phone: item.phone },
        phone: item.phone,
        origin: 'routine-follow-up',
        agentName: 'Bot',
        routeSelector: item.routeSelector || {},
      });
      if (!response?.totalSent) {
        throw new Error('Nenhuma ação válida foi enviada para este follow up.');
      }
      const sentAt = nowIso();
      sent += 1;
      const nextCount = Math.min((Number(item.sentCount) || 0) + 1, routine.followUp.maxSendsPerCustomer || routine.followUp.steps?.length || 1);
      const completed = nextCount >= (routine.followUp.steps?.length || nextCount);
      stateUpdates[item.customerKey] = {
        customerKey: item.customerKey,
        routineId: routine.id,
        count: nextCount,
        lastFollowUpAt: sentAt,
        lastModel: item.modelKey,
        lastPeriod: item.periodKey,
        status: completed ? 'closed_by_desistance' : 'sent',
        completedAt: completed ? sentAt : null,
        updatedAt: sentAt,
      };
      await persistRoutineLog({
        routineId: routine.id,
        routineName: routine.name,
        level: 'success',
        status: 'success',
        runId,
        message: `Follow Up enviado com sucesso para ${item.name || item.phone}.`,
        details: {
          customer: item.name || '',
          phone: item.phone,
          model: item.modelLabel,
          period: item.periodLabel,
          quickReplyId: item.quickReplyId || null,
          quickReplyTitle: item.quickReplyTitle || '',
          baseActionCount: item.baseActionCount || 0,
          additionalActionCount: item.additionalActionCount || 0,
          totalActionCount: (item.actionChain || []).length,
          actionTypes: item.actionTypes || [],
          sentTypes: response?.sentTypes || [],
        },
      });
      detailLogs.push({
        id: `${runId}-${item.customerKey}-success`,
        runId,
        routineId: routine.id,
        routineName: routine.name,
        customerId: item.conversationId || item.customerKey,
        phone: item.phone,
        status: 'success',
        createdAt: sentAt,
        message: `${item.modelLabel} enviado no período ${item.periodLabel}.`,
      });
    } catch (error) {
      failed += 1;
      const failedAt = nowIso();
      stateUpdates[item.customerKey] = {
        ...(normalizeFollowUpState(routine.followUpState)[item.customerKey] || { customerKey: item.customerKey, count: Number(item.sentCount) || 0 }),
        routineId: routine.id,
        status: 'failed',
        lastModel: item.modelKey,
        lastPeriod: item.periodKey,
        updatedAt: failedAt,
      };
      await persistRoutineLog({
        routineId: routine.id,
        routineName: routine.name,
        level: 'error',
        status: 'error',
        runId,
        message: `Falha ao enviar follow up para ${item.name || item.phone}: ${error?.message || 'Erro desconhecido'}`,
        details: {
          customer: item.name || '',
          phone: item.phone,
          model: item.modelLabel,
          period: item.periodLabel,
          quickReplyId: item.quickReplyId || null,
          quickReplyTitle: item.quickReplyTitle || '',
          actionIndex: error?.actionIndex ?? null,
          actionType: error?.actionType || null,
          baseActionCount: item.baseActionCount || 0,
          additionalActionCount: item.additionalActionCount || 0,
          totalActionCount: (item.actionChain || []).length,
          actionTypes: item.actionTypes || [],
          error: error?.message || 'Erro desconhecido',
          status: error?.status || null,
          apiResponse: error?.payload && typeof error.payload === 'object' ? error.payload : null,
        },
      });
      detailLogs.push({
        id: `${runId}-${item.customerKey}-error`,
        runId,
        routineId: routine.id,
        routineName: routine.name,
        customerId: item.conversationId || item.customerKey,
        phone: item.phone,
        status: 'error',
        createdAt: failedAt,
        message: error?.message || 'Falha ao enviar follow up.',
      });
    }
  }

  skipped = Math.max(0, forecast.totalCandidates - sent - failed);
  const finishedAt = nowIso();
  const summary = {
    total: forecast.totalCandidates,
    eligible: forecast.readyCount,
    sent,
    failed,
    skipped,
    ignored: forecast.ignored,
    period: forecast.period,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
  };

  await updateStore((current) => {
    const routines = normalizeRoutinesState(current.routines);
    current.routines = {
      ...routines,
      items: routines.items.map((item) => {
        if (item.id !== routine.id) return item;
        return {
          ...item,
          followUpState: {
            ...normalizeFollowUpState(item.followUpState),
            ...stateUpdates,
          },
          lastRunAt: finishedAt,
          lastRunKey: options.runKey || item.lastRunKey,
          lastRunSummary: summary,
          updatedAt: finishedAt,
        };
      }),
      logs: appendRoutineLog(
        detailLogs.reduce((logs, entry) => appendRoutineLog(logs, entry), routines.logs),
        {
          id: `${runId}-summary`,
          runId,
          routineId: routine.id,
          routineName: routine.name,
          status: failed > 0 ? 'warning' : 'success',
          createdAt: finishedAt,
          summary,
          message: `Rotina de Follow Up finalizada. Total enviados: ${sent}. Ignorados: ${skipped}. Falhas: ${failed}.`,
        },
      ),
    };
    return current;
  });

  await persistRoutineLog({
    id: `${runId}-summary-live`,
    runId,
    routineId: routine.id,
    routineName: routine.name,
    level: failed > 0 ? 'warning' : 'success',
    status: failed > 0 ? 'warning' : 'success',
    summary,
    message: `Rotina finalizada. Total enviados: ${sent}. Ignorados: ${skipped}. Falhas: ${failed}.`,
  });

  return { ok: true, summary, forecast };
};

const executeRoutineNow = async (routineId, options = {}) => {
  const id = String(routineId || '').trim();
  if (!id) {
    return { ok: false, skipped: true, reason: 'missing_routine_id' };
  }

  if (routineInFlight.has(id)) {
    return { ok: false, skipped: true, reason: 'routine_already_running' };
  }

  routineInFlight.add(id);
  const startedAt = nowIso();
  const runId = `routine-run-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const routineMeasure = startPerfMeasure();
  let routineName = '';
  let routineType = '';
  let routineTargetCount = 0;
  let routineOutcome = 'success';

  try {
    const store = await readStore();
    const storedRoutine = normalizeRoutinesState(store.routines).items.find((item) => item.id === id) || null;
    if (!storedRoutine) {
      routineOutcome = 'skipped';
      return { ok: false, skipped: true, reason: 'not_found' };
    }
    const routine = normalizeRoutine({
      ...storedRoutine,
      hsm:
        storedRoutine.hsm && (options.parameterOverrides || options.mediaOverride)
          ? {
              ...storedRoutine.hsm,
              parameterOverrides:
                options.parameterOverrides && typeof options.parameterOverrides === 'object'
                  ? options.parameterOverrides
                  : storedRoutine.hsm.parameterOverrides,
              mediaOverride:
                options.mediaOverride && typeof options.mediaOverride === 'object'
                  ? options.mediaOverride
                  : storedRoutine.hsm.mediaOverride,
            }
          : storedRoutine.hsm,
    });
    routineName = routine.name;
    routineType = routine.type;
    if (!options.manual && normalizeRoutineStatus(routine.status) !== 'active') {
      routineOutcome = 'skipped';
      return { ok: true, skipped: true, reason: 'paused' };
    }
    if (routine.type === 'etiqueta') {
      await persistRoutineLog({
        routineId: routine.id,
        routineName: routine.name,
        level: 'running',
        status: 'running',
        runId,
        message: options.manual ? 'Execução manual de etiqueta iniciada.' : 'Execução agendada de etiqueta iniciada.',
      });
      return await executeLabelRoutineNow(routine, runId, startedAt, options);
    }

    if (routine.type === 'follow_up') {
      await persistRoutineLog({
        routineId: routine.id,
        routineName: routine.name,
        level: 'running',
        status: 'running',
        runId,
        message: options.manual ? 'Rotina de Follow Up iniciada manualmente.' : 'Rotina de Follow Up iniciada.',
      });
      return await executeFollowUpRoutineNow(routine, runId, startedAt, options);
    }

    await persistRoutineLog({
      routineId: routine.id,
      routineName: routine.name,
      level: 'running',
      status: 'running',
      runId,
      message: options.manual ? 'Rotina iniciada manualmente.' : 'Execução agendada iniciada.',
    });

    const [templates, currentStore] = await Promise.all([fetchLocalHsmItemsForRoutines(), readStore()]);
    const template = findRoutineTemplate(templates, routine);
    if (!template) {
      routineOutcome = 'error';
      const summary = { total: 0, sent: 0, failed: 0, skipped: 0, error: 'template_not_found' };
      await persistRoutineLog({
        id: `${runId}-template`,
        runId,
        routineId: id,
        routineName: routine.name,
        level: 'error',
        status: 'error',
        message: 'Template/HSM não encontrado para a rotina.',
      });
      return { ok: false, summary };
    }

    const manualSelection = Array.isArray(options.customerIds)
      ? resolveManualRoutineCustomers(currentStore, options.customerIds)
      : null;
    const baseCustomers = manualSelection ? manualSelection.customers : resolveRoutineCustomers(currentStore, routine);
    const renovadosErradoContext = buildRenovadosErradoRoutineContext(currentStore);
    const customers = options.manual
      ? baseCustomers
      : filterRoutineCustomersForToday(baseCustomers, routine, getSaoPauloDateParts().dateKey, renovadosErradoContext);
    routineTargetCount = customers.length;
    const renovadosErradoAdjusted = customers.filter((customer) => customer?.routineRenovadosErradoValidation?.effectiveDueDateKey).length;
    await persistRoutineLog({
      routineId: id,
      routineName: routine.name,
      level: 'info',
      status: 'info',
      runId,
      message: `Clientes localizados: ${customers.length}.`,
      details: {
        totalCandidates: baseCustomers.length,
        ignored: manualSelection?.ignored || 0,
        duplicates: manualSelection?.duplicates || 0,
        renovadosErradoAdjusted,
      },
    });
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const detailLogs = [];

    for (const customer of customers) {
      const phone = normalizePhone(customer?.whatsapp || customer?.phone_digits || '');
      if (!phone) {
        skipped += 1;
        await persistRoutineLog({
          routineId: id,
          routineName: routine.name,
          level: 'warning',
          status: 'warning',
          runId,
          message: 'Cliente ignorado por telefone inválido.',
          details: { customerId: customer.id || null },
        });
        continue;
      }
      if (
        hasPendingQuickReplyScheduleForTarget(currentStore, {
          customerId: customer.id,
          phone,
        })
      ) {
        skipped += 1;
        await persistRoutineLog({
          routineId: id,
          routineName: routine.name,
          level: 'info',
          status: 'skipped',
          runId,
          message: 'Envio ignorado: cliente possui agendamento pendente.',
          details: { customerId: customer.id || null, phone, source: 'quick_reply_schedule' },
        });
        continue;
      }

      await persistRoutineLog({
        routineId: id,
        routineName: routine.name,
        level: 'running',
        status: 'running',
        runId,
        message: `Enviando para ${customer.display_name || customer.username || phone}.`,
        details: { customerId: customer.id || null },
      });
      let payload = null;
      let emptyBodyParameters = [];
      let emptyHeaderParameters = [];
      let emptyButtonParameters = [];
      try {
        let extraValues = {};
        if (routineNeedsCheckoutToken(routine, template)) {
          const checkoutData = await buildRoutineCheckoutData(customer);
          extraValues = {
            checkoutoken: checkoutData.token,
            checkouttoken: checkoutData.token,
            checkoutlink: checkoutData.checkoutLink,
          };
        }
        payload = buildRoutineTemplatePayload(template, routine, customer, { extraValues });
        emptyBodyParameters = payload.bodyParameters
          .map((value, index) => (String(value || '').trim() ? null : index + 1))
          .filter(Boolean);
        emptyHeaderParameters = payload.headerParameters
          .map((value, index) => (String(value || '').trim() ? null : index + 1))
          .filter(Boolean);
        emptyButtonParameters = payload.buttonParameterValues
          .map((value, index) => (String(value || '').trim() ? null : index + 1))
          .filter(Boolean);
        await requestWhatsappApiJson('/api/whatsapp/send-template', {
          to: phone,
          templateName: payload.templateName,
          language: payload.language,
          parameters: payload.bodyParameters,
          buttonParameters: payload.buttonParameterValues,
          headerParameters: payload.headerParameters,
          headerFormat: payload.headerFormat,
          headerType: payload.headerType,
          headerMediaUrl: payload.headerMediaUrl,
          previewText: payload.previewText,
          origin: 'routine',
          agentName: 'Bot',
        }, {
          timeoutMs: ROUTINE_WHATSAPP_TIMEOUT_MS,
        });
        sent += 1;
        await persistRoutineLog({
          routineId: id,
          routineName: routine.name,
          level: 'success',
          status: 'success',
          runId,
          message: 'Mensagem enviada.',
          details: {
            customerId: customer.id || null,
            phone,
            templateName: payload.templateName,
            language: payload.language,
            bodyParameterCount: payload.bodyParameters.length,
            headerParameterCount: payload.headerParameters.length,
            buttonParameterCount: payload.buttonParameterValues.length,
          },
        });
        detailLogs.push({
          id: `${runId}-${customer.id || phone}-success`,
          runId,
          routineId: id,
          routineName: routine.name,
          customerId: customer.id || null,
          phone,
          status: 'success',
          createdAt: nowIso(),
          message: 'HSM enviado.',
        });
      } catch (error) {
        failed += 1;
        await persistRoutineLog({
          routineId: id,
          routineName: routine.name,
          level: 'error',
          status: 'error',
          runId,
          message: 'Falha ao enviar mensagem.',
          details: {
            customerId: customer.id || null,
            customerName: getRoutineCustomerDisplayName(customer),
            phone,
            error: error?.message || 'Erro desconhecido.',
            status: error?.status || null,
            apiPath: error?.pathName || null,
            apiBaseUrl: error?.baseUrl || null,
            timeoutMs: error?.timeoutMs || null,
            isTimeout: Boolean(error?.isTimeout),
            apiResponse: error?.payload && typeof error.payload === 'object' ? error.payload : null,
            templateName: template ? getTemplateName(template) : routine?.hsm?.templateName || null,
            language: template ? getTemplateLanguage(template) : routine?.hsm?.language || null,
            checkoutTokenRequired: routineNeedsCheckoutToken(routine, template),
            bodyParameters: payload?.bodyParameters || [],
            headerParameters: payload?.headerParameters || [],
            buttonParameters: payload?.buttonParameterValues || [],
            emptyBodyParameters,
            emptyHeaderParameters,
            emptyButtonParameters,
          },
        });
        detailLogs.push({
          id: `${runId}-${customer.id || phone}-error`,
          runId,
          routineId: id,
          routineName: routine.name,
          customerId: customer.id || null,
          phone,
          status: 'error',
          createdAt: nowIso(),
          message: error?.message || 'Falha ao enviar HSM.',
        });
      }

      if (routine.sendIntervalMs > 0 && customer !== customers[customers.length - 1]) {
        await persistRoutineLog({
          routineId: id,
          routineName: routine.name,
          level: 'running',
          status: 'running',
          runId,
          message: `Aguardando intervalo de ${Math.max(1, Math.round(routine.sendIntervalMs / 1000))}s.`,
        });
        await delay(routine.sendIntervalMs);
      }
    }

    const finishedAt = nowIso();
    const summary = {
      total: customers.length,
      sent,
      failed,
      skipped,
      ignored: skipped + (manualSelection?.ignored || 0),
      duplicates: manualSelection?.duplicates || 0,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    };

    await updateStore((current) => {
      const routines = normalizeRoutinesState(current.routines);
      current.routines = {
        ...routines,
        items: routines.items.map((item) =>
          item.id === id
            ? {
                ...item,
                lastRunAt: finishedAt,
                lastRunKey: options.runKey || item.lastRunKey,
                lastRunSummary: summary,
                updatedAt: finishedAt,
              }
            : item,
        ),
        logs: appendRoutineLog(
          detailLogs.reduce((logs, entry) => appendRoutineLog(logs, entry), routines.logs),
          {
            id: `${runId}-summary`,
            runId,
            routineId: id,
            routineName: routine.name,
            status: failed > 0 ? 'warning' : 'success',
            createdAt: finishedAt,
            summary,
            message: `Execucao finalizada: ${sent} enviado(s), ${failed} falha(s), ${skipped} ignorado(s).`,
          },
        ),
      };
      return current;
    });

    await persistRoutineLog({
      id: `${runId}-summary-live`,
      runId,
      routineId: id,
      routineName: routine.name,
      level: failed > 0 ? 'warning' : 'success',
      status: failed > 0 ? 'warning' : 'success',
      summary,
      message: `Rotina finalizada. Total: ${customers.length} | Enviados: ${sent} | Falhas: ${failed} | Ignorados: ${skipped}.`,
    });

    return { ok: true, summary };
  } catch (error) {
    routineOutcome = 'error';
    throw error;
  } finally {
    await flushPendingRoutineLogs();
    const perf = finishPerfMeasure(routineMeasure);
    logPerf('routine-perf', {
      routineId: id,
      routineName,
      type: routineType,
      trigger: options.manual ? 'manual' : options.trigger || 'scheduled',
      outcome: routineOutcome,
      targets: routineTargetCount,
      durationMs: perf.durationMs,
      cpuUserMs: perf.cpuUserMs,
      cpuSystemMs: perf.cpuSystemMs,
      rssMb: perf.rssMb,
      heapUsedMb: perf.heapUsedMb,
    }, { level: routineOutcome === 'error' ? 'warn' : 'info' });
    routineInFlight.delete(id);
  }
};

const hasActiveRoutineExecution = async (routineId) => {
  const id = String(routineId || '').trim();
  if (!id) return false;
  if (routineInFlight.has(id) || routineQueued.has(id)) return true;
  return ROUTINE_DISPATCH_QUEUE_ENABLED && hasActiveRoutineDispatchJob(id);
};

const enqueueRoutineExecution = async (routineId, options = {}) => {
  const id = String(routineId || '').trim();
  if (!id) {
    return { ok: false, skipped: true, reason: 'missing_routine_id' };
  }
  if (await hasActiveRoutineExecution(id)) {
    return { ok: false, skipped: true, reason: 'routine_already_running' };
  }

  const store = await readStore();
  const routine = normalizeRoutinesState(store.routines).items.find((item) => item.id === id) || null;
  if (!routine) {
    return { ok: false, skipped: true, reason: 'not_found' };
  }

  const queuedAt = nowIso();
  await persistRoutineLog({
    routineId: id,
    routineName: routine.name,
    level: 'queued',
    status: 'queued',
    message: options.manual ? 'Envio manual enfileirado.' : 'Execucao de rotina enfileirada.',
    details: {
      trigger: options.trigger || null,
      customerCount: Array.isArray(options.customerIds) ? options.customerIds.length : null,
      queuedAt,
    },
  });

  if (ROUTINE_DISPATCH_QUEUE_ENABLED) {
    const queueResult = enqueueRoutineDispatchJob({
      routineId: id,
      routineName: routine.name,
      options,
      idempotencyKey: options.runKey ? `routine:${id}:${options.runKey}` : null,
    });
    const job = queueResult.job || null;
    return {
      ok: queueResult.ok,
      queued: ['queued', 'running'].includes(String(job?.status || 'queued')),
      existing: Boolean(queueResult.existing),
      routineId: id,
      routineName: routine.name,
      jobId: job?.id || null,
      status: job?.status || 'queued',
      queuedAt: job?.queuedAt || queuedAt,
    };
  }

  routineQueued.add(id);
  routineDispatchQueue = routineDispatchQueue
    .catch((error) => {
      console.error(`[local-api] routine queue recovered: ${error?.message || error}`);
    })
    .then(async () => {
      routineQueued.delete(id);
      await executeRoutineNow(id, options);
    })
    .catch((error) => {
      routineQueued.delete(id);
      console.error(`[local-api] routine queue error id=${id}: ${error?.message || error}`);
    });

  return { ok: true, queued: true, routineId: id, routineName: routine.name, queuedAt };
};

let routineDispatchQueueWorkerTimer = null;
let routineDispatchQueueWorkerBusy = false;

const processRoutineDispatchQueueOnce = async () => {
  if (!ROUTINE_DISPATCH_QUEUE_ENABLED || !ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED || routineDispatchQueueWorkerBusy) {
    return;
  }

  routineDispatchQueueWorkerBusy = true;
  try {
    const job = claimNextRoutineDispatchJob({ workerId: ROUTINE_DISPATCH_WORKER_ID });
    if (!job) return;

    const options = job.payload && typeof job.payload === 'object' ? job.payload : {};
    log(`[routine-dispatch-worker] processing job=${job.id} routine=${job.routineId} trigger=${options.trigger || job.trigger || ''}`);
    try {
      const result = await executeRoutineNow(job.routineId, {
        ...options,
        dispatchJobId: job.id,
        trigger: options.trigger || job.trigger || 'queue',
      });
      completeRoutineDispatchJob({ id: job.id, result });
      log(`[routine-dispatch-worker] completed job=${job.id} routine=${job.routineId}`);
    } catch (error) {
      failRoutineDispatchJob({ id: job.id, error });
      console.error(`[routine-dispatch-worker] failed job=${job.id} routine=${job.routineId}: ${error?.message || error}`);
    }
  } finally {
    routineDispatchQueueWorkerBusy = false;
  }
};

const initializeRoutineDispatchQueueWorker = () => {
  if (!ROUTINE_DISPATCH_QUEUE_ENABLED || !ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED || routineDispatchQueueWorkerTimer) return;
  routineDispatchQueueWorkerTimer = startRegisteredInterval(
    'routine-dispatch-worker',
    () => {
      void processRoutineDispatchQueueOnce();
    },
    ROUTINE_DISPATCH_QUEUE_INTERVAL_MS,
  );
  void processRoutineDispatchQueueOnce();
};

const getRoutineFailedCustomerIdsForRun = async (routineId, runId) => {
  const id = String(routineId || '').trim();
  const targetRunId = String(runId || '').trim();
  if (!id || !targetRunId) return [];

  const store = await readStore();
  const logs = normalizeRoutinesState(store.routines).logs;
  const failedIds = new Set();

  logs.forEach((entry) => {
    if (String(entry?.routineId || '') !== id) return;
    if (String(entry?.runId || '') !== targetRunId) return;
    if (String(entry?.status || '').toLowerCase() !== 'error') return;
    const customerId = String(entry?.customerId || entry?.details?.customerId || '').trim();
    if (customerId) failedIds.add(customerId);
  });

  return Array.from(failedIds);
};

const getPublicCustomerSyncState = (state) => {
  const config = (() => {
    try {
      const settings = getNewbrConfig();
      return {
        configured: Boolean(settings.username && settings.password),
        baseUrl: settings.baseUrl,
      };
    } catch {
      return {
        configured: false,
        baseUrl: '',
      };
    }
  })();

  return {
    ...CUSTOMER_SYNC_DEFAULT_STATE,
    ...(state && typeof state === 'object' ? state : {}),
    summary: {
      ...CUSTOMER_SYNC_DEFAULT_STATE.summary,
      ...(state?.summary && typeof state.summary === 'object' ? state.summary : {}),
    },
    config,
  };
};

const scheduleCustomerSync = async (delayMs, mode) => {
  const safeDelay = Math.max(1000, Number(delayMs) || 1000);
  const nextScheduledAt = new Date(Date.now() + safeDelay).toISOString();

  await updateStore((store) => {
    store.customerSync = {
      ...store.customerSync,
      nextScheduledAt,
      lastMode: mode || store.customerSync.lastMode,
    };
    return store;
  });
};

const markCustomerSyncRunning = async (mode) => {
  const startedAt = nowIso();
  const store = await updateStore((current) => {
    current.customerSync = {
      ...current.customerSync,
      status: 'running',
      currentRunStartedAt: startedAt,
      lastAttemptAt: startedAt,
      lastMode: mode,
      nextScheduledAt: null,
      lastError: null,
      lastErrorCode: null,
      authErrorMessage: null,
    };
    return current;
  });

  return {
    startedAt,
    sync: store.customerSync,
  };
};

const classifySyncError = (error) => {
  if (error instanceof SyncError) {
    return error;
  }

  if (error?.name === 'AbortError') {
    return new SyncError('A sincronizacao com o NewBr excedeu o tempo limite.', 504, 'timeout');
  }

  return new SyncError(error?.message || 'Falha inesperada na sincronizacao.', 500, 'unknown');
};

const finishCustomerSyncSuccess = async (mode, startedAt, result) => {
  const finishedAt = nowIso();
  const customers = result.rows.map((row, index) => normalizeCustomerRow(row, index, finishedAt));
  const summary = buildCustomerSyncSummary(customers);
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  let autoSyncIntervalMs = CUSTOMER_SYNC_SETTINGS_DEFAULT.autoSyncIntervalMinutes * 60 * 1000;

  const store = await updateStore((current) => {
    autoSyncIntervalMs = getCustomerAutoSyncIntervalMs(current);
    current.customers = customers;
    current.customerSync = {
      ...current.customerSync,
      status: 'success',
      currentRunStartedAt: null,
      lastAttemptAt: startedAt,
      lastSyncAt: finishedAt,
      lastSuccessfulSyncAt: finishedAt,
      lastMode: mode,
      nextScheduledAt: new Date(Date.now() + autoSyncIntervalMs).toISOString(),
      hasCompletedInitialSync: true,
      lastError: null,
      lastErrorCode: null,
      authErrorMessage: null,
      pagesLoaded: result.pagesLoaded,
      totalRows: customers.length,
      lastPage: result.lastPage || null,
      summary,
    };
    current.customerSyncLogs = appendCustomerSyncLog(current.customerSyncLogs, {
      id: `customer-sync-${Date.now().toString(36)}`,
      mode,
      status: 'success',
      startedAt,
      finishedAt,
      durationMs,
      totalRows: customers.length,
      pagesLoaded: result.pagesLoaded,
      lastPage: result.lastPage || null,
      summary,
      message: `Sincronizacao concluida com ${customers.length} cliente(s).`,
    });
    return current;
  });

  return store.customerSync;
};

const finishCustomerSyncFailure = async (mode, startedAt, error) => {
  const syncError = classifySyncError(error);
  const finishedAt = nowIso();
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  let autoSyncIntervalMs = CUSTOMER_SYNC_SETTINGS_DEFAULT.autoSyncIntervalMinutes * 60 * 1000;
  const syncAuthMessage =
    syncError.code === 'auth'
      ? 'Falha de autorizacao na sincronizacao NewBr. Revise as credenciais configuradas na VPS.'
      : syncError.code === 'cloudflare'
        ? 'O NewBr bloqueou a sincronizacao com uma protecao do Cloudflare. A tela continua operando, mas a carga de clientes nao conseguiu entrar.'
        : null;

  const store = await updateStore((current) => {
    autoSyncIntervalMs = getCustomerAutoSyncIntervalMs(current);
    current.customerSync = {
      ...current.customerSync,
      status: 'error',
      currentRunStartedAt: null,
      lastAttemptAt: startedAt,
      lastMode: mode,
      nextScheduledAt: new Date(Date.now() + autoSyncIntervalMs).toISOString(),
      lastError: syncError.message,
      lastErrorCode: syncError.code,
      authErrorMessage: syncAuthMessage,
      hasCompletedInitialSync: current.customerSync.hasCompletedInitialSync || current.customers.length > 0,
    };
    current.customerSyncLogs = appendCustomerSyncLog(current.customerSyncLogs, {
      id: `customer-sync-${Date.now().toString(36)}`,
      mode,
      status: 'error',
      startedAt,
      finishedAt,
      durationMs,
      totalRows: current.customerSync.totalRows || current.customers.length,
      pagesLoaded: 0,
      lastPage: null,
      summary: current.customerSync.summary,
      errorCode: syncError.code,
      message: syncError.message,
    });
    return current;
  });

  return store.customerSync;
};

const finishCustomerSyncImportedSuccess = async (payload = {}) => {
  const startedAt = payload.startedAt || nowIso();
  const finishedAt = nowIso();
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const customers = rows.map((row, index) => normalizeCustomerRow(row, index, finishedAt));
  const summary = buildCustomerSyncSummary(customers);
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  const source = String(payload.source || 'browser-newbr').trim() || 'browser-newbr';
  const pagesLoaded = Number.parseInt(String(payload.pagesLoaded ?? ''), 10);
  const totalRows = Number.parseInt(String(payload.totalRows ?? ''), 10);
  const lastPageValue = Number.parseInt(String(payload.lastPage ?? ''), 10);
  const mode = String(payload.mode || 'browser_manual').trim() || 'browser_manual';
  const browserAuth = normalizeBrowserAuth(payload.auth);
  let autoSyncIntervalMs = CUSTOMER_SYNC_SETTINGS_DEFAULT.autoSyncIntervalMinutes * 60 * 1000;

  const store = await updateStore((current) => {
    autoSyncIntervalMs = getCustomerAutoSyncIntervalMs(current);
    current.customers = customers;
    current.customerSyncContext = {
      ...current.customerSyncContext,
      browserAuth: browserAuth || current.customerSyncContext?.browserAuth || null,
    };
    current.customerSync = {
      ...current.customerSync,
      status: 'success',
      currentRunStartedAt: null,
      lastAttemptAt: startedAt,
      lastSyncAt: finishedAt,
      lastSuccessfulSyncAt: finishedAt,
      lastMode: mode,
      nextScheduledAt: new Date(Date.now() + autoSyncIntervalMs).toISOString(),
      hasCompletedInitialSync: true,
      lastError: null,
      lastErrorCode: null,
      authErrorMessage: null,
      pagesLoaded: Number.isFinite(pagesLoaded) ? pagesLoaded : 0,
      totalRows: Number.isFinite(totalRows) && totalRows > 0 ? totalRows : customers.length,
      lastPage: Number.isFinite(lastPageValue) ? lastPageValue : null,
      summary,
    };
    current.customerSyncLogs = appendCustomerSyncLog(current.customerSyncLogs, {
      id: `customer-sync-${Date.now().toString(36)}`,
      mode,
      source,
      status: 'success',
      startedAt,
      finishedAt,
      durationMs,
      totalRows: customers.length,
      pagesLoaded: Number.isFinite(pagesLoaded) ? pagesLoaded : 0,
      lastPage: Number.isFinite(lastPageValue) ? lastPageValue : null,
      summary,
      message: `Importacao ${source} concluida com ${customers.length} cliente(s).`,
    });
    return current;
  });

  customerSyncRunning = false;
  return store.customerSync;
};

const finishCustomerSyncBrowserFailure = async (payload = {}) => {
  const startedAt = payload.startedAt || nowIso();
  const finishedAt = nowIso();
  const mode = String(payload.mode || 'browser_automatic').trim() || 'browser_automatic';
  const message = String(payload.error || 'Nao foi possivel sincronizar clientes pelo navegador.').trim();
  const errorCode = String(payload.errorCode || 'browser').trim() || 'browser';
  const authErrorMessage = payload.authErrorMessage ? String(payload.authErrorMessage).trim() : null;
  const source = String(payload.source || 'browser-newbr').trim() || 'browser-newbr';
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  let retryDelayMs = CUSTOMER_SYNC_RETRY_INTERVAL_MS;

  const store = await updateStore((current) => {
    retryDelayMs = mode === 'browser_automatic' ? CUSTOMER_SYNC_RETRY_INTERVAL_MS : getCustomerAutoSyncIntervalMs(current);
    current.customerSync = {
      ...current.customerSync,
      status: 'error',
      currentRunStartedAt: null,
      lastAttemptAt: startedAt,
      lastMode: mode,
      nextScheduledAt: new Date(Date.now() + retryDelayMs).toISOString(),
      lastError: message,
      lastErrorCode: errorCode,
      authErrorMessage,
      hasCompletedInitialSync: current.customerSync.hasCompletedInitialSync || current.customers.length > 0,
    };
    current.customerSyncLogs = appendCustomerSyncLog(current.customerSyncLogs, {
      id: `customer-sync-${Date.now().toString(36)}`,
      mode,
      source,
      status: 'error',
      startedAt,
      finishedAt,
      durationMs,
      totalRows: current.customerSync.totalRows || current.customers.length,
      pagesLoaded: 0,
      lastPage: null,
      summary: current.customerSync.summary,
      errorCode,
      message,
    });
    return current;
  });

  customerSyncRunning = false;
  return store.customerSync;
};

const executeCustomerSync = async (mode, startedAt, overrides = {}) => {
  try {
    const result = await fetchAllCustomersFromNewbr(overrides);
    return await finishCustomerSyncSuccess(mode, startedAt, result);
  } catch (error) {
    await finishCustomerSyncFailure(mode, startedAt, error);
    throw classifySyncError(error);
  } finally {
    customerSyncRunning = false;
  }
};

const startCustomerSync = async (mode = 'manual', overrides = {}) => {
  if (customerSyncRunning) {
    const store = await readStore();
    return {
      started: false,
      sync: store.customerSync,
    };
  }

  customerSyncRunning = true;

  const providedBrowserAuth = normalizeBrowserAuth(overrides?.auth);
  if (providedBrowserAuth) {
    await updateStore((current) => {
      current.customerSyncContext = {
        ...current.customerSyncContext,
        browserAuth: providedBrowserAuth,
      };
      return current;
    });
  }

  const { startedAt, sync } = await markCustomerSyncRunning(mode);
  void executeCustomerSync(mode, startedAt, overrides).catch((error) => {
    log(`Falha na sincronizacao de clientes: ${error?.message || error}`);
  });

  return {
    started: true,
    sync,
  };
};

const recoverCustomerSyncStateOnBoot = async () => {
  const store = await updateStore((current) => {
    if (current.customerSync.status === 'running') {
      current.customerSync = {
        ...current.customerSync,
        status: 'error',
        currentRunStartedAt: null,
        lastError: 'O servidor foi reiniciado durante a sincronizacao anterior.',
        lastErrorCode: 'interrupted',
        authErrorMessage: null,
      };
      current.customerSyncLogs = appendCustomerSyncLog(current.customerSyncLogs, {
        id: `customer-sync-${Date.now().toString(36)}`,
        mode: current.customerSync.lastMode || 'automatic',
        status: 'error',
        startedAt: current.customerSync.lastAttemptAt || nowIso(),
        finishedAt: nowIso(),
        durationMs: 0,
        totalRows: current.customerSync.totalRows || current.customers.length,
        pagesLoaded: 0,
        lastPage: current.customerSync.lastPage || null,
        summary: current.customerSync.summary,
        errorCode: 'interrupted',
        message: 'O servidor foi reiniciado durante a sincronizacao anterior.',
      });
    }
    return current;
  });

  const persistedNextScheduledAt = Date.parse(store.customerSync.nextScheduledAt || '');
  if (Number.isFinite(persistedNextScheduledAt)) {
    await scheduleCustomerSync(Math.max(persistedNextScheduledAt - Date.now(), 5000), store.customerSync.lastMode || 'automatic');
    return;
  }

  if (!store.customerSync.hasCompletedInitialSync) {
    const remainingMs = resolveCustomerSyncRescheduleDelayMs(store);
    if (remainingMs != null) {
      await scheduleCustomerSync(remainingMs, 'automatic');
    }
    return;
  }

  const remainingMs = resolveCustomerSyncRescheduleDelayMs(store);
  if (remainingMs != null) {
    await scheduleCustomerSync(remainingMs, 'automatic');
  }
};

const runDueRoutines = async () => {
  if (!ROUTINE_SCHEDULER_ENABLED || routineSchedulerRunning) return;
  routineSchedulerRunning = true;
  const dateParts = getSaoPauloDateParts();

  try {
    const store = await readStore();
    const routines = normalizeRoutinesState(store.routines).items.filter((routine) => isRoutineDueNow(routine, dateParts));

    await updateStore((current) => {
      current.routines = {
        ...normalizeRoutinesState(current.routines),
        lastSchedulerRunAt: nowIso(),
      };
      return current;
    });

    for (const routine of routines) {
      const runKey = getRoutineRunKeyForNow(routine, dateParts);
      void enqueueRoutineExecution(routine.id, { runKey, trigger: 'schedule' }).catch((error) => {
        console.error(`[local-api] routine scheduler error id=${routine.id}: ${error?.message || error}`);
      });
    }
  } finally {
    routineSchedulerRunning = false;
  }
};

const initializeRoutineScheduler = () => {
  if (!ROUTINE_SCHEDULER_ENABLED || routineSchedulerTimer) return;
  routineSchedulerTimer = startRegisteredInterval('routine-scheduler', () => {
    void runDueRoutines();
  }, Math.max(15000, ROUTINE_SCHEDULER_INTERVAL_MS));
  void runDueRoutines();
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    attachSlowRouteLogger(req, res, { source: 'local-api' });

    if (req.method === 'OPTIONS') {
      return sendJson(res, 204, {});
    }

    if (
      await handleCoreUtilityRoutes(req, res, {
        sendJson,
        readBody,
        isInternalLoopbackRequest,
        publishLocalEvent,
      }, url)
    ) {
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/local/chatbot/process-incoming') {
      if (!isInternalLoopbackRequest(req)) {
        return sendJson(res, 403, { error: 'Acesso interno obrigatorio.' });
      }

      const payload = await readBody(req);
      const conversation = normalizeIncomingChatbotConversationPayload(payload);

      if (!conversation.id || !conversation.last_message) {
        return sendJson(res, 200, {
          ok: true,
          skipped: true,
          reason: 'missing_conversation_or_message',
        });
      }

      const messageKey =
        payload.messageKey ||
        payload.message_key ||
        [
          conversation.id,
          conversation.last_message_time || conversation.last_message_at || conversation.updated_date || '',
          conversation.last_message || '',
          conversation.last_message_type || 'text',
        ].join('|');

      const result = await processChatbotConversationRequest(conversation, { messageKey });
      return sendJson(res, 200, result);
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/api/local/chatbot/process-conversation' &&
      !CHATBOT_FRONTEND_PROCESSING_ENABLED &&
      req.headers.origin
    ) {
      return sendJson(res, 200, {
        ok: true,
        skipped: true,
        reason: 'backend_runtime_enabled',
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/auth/login') {
      const payload = await readBody(req);
      const username = String(payload?.username || payload?.user || '').trim().slice(0, 160);
      const password = String(payload?.password || '').slice(0, 512);
      const remember = Boolean(payload?.remember);
      const loginKey = sanitizeLoginIdentifier(username);

      if (!username || !password) {
        return sendJson(res, 400, { error: 'Informe usuário e senha para entrar.' });
      }

      const store = await readStore();
      const activeAttempt = getActiveLoginAttempt(store.auth, loginKey);
      if (activeAttempt) {
        return sendJson(res, 429, {
          error: 'Muitas tentativas de login. Aguarde antes de tentar novamente.',
          retryAt: activeAttempt.lockedUntil,
        });
      }

      const matchedUser = findUserByLogin(store, username);
      const passwordIsValid = matchedUser ? verifyPassword(password, matchedUser.password_hash) : false;

      if (!matchedUser || !passwordIsValid) {
        await updateStore((current) => {
          current.auth = recordFailedLoginAttempt(current.auth, loginKey);
          return current;
        });

        return sendJson(res, 401, { error: 'Usuário ou senha inválidos.' });
      }

      const { token, record } = createSessionRecord(req, matchedUser.id, remember);
      const shouldClearFailedAttempt = Boolean(pruneAuthState(store.auth).loginAttempts[loginKey]);
      const storedInSql = upsertSqlAuthSession(record);

      if (shouldClearFailedAttempt || !storedInSql) {
        await updateStore((current) => {
          current.auth = clearFailedLoginAttempt(current.auth, loginKey);
          if (!storedInSql) {
            current.auth.sessions = pruneAuthState(current.auth).sessions
              .filter((session) => session.user_id !== matchedUser.id || session.id !== record.id)
              .concat(record)
              .slice(-40);
          }
          return current;
        });
      }

      if (AUTH_TOUCHES_ATTENDANCE_PRESENCE_ENABLED) {
        const loginPresence = await touchAttendancePresenceForUser(store, matchedUser, { force: true });
        if (AUTH_ACTIVITY_ASSIGNMENT_DRAIN_ENABLED && loginPresence?.status === 'attending') {
          scheduleQueuedWhatsappAssignmentDrain('login');
        }
      }

      return sendJson(
        res,
        200,
        {
          ok: true,
          user: sanitizeAuthenticatedUserForClient(store, matchedUser),
          session: {
            remember,
            expiresAt: record.expires_at,
          },
        },
        {
          'Set-Cookie': buildSessionCookie(req, token, remember),
        },
      );
    }

    if (req.method === 'POST' && url.pathname === '/api/local/auth/logout') {
      const token = getSessionTokenFromRequest(req);
      const currentStore = await readStore();
      const sessionContext = await resolveSessionContext(currentStore, req);
      await invalidateSessionToken(token);
      let assignmentRecovery = null;
      if (AUTH_LOGOUT_ENDS_ATTENDANCE_ENABLED && sessionContext?.user?.id) {
        await removeAttendancePresenceForUser(sessionContext.user.id);
        assignmentRecovery = enqueueLogoutAssignmentRecovery(sessionContext.user, 'user_logout');
      }
      return sendJson(
        res,
        200,
        {
          ok: true,
          requeuedConversationIds: [],
          reassignedConversations: [],
          assignmentRecoveryScheduled: Boolean(assignmentRecovery?.scheduled),
          assignmentRecoveryQueued: Boolean(assignmentRecovery?.queued),
          assignmentRecoveryJobId: assignmentRecovery?.job?.id || null,
        },
        {
          'Set-Cookie': buildExpiredSessionCookie(req),
        },
      );
    }

    if (url.pathname.startsWith('/api/local') && !['/api/local/health', '/api/local/auth/login'].includes(url.pathname)) {
      if (url.pathname === '/api/local/auth/me' && req.method === 'GET') {
        const authContext = await requireAuthenticatedSession(req);
        void updateUserLastSeenSession(authContext.session.id);
        if (AUTH_TOUCHES_ATTENDANCE_PRESENCE_ENABLED) {
          void touchAttendancePresenceForUser(authContext.store, authContext.user)
            .then((presence) => {
              if (AUTH_ACTIVITY_ASSIGNMENT_DRAIN_ENABLED && presence?.status === 'attending') {
                scheduleQueuedWhatsappAssignmentDrain('auth_me');
              }
            })
            .catch((error) => {
              log(`Falha ao atualizar presenca do atendimento: ${error?.message || error}`);
            });
        }
        return sendJson(res, 200, sanitizeAuthenticatedUserForClient(authContext.store, authContext.user));
      }

      const authContext = await requireAuthenticatedSession(req);
      req.authContext = authContext;
      void updateUserLastSeenSession(authContext.session.id);
      if (AUTH_TOUCHES_ATTENDANCE_PRESENCE_ENABLED) {
        void touchAttendancePresenceForUser(authContext.store, authContext.user)
          .then((presence) => {
            if (AUTH_ACTIVITY_ASSIGNMENT_DRAIN_ENABLED && presence?.status === 'attending') {
              scheduleQueuedWhatsappAssignmentDrain('authenticated_activity');
            }
          })
          .catch((error) => {
            log(`Falha ao atualizar presenca do atendimento: ${error?.message || error}`);
          });
      }
    }

    if (
      await handleCustomerReadRoutes(req, res, url, {
        getPublicCustomerSyncState,
        readStore,
        sendJson,
        sendJsonText,
      })
    ) {
      return;
    }

    if (await handleDashboardRoutes(req, res, url, { sendJson, readStore, readAttendanceConversations: readDashboardAttendanceConversations })) {
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/local/tavinho/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'tavinho-agent-api',
        model: process.env.TAVINHO_OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/local/tavinho/knowledge-summary') {
      const store = await readStore();
      const summary = await getTavinhoKnowledgeSummary({ settings: store.tavinhoSettings });
      return sendJson(res, 200, summary);
    }

    if (req.method === 'POST' && url.pathname === '/api/local/tavinho/message') {
      try {
        const payload = await readBody(req);
        const store = await readStore();
        const result = await askTavinho({
          ...payload,
          tavinhoSettings: store.tavinhoSettings,
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          ok: false,
          error: error?.message || 'Tavinho indisponivel no momento.',
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/local/checkout/renewals/customer-status') {
      const phone = String(url.searchParams.get('phone') || '').trim();
      const params = new URLSearchParams();
      if (phone) params.set('phone', phone);
      const payload = await requestCheckoutApiGetJson(`/api/checkout/renewals/customer-status?${params.toString()}`);
      return sendJson(res, 200, payload);
    }

    if (req.method === 'POST' && url.pathname === '/api/local/presence/pause-distribution') {
      const authContext = req.authContext;
      const payload = await readBody(req);
      const reason = normalizeAttendanceDistributionPauseReason(payload?.reason);
      const presence = await pauseAttendanceDistributionForUser(authContext.store, authContext.user, reason);
      publishLocalEvent('presence:distribution-paused', {
        user_id: String(authContext.user?.id || '').trim(),
        paused_until: String(presence?.paused_until || '').trim(),
        pause_reason: String(presence?.pause_reason || '').trim(),
        pause_reason_label: String(presence?.pause_reason_label || '').trim(),
      });
      return sendJson(res, 200, {
        ok: true,
        presence,
        distributionPause: {
          active: true,
          pausedUntil: String(presence?.paused_until || '').trim(),
          remainingMs: getPresencePauseRemainingMs(presence),
          reason: String(presence?.pause_reason || '').trim(),
          reasonLabel: String(presence?.pause_reason_label || '').trim(),
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/presence/start') {
      const authContext = req.authContext;
      const presence = await touchAttendancePresenceForUser(authContext.store, authContext.user, { force: true });
      publishLocalEvent('presence:started', {
        user_id: String(authContext.user?.id || '').trim(),
      });
      if (presence?.status === 'attending') {
        scheduleQueuedWhatsappAssignmentDrain('presence_start');
      }
      return sendJson(res, 200, {
        ok: true,
        presence,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/presence/stop') {
      const authContext = req.authContext;
      const payload = await readBody(req);
      const shouldRecoverAssignments = payload?.recoverAssignments !== false;
      await removeAttendancePresenceForUser(authContext.user?.id);
      const assignmentRecovery = shouldRecoverAssignments
        ? enqueueLogoutAssignmentRecovery(authContext.user, String(payload?.reason || 'attendance_stop').trim() || 'attendance_stop')
        : null;
      publishLocalEvent('presence:stopped', {
        user_id: String(authContext.user?.id || '').trim(),
        assignment_recovery_queued: Boolean(assignmentRecovery?.queued),
        assignment_recovery_job_id: assignmentRecovery?.job?.id || null,
      });
      return sendJson(res, 200, {
        ok: true,
        assignmentRecoveryQueued: Boolean(assignmentRecovery?.queued),
        assignmentRecoveryScheduled: Boolean(assignmentRecovery?.scheduled),
        assignmentRecoveryJobId: assignmentRecovery?.job?.id || null,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/presence/resume-distribution') {
      const authContext = req.authContext;
      const presence = await resumeAttendanceDistributionForUser(authContext.user);
      const refreshedStore = await readStore();
      publishLocalEvent('presence:distribution-resumed', {
        user_id: String(authContext.user?.id || '').trim(),
      });
      void assignQueuedWhatsappConversations(refreshedStore).catch((error) => {
        log(`Falha ao redistribuir conversas apos sair da pausa: ${error?.message || error}`);
      });
      return sendJson(res, 200, {
        ok: true,
        presence,
        distributionPause: {
          active: false,
          pausedUntil: '',
          remainingMs: 0,
          reason: '',
          reasonLabel: '',
        },
      });
    }

    if (await handleCoreEventRoutes(req, res, { nowIso }, url)) {
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/local/presence/attending-users') {
      const activeUserIds = getActiveAttendingUserIds(req.authContext.store);
      const users = (Array.isArray(req.authContext.store.users) ? req.authContext.store.users : [])
        .filter((user) => activeUserIds.has(String(user?.id || '').trim()) && !isAdminUser(req.authContext.store, user))
        .map((user) => sanitizeUserForClient(user));
      return sendJson(res, 200, users);
    }

    if (req.method === 'GET' && url.pathname === '/api/local/presence/status') {
      const authContext = req.authContext;
      const presence = getPersistedAttendancePresenceForUser(authContext.store, authContext.user?.id);
      return sendJson(res, 200, {
        ok: true,
        presence,
        distributionPause: {
          active: isPresenceDistributionPaused(presence),
          pausedUntil: String(presence?.paused_until || '').trim(),
          remainingMs: getPresencePauseRemainingMs(presence),
          reason: String(presence?.pause_reason || '').trim(),
          reasonLabel: String(presence?.pause_reason_label || '').trim(),
        },
      });
    }


    const assignConversationMatch = url.pathname.match(/^\/api\/local\/conversations\/([^/]+)\/assign$/);
    if (req.method === 'POST' && assignConversationMatch) {
      const authContext = req.authContext;
      const isRequesterAdmin = isAdminUser(authContext.store, authContext.user);

      const conversationId = decodeURIComponent(assignConversationMatch[1] || '').trim();
      const payload = await readBody(req);
      const targetUserId = String(payload?.userId || '').trim();
      const sourceConversationIds = Array.isArray(payload?.sourceConversationIds) ? payload.sourceConversationIds : [];
      const matchingServiceIds = normalizeStringArray(payload?.matchingServiceIds);
      if (!conversationId || !targetUserId) {
        return sendJson(res, 400, { error: 'Informe conversa e usuario de destino.' });
      }

      const targetUser = (Array.isArray(authContext.store.users) ? authContext.store.users : []).find(
        (user) => String(user?.id || '').trim() === targetUserId,
      );
      if (!targetUser) {
        return sendJson(res, 404, { error: 'Usuario de destino nao encontrado.' });
      }
      if (isAdminUser(authContext.store, targetUser)) {
        return sendJson(res, 400, { error: 'Administrador nao participa da fila de atendimento.' });
      }
      if (!getActiveAttendingUserIds(authContext.store).has(targetUserId)) {
        return sendJson(res, 400, { error: 'Usuario de destino nao esta logado ou esta pausado.' });
      }
      if (matchingServiceIds.length > 0) {
        const targetServiceIds = getUserServiceIds(authContext.store, targetUser);
        if (!matchingServiceIds.some((serviceId) => targetServiceIds.includes(serviceId))) {
          return sendJson(res, 400, { error: 'Usuario de destino nao pertence ao servico desta conversa.' });
        }
      }

      const whatsappStore = await readWhatsappStore();
      const resolved = findWhatsappConversationByIds(
        whatsappStore,
        resolveConversationIdCandidates(conversationId, sourceConversationIds),
      );
      const conversation = resolved.conversation;
      if (!conversation) {
        return sendJson(res, 404, { error: 'Conversa nao encontrada.' });
      }
      if (!isRequesterAdmin && !isWhatsappConversationAssignedToLocalUser(conversation, authContext.user)) {
        return sendJson(res, 403, { error: 'Apenas o atendente atribuido ou um administrador pode transferir esta conversa.' });
      }

      const assignedAt = nowIso();
      const previouslyAssignedUser = (Array.isArray(authContext.store.users) ? authContext.store.users : []).find((user) =>
        isWhatsappConversationAssignedToLocalUser(conversation, user),
      );
      const exclusionPatch = buildAssignmentExclusionPatch(previouslyAssignedUser || authContext.user);
      const assignedConversation = {
        ...conversation,
        ...exclusionPatch,
        assigned_agent: targetUser.email || targetUser.id,
        assigned_agent_id: targetUser.id,
        assigned_agent_email: targetUser.email || '',
        assigned_agent_name: targetUser.full_name || targetUser.username || targetUser.email || 'Operador',
        assigned_at: assignedAt,
        assignment_source: 'manual_assignment',
        assignment_exclusion_reason: 'manual_transfer',
        queue_status: 'assigned',
        queued_at: '',
      };
      whatsappStore.conversations[resolved.conversationId] = assignedConversation;
      await writeWhatsappStore(whatsappStore, { conversationIds: [resolved.conversationId] });
      publishLocalEvent('conversation:assignment-updated', {
        action: 'manual_assignment',
        conversation_ids: [resolved.conversationId],
        assigned_agent_id: targetUser.id,
        assigned_agent_email: targetUser.email || '',
        assigned_agent_name: assignedConversation.assigned_agent_name,
      });

      return sendJson(res, 200, {
        ok: true,
        conversationId: resolved.conversationId,
        conversation: assignedConversation,
      });
    }

    const requeueConversationMatch = url.pathname.match(/^\/api\/local\/conversations\/([^/]+)\/requeue$/);
    if (req.method === 'POST' && requeueConversationMatch) {
      const authContext = req.authContext;
      const isRequesterAdmin = isAdminUser(authContext.store, authContext.user);
      const conversationId = decodeURIComponent(requeueConversationMatch[1] || '').trim();
      const payload = await readBody(req);
      const sourceConversationIds = Array.isArray(payload?.sourceConversationIds) ? payload.sourceConversationIds : [];
      const targetServiceId = String(payload?.targetServiceId || '').trim();

      if (!conversationId) {
        return sendJson(res, 400, { error: 'Informe a conversa que deve voltar para a fila.' });
      }

      const whatsappStore = await readWhatsappStore();
      const resolved = findWhatsappConversationByIds(
        whatsappStore,
        resolveConversationIdCandidates(conversationId, sourceConversationIds),
      );
      const conversation = resolved.conversation;
      if (!conversation) {
        return sendJson(res, 404, { error: 'Conversa nao encontrada.' });
      }
      if (!isRequesterAdmin && !isWhatsappConversationAssignedToLocalUser(conversation, authContext.user)) {
        return sendJson(res, 403, { error: 'Apenas o atendente atribuido ou um administrador pode devolver esta conversa para a fila.' });
      }

      const result = await requeueWhatsappConversationForService({
        store: await readStore(),
        conversationId: resolved.conversationId,
        sourceConversationIds: [],
        requester: authContext.user,
        assignmentSource: 'manual_service_queue',
        targetServiceId,
      });

      return sendJson(res, result.status || 200, result.status && result.status >= 400 ? { error: result.error } : result);
    }

    if (req.method === 'POST' && url.pathname === '/api/local/auth/logout-user') {
      const payload = await readBody(req);
      const targetUserId = String(payload?.userId || '').trim();
      const authContext = req.authContext;

      if (!targetUserId) {
        return sendJson(res, 400, { error: 'Informe o usuário que deve ser desconectado.' });
      }

      if (!canManageTeamSessions(authContext.store, authContext.user)) {
        return sendJson(res, 403, { error: 'Apenas administradores podem desconectar outros usuários.' });
      }

      const targetUser = (Array.isArray(authContext.store.users) ? authContext.store.users : []).find(
        (user) => String(user?.id || '') === targetUserId,
      );
      if (!targetUser) {
        return sendJson(res, 404, { error: 'Usuário não encontrado.' });
      }

      const removedSessions = await invalidateUserSessions(targetUserId);
      let assignmentRecovery = null;
      if (AUTH_LOGOUT_ENDS_ATTENDANCE_ENABLED) {
        await removeAttendancePresenceForUser(targetUserId);
        assignmentRecovery = enqueueLogoutAssignmentRecovery(targetUser, 'admin_logout_user');
      }
      return sendJson(res, 200, {
        ok: true,
        removedSessions,
        requeuedConversationIds: [],
        reassignedConversations: [],
        assignmentRecoveryScheduled: Boolean(assignmentRecovery?.scheduled),
        assignmentRecoveryQueued: Boolean(assignmentRecovery?.queued),
        assignmentRecoveryJobId: assignmentRecovery?.job?.id || null,
        user: sanitizeUserForClient(targetUser),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/local/labels') {
      return sendJson(res, 200, getLabelsState(req.authContext.store));
    }

    if (req.method === 'POST' && url.pathname === '/api/local/labels/import') {
      const payload = await readBody(req);
      const labelsState = await persistLabelsState((currentState) => mergeImportedLabelsState(currentState, payload));
      return sendJson(res, 200, labelsState);
    }

    if (req.method === 'POST' && url.pathname === '/api/local/labels/migrate-legacy') {
      const migratedStore = await updateStore((store) => store);
      return sendJson(res, 200, {
        ok: true,
        labels: getLabelsState(migratedStore),
      });
    }

    const labelAssignmentsMatch = url.pathname.match(/^\/api\/local\/labels\/assignments\/([^/]+)$/);
    if (req.method === 'PUT' && labelAssignmentsMatch) {
      const conversationId = String(labelAssignmentsMatch[1] || '').trim();
      const payload = await readBody(req);

      if (!conversationId) {
        return sendJson(res, 400, { error: 'Conversa invalida para vinculacao de etiqueta.' });
      }

      const labelIds = Array.isArray(payload?.labelIds) ? payload.labelIds : [];
      let nextLabelIds = [];

      const labelsState = await persistLabelsState((currentState) => {
        const allowedLabelIds = new Set(currentState.customLabels.map((label) => label.id));
        nextLabelIds = Array.from(
          new Set(
            labelIds
              .map((labelId) => String(labelId || '').trim())
              .filter((labelId) => labelId && allowedLabelIds.has(labelId)),
          ),
        );

        const nextAssignments = { ...(currentState.assignments || {}) };
        if (nextLabelIds.length > 0) {
          nextAssignments[conversationId] = nextLabelIds;
        } else {
          delete nextAssignments[conversationId];
        }

        return {
          ...currentState,
          assignments: nextAssignments,
        };
      });

      return sendJson(res, 200, {
        conversationId,
        labelIds: nextLabelIds,
        state: labelsState,
      });
    }

    const labelStageMatch = url.pathname.match(/^\/api\/local\/labels\/stages\/([^/]+)$/);
    if (req.method === 'PUT' && labelStageMatch) {
      const conversationId = String(labelStageMatch[1] || '').trim();
      const payload = await readBody(req);
      const labelId = String(payload?.labelId || '').trim();

      if (!conversationId) {
        return sendJson(res, 400, { error: 'Conversa invalida para estagio de etiqueta.' });
      }

      let stageLabelId = '';
      const labelsState = await persistLabelsState((currentState) => {
        const customLabelIds = new Set(currentState.customLabels.map((label) => label.id));
        const isValidCustomLabel = customLabelIds.has(labelId);

        if (labelId && !isValidCustomLabel) {
          throw new SyncError('Etiqueta nao encontrada para este estagio.', 404, 'label_not_found');
        }

        const nextStageAssignments = { ...(currentState.stageAssignments || {}) };
        if (labelId) {
          nextStageAssignments[conversationId] = labelId;
          stageLabelId = labelId;
        } else {
          delete nextStageAssignments[conversationId];
        }

        const nextAssignments = { ...(currentState.assignments || {}) };
        if (isValidCustomLabel) {
          const nextCustomIds = new Set(nextAssignments[conversationId] || []);
          nextCustomIds.add(labelId);
          nextAssignments[conversationId] = Array.from(nextCustomIds);
        }

        return {
          ...currentState,
          assignments: nextAssignments,
          stageAssignments: nextStageAssignments,
        };
      });

      return sendJson(res, 200, {
        conversationId,
        labelId: stageLabelId,
        state: labelsState,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/labels') {
      const payload = await readBody(req);
      const nextLabel = normalizeCustomLabel({
        ...payload,
        id: payload?.id || `custom-label-${toSlug(payload?.name)}-${Date.now().toString(36)}`,
        updatedAt: nowIso(),
      });

      if (!nextLabel.name) {
        return sendJson(res, 400, { error: 'Informe um titulo para a etiqueta.' });
      }

      const labelsState = await persistLabelsState((currentState) => ({
        ...currentState,
        customLabels: [...currentState.customLabels, nextLabel],
      }));

      const createdLabel = labelsState.customLabels.find((label) => label.id === nextLabel.id) || nextLabel;
      return sendJson(res, 201, createdLabel);
    }

    const labelItemMatch = url.pathname.match(/^\/api\/local\/labels\/([^/]+)$/);
    if (labelItemMatch) {
      const labelId = String(labelItemMatch[1] || '').trim();

      if (req.method === 'PUT') {
        const payload = await readBody(req);
        let updatedLabel = null;

        const labelsState = await persistLabelsState((currentState) => {
          const currentLabel = currentState.customLabels.find((label) => label.id === labelId) || null;
          if (!currentLabel) {
            return currentState;
          }

          updatedLabel = normalizeCustomLabel({
            ...currentLabel,
            ...payload,
            id: currentLabel.id,
            createdAt: currentLabel.createdAt,
            updatedAt: nowIso(),
          });

          if (!updatedLabel.name) {
            throw new SyncError('Informe um titulo para a etiqueta.', 400, 'invalid_label');
          }

          return {
            ...currentState,
            customLabels: currentState.customLabels.map((label) => (label.id === labelId ? updatedLabel : label)),
          };
        });

        if (!updatedLabel) {
          return sendJson(res, 404, { error: 'Etiqueta nao encontrada.' });
        }

        const savedLabel = labelsState.customLabels.find((label) => label.id === labelId) || updatedLabel;
        return sendJson(res, 200, savedLabel);
      }

      if (req.method === 'DELETE') {
        const existingState = await readStore();
        const hasLabel = getLabelsState(existingState).customLabels.some((label) => label.id === labelId);
        if (!hasLabel) {
          return sendJson(res, 404, { error: 'Etiqueta nao encontrada.' });
        }

        await persistLabelsState((currentState) => ({
          ...currentState,
          customLabels: currentState.customLabels.filter((label) => label.id !== labelId),
          assignments: Object.entries(currentState.assignments || {}).reduce((accumulator, [conversationId, labelIds]) => {
            const filteredIds = (Array.isArray(labelIds) ? labelIds : []).filter((currentLabelId) => currentLabelId !== labelId);
            if (filteredIds.length > 0) {
              accumulator[conversationId] = filteredIds;
            }
            return accumulator;
          }, {}),
          stageAssignments: Object.entries(currentState.stageAssignments || {}).reduce((accumulator, [conversationId, assignedLabelId]) => {
            if (assignedLabelId !== labelId) {
              accumulator[conversationId] = assignedLabelId;
            }
            return accumulator;
          }, {}),
        }));

        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/local/customers/sync') {
      const payload = await readBody(req);
      const result = await startCustomerSync('manual', payload);
      if (!result.started) {
        return sendJson(res, 409, {
          error: 'Ja existe uma sincronizacao de clientes em andamento.',
          sync: getPublicCustomerSyncState(result.sync),
        });
      }

      return sendJson(res, 202, {
        ok: true,
        sync: getPublicCustomerSyncState(result.sync),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/customers/sync/browser-start') {
      if (customerSyncRunning) {
        const store = await readStore();
        return sendJson(res, 409, {
          error: 'Ja existe uma sincronizacao de clientes em andamento.',
          sync: getPublicCustomerSyncState(store.customerSync),
        });
      }

      const payload = await readBody(req);
      const mode = String(payload?.mode || 'browser_manual').trim() || 'browser_manual';
      customerSyncRunning = true;
      const { sync } = await markCustomerSyncRunning(mode);

      return sendJson(res, 202, {
        ok: true,
        sync: getPublicCustomerSyncState(sync),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/customers/sync/browser-failure') {
      const payload = await readBody(req);
      const sync = await finishCustomerSyncBrowserFailure(payload);

      return sendJson(res, 200, {
        ok: true,
        sync: getPublicCustomerSyncState(sync),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/customers/import') {
      const payload = await readBody(req);
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];

      if (!rows.length) {
        return sendJson(res, 400, { error: 'Payload de importacao sem clientes.' });
      }

      const sync = await finishCustomerSyncImportedSuccess({
        rows,
        pagesLoaded: payload?.pagesLoaded,
        lastPage: payload?.lastPage,
        totalRows: payload?.totalRows,
        source: payload?.source || 'browser-newbr',
        mode: payload?.mode || 'browser_manual',
        startedAt: payload?.startedAt || nowIso(),
      });

      return sendJson(res, 200, {
        ok: true,
        sync: getPublicCustomerSyncState(sync),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/local/routines') {
      const store = await readStore();
      const routines = normalizeRoutinesState(store.routines);
      return sendJson(res, 200, {
        items: routines.items,
        lastSchedulerRunAt: routines.lastSchedulerRunAt,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/routines') {
      const payload = await readBody(req);
      const timestamp = nowIso();
      let createdRoutine = null;

      await updateStore((current) => {
        const routines = normalizeRoutinesState(current.routines);
        createdRoutine = normalizeRoutine(
          {
            ...payload,
            id: payload?.id || `routine-${crypto.randomUUID()}`,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          routines.items.length,
        );
        current.routines = {
          ...routines,
          items: [createdRoutine, ...routines.items],
        };
        return current;
      });

      await persistRoutineLog({
        routineId: createdRoutine.id,
        routineName: createdRoutine.name,
        level: 'success',
        status: 'success',
        message: 'Rotina criada.',
      });

      return sendJson(res, 201, createdRoutine);
    }

    if (req.method === 'GET' && url.pathname === '/api/local/routines/logs/stream') {
      const requestOrigin = req.headers.origin;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': requestOrigin || '*',
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, at: nowIso() })}\n\n`);
      routineLogClients.add(res);
      req.on('close', () => {
        routineLogClients.delete(res);
      });
      return;
    }

    const routineLogsMatch = url.pathname === '/api/local/routines/logs';
    if (req.method === 'GET' && routineLogsMatch) {
      await flushPendingRoutineLogs();
      const store = await readStore();
      const routineId = String(url.searchParams.get('routineId') || '').trim();
      const limit = Number.parseInt(url.searchParams.get('limit') || '120', 10);
      const logs = normalizeRoutinesState(store.routines).logs
        .filter((logEntry) => !routineId || String(logEntry?.routineId || '') === routineId)
        .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 120);
      return sendJson(res, 200, { logs });
    }

    if (req.method === 'DELETE' && routineLogsMatch) {
      await flushPendingRoutineLogs();
      let removed = 0;
      let kept = 0;
      await updateStore((current) => {
        const routines = normalizeRoutinesState(current.routines);
        const currentLogs = Array.isArray(routines.logs) ? routines.logs : [];
        const nextLogs = keepOnlyRunningRoutineLogs(currentLogs);
        removed = Math.max(0, currentLogs.length - nextLogs.length);
        kept = nextLogs.length;
        current.routines = {
          ...routines,
          logs: nextLogs,
        };
        return current;
      });
      return sendJson(res, 200, { ok: true, removed, kept });
    }

    if (req.method === 'GET' && (url.pathname === '/api/local/dispatches/active' || url.pathname === '/api/dispatches/active')) {
      const routineJobs = ROUTINE_DISPATCH_QUEUE_ENABLED ? listActiveRoutineDispatchJobs() : [];
      return sendJson(res, 200, {
        ok: true,
        items: routineJobs.map((job) => ({
          id: job.id,
          type: 'routine',
          routineId: job.routineId,
          routineName: job.routineName,
          status: job.status,
          trigger: job.trigger || job.payload?.trigger || '',
          manual: Boolean(job.manual || job.payload?.manual),
          attempts: job.attempts,
          queuedAt: job.queuedAt,
          startedAt: job.startedAt,
          lockedBy: job.lockedBy,
        })),
      });
    }

    if (req.method === 'POST' && (url.pathname === '/api/local/dispatches/cancel' || url.pathname === '/api/dispatches/cancel')) {
      const payload = await readBody(req);
      const type = String(payload?.type || 'routine').trim();
      if (type && type !== 'routine') {
        return sendJson(res, 400, { ok: false, error: 'Somente jobs de rotina podem ser cancelados pela API local.' });
      }
      const result = ROUTINE_DISPATCH_QUEUE_ENABLED
        ? cancelRoutineDispatchJob({ id: payload?.id, routineId: payload?.routineId })
        : { ok: true, cancelled: 0 };
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/local/routines/preview') {
      const payload = await readBody(req);
      const store = await readStore();
      const routine = normalizeRoutine(payload?.routine || payload || {}, 0);
      const templates = await fetchLocalHsmItemsForRoutines();
      const template = findRoutineTemplate(templates, routine);
      const forecast = await buildRoutineForecast(store, routine, {
        limit: Number.parseInt(String(payload?.limit || '20'), 10) || 20,
        allowUpcomingPeriod: normalizeRoutineType(routine?.type) === 'follow_up',
      });
      const sampleCustomer =
        forecast.items?.[0]?.customerId && Array.isArray(store.customers)
          ? store.customers.find((customer) => String(customer?.id || '') === String(forecast.items[0].customerId)) || store.customers?.[0] || {}
          : store.customers?.[0] || {};
      const preview = template ? buildRoutineTemplatePayload(template, routine, sampleCustomer) : null;
      return sendJson(res, 200, {
        routine,
        templateFound: Boolean(template),
        audience: {
          total: forecast.totalCandidates,
          affected: forecast.affectedCount,
          sampleCustomerId: sampleCustomer?.id || null,
        },
        forecast,
        preview,
      });
    }

    const routineRunMatch = url.pathname.match(/^\/api\/local\/routines\/([^/]+)\/run-now$/);
    if (req.method === 'POST' && routineRunMatch) {
      const routineId = String(routineRunMatch[1] || '').trim();
      if (await hasActiveRoutineExecution(routineId)) {
        return sendJson(res, 409, { ok: false, skipped: true, reason: 'routine_already_running' });
      }

      const result = await enqueueRoutineExecution(routineId, { manual: true, trigger: 'manual' });
      return sendJson(res, result?.ok ? 202 : 409, result);
    }

    const routineManualRunMatch = url.pathname.match(/^\/api\/local\/routines\/([^/]+)\/manual-run$/);
    if (req.method === 'POST' && routineManualRunMatch) {
      const routineId = String(routineManualRunMatch[1] || '').trim();
      if (await hasActiveRoutineExecution(routineId)) {
        return sendJson(res, 409, { ok: false, skipped: true, reason: 'routine_already_running' });
      }
      const payload = await readBody(req);
      const customerIds = normalizeRoutineArray(payload?.customerIds);
      if (!customerIds.length) {
        return sendJson(res, 400, { error: 'Selecione ao menos um cliente para o envio manual.' });
      }

      const result = await enqueueRoutineExecution(routineId, {
        manual: true,
        trigger: 'manual-selection',
        customerIds,
        advanceWindow: Boolean(payload?.advanceWindow),
        parameterOverrides: payload?.parameterOverrides,
        mediaOverride: payload?.mediaOverride,
      });
      return sendJson(res, result?.ok ? 202 : 409, result);
    }

    const routineRetryFailedRunMatch = url.pathname.match(/^\/api\/local\/routines\/([^/]+)\/retry-failed-run$/);
    if (req.method === 'POST' && routineRetryFailedRunMatch) {
      const routineId = String(routineRetryFailedRunMatch[1] || '').trim();
      if (await hasActiveRoutineExecution(routineId)) {
        return sendJson(res, 409, { ok: false, skipped: true, reason: 'routine_already_running' });
      }
      const payload = await readBody(req);
      const runId = String(payload?.runId || '').trim();
      if (!runId) {
        return sendJson(res, 400, { error: 'Run ID obrigatorio para reenviar falhas.' });
      }

      const customerIds = await getRoutineFailedCustomerIdsForRun(routineId, runId);
      if (!customerIds.length) {
        return sendJson(res, 400, { error: 'Nenhum cliente com falha encontrado para este Run ID.' });
      }

      const result = await enqueueRoutineExecution(routineId, {
        manual: true,
        trigger: 'retry-failed-run',
        sourceRunId: runId,
        customerIds,
      });
      return sendJson(res, result?.ok ? 202 : 409, { ...result, customerCount: customerIds.length, sourceRunId: runId });
    }

    const routinePreviewMatch = url.pathname.match(/^\/api\/local\/routines\/([^/]+)\/preview$/);
    if (req.method === 'POST' && routinePreviewMatch) {
      const routineId = String(routinePreviewMatch[1] || '').trim();
      const payload = await readBody(req);
      const store = await readStore();
      const routines = normalizeRoutinesState(store.routines);
      const savedRoutine = routines.items.find((item) => item.id === routineId) || null;
      const routine = normalizeRoutine({ ...(savedRoutine || {}), ...(payload?.routine || payload || {}), id: routineId }, 0);
      const templates = await fetchLocalHsmItemsForRoutines();
      const template = findRoutineTemplate(templates, routine);
      const forecast = await buildRoutineForecast(store, routine, {
        limit: Number.parseInt(String(payload?.limit || '20'), 10) || 20,
        allowUpcomingPeriod: normalizeRoutineType(routine?.type) === 'follow_up',
      });
      const sampleCustomer =
        forecast.items?.[0]?.customerId && Array.isArray(store.customers)
          ? store.customers.find((customer) => String(customer?.id || '') === String(forecast.items[0].customerId)) || store.customers?.[0] || {}
          : store.customers?.[0] || {};
      const preview = template ? buildRoutineTemplatePayload(template, routine, sampleCustomer) : null;
      return sendJson(res, 200, {
        routine,
        templateFound: Boolean(template),
        audience: {
          total: forecast.totalCandidates,
          affected: forecast.affectedCount,
          sampleCustomerId: sampleCustomer?.id || null,
        },
        forecast,
        preview,
      });
    }

    const routineItemMatch = url.pathname.match(/^\/api\/local\/routines\/([^/]+)$/);
    if (routineItemMatch) {
      const routineId = String(routineItemMatch[1] || '').trim();

      if (req.method === 'PUT') {
        const payload = await readBody(req);
        let updatedRoutine = null;

        await updateStore((current) => {
          const routines = normalizeRoutinesState(current.routines);
          const index = routines.items.findIndex((item) => item.id === routineId);
          if (index < 0) return current;
          updatedRoutine = normalizeRoutine(
            {
              ...routines.items[index],
              ...payload,
              id: routineId,
              createdAt: routines.items[index].createdAt,
              updatedAt: nowIso(),
            },
            index,
          );
          current.routines = {
            ...routines,
            items: routines.items.map((item) => (item.id === routineId ? updatedRoutine : item)),
          };
          return current;
        });

        if (!updatedRoutine) {
          return sendJson(res, 404, { error: 'Rotina nao encontrada.' });
        }

        await persistRoutineLog({
          routineId: updatedRoutine.id,
          routineName: updatedRoutine.name,
          level: 'success',
          status: 'success',
          message: 'Rotina atualizada.',
        });

        return sendJson(res, 200, updatedRoutine);
      }

      if (req.method === 'DELETE') {
        let removedRoutine = null;
        await updateStore((current) => {
          const routines = normalizeRoutinesState(current.routines);
          removedRoutine = routines.items.find((item) => item.id === routineId) || null;
          current.routines = {
            ...routines,
            items: routines.items.filter((item) => item.id !== routineId),
          };
          return current;
        });

        if (!removedRoutine) {
          return sendJson(res, 404, { error: 'Rotina nao encontrada.' });
        }

        await persistRoutineLog({
          routineId,
          routineName: removedRoutine.name,
          level: 'warning',
          status: 'warning',
          message: 'Rotina apagada.',
        });

        return sendJson(res, 200, { ok: true, id: routineId });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/local/settings/notifications') {
      const store = await readStore();
      return sendJson(res, 200, store.notificationSettings || NOTIFICATION_SETTINGS_DEFAULT);
    }

    if (req.method === 'PUT' && url.pathname === '/api/local/settings/notifications') {
      const payload = await readBody(req);
      let nextSettings = null;

      await updateStore((store) => {
        nextSettings = {
          ...NOTIFICATION_SETTINGS_DEFAULT,
          ...(store.notificationSettings && typeof store.notificationSettings === 'object' ? store.notificationSettings : {}),
          ...(payload && typeof payload === 'object' ? payload : {}),
          updatedAt: nowIso(),
        };
        store.notificationSettings = nextSettings;
        return store;
      });

      return sendJson(res, 200, nextSettings);
    }

    if (req.method === 'GET' && url.pathname === '/api/local/dashboard/events') {
      const store = await readStore();
      const type = String(url.searchParams.get('type') || '').trim().toLowerCase();
      const limit = Number.parseInt(url.searchParams.get('limit') || '200', 10);
      const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
      const startMs = Date.parse(String(url.searchParams.get('start') || ''));
      const endMs = Date.parse(String(url.searchParams.get('end') || ''));
      const events = normalizeDashboardEventsState(store.dashboardEvents).items
        .filter((event) => !type || event.type === type)
        .filter((event) => {
          const createdMs = Date.parse(event.createdAt);
          if (Number.isFinite(startMs) && (!Number.isFinite(createdMs) || createdMs < startMs)) return false;
          if (Number.isFinite(endMs) && (!Number.isFinite(createdMs) || createdMs > endMs)) return false;
          return true;
        })
        .slice(0, safeLimit);
      return sendJson(res, 200, { items: events });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/dashboard/events') {
      const payload = await readBody(req);
      let createdEvent = null;

      await updateStore((store) => {
        const currentEvents = normalizeDashboardEventsState(store.dashboardEvents);
        createdEvent = normalizeDashboardEvent(payload, currentEvents.items.length);
        store.dashboardEvents = normalizeDashboardEventsState({
          ...currentEvents,
          items: [createdEvent, ...currentEvents.items],
          updatedAt: nowIso(),
        });
        return store;
      });

      return sendJson(res, 201, createdEvent);
    }

    if (req.method === 'POST' && url.pathname === '/api/local/dashboard/events/import') {
      const payload = await readBody(req);
      const rawItems = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
      let imported = [];

      await updateStore((store) => {
        const currentEvents = normalizeDashboardEventsState(store.dashboardEvents);
        imported = rawItems.map((item, index) => normalizeDashboardEvent(item, currentEvents.items.length + index));
        const existingIds = new Set();
        const items = [...imported, ...currentEvents.items].filter((event) => {
          if (existingIds.has(event.id)) return false;
          existingIds.add(event.id);
          return true;
        });
        store.dashboardEvents = normalizeDashboardEventsState({
          ...currentEvents,
          items,
          updatedAt: nowIso(),
        });
        return store;
      });

      return sendJson(res, 200, { imported: imported.length, items: imported });
    }

    if (req.method === 'GET' && url.pathname === '/api/local/settings/dashboard') {
      const store = await readStore();
      return sendJson(res, 200, normalizeDashboardSettings(store.dashboardSettings));
    }

    if (req.method === 'PUT' && url.pathname === '/api/local/settings/dashboard') {
      const payload = await readBody(req);
      let nextSettings = null;

      await updateStore((store) => {
        nextSettings = {
          ...normalizeDashboardSettings(store.dashboardSettings),
          ...normalizeDashboardSettings(payload),
          updatedAt: nowIso(),
        };
        store.dashboardSettings = nextSettings;
        return store;
      });

      return sendJson(res, 200, nextSettings);
    }

    if (req.method === 'GET' && url.pathname === '/api/local/settings/customer-sync') {
      const store = await readStore();
      return sendJson(res, 200, {
        ...normalizeCustomerSyncSettings(store.customerSyncSettings),
        nextScheduledAt: store.customerSync?.nextScheduledAt || null,
      });
    }

    if (req.method === 'PUT' && url.pathname === '/api/local/settings/customer-sync') {
      const payload = await readBody(req);
      let nextSettings = null;

      const store = await updateStore((current) => {
        nextSettings = {
          ...normalizeCustomerSyncSettings(current.customerSyncSettings),
          ...normalizeCustomerSyncSettings(payload),
          updatedAt: nowIso(),
        };
        current.customerSyncSettings = nextSettings;

        if (!customerSyncRunning) {
          const nextDelayMs = resolveCustomerSyncRescheduleDelayMs(current);
          if (nextDelayMs != null) {
            current.customerSync = {
              ...current.customerSync,
              nextScheduledAt: new Date(Date.now() + nextDelayMs).toISOString(),
            };
          }
        }

        return current;
      });

      return sendJson(res, 200, {
        ...nextSettings,
        nextScheduledAt: store.customerSync?.nextScheduledAt || null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/local/settings/schedules') {
      const store = await readStore();
      return sendJson(res, 200, normalizeScheduleSettings(store.scheduleSettings));
    }

    if (req.method === 'PUT' && url.pathname === '/api/local/settings/schedules') {
      const payload = await readBody(req);
      let nextSettings = null;

      await updateStore((store) => {
        nextSettings = {
          ...normalizeScheduleSettings(store.scheduleSettings),
          ...normalizeScheduleSettings(payload),
          updatedAt: nowIso(),
        };
        store.scheduleSettings = nextSettings;
        return store;
      });

      return sendJson(res, 200, nextSettings);
    }

    if (req.method === 'GET' && url.pathname === '/api/local/settings/tavinho') {
      const store = await readStore();
      return sendJson(res, 200, normalizeLocalTavinhoSettings(store.tavinhoSettings));
    }

    if (req.method === 'PUT' && url.pathname === '/api/local/settings/tavinho') {
      const payload = await readBody(req);
      let nextSettings = null;

      await updateStore((store) => {
        nextSettings = {
          ...normalizeLocalTavinhoSettings(store.tavinhoSettings),
          ...normalizeLocalTavinhoSettings(payload),
          updatedAt: nowIso(),
        };
        store.tavinhoSettings = nextSettings;
        return store;
      });

      return sendJson(res, 200, nextSettings);
    }

    if (req.method === 'POST' && url.pathname === '/api/local/chatbot/assets') {
      const payload = await readBody(req);
      const dataUrl = String(payload?.dataUrl || '').trim();
      const base64 = stripDataUrlPrefix(dataUrl);
      if (!dataUrl || getApproxBase64Bytes(base64) > CHATBOT_ASSET_MAX_BYTES) {
        return sendJson(res, 400, { error: 'Arquivo invalido ou acima do limite permitido.' });
      }

      let createdAsset = null;
      await updateStore((store) => {
        const timestamp = nowIso();
        createdAsset = {
          id: `chatbot-asset-${crypto.randomUUID()}`,
          fileName: String(payload?.fileName || 'arquivo').trim() || 'arquivo',
          mimeType: String(payload?.mimeType || 'application/octet-stream').trim() || 'application/octet-stream',
          kind: String(payload?.kind || '').trim() || 'file',
          dataUrl,
          created_date: timestamp,
          updated_date: timestamp,
        };
        store.chatbotAssets = [...(Array.isArray(store.chatbotAssets) ? store.chatbotAssets : []), createdAsset].slice(-200);
        return store;
      });

      return sendJson(res, 201, createdAsset);
    }

    if (req.method === 'GET' && url.pathname === '/api/local/chatbot/runtime-state') {
      const store = await readStore();
      return sendJson(res, 200, buildChatbotRuntimeState(store));
    }

    if (req.method === 'POST' && url.pathname === '/api/local/chatbot/process-conversation') {
      const payload = await readBody(req);
      const conversation = payload?.conversation || {};
      const result = await processChatbotConversationRequest(conversation, {
        messageKey: payload?.messageKey,
      });
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/api/local/chatbot/events') {
      const conversationId = String(url.searchParams.get('conversationId') || '').trim();
      if (!conversationId) {
        return sendJson(res, 200, []);
      }
      const store = await readStore();
      const events = (Array.isArray(store.chatbotEvents) ? store.chatbotEvents : [])
        .filter((event) => String(event?.conversation_id || event?.conversationId || '') === conversationId)
        .sort((left, right) => Date.parse(left?.created_date || '') - Date.parse(right?.created_date || ''));
      return sendJson(res, 200, events);
    }

    if (req.method === 'GET' && url.pathname === '/api/local/chatbot/flows') {
      const store = await readStore();
      const flows = normalizeChatbotFlows(store.chatbotFlows);
      const summaryOnly = ['1', 'true', 'yes'].includes(String(url.searchParams.get('summary') || '').toLowerCase());
      return sendJson(res, 200, summaryOnly ? flows.map(sanitizeChatbotFlowSummaryForClient) : flows);
    }

    if (req.method === 'POST' && url.pathname === '/api/local/chatbot/flows') {
      const payload = await readBody(req);
      const timestamp = nowIso();
      let createdFlow = null;

      await updateStore((store) => {
        const flows = normalizeChatbotFlows(store.chatbotFlows);
        const code = getNextChatbotFlowCode(flows);
        createdFlow = normalizeChatbotFlow(
          {
            ...payload,
            id: `flow-${code}`,
            code,
            name: payload?.name || `Flow ${code}`,
            active: Boolean(payload?.active),
            state: normalizeChatbotFlowState(payload?.state),
            created_date: timestamp,
            updated_date: timestamp,
          },
          flows.length,
          code,
        );
        store.chatbotFlows = sortChatbotFlows([...flows, createdFlow]);
        return store;
      });

      return sendJson(res, 201, sanitizeChatbotFlowForClient(createdFlow));
    }

    if (req.method === 'POST' && url.pathname === '/api/local/chatbot/flows/import') {
      const payload = await readBody(req);
      const sourceFlow = payload?.flow && typeof payload.flow === 'object' ? payload.flow : payload;
      const timestamp = nowIso();
      let createdFlow = null;

      await updateStore((store) => {
        const flows = normalizeChatbotFlows(store.chatbotFlows);
        const code = getNextChatbotFlowCode(flows);
        createdFlow = normalizeChatbotFlow(
          {
            ...sourceFlow,
            id: `flow-${code}`,
            code,
            name: sourceFlow?.name || `Flow ${code}`,
            active: Boolean(sourceFlow?.active),
            state: normalizeChatbotFlowState(sourceFlow?.state || sourceFlow),
            created_date: timestamp,
            updated_date: timestamp,
          },
          flows.length,
          code,
        );
        store.chatbotFlows = sortChatbotFlows([...flows, createdFlow]);
        return store;
      });

      return sendJson(res, 201, sanitizeChatbotFlowForClient(createdFlow));
    }

    const chatbotFlowMatch = url.pathname.match(/^\/api\/local\/chatbot\/flows\/([^/]+)$/);
    if (chatbotFlowMatch) {
      const flowRef = chatbotFlowMatch[1];

      if (req.method === 'GET') {
        const store = await readStore();
        const flows = normalizeChatbotFlows(store.chatbotFlows);
        const index = resolveChatbotFlowIndex(flows, flowRef);
        if (index < 0) {
          return sendJson(res, 404, { error: 'Flow nao encontrado.' });
        }
        return sendJson(res, 200, sanitizeChatbotFlowForClient(flows[index]));
      }

      if (req.method === 'PUT') {
        const payload = await readBody(req);
        let updatedFlow = null;

        await updateStore((store) => {
          const flows = normalizeChatbotFlows(store.chatbotFlows);
          const index = resolveChatbotFlowIndex(flows, flowRef);
          if (index < 0) {
            return store;
          }

          updatedFlow = normalizeChatbotFlow(
            {
              ...flows[index],
              ...payload,
              id: flows[index].id,
              code: flows[index].code,
              name: payload?.name || flows[index].name,
              active: typeof payload?.active === 'boolean' ? payload.active : flows[index].active,
              state: normalizeChatbotFlowState(payload?.state || flows[index].state),
              created_date: flows[index].created_date,
              updated_date: nowIso(),
            },
            index,
            flows[index].code,
          );
          flows[index] = updatedFlow;
          store.chatbotFlows = sortChatbotFlows(flows);
          return store;
        });

        if (!updatedFlow) {
          return sendJson(res, 404, { error: 'Flow nao encontrado.' });
        }

        const summaryOnly = ['1', 'true', 'yes'].includes(String(url.searchParams.get('summary') || '').toLowerCase());
        return sendJson(res, 200, summaryOnly ? sanitizeChatbotFlowSummaryForClient(updatedFlow) : sanitizeChatbotFlowForClient(updatedFlow));
      }

      if (req.method === 'DELETE') {
        let removedFlow = null;

        await updateStore((store) => {
          const flows = normalizeChatbotFlows(store.chatbotFlows);
          const index = resolveChatbotFlowIndex(flows, flowRef);
          if (index < 0) {
            return store;
          }

          removedFlow = flows[index];
          store.chatbotFlows = flows.filter((_, currentIndex) => currentIndex !== index);
          return store;
        });

        if (!removedFlow) {
          return sendJson(res, 404, { error: 'Flow nao encontrado.' });
        }

        return sendJson(res, 200, { ok: true, id: removedFlow.id });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/local/newbr/browser-auth-config') {
      return sendJson(res, 200, getSharedNewbrBrowserAuthConfig());
    }

    if (req.method === 'POST' && url.pathname === '/api/local/newbr/tests') {
      const payload = await readBody(req);
      const conversationId = String(payload?.conversationId || '').trim();
      const whatsappStore = await readWhatsappStore();
      const whatsappConversations = Object.values(whatsappStore.conversations || {});
      const localStore = await readStore();
      const conversation =
        whatsappConversations.find((item) => String(item?.id || '') === conversationId) ||
        (Array.isArray(localStore.conversations) ? localStore.conversations : []).find((item) => String(item?.id || '') === conversationId) ||
        {};
      const result = await createNewbrTestForConversation({ conversation, payload });
      return sendJson(res, 200, {
        ...result,
        mode: 'server_direct',
      });
    }

    const newbrTestResultMatch = url.pathname.match(/^\/api\/local\/newbr\/tests\/([^/]+)\/result$/);
    if (req.method === 'POST' && newbrTestResultMatch) {
      const payload = await readBody(req);
      const result = await completeNewbrTestRequest({
        requestId: decodeURIComponent(newbrTestResultMatch[1]),
        raw: payload?.raw,
        error: payload?.error,
        success: payload?.success !== false,
      });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/local/newbr/tests/direct-result') {
      const payload = await readBody(req);
      const result = await completeDirectNewbrTestResult({ payload });
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/api/local/newbr/tests/active') {
      const conversationId = String(url.searchParams.get('conversationId') || '').trim();
      const phone = String(url.searchParams.get('phone') || '').trim();
      const store = await readStore();
      const session = findActiveNewbrTestSession(store, { conversationId, phone });
      if (!session) {
        return sendJson(res, 200, { active: false });
      }
      const expiresAtMs = Date.parse(session.expiresAt || '');
      const remainingSeconds = Number.isFinite(expiresAtMs) ? Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000)) : 0;
      return sendJson(res, 200, {
        active: true,
        id: session.id,
        status: session.status,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        remainingSeconds,
        username: session.username,
        provider: session.provider,
        url: session.url,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/local/tickets') {
      const store = await readStore();
      const tickets = filterTicketsForRequest(Array.isArray(store.tickets) ? store.tickets : [], url)
        .sort((left, right) => Date.parse(right.updated_at || right.created_at || '') - Date.parse(left.updated_at || left.created_at || ''));
      return sendJson(res, 200, {
        items: tickets.map(sanitizeTicketForClient),
        summary: buildTicketListSummary(tickets),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/tickets') {
      const payload = await readBody(req);
      const timestamp = nowIso();
      let createdTicket = null;

      if (!String(payload?.title || '').trim()) {
        return sendJson(res, 400, { error: 'Informe o titulo do chamado.' });
      }
      if (!String(payload?.conversation_id || payload?.conversationId || '').trim()) {
        return sendJson(res, 400, { error: 'Ticket precisa estar vinculado a uma conversa.' });
      }

      await updateStore((store) => {
        const tickets = Array.isArray(store.tickets) ? store.tickets : [];
        createdTicket = normalizeTicketForStorage(
          {
            ...payload,
            id: payload?.id || `ticket-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
            status: 'open',
            created_by: req.authContext?.user?.id || req.authContext?.user?.email || payload?.created_by || '',
            created_by_name: req.authContext?.user?.full_name || req.authContext?.user?.name || req.authContext?.user?.username || '',
            created_at: timestamp,
            updated_at: timestamp,
          },
          null,
          timestamp,
        );
        store.tickets = [createdTicket, ...tickets];
        return store;
      });

      return sendJson(res, 201, sanitizeTicketForClient(createdTicket));
    }

    const ticketConversationMatch = url.pathname.match(/^\/api\/local\/tickets\/conversation\/([^/]+)$/);
    if (req.method === 'GET' && ticketConversationMatch) {
      const conversationId = decodeURIComponent(ticketConversationMatch[1] || '');
      const store = await readStore();
      const tickets = (Array.isArray(store.tickets) ? store.tickets : [])
        .filter((ticket) => getTicketMatchesConversation(ticket, conversationId))
        .sort((left, right) => Date.parse(right.updated_at || right.created_at || '') - Date.parse(left.updated_at || left.created_at || ''));
      return sendJson(res, 200, {
        tickets: tickets.map(sanitizeTicketForClient),
        summary: buildTicketConversationSummary(tickets),
      });
    }

    const ticketCommentMatch = url.pathname.match(/^\/api\/local\/tickets\/([^/]+)\/comments$/);
    if (req.method === 'POST' && ticketCommentMatch) {
      const ticketId = decodeURIComponent(ticketCommentMatch[1] || '');
      const payload = await readBody(req);
      let updatedTicket = null;
      await updateStore((store) => {
        const tickets = Array.isArray(store.tickets) ? store.tickets : [];
        const index = tickets.findIndex((ticket) => String(ticket.id) === ticketId);
        if (index < 0) return store;
        updatedTicket = addTicketComment(tickets[index], payload, req.authContext?.user, nowIso());
        tickets[index] = updatedTicket;
        store.tickets = tickets;
        return store;
      });
      if (!updatedTicket) return sendJson(res, 404, { error: 'Ticket nao encontrado.' });
      return sendJson(res, 201, sanitizeTicketForClient(updatedTicket));
    }

    const ticketAttachmentMatch = url.pathname.match(/^\/api\/local\/tickets\/([^/]+)\/attachments$/);
    if (req.method === 'POST' && ticketAttachmentMatch) {
      const ticketId = decodeURIComponent(ticketAttachmentMatch[1] || '');
      const payload = await readBody(req);
      let updatedTicket = null;
      await updateStore((store) => {
        const tickets = Array.isArray(store.tickets) ? store.tickets : [];
        const index = tickets.findIndex((ticket) => String(ticket.id) === ticketId);
        if (index < 0) return store;
        updatedTicket = addTicketAttachment(tickets[index], payload, nowIso());
        tickets[index] = updatedTicket;
        store.tickets = tickets;
        return store;
      });
      if (!updatedTicket) return sendJson(res, 404, { error: 'Ticket nao encontrado.' });
      return sendJson(res, 201, sanitizeTicketForClient(updatedTicket));
    }

    const ticketItemMatch = url.pathname.match(/^\/api\/local\/tickets\/([^/]+)$/);
    if (ticketItemMatch) {
      const ticketId = decodeURIComponent(ticketItemMatch[1] || '');

      if (req.method === 'GET') {
        const store = await readStore();
        const ticket = (Array.isArray(store.tickets) ? store.tickets : []).find((item) => String(item.id) === ticketId);
        if (!ticket) return sendJson(res, 404, { error: 'Ticket nao encontrado.' });
        return sendJson(res, 200, sanitizeTicketForClient(ticket));
      }

      if (req.method === 'PATCH') {
        const payload = await readBody(req);
        let updatedTicket = null;
        await updateStore((store) => {
          const tickets = Array.isArray(store.tickets) ? store.tickets : [];
          const index = tickets.findIndex((ticket) => String(ticket.id) === ticketId);
          if (index < 0) return store;
          const timestamp = nowIso();
          const requestedStatus = normalizeTicketStatus(payload?.status, normalizeTicketStatus(tickets[index].status));
          const currentStatus = normalizeTicketStatus(tickets[index].status);
          const resolutionNote = String(payload?.resolution_note || payload?.resolutionNote || '').trim();
          if (requestedStatus === 'resolved' && currentStatus !== 'resolved' && !resolutionNote) {
            throw new SyncError('Informe a tratativa antes de finalizar o ticket.', 400, 'missing_ticket_resolution_note');
          }
          const ticketWithResolutionNote = resolutionNote
            ? addTicketComment(tickets[index], { content: resolutionNote }, req.authContext?.user, timestamp)
            : tickets[index];
          updatedTicket = normalizeTicketForStorage(
            {
              ...ticketWithResolutionNote,
              ...payload,
              id: tickets[index].id,
              resolved_by: requestedStatus === 'resolved'
                ? req.authContext?.user?.id || req.authContext?.user?.email || payload?.resolved_by || ticketWithResolutionNote.resolved_by || ''
                : '',
              resolved_by_name: requestedStatus === 'resolved'
                ? req.authContext?.user?.full_name || req.authContext?.user?.name || req.authContext?.user?.username || payload?.resolved_by_name || ticketWithResolutionNote.resolved_by_name || ''
                : '',
              updated_at: timestamp,
            },
            ticketWithResolutionNote,
            timestamp,
          );
          tickets[index] = updatedTicket;
          store.tickets = tickets;
          return store;
        });
        if (!updatedTicket) return sendJson(res, 404, { error: 'Ticket nao encontrado.' });
        return sendJson(res, 200, sanitizeTicketForClient(updatedTicket));
      }
    }

    const entityFilterMatch = url.pathname.match(/^\/api\/local\/entities\/([A-Za-z]+)\/filter$/);
    if (req.method === 'GET' && entityFilterMatch) {
      const entityName = entityFilterMatch[1];
      const collectionName = getCollectionName(entityName);
      if (!collectionName) return sendJson(res, 404, { error: 'Entity not found' });
      const store = await readStore();
      const items = Array.isArray(store[collectionName]) ? store[collectionName] : [];
      const filters = Object.fromEntries(url.searchParams.entries());
      const sortBy = filters.sort || '';
      const limit = filters.limit || '';
      delete filters.sort;
      delete filters.limit;
      const filtered = items.filter((item) =>
        Object.entries(filters).every(([key, value]) => String(item?.[key] ?? '') === String(value)),
      );
      return sendJson(res, 200, stripSensitiveEntity(entityName, applyLimit(sortItems(filtered, sortBy), limit)));
    }

    const entityCollectionMatch = url.pathname.match(/^\/api\/local\/entities\/([A-Za-z]+)$/);
    if (entityCollectionMatch) {
      const entityName = entityCollectionMatch[1];
      const collectionName = getCollectionName(entityName);
      if (!collectionName) return sendJson(res, 404, { error: 'Entity not found' });

      if (req.method === 'GET') {
        const store = await readStore();
        const items = Array.isArray(store[collectionName]) ? store[collectionName] : [];
        const sortBy = url.searchParams.get('sort') || '';
        const limit = url.searchParams.get('limit') || '';
        return sendJson(res, 200, stripSensitiveEntity(entityName, applyLimit(sortItems(items, sortBy), limit)));
      }

      if (req.method === 'POST') {
        const payload = await readBody(req);
        const timestamp = nowIso();
        let createdItem = null;
        let createdAction = 'created';
        let createdStatus = 201;

        await updateStore((store) => {
          const items = Array.isArray(store[collectionName]) ? store[collectionName] : [];
          if (
            entityName === 'QuickReplySchedule' &&
            items.some(
              (item) =>
                String(item?.status || '') === 'pending' &&
                String(item?.conversationId || '') === String(payload?.conversationId || '') &&
                String(item?.quickReplyId || '') === String(payload?.quickReplyId || '') &&
                String(item?.scheduledAt || '') === String(payload?.scheduledAt || ''),
            )
          ) {
            throw new SyncError('Já existe um agendamento pendente idêntico para esta conversa.', 409, 'duplicate_quick_reply_schedule');
          }
          if (entityName === 'ConversationPreference') {
            const result = upsertConversationPreferenceInItems(items, payload, {
              itemId: payload?.conversation_id || payload?.id || '',
              timestamp,
            });
            createdItem = result.item;
            createdAction = result.existed ? 'updated' : 'created';
            createdStatus = result.existed ? 200 : 201;
            store[collectionName] = result.items;
            return store;
          }

          createdItem =
            entityName === 'Service'
              ? normalizeService(
                  {
                    ...payload,
                    id: createId(entityName, payload),
                    created_date: payload?.created_date || timestamp,
                    updated_date: timestamp,
                  },
                  items.length,
                )
              : entityName === 'User'
                ? prepareUserForStorage(
                    {
                      ...payload,
                      id: createId(entityName, payload),
                    },
                    null,
                    timestamp,
                  )
              : entityName === 'QuickReplySchedule'
                ? normalizeQuickReplyScheduleForStorage(
                    {
                      ...payload,
                      id: createId(entityName, payload),
                    },
                    null,
                    timestamp,
                  )
              : {
                  id: createId(entityName, payload),
                  ...payload,
                  created_date: payload?.created_date || timestamp,
                  updated_date: timestamp,
                };
          store[collectionName] = [createdItem, ...items];
          return store;
        });

        if (entityName === 'ConversationPreference') {
          if (String(createdItem?.resolution_status || '').trim() === 'resolved') {
            await clearWhatsappConversationAssignment([
              createdItem.conversation_id,
              ...(Array.isArray(payload?.sourceConversationIds) ? payload.sourceConversationIds : []),
            ]);
          }
          publishConversationPreferenceEvent(createdItem, createdAction);
        }

        return sendJson(res, createdStatus, stripSensitiveEntity(entityName, createdItem));
      }
    }

    const entityItemMatch = url.pathname.match(/^\/api\/local\/entities\/([A-Za-z]+)\/([^/]+)$/);
    if (entityItemMatch) {
      const entityName = entityItemMatch[1];
      const itemId = entityItemMatch[2];
      const collectionName = getCollectionName(entityName);
      if (!collectionName) return sendJson(res, 404, { error: 'Entity not found' });

      if (req.method === 'PUT') {
        const payload = await readBody(req);
        let updatedItem = null;
        let passwordChanged = false;
        let nextConversationPreferenceItems = null;

        const store = await updateStore((current) => {
          const items = Array.isArray(current[collectionName]) ? current[collectionName] : [];
          const index = findEntityItemIndex(items, entityName, itemId, payload || {});
          if (index < 0) return current;

          if (entityName === 'ConversationPreference') {
            const result = upsertConversationPreferenceInItems(items, payload || {}, {
              itemId,
              timestamp: nowIso(),
            });
            updatedItem = result.item;
            nextConversationPreferenceItems = result.items;
          } else {
            updatedItem =
              entityName === 'Service'
              ? normalizeService(
                  {
                    ...mergeEntity(items[index], payload || {}),
                    id: items[index]?.id || itemId,
                    created_date: items[index]?.created_date || payload?.created_date || nowIso(),
                  },
                  index,
                )
              : entityName === 'User'
                ? prepareUserForStorage(
                    {
                      ...payload,
                      id: items[index]?.id || itemId,
                    },
                    items[index],
                    nowIso(),
                  )
              : entityName === 'QuickReplySchedule'
                ? normalizeQuickReplyScheduleForStorage(
                    {
                      ...payload,
                      id: items[index]?.id || itemId,
                    },
                    items[index],
                    nowIso(),
                  )
              : mergeEntity(items[index], payload || {});
          }
          passwordChanged = entityName === 'User' && Boolean(String(payload?.password || '').trim());
          if (entityName === 'ConversationPreference') {
            current[collectionName] = nextConversationPreferenceItems || items;
          } else {
            items[index] = updatedItem;
            current[collectionName] = items;
          }
          if (passwordChanged) {
            current.auth = pruneAuthState(current.auth);
            current.auth.sessions = current.auth.sessions.filter((session) => session.user_id !== String(updatedItem?.id || ''));
          }
          return current;
        });

        if (!updatedItem) {
          return sendJson(res, 404, { error: 'Item not found' });
        }

        if (passwordChanged && updatedItem?.id) {
          deleteSqlAuthSessionsByUserId(updatedItem.id);
        }

        if (entityName === 'ConversationPreference') {
          if (String(updatedItem?.resolution_status || '').trim() === 'resolved') {
            await clearWhatsappConversationAssignment([
              updatedItem.conversation_id,
              ...(Array.isArray(payload?.sourceConversationIds) ? payload.sourceConversationIds : []),
            ]);
          }
          publishConversationPreferenceEvent(updatedItem, 'updated');
        }

        return sendJson(res, 200, stripSensitiveEntity(entityName, updatedItem));
      }

      if (req.method === 'DELETE') {
        const store = await readStore();
        const items = Array.isArray(store[collectionName]) ? store[collectionName] : [];
        const index = items.findIndex((item) => String(item?.id) === String(itemId));
        if (index < 0) return sendJson(res, 404, { error: 'Item not found' });

        await updateStore((current) => {
          current[collectionName] = (Array.isArray(current[collectionName]) ? current[collectionName] : []).filter(
            (item) => String(item?.id) !== String(itemId),
          );
          if (entityName === 'User') {
            current.auth = pruneAuthState(current.auth);
            current.auth.sessions = current.auth.sessions.filter((session) => session.user_id !== String(itemId));
          }
          return current;
        });

        if (entityName === 'User') {
          deleteSqlAuthSessionsByUserId(itemId);
        }

        return sendJson(res, 200, { ok: true });
      }
    }

    return sendJson(res, 404, { error: 'Route not found' });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return sendJson(res, 400, { error: 'JSON invalido na requisicao.' });
    }

    if (error instanceof SyncError) {
      return sendJson(
        res,
        error.status || 500,
        {
          error: error.message,
          code: error.code,
          payload: error.payload,
        },
        error.status === 401 ? { 'Set-Cookie': buildExpiredSessionCookie(req) } : undefined,
      );
    }

    return sendJson(res, 500, { error: error?.message || 'Internal server error' });
  }
});

const initializeLocalApiRuntime = async ({ httpEnabled = true } = {}) => {
  await ensureStore();
  if (httpEnabled && !IS_AUTH_API_ROLE) {
    await recoverCustomerSyncStateOnBoot();
    scheduleChatbotBackendRuntime();
  }
  initializeRoutineScheduler();
  initializeRoutineDispatchQueueWorker();
  initializeQuickReplyScheduleScheduler();
  initializeAssignmentRecoveryWorker();
  if (httpEnabled && !IS_AUTH_API_ROLE) {
    initializeNewbrTestSessionScheduler();
  }
};

if (LOCAL_API_HTTP_ENABLED) {
  server.listen(PORT, '127.0.0.1', async () => {
    await initializeLocalApiRuntime({ httpEnabled: true });
    log(`listening on http://127.0.0.1:${PORT}`);
  });
} else {
  await initializeLocalApiRuntime({ httpEnabled: false });
  log(`HTTP disabled for role=${LOCAL_API_RUNTIME_ROLE || 'worker'}; background workers active`);
}

const shutdownLocalApi = (signal) => {
  log(`shutdown requested by ${signal}`);
  stopAllSchedulers();
  if (newbrTestSessionSchedulerTimer) {
    clearInterval(newbrTestSessionSchedulerTimer);
    newbrTestSessionSchedulerTimer = null;
  }
  if (!LOCAL_API_HTTP_ENABLED) {
    process.exit(0);
    return;
  }
  server.close(() => {
    process.exit(0);
  });
};

process.once('SIGINT', () => shutdownLocalApi('SIGINT'));
process.once('SIGTERM', () => shutdownLocalApi('SIGTERM'));
