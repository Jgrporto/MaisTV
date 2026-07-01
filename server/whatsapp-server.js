import "dotenv/config";































import http from "node:http";































import { URL } from "node:url";































import fs from "node:fs/promises";































import path from "node:path";































import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { spawn, spawnSync } from "node:child_process";































import { fetchPainelCustomer, fetchPainelCustomersByDueDate, fetchPainelPlaylist, syncPainelCustomers } from "./painel-newbr.js";
import { readJsonBackedStore, writeJsonBackedStore } from "./sql-store.js";
import {
  getWhatsappSqliteConversation,
  isWhatsappSqliteStoreEnabled,
  listWhatsappSqliteConversations,
  listWhatsappSqliteConversationsByPhone,
  listWhatsappSqliteMessages,
  markWhatsappSqliteConversationRead,
  readWhatsappSqliteStore,
  writeWhatsappSqliteStore,
} from "./whatsapp-sqlite-store.js";
import { queryWhatsappHistoryMessages } from "./whatsapp-history-store.js";
import {
  normalizeTemplateMediaUrl,
  resolveTemplateMediaPublicOrigin as resolveConfiguredTemplateMediaPublicOrigin,
} from "./template-media-url.js";
import {
  addContactLabelsById,
  clearContactLabelsById,
  createLabel as createContactLabel,
  deleteLabelById,
  ensureLabelsReady,
  getContactLabelsById,
  getDefaultLabelsRefreshIntervalMs,
  listLabelContacts,
  listLabels,
  listResolvedContacts,
  removeContactLabelsById,
  replaceContactManualLabels,
  resolveConversationLabels,
  syncContactsSnapshot,
  updateLabelById,
} from "./labels-store.js";
import {
  createCampaign as createCampaignDefinition,
  deleteCampaignById,
  getCampaignById,
  listCampaigns,
  updateCampaignById,
} from "./campaigns-store.js";
import { getOptionalPaginationFromSearchParams, paginateItems } from "./middlewares/pagination.mjs";
import { attachSlowRouteLogger } from "./middlewares/slow-route-logger.mjs";
import {
  finishPerfMeasure,
  logPerf,
  parsePositiveInt,
  shouldLogDuration,
  startPerfMeasure,
} from "./utils/perf-log.mjs";
import {
  getAudioTranscriptionStatus,
  isProcessingTranscriptionFresh,
  transcribeAudioMessage,
} from "./audio-transcription-service.js";
import {
  claimFlowRun,
  closeFlowSession,
  completeFlowRun,
  createFlow,
  deleteFlowById,
  ensureFlowStoreReady,
  findMatchingFlowForText,
  getActiveFlowSession,
  isFlowStoreEnabled,
  listFlowRunsByConversation,
  listFlows,
  saveFlowSession,
  updateFlowById,
} from "./flow-store.js";
import { buildFlowExecutionPlan } from "./flow-engine.js";
import { buildInboxSectionPayload } from "./inbox-sections.js";
import { listSqlAttendancePresence } from "./modules/attendance/presence-store.js";
import { acceptMetaWebhook } from "./services/meta-webhook.service.mjs";

const parseBooleanEnv = (value, defaultValue = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === "true" || normalized === "1" || normalized === "yes";
};

const RUNTIME_ROLE = String(process.env.MAISTV_RUNTIME_ROLE || "").trim().toLowerCase();
const IS_WORKER_ROLE = RUNTIME_ROLE === "worker";
const WHATSAPP_HTTP_ENABLED = parseBooleanEnv(process.env.WHATSAPP_HTTP_ENABLED, !IS_WORKER_ROLE);
const WHATSAPP_SCHEDULERS_ENABLED = parseBooleanEnv(process.env.WHATSAPP_SCHEDULERS_ENABLED, IS_WORKER_ROLE);
const WHATSAPP_HTTP_ROLE = String(process.env.WHATSAPP_HTTP_ROLE || "all").trim().toLowerCase();
const SUPPORT_FLOW_EXECUTION_ENABLED = parseBooleanEnv(process.env.SUPPORT_FLOW_EXECUTION_ENABLED, true);
const CHAT_MIRROR_META_WEBHOOK_ENABLED = parseBooleanEnv(process.env.CHAT_MIRROR_META_WEBHOOK_ENABLED, false);
const WHATSAPP_WEBHOOK_CHAT_ONLY = parseBooleanEnv(process.env.WHATSAPP_WEBHOOK_CHAT_ONLY, false);

const mirrorMetaWebhookToChatArchitecture = ({ rawBody, payload, routeKey }) => {
  if (!CHAT_MIRROR_META_WEBHOOK_ENABLED) return;
  void acceptMetaWebhook({ rawBody, payload })
    .then((result) => console.log(`[chat-mirror] route=${routeKey || "default"} accepted=true duplicate=${Boolean(result?.duplicate)}`))
    .catch((error) => console.error(`[chat-mirror] route=${routeKey || "default"} failed:`, error?.message || error));
};
const WEBHOOK_SLOW_PROCESSING_THRESHOLD_MS = Math.max(
  250,
  Number.parseInt(process.env.WEBHOOK_SLOW_PROCESSING_THRESHOLD_MS || "1500", 10) || 1500,
);

let supportFlowStoreDisabledLogged = false;

const shouldExecuteSupportFlows = () => SUPPORT_FLOW_EXECUTION_ENABLED && isFlowStoreEnabled();

const logSupportFlowStoreDisabledOnce = () => {
  if (supportFlowStoreDisabledLogged) return;
  supportFlowStoreDisabledLogged = true;
  console.warn(
    "[flow] support execution disabled: SQL_STORE_DATABASE_URL/DATABASE_URL is not configured",
  );
};























































const PORT = Number.parseInt(process.env.WHATSAPP_SERVER_PORT || "5050", 10);
const HOST = String(process.env.WHATSAPP_SERVER_HOST || "127.0.0.1").trim() || "127.0.0.1";































const API_VERSION = process.env.WHATSAPP_API_VERSION || "v19.0";































const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;































const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;































const DEFAULT_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME;































const DEFAULT_LANGUAGE = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "pt_BR";































const ALLOWED_ORIGIN = process.env.WHATSAPP_ALLOWED_ORIGIN || "*";































const STORE_PATH = process.env.WHATSAPP_STORE_PATH || "server/data/whatsapp-store.json";
const WHATSAPP_STORE_CACHE_TTL_MS = Number.parseInt(
  process.env.WHATSAPP_STORE_CACHE_TTL_MS || "15000",
  10,
);
const ATTENDANCE_PRESENCE_TTL_MS = Number.parseInt(
  process.env.ATTENDANCE_PRESENCE_TTL_MS || `${3 * 60 * 1000}`,
  10,
);
const ASSIGNMENT_OFFLINE_REQUEUE_GRACE_MS = (() => {
  const parsed = Number.parseInt(
    process.env.ASSIGNMENT_OFFLINE_REQUEUE_GRACE_MS || `${5 * 60 * 1000}`,
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : ATTENDANCE_PRESENCE_TTL_MS;
})();
const ASSIGNMENT_QUEUE_SCHEDULER_INTERVAL_MS = Number.parseInt(
  process.env.ASSIGNMENT_QUEUE_SCHEDULER_INTERVAL_MS || "30000",
  10,
);































const WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
const WHATSAPP_DISPLAY_PHONE_NUMBER = process.env.WHATSAPP_DISPLAY_PHONE_NUMBER || "";
const WHATSAPP_DEFAULT_WEBHOOK_PATH = "/api/whatsapp/webhook";
const WHATSAPP_VENDAS_PHONE_NUMBER_ID = process.env.WHATSAPP_VENDAS_PHONE_NUMBER_ID || "";
const WHATSAPP_VENDAS_ACCESS_TOKEN = process.env.WHATSAPP_VENDAS_ACCESS_TOKEN || "";
const WHATSAPP_VENDAS_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_VENDAS_WEBHOOK_VERIFY_TOKEN || "";
const WHATSAPP_VENDAS_APP_SECRET = process.env.WHATSAPP_VENDAS_APP_SECRET || "";
const WHATSAPP_VENDAS_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_VENDAS_BUSINESS_ACCOUNT_ID || "";
const WHATSAPP_VENDAS_DISPLAY_PHONE_NUMBER = process.env.WHATSAPP_VENDAS_DISPLAY_PHONE_NUMBER || "";
const WHATSAPP_VENDAS_WEBHOOK_PATH = String(
  process.env.WHATSAPP_VENDAS_WEBHOOK_PATH || "/api/whatsapp/webhook-vendas",
)
  .trim()
  .startsWith("/")
  ? String(process.env.WHATSAPP_VENDAS_WEBHOOK_PATH || "/api/whatsapp/webhook-vendas").trim()
  : `/${String(process.env.WHATSAPP_VENDAS_WEBHOOK_PATH || "api/whatsapp/webhook-vendas").trim()}`;
const WHATSAPP_VENDAS2_PHONE_NUMBER_ID = process.env.WHATSAPP_VENDAS2_PHONE_NUMBER_ID || "";
const WHATSAPP_VENDAS2_ACCESS_TOKEN = process.env.WHATSAPP_VENDAS2_ACCESS_TOKEN || "";
const WHATSAPP_VENDAS2_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_VENDAS2_WEBHOOK_VERIFY_TOKEN || "";
const WHATSAPP_VENDAS2_APP_SECRET = process.env.WHATSAPP_VENDAS2_APP_SECRET || "";
const WHATSAPP_VENDAS2_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_VENDAS2_BUSINESS_ACCOUNT_ID || "";
const WHATSAPP_VENDAS2_DISPLAY_PHONE_NUMBER = process.env.WHATSAPP_VENDAS2_DISPLAY_PHONE_NUMBER || "";
const WHATSAPP_VENDAS2_WEBHOOK_PATH = String(
  process.env.WHATSAPP_VENDAS2_WEBHOOK_PATH || "/api/whatsapp/webhook-vendas2",
)
  .trim()
  .startsWith("/")
  ? String(process.env.WHATSAPP_VENDAS2_WEBHOOK_PATH || "/api/whatsapp/webhook-vendas2").trim()
  : `/${String(process.env.WHATSAPP_VENDAS2_WEBHOOK_PATH || "api/whatsapp/webhook-vendas2").trim()}`;































const TEMPLATE_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WHATSAPP_TEMPLATE_NAMESPACE;































const BAILEYS_API_URL = process.env.WHATSAPP_BAILEYS_API_URL || "";

const shouldProxyToBaileys = (url) => {
  if (!BAILEYS_API_URL) return false;
  return url.pathname.startsWith("/api/whatsapp/baileys");
};

const proxyBaileysRequest = async (req, res, url) => {
  if (!BAILEYS_API_URL) {
    throw new Error("Baileys API URL not configured");
  }

  const rewrittenPath = url.pathname.startsWith("/api/whatsapp/baileys")
    ? `/api/whatsapp${url.pathname.slice("/api/whatsapp/baileys".length)}`
    : url.pathname;
  const targetSearch = new URLSearchParams(url.search);
  const requestedLabelIds =
    rewrittenPath === "/api/whatsapp/conversations"
      ? normalizeRequestedLabelIds(targetSearch.get("labels"))
      : [];
  if (rewrittenPath === "/api/whatsapp/conversations") {
    targetSearch.delete("labels");
  }
  const target = new URL(`${BAILEYS_API_URL}${rewrittenPath}`);
  if (targetSearch.toString()) {
    target.search = targetSearch.toString();
  }
  const method = req.method || "GET";
  const headers = { ...req.headers };
  delete headers.host;

  const body =
    method === "GET" || method === "HEAD" ? undefined : await readBuffer(req);

  const response = await fetch(target, {
    method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });

  setCors(res);
  const contentType = response.headers.get("content-type");
  if (
    rewrittenPath === "/api/whatsapp/conversations" &&
    response.ok &&
    contentType &&
    contentType.includes("application/json")
  ) {
    const payload = await response.text();
    const parsed = parseLenientJson(payload);
    const painelStore = await readPainelStore();
    const painelCustomers = painelStore?.customers || {};
    const conversations = await enrichConversationsWithLabels(
      Array.isArray(parsed) ? parsed : [],
      painelCustomers,
      requestedLabelIds,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(conversations));
    return;
  }
  const responseHeaders = {};
  if (contentType) {
    responseHeaders["Content-Type"] = contentType;
  }
  res.writeHead(response.status, responseHeaders);
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
};






























const PAINEL_CUSTOMERS_PATH = process.env.PANEL_NEWBR_CUSTOMERS_PATH || "server/data/painel-customers.json";
const PERSISTED_CUSTOMERS_STORE_PATH =
  process.env.PERSISTED_CUSTOMERS_STORE_PATH || "server/data/store.json";































const PAINEL_SYNC_STATE_PATH = process.env.PANEL_NEWBR_SYNC_STATE_PATH || "server/data/painel-sync.json";
const PAINEL_MISSING_REPORT_PATH =
  process.env.PANEL_MISSING_REPORT_PATH || "server/data/painel-missing-report.json";































const PAINEL_SYNC_LOG_LIMIT = Number.parseInt(process.env.PANEL_NEWBR_SYNC_LOG_LIMIT || "500", 10);































const PAINEL_RAW_URL = process.env.PANEL_NEWBR_URL || "https://painel.newbr.top/#/customers";































const COEXISTENCE_PATH = process.env.WHATSAPP_COEXISTENCE_PATH || "server/data/whatsapp-coexistencia.json";































const CHECKOUT_TOKEN_STORE_PATH = process.env.CHECKOUT_TOKEN_STORE_PATH || "server/data/checkout-tokens.json";
const CHECKOUT_RENEW_LOG_PATH = process.env.CHECKOUT_RENEW_LOG_PATH || "server/data/painel-renew-log.json";
const CHECKOUT_RENEW_LOG_LIMIT = Number.parseInt(process.env.CHECKOUT_RENEW_LOG_LIMIT || "300", 10);
const MESSAGE_DELIVERY_LOG_PATH =
  process.env.MESSAGE_DELIVERY_LOG_PATH || "server/data/message-delivery-log.json";
const MESSAGE_DELIVERY_LOG_LIMIT = Number.parseInt(
  process.env.MESSAGE_DELIVERY_LOG_LIMIT || "2000",
  10,
);
const WHATSAPP_TEMPLATE_MEDIA_DIR =
  process.env.WHATSAPP_TEMPLATE_MEDIA_DIR || "server/data/whatsapp-template-media";
const WHATSAPP_TEMPLATE_MEDIA_PUBLIC_ORIGIN = String(
  process.env.WHATSAPP_TEMPLATE_MEDIA_PUBLIC_ORIGIN || "",
).trim();
const TEMPLATE_MEDIA_PUBLIC_API_BASE_URL = String(
  process.env.VITE_WHATSAPP_API_BASE_URL || process.env.VITE_API_BASE_URL || "",
).trim();
const WHATSAPP_TEMPLATE_MEDIA_MAX_MB = Number.parseInt(
  process.env.WHATSAPP_TEMPLATE_MEDIA_MAX_MB || "10",
  10,
);































const CHECKOUT_TOKEN_TTL_HOURS = Number.parseInt(process.env.CHECKOUT_TOKEN_TTL_HOURS || "72", 10);







const CHECKOUT_PUBLIC_URL = process.env.CHECKOUT_PUBLIC_URL || process.env.VITE_CHECKOUT_PUBLIC_URL || "";
const ROUTINES_STORE_PATH = process.env.ROUTINES_STORE_PATH || "server/data/routines.json";
const ROUTINE_LOG_STORE_PATH = process.env.ROUTINE_LOG_STORE_PATH || "server/data/routine-logs.json";
const SCHEDULED_MESSAGES_STORE_PATH =
  process.env.SCHEDULED_MESSAGES_STORE_PATH || "server/data/scheduled-messages.json";
const LABEL_CAMPAIGN_STATE_PATH =
  process.env.LABEL_CAMPAIGN_STATE_PATH || "server/data/label-campaign-state.json";
const ROUTINE_LOG_LIMIT = Number.parseInt(process.env.ROUTINE_LOG_LIMIT || "1000", 10);
const ROUTINE_SCHEDULER_INTERVAL_MS = Number.parseInt(
  process.env.ROUTINE_SCHEDULER_INTERVAL_MS || "15000",
  10,
);
const SCHEDULED_MESSAGES_SCHEDULER_INTERVAL_MS = Number.parseInt(
  process.env.SCHEDULED_MESSAGES_SCHEDULER_INTERVAL_MS || "15000",
  10,
);
const LABEL_CAMPAIGN_SCHEDULER_INTERVAL_MS = Number.parseInt(
  process.env.LABEL_CAMPAIGN_SCHEDULER_INTERVAL_MS || "60000",
  10,
);
const DEFAULT_ROUTINE_TIMEZONE = "America/Sao_Paulo";
const ROUTINE_DEFAULT_SEND_INTERVAL_SECONDS = Number.parseInt(
  process.env.ROUTINE_DEFAULT_SEND_INTERVAL_SECONDS || "12",
  10,
);
const ROUTINE_MIN_SEND_INTERVAL_SECONDS = Number.parseInt(
  process.env.ROUTINE_MIN_SEND_INTERVAL_SECONDS || "3",
  10,
);
const ROUTINE_MAX_SEND_INTERVAL_SECONDS = Number.parseInt(
  process.env.ROUTINE_MAX_SEND_INTERVAL_SECONDS || "120",
  10,
);
const ROUTINE_RENOVADOS_ERRADO_VALIDATION_ENABLED = parseBooleanEnv(
  process.env.ROUTINE_RENOVADOS_ERRADO_VALIDATION_ENABLED,
  false,
);
const ROUTINE_RENOVADOS_ERRADO_LABEL_NAME = String(
  process.env.ROUTINE_RENOVADOS_ERRADO_LABEL_NAME || "RENOVADOS ERRADO",
).trim();
const CHECKOUT_PLAN_MAP = {
  1: { packageId: "BV4D3rLaqZ", planLabel: "[1 MES] COMPLETO" },
  2: { packageId: "EMeWepDnN9", planLabel: "[2 MESES] COMPLETO" },
  3: { packageId: "bOxLAQLZ7a", planLabel: "[3 MESES] COMPLETO" },
};
const sanitizeCheckoutPlanMonths = (value) => {
  const parsed = Number(value);
  if (parsed === 1 || parsed === 2 || parsed === 3) return parsed;
  return null;
};
const resolveCheckoutPlanConfig = (value) => {
  const months = sanitizeCheckoutPlanMonths(value) || 1;
  return { months, ...CHECKOUT_PLAN_MAP[months] };
};

const PANEL_AGENT_BROKER_URL = (
  process.env.PANEL_AGENT_BROKER_URL || "http://127.0.0.1:5052"
).replace(/\/$/, "");
const LOCAL_CHATBOT_API_BASE_URL = (
  process.env.LOCAL_CHATBOT_API_BASE_URL || "http://127.0.0.1:5053"
).replace(/\/$/, "");
const LOCAL_REALTIME_API_BASE_URL = (
  process.env.LOCAL_REALTIME_API_BASE_URL || process.env.LOCAL_CHATBOT_API_BASE_URL || "http://127.0.0.1:5053"
).replace(/\/$/, "");
const LOCAL_CHATBOT_TIMEOUT_MS = Number.parseInt(
  process.env.LOCAL_CHATBOT_TIMEOUT_MS || "10000",
  10,
);
const LOCAL_REALTIME_TIMEOUT_MS = Number.parseInt(
  process.env.LOCAL_REALTIME_TIMEOUT_MS || "3000",
  10,
);
const LOCAL_REALTIME_RETRY_ATTEMPTS = Math.max(
  0,
  Number.parseInt(process.env.LOCAL_REALTIME_RETRY_ATTEMPTS || "1", 10) || 0,
);
const LOCAL_REALTIME_RETRY_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.LOCAL_REALTIME_RETRY_DELAY_MS || "250", 10) || 0,
);
const PANEL_AGENT_TOKEN = String(
  process.env.PANEL_AGENT_TOKEN || process.env.PANEL_AGENT_BROKER_TOKEN || "",
).trim();
const PANEL_AGENT_PLAYLIST_TIMEOUT_MS = Number.parseInt(
  process.env.PANEL_AGENT_PLAYLIST_TIMEOUT_MS || "120000",
  10,
);
const PANEL_AGENT_PLAYLIST_POLL_MS = Number.parseInt(
  process.env.PANEL_AGENT_PLAYLIST_POLL_MS || "1500",
  10,
);































const PAINEL_LOG_URL = PAINEL_RAW_URL.includes("#/customers")































  ? PAINEL_RAW_URL































  : `${PAINEL_RAW_URL.replace(/\/+$/, "")}/#/customers`;































































const storePath = path.resolve(process.cwd(), STORE_PATH);































const coexPath = path.resolve(process.cwd(), COEXISTENCE_PATH);































const checkoutTokenPath = path.resolve(process.cwd(), CHECKOUT_TOKEN_STORE_PATH);
const checkoutRenewLogPath = path.resolve(process.cwd(), CHECKOUT_RENEW_LOG_PATH);
const messageDeliveryLogPath = path.resolve(process.cwd(), MESSAGE_DELIVERY_LOG_PATH);
const safeReadJsonFile = async (filePath, fallback) => {
  const readFromJsonFile = async () => {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : fallback;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return fallback;
      }
      const suffix = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        await fs.rename(filePath, filePath + ".corrupt-" + suffix);
      } catch {
        // ignore
      }
      return fallback;
    }
  };

  return readJsonBackedStore(filePath, fallback, readFromJsonFile);
};

const atomicWriteJson = async (filePath, data) => {
  const writeToJsonFile = async () => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = filePath + ".tmp-" + process.pid + "-" + Date.now();
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
    await fs.rename(tmpPath, filePath);
  };

  await writeJsonBackedStore(filePath, data, writeToJsonFile);
};

const emptyCheckoutTokenStore = () => ({
  updatedAt: null,
  tokens: {},
});

const readCheckoutTokenStore = async () => {
  const data = await safeReadJsonFile(checkoutTokenPath, emptyCheckoutTokenStore());
  if (!data || typeof data !== "object") return emptyCheckoutTokenStore();
  const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : {};
  return { ...emptyCheckoutTokenStore(), ...data, tokens };
};

const writeCheckoutTokenStore = async (store) => {
  const next = store && typeof store === "object" ? store : emptyCheckoutTokenStore();
  const tokens = next.tokens && typeof next.tokens === "object" ? next.tokens : {};
  const updatedAt = new Date().toISOString();
  await atomicWriteJson(checkoutTokenPath, { ...next, tokens, updatedAt });
};

const pruneCheckoutTokens = (store) => {
  const ttlMs = Math.max(1, CHECKOUT_TOKEN_TTL_HOURS) * 60 * 60 * 1000;
  const now = Date.now();
  const tokens = store?.tokens && typeof store.tokens === "object" ? store.tokens : {};
  const entries = Object.entries(tokens).filter(([, payload]) => {
    const expiresAt = Date.parse(payload?.expiresAt || "");
    if (Number.isFinite(expiresAt)) {
      return expiresAt > now;
    }
    const createdAt = Date.parse(payload?.createdAt || "");
    if (Number.isFinite(createdAt)) {
      return now - createdAt <= ttlMs;
    }
    return true;
  });
  return { ...emptyCheckoutTokenStore(), ...store, tokens: Object.fromEntries(entries) };
};


const readRenewLogStore = async () => safeReadJsonFile(checkoutRenewLogPath, { byPhone: {} });

const writeRenewLogStore = async (store) => {
  await atomicWriteJson(checkoutRenewLogPath, store);
};

const appendRenewLog = async (phone, message, meta = {}) => {
  if (!phone || !message) return;
  const store = await readRenewLogStore();
  if (!store.byPhone || typeof store.byPhone !== "object") {
    store.byPhone = {};
  }
  const logs = Array.isArray(store.byPhone[phone]) ? store.byPhone[phone] : [];
  logs.push({
    at: new Date().toISOString(),
    message,
    ...meta,
  });
  if (Number.isFinite(CHECKOUT_RENEW_LOG_LIMIT) && logs.length > CHECKOUT_RENEW_LOG_LIMIT) {
    store.byPhone[phone] = logs.slice(-CHECKOUT_RENEW_LOG_LIMIT);
  } else {
    store.byPhone[phone] = logs;
  }
  await writeRenewLogStore(store);
};

const getRenewLogs = async (phone) => {
  if (!phone) return [];
  const store = await readRenewLogStore();
  const logs = Array.isArray(store.byPhone?.[phone]) ? store.byPhone[phone] : [];
  return logs;
};
const getAllRenewLogs = async () => {
  const store = await readRenewLogStore();
  const byPhone = store.byPhone || {};
  const logs = [];
  for (const [phone, entries] of Object.entries(byPhone)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const message = String(entry.message || "");
      const lower = message.toLowerCase();
      const type = lower.includes("erro") || lower.includes("error") ? "error" : "renew";
      logs.push({
        ...entry,
        phone,
        type,
        source: entry.source || "checkout",
        category: "renew",
      });
    }
  }
  return logs;
};

const getPainelSyncLogs = async () => {
  const state = await loadPainelSyncState();
  const entries = Array.isArray(state.logs) ? state.logs : [];
  return entries.map((entry) => ({
    at: entry.at,
    message: entry.message,
    type: "sync",
    source: "sync",
    category: "sync",
  }));
};

const readMessageDeliveryLogStore = async () =>
  safeReadJsonFile(messageDeliveryLogPath, { logs: [] });

const writeMessageDeliveryLogStore = async (store) => {
  await atomicWriteJson(messageDeliveryLogPath, store);
};

const appendMessageDeliveryLog = async (entry) => {
  if (!entry || typeof entry !== "object") return;
  const store = await readMessageDeliveryLogStore();
  const logs = Array.isArray(store.logs) ? store.logs : [];
  logs.push({
    at: entry.at || nowIso(),
    category: entry.category || "message",
    level: entry.level || "info",
    source: entry.source || "meta",
    event: entry.event || null,
    to: entry.to || null,
    messageId: entry.messageId || null,
    conversationId: entry.conversationId || null,
    phone: entry.phone || entry.to || null,
    channel: entry.channel || null,
    preview: entry.preview || null,
    templateName: entry.templateName || null,
    campaignId: entry.campaignId || null,
    campaignName: entry.campaignName || null,
    errorCode: entry.errorCode || null,
    errorReason: entry.errorReason || null,
    status: entry.status || null,
    message: entry.message || "",
  });
  if (Number.isFinite(MESSAGE_DELIVERY_LOG_LIMIT) && logs.length > MESSAGE_DELIVERY_LOG_LIMIT) {
    store.logs = logs.slice(-MESSAGE_DELIVERY_LOG_LIMIT);
  } else {
    store.logs = logs;
  }
  await writeMessageDeliveryLogStore(store);
};

const normalizeMetaStatusErrorCode = (value) => {
  if (value === null || typeof value === "undefined") return "";
  const code = String(value).trim();
  return code && code !== "undefined" && code !== "null" ? code : "";
};

const describeMetaStatusError = ({ code, title, message, details, statusValue }) => {
  const raw = [title, message, details].filter(Boolean).join(" | ").toLowerCase();
  if (code === "131026" || raw.includes("undeliverable")) {
    return "Meta nao conseguiu entregar a mensagem. O numero pode nao estar apto a receber no WhatsApp, pode ter bloqueado o canal ou estar indisponivel no momento.";
  }
  if (code === "131047" || raw.includes("re-engagement message")) {
    return "A janela de 24h esta fechada. Para retomar a conversa, envie um template aprovado pela Meta.";
  }
  if (code === "131048" || raw.includes("spam rate limit")) {
    return "A Meta aplicou limite por qualidade/spam. Revise a frequencia, o conteudo e a qualidade do numero remetente.";
  }
  if (code === "131049" || raw.includes("meta chose not to deliver")) {
    return "A Meta optou por nao entregar essa mensagem. Isso costuma acontecer por regras de protecao do ecossistema e engajamento do destinatario.";
  }
  if (code === "131021" || raw.includes("recipient cannot be sender")) {
    return "O numero destinatario e o mesmo numero remetente configurado no canal.";
  }
  if (code === "131042" || raw.includes("payment issue")) {
    return "Ha um problema de elegibilidade/pagamento na conta WhatsApp Business. Verifique faturamento e limites no WhatsApp Manager.";
  }
  if (code === "131000") {
    return "A Meta retornou uma falha generica de envio. Vale tentar novamente e verificar o payload completo do erro.";
  }
  if (statusValue === "failed") {
    return "A Meta marcou o envio como falho. Consulte o codigo e os detalhes tecnicos retornados no status.";
  }
  return "";
};

const normalizeMetaStatusErrors = (errors, statusValue) => {
  return (Array.isArray(errors) ? errors : [])
    .map((item) => {
      const code = normalizeMetaStatusErrorCode(item?.code || item?.error_code);
      const title = String(item?.title || "").trim();
      const message = String(item?.message || "").trim();
      const details = String(
        item?.error_data?.details ||
        item?.error_data?.messaging_product ||
        item?.details ||
        "",
      ).trim();
      const href = String(item?.href || "").trim();
      const explanation = describeMetaStatusError({ code, title, message, details, statusValue });
      const debugParts = [
        code ? `codigo=${code}` : "",
        title ? `titulo=${title}` : "",
        message ? `mensagem=${message}` : "",
        details ? `detalhes=${details}` : "",
        href ? `doc=${href}` : "",
      ].filter(Boolean);
      return {
        code,
        title,
        message,
        details,
        href,
        explanation,
        summary: [explanation, debugParts.join(" | ")].filter(Boolean).join(" | "),
      };
    })
    .filter((item) => item.summary || item.code || item.message || item.details);
};

const getMessageDeliveryLogs = async () => {
  const store = await readMessageDeliveryLogStore();
  const logs = Array.isArray(store.logs) ? store.logs : [];
  return logs.map((entry) => ({
    ...entry,
    type: entry.level === "error" ? "error" : "message",
  }));
};

const DEFAULT_UI_TAGS = [
  { id: "tag-cliente", name: "Cliente", color: "#22C55E", sectorId: "default" },
  { id: "tag-lead", name: "Lead", color: "#F59E0B", sectorId: "default" },
];
const DEFAULT_UI_NEWBR_CREDENTIALS = {
  baseUrl: String(process.env.PANEL_NEWBR_BASE_URL || "https://painel.newbr.top").trim().replace(/\/+$/, ""),
  username: String(process.env.PANEL_NEWBR_USERNAME || "suportemaistv").trim(),
  password: String(process.env.PANEL_NEWBR_PASSWORD || "suporte+TV1").trim(),
};

const normalizeUiTagList = (value) => {
  if (!Array.isArray(value)) return DEFAULT_UI_TAGS;
  const list = value
    .map((entry, index) => {
      const name = String(entry?.name || "").trim();
      const color = String(entry?.color || "").trim();
      if (!name || !color) return null;
      return {
        id: String(entry?.id || `tag-${Date.now()}-${index}`),
        name,
        color,
        sectorId: String(entry?.sectorId || "default"),
      };
    })
    .filter(Boolean);
  return list.length ? list : DEFAULT_UI_TAGS;
};

const normalizeUiStringList = (value, maxItems) => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  ).slice(0, maxItems);
};

const normalizeUiNewbrCredentials = (value, fallback = DEFAULT_UI_NEWBR_CREDENTIALS) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const baseUrl = String(source?.baseUrl || fallback.baseUrl || "").trim().replace(/\/+$/, "");
  const username = String(source?.username || fallback.username || "").trim();
  const password = String(source?.password || fallback.password || "").trim();
  return {
    baseUrl: baseUrl || DEFAULT_UI_NEWBR_CREDENTIALS.baseUrl,
    username: username || DEFAULT_UI_NEWBR_CREDENTIALS.username,
    password: password || DEFAULT_UI_NEWBR_CREDENTIALS.password,
  };
};

const normalizeUiTheme = (value) => {
  const theme = String(value || "").trim().toLowerCase();
  if (theme === "whatsapp-web" || theme === "neon-grid") return theme;
  return "original";
};

const normalizeUiColorScheme = (value) => {
  const scheme = String(value || "").trim().toLowerCase();
  return scheme === "light" ? "light" : "dark";
};

const emptyUiPreferencesStore = () => ({
  updatedAt: null,
  selectedConversationId: null,
  pinnedConversationIds: [],
  recentEmojis: [],
  uiTheme: "original",
  colorScheme: "dark",
  tags: DEFAULT_UI_TAGS,
  newbrCredentials: DEFAULT_UI_NEWBR_CREDENTIALS,
});

const readUiPreferencesStore = async () => {
  const data = await safeReadJsonFile(uiPreferencesPath, emptyUiPreferencesStore());
  if (!data || typeof data !== "object") return emptyUiPreferencesStore();
  return {
    ...emptyUiPreferencesStore(),
    ...data,
    selectedConversationId: data?.selectedConversationId ? String(data.selectedConversationId) : null,
    pinnedConversationIds: normalizeUiStringList(data?.pinnedConversationIds, 3),
    recentEmojis: normalizeUiStringList(data?.recentEmojis, 24),
    uiTheme: normalizeUiTheme(data?.uiTheme),
    colorScheme: normalizeUiColorScheme(data?.colorScheme),
    tags: normalizeUiTagList(data?.tags),
    newbrCredentials: normalizeUiNewbrCredentials(data?.newbrCredentials),
  };
};

const writeUiPreferencesStore = async (store) => {
  const next = store && typeof store === "object" ? store : emptyUiPreferencesStore();
  const normalized = {
    ...emptyUiPreferencesStore(),
    ...next,
    selectedConversationId: next?.selectedConversationId ? String(next.selectedConversationId) : null,
    pinnedConversationIds: normalizeUiStringList(next?.pinnedConversationIds, 3),
    recentEmojis: normalizeUiStringList(next?.recentEmojis, 24),
    uiTheme: normalizeUiTheme(next?.uiTheme),
    colorScheme: normalizeUiColorScheme(next?.colorScheme),
    tags: normalizeUiTagList(next?.tags),
    newbrCredentials: normalizeUiNewbrCredentials(next?.newbrCredentials),
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(uiPreferencesPath, normalized);
  return normalized;
};

const patchUiPreferencesStore = async (payload) => {
  const current = await readUiPreferencesStore();
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(payload || {}, "selectedConversationId")) {
    next.selectedConversationId = payload?.selectedConversationId
      ? String(payload.selectedConversationId)
      : null;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, "pinnedConversationIds")) {
    next.pinnedConversationIds = normalizeUiStringList(payload?.pinnedConversationIds, 3);
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, "recentEmojis")) {
    next.recentEmojis = normalizeUiStringList(payload?.recentEmojis, 24);
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, "uiTheme")) {
    next.uiTheme = normalizeUiTheme(payload?.uiTheme);
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, "colorScheme")) {
    next.colorScheme = normalizeUiColorScheme(payload?.colorScheme);
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, "tags")) {
    next.tags = normalizeUiTagList(payload?.tags);
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, "newbrCredentials")) {
    next.newbrCredentials = normalizeUiNewbrCredentials(payload?.newbrCredentials, current?.newbrCredentials);
  }
  return writeUiPreferencesStore(next);
};

const QUICK_REPLIES_PATH = process.env.WHATSAPP_QUICK_REPLIES_PATH || "server/data/quick-replies.json";
const WHATSAPP_LOCAL_TEMPLATES_PATH = process.env.WHATSAPP_LOCAL_TEMPLATES_PATH || "server/data/whatsapp-local-templates.json";
const UI_PREFERENCES_PATH = process.env.UI_PREFERENCES_PATH || "server/data/ui-preferences.json";

const quickRepliesPath = path.resolve(process.cwd(), QUICK_REPLIES_PATH);
const localTemplatesPath = path.resolve(process.cwd(), WHATSAPP_LOCAL_TEMPLATES_PATH);
const uiPreferencesPath = path.resolve(process.cwd(), UI_PREFERENCES_PATH);
const templateMediaDirPath = path.resolve(process.cwd(), WHATSAPP_TEMPLATE_MEDIA_DIR);
const routinesStorePath = path.resolve(process.cwd(), ROUTINES_STORE_PATH);
const routineLogStorePath = path.resolve(process.cwd(), ROUTINE_LOG_STORE_PATH);
const scheduledMessagesStorePath = path.resolve(process.cwd(), SCHEDULED_MESSAGES_STORE_PATH);
const labelCampaignStatePath = path.resolve(process.cwd(), LABEL_CAMPAIGN_STATE_PATH);



const emptyQuickReplyStore = () => ({

  updatedAt: null,

  items: [],

});



const extractQuickReplyVariables = (text) => {

  const matches = String(text || "").match(/\{\{[^}]+\}\}/g);

  return matches ? [...new Set(matches)] : [];

};



const normalizeQuickReply = (input, existing) => {

  const title = String(input?.title || "").trim();

  const content = String(input?.content || "").trim();

  if (!title || !content) {

    throw new Error("Missing quick reply fields");

  }

  const sector = ["suporte", "comercial", "financeiro", "retencao"].includes(input?.sector)

    ? input.sector

    : "suporte";

  const variables = Array.isArray(input?.variables) && input.variables.length

    ? input.variables

    : extractQuickReplyVariables(content);

  const usageCount = Number.isFinite(input?.usageCount)

    ? Number(input.usageCount)

    : (existing?.usageCount || 0);

  const createdAt = existing?.createdAt

    || (input?.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString());

  const id = String(input?.id || existing?.id || `qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  return { id, title, sector, content, variables, usageCount, createdAt };

};



const readQuickRepliesStore = async () => {
  const data = await safeReadJsonFile(quickRepliesPath, emptyQuickReplyStore());
  if (!data || typeof data !== "object") return emptyQuickReplyStore();
  const items = Array.isArray(data.items) ? data.items : [];
  return { ...data, items };
};

const writeQuickRepliesStore = async (store) => {
  const next = store && typeof store === "object" ? store : emptyQuickReplyStore();
  const items = Array.isArray(next.items) ? next.items : [];
  const updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(quickRepliesPath), { recursive: true });
  await atomicWriteJson(quickRepliesPath, { ...next, items, updatedAt });
};

const listQuickReplies = async () => {
  const store = await readQuickRepliesStore();
  return Array.isArray(store.items) ? store.items : [];
};

const findQuickReplyById = async (id) => {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return null;
  const items = await listQuickReplies();
  return items.find((item) => String(item?.id || "").trim() === normalizedId) || null;
};



const upsertQuickReplyStore = async (payload) => {

  const store = await readQuickRepliesStore();

  const items = Array.isArray(store.items) ? store.items : [];

  const index = items.findIndex((item) => item.id === payload?.id);

  const existing = index >= 0 ? items[index] : null;

  const normalized = normalizeQuickReply(payload, existing);

  if (index >= 0) {

    items[index] = normalized;

  } else {

    items.unshift(normalized);

  }

  store.items = items;

  await writeQuickRepliesStore(store);

  return normalized;

};



const deleteQuickReplyStore = async (id) => {

  if (!id) return false;

  const store = await readQuickRepliesStore();

  const items = Array.isArray(store.items) ? store.items : [];

  const next = items.filter((item) => item.id !== id);

  store.items = next;

  await writeQuickRepliesStore(store);

  return next.length !== items.length;

};

const emptyLocalTemplateStore = () => ({
  updatedAt: null,
  items: [],
});

const normalizeLocalTemplateCategory = (value) => {
  const category = String(value || "").toLowerCase();
  if (category === "utility" || category === "marketing" || category === "authentication" || category === "internal") {
    return category;
  }
  return "utility";
};

const normalizeLocalTemplateStatus = (value) => {
  const status = String(value || "").toLowerCase();
  if (status === "approved" || status === "pending" || status === "rejected") {
    return status;
  }
  return "approved";
};

const normalizeLocalTemplateUtilityType = (value) => {
  const type = String(value || "").toLowerCase();
  if (type === "status_pedido") return "status_pedido";
  return "personalizado";
};

const normalizeLocalTemplateHeaderType = (value) => {
  const type = String(value || "").toLowerCase();
  if (type === "image" || type === "document" || type === "video" || type === "text") {
    return type;
  }
  return "none";
};

const normalizeLocalTemplateButtons = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const rawType = String(item?.type || "").toLowerCase();
      const type =
        rawType === "personalizado" || rawType === "acessar_site" || rawType === "fluxo_whatsapp"
          ? rawType
          : null;
      if (!type) return null;
      const id = String(item?.id || `btn-${Date.now()}-${index}`);
      const text = String(item?.text || "").trim();
      if (!text) return null;
      const normalized = { id, type, text };
      if (type === "acessar_site") {
        const urlType = String(item?.urlType || "").toLowerCase() === "dinamico" ? "dinamico" : "fixo";
        const url = String(item?.url || "").trim();
        return { ...normalized, urlType, url };
      }
      if (type === "fluxo_whatsapp") {
        const flowId = String(item?.flowId || "").trim();
        return { ...normalized, flowId };
      }
      return normalized;
    })
    .filter(Boolean);
};

const normalizeLocalTemplateServiceIds = (...values) => {
  const ids = values.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.includes(",")) return value.split(",");
    return [value];
  });
  return Array.from(
    new Set(
      ids
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
};

const normalizeLocalTemplateItem = (input, existing = null) => {
  const name = String(input?.name || existing?.name || "").trim();
  const content = String(input?.content || existing?.content || "").trim();
  const hasFooter = Object.prototype.hasOwnProperty.call(input || {}, "footer");
  if (!name || !content) {
    throw new Error("Missing local template fields");
  }

  const hasButton = Boolean(input?.hasButton);
  const createdAtValue = input?.createdAt || existing?.createdAt || new Date().toISOString();
  const createdAtDate = new Date(createdAtValue);
  const createdAt = Number.isFinite(createdAtDate.getTime())
    ? createdAtDate.toISOString()
    : new Date().toISOString();
  const serviceIds = normalizeLocalTemplateServiceIds(
    input?.serviceIds,
    input?.service_ids,
    input?.serviceId ||
      input?.service_id ||
      input?.service ||
      input?.assignedServiceId ||
      input?.assigned_service_id ||
      existing?.serviceId ||
      existing?.service_id ||
      "",
    existing?.serviceIds,
    existing?.service_ids
  );

  return {
    id: String(
      input?.id || existing?.id || `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    ),
    name,
    language: String(input?.language || existing?.language || "pt_BR"),
    category: normalizeLocalTemplateCategory(input?.category || existing?.category),
    content,
    status: normalizeLocalTemplateStatus(input?.status || existing?.status),
    serviceIds,
    serviceId: serviceIds[0] || "",
    hasButton,
    buttonText: hasButton ? String(input?.buttonText || "").trim() || undefined : undefined,
    buttonUrl: hasButton ? String(input?.buttonUrl || "").trim() || undefined : undefined,
    headerFormat: input?.headerFormat ? String(input.headerFormat) : undefined,
    headerText: input?.headerText ? String(input.headerText) : undefined,
    headerExample: input?.headerExample ? normalizeTemplateMediaLink(input.headerExample) : undefined,
    headerMediaUrl: input?.headerMediaUrl ? normalizeTemplateMediaLink(input.headerMediaUrl) : undefined,
    active: typeof input?.active === "boolean" ? input.active : Boolean(existing?.active ?? true),
    utilityType: normalizeLocalTemplateUtilityType(input?.utilityType || existing?.utilityType),
    headerType: normalizeLocalTemplateHeaderType(input?.headerType || existing?.headerType),
    footer: hasFooter ? String(input?.footer || "") : String(existing?.footer || ""),
    bodyVariables: Array.isArray(input?.bodyVariables)
      ? input.bodyVariables.map((item) => String(item || ""))
      : Array.isArray(existing?.bodyVariables)
        ? existing.bodyVariables.map((item) => String(item || ""))
        : [],
    buttonConfig: normalizeLocalTemplateButtons(
      Array.isArray(input?.buttonConfig) ? input.buttonConfig : existing?.buttonConfig
    ),
    createdAt,
  };
};

const readLocalTemplateStore = async () => {
  const data = await safeReadJsonFile(localTemplatesPath, emptyLocalTemplateStore());
  if (!data || typeof data !== "object") return emptyLocalTemplateStore();
  const items = Array.isArray(data.items)
    ? data.items.map((item) =>
        item && typeof item === "object"
          ? {
              ...item,
              headerExample: normalizeTemplateMediaLink(item.headerExample),
              headerMediaUrl: normalizeTemplateMediaLink(item.headerMediaUrl),
            }
          : item,
      )
    : [];
  return { ...data, items };
};

const writeLocalTemplateStore = async (store) => {
  const next = store && typeof store === "object" ? store : emptyLocalTemplateStore();
  const items = Array.isArray(next.items) ? next.items : [];
  const updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(localTemplatesPath), { recursive: true });
  await atomicWriteJson(localTemplatesPath, { ...next, items, updatedAt });
};

const listLocalTemplates = async () => {
  const store = await readLocalTemplateStore();
  return Array.isArray(store.items) ? store.items : [];
};

const upsertLocalTemplateStore = async (payload) => {
  const store = await readLocalTemplateStore();
  const items = Array.isArray(store.items) ? store.items : [];
  const byIdIndex = payload?.id ? items.findIndex((item) => item.id === payload.id) : -1;
  const byNameLanguageIndex =
    byIdIndex >= 0
      ? byIdIndex
      : items.findIndex(
          (item) =>
            String(item.name || "").toLowerCase() === String(payload?.name || "").toLowerCase() &&
            String(item.language || "pt_BR").toLowerCase() ===
              String(payload?.language || "pt_BR").toLowerCase()
        );
  const existing = byNameLanguageIndex >= 0 ? items[byNameLanguageIndex] : null;
  const normalized = normalizeLocalTemplateItem(payload, existing);
  if (byNameLanguageIndex >= 0) {
    items[byNameLanguageIndex] = normalized;
  } else {
    items.unshift(normalized);
  }
  store.items = items;
  await writeLocalTemplateStore(store);
  return normalized;
};

const replaceLocalTemplateStore = async (payloadItems) => {
  const normalized = payloadItems.map((item) => normalizeLocalTemplateItem(item));
  await writeLocalTemplateStore({ items: normalized });
  return normalized;
};

const deleteLocalTemplateStore = async (id) => {
  if (!id) return false;
  const store = await readLocalTemplateStore();
  const items = Array.isArray(store.items) ? store.items : [];
  const next = items.filter((item) => item.id !== id);
  store.items = next;
  await writeLocalTemplateStore(store);
  return next.length !== items.length;
};

const TEMPLATE_MEDIA_ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const TEMPLATE_MEDIA_EXT_FROM_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
};

const TEMPLATE_MEDIA_MIME_FROM_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

const templateMediaMaxBytes = Math.max(1, WHATSAPP_TEMPLATE_MEDIA_MAX_MB || 10) * 1024 * 1024;

const extractBase64Payload = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return { mimeType: "", base64: "" };
  const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    return {
      mimeType: String(dataUrlMatch[1] || "").toLowerCase().trim(),
      base64: String(dataUrlMatch[2] || "").trim(),
    };
  }
  return {
    mimeType: "",
    base64: raw.replace(/\s+/g, ""),
  };
};

const resolveTemplateMediaPublicOriginFromConfig = () =>
  resolveConfiguredTemplateMediaPublicOrigin({
    explicitOrigin: WHATSAPP_TEMPLATE_MEDIA_PUBLIC_ORIGIN,
    apiBaseUrl: TEMPLATE_MEDIA_PUBLIC_API_BASE_URL,
  }).replace(/\/+$/, "");

const normalizeTemplateMediaLink = (value) =>
  normalizeTemplateMediaUrl(value, {
    publicOrigin: WHATSAPP_TEMPLATE_MEDIA_PUBLIC_ORIGIN,
    apiBaseUrl: TEMPLATE_MEDIA_PUBLIC_API_BASE_URL,
  });

const normalizeTemplateHeaderParameters = (headerParameters = [], headerFormat = "") => {
  const normalizedHeaderFormat = String(headerFormat || "").trim().toUpperCase();
  return (Array.isArray(headerParameters) ? headerParameters : []).map((value, index) => {
    const normalizedValue = String(value || "").trim();
    if (index === 0 && normalizedHeaderFormat && normalizedHeaderFormat !== "TEXT") {
      return normalizeTemplateMediaLink(normalizedValue);
    }
    return normalizedValue;
  });
};

const resolveTemplateMediaPublicOrigin = (req) => {
  const configuredOrigin = resolveTemplateMediaPublicOriginFromConfig();
  if (configuredOrigin) {
    return configuredOrigin;
  }
  if (CHECKOUT_PUBLIC_URL) {
    try {
      const url = new URL(CHECKOUT_PUBLIC_URL);
      return `${url.protocol}//${url.host}`;
    } catch {
      // ignore
    }
  }
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const host = String(req?.headers?.host || "").trim();
  if (host) {
    return `${forwardedProto || "http"}://${host}`.replace(/\/+$/, "");
  }
  return "";
};

const buildTemplateMediaPublicUrl = (req, fileName) => {
  const origin = resolveTemplateMediaPublicOrigin(req);
  const pathPart = `/api/whatsapp/templates/local/media/${encodeURIComponent(fileName)}`;
  if (!origin) return pathPart;
  return `${origin}${pathPart}`;
};

const persistTemplateMediaFromPayload = async (payload) => {
  const filename = String(payload?.filename || "").trim();
  const explicitMime = String(payload?.mimeType || "").toLowerCase().trim();
  const parsed = extractBase64Payload(payload?.dataUrl || payload?.dataBase64 || payload?.data || "");
  const mimeType = explicitMime || parsed.mimeType;
  if (!mimeType || !TEMPLATE_MEDIA_ALLOWED_MIME.has(mimeType)) {
    throw new Error("Tipo de arquivo nao permitido. Use imagem, video MP4 ou documento compativel.");
  }
  if (!parsed.base64) {
    throw new Error("Arquivo vazio.");
  }
  const buffer = Buffer.from(parsed.base64, "base64");
  if (!buffer.length) {
    throw new Error("Nao foi possivel decodificar o arquivo.");
  }
  if (buffer.length > templateMediaMaxBytes) {
    throw new Error(`Arquivo excede o limite de ${WHATSAPP_TEMPLATE_MEDIA_MAX_MB}MB.`);
  }
  const ext = TEMPLATE_MEDIA_EXT_FROM_MIME[mimeType] || "bin";
  const safeBase =
    filename
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "header-media";
  const fileName = `${safeBase}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await fs.mkdir(templateMediaDirPath, { recursive: true });
  await fs.writeFile(path.join(templateMediaDirPath, fileName), buffer);
  return {
    fileName,
    mimeType,
    size: buffer.length,
  };
};

const ROUTINE_RULE_VALUES = new Set(["due_minus_1", "due_today", "due_plus_1", "after_signup_10"]);
const ROUTINE_STATUS_VALUES = new Set(["active", "paused"]);
const ROUTINE_WEEKDAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const ROUTINE_WEEKDAY_INDEX = {
  0: "sunday",
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
};

const emptyRoutineStore = () => ({
  updatedAt: null,
  routines: [],
});

const emptyRoutineLogStore = () => ({
  updatedAt: null,
  logs: [],
});

const readRoutineStore = async () => {
  const data = await safeReadJsonFile(routinesStorePath, emptyRoutineStore());
  if (!data || typeof data !== "object") return emptyRoutineStore();
  const routines = Array.isArray(data.routines)
    ? data.routines.map((routine) =>
        routine && typeof routine === "object"
          ? {
              ...routine,
              headerVariables: Array.isArray(routine.headerVariables)
                ? routine.headerVariables.map((item) => normalizeTemplateMediaLink(item))
                : [],
            }
          : routine,
      )
    : [];
  return { ...emptyRoutineStore(), ...data, routines };
};

const writeRoutineStore = async (store) => {
  const next = store && typeof store === "object" ? store : emptyRoutineStore();
  const routines = Array.isArray(next.routines) ? next.routines : [];
  await atomicWriteJson(routinesStorePath, {
    ...next,
    routines,
    updatedAt: new Date().toISOString(),
  });
};

const readRoutineLogStore = async () => {
  const data = await safeReadJsonFile(routineLogStorePath, emptyRoutineLogStore());
  if (!data || typeof data !== "object") return emptyRoutineLogStore();
  const logs = Array.isArray(data.logs) ? data.logs : [];
  return { ...emptyRoutineLogStore(), ...data, logs };
};

const writeRoutineLogStore = async (store) => {
  const next = store && typeof store === "object" ? store : emptyRoutineLogStore();
  const logs = Array.isArray(next.logs) ? next.logs : [];
  await atomicWriteJson(routineLogStorePath, {
    ...next,
    logs,
    updatedAt: new Date().toISOString(),
  });
};

const emptyScheduledMessageStore = () => ({
  updatedAt: null,
  items: [],
});

const normalizeScheduledMessageType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (["text", "media", "audio", "quickreply"].includes(normalized)) {
    return normalized === "quickreply" ? "quickReply" : normalized;
  }
  return "text";
};

const normalizeScheduledDateValue = (value) => {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}`;
};

const normalizeScheduledTimeValue = (value) => {
  const text = String(value || "").trim();
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) return "";
  return `${match[1]}:${match[2]}`;
};

const compareScheduledDateTime = (dateA, timeA, dateB, timeB) => {
  const a = `${normalizeScheduledDateValue(dateA)} ${normalizeScheduledTimeValue(timeA)}`;
  const b = `${normalizeScheduledDateValue(dateB)} ${normalizeScheduledTimeValue(timeB)}`;
  return a.localeCompare(b);
};

const parseScheduledDateParts = (value) => {
  const normalized = normalizeScheduledDateValue(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
};

const formatScheduledDateFromUtc = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
};

const normalizeScheduledMessageItem = (item) => {
  const next = item && typeof item === "object" ? item : {};
  return {
    id: String(next.id || `schedule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    conversationId: String(next.conversationId || "").trim(),
    channel: String(next.channel || "support").trim() === "sales" ? "sales" : "support",
    to: normalizePhone(next.to) || String(next.to || "").trim(),
    title: String(next.title || "").trim(),
    type: normalizeScheduledMessageType(next.type),
    message: String(next.message || ""),
    date: normalizeScheduledDateValue(next.date),
    time: normalizeScheduledTimeValue(next.time),
    recurrence: String(next.recurrence || "Nenhuma selecionada").trim() || "Nenhuma selecionada",
    customRecurrence: String(next.customRecurrence || "").trim(),
    imageBase64: String(next.imageBase64 || next.imageDataUrl || "").trim(),
    imageName: String(next.imageName || "").trim(),
    audioBase64: String(next.audioBase64 || next.audioDataUrl || "").trim(),
    audioName: String(next.audioName || "").trim(),
    audioMimeType: String(next.audioMimeType || "").trim(),
    quickReplyId: String(next.quickReplyId || "").trim(),
    quickReplyTitle: String(next.quickReplyTitle || "").trim(),
    status: String(next.status || "scheduled").trim(),
    createdAt: String(next.createdAt || nowIso()),
    updatedAt: String(next.updatedAt || nowIso()),
    lastRunAt: next.lastRunAt ? String(next.lastRunAt) : null,
    error: next.error ? String(next.error) : null,
  };
};

const buildScheduledMessageSummaryIndex = (items = []) => {
  const byConversationId = new Map();
  const byPhone = new Map();
  const pendingItems = Array.isArray(items)
    ? items.filter(
        (item) =>
          String(item?.status || "scheduled").trim().toLowerCase() === "scheduled" &&
          normalizeScheduledDateValue(item?.date) &&
          normalizeScheduledTimeValue(item?.time),
      )
    : [];

  const grouped = new Map();
  pendingItems.forEach((item) => {
    const conversationId = String(item?.conversationId || "").trim();
    const phone = normalizePhone(item?.to) || String(item?.to || "").trim();
    const key = conversationId || phone;
    if (!key) return;
    const current = grouped.get(key) || [];
    current.push(item);
    grouped.set(key, current);
  });

  grouped.forEach((groupItems) => {
    const sortedItems = [...groupItems].sort((a, b) =>
      compareScheduledDateTime(a?.date, a?.time, b?.date, b?.time),
    );
    const nextItem = sortedItems[0];
    if (!nextItem) return;
    const summary = {
      scheduledMessageId: String(nextItem.id || ""),
      title: String(nextItem.title || "").trim() || null,
      type: normalizeScheduledMessageType(nextItem.type),
      date: normalizeScheduledDateValue(nextItem.date),
      time: normalizeScheduledTimeValue(nextItem.time),
      recurrence: String(nextItem.recurrence || "").trim() || null,
      count: sortedItems.length,
    };
    const conversationId = String(nextItem.conversationId || "").trim();
    const phone = normalizePhone(nextItem.to) || String(nextItem.to || "").trim();
    if (conversationId) {
      byConversationId.set(conversationId, summary);
    }
    if (phone) {
      byPhone.set(phone, summary);
    }
  });

  return { byConversationId, byPhone };
};

const attachScheduledSummariesToConversations = (items = [], summaryIndex) => {
  if (!summaryIndex || !Array.isArray(items) || items.length === 0) return items;
  return items.map((conversation) => {
    const byConversationId = summaryIndex.byConversationId?.get(String(conversation?.id || "").trim()) || null;
    const normalizedPhone = normalizePhone(
      conversation?.customer?.phone || conversation?.customer?.jid || conversation?.id || "",
    );
    const byPhone = normalizedPhone ? summaryIndex.byPhone?.get(normalizedPhone) || null : null;
    const scheduledSummary = byConversationId || byPhone;
    if (!scheduledSummary) return conversation;
    return {
      ...conversation,
      scheduledSummary,
    };
  });
};

const readScheduledMessageStore = async () => {
  const data = await safeReadJsonFile(scheduledMessagesStorePath, emptyScheduledMessageStore());
  if (!data || typeof data !== "object") return emptyScheduledMessageStore();
  const items = Array.isArray(data.items) ? data.items.map(normalizeScheduledMessageItem) : [];
  return { ...emptyScheduledMessageStore(), ...data, items };
};

const writeScheduledMessageStore = async (store) => {
  const next = store && typeof store === "object" ? store : emptyScheduledMessageStore();
  const items = Array.isArray(next.items) ? next.items.map(normalizeScheduledMessageItem) : [];
  await atomicWriteJson(scheduledMessagesStorePath, {
    ...next,
    items,
    updatedAt: nowIso(),
  });
};

const emptyLabelCampaignStateStore = () => ({
  updatedAt: null,
  slots: {},
});

const readLabelCampaignStateStore = async () => {
  const data = await safeReadJsonFile(labelCampaignStatePath, emptyLabelCampaignStateStore());
  if (!data || typeof data !== "object") return emptyLabelCampaignStateStore();
  return {
    ...emptyLabelCampaignStateStore(),
    ...data,
    slots: data?.slots && typeof data.slots === "object" ? data.slots : {},
  };
};

const writeLabelCampaignStateStore = async (store) => {
  const next = store && typeof store === "object" ? store : emptyLabelCampaignStateStore();
  await atomicWriteJson(labelCampaignStatePath, {
    ...next,
    slots: next?.slots && typeof next.slots === "object" ? next.slots : {},
    updatedAt: nowIso(),
  });
};

const isScheduledMessageDue = (item, now = new Date()) => {
  if (!item || item.status !== "scheduled" || !item.date || !item.time) return false;
  const nowDate = getZonedDateKey(now, DEFAULT_ROUTINE_TIMEZONE);
  const nowTime = getZonedTimeKey(now, DEFAULT_ROUTINE_TIMEZONE);
  if (!nowDate || !nowTime) return false;
  return compareScheduledDateTime(item.date, item.time, nowDate, nowTime) <= 0;
};

const computeNextScheduledOccurrence = (item) => {
  const recurrence = String(item?.recurrence || "").trim().toLowerCase();
  if (!["di?ria", "diaria", "semanal", "mensal"].includes(recurrence)) return null;
  const currentParts = parseScheduledDateParts(item?.date);
  if (!currentParts) return null;
  const next = new Date(Date.UTC(currentParts.year, currentParts.month - 1, currentParts.day));
  if (recurrence === "di?ria" || recurrence === "diaria") {
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (recurrence === "semanal") {
    next.setUTCDate(next.getUTCDate() + 7);
  } else if (recurrence === "mensal") {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return {
    date: formatScheduledDateFromUtc(next),
    time: normalizeScheduledTimeValue(item.time),
  };
};

const normalizeRoutineRule = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return ROUTINE_RULE_VALUES.has(normalized) ? normalized : "due_today";
};

const getDefaultRoutineRuleDays = (rule) => {
  const normalizedRule = normalizeRoutineRule(rule);
  if (normalizedRule === "due_minus_1") return 1;
  if (normalizedRule === "due_plus_1") return 1;
  if (normalizedRule === "after_signup_10") return 10;
  return 0;
};

const normalizeRoutineRuleDays = (rule, value) => {
  const fallback = getDefaultRoutineRuleDays(rule);
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(365, parsed));
};

const normalizeRoutineStatus = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return ROUTINE_STATUS_VALUES.has(normalized) ? normalized : "paused";
};

const normalizeRoutineRunAt = (value, fallback = "18:00") => {
  const text = String(value || "").trim();
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return fallback;
  return `${match[1]}:${match[2]}`;
};

const LABEL_CAMPAIGN_WEEKDAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const normalizeLabelCampaignWeekday = (value, fallback = "monday") => {
  const normalized = String(value || "").trim().toLowerCase();
  return LABEL_CAMPAIGN_WEEKDAY_KEYS.includes(normalized) ? normalized : fallback;
};

const normalizeLabelCampaignWeekdays = (value, fallback = ["monday"]) => {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const normalized = Array.from(
    new Set(
      source
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => LABEL_CAMPAIGN_WEEKDAY_KEYS.includes(item)),
    ),
  );
  if (normalized.length > 0) return normalized;
  return Array.from(
    new Set(
      (Array.isArray(fallback) ? fallback : [fallback])
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => LABEL_CAMPAIGN_WEEKDAY_KEYS.includes(item)),
    ),
  );
};

const normalizeLabelCampaignConfig = (value) => {
  const source = value && typeof value === "object" ? value : {};
  const weekdays = normalizeLabelCampaignWeekdays(source?.weekdays ?? source?.weekday, ["monday"]);
  return {
    enabled: source?.enabled === true,
    metaTemplateName: String(source?.metaTemplateName || "").trim() || null,
    metaTemplateLanguage: String(source?.metaTemplateLanguage || "pt_BR").trim() || "pt_BR",
    weekday: weekdays[0] || normalizeLabelCampaignWeekday(source?.weekday, "monday"),
    weekdays,
    time: normalizeRoutineRunAt(source?.time, "09:00"),
    moveToLabelId: String(source?.moveToLabelId || "").trim() || null,
    removeFromCurrent: source?.removeFromCurrent === true,
    useInternalTemplateOn24h: source?.useInternalTemplateOn24h === true,
    internalTemplateId: String(source?.internalTemplateId || "").trim() || null,
  };
};

const normalizeRoutineWeekdaySchedules = (value, fallbackRunAt = "18:00", existing = null) => {
  const fallbackTime = normalizeRoutineRunAt(
    fallbackRunAt,
    normalizeRoutineRunAt(existing?.monday?.runAt || "18:00", "18:00"),
  );
  const source = value && typeof value === "object" ? value : existing && typeof existing === "object" ? existing : null;
  const next = {};

  for (const weekday of ROUTINE_WEEKDAY_KEYS) {
    const current = source?.[weekday];
    next[weekday] = {
      enabled:
        typeof current?.enabled === "boolean"
          ? current.enabled
          : source
            ? Boolean(current?.enabled)
            : true,
      runAt: normalizeRoutineRunAt(current?.runAt, fallbackTime),
    };
  }

  return next;
};

const normalizeRoutineExceptionDates = (value, fallback = []) => {
  const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : [];
  const seen = new Set();
  const next = [];
  for (const item of source) {
    const text = String(item || "").trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) continue;
    const normalized = `${match[1]}-${match[2]}-${match[3]}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
  }
  return next.sort();
};

const normalizeRoutineSendIntervalSeconds = (value, fallback = ROUTINE_DEFAULT_SEND_INTERVAL_SECONDS) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const base = Number.isFinite(parsed) ? parsed : Number.parseInt(String(fallback || ""), 10);
  if (!Number.isFinite(base)) return ROUTINE_DEFAULT_SEND_INTERVAL_SECONDS;
  return Math.min(
    ROUTINE_MAX_SEND_INTERVAL_SECONDS,
    Math.max(ROUTINE_MIN_SEND_INTERVAL_SECONDS, Math.round(base)),
  );
};

const normalizeRoutineVarList = (value, fallback = []) => {
  const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : [];
  return source.map((item) => String(item || "").trim());
};

const normalizeRoutineHeaderFormat = (value, fallback = "") => {
  const raw = String(value ?? fallback ?? "").trim().toUpperCase();
  if (!raw) return "";
  if (["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(raw)) return raw;
  return "";
};

const normalizeRoutineType = (value) => {
  return String(value || "").trim().toLowerCase() === "label" ? "label" : "dispatch";
};

const normalizeRoutineLabelIds = (value, fallback = []) => {
  const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : [];
  return Array.from(
    new Set(
      source
        .flatMap((item) => String(item || "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
};

const normalizeRoutineDefinition = (input, existing = null) => {
  const now = new Date().toISOString();
  const title = String(input?.title || existing?.title || "").trim();
  if (!title) throw new Error("Missing routine title");

  const type = normalizeRoutineType(input?.type || existing?.type || "dispatch");
  const templateName = String(input?.templateName || existing?.templateName || "").trim();
  if (type === "dispatch" && !templateName) throw new Error("Missing template name");

  const variable1Value = String(input?.variable1 ?? existing?.variable1 ?? "{{dia_hoje}}").trim();
  const buttonVariableValue = String(input?.buttonVariable ?? existing?.buttonVariable ?? "").trim();
  const labelsToAdd = normalizeRoutineLabelIds(input?.labelsToAdd, existing?.labelsToAdd ?? []);
  const labelsToRemove = normalizeRoutineLabelIds(input?.labelsToRemove, existing?.labelsToRemove ?? [])
    .filter((labelId) => !labelsToAdd.includes(labelId));
  if (type === "label" && labelsToAdd.length === 0 && labelsToRemove.length === 0) {
    throw new Error("Missing routine label actions");
  }

  const id = String(
    input?.id || existing?.id || `routine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const createdAtRaw = input?.createdAt || existing?.createdAt || now;
  const createdAtDate = new Date(createdAtRaw);
  const createdAt = Number.isFinite(createdAtDate.getTime()) ? createdAtDate.toISOString() : now;

  return {
    id,
    type,
    title,
    rule: normalizeRoutineRule(input?.rule ?? existing?.rule),
    ruleDays: normalizeRoutineRuleDays(
      input?.rule ?? existing?.rule,
      input?.ruleDays ?? existing?.ruleDays,
    ),
    runAt: normalizeRoutineRunAt(input?.runAt ?? existing?.runAt, "18:00"),
    weekdaySchedules: normalizeRoutineWeekdaySchedules(
      input?.weekdaySchedules,
      input?.runAt ?? existing?.runAt ?? "18:00",
      existing?.weekdaySchedules ?? null,
    ),
    exceptionDates: normalizeRoutineExceptionDates(
      input?.exceptionDates,
      existing?.exceptionDates ?? [],
    ),
    sendIntervalSeconds: normalizeRoutineSendIntervalSeconds(
      input?.sendIntervalSeconds ?? existing?.sendIntervalSeconds,
      ROUTINE_DEFAULT_SEND_INTERVAL_SECONDS,
    ),
    timezone: String(input?.timezone || existing?.timezone || DEFAULT_ROUTINE_TIMEZONE),
    templateName: type === "dispatch" ? templateName : "",
    templateLanguage:
      type === "dispatch" ? String(input?.templateLanguage || existing?.templateLanguage || "pt_BR") : "pt_BR",
    alternativeTemplateId: String(
      input?.alternativeTemplateId || existing?.alternativeTemplateId || "",
    ).trim(),
    alternativeTemplateName: String(
      input?.alternativeTemplateName || existing?.alternativeTemplateName || "",
    ).trim(),
    variable1: variable1Value,
    buttonVariable: buttonVariableValue,
    bodyVariables:
      type === "dispatch"
        ? normalizeRoutineVarList(
            input?.bodyVariables,
            existing?.bodyVariables ??
              (variable1Value ? [variable1Value] : ["{{dia_hoje}}"]),
          )
        : [],
    buttonVariables:
      type === "dispatch"
        ? normalizeRoutineVarList(
            input?.buttonVariables,
            existing?.buttonVariables ?? (buttonVariableValue ? [buttonVariableValue] : []),
          )
        : [],
    headerVariables: type === "dispatch"
      ? normalizeRoutineVarList(input?.headerVariables, existing?.headerVariables ?? []).map((item) =>
          normalizeTemplateMediaLink(item),
        )
      : [],
    headerFormat: type === "dispatch"
      ? normalizeRoutineHeaderFormat(input?.headerFormat, existing?.headerFormat || "")
      : "",
    labelsToAdd,
    labelsToRemove,
    status: normalizeRoutineStatus(input?.status ?? existing?.status ?? "active"),
    createdAt,
    updatedAt: now,
    lastRunAt: input?.lastRunAt ?? existing?.lastRunAt ?? null,
    lastRunKey: input?.lastRunKey ?? existing?.lastRunKey ?? null,
    lastRunSummary: input?.lastRunSummary ?? existing?.lastRunSummary ?? null,
  };
};

const sortRoutineList = (items) => {
  return [...items].sort((a, b) => {
    const aAt = Date.parse(a?.createdAt || "") || 0;
    const bAt = Date.parse(b?.createdAt || "") || 0;
    return bAt - aAt;
  });
};

const decodeRouteSegment = (value) => {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
};

const appendRoutineLog = async ({ routineId, routineTitle, level = "info", message, meta = {} }) => {
  const logStore = await readRoutineLogStore();
  const logs = Array.isArray(logStore.logs) ? logStore.logs : [];
  logs.push({
    id: `rlog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    routineId: routineId || null,
    routineTitle: routineTitle || null,
    level: level === "success" || level === "error" ? level : "info",
    message: String(message || ""),
    ...meta,
  });
  const limit = Number.isFinite(ROUTINE_LOG_LIMIT) && ROUTINE_LOG_LIMIT > 0 ? ROUTINE_LOG_LIMIT : 1000;
  logStore.logs = logs.slice(-limit);
  await writeRoutineLogStore(logStore);
};

const getZonedParts = (date = new Date(), timeZone = DEFAULT_ROUTINE_TIMEZONE) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
  };
};

const getZonedDateKey = (date = new Date(), timeZone = DEFAULT_ROUTINE_TIMEZONE) => {
  const parts = getZonedParts(date, timeZone);
  if (!parts.year || !parts.month || !parts.day) return "";
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const getZonedTimeKey = (date = new Date(), timeZone = DEFAULT_ROUTINE_TIMEZONE) => {
  const parts = getZonedParts(date, timeZone);
  if (!parts.hour || !parts.minute) return "";
  return `${parts.hour}:${parts.minute}`;
};

const getZonedWeekdayKey = (date = new Date(), timeZone = DEFAULT_ROUTINE_TIMEZONE) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  });
  const label = String(formatter.format(date) || "").toLowerCase();
  if (label.startsWith("mon")) return "monday";
  if (label.startsWith("tue")) return "tuesday";
  if (label.startsWith("wed")) return "wednesday";
  if (label.startsWith("thu")) return "thursday";
  if (label.startsWith("fri")) return "friday";
  if (label.startsWith("sat")) return "saturday";
  return "sunday";
};

const shiftDateKey = (dateKey, days) => {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, "0");
  const d = String(base.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const shiftDateKeyByMonths = (dateKey, monthsDelta) => {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const delta = Number.parseInt(String(monthsDelta || 0), 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(delta)
  ) {
    return "";
  }
  const targetMonthIndex = year * 12 + (month - 1) + delta;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonthZero = targetMonthIndex - targetYear * 12;
  const targetMonth = targetMonthZero + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return [
    String(targetYear).padStart(4, "0"),
    String(targetMonth).padStart(2, "0"),
    String(targetDay).padStart(2, "0"),
  ].join("-");
};

const formatDateKeyPtBr = (dateKey) => {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateKey || "";
  return `${match[3]}/${match[2]}/${match[1]}`;
};

const parseDateCandidate = (value) => {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const text = String(value).trim();
  if (!text) return null;

  const direct = new Date(text);
  if (Number.isFinite(direct.getTime())) return direct;

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const candidate = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T12:00:00Z`);
    if (Number.isFinite(candidate.getTime())) return candidate;
  }

  const brMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brMatch) {
    const candidate = new Date(`${brMatch[3]}-${brMatch[2]}-${brMatch[1]}T12:00:00Z`);
    if (Number.isFinite(candidate.getTime())) return candidate;
  }

  return null;
};

const extractCustomerDueDateKey = (row, timeZone = DEFAULT_ROUTINE_TIMEZONE) => {
  const candidates = [
    row?.expiresAtTz,
    row?.expires_at_tz,
    row?.expiresAt,
    row?.expires_at,
    row?.vencimento,
    row?.dueDate,
  ];
  for (const candidate of candidates) {
    const parsed = parseDateCandidate(candidate);
    if (parsed) {
      const key = getZonedDateKey(parsed, timeZone);
      if (key) return key;
    }
  }
  return "";
};

const extractCustomerCreatedDateKey = (row, timeZone = DEFAULT_ROUTINE_TIMEZONE) => {
  const candidates = [
    row?.createdAt,
    row?.created_at,
    row?.signupAt,
    row?.signup_at,
    row?.dateCreated,
    row?.date_created,
  ];
  for (const candidate of candidates) {
    const parsed = parseDateCandidate(candidate);
    if (parsed) {
      const key = getZonedDateKey(parsed, timeZone);
      if (key) return key;
    }
  }
  return "";
};

const isRoutineTrialPlan = (row) => {
  const planLabel = String(row?.packageName || row?.planoAtual || row?.planLabel || "").toUpperCase();
  return planLabel.includes("TESTE");
};

const normalizeRoutinePhone = (row) => {
  return normalizePhone(row?.whatsapp || row?.phone || row?.telefone || "");
};

const resolveRoutineTargetDateKey = (routine, now = new Date()) => {
  const timezone = String(routine?.timezone || DEFAULT_ROUTINE_TIMEZONE);
  const todayKey = getZonedDateKey(now, timezone);
  const rule = normalizeRoutineRule(routine?.rule);
  const ruleDays = normalizeRoutineRuleDays(rule, routine?.ruleDays);
  if (rule === "due_minus_1") return shiftDateKey(todayKey, ruleDays);
  if (rule === "due_plus_1") return shiftDateKey(todayKey, -ruleDays);
  if (rule === "after_signup_10") return todayKey;
  return todayKey;
};

const resolveRoutineScheduleForDate = (routine, date = new Date()) => {
  const timezone = String(routine?.timezone || DEFAULT_ROUTINE_TIMEZONE);
  const weekdayKey = getZonedWeekdayKey(date, timezone);
  const schedules = normalizeRoutineWeekdaySchedules(
    routine?.weekdaySchedules,
    routine?.runAt || "18:00",
    routine?.weekdaySchedules ?? null,
  );
  return {
    weekdayKey,
    schedule: schedules?.[weekdayKey] || { enabled: true, runAt: normalizeRoutineRunAt(routine?.runAt, "18:00") },
  };
};

const isRoutineExceptionDate = (routine, dateKey) => {
  const exceptions = normalizeRoutineExceptionDates(routine?.exceptionDates, []);
  return exceptions.includes(String(dateKey || "").trim());
};

const routineNeedsCheckoutToken = (routine) => {
  const values = [
    String(routine?.variable1 || ""),
    String(routine?.buttonVariable || ""),
    ...(Array.isArray(routine?.bodyVariables) ? routine.bodyVariables : []),
    ...(Array.isArray(routine?.buttonVariables) ? routine.buttonVariables : []),
    ...(Array.isArray(routine?.headerVariables) ? routine.headerVariables : []),
  ]
    .map((entry) => String(entry || ""))
    .join("\n");
  return (
    /\{\{\s*checkoutoken\s*\}\}/i.test(values) ||
    /\{\{\s*checkouttoken\s*\}\}/i.test(values) ||
    /\{\{\s*checkoutlink\s*\}\}/i.test(values)
  );
};

const resolveRoutineAmountLabel = (row) => {
  const value = row?.valor ?? row?.amount ?? null;
  if (value == null || value === "") return "";
  const number = Number(String(value).replace(",", "."));
  if (!Number.isFinite(number)) return String(value);
  return number.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
};

const resolveRoutineValueToken = ({ token, row, checkoutToken, checkoutLink, dueDateKey, todayDateKey }) => {
  const key = String(token || "").trim().toLowerCase();
  if (key === "nome") return String(row?.username || row?.usuario || row?.name || "").trim();
  if (key === "telefone") return String(normalizeRoutinePhone(row) || "").trim();
  if (key === "plano") return String(row?.packageName || row?.planoAtual || row?.planLabel || "").trim();
  if (key === "valor") return resolveRoutineAmountLabel(row);
  if (key === "vencimento") return formatDateKeyPtBr(dueDateKey || "");
  if (key === "dia_hoje") return formatDateKeyPtBr(todayDateKey || "");
  if (key === "checkoutoken") return String(checkoutToken || "");
  if (key === "checkouttoken") return String(checkoutToken || "");
  if (key === "checkoutlink") return String(checkoutLink || "");
  return "";
};

const applyRoutineVariables = ({ template, row, checkoutToken, checkoutLink, dueDateKey, todayDateKey }) => {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, tokenName) => {
    return resolveRoutineValueToken({
      token: tokenName,
      row,
      checkoutToken,
      checkoutLink,
      dueDateKey,
      todayDateKey,
    });
  });
};

const buildRoutineCheckoutData = async (row) => {
  const phone = normalizeRoutinePhone(row);
  if (!phone) throw new Error("Cliente sem telefone");
  const user = String(row?.username || row?.usuario || phone).trim();
  if (!user) throw new Error("Cliente sem usuario");

  const planMonths =
    sanitizeCheckoutPlanMonths(row?.planMonths) ||
    sanitizeCheckoutPlanMonths(parsePlanMonths(row?.packageName || row?.planoAtual || "")) ||
    1;
  const connectionsRaw = Number(row?.connections ?? row?.conexoes ?? 1);
  const connections = Number.isFinite(connectionsRaw)
    ? Math.min(4, Math.max(1, Math.round(connectionsRaw)))
    : 1;

  const created = await createCheckoutToken({
    user,
    whatsapp: phone,
    plan: planMonths,
    connections,
  });
  const checkoutLink = CHECKOUT_PUBLIC_URL
    ? `${CHECKOUT_PUBLIC_URL}?token=${encodeURIComponent(created.token)}`
    : null;
  return {
    checkoutToken: created.token,
    checkoutLink,
    expiresAt: created.expiresAt || null,
  };
};

const normalizeRoutineLabelNameKey = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const buildRoutineCustomerIdentityKeys = (row = {}, phone = "") => {
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  return Array.from(
    new Set(
      [
        row?.contactId,
        row?.contact_id,
        row?.customerId,
        row?.customer_id,
        row?.id,
        row?.username,
        row?.usuario,
        raw?.contactId,
        raw?.contact_id,
        raw?.customerId,
        raw?.customer_id,
        raw?.id,
        raw?.username,
        raw?.usuario,
        phone ? `phone:${phone}` : "",
      ]
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  );
};

const buildRenovadosErradoRoutineValidationContext = async () => {
  if (!ROUTINE_RENOVADOS_ERRADO_VALIDATION_ENABLED) {
    return { enabled: false, label: null, phones: new Set(), identityKeys: new Set(), contacts: [] };
  }

  const expectedLabelName = normalizeRoutineLabelNameKey(ROUTINE_RENOVADOS_ERRADO_LABEL_NAME);
  if (!expectedLabelName) {
    return { enabled: true, label: null, phones: new Set(), identityKeys: new Set(), contacts: [] };
  }

  const labels = await listLabels();
  const label = labels.find((item) => normalizeRoutineLabelNameKey(item?.name) === expectedLabelName) || null;
  if (!label?.id) {
    return { enabled: true, label: null, phones: new Set(), identityKeys: new Set(), contacts: [] };
  }

  const response = await listLabelContacts(label.id);
  const contacts = Array.isArray(response?.contacts) ? response.contacts : [];
  const phones = new Set();
  const identityKeys = new Set();

  for (const contact of contacts) {
    const phone = normalizePhone(contact?.number || "");
    if (phone) {
      phones.add(phone);
      identityKeys.add(`phone:${phone}`);
    }
    [contact?.id, contact?.lookupKey, contact?.conversationId]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .forEach((item) => identityKeys.add(item));
  }

  return { enabled: true, label, phones, identityKeys, contacts };
};

const customerMatchesRenovadosErradoContext = (row, phone, context) => {
  if (!context?.enabled || !context?.label) return false;
  if (phone && context.phones?.has(phone)) return true;
  return buildRoutineCustomerIdentityKeys(row, phone).some((key) => context.identityKeys?.has(key));
};

const resolveRoutinePlanMonthsFromRow = (row = {}) => {
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  const direct = Number(
    row?.checkoutPlanMonths ??
      row?.planMonths ??
      row?.plan_months ??
      row?.months ??
      row?.planoMeses ??
      raw?.checkoutPlanMonths ??
      raw?.planMonths ??
      raw?.plan_months ??
      raw?.months ??
      raw?.planoMeses,
  );
  if (Number.isFinite(direct) && direct > 0) return Math.min(24, Math.max(1, Math.round(direct)));

  const planText = [
    row?.checkoutPlanLabel,
    row?.planLabel,
    row?.packageName,
    row?.planoAtual,
    row?.package,
    row?.package_name,
    row?.plan,
    raw?.checkoutPlanLabel,
    raw?.planLabel,
    raw?.packageName,
    raw?.planoAtual,
    raw?.package,
    raw?.package_name,
    raw?.plan,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" ");
  const parsed = parsePlanMonths(planText);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(24, Math.max(1, Math.round(parsed))) : null;
};

const buildRenovadosErradoRoutineCorrection = ({ row, dueDateKey }) => {
  const planMonths = resolveRoutinePlanMonthsFromRow(row);
  if (!dueDateKey || !planMonths) {
    return {
      applies: true,
      planMonths: planMonths || null,
      originalDueDateKey: dueDateKey || "",
      effectiveDueDateKey: "",
      reason: planMonths ? "missing_due_date" : "missing_plan_months",
    };
  }
  return {
    applies: true,
    planMonths,
    originalDueDateKey: dueDateKey,
    effectiveDueDateKey: shiftDateKeyByMonths(dueDateKey, -planMonths),
    reason: "adjusted_by_plan_months",
  };
};

const collectRoutineCandidates = async (routine, options = {}) => {
  const routineType = normalizeRoutineType(routine?.type || "dispatch");
  const timezone = String(routine?.timezone || DEFAULT_ROUTINE_TIMEZONE);
  const targetDateKey = routineType === "label" ? "" : resolveRoutineTargetDateKey(routine);
  const nowDateKey = getZonedDateKey(new Date(), timezone);
  const limitValue = Number.isFinite(Number(options?.limit)) ? Number(options.limit) : null;
  const limit = limitValue && limitValue > 0 ? Math.round(limitValue) : null;
  const painelStore = await readPainelStore();
  const rows = Object.values(painelStore?.customers || {});
  const seenPhones = new Set();
  const allCandidates = [];
  const renovadosErradoContext =
    routineType === "dispatch" ? await buildRenovadosErradoRoutineValidationContext() : null;

  if (isRoutineExceptionDate(routine, nowDateKey)) {
    return {
      timezone,
      targetDateKey,
      nowDateKey,
      allCandidates,
      selected: [],
      skippedByException: true,
    };
  }

  if (routineType === "label") {
    const labelsToRemove = normalizeRoutineLabelIds(routine?.labelsToRemove, []);
    if (labelsToRemove.length > 0) {
      for (const labelId of labelsToRemove) {
        const response = await listLabelContacts(labelId);
        for (const contact of Array.isArray(response?.contacts) ? response.contacts : []) {
          if (!contact || contact.isTeste) continue;
          const phone = normalizePhone(contact.number || "");
          if (!phone || seenPhones.has(phone)) continue;
          seenPhones.add(phone);
          allCandidates.push({
            row: {
              username: contact.name || null,
              usuario: contact.name || null,
              packageName: null,
              planoAtual: null,
              amount: null,
            },
            phone,
            dueDateKey: "",
            contact,
          });
        }
      }
      return {
        timezone,
        targetDateKey,
        nowDateKey,
        allCandidates,
        selected: limit ? allCandidates.slice(0, limit) : allCandidates,
        skippedByException: false,
      };
    }

    const contacts = await listResolvedContacts();
    for (const contact of Array.isArray(contacts) ? contacts : []) {
      if (!contact || contact.isTeste) continue;
      const phone = normalizePhone(contact.number || "");
      if (!phone || seenPhones.has(phone)) continue;
      seenPhones.add(phone);
      allCandidates.push({
        row: {
          username: contact.name || null,
          usuario: contact.name || null,
          packageName: null,
          planoAtual: null,
          amount: null,
        },
        phone,
        dueDateKey: "",
        contact,
      });
    }
    return {
      timezone,
      targetDateKey,
      nowDateKey,
      allCandidates,
      selected: limit ? allCandidates.slice(0, limit) : allCandidates,
      skippedByException: false,
    };
  }

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (isRoutineTrialPlan(row)) continue;
    const phone = normalizeRoutinePhone(row);
    if (!phone || seenPhones.has(phone)) continue;
    const rule = normalizeRoutineRule(routine?.rule);
    const ruleDays = normalizeRoutineRuleDays(rule, routine?.ruleDays);
    let dueDateKey = "";
    let candidateRow = row;
    if (rule === "after_signup_10") {
      const createdDateKey = extractCustomerCreatedDateKey(row, timezone);
      if (!createdDateKey) continue;
      dueDateKey = shiftDateKey(createdDateKey, ruleDays);
    } else {
      dueDateKey = extractCustomerDueDateKey(row, timezone);
      if (customerMatchesRenovadosErradoContext(row, phone, renovadosErradoContext)) {
        const correction = buildRenovadosErradoRoutineCorrection({ row, dueDateKey });
        if (!correction.effectiveDueDateKey) continue;
        dueDateKey = correction.effectiveDueDateKey;
        candidateRow = {
          ...row,
          routineRenovadosErradoValidation: {
            labelId: renovadosErradoContext?.label?.id || null,
            labelName: renovadosErradoContext?.label?.name || ROUTINE_RENOVADOS_ERRADO_LABEL_NAME,
            ...correction,
          },
        };
      }
    }
    if (!dueDateKey || dueDateKey !== targetDateKey) continue;
    seenPhones.add(phone);
    allCandidates.push({ row: candidateRow, phone, dueDateKey });
  }

  return {
    timezone,
    targetDateKey,
    nowDateKey,
    allCandidates,
    selected: limit ? allCandidates.slice(0, limit) : allCandidates,
    skippedByException: false,
  };
};

const buildRoutineLabelActionSummary = ({ labelsToAdd = [], labelsToRemove = [], labelsById = new Map() }) => {
  const segments = [];
  if (Array.isArray(labelsToAdd) && labelsToAdd.length > 0) {
    segments.push(
      `Adicionar: ${labelsToAdd.map((labelId) => labelsById.get(labelId)?.name || labelId).join(", ")}`,
    );
  }
  if (Array.isArray(labelsToRemove) && labelsToRemove.length > 0) {
    segments.push(
      `Remover: ${labelsToRemove.map((labelId) => labelsById.get(labelId)?.name || labelId).join(", ")}`,
    );
  }
  return segments.join(" | ");
};

const mapRoutineContactsByPhone = async () => {
  const contacts = await listResolvedContacts();
  const contactsByPhone = new Map();
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const phone = normalizePhone(contact?.number || "");
    if (!phone || contactsByPhone.has(phone)) continue;
    contactsByPhone.set(phone, contact);
  }
  return contactsByPhone;
};

const buildRoutinePreviewPayload = async (routine, options = {}) => {
  const routineType = normalizeRoutineType(routine?.type || "dispatch");
  const timezone = String(routine?.timezone || DEFAULT_ROUTINE_TIMEZONE);
  const { targetDateKey, nowDateKey, allCandidates, selected, skippedByException } =
    await collectRoutineCandidates(routine, options);

  if (skippedByException) {
    return {
      routineId: routine.id,
      routineTitle: routine.title,
      runDate: nowDateKey,
      targetDate: targetDateKey,
      totalTargets: 0,
      previewedTargets: 0,
      readyCount: 0,
      failedCount: 0,
      hasMore: false,
      items: [],
    };
  }

  if (routineType === "label") {
    const [labels, contactsByPhone] = await Promise.all([listLabels(), mapRoutineContactsByPhone()]);
    const labelsById = new Map(labels.map((label) => [String(label.id), label]));
    const labelsToAdd = normalizeRoutineLabelIds(routine?.labelsToAdd, []);
    const labelsToRemove = normalizeRoutineLabelIds(routine?.labelsToRemove, [])
      .filter((labelId) => !labelsToAdd.includes(labelId));
    const actionSummary = buildRoutineLabelActionSummary({ labelsToAdd, labelsToRemove, labelsById });
    const items = selected.map((candidate) => {
      const phone = candidate.phone;
      const contact = candidate.contact || contactsByPhone.get(phone) || null;
      const status = contact ? "ready" : "error";
      return {
        contactId: contact?.id || null,
        contactExists: Boolean(contact),
        phone,
        username: candidate.row?.username || candidate.row?.usuario || contact?.name || null,
        planLabel: candidate.row?.packageName || candidate.row?.planoAtual || null,
        amount: resolveRoutineAmountLabel(candidate.row),
        dueDate: formatDateKeyPtBr(candidate.dueDateKey),
        actionSummary: actionSummary || null,
        labelsToAdd,
        labelsToRemove,
        status,
        error: contact ? null : "Contato nao encontrado na base local para alterar etiquetas",
      };
    });

    const readyCount = items.filter((item) => item.status === "ready").length;
    const failedCount = items.length - readyCount;

    return {
      routineId: routine.id,
      routineTitle: routine.title,
      runDate: nowDateKey,
      targetDate: targetDateKey,
      totalTargets: allCandidates.length,
      previewedTargets: items.length,
      readyCount,
      failedCount,
      hasMore: allCandidates.length > items.length,
      items,
    };
  }

  const requiresCheckoutToken = routineNeedsCheckoutToken(routine);
  const bodyTemplates = normalizeRoutineVarList(
    routine?.bodyVariables,
    routine?.variable1 ? [routine.variable1] : ["{{dia_hoje}}"],
  );
  const buttonTemplates = normalizeRoutineVarList(
    routine?.buttonVariables,
    routine?.buttonVariable ? [routine.buttonVariable] : [],
  );
  const headerTemplates = normalizeRoutineVarList(routine?.headerVariables, []);
  const headerFormat = normalizeRoutineHeaderFormat(routine?.headerFormat, "");
  const alternativeTemplate = await findRoutineAlternativeTemplate(routine);
  const messageStore = await readStore();
  const hasAlternativeTemplateConfigured = Boolean(
    String(routine?.alternativeTemplateId || "").trim() ||
    String(routine?.alternativeTemplateName || "").trim(),
  );
  const items = [];

  for (const candidate of selected) {
    const { row, phone, dueDateKey } = candidate;
    let checkoutToken = null;
    let checkoutLink = null;
    let status = "ready";
    let error = null;

    try {
      if (requiresCheckoutToken) {
        const checkoutData = await buildRoutineCheckoutData(row);
        checkoutToken = checkoutData.checkoutToken;
        checkoutLink = checkoutData.checkoutLink;
      }
    } catch (tokenError) {
      status = "error";
      error = tokenError?.message || "Falha ao gerar checkout token";
    }

    const bodyParameters = bodyTemplates.map((item) =>
      applyRoutineVariables({
        template: item,
        row,
        checkoutToken,
        checkoutLink,
        dueDateKey,
        todayDateKey: nowDateKey,
      }).trim(),
    );
    const buttonParameters = buttonTemplates.map((item) =>
      applyRoutineVariables({
        template: item,
        row,
        checkoutToken,
        checkoutLink,
        dueDateKey,
        todayDateKey: nowDateKey,
      }).trim(),
    );
    const headerParameters = headerTemplates.map((item) =>
      applyRoutineVariables({
        template: item,
        row,
        checkoutToken,
        checkoutLink,
        dueDateKey,
        todayDateKey: nowDateKey,
      }).trim(),
    );
    const conversationState = await getRoutineConversationWindowState(phone, new Date(), messageStore);
    const useAlternativeTemplate = Boolean(alternativeTemplate && conversationState.within24hWindow);
    let previewText = "";
    let alternativePayload = null;

    if (status !== "error" && bodyParameters.some((item) => !String(item).trim())) {
      status = "error";
      error = "Parametros do corpo vazios";
    }
    if (status !== "error" && buttonParameters.some((item) => !String(item).trim())) {
      status = "error";
      error = "Parametros de botao vazios";
    }
    if (status !== "error" && headerParameters.some((item) => !String(item).trim())) {
      status = "error";
      error = "Parametros de header vazios";
    }
    if (
      status !== "error" &&
      conversationState.within24hWindow &&
      hasAlternativeTemplateConfigured &&
      !alternativeTemplate
    ) {
      status = "error";
      error = "Template alternativo configurado, mas nao encontrado";
    }

    if (status !== "error" && useAlternativeTemplate) {
      alternativePayload = buildRoutineAlternativeTemplatePayload({
        template: alternativeTemplate,
        row,
        checkoutToken,
        checkoutLink,
        dueDateKey,
        todayDateKey: nowDateKey,
      });
      if (!alternativePayload.text && !alternativePayload.headerMediaUrl) {
        status = "error";
        error = "Template alternativo sem conteudo para envio";
      } else {
        previewText = alternativePayload.text;
      }
    } else {
      previewText = await buildTemplatePreviewText({
        templateName: routine?.templateName,
        language: routine?.templateLanguage || "pt_BR",
        bodyParameters,
        headerParameters,
        buttonParameters,
      });
    }

    items.push({
      phone,
      username: row?.username || row?.usuario || null,
      planLabel: row?.packageName || row?.planoAtual || null,
      amount: resolveRoutineAmountLabel(row),
      dueDate: formatDateKeyPtBr(dueDateKey),
      originalDueDate:
        row?.routineRenovadosErradoValidation?.originalDueDateKey
          ? formatDateKeyPtBr(row.routineRenovadosErradoValidation.originalDueDateKey)
          : null,
      effectiveDueDate:
        row?.routineRenovadosErradoValidation?.effectiveDueDateKey
          ? formatDateKeyPtBr(row.routineRenovadosErradoValidation.effectiveDueDateKey)
          : null,
      renovadosErradoValidation: row?.routineRenovadosErradoValidation || null,
      variable1: bodyParameters[0] || null,
      buttonParam: buttonParameters[0] || null,
      bodyParameters,
      buttonParameters,
      headerParameters,
      headerFormat: headerFormat || null,
      checkoutToken,
      checkoutLink,
      previewText: previewText || null,
      sendMode: useAlternativeTemplate ? "internal_template_24h" : "meta_template",
      sendModeLabel: useAlternativeTemplate
        ? `Template interno 24h${alternativeTemplate?.name ? `: ${alternativeTemplate.name}` : ""}`
        : "Template Meta",
      within24hWindow: conversationState.within24hWindow,
      internalHeaderType: alternativePayload?.headerType || null,
      internalHeaderMediaUrl: alternativePayload?.headerMediaUrl || null,
      status,
      error,
    });
  }

  const readyCount = items.filter((item) => item.status === "ready").length;
  const failedCount = items.length - readyCount;

  return {
    routineId: routine.id,
    routineTitle: routine.title,
    runDate: nowDateKey,
    targetDate: targetDateKey,
    totalTargets: allCandidates.length,
    previewedTargets: items.length,
    readyCount,
    failedCount,
    hasMore: Boolean(options?.limit && allCandidates.length > items.length),
    items,
  };
};

const markRoutineRun = async ({ routineId, summary, runKey }) => {
  const store = await readRoutineStore();
  const list = Array.isArray(store.routines) ? store.routines : [];
  const index = list.findIndex((item) => item?.id === routineId);
  if (index < 0) return null;
  const current = list[index];
  list[index] = {
    ...current,
    lastRunAt: new Date().toISOString(),
    lastRunKey: runKey || current?.lastRunKey || null,
    lastRunSummary: summary || null,
    updatedAt: new Date().toISOString(),
  };
  store.routines = list;
  await writeRoutineStore(store);
  return list[index];
};

const META_TEMPLATE_CACHE_TTL_MS = Number.parseInt(
  process.env.WHATSAPP_TEMPLATE_PREVIEW_CACHE_TTL_MS || "300000",
  10,
);
let metaTemplatePreviewCache = {
  items: null,
  at: 0,
  loading: null,
};

const applyIndexedTemplateParams = (text, parameters = []) =>
  String(text || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_, rawIndex) => {
    const index = Number.parseInt(String(rawIndex || "0"), 10) - 1;
    if (!Number.isFinite(index) || index < 0) return "";
    return String(parameters[index] || "");
  });

const listMetaTemplatesForPreview = async ({ force = false } = {}) => {
  const ttl = Number.isFinite(META_TEMPLATE_CACHE_TTL_MS) && META_TEMPLATE_CACHE_TTL_MS > 0
    ? META_TEMPLATE_CACHE_TTL_MS
    : 300000;
  if (!force && Array.isArray(metaTemplatePreviewCache.items) && Date.now() - metaTemplatePreviewCache.at < ttl) {
    return metaTemplatePreviewCache.items;
  }
  if (metaTemplatePreviewCache.loading) {
    return metaTemplatePreviewCache.loading;
  }
  metaTemplatePreviewCache.loading = (async () => {
    const { accessToken, wabaId } = await resolveMetaConfig();
    if (!accessToken || !wabaId) return [];
    let templates = [];
    let nextUrl = new URL(`https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates`);
    nextUrl.searchParams.set("fields", "name,language,status,category,components");
    nextUrl.searchParams.set("limit", "250");
    nextUrl.searchParams.set("access_token", accessToken);
    let pageCount = 0;
    while (nextUrl) {
      const response = await fetch(nextUrl.toString(), {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error?.message || "WhatsApp template list error");
      }
      if (Array.isArray(data?.data)) {
        templates = templates.concat(data.data);
      }
      const next = data?.paging?.next;
      if (next && pageCount < 20) {
        nextUrl = new URL(next);
        pageCount += 1;
      } else {
        nextUrl = null;
      }
    }
    metaTemplatePreviewCache.items = templates;
    metaTemplatePreviewCache.at = Date.now();
    return templates;
  })();
  try {
    return await metaTemplatePreviewCache.loading;
  } finally {
    metaTemplatePreviewCache.loading = null;
  }
};

const findMetaTemplateForPreview = async ({ templateName, language }) => {
  const normalizedName = String(templateName || "").trim().toLowerCase();
  if (!normalizedName) return null;
  const normalizedLanguage = String(language || "pt_BR").trim().toLowerCase();
  const templates = await listMetaTemplatesForPreview();
  return (
    templates.find(
      (template) =>
        String(template?.name || "").trim().toLowerCase() === normalizedName &&
        String(template?.language || "pt_BR").trim().toLowerCase() === normalizedLanguage,
    ) ||
    templates.find((template) => String(template?.name || "").trim().toLowerCase() === normalizedName) ||
    null
  );
};

const buildTemplatePreviewText = async ({
  templateName,
  language,
  bodyParameters = [],
  headerParameters = [],
  buttonParameters = [],
}) => {
  const normalizedBodyParameters = Array.isArray(bodyParameters) ? bodyParameters.map((value) => String(value || "")) : [];
  const normalizedHeaderParameters = Array.isArray(headerParameters)
    ? headerParameters.map((value) => String(value || ""))
    : [];
  const normalizedButtonParameters = Array.isArray(buttonParameters)
    ? buttonParameters.map((value) => String(value || ""))
    : [];
  try {
    const template = await findMetaTemplateForPreview({ templateName, language });
    if (!template?.components?.length) {
      return normalizedBodyParameters.find((value) => value.trim()) || "";
    }

    const bodyComponent = template.components.find(
      (component) => String(component?.type || "").toUpperCase() === "BODY",
    );
    const headerComponent = template.components.find(
      (component) => String(component?.type || "").toUpperCase() === "HEADER",
    );
    const buttonsComponent = template.components.find(
      (component) => String(component?.type || "").toUpperCase() === "BUTTONS",
    );

    const headerFormat = String(headerComponent?.format || "").toUpperCase();
    const headerText =
      headerFormat === "TEXT"
        ? applyIndexedTemplateParams(String(headerComponent?.text || ""), normalizedHeaderParameters).trim()
        : "";
    const bodyText = applyIndexedTemplateParams(String(bodyComponent?.text || ""), normalizedBodyParameters).trim();
    const buttonUrlTemplate = Array.isArray(buttonsComponent?.buttons)
      ? buttonsComponent.buttons.find((button) => String(button?.type || "").toUpperCase() === "URL")?.url
      : "";
    const buttonUrl = applyIndexedTemplateParams(String(buttonUrlTemplate || ""), normalizedButtonParameters).trim();

    return [headerText, bodyText, buttonUrl ? `Link botao: ${buttonUrl}` : ""]
      .filter(Boolean)
      .join("\n")
      .trim();
  } catch (error) {
    console.warn("[templates] preview fallback:", error?.message || error);
    return normalizedBodyParameters.find((value) => value.trim()) || "";
  }
};

const buildTemplateButtonPreviewItems = async ({
  templateName,
  language,
  buttonParameters = [],
}) => {
  const normalizedButtonParameters = Array.isArray(buttonParameters)
    ? buttonParameters.map((value) => String(value || ""))
    : [];
  try {
    const template = await findMetaTemplateForPreview({ templateName, language });
    const buttonsComponent = Array.isArray(template?.components)
      ? template.components.find((component) => String(component?.type || "").toUpperCase() === "BUTTONS")
      : null;
    const templateButtons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : [];
    return templateButtons
      .map((button, index) => {
        const type = String(button?.type || "").trim().toUpperCase();
        const text = String(button?.text || button?.label || "").trim();
        const urlTemplate = String(button?.url || "").trim();
        const url = type === "URL"
          ? applyIndexedTemplateParams(urlTemplate, normalizedButtonParameters).trim()
          : "";
        if (!text && !url) return null;
        return {
          id: `template-button-${index}`,
          index,
          type: type.toLowerCase() || "button",
          label: text || "Abrir link",
          text: text || "Abrir link",
          url: url || undefined,
          value: normalizedButtonParameters[index] || undefined,
          agentOnly: true,
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.warn("[templates] button preview fallback:", error?.message || error);
    return [];
  }
};

const persistTemplateMessageAsAgent = async ({
  phone,
  text,
  responseMessageId,
  templateName,
  language,
  bodyParameters,
  buttonParameters,
  headerFormat,
  headerParameters,
}) => {
  const normalizedHeaderFormat = String(headerFormat || "").toUpperCase();
  const firstHeaderParam = Array.isArray(headerParameters) ? String(headerParameters[0] || "").trim() : "";
  const headerMediaLink =
    normalizedHeaderFormat && normalizedHeaderFormat !== "TEXT"
      ? normalizeTemplateMediaLink(firstHeaderParam)
      : "";
  const templateAttachments = [];
  if (normalizedHeaderFormat === "IMAGE" && headerMediaLink) {
    templateAttachments.push({
      id: `tpl-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "image",
      url: headerMediaLink,
      name: "Template header image",
    });
  }
  const templateLabel = String(templateName || "").trim();
  const previewText = String(text || "").trim();
  const renderedPreviewText =
    previewText ||
    (await buildTemplatePreviewText({
      templateName,
      language,
      bodyParameters,
      headerParameters,
      buttonParameters,
    }));
  const persistedText =
    renderedPreviewText || (templateLabel ? `Template: ${templateLabel}` : "Template enviado");
  const templateButtons = await buildTemplateButtonPreviewItems({
    templateName,
    language,
    buttonParameters,
  });

  await upsertAgentMessage({
    to: normalizePhone(phone) || phone,
    text: persistedText,
    messageId: responseMessageId || null,
    attachments: templateAttachments,
    templateButtons,
    origin: "routine",
  });
  await markRoutineConversationAsBroadcast(phone);
};

const sendRoutineAlternativeTemplateMessage = async ({
  phone,
  payload,
}) => {
  const normalizedTo = normalizePhone(phone) || String(phone || "").trim();
  if (!normalizedTo) {
    throw new Error("Cliente sem telefone");
  }
  const messageText = String(payload?.text || "").trim();
  const headerType = String(payload?.headerType || "none").trim().toLowerCase();
  const headerMediaUrl = normalizeTemplateMediaLink(String(payload?.headerMediaUrl || "").trim());
  let result = null;
  let responseMessageId = null;

  if (["image", "video", "document"].includes(headerType) && headerMediaUrl) {
    result = await sendMediaMessage({
      to: normalizedTo,
      mediaType: headerType,
      mediaLink: headerMediaUrl,
      caption: messageText || undefined,
    });
    responseMessageId = result?.messages?.[0]?.id || null;
    await upsertAgentMessage({
      to: normalizedTo,
      text: messageText || `[${headerType}]`,
      messageId: responseMessageId,
      attachments: [
        {
          id: `routine-alt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: headerType,
          url: headerMediaUrl,
          name: payload?.templateName || "Template alternativo",
        },
      ],
      origin: "routine",
    });
  } else {
    if (!messageText) {
      throw new Error("Template alternativo sem conteudo para envio");
    }
    result = await sendTextMessage({ to: normalizedTo, text: messageText });
    responseMessageId = result?.messages?.[0]?.id || null;
    await upsertAgentMessage({
      to: normalizedTo,
      text: messageText,
      messageId: responseMessageId,
      origin: "routine",
    });
  }

  await markRoutineConversationAsBroadcast(normalizedTo);
  return {
    result,
    responseMessageId,
    previewText: messageText,
  };
};

const routineInFlight = new Set();
const routineSchedulerQueue = [];
const routineSchedulerQueuedKeys = new Set();
let routineSchedulerQueueBusy = false;

const executeRoutineNow = async (routine, options = {}) => {
  if (!routine || !routine.id) throw new Error("Routine not found");
  if (routineInFlight.has(routine.id)) {
    throw new Error("Rotina em execucao");
  }
  routineInFlight.add(routine.id);
  try {
    const routineType = normalizeRoutineType(routine?.type || "dispatch");
    const preview = await buildRoutinePreviewPayload(routine, {
      limit: options?.limit,
    });
    await appendRoutineLog({
      routineId: routine.id,
      routineTitle: routine.title,
      level: "info",
      message: `Execucao iniciada. Alvos: ${preview.totalTargets}. Prontos: ${preview.readyCount}.`,
    });

    if (routineType === "label") {
      let sent = 0;
      let failed = 0;
      const labelsToAdd = normalizeRoutineLabelIds(routine?.labelsToAdd, []);
      const labelsToRemove = normalizeRoutineLabelIds(routine?.labelsToRemove, [])
        .filter((labelId) => !labelsToAdd.includes(labelId));

      for (const item of preview.items) {
        if (item.status !== "ready" || !item.contactId) {
          failed += 1;
          continue;
        }
        try {
          if (labelsToAdd.length > 0) {
            await addContactLabelsById(item.contactId, labelsToAdd);
          }
          if (labelsToRemove.length > 0) {
            await removeContactLabelsById(item.contactId, labelsToRemove);
          }
          sent += 1;
        } catch (applyError) {
          failed += 1;
          await appendRoutineLog({
            routineId: routine.id,
            routineTitle: routine.title,
            level: "error",
            message: `Falha ao alterar etiquetas de ${item.phone}: ${applyError?.message || "Erro desconhecido"}`,
          });
        }
      }

      const summary = {
        total: preview.totalTargets,
        sent,
        failed,
      };
      await markRoutineRun({
        routineId: routine.id,
        summary,
        runKey: options?.runKey || null,
      });
      await appendRoutineLog({
        routineId: routine.id,
        routineTitle: routine.title,
        level: failed > 0 ? "info" : "success",
        message: `Rotina de etiqueta finalizada. Total: ${summary.total} | Alterados: ${summary.sent} | Falha: ${summary.failed}.`,
      });
      return { summary, preview };
    }

    let sent = 0;
    let failed = 0;
    const sendIntervalSeconds = normalizeRoutineSendIntervalSeconds(
      routine?.sendIntervalSeconds,
      ROUTINE_DEFAULT_SEND_INTERVAL_SECONDS,
    );
    const readyItems = preview.items.filter((item) => item.status === "ready");
    let attemptedReady = 0;
    const alternativeTemplate = await findRoutineAlternativeTemplate(routine);
    for (const item of preview.items) {
      if (item.status !== "ready") {
        failed += 1;
        continue;
      }
      attemptedReady += 1;
      try {
        await appendMessageDeliveryLog({
          category: "message-send",
          level: "info",
          source: "routine-dispatch",
          event: "routine-dispatch-requested",
          to: item.phone,
          templateName:
            item.sendMode === "internal_template_24h"
              ? routine.alternativeTemplateName || routine.alternativeTemplateId || null
              : routine.templateName || null,
          message:
            item.sendMode === "internal_template_24h"
              ? `Tentativa de envio do template interno 24h da rotina para ${item.phone}.`
              : `Tentativa de envio de template da rotina para ${item.phone}.`,
        });
        let responseMessageId = null;
        if (item.sendMode === "internal_template_24h") {
          if (!alternativeTemplate) {
            throw new Error("Template alternativo da rotina nao encontrado");
          }
          const internalSend = await sendRoutineAlternativeTemplateMessage({
            phone: item.phone,
            payload: {
              templateName: alternativeTemplate.name || routine.alternativeTemplateName || "Template alternativo",
              text: item.previewText || "",
              headerType: item.internalHeaderType || "none",
              headerMediaUrl: item.internalHeaderMediaUrl || "",
            },
          });
          responseMessageId = internalSend.responseMessageId || null;
        } else {
          const result = await sendTemplateMessage({
            to: item.phone,
            parameters: Array.isArray(item.bodyParameters)
              ? item.bodyParameters
              : [item.variable1 || ""],
            buttonParameters: Array.isArray(item.buttonParameters) && item.buttonParameters.length > 0
              ? item.buttonParameters
              : undefined,
            headerParameters: Array.isArray(item.headerParameters) && item.headerParameters.length > 0
              ? item.headerParameters
              : undefined,
            headerFormat: item.headerFormat || undefined,
            templateName: routine.templateName,
            language: routine.templateLanguage || "pt_BR",
          });
          responseMessageId = result?.messages?.[0]?.id;
          const routinePreviewText =
            await buildTemplatePreviewText({
              templateName: routine.templateName,
              language: routine.templateLanguage || "pt_BR",
              bodyParameters: Array.isArray(item.bodyParameters) ? item.bodyParameters : [item.variable1 || ""],
              headerParameters: Array.isArray(item.headerParameters) ? item.headerParameters : [],
              buttonParameters: Array.isArray(item.buttonParameters) ? item.buttonParameters : [],
            });
          await persistTemplateMessageAsAgent({
            phone: item.phone,
            text: routinePreviewText,
            responseMessageId,
            templateName: routine.templateName,
            language: routine.templateLanguage || "pt_BR",
            bodyParameters: Array.isArray(item.bodyParameters) ? item.bodyParameters : [item.variable1 || ""],
            buttonParameters: Array.isArray(item.buttonParameters) ? item.buttonParameters : [],
            headerFormat: item.headerFormat || null,
            headerParameters: Array.isArray(item.headerParameters) ? item.headerParameters : [],
          });
        }
        await appendMessageDeliveryLog({
          category: "message-send",
          level: "success",
          source: "routine-dispatch",
          event: "routine-dispatch-success",
          to: item.phone,
          messageId: responseMessageId || null,
          templateName:
            item.sendMode === "internal_template_24h"
              ? routine.alternativeTemplateName || routine.alternativeTemplateId || null
              : routine.templateName || null,
          message:
            item.sendMode === "internal_template_24h"
              ? `Template interno 24h da rotina enviado para ${item.phone}.`
              : `Template da rotina enviado para ${item.phone}.`,
        });
        sent += 1;
      } catch (sendError) {
        await appendMessageDeliveryLog({
          category: "message-send",
          level: "error",
          source: "routine-dispatch",
          event: "routine-dispatch-failed",
          to: item.phone,
          templateName: routine.templateName || null,
          errorReason: sendError?.message || "Erro desconhecido",
          message: `Falha ao enviar template da rotina para ${item.phone}: ${sendError?.message || "Erro desconhecido"}`,
        });
        failed += 1;
        await appendRoutineLog({
          routineId: routine.id,
          routineTitle: routine.title,
          level: "error",
          message: `Falha ao enviar para ${item.phone}: ${sendError?.message || "Erro desconhecido"}`,
        });
      }
      const hasNextReady = attemptedReady < readyItems.length;
      if (hasNextReady && sendIntervalSeconds > 0) {
        await new Promise((resolve) => setTimeout(resolve, sendIntervalSeconds * 1000));
      }
    }

    const summary = {
      total: preview.totalTargets,
      sent,
      failed,
    };
    await markRoutineRun({
      routineId: routine.id,
      summary,
      runKey: options?.runKey || null,
    });
    await appendRoutineLog({
      routineId: routine.id,
      routineTitle: routine.title,
      level: failed > 0 ? "info" : "success",
      message: `Execucao finalizada. Total: ${summary.total} | OK: ${summary.sent} | Falha: ${summary.failed}.`,
    });
    return { summary, preview };
  } finally {
    routineInFlight.delete(routine.id);
  }
};

const enqueueRoutineExecution = (routine, options = {}) => {
  if (!routine?.id) return;
  const queueKey = `${routine.id}::${String(options?.runKey || "")}`;
  if (routineSchedulerQueuedKeys.has(queueKey)) return;
  routineSchedulerQueuedKeys.add(queueKey);
  routineSchedulerQueue.push({
    routine,
    options,
    queueKey,
  });
};

const drainRoutineExecutionQueue = async () => {
  if (routineSchedulerQueueBusy) return;
  routineSchedulerQueueBusy = true;
  try {
    while (routineSchedulerQueue.length > 0) {
      const current = routineSchedulerQueue.shift();
      if (!current?.routine?.id) continue;
      try {
        await executeRoutineNow(current.routine, current.options || {});
      } catch (error) {
        await appendRoutineLog({
          routineId: current.routine.id,
          routineTitle: current.routine.title,
          level: "error",
          message: `Falha na execucao agendada: ${error?.message || "Erro desconhecido"}`,
        });
      } finally {
        routineSchedulerQueuedKeys.delete(current.queueKey);
      }
    }
  } finally {
    routineSchedulerQueueBusy = false;
  }
};

const runRoutineSchedulerTick = async () => {
  const store = await readRoutineStore();
  const routines = Array.isArray(store.routines) ? store.routines : [];
  if (!routines.length) return;

  const dueRoutines = [];

  for (const routine of routines) {
    if (!routine || normalizeRoutineStatus(routine.status) !== "active") continue;
    const timezone = String(routine.timezone || DEFAULT_ROUTINE_TIMEZONE);
    const now = new Date();
    const nowTime = getZonedTimeKey(now, timezone);
    const nowDate = getZonedDateKey(now, timezone);
    if (isRoutineExceptionDate(routine, nowDate)) continue;
    const { schedule } = resolveRoutineScheduleForDate(routine, now);
    const runAt = normalizeRoutineRunAt(schedule?.runAt || routine.runAt, "");
    if (!schedule?.enabled) continue;
    if (!runAt || nowTime !== runAt) continue;
    if (String(routine.lastRunKey || "") === nowDate) continue;
    dueRoutines.push({
      routine,
      runKey: nowDate,
      createdAt: Date.parse(routine.createdAt || "") || 0,
    });
  }

  if (!dueRoutines.length) return;

  if (dueRoutines.length > 1) {
    await appendRoutineLog({
      routineId: null,
      routineTitle: "Fila de rotinas",
      level: "info",
      message: `${dueRoutines.length} rotinas enfileiradas para execucao sequencial no mesmo horario.`,
    });
  }

  dueRoutines
    .sort((a, b) => a.createdAt - b.createdAt || String(a.routine.title || "").localeCompare(String(b.routine.title || "")))
    .forEach((item) => {
      enqueueRoutineExecution(item.routine, { runKey: item.runKey });
    });

  await drainRoutineExecutionQueue();
};

const runScheduledMessagesSchedulerTick = async () => {
  const store = await readScheduledMessageStore();
  const items = Array.isArray(store.items) ? store.items : [];
  if (!items.length) return;
  const now = new Date();
  let changed = false;

  for (const item of items) {
    if (!isScheduledMessageDue(item, now)) continue;
    try {
      await executeScheduledMessageItem(item);
      const nextOccurrence = computeNextScheduledOccurrence(item);
      item.lastRunAt = nowIso();
      item.error = null;
      if (nextOccurrence) {
        item.date = nextOccurrence.date;
        item.time = nextOccurrence.time;
        item.status = "scheduled";
      } else {
        item.status = "sent";
      }
      item.updatedAt = nowIso();
      changed = true;
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "scheduled-message",
        event: "scheduled-message-success",
        to: item.to || null,
        message: `Agendamento executado (${item.type}) para ${item.to || "-"}.`,
      });
    } catch (error) {
      item.status = "failed";
      item.error = error?.message || "erro desconhecido";
      item.lastRunAt = nowIso();
      item.updatedAt = nowIso();
      changed = true;
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "error",
        source: "scheduled-message",
        event: "scheduled-message-failed",
        to: item.to || null,
        message: `Falha ao executar agendamento (${item.type}) para ${item.to || "-"}: ${error?.message || "erro desconhecido"}`,
        errorReason: error?.message || "erro desconhecido",
      });
    }
  }

  if (changed) {
    await writeScheduledMessageStore(store);
  }
};

const isLabelCampaignDueNow = (config, now = new Date()) => {
  if (!config?.enabled) return false;
  const weekdays = normalizeLabelCampaignWeekdays(config?.weekdays ?? config?.weekday, ["monday"]);
  const runAt = normalizeRoutineRunAt(config.time, "");
  if (!runAt || !weekdays.length) return false;
  const nowWeekday = getZonedWeekdayKey(now, DEFAULT_ROUTINE_TIMEZONE);
  const nowTime = getZonedTimeKey(now, DEFAULT_ROUTINE_TIMEZONE);
  return weekdays.includes(nowWeekday) && nowTime === runAt;
};

const executeLabelCampaignDispatch = async ({ label, config, labelsById, now = new Date() }) => {
  const contactsResult = await listLabelContacts(label.id);
  const contacts = Array.isArray(contactsResult?.contacts) ? contactsResult.contacts : [];
  if (!contacts.length) {
    return { total: 0, sent: 0, failed: 0 };
  }

  const painelStore = await readPainelStore();
  const painelCustomersByPhone = buildPainelCustomersPhoneIndex(painelStore?.customers || {});
  const store = await readStore();
  const internalTemplate =
    config.useInternalTemplateOn24h && config.internalTemplateId
      ? await findLocalTemplateById(config.internalTemplateId)
      : null;
  const targetLabel = config.moveToLabelId ? labelsById.get(config.moveToLabelId) : null;
  const canAssignTargetLabel = Boolean(targetLabel);

  let sent = 0;
  let failed = 0;

  for (const contact of contacts) {
    const phone = normalizePhone(contact?.number || "");
    if (!phone) {
      failed += 1;
      continue;
    }

    try {
      const painelRow = painelCustomersByPhone.get(phone) || null;
      const context = buildLabelCampaignTemplateContext({ contact, painelRow });
      const windowState = await getRoutineConversationWindowState(phone, now, store);
      let responseMessageId = null;

      if (windowState.within24hWindow && config.useInternalTemplateOn24h && internalTemplate) {
        const payload = buildLabelCampaignInternalTemplatePayload({ template: internalTemplate, context });
        const internalSend = await sendRoutineAlternativeTemplateMessage({ phone, payload });
        responseMessageId = internalSend.responseMessageId || null;
      } else {
        const metaPayload = await buildLabelCampaignMetaTemplatePayload({
          templateName: config.metaTemplateName,
          language: config.metaTemplateLanguage || "pt_BR",
          context,
        });
        const result = await sendTemplateMessage({
          to: phone,
          parameters: metaPayload.bodyParameters,
          buttonParameters: metaPayload.buttonParameters,
          headerParameters: metaPayload.headerParameters,
          headerFormat: metaPayload.headerFormat,
          templateName: config.metaTemplateName,
          language: config.metaTemplateLanguage || "pt_BR",
        });
        responseMessageId = result?.messages?.[0]?.id || null;
        await persistTemplateMessageAsAgent({
          phone,
          responseMessageId,
          templateName: config.metaTemplateName,
          language: config.metaTemplateLanguage || "pt_BR",
          bodyParameters: metaPayload.bodyParameters,
          buttonParameters: metaPayload.buttonParameters,
          headerParameters: metaPayload.headerParameters,
          headerFormat: metaPayload.headerFormat || null,
        });
      }

      if (contact?.id && (config.removeFromCurrent || canAssignTargetLabel)) {
        if (config.removeFromCurrent) {
          await removeContactLabelsById(contact.id, [String(label.id)]);
        }
        if (canAssignTargetLabel) {
          await addContactLabelsById(contact.id, [String(targetLabel.id)]);
        }
      }

      await appendMessageDeliveryLog({
        category: "message-send",
        level: "success",
        source: "label-campaign",
        event: "label-campaign-success",
        to: phone,
        messageId: responseMessageId,
        templateName:
          windowState.within24hWindow && config.useInternalTemplateOn24h && internalTemplate
            ? internalTemplate.name || config.internalTemplateId
            : config.metaTemplateName || null,
        message: `Campanha da etiqueta ${label.name} enviada para ${phone}.`,
      });
      sent += 1;
    } catch (error) {
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "error",
        source: "label-campaign",
        event: "label-campaign-failed",
        to: phone,
        templateName: config.metaTemplateName || null,
        errorReason: error?.message || "erro desconhecido",
        message: `Falha na campanha da etiqueta ${label.name} para ${phone}: ${error?.message || "erro desconhecido"}`,
      });
      failed += 1;
    }
  }

  return {
    total: contacts.length,
    sent,
    failed,
  };
};

const runLabelCampaignSchedulerTick = async () => {
  await syncCurrentContactsForLabels({ force: false });
  const [labels, stateStore] = await Promise.all([listLabels(), readLabelCampaignStateStore()]);
  const now = new Date();
  const todayKey = getZonedDateKey(now, DEFAULT_ROUTINE_TIMEZONE);
  const labelsById = new Map(labels.map((label) => [String(label.id), label]));
  let changed = false;

  for (const label of labels) {
    const config = normalizeLabelCampaignConfig(label?.campaignConfig);
    if (!config.enabled || !config.metaTemplateName) continue;
    if (!isLabelCampaignDueNow(config, now)) continue;
    const currentWeekday = getZonedWeekdayKey(now, DEFAULT_ROUTINE_TIMEZONE);
    const slotKey = `${todayKey}|${currentWeekday}|${config.time}`;
    const previousSlot = String(stateStore?.slots?.[label.id]?.lastRunSlot || "");
    if (previousSlot === slotKey) continue;

    const summary = await executeLabelCampaignDispatch({
      label,
      config,
      labelsById,
      now,
    });

    stateStore.slots[label.id] = {
      lastRunSlot: slotKey,
      lastRunAt: nowIso(),
      summary,
    };
    changed = true;
  }

  if (changed) {
    await writeLabelCampaignStateStore(stateStore);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const isCampaignDueNow = (campaign, now = new Date()) => {
  if (!campaign?.config?.active) return false;
  const weekdays = Array.isArray(campaign?.config?.weekdays) ? campaign.config.weekdays : [];
  const runAt = normalizeRoutineRunAt(campaign?.config?.time, "");
  if (!weekdays.length || !runAt) return false;
  const nowWeekday = getZonedWeekdayKey(now, DEFAULT_ROUTINE_TIMEZONE);
  const nowTime = getZonedTimeKey(now, DEFAULT_ROUTINE_TIMEZONE);
  return weekdays.includes(nowWeekday) && nowTime === runAt;
};

const normalizeCampaignDispatchMode = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "inside_24h") return "inside_24h";
  if (normalized === "outside_24h") return "outside_24h";
  return "all";
};

const findConversationByPhone = (store, phone) => {
  const target = normalizePhone(phone);
  if (!target) return null;
  const conversations = Object.values(store?.conversations || {});
  return (
    conversations.find((conversation) => normalizePhone(conversation?.customer?.phone || conversation?.id || "") === target) ||
    null
  );
};

const applyCampaignUtilityAction = async ({ action, phone, store }) => {
  const conversation = findConversationByPhone(store, phone);
  if (!conversation) return;
  if (action.type === "utility_mark_unread") {
    conversation.unreadCount = Math.max(Number(conversation.unreadCount || conversation.unread_count || 0), 1);
    conversation.unread_count = conversation.unreadCount;
    await writeStore(store, { conversationIds: [conversation.id] });
    return;
  }
  const preferences = await readUiPreferencesStore();
  const currentPinned = new Set(Array.isArray(preferences?.pinnedConversationIds) ? preferences.pinnedConversationIds : []);
  if (action.type === "utility_pin") {
    currentPinned.add(conversation.id);
  } else if (action.type === "utility_unpin") {
    currentPinned.delete(conversation.id);
  }
  await writeUiPreferencesStore({
    ...preferences,
    pinnedConversationIds: Array.from(currentPinned),
  });
};

const applyCampaignLabelAction = async ({ action, contactId }) => {
  if (!contactId) return;
  if (action.type === "label_remove_all") {
    await clearContactLabelsById(contactId);
    return;
  }
  if (action.type === "label_add") {
    await addContactLabelsById(contactId, Array.isArray(action.labelIds) ? action.labelIds : []);
    return;
  }
  if (action.type === "label_remove") {
    await removeContactLabelsById(contactId, Array.isArray(action.labelIds) ? action.labelIds : []);
    return;
  }
};

const executeCampaignActions = async ({ campaign, phone, contact, context, store }) => {
  for (const action of Array.isArray(campaign?.actions) ? campaign.actions : []) {
    if (!action || typeof action !== "object") continue;
    if (action.type === "wait_seconds") {
      await sleep(Math.max(1, Number(action.seconds || 1)) * 1000);
      continue;
    }
    if (action.type === "send_text") {
      const typingSeconds = Math.max(0, Number(action.typingSeconds || 0));
      const nextDelaySeconds = Math.max(0, Number(action.nextDelaySeconds || 0));
      if (typingSeconds) {
        await sleep(typingSeconds * 1000);
      }
      const text = applyLabelCampaignVariables(action.message || "", context).trim();
      if (text) {
        await sendScheduledTextMessage({ to: phone, text });
      }
      if (nextDelaySeconds) {
        await sleep(nextDelaySeconds * 1000);
      }
      continue;
    }
    if (action.type === "send_media") {
      const mediaLink = String(action.mediaUrl || "").trim();
      if (!mediaLink) continue;
      const caption = applyLabelCampaignVariables(action.message || "", context).trim();
      const mediaType = ["image", "video", "audio", "document"].includes(String(action.mediaType || ""))
        ? String(action.mediaType)
        : "image";
      const result = await sendMediaMessage({
        to: phone,
        mediaType,
        mediaLink,
        caption: mediaType === "audio" ? undefined : caption || undefined,
      });
      await upsertAgentMessage({
        to: phone,
        text: caption || `[${mediaType}]`,
        messageId: result?.messages?.[0]?.id,
        attachments: [{
          id: result?.messages?.[0]?.id || `${Date.now()}`,
          type: mediaType === "document" ? "document" : mediaType,
          url: mediaLink,
          name: String(action.mediaName || "").trim() || `Campanha ${mediaType}`,
          mimeType: String(action.mimeType || "").trim() || null,
        }],
        origin: "panel",
      });
      continue;
    }
    if (action.type === "send_quick_reply") {
      const text = applyLabelCampaignVariables(action.message || "", context).trim();
      if (text) {
        await sendScheduledTextMessage({ to: phone, text });
      }
      continue;
    }
    if (action.type === "send_list") {
      const rows = Array.isArray(action.rows)
        ? action.rows.map((row) => ({
            id: String(row?.id || "").trim() || `campaign-list-row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: applyLabelCampaignVariables(row?.title || "", context).trim(),
            description: applyLabelCampaignVariables(row?.description || "", context).trim(),
          })).filter((row) => row.title)
        : [];
      if (rows.length) {
        const messageText = applyLabelCampaignVariables(action.message || "", context).trim();
        const result = await sendInteractiveMessage({
          to: phone,
          text: messageText,
          buttonText: applyLabelCampaignVariables(action.buttonText || "MENU", context).trim(),
          rows,
        });
        await upsertAgentMessage({
          to: phone,
          text: messageText || "[lista]",
          messageId: result?.messages?.[0]?.id || null,
          origin: "panel",
        });
      }
      continue;
    }
    if (action.type === "label_add" || action.type === "label_remove" || action.type === "label_remove_all") {
      await applyCampaignLabelAction({ action, contactId: contact?.id });
      continue;
    }
    if (action.type === "utility_pin" || action.type === "utility_unpin" || action.type === "utility_mark_unread") {
      await applyCampaignUtilityAction({ action, phone, store });
    }
  }
};

const stripCampaignDispatchResults = (summary) => {
  if (!summary || typeof summary !== "object") return summary;
  const { results, ...rest } = summary;
  return rest;
};

const resolveCampaignDispatchTemplateName = ({ campaign, channel, internalQuickReply, internalTemplate }) => {
  if (channel === "internal_quick_reply") {
    return String(
      internalQuickReply?.title ||
        campaign?.config?.internalQuickReplyTitle ||
        campaign?.config?.internalQuickReplyId ||
        "Resposta rapida 24h",
    ).trim();
  }
  if (channel === "internal_template") {
    return String(
      internalTemplate?.name ||
        campaign?.config?.internalTemplateName ||
        campaign?.config?.internalTemplateId ||
        "Template interno 24h",
    ).trim();
  }
  if (channel === "meta_template") {
    return String(campaign?.config?.metaTemplateName || "").trim();
  }
  return "";
};

const appendCampaignDispatchLog = async ({
  campaign,
  event,
  level = "info",
  phone = null,
  channel = null,
  templateName = null,
  message,
  errorReason = null,
  status = null,
}) => {
  await appendMessageDeliveryLog({
    category: "message-send",
    level,
    source: "campaign-dispatch",
    event,
    to: phone,
    phone,
    channel: channel || null,
    templateName: templateName || null,
    campaignId: String(campaign?.id || "").trim() || null,
    campaignName: String(campaign?.name || "").trim() || null,
    errorReason,
    status,
    message,
  });
};

const executeCampaignDispatch = async ({
  campaign,
  now = new Date(),
  mode = "all",
  contacts: explicitContacts = null,
  sendIntervalSeconds: sendIntervalSecondsOverride = null,
}) => {
  const dispatchMode = normalizeCampaignDispatchMode(mode);
  const sendIntervalSeconds = normalizeRoutineSendIntervalSeconds(
    sendIntervalSecondsOverride ?? campaign?.config?.sendIntervalSeconds,
    ROUTINE_DEFAULT_SEND_INTERVAL_SECONDS,
  );
  const providedContacts = Array.isArray(explicitContacts)
    ? explicitContacts
        .map((contact) => ({
          id: String(contact?.id || "").trim(),
          name: String(contact?.name || "").trim(),
          number: String(contact?.number || "").trim(),
          status: String(contact?.status || "").trim(),
          lastClientMessageAt: contact?.lastClientMessageAt || null,
          labels: Array.isArray(contact?.labels) ? contact.labels : [],
        }))
        .filter((contact) => contact.number)
    : [];
  const labelIds = Array.isArray(campaign?.recipients?.labelIds) ? campaign.recipients.labelIds : [];
  if (!providedContacts.length && !labelIds.length) {
    return {
      total: 0,
      eligible: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      skippedInside24h: 0,
      skippedOutside24h: 0,
      skippedHasSchedule: 0,
      mode: dispatchMode,
      sendIntervalSeconds,
      results: [],
    };
  }

  const contactsMap = new Map();
  if (providedContacts.length) {
    providedContacts.forEach((contact) => {
      const phone = normalizePhone(contact?.number || "");
      if (!phone) return;
      contactsMap.set(phone, {
        ...contact,
        number: phone,
      });
    });
  } else {
    for (const labelId of labelIds) {
      const response = await listLabelContacts(labelId);
      (Array.isArray(response?.contacts) ? response.contacts : []).forEach((contact) => {
        const key = String(contact?.id || contact?.number || "").trim();
        if (!key) return;
        const previous = contactsMap.get(key);
        contactsMap.set(key, previous ? {
          ...previous,
          labels: Array.from(new Map([...(previous.labels || []), ...(contact.labels || [])].map((label) => [label.id, label])).values()),
        } : contact);
      });
    }
  }

  const contacts = Array.from(contactsMap.values());
  if (!contacts.length) {
    return {
      total: 0,
      eligible: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      skippedInside24h: 0,
      skippedOutside24h: 0,
      skippedHasSchedule: 0,
      mode: dispatchMode,
      sendIntervalSeconds,
      results: [],
    };
  }

  const [painelStore, store, scheduledStore] = await Promise.all([
    readPainelStore(),
    readStore(),
    readScheduledMessageStore(),
  ]);
  const painelCustomersByPhone = buildPainelCustomersPhoneIndex(painelStore?.customers || {});
  const scheduledSummaryIndex = buildScheduledMessageSummaryIndex(
    Array.isArray(scheduledStore?.items) ? scheduledStore.items : [],
  );
  const scheduledPhones = new Set(
    scheduledSummaryIndex.byPhone instanceof Map ? Array.from(scheduledSummaryIndex.byPhone.keys()) : [],
  );
  if (dispatchMode === "outside_24h" && !campaign?.config?.metaTemplateName) {
    throw new Error("Configure um template da Meta para disparar apenas contatos fora da janela de 24h.");
  }
  const internalQuickReply =
    campaign?.config?.useInternalTemplateOn24h && campaign?.config?.internalQuickReplyId
      ? await findQuickReplyById(campaign.config.internalQuickReplyId)
      : null;
  const internalTemplate =
    !internalQuickReply && campaign?.config?.useInternalTemplateOn24h && campaign?.config?.internalTemplateId
      ? await findLocalTemplateById(campaign.config.internalTemplateId)
      : null;
  let sent = 0;
  let failed = 0;
  let skippedInside24h = 0;
  let skippedOutside24h = 0;
  let skippedHasSchedule = 0;
  const results = [];

  await appendCampaignDispatchLog({
    campaign,
    event: "campaign-dispatch-started",
    level: "info",
    message: `Disparo da campanha ${campaign?.name || "-"} iniciado. Contatos previstos: ${contacts.length}. Modo: ${dispatchMode}. Intervalo: ${sendIntervalSeconds}s.`,
    status: "started",
  });

  for (let index = 0; index < contacts.length; index += 1) {
    const contact = contacts[index];
    const phone = normalizePhone(contact?.number || "");
    const hasScheduledMessage = scheduledPhones.has(phone);
    if (!phone) {
      failed += 1;
      await appendCampaignDispatchLog({
        campaign,
        event: "campaign-dispatch-invalid-phone",
        level: "error",
        phone: String(contact?.number || "").trim() || null,
        message: `Campanha ${campaign?.name || "-"} ignorou um contato com telefone invalido.`,
        errorReason: "Telefone invalido para disparo.",
        status: "invalid_phone",
      });
      results.push({
        contactId: String(contact?.id || "").trim() || null,
        name: String(contact?.name || "").trim() || null,
        phone: String(contact?.number || "").trim() || null,
        status: "invalid_phone",
        within24hWindow: false,
        hasScheduledMessage,
        channel: "none",
        error: "Telefone invalido para disparo.",
      });
      continue;
    }
    try {
      const painelRow = painelCustomersByPhone.get(phone) || null;
      const context = buildLabelCampaignTemplateContext({ contact, painelRow });
      const windowState = await getRoutineConversationWindowState(phone, now, store);
      let channel = "none";
      let templateName = null;
      if (campaign?.config?.includeScheduledContacts === false && hasScheduledMessage) {
        skippedHasSchedule += 1;
        await appendCampaignDispatchLog({
          campaign,
          event: "campaign-dispatch-skipped-has-schedule",
          level: "info",
          phone,
          message: `Campanha ${campaign?.name || "-"} ignorou ${phone} porque o cliente possui mensagem agendada.`,
          status: "skipped_has_schedule",
        });
        results.push({
          contactId: String(contact?.id || "").trim() || null,
          name: String(contact?.name || "").trim() || null,
          phone,
          status: "skipped_has_schedule",
          within24hWindow: Boolean(windowState?.within24hWindow),
          hasScheduledMessage,
          channel,
          error: null,
        });
        continue;
      }
      if (dispatchMode === "outside_24h" && windowState.within24hWindow) {
        skippedInside24h += 1;
        await appendCampaignDispatchLog({
          campaign,
          event: "campaign-dispatch-skipped-inside-24h",
          level: "info",
          phone,
          message: `Campanha ${campaign?.name || "-"} ignorou ${phone} porque o contato esta dentro da janela de 24h.`,
          status: "skipped_inside_24h",
        });
        results.push({
          contactId: String(contact?.id || "").trim() || null,
          name: String(contact?.name || "").trim() || null,
          phone,
          status: "skipped_inside_24h",
          within24hWindow: true,
          hasScheduledMessage,
          channel,
          error: null,
        });
        continue;
      }
      if (dispatchMode === "inside_24h" && !windowState.within24hWindow) {
        skippedOutside24h += 1;
        await appendCampaignDispatchLog({
          campaign,
          event: "campaign-dispatch-skipped-outside-24h",
          level: "info",
          phone,
          message: `Campanha ${campaign?.name || "-"} ignorou ${phone} porque o contato esta fora da janela de 24h.`,
          status: "skipped_outside_24h",
        });
        results.push({
          contactId: String(contact?.id || "").trim() || null,
          name: String(contact?.name || "").trim() || null,
          phone,
          status: "skipped_outside_24h",
          within24hWindow: false,
          hasScheduledMessage,
          channel,
          error: null,
        });
        continue;
      }
      if (windowState.within24hWindow && internalQuickReply) {
        const text = applyLabelCampaignVariables(internalQuickReply.content || "", context).trim();
        if (!text) {
          throw new Error("A resposta rapida configurada para a janela de 24h esta vazia.");
        }
        channel = "internal_quick_reply";
        templateName = resolveCampaignDispatchTemplateName({ campaign, channel, internalQuickReply, internalTemplate });
        await appendCampaignDispatchLog({
          campaign,
          event: "campaign-dispatch-requested",
          level: "info",
          phone,
          channel,
          templateName,
          message: `Tentativa de envio da campanha ${campaign?.name || "-"} para ${phone} usando resposta rapida de 24h.`,
          status: "requested",
        });
        await sendScheduledTextMessage({ to: phone, text });
      } else if (windowState.within24hWindow && internalTemplate) {
        channel = "internal_template";
        templateName = resolveCampaignDispatchTemplateName({ campaign, channel, internalQuickReply, internalTemplate });
        await appendCampaignDispatchLog({
          campaign,
          event: "campaign-dispatch-requested",
          level: "info",
          phone,
          channel,
          templateName,
          message: `Tentativa de envio da campanha ${campaign?.name || "-"} para ${phone} usando template interno de 24h.`,
          status: "requested",
        });
        const payload = buildLabelCampaignInternalTemplatePayload({ template: internalTemplate, context });
        await sendRoutineAlternativeTemplateMessage({ phone, payload });
      } else if (campaign?.config?.metaTemplateName) {
        const configuredBodyParameters = Array.isArray(campaign?.config?.metaBodyParameters)
          ? campaign.config.metaBodyParameters.map((value) => String(value || ""))
          : [];
        const configuredHeaderParameters = Array.isArray(campaign?.config?.metaHeaderParameters)
          ? campaign.config.metaHeaderParameters.map((value) => String(value || ""))
          : [];
        const configuredButtonParameters = Array.isArray(campaign?.config?.metaButtonParameters)
          ? campaign.config.metaButtonParameters.map((value) => String(value || ""))
          : [];
        const metaPayload = await buildLabelCampaignMetaTemplatePayload({
          templateName: campaign.config.metaTemplateName,
          language: campaign?.config?.metaTemplateLanguage || "pt_BR",
          context,
        });
        channel = "meta_template";
        templateName = resolveCampaignDispatchTemplateName({ campaign, channel, internalQuickReply, internalTemplate });
        await appendCampaignDispatchLog({
          campaign,
          event: "campaign-dispatch-requested",
          level: "info",
          phone,
          channel,
          templateName,
          message: `Tentativa de envio da campanha ${campaign?.name || "-"} para ${phone} usando template Meta ${templateName || "-"}.`,
          status: "requested",
        });
        const result = await sendTemplateMessage({
          to: phone,
          parameters: configuredBodyParameters.length ? configuredBodyParameters : metaPayload.bodyParameters,
          buttonParameters: configuredButtonParameters.length ? configuredButtonParameters : metaPayload.buttonParameters,
          headerParameters: configuredHeaderParameters.length ? configuredHeaderParameters : metaPayload.headerParameters,
          headerFormat: metaPayload.headerFormat,
          templateName: campaign.config.metaTemplateName,
          language: campaign?.config?.metaTemplateLanguage || "pt_BR",
        });
        await persistTemplateMessageAsAgent({
          phone,
          responseMessageId: result?.messages?.[0]?.id || null,
          templateName: campaign.config.metaTemplateName,
          language: campaign?.config?.metaTemplateLanguage || "pt_BR",
          bodyParameters: configuredBodyParameters.length ? configuredBodyParameters : metaPayload.bodyParameters,
          buttonParameters: configuredButtonParameters.length ? configuredButtonParameters : metaPayload.buttonParameters,
          headerParameters: configuredHeaderParameters.length ? configuredHeaderParameters : metaPayload.headerParameters,
          headerFormat: metaPayload.headerFormat || null,
        });
      } else {
        throw new Error("Campanha sem conteudo configurado para este cenario de disparo.");
      }
      await executeCampaignActions({ campaign, phone, contact, context, store });
      await appendCampaignDispatchLog({
        campaign,
        event: "campaign-dispatch-success",
        level: "success",
        phone,
        channel,
        templateName,
        message: `Campanha ${campaign?.name || "-"} enviada com sucesso para ${phone}.`,
        status: "sent",
      });
      sent += 1;
      results.push({
        contactId: String(contact?.id || "").trim() || null,
        name: String(contact?.name || "").trim() || null,
        phone,
        status: "sent",
        within24hWindow: Boolean(windowState?.within24hWindow),
        hasScheduledMessage,
        channel,
        error: null,
      });
      const hasMoreContacts = index < contacts.length - 1;
      if (hasMoreContacts && sendIntervalSeconds > 0) {
        await sleep(sendIntervalSeconds * 1000);
      }
    } catch (error) {
      failed += 1;
      await appendCampaignDispatchLog({
        campaign,
        event: "campaign-dispatch-failed",
        level: "error",
        phone,
        errorReason: error?.message || "erro desconhecido",
        message: `Falha na campanha ${campaign?.name || "-"} para ${phone}: ${error?.message || "erro desconhecido"}`,
        status: "failed",
      });
      results.push({
        contactId: String(contact?.id || "").trim() || null,
        name: String(contact?.name || "").trim() || null,
        phone,
        status: "failed",
        within24hWindow: false,
        hasScheduledMessage,
        channel: "none",
        error: error?.message || "erro desconhecido",
      });
      const hasMoreContacts = index < contacts.length - 1;
      if (hasMoreContacts && sendIntervalSeconds > 0) {
        await sleep(sendIntervalSeconds * 1000);
      }
    }
  }
  const skippedTotal = skippedInside24h + skippedOutside24h + skippedHasSchedule;
  await appendCampaignDispatchLog({
    campaign,
    event: "campaign-dispatch-completed",
    level: "info",
    message: `Disparo da campanha ${campaign?.name || "-"} concluido. Enviados: ${sent}. Falhas: ${failed}. Ignorados: ${skippedTotal}.`,
    status: "completed",
  });
  return {
    total: contacts.length,
    eligible: Math.max(0, contacts.length - skippedTotal),
    sent,
    failed,
    skipped: skippedTotal,
    skippedInside24h,
    skippedOutside24h,
    skippedHasSchedule,
    mode: dispatchMode,
    sendIntervalSeconds,
    results,
  };
};

const activeCampaignDispatches = new Set();

const executeCampaignDispatchWithPersistence = async ({
  campaign,
  now = new Date(),
  mode = "all",
  contacts = null,
  persistRun = true,
  trigger = "manual",
  lastRunSlot = null,
  sendIntervalSeconds = null,
}) => {
  const summary = await executeCampaignDispatch({
    campaign,
    now,
    mode,
    contacts,
    sendIntervalSeconds,
  });
  if (persistRun === false) {
    return { summary, item: campaign };
  }
  const executedAt = nowIso();
  const item = await updateCampaignById(campaign.id, {
    lastRunAt: executedAt,
    lastRunSlot: lastRunSlot ?? campaign?.lastRunSlot ?? null,
    lastRunSummary: {
      ...stripCampaignDispatchResults(summary),
      trigger,
      triggeredAt: executedAt,
    },
  });
  return { summary, item };
};

const startCampaignDispatchInBackground = ({
  campaign,
  mode = "all",
  contacts = null,
  persistRun = true,
  trigger = "manual",
  lastRunSlot = null,
  sendIntervalSeconds = null,
  syncBeforeStart = false,
}) => {
  const campaignId = String(campaign?.id || "").trim();
  if (!campaignId) {
    throw new Error("Campanha invalida para execucao em background.");
  }
  if (activeCampaignDispatches.has(campaignId)) {
    throw new Error("Ja existe um disparo em andamento para esta campanha.");
  }
  activeCampaignDispatches.add(campaignId);
  const dispatchId = `campaign-dispatch-${campaignId}-${Date.now()}`;
  void (async () => {
    try {
      if (syncBeforeStart) {
        await syncCurrentContactsForLabels({ force: true });
      }
      await executeCampaignDispatchWithPersistence({
        campaign,
        now: new Date(),
        mode,
        contacts,
        persistRun,
        trigger,
        lastRunSlot,
        sendIntervalSeconds,
      });
    } catch (error) {
      console.error("[campaigns] background dispatch failed:", error?.message || error);
      try {
        await appendCampaignDispatchLog({
          campaign,
          event: "campaign-dispatch-background-failed",
          level: "error",
          message: `Falha ao executar campanha em background: ${error?.message || "erro desconhecido"}`,
          errorReason: error?.message || "erro desconhecido",
          status: "failed",
        });
      } catch (logError) {
        console.error("[campaigns] failed to append background error log:", logError?.message || logError);
      }
    } finally {
      activeCampaignDispatches.delete(campaignId);
    }
  })();
  return { dispatchId };
};

const runCampaignSchedulerTick = async () => {
  await syncCurrentContactsForLabels({ force: false });
  const campaigns = await listCampaigns();
  const now = new Date();
  for (const campaign of campaigns) {
    if (!isCampaignDueNow(campaign, now)) continue;
    if (activeCampaignDispatches.has(String(campaign?.id || "").trim())) continue;
    const slotKey = `${getZonedDateKey(now, DEFAULT_ROUTINE_TIMEZONE)}|${getZonedTimeKey(now, DEFAULT_ROUTINE_TIMEZONE)}`;
    if (String(campaign?.lastRunSlot || "") === slotKey) continue;
    activeCampaignDispatches.add(String(campaign.id || "").trim());
    try {
      await executeCampaignDispatchWithPersistence({
        campaign,
        now,
        trigger: "schedule",
        lastRunSlot: slotKey,
      });
    } finally {
      activeCampaignDispatches.delete(String(campaign.id || "").trim());
    }
  }
};

































const emptyStore = () => ({































  conversations: {},































  messages: {},































  session: {































    assignedUserId: null,































  },































});































































const emptyPainelStore = () => ({































  updatedAt: null,































  customers: {},































});

const readPainelStore = async () => {
  const data = await safeReadJsonFile(painelStorePath, emptyPainelStore());
  if (!data || typeof data !== "object") return emptyPainelStore();
  const customers =
    data.customers && typeof data.customers === "object" ? data.customers : {};
  return { ...emptyPainelStore(), ...data, customers };
};

// Etiquetas usam somente a base persistida canonica da operacao.
const readPersistedCustomerRows = async () => {
  const data = await safeReadJsonFile(persistedCustomersStorePath, {});
  return Array.isArray(data?.customers) ? data.customers : [];
};

const buildPersistedCustomersObject = (rows = []) =>
  rows.reduce((accumulator, row, index) => {
    const key = String(row?.id || row?.sync_key || `customer-${index + 1}`).trim();
    if (key) accumulator[key] = row;
    return accumulator;
  }, {});

const writePainelStore = async (store) => {
  const next = store && typeof store === "object" ? store : emptyPainelStore();
  await atomicWriteJson(painelStorePath, next);
};

const emptyPainelMissingReport = () => ({
  generatedAt: null,
  updatedAt: null,
  sourceBaseUrl: null,
  sourceTotalRows: 0,
  importedRows: 0,
  pages: 0,
  reimportedRows: 0,
  missingBeforeCount: 0,
  missingAfterCount: 0,
  sourceWithoutIdentityCount: 0,
  missingBefore: [],
  missingAfter: [],
  sourceWithoutIdentity: [],
});

const readPainelMissingReport = async () => {
  const data = await safeReadJsonFile(painelMissingReportPath, emptyPainelMissingReport());
  if (!data || typeof data !== "object") return emptyPainelMissingReport();
  const normalizeRows = (value) =>
    Array.isArray(value)
      ? value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      : [];
  return {
    ...emptyPainelMissingReport(),
    ...data,
    missingBefore: normalizeRows(data.missingBefore),
    missingAfter: normalizeRows(data.missingAfter),
    sourceWithoutIdentity: normalizeRows(data.sourceWithoutIdentity),
  };
};

const normalizePainelMissingCustomerRow = (row) => {
  const customerId = String(row?.customerId || "").trim() || null;
  const usuario = String(row?.usuario || "").trim() || null;
  const phoneValue = String(row?.phone || "").trim();
  const safePhone = phoneValue || "n/a";
  const plan =
    String(
      row?.planoAtual ||
        row?.packageName ||
        row?.package ||
        row?.package_name ||
        row?.plan ||
        row?.subscription ||
        "",
    ).trim() || null;
  const dueDate =
    String(
      row?.vencimento ||
        row?.expiresAtTz ||
        row?.expiresAt ||
        row?.expires_at_tz ||
        row?.expires_at ||
        row?.expiry ||
        row?.expiration ||
        row?.due_date ||
        "",
    ).trim() || null;
  const status =
    String(row?.status || row?.situacao || row?.state || "").trim() || null;
  const connections =
    Number.isFinite(Number(row?.connections))
      ? Number(row?.connections)
      : Number.isFinite(Number(row?.conexoes))
        ? Number(row?.conexoes)
        : null;
  return {
    phone: safePhone,
    whatsapp: safePhone,
    id: customerId,
    customerId,
    usuario,
    username: usuario,
    packageName: plan,
    planoAtual: plan,
    vencimento: dueDate,
    expiresAt: dueDate,
    expiresAtTz: dueDate,
    status,
    situacao: status,
    connections,
    conexoes: connections,
    missingInSync: true,
    missingIdentity: String(row?.identity || "").trim() || null,
    source: "missing-report",
  };
};

const normalizePainelCustomerIdentity = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const sanitizePainelKeyPart = (value, fallback = "unknown") => {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/gi, "_")
    .slice(0, 120);
  return cleaned || fallback;
};

const buildPainelCustomerKey = (row, fallbackSeed = "row") => {
  const identity = normalizePainelCustomerIdentity(
    row?.customerId || row?.id || row?.usuario || row?.username || row?.user || row?.email || "",
  );
  if (identity) return `id:${sanitizePainelKeyPart(identity, fallbackSeed)}`;
  const normalizedPhone = normalizePhone(
    row?.phone || row?.whatsapp || row?.telefone || row?.mobile || row?.numero || row?.number || "",
  );
  if (normalizedPhone) return `ph:${normalizedPhone}`;
  const fallback =
    row?.renewUrl || row?.renew_url || row?.m3uUrl || row?.playlist || row?.vencimento || fallbackSeed;
  return `na:${sanitizePainelKeyPart(fallback, fallbackSeed)}`;
};

const getPainelCustomerEntries = (store) =>
  Object.entries(store?.customers || {}).filter(([, row]) => row && typeof row === "object");

const findPainelCustomerEntry = (store, { phone, customerId, usuario } = {}) => {
  const entries = getPainelCustomerEntries(store);
  const normalizedPhone = normalizePhone(phone);
  const normalizedCustomerId = normalizePainelCustomerIdentity(customerId);
  const normalizedUsuario = normalizePainelCustomerIdentity(usuario);

  if (normalizedCustomerId) {
    const match = entries.find(([, row]) =>
      normalizePainelCustomerIdentity(row?.customerId || row?.id || "") === normalizedCustomerId,
    );
    if (match) return { key: match[0], row: match[1] };
  }

  if (normalizedUsuario) {
    const match = entries.find(([, row]) =>
      normalizePainelCustomerIdentity(row?.usuario || row?.username || row?.user || "") === normalizedUsuario,
    );
    if (match) return { key: match[0], row: match[1] };
  }

  if (normalizedPhone) {
    const match = entries.find(([, row]) => {
      const rowPhone = normalizePhone(
        row?.phone || row?.whatsapp || row?.telefone || row?.mobile || row?.numero || row?.number || "",
      );
      return rowPhone === normalizedPhone;
    });
    if (match) return { key: match[0], row: match[1] };
  }

  return null;
};

const findPainelCustomerEntriesByPhone = (store, phone) => {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return [];
  return getPainelCustomerEntries(store)
    .filter(([, row]) => {
      const rowPhone = normalizePhone(
        row?.phone || row?.whatsapp || row?.telefone || row?.mobile || row?.numero || row?.number || "",
      );
      return rowPhone === normalizedPhone;
    })
    .map(([key, row]) => ({ key, row }));
};

const resolvePainelCustomerStrongIdentity = (row) => ({
  customerId: normalizePainelCustomerIdentity(row?.customerId || row?.id || ""),
  usuario: normalizePainelCustomerIdentity(row?.usuario || row?.username || row?.user || ""),
});

const canMergePainelCustomerByUsuario = ({ incomingRow, existingRow }) => {
  if (!incomingRow || !existingRow) return false;
  const incoming = resolvePainelCustomerStrongIdentity(incomingRow);
  const existing = resolvePainelCustomerStrongIdentity(existingRow);

  if (!incoming.usuario || !existing.usuario) {
    return false;
  }
  if (incoming.usuario !== existing.usuario) {
    return false;
  }
  if (incoming.customerId && existing.customerId) {
    return incoming.customerId === existing.customerId;
  }
  return true;
};

const canMergePainelCustomerByPhone = ({ incomingRow, existingRow }) => {
  if (!incomingRow || !existingRow) return false;
  const incoming = resolvePainelCustomerStrongIdentity(incomingRow);
  const existing = resolvePainelCustomerStrongIdentity(existingRow);

  const incomingHasStrong = Boolean(incoming.customerId || incoming.usuario);
  const existingHasStrong = Boolean(existing.customerId || existing.usuario);

  if (!incomingHasStrong || !existingHasStrong) {
    return true;
  }
  if (incoming.customerId && existing.customerId) {
    return incoming.customerId === existing.customerId;
  }
  if (incoming.usuario && existing.usuario) {
    return incoming.usuario === existing.usuario;
  }
  return false;
};

const createPainelUpsertStats = (store, rows) => ({
  received: Array.isArray(rows) ? rows.length : 0,
  processed: 0,
  skipped: 0,
  inserted: 0,
  updated: 0,
  mergedByCustomerId: 0,
  mergedByUsuario: 0,
  mergedByPhone: 0,
  phoneConflictSkipped: 0,
  aliasKeysRemoved: 0,
  totalBefore: Object.keys(store?.customers || {}).length,
  totalAfter: 0,
  delta: 0,
});

const mergePainelUpsertStats = (target, stats) => {
  if (!target || !stats) return target;
  target.received += Number(stats.received || 0);
  target.processed += Number(stats.processed || 0);
  target.skipped += Number(stats.skipped || 0);
  target.inserted += Number(stats.inserted || 0);
  target.updated += Number(stats.updated || 0);
  target.mergedByCustomerId += Number(stats.mergedByCustomerId || 0);
  target.mergedByUsuario += Number(stats.mergedByUsuario || 0);
  target.mergedByPhone += Number(stats.mergedByPhone || 0);
  target.phoneConflictSkipped += Number(stats.phoneConflictSkipped || 0);
  target.aliasKeysRemoved += Number(stats.aliasKeysRemoved || 0);
  target.totalAfter = Number(stats.totalAfter || target.totalAfter || 0);
  target.delta = target.totalAfter - target.totalBefore;
  return target;
};

const formatPainelUpsertStats = (stats) => {
  const safe = stats && typeof stats === "object" ? stats : {};
  const merged =
    (Number(safe.mergedByCustomerId || 0) || 0) +
    (Number(safe.mergedByUsuario || 0) || 0) +
    (Number(safe.mergedByPhone || 0) || 0);
  return (
    `recebidos=${Number(safe.received || 0) || 0}, ` +
    `processados=${Number(safe.processed || 0) || 0}, ` +
    `novos=${Number(safe.inserted || 0) || 0}, ` +
    `atualizados=${Number(safe.updated || 0) || 0}, ` +
    `mesclados=${merged}, ` +
    `conflitos-telefone=${Number(safe.phoneConflictSkipped || 0) || 0}, ` +
    `aliases-removidos=${Number(safe.aliasKeysRemoved || 0) || 0}, ` +
    `total-local=${Number(safe.totalAfter || 0) || 0}`
  );
};

const upsertMissingCustomersIntoPainelStore = async (missingRows) => {
  const rows = Array.isArray(missingRows) ? missingRows : [];
  if (!rows.length) {
    return { inserted: 0, updated: 0, totalProcessed: 0 };
  }

  const store = await readPainelStore();
  const customers = store?.customers && typeof store.customers === "object" ? { ...store.customers } : {};
  let inserted = 0;
  let updated = 0;

  rows.forEach((missingRow, index) => {
    const normalizedRow = normalizePainelMissingCustomerRow(missingRow);
    const normalizedPhone = normalizePhone(normalizedRow.phone);
    const normalizedUsuario = normalizePainelCustomerIdentity(normalizedRow.usuario);
    const fallbackEntry = getPainelCustomerEntries({ ...store, customers }).find(([, row]) => {
      const rowPhone = normalizePhone(row?.whatsapp || row?.phone || "");
      const rowUsuario = normalizePainelCustomerIdentity(row?.usuario || row?.username || "");
      return (
        (normalizedPhone && rowPhone && rowPhone === normalizedPhone) ||
        (normalizedUsuario && rowUsuario && rowUsuario === normalizedUsuario)
      );
    });
    const fallbackRow = fallbackEntry?.[1] && typeof fallbackEntry[1] === "object" ? fallbackEntry[1] : null;
    if (fallbackRow) {
      if (!normalizedRow.packageName && (fallbackRow.packageName || fallbackRow.planoAtual)) {
        normalizedRow.packageName = String(fallbackRow.packageName || fallbackRow.planoAtual || "").trim() || null;
        normalizedRow.planoAtual = normalizedRow.packageName;
      }
      if (!normalizedRow.status && (fallbackRow.status || fallbackRow.situacao)) {
        normalizedRow.status = String(fallbackRow.status || fallbackRow.situacao || "").trim() || null;
        normalizedRow.situacao = normalizedRow.status;
      }
      if (!Number.isFinite(Number(normalizedRow.connections)) && Number.isFinite(Number(fallbackRow.connections ?? fallbackRow.conexoes))) {
        const conn = Number(fallbackRow.connections ?? fallbackRow.conexoes);
        normalizedRow.connections = conn;
        normalizedRow.conexoes = conn;
      }
      if (!normalizedRow.vencimento && (fallbackRow.vencimento || fallbackRow.expiresAtTz || fallbackRow.expiresAt)) {
        const due = String(fallbackRow.vencimento || fallbackRow.expiresAtTz || fallbackRow.expiresAt || "").trim() || null;
        normalizedRow.vencimento = due;
        normalizedRow.expiresAt = due;
        normalizedRow.expiresAtTz = due;
      }
    }

    const existing = findPainelCustomerEntry({ ...store, customers }, {
      customerId: normalizedRow.customerId,
      usuario: normalizedRow.usuario,
      phone: normalizedRow.phone,
    });
    if (existing?.key) {
      const prev = customers[existing.key] && typeof customers[existing.key] === "object" ? customers[existing.key] : {};
      customers[existing.key] = {
        ...prev,
        packageName:
          prev?.packageName ||
          prev?.planoAtual ||
          normalizedRow.packageName ||
          normalizedRow.planoAtual ||
          null,
        planoAtual:
          prev?.planoAtual ||
          prev?.packageName ||
          normalizedRow.planoAtual ||
          normalizedRow.packageName ||
          null,
        status: prev?.status || prev?.situacao || normalizedRow.status || normalizedRow.situacao || null,
        situacao: prev?.situacao || prev?.status || normalizedRow.situacao || normalizedRow.status || null,
        connections:
          Number.isFinite(Number(prev?.connections))
            ? Number(prev.connections)
            : Number.isFinite(Number(prev?.conexoes))
              ? Number(prev.conexoes)
              : Number.isFinite(Number(normalizedRow.connections))
                ? Number(normalizedRow.connections)
                : Number.isFinite(Number(normalizedRow.conexoes))
                  ? Number(normalizedRow.conexoes)
                  : null,
        conexoes:
          Number.isFinite(Number(prev?.conexoes))
            ? Number(prev.conexoes)
            : Number.isFinite(Number(prev?.connections))
              ? Number(prev.connections)
              : Number.isFinite(Number(normalizedRow.conexoes))
                ? Number(normalizedRow.conexoes)
                : Number.isFinite(Number(normalizedRow.connections))
                  ? Number(normalizedRow.connections)
                  : null,
        vencimento: prev?.vencimento || prev?.expiresAtTz || prev?.expiresAt || normalizedRow.vencimento || null,
        expiresAt:
          prev?.expiresAt ||
          prev?.expiresAtTz ||
          prev?.vencimento ||
          normalizedRow.expiresAt ||
          normalizedRow.expiresAtTz ||
          normalizedRow.vencimento ||
          null,
        expiresAtTz:
          prev?.expiresAtTz ||
          prev?.expiresAt ||
          prev?.vencimento ||
          normalizedRow.expiresAtTz ||
          normalizedRow.expiresAt ||
          normalizedRow.vencimento ||
          null,
        missingInSync: true,
        missingIdentity: normalizedRow.missingIdentity || prev?.missingIdentity || null,
        source: prev?.source || normalizedRow.source,
      };
      updated += 1;
      return;
    }

    const key = buildPainelCustomerKey(normalizedRow, `missing-${index}`);
    if (!customers[key]) {
      customers[key] = normalizedRow;
      inserted += 1;
      return;
    }

    const fallbackKey = `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    customers[fallbackKey] = normalizedRow;
    inserted += 1;
  });

  const nextStore = {
    ...store,
    updatedAt: new Date().toISOString(),
    customers,
  };
  await writePainelStore(nextStore);
  return { inserted, updated, totalProcessed: rows.length };
};

const buildPainelCustomersPhoneIndex = (painelCustomers) => {
  const index = new Map();
  Object.values(painelCustomers || {}).forEach((row) => {
    if (!row || typeof row !== "object") return;
    const normalizedPhone = normalizePhone(
      row?.phone || row?.whatsapp || row?.telefone || row?.mobile || row?.numero || row?.number || "",
    );
    if (!normalizedPhone || index.has(normalizedPhone)) return;
    index.set(normalizedPhone, row);
  });
  return index;
};































































const emptyPainelSyncState = () => ({































  running: false,































  startedAt: null,































  finishedAt: null,































  error: null,































  logs: [],































});































































const emptyCoexConfig = () => ({































  updatedAt: null,































  wabaId: null,































  phoneNumberId: null,































  displayPhoneNumber: null,































  accessToken: null,































  sync: {































    contactsRequestedAt: null,































    historyRequestedAt: null,































    lastRequestId: null,































    lastError: null,































  },































});

const readCoexConfig = async () => {
  const data = await safeReadJsonFile(coexPath, emptyCoexConfig());
  if (!data || typeof data !== "object") return emptyCoexConfig();
  return { ...emptyCoexConfig(), ...data };
};

const writeCoexConfig = async (config) => {
  const next = config && typeof config === "object" ? config : emptyCoexConfig();
  const updatedAt = new Date().toISOString();
  await atomicWriteJson(coexPath, { ...next, updatedAt });
};































































const painelStorePath = path.resolve(process.cwd(), PAINEL_CUSTOMERS_PATH);
const persistedCustomersStorePath = path.resolve(process.cwd(), PERSISTED_CUSTOMERS_STORE_PATH);































const painelSyncPath = path.resolve(process.cwd(), PAINEL_SYNC_STATE_PATH);
const painelMissingReportPath = path.resolve(process.cwd(), PAINEL_MISSING_REPORT_PATH);































let painelSyncState = null;































let painelSyncTask = null;
let cachedMainStore = null;
let cachedMainStoreAt = 0;
let mainStoreRevision = 0;
let conversationsPayloadCache = null;
const WHATSAPP_STORE_WRITE_PERF_THRESHOLD_MS = parsePositiveInt(
  process.env.WHATSAPP_STORE_WRITE_PERF_THRESHOLD_MS,
  250,
);
const WHATSAPP_STORE_WRITE_LOG_FULL_REPLACE =
  String(process.env.WHATSAPP_STORE_WRITE_LOG_FULL_REPLACE || "true").toLowerCase() !== "false";
const messageListCache = new Map();
const messageResponsePayloadCache = new Map();
const parsedStoreCacheTtlMs = Number(WHATSAPP_STORE_CACHE_TTL_MS);
const normalizedStoreCacheTtlMs = Number.isFinite(parsedStoreCacheTtlMs)
  ? Math.max(0, parsedStoreCacheTtlMs)
  : 10 * 60 * 1000;
const WHATSAPP_MAX_MESSAGES_PER_CONVERSATION = Number.parseInt(
  process.env.WHATSAPP_MAX_MESSAGES_PER_CONVERSATION || "200",
  10,
);
const WHATSAPP_MESSAGE_LIST_CACHE_MAX_ENTRIES = Number.parseInt(
  process.env.WHATSAPP_MESSAGE_LIST_CACHE_MAX_ENTRIES || "500",
  10,
);
const WHATSAPP_MESSAGE_RESPONSE_CACHE_MAX_ENTRIES = Number.parseInt(
  process.env.WHATSAPP_MESSAGE_RESPONSE_CACHE_MAX_ENTRIES || "300",
  10,
);

const normalizePositiveInteger = (value, fallback) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

const maxMessagesPerConversation = normalizePositiveInteger(
  WHATSAPP_MAX_MESSAGES_PER_CONVERSATION,
  200,
);
const messageListCacheMaxEntries = normalizePositiveInteger(
  WHATSAPP_MESSAGE_LIST_CACHE_MAX_ENTRIES,
  500,
);
const messageResponsePayloadCacheMaxEntries = normalizePositiveInteger(
  WHATSAPP_MESSAGE_RESPONSE_CACHE_MAX_ENTRIES,
  300,
);

const setBoundedCacheEntry = (cache, key, value, maxEntries) => {
  if (!cache || !key) return;
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
};

const trimStoredMessagesForConversation = (messages) => {
  if (!Array.isArray(messages)) return [];
  if (messages.length <= maxMessagesPerConversation) return messages;
  return messages.slice(-maxMessagesPerConversation);
};

const cloneMainStore = (store) => {
  if (!store || typeof store !== "object") return emptyStore();
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(store);
    } catch {
      // fallback below
    }
  }
  return JSON.parse(JSON.stringify(store));
};

const normalizeMainStore = (parsed) => {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const conversations =
    source.conversations && typeof source.conversations === "object"
      ? source.conversations
      : {};
  const messages = source.messages && typeof source.messages === "object" ? source.messages : {};
  const sessionSource = source.session && typeof source.session === "object" ? source.session : {};
  return {
    ...emptyStore(),
    ...source,
    conversations,
    messages,
    session: {
      assignedUserId: null,
      ...sessionSource,
    },
  };
};

const loadLegacyWhatsappStore = async () =>
  readJsonBackedStore(storePath, emptyStore(), async () =>
    safeReadJsonFile(storePath, emptyStore()),
  );

const isMainStoreCacheFresh = () =>
  normalizedStoreCacheTtlMs > 0 &&
  Boolean(cachedMainStore) &&
  Date.now() - cachedMainStoreAt <= normalizedStoreCacheTtlMs;

const invalidateMainStoreDerivedCaches = () => {
  conversationsPayloadCache = null;
  messageListCache.clear();
  messageResponsePayloadCache.clear();
};

const invalidateMainStoreAfterDirectPersistence = () => {
  cachedMainStore = null;
  cachedMainStoreAt = 0;
  mainStoreRevision += 1;
  invalidateMainStoreDerivedCaches();
};

const getMainStoreRevision = () => mainStoreRevision;

const createPayloadEtag = (payload, signature = "") => {
  const hash = createHash("sha1");
  hash.update(String(signature || ""));
  hash.update(":");
  hash.update(String(payload || ""));
  return `W/"${hash.digest("hex")}"`;
};

const requestMatchesEtag = (req, etag) => {
  const expected = String(etag || "").trim();
  if (!expected) return false;
  return String(req?.headers?.["if-none-match"] || "")
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === expected);
};

const sendJsonPayload = (req, res, payload, { etag = "" } = {}) => {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "private, max-age=0, must-revalidate",
  };
  if (etag) {
    headers.ETag = etag;
    headers.Vary = "Origin, If-None-Match";
  }

  if (etag && requestMatchesEtag(req, etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  res.end(payload);
};

const DELIVERY_STATUS_RANK = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 100,
};

const STATUS_EVENT_CACHE_TTL_MS = Number.parseInt(
  process.env.WHATSAPP_STATUS_EVENT_CACHE_TTL_MS || "600000",
  10,
);
const normalizedStatusEventCacheTtlMs = Number.isFinite(STATUS_EVENT_CACHE_TTL_MS)
  ? Math.max(30000, STATUS_EVENT_CACHE_TTL_MS)
  : 600000;
const outboundStatusEventCache = new Map();
const outboundMessageIndex = new Map();
let outboundMessageIndexRevision = -1;
const MEDIA_PROXY_CACHE_TTL_MS = Number.parseInt(
  process.env.WHATSAPP_MEDIA_PROXY_CACHE_TTL_MS || "300000",
  10,
);
const MEDIA_PROXY_CACHE_MAX_BYTES = Number.parseInt(
  process.env.WHATSAPP_MEDIA_PROXY_CACHE_MAX_BYTES || String(50 * 1024 * 1024),
  10,
);
const normalizedMediaProxyCacheTtlMs = Number.isFinite(MEDIA_PROXY_CACHE_TTL_MS)
  ? Math.max(30000, MEDIA_PROXY_CACHE_TTL_MS)
  : 300000;
const normalizedMediaProxyCacheMaxBytes = Number.isFinite(MEDIA_PROXY_CACHE_MAX_BYTES)
  ? Math.max(1024 * 1024, MEDIA_PROXY_CACHE_MAX_BYTES)
  : 50 * 1024 * 1024;
const mediaProxyCache = new Map();
let mediaProxyCacheBytes = 0;

const getDeliveryStatusRank = (status) => DELIVERY_STATUS_RANK[status] || 0;

const getCachedMediaProxyPayload = (mediaId) => {
  const key = String(mediaId || "").trim();
  if (!key) return null;
  const cached = mediaProxyCache.get(key);
  if (!cached) return null;
  if (Date.now() - Number(cached.at || 0) > normalizedMediaProxyCacheTtlMs) {
    mediaProxyCache.delete(key);
    mediaProxyCacheBytes = Math.max(0, mediaProxyCacheBytes - Number(cached.size || 0));
    return null;
  }
  mediaProxyCache.delete(key);
  mediaProxyCache.set(key, cached);
  return cached;
};

const setCachedMediaProxyPayload = ({ mediaId, mimeType, buffer }) => {
  const key = String(mediaId || "").trim();
  if (!key || !Buffer.isBuffer(buffer) || buffer.length <= 0) return;
  if (buffer.length > normalizedMediaProxyCacheMaxBytes / 2) return;

  const previous = mediaProxyCache.get(key);
  if (previous) {
    mediaProxyCacheBytes = Math.max(0, mediaProxyCacheBytes - Number(previous.size || 0));
    mediaProxyCache.delete(key);
  }

  mediaProxyCache.set(key, {
    mimeType: mimeType || "application/octet-stream",
    buffer,
    size: buffer.length,
    at: Date.now(),
  });
  mediaProxyCacheBytes += buffer.length;

  for (const [cachedKey, cachedValue] of mediaProxyCache.entries()) {
    if (mediaProxyCacheBytes <= normalizedMediaProxyCacheMaxBytes) break;
    mediaProxyCache.delete(cachedKey);
    mediaProxyCacheBytes = Math.max(0, mediaProxyCacheBytes - Number(cachedValue?.size || 0));
  }
};

const pruneStatusEventCache = () => {
  if (outboundStatusEventCache.size < 5000) return;
  const now = Date.now();
  for (const [key, entry] of outboundStatusEventCache.entries()) {
    if (!entry || now - Number(entry.at || 0) > normalizedStatusEventCacheTtlMs) {
      outboundStatusEventCache.delete(key);
    }
  }
};

const shouldSkipMetaStatusEvent = ({ messageId, status }) => {
  const normalizedMessageId = String(messageId || "").trim();
  const normalizedStatus = normalizeDeliveryStatus(status);
  if (!normalizedMessageId || !normalizedStatus) return false;

  pruneStatusEventCache();
  const previous = outboundStatusEventCache.get(normalizedMessageId);
  const now = Date.now();
  const nextRank = getDeliveryStatusRank(normalizedStatus);
  const previousRank = getDeliveryStatusRank(previous?.status);
  const isFresh = previous && now - Number(previous.at || 0) <= normalizedStatusEventCacheTtlMs;

  if (isFresh && previousRank >= nextRank) {
    return true;
  }

  outboundStatusEventCache.set(normalizedMessageId, {
    status: normalizedStatus,
    at: now,
  });
  return false;
};

const indexOutboundMessageIdentifier = (identifier, conversationId, index) => {
  const normalizedIdentifier = String(identifier || "").trim();
  if (!normalizedIdentifier) return;
  outboundMessageIndex.set(normalizedIdentifier, { conversationId, index });
};

const indexOutboundMessage = (conversationId, index, message) => {
  if (!message || typeof message !== "object") return;
  indexOutboundMessageIdentifier(message.id, conversationId, index);
  indexOutboundMessageIdentifier(message.serverMessageId, conversationId, index);
  indexOutboundMessageIdentifier(message.server_message_id, conversationId, index);
  indexOutboundMessageIdentifier(message.providerMessageId, conversationId, index);
  indexOutboundMessageIdentifier(message.provider_message_id, conversationId, index);
  indexOutboundMessageIdentifier(message.wamid, conversationId, index);
  indexOutboundMessageIdentifier(message.clientMessageId, conversationId, index);
  indexOutboundMessageIdentifier(message.client_message_id, conversationId, index);
};

const rebuildOutboundMessageIndex = (store) => {
  outboundMessageIndex.clear();
  Object.entries(store?.messages || {}).forEach(([conversationId, messages]) => {
    if (!Array.isArray(messages)) return;
    messages.forEach((message, index) => indexOutboundMessage(conversationId, index, message));
  });
  outboundMessageIndexRevision = getMainStoreRevision();
};

const findOutboundMessageLocation = (store, messageId) => {
  const normalizedMessageId = String(messageId || "").trim();
  if (!normalizedMessageId) return null;

  if (outboundMessageIndexRevision !== getMainStoreRevision()) {
    rebuildOutboundMessageIndex(store);
  }

  const indexed = outboundMessageIndex.get(normalizedMessageId);
  if (indexed) {
    const indexedMessage = store?.messages?.[indexed.conversationId]?.[indexed.index];
    const matchesIndexedMessage =
      indexedMessage &&
      [
        indexedMessage.id,
        indexedMessage.serverMessageId,
        indexedMessage.server_message_id,
        indexedMessage.providerMessageId,
        indexedMessage.provider_message_id,
        indexedMessage.wamid,
        indexedMessage.clientMessageId,
        indexedMessage.client_message_id,
      ]
        .map((value) => String(value || ""))
        .includes(normalizedMessageId);
    if (matchesIndexedMessage) return indexed;
  }

  for (const [conversationId, messages] of Object.entries(store?.messages || {})) {
    if (!Array.isArray(messages)) continue;
    const targetIndex = messages.findIndex((item) =>
      [
        item?.id,
        item?.serverMessageId,
        item?.server_message_id,
        item?.providerMessageId,
        item?.provider_message_id,
        item?.wamid,
        item?.clientMessageId,
        item?.client_message_id,
      ]
        .map((value) => String(value || ""))
        .includes(normalizedMessageId),
    );
    if (targetIndex >= 0) {
      indexOutboundMessage(conversationId, targetIndex, messages[targetIndex]);
      return { conversationId, index: targetIndex };
    }
  }

  return null;
};

const resolveMessageIdentifierCandidates = (message = {}) =>
  [
    message.id,
    message.serverMessageId,
    message.server_message_id,
    message.providerMessageId,
    message.provider_message_id,
    message.wamid,
    message.messageId,
    message.message_id,
    message.message_key,
    message.clientMessageId,
    message.client_message_id,
    message.temp_id,
    message.raw?.id,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

const findMessageLocationByIdentifier = (store, messageId, options = {}) => {
  const identifierCandidates = [
    messageId,
    ...(Array.isArray(options.identifiers) ? options.identifiers : []),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const candidateSet = new Set(identifierCandidates);
  if (candidateSet.size === 0) return null;

  for (const candidate of candidateSet) {
    const indexed = findOutboundMessageLocation(store, candidate);
    if (indexed) return indexed;
  }

  const scopedConversationIds = [
    options.conversationId,
    options.sourceConversationId,
    options.fallbackConversationId,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const entries =
    scopedConversationIds.length > 0
      ? [
          ...scopedConversationIds
            .filter((conversationId, index, list) => list.indexOf(conversationId) === index)
            .map((conversationId) => [conversationId, store?.messages?.[conversationId]])
            .filter(([, messages]) => Array.isArray(messages)),
          ...Object.entries(store?.messages || {}).filter(
            ([conversationId]) => !scopedConversationIds.includes(conversationId),
          ),
        ]
      : Object.entries(store?.messages || {});

  for (const [conversationId, messages] of entries) {
    if (!Array.isArray(messages)) continue;
    const index = messages.findIndex((message) =>
      resolveMessageIdentifierCandidates(message).some((candidate) => candidateSet.has(candidate)) ||
      (Array.isArray(message?.attachments) &&
        message.attachments.some((attachment) =>
          [
            attachment?.id,
            attachment?.mediaId,
            attachment?.media_id,
            attachment?.providerMediaId,
            attachment?.provider_media_id,
          ]
            .map((value) => String(value || "").trim())
            .filter(Boolean)
            .some((candidate) => candidateSet.has(candidate)),
        )),
    );
    if (index >= 0) return { conversationId, index };
  }

  return null;
};

const getStoreMessageByIdentifier = async (messageId, { mutable = false, ...options } = {}) => {
  const store = await readStore({ mutable });
  const location = findMessageLocationByIdentifier(store, messageId, options);
  if (!location) return { store, location: null, message: null };
  const message = store.messages?.[location.conversationId]?.[location.index] || null;
  return { store, location, message };
};

const resolveMediaIdFromAttachment = (attachment = {}) => {
  const direct = String(
    attachment.id ||
      attachment.mediaId ||
      attachment.media_id ||
      attachment.providerMediaId ||
      attachment.provider_media_id ||
      "",
  ).trim();
  if (direct) return direct;
  const rawUrl = String(attachment.url || "").trim();
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl, "http://maistv.local");
    return String(parsed.searchParams.get("id") || "").trim();
  } catch {
    return "";
  }
};

const fetchMetaMediaBuffer = async (mediaId) => {
  const normalizedMediaId = String(mediaId || "").trim();
  if (!normalizedMediaId) throw new Error("Audio sem media id");

  const cachedMedia = getCachedMediaProxyPayload(normalizedMediaId);
  if (cachedMedia) {
    return {
      buffer: cachedMedia.buffer,
      mimeType: cachedMedia.mimeType || "application/octet-stream",
    };
  }

  const { accessToken } = await resolveMetaConfig();
  if (!accessToken) {
    throw new Error("Token da Meta nao configurado");
  }

  const metaResponse = await fetch(`https://graph.facebook.com/${API_VERSION}/${normalizedMediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaResponse.ok) {
    const text = await metaResponse.text();
    throw new Error(text || "Falha ao buscar metadados da midia");
  }
  const meta = await metaResponse.json();
  const mediaUrl = String(meta?.url || "").trim();
  const mimeType = meta?.mime_type || "application/octet-stream";
  if (!mediaUrl) throw new Error("URL da midia indisponivel");

  const mediaResponse = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!mediaResponse.ok) {
    const text = await mediaResponse.text();
    throw new Error(text || "Falha ao baixar audio da Meta");
  }
  const buffer = Buffer.from(await mediaResponse.arrayBuffer());
  setCachedMediaProxyPayload({ mediaId: normalizedMediaId, mimeType, buffer });
  return { buffer, mimeType };
};

const downloadAudioAttachmentBuffer = async (attachment = {}) => {
  const mediaId = resolveMediaIdFromAttachment(attachment);
  if (mediaId) return fetchMetaMediaBuffer(mediaId);

  const attachmentUrl = String(attachment.url || "").trim();
  if (!attachmentUrl || !/^https?:\/\//i.test(attachmentUrl)) {
    throw new Error("Audio sem URL baixavel");
  }
  const response = await fetch(attachmentUrl);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || "Falha ao baixar audio");
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") || attachment.mimeType || "application/octet-stream",
  };
};

const persistMessageTranscription = async ({ messageId, transcription, lookup = {} }) => {
  const { store, location, message } = await getStoreMessageByIdentifier(messageId, {
    mutable: true,
    ...lookup,
  });
  if (!location || !message) {
    throw new Error("Mensagem nao encontrada");
  }
  const nextMessage = {
    ...message,
    transcription,
    audioTranscription: transcription,
  };
  store.messages[location.conversationId][location.index] = nextMessage;
  await writeStore(store, { conversationIds: [location.conversationId] });
  publishConversationMessageEvent("conversation:message-upserted", {
    conversationId: location.conversationId,
    message: nextMessage,
    status: nextMessage.status,
  });
  return { conversationId: location.conversationId, message: nextMessage };
};

const activeAudioTranscriptionJobs = new Map();

const startAudioTranscriptionJob = ({ messageId, message, force, lookup = {} }) => {
  const normalizedMessageId = String(messageId || "").trim();
  if (!normalizedMessageId) {
    throw new Error("Mensagem nao informada");
  }

  const existingJob = activeAudioTranscriptionJobs.get(normalizedMessageId);
  if (existingJob) return existingJob;

  const job = transcribeAudioMessage({
    message,
    force,
    downloadAudioBuffer: downloadAudioAttachmentBuffer,
    updateMessageTranscription: async (nextTranscription) =>
      persistMessageTranscription({
        messageId: normalizedMessageId,
        transcription: nextTranscription,
        lookup,
      }),
  })
    .catch((error) => {
      console.error("[whisper] audio transcription failed:", error?.message || error);
    })
    .finally(() => {
      activeAudioTranscriptionJobs.delete(normalizedMessageId);
    });

  activeAudioTranscriptionJobs.set(normalizedMessageId, job);
  return job;
};

const toTimeMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};

const resolveLastClientMessageTime = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.type === "client" && candidate?.timestamp) {
      return candidate.timestamp;
    }
  }
  return null;
};

const resolveConversationActivityTimeMs = (conversation) =>
  Math.max(
    toTimeMs(conversation?.last_received_at || conversation?.lastClientMessageTime),
    toTimeMs(conversation?.last_sent_at),
    toTimeMs(conversation?.last_message_at || conversation?.lastMessageTime),
  );

const isMessagesChronological = (messages) => {
  if (!Array.isArray(messages) || messages.length < 2) return true;
  let previous = toTimeMs(messages[0]?.timestamp);
  for (let index = 1; index < messages.length; index += 1) {
    const current = toTimeMs(messages[index]?.timestamp);
    if (current < previous) return false;
    previous = current;
  }
  return true;
};

const buildMessageListSignature = (messages) =>
  `${getMainStoreRevision()}|${messages.length}|${messages[0]?.id || ""}|${
    messages[0]?.timestamp || ""
  }|${messages[messages.length - 1]?.id || ""}|${messages[messages.length - 1]?.timestamp || ""}`;

const getSortedMessages = (conversationId, messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const signature = buildMessageListSignature(messages);
  const cached = messageListCache.get(conversationId);
  if (cached?.signature === signature) {
    return cached.messages;
  }
  const sorted = isMessagesChronological(messages)
    ? messages
    : [...messages].sort((a, b) => toTimeMs(a?.timestamp) - toTimeMs(b?.timestamp));
  setBoundedCacheEntry(messageListCache, conversationId, { signature, messages: sorted }, messageListCacheMaxEntries);
  return sorted;
};

const buildConversationListItem = (conversation, painelCustomersByPhone, messages = []) => {
  const item = {
    ...(conversation || {}),
    customer:
      conversation?.customer && typeof conversation.customer === "object"
        ? { ...conversation.customer }
        : conversation?.customer,
  };
  const normalizedPhone = normalizePhone(item?.customer?.phone || item?.id || "") || null;
  if (normalizedPhone) {
    const painelCustomer = painelCustomersByPhone.get(normalizedPhone);
    if (painelCustomer) {
      const painelUsuario =
        painelCustomer.usuario || painelCustomer.user || painelCustomer.username || null;
      if (painelUsuario) {
        item.customer = item.customer || {};
        item.customer.usuario = painelUsuario;
        if (!item.customer.username) {
          item.customer.username = painelUsuario;
        }
        if (isUnknownCustomerName(item.customer.name, normalizedPhone)) {
          item.customer.name = painelUsuario;
        }
      }
    }
  }

  if (!item.lastClientMessageTime && Array.isArray(messages) && messages.length > 0) {
    item.lastClientMessageTime = resolveLastClientMessageTime(messages);
  }

  return item;
};

const buildConversationListResponse = (store, painelCustomers) => {
  const painelCustomersByPhone = buildPainelCustomersPhoneIndex(painelCustomers);
  const conversations = Object.values(store?.conversations || {}).map((conversation) =>
    buildConversationListItem(
      conversation,
      painelCustomersByPhone,
      store?.messages?.[conversation?.id] || [],
    ),
  );

  conversations.sort(
    (a, b) => resolveConversationActivityTimeMs(b) - resolveConversationActivityTimeMs(a),
  );
  return conversations;
};

const isConversationSummaryRequest = (searchParams) => {
  const raw = String(searchParams?.get?.("summary") || searchParams?.get?.("mode") || "").trim().toLowerCase();
  return ["1", "true", "yes", "sim", "summary", "list"].includes(raw);
};

const loadSqliteConversationSummaryPage = async ({
  searchParams,
  painelCustomers,
  requestedLabelIds = [],
}) => {
  if (!isWhatsappSqliteStoreEnabled()) return null;
  const pagination =
    getOptionalPaginationFromSearchParams(searchParams, { defaultLimit: 50, maxLimit: 1000 }) ||
    { page: 1, limit: 50, offset: 0 };
  const page = await listWhatsappSqliteConversations({
    page: pagination.page,
    limit: pagination.limit,
    fallbackLoader: loadLegacyWhatsappStore,
  });
  if (!page) return null;

  const painelCustomersByPhone = buildPainelCustomersPhoneIndex(painelCustomers);
  const baseConversations = page.items.map((conversation) =>
    buildConversationListItem(conversation, painelCustomersByPhone),
  );
  const conversations = await enrichConversationsWithLabels(
    baseConversations,
    painelCustomers,
    requestedLabelIds,
  );

  return {
    items: conversations,
    page: page.page,
    limit: page.limit,
    total: page.total,
    hasMore: page.hasMore,
    summary: true,
  };
};

const loadConversationDetailItems = async ({ conversationId, phone, painelCustomers }) => {
  const safeConversationId = String(conversationId || "").trim();
  const normalizedPhone =
    normalizePhone(phone) ||
    (safeConversationId.startsWith("agg-") ? normalizePhone(safeConversationId.slice(4)) : "");
  const painelCustomersByPhone = buildPainelCustomersPhoneIndex(painelCustomers);

  if (isWhatsappSqliteStoreEnabled()) {
    const itemsById = new Map();
    if (normalizedPhone) {
      const phoneItems = await listWhatsappSqliteConversationsByPhone(normalizedPhone, {
        fallbackLoader: loadLegacyWhatsappStore,
        limit: 100,
      });
      for (const item of phoneItems || []) {
        if (item?.id) itemsById.set(String(item.id), item);
      }
    }
    if (safeConversationId && !safeConversationId.startsWith("agg-")) {
      const directItem = await getWhatsappSqliteConversation(safeConversationId, {
        fallbackLoader: loadLegacyWhatsappStore,
      });
      if (directItem?.id) itemsById.set(String(directItem.id), directItem);
    }
    if (itemsById.size > 0) {
      return Array.from(itemsById.values()).map((conversation) =>
        buildConversationListItem(conversation, painelCustomersByPhone),
      );
    }
  }

  const store = await readStore({ mutable: false });
  const sourceConversations = Object.values(store?.conversations || {}).filter((conversation) => {
    const currentId = String(conversation?.id || "").trim();
    const currentPhone = normalizePhone(conversation?.customer?.phone || conversation?.phone || currentId);
    return (
      (safeConversationId && currentId === safeConversationId) ||
      (normalizedPhone && currentPhone === normalizedPhone)
    );
  });

  return sourceConversations.map((conversation) =>
    buildConversationListItem(conversation, painelCustomersByPhone, store?.messages?.[conversation?.id] || []),
  );
};

const normalizeRequestedLabelIds = (value) => {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .flatMap((item) => String(item || "").split(","))
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    );
  }
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
};

// Anexa etiquetas resolvidas ao payload das conversas e aplica filtro por etiquetas selecionadas.
const enrichConversationsWithLabels = async (conversations, painelCustomers, selectedLabelIds = []) => {
  const baseConversations = Array.isArray(conversations) ? conversations : [];
  if (!baseConversations.length) return [];
  const painelCustomersList = Object.values(painelCustomers || {}).filter(
    (row) => row && typeof row === "object",
  );
  try {
    const resolvedByConversationId = await resolveConversationLabels({
      conversations: baseConversations,
      painelCustomers: painelCustomersList,
    });
    const selectedSet = new Set(normalizeRequestedLabelIds(selectedLabelIds));
    return baseConversations
      .map((conversation) => {
        const resolved = resolvedByConversationId.get(conversation.id) || null;
        const labels = Array.isArray(resolved?.labels) ? resolved.labels : [];
        const customerSource =
          conversation?.customer && typeof conversation.customer === "object"
            ? conversation.customer
            : {};
        return {
          ...conversation,
          labels,
          customer: {
            ...customerSource,
            contactId: resolved?.contactId || customerSource.contactId || null,
            existsInBase:
              typeof resolved?.existsInBase === "boolean"
                ? resolved.existsInBase
                : Boolean(customerSource.existsInBase),
            isTeste:
              typeof resolved?.isTeste === "boolean"
                ? resolved.isTeste
                : Boolean(customerSource.isTeste),
          },
        };
      })
      .filter((conversation) => {
        if (!selectedSet.size) return true;
        return Array.isArray(conversation.labels)
          ? conversation.labels.some((label) => selectedSet.has(String(label?.id || "")))
          : false;
      });
  } catch (error) {
    console.error("[labels] failed to enrich conversations:", error?.message || error);
    return baseConversations;
  }
};

const loadChannelConversationContext = async (channel = "support") => {
  const normalizedChannel = String(channel || "support").trim().toLowerCase() === "sales"
    ? "sales"
    : "support";
  const persistedCustomerRows = await readPersistedCustomerRows();
  const painelCustomers = buildPersistedCustomersObject(persistedCustomerRows);
  if (normalizedChannel === "sales") {
    let salesConversations = [];
    if (BAILEYS_API_URL) {
      const response = await fetch(`${BAILEYS_API_URL}/api/whatsapp/conversations`);
      if (!response.ok) {
        throw new Error("Failed to fetch sales conversations");
      }
      const payload = await response.text();
      const parsed = parseLenientJson(payload);
      salesConversations = Array.isArray(parsed) ? parsed : [];
    }
    return {
      channel: normalizedChannel,
      painelCustomers,
      painelCustomersList: persistedCustomerRows,
      conversations: await enrichConversationsWithLabels(salesConversations, painelCustomers),
    };
  }

  const store = await readStore({ mutable: false });
  const supportConversations = buildConversationListResponse(store, painelCustomers);
  return {
    channel: normalizedChannel,
    painelCustomers,
    painelCustomersList: persistedCustomerRows,
    conversations: await enrichConversationsWithLabels(supportConversations, painelCustomers),
  };
};

const resolveLabelsHttpStatus = (error) => {
  const message = String(error?.message || "").toLowerCase();
  if (
    message.includes("nao encontrado") ||
    message.includes("não encontrado") ||
    message.includes("nao encontrada") ||
    message.includes("não encontrada")
  ) {
    return 404;
  }
  if (
    message.includes("obrigatorio") ||
    message.includes("obrigatório") ||
    message.includes("inval") ||
    message.includes("padrao") ||
    message.includes("padrão")
  ) {
    return 400;
  }
  return 500;
};

const isLabelsContactNotFoundError = (error) => {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("contato nao encontrado") || message.includes("contato n??o encontrado");
};

// Mantem a base SQL de contatos alinhada ao estado atual do store e da sincronizacao do painel.
let cachedLabelSyncResult = { conversations: [], painelCustomers: {} };
let cachedLabelSyncAt = 0;
let cachedLabelSyncPromise = null;
const LABEL_CONTEXT_SYNC_TTL_MS = Number.parseInt(process.env.LABEL_CONTEXT_SYNC_TTL_MS || "300000", 10);

const syncCurrentContactsForLabels = async ({ force = false } = {}) => {
  const ttlMs =
    Number.isFinite(LABEL_CONTEXT_SYNC_TTL_MS) && LABEL_CONTEXT_SYNC_TTL_MS > 0
      ? LABEL_CONTEXT_SYNC_TTL_MS
      : 300000;
  if (cachedLabelSyncPromise) {
    return cachedLabelSyncPromise;
  }
  if (!force && cachedLabelSyncAt > 0 && Date.now() - cachedLabelSyncAt <= ttlMs) {
    return cachedLabelSyncResult;
  }

  cachedLabelSyncPromise = (async () => {
    const store = await readStore({ mutable: false });
    const persistedCustomerRows = await readPersistedCustomerRows();
    const painelCustomers = buildPersistedCustomersObject(persistedCustomerRows);
    const conversations = buildConversationListResponse(store, painelCustomers);
    let salesConversations = [];
    if (BAILEYS_API_URL) {
      try {
        const response = await fetch(`${BAILEYS_API_URL}/api/whatsapp/conversations`);
        if (response.ok) {
          const payload = await response.text();
          const parsed = parseLenientJson(payload);
          salesConversations = Array.isArray(parsed) ? parsed : [];
        }
      } catch (error) {
        console.error("[labels] failed to sync sales conversations:", error?.message || error);
      }
    }
    await syncContactsSnapshot({
      conversations: [...conversations, ...salesConversations],
      painelCustomers: persistedCustomerRows,
      force,
    });
    cachedLabelSyncResult = { conversations, painelCustomers };
    cachedLabelSyncAt = Date.now();
    return cachedLabelSyncResult;
  })();

  try {
    return await cachedLabelSyncPromise;
  } finally {
    cachedLabelSyncPromise = null;
  }
};

const withContactLabelsRetry = async (task) => {
  try {
    return await task();
  } catch (error) {
    if (!isLabelsContactNotFoundError(error)) {
      throw error;
    }
    await syncCurrentContactsForLabels({ force: true });
    return task();
  }
};

const resolveFlowHttpStatus = (error) => {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("not found") || message.includes("nao encontrado") || message.includes("não encontrado")) {
    return 404;
  }
  if (message.includes("required") || message.includes("missing") || message.includes("invalid") || message.includes("obrig")) {
    return 400;
  }
  return 500;
};

const buildFlowRuntimeContext = async ({ waId, conversation, incomingText, variables = {} }) => {
  const normalizedPhone = normalizePhone(waId);
  const painelStore = await readPainelStore();
  const painelEntry = findPainelCustomerEntry(painelStore, { phone: normalizedPhone })?.row || null;
  const packageLabel = String(
    painelEntry?.packageName || painelEntry?.planoAtual || painelEntry?.plan || "",
  ).toUpperCase();
  return {
    waId: normalizedPhone,
    incomingText: String(incomingText || ""),
    contactName:
      conversation?.customer?.name ||
      painelEntry?.nome ||
      painelEntry?.name ||
      painelEntry?.usuario ||
      normalizedPhone,
    existsInBase: Boolean(painelEntry),
    isTeste: packageLabel.includes("TESTE"),
    status: conversation?.status || "",
    variables: variables && typeof variables === "object" ? variables : {},
    now: new Date(),
  };
};

const applyFlowPatchToSupportConversation = async (conversationId, patch = {}, tags = []) => {
  if (!conversationId) return null;
  const store = await readStore();
  const conversation = store.conversations[conversationId];
  if (!conversation) return null;

  if (patch?.sector) {
    conversation.sector = patch.sector;
  }
  if (patch?.priority) {
    conversation.priority = patch.priority;
  }
  if (Array.isArray(tags) && tags.length) {
    const nextTags = new Set(Array.isArray(conversation.tags) ? conversation.tags : []);
    for (const tag of tags) {
      const value = String(tag || "").trim();
      if (value) nextTags.add(value);
    }
    conversation.tags = Array.from(nextTags);
  }

  store.conversations[conversationId] = conversation;
  await writeStore(store, { conversationIds: [conversationId] });
  return conversation;
};

const normalizeFlowLabelNames = (values = []) =>
  Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

const normalizeFlowLabelLookup = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const applyFlowLabelsToSupportConversation = async ({
  conversationId,
  labelsToAdd = [],
  labelsToRemove = [],
}) => {
  const sanitizedAdd = normalizeFlowLabelNames(labelsToAdd);
  const sanitizedRemove = normalizeFlowLabelNames(labelsToRemove);
  if (!conversationId || (!sanitizedAdd.length && !sanitizedRemove.length)) {
    return null;
  }

  await ensureLabelsReady();
  const store = await readStore({ mutable: false });
  const persistedCustomerRows = await readPersistedCustomerRows();
  const painelCustomers = buildPersistedCustomersObject(persistedCustomerRows);
  const rawConversation = store?.conversations?.[conversationId];
  if (!rawConversation || typeof rawConversation !== "object") return null;

  const targetConversation = {
    ...rawConversation,
    customer:
      rawConversation?.customer && typeof rawConversation.customer === "object"
        ? { ...rawConversation.customer }
        : {},
  };

  const normalizedPhone = normalizePhone(
    targetConversation?.customer?.phone || targetConversation?.id || "",
  );
  if (normalizedPhone) {
    const painelCustomer = buildPainelCustomersPhoneIndex(painelCustomers).get(normalizedPhone);
    if (painelCustomer) {
      const painelUsuario =
        painelCustomer.usuario || painelCustomer.user || painelCustomer.username || null;
      if (painelUsuario) {
        targetConversation.customer.usuario = painelUsuario;
        if (!targetConversation.customer.username) {
          targetConversation.customer.username = painelUsuario;
        }
        if (isUnknownCustomerName(targetConversation.customer.name, normalizedPhone)) {
          targetConversation.customer.name = painelUsuario;
        }
      }
    }
  }

  if (!targetConversation) return null;

  const resolvedMap = await resolveConversationLabels({
    conversations: [targetConversation],
    painelCustomers: persistedCustomerRows,
  });
  const resolved = resolvedMap.get(String(conversationId));
  const contactId = String(resolved?.contactId || "").trim();
  if (!contactId) return null;

  const existingLabels = await listLabels();
  const labelsByNormalizedName = new Map(
    existingLabels.map((label) => [normalizeFlowLabelLookup(label?.name), label]),
  );

  const ensureLabelId = async (name) => {
    const normalized = normalizeFlowLabelLookup(name);
    if (!normalized) return null;
    const existing = labelsByNormalizedName.get(normalized);
    if (existing) return String(existing.id);
    const created = await createContactLabel({
      name,
      color: "#7C3AED",
      visibleInFilter: true,
    });
    labelsByNormalizedName.set(normalized, created);
    return String(created.id);
  };

  const currentContactLabels = await withContactLabelsRetry(() => getContactLabelsById(contactId));
  const currentManualLabelIds = currentContactLabels
    .filter((label) => label.assignmentSource === "manual")
    .map((label) => String(label.id));

  const labelIdsToRemove = new Set(
    sanitizedRemove
      .map((name) => labelsByNormalizedName.get(normalizeFlowLabelLookup(name)))
      .filter((label) => label && !label.isDefault)
      .map((label) => String(label.id)),
  );

  const nextManualLabelIds = new Set(
    currentManualLabelIds.filter((labelId) => !labelIdsToRemove.has(labelId)),
  );

  for (const labelName of sanitizedAdd) {
    const labelId = await ensureLabelId(labelName);
    if (labelId) {
      nextManualLabelIds.add(labelId);
    }
  }

  return withContactLabelsRetry(() =>
    replaceContactManualLabels(contactId, Array.from(nextManualLabelIds)),
  );
};

const buildFlowOutputPreviewText = (output) => {
  if (!output || typeof output !== "object") return "";
  if (output.type === "media") {
    const caption = String(output.caption || "").trim();
    return caption || `[${String(output.mediaType || "media").trim() || "media"}]`;
  }
  if (output.type === "interactive_buttons") {
    const buttonTitles = Array.isArray(output.buttons)
      ? output.buttons.map((button) => String(button?.title || "").trim()).filter(Boolean)
      : [];
    return [String(output.text || "").trim(), buttonTitles.join(" | ")].filter(Boolean).join("\n");
  }
  if (output.type === "interactive_list") {
    const rowTitles = Array.isArray(output.rows)
      ? output.rows.map((row) => String(row?.title || "").trim()).filter(Boolean)
      : [];
    return [String(output.text || "").trim(), rowTitles.join(" | ")].filter(Boolean).join("\n");
  }
  return String(output.text || "").trim();
};

const normalizeOutboundMediaLink = (asset) => {
  const raw = String(asset || "").trim();
  if (!raw) return "";
  return (
    normalizeTemplateMediaUrl(raw, {
      publicOrigin: WHATSAPP_TEMPLATE_MEDIA_PUBLIC_ORIGIN,
      apiBaseUrl: TEMPLATE_MEDIA_PUBLIC_API_BASE_URL,
      fallbackOrigin: ALLOWED_ORIGIN,
    }) || raw
  );
};

const FLOW_SUPPORT_OUTPUT_INTERVAL_SECONDS = Math.max(
  0,
  Number(process.env.FLOW_SUPPORT_OUTPUT_INTERVAL_SECONDS || "2"),
);

const sleepFlowOutput = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });

const sendFlowOutputsForSupport = async ({ waId, outputs = [] }) => {
  const delivered = [];
  let sentCount = 0;
  let explicitDelayApplied = false;
  for (const output of Array.isArray(outputs) ? outputs : []) {
    if (!output || typeof output !== "object") continue;
    if (output.type === "delay") {
      const seconds = Math.max(0, Number(output.seconds || 0));
      if (seconds > 0) {
        await sleepFlowOutput(seconds * 1000);
      }
      explicitDelayApplied = true;
      continue;
    }
    if (sentCount > 0 && !explicitDelayApplied && FLOW_SUPPORT_OUTPUT_INTERVAL_SECONDS > 0) {
      await sleepFlowOutput(FLOW_SUPPORT_OUTPUT_INTERVAL_SECONDS * 1000);
    }
    if (output.type === "interactive_buttons" || output.type === "interactive_list") {
      const result = await sendInteractiveMessage({
        to: waId,
        text: output.text,
        header: output.header
          ? {
              ...output.header,
              asset: normalizeOutboundMediaLink(output.header.asset || output.header.link || ""),
            }
          : null,
        footer: output.footer || null,
        buttons: output.type === "interactive_buttons" ? output.buttons || [] : [],
        buttonText: output.type === "interactive_list" ? output.buttonText || "MENU" : "MENU",
        rows: output.type === "interactive_list" ? output.rows || [] : [],
      });
      delivered.push({
        output,
        result,
        previewText: buildFlowOutputPreviewText(output),
      });
      sentCount += 1;
      explicitDelayApplied = false;
      continue;
    }

    if (output.type === "media") {
      const mediaType = String(output.mediaType || "").trim().toLowerCase();
      const mediaLink = normalizeOutboundMediaLink(output.asset || output.link || "");
      if (!["image", "video", "document"].includes(mediaType) || !mediaLink) continue;
      const result = await sendMediaMessage({
        to: waId,
        mediaType,
        mediaLink,
        caption: String(output.caption || "").trim(),
      });
      delivered.push({
        output,
        result,
        previewText: buildFlowOutputPreviewText(output),
      });
      sentCount += 1;
      explicitDelayApplied = false;
      continue;
    }

    const text = String(output.text || "").trim();
    if (!text) continue;
    const result = await sendTextMessage({ to: waId, text });
    delivered.push({ output, result, previewText: text });
    sentCount += 1;
    explicitDelayApplied = false;
  }
  return delivered;
};

const persistFlowPauseForSupport = async ({
  sessionId = null,
  flow,
  conversationId,
  waId,
  pause,
  variables = {},
}) => {
  if (!pause?.nodeId || !pause?.type) return null;
  return saveFlowSession({
    id: sessionId,
    flowId: flow.id,
    channel: "support",
    conversationId,
    waId,
    currentNodeId: pause.nodeId,
    waitType: pause.type,
    variables,
    metadata: {
      timeoutSeconds: Number(pause.timeoutSeconds || 0),
    },
    status: "waiting",
  });
};

const normalizeFlowReferenceValue = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const canonicalizeFlowReferenceValue = (value) =>
  normalizeFlowReferenceValue(value)
    .replace(/^(hsm|flow)\s*[:\-]\s*/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

const resolveRedirectFlowTarget = (flows, flowRef) => {
  const normalizedRef = normalizeFlowReferenceValue(flowRef);
  const canonicalRef = canonicalizeFlowReferenceValue(flowRef);
  if (!normalizedRef) return null;
  return (
    flows.find((item) => String(item?.id || "").trim() === String(flowRef || "").trim()) ||
    flows.find((item) => normalizeFlowReferenceValue(item?.name) === normalizedRef) ||
    flows.find((item) => canonicalizeFlowReferenceValue(item?.name) === canonicalRef) ||
    null
  );
};

const resolveRedirectNodeId = (flow, redirect = {}) => {
  if (!flow || !Array.isArray(flow.nodes)) return "";
  const directId = String(redirect.componentId || "").trim();
  if (directId) {
    const exists = flow.nodes.find((node) => String(node?.id || "").trim() === directId);
    if (exists) return directId;
  }

  const identifier = normalizeFlowReferenceValue(redirect.componentIdentifier);
  if (!identifier) return "";
  const targetNode = flow.nodes.find((node) => {
    const config = node?.config && typeof node.config === "object" ? node.config : {};
    return normalizeFlowReferenceValue(config.identifier || node?.label || "") === identifier;
  });
  return targetNode ? String(targetNode.id || "") : "";
};

const markRoutineConversationAsBroadcast = async (phone) => {
  const normalizedTo = normalizePhone(phone);
  if (!normalizedTo) return;
  const store = await readStore();
  const conversationId = mergeConversationIds(store, normalizedTo);
  const conversation =
    store.conversations[conversationId] || buildConversation({ waId: normalizedTo, name: null });
  const tags = new Set(Array.isArray(conversation.tags) ? conversation.tags : []);
  tags.add("disparo");
  conversation.tags = Array.from(tags);
  store.conversations[conversationId] = conversation;
  await writeStore(store, { conversationIds: [conversationId] });
};

const getRoutineConversationWindowState = async (phone, now = new Date(), storeOverride = null) => {
  const normalizedTo = normalizePhone(phone);
  if (!normalizedTo) {
    return {
      within24hWindow: false,
      lastClientMessageTime: null,
      conversationId: null,
    };
  }
  const store = storeOverride || (await readStore());
  const conversationId = mergeConversationIds(store, normalizedTo);
  const conversation =
    store?.conversations?.[conversationId] || buildConversation({ waId: normalizedTo, name: null });
  const lastClientMessageTime =
    conversation?.lastClientMessageTime ||
    resolveLastClientMessageTime(store?.messages?.[conversationId] || []) ||
    null;
  const lastClientTimeMs = lastClientMessageTime ? Date.parse(lastClientMessageTime) : NaN;
  const within24hWindow =
    Number.isFinite(lastClientTimeMs) &&
    now.getTime() - lastClientTimeMs <= 24 * 60 * 60 * 1000;
  return {
    within24hWindow,
    lastClientMessageTime,
    conversationId,
  };
};

const findRoutineAlternativeTemplate = async (routine) => {
  const desiredId = String(routine?.alternativeTemplateId || "").trim();
  const desiredName = String(routine?.alternativeTemplateName || "").trim().toLowerCase();
  if (!desiredId && !desiredName) return null;
  const items = await listLocalTemplates();
  return (
    items.find((item) => desiredId && String(item?.id || "").trim() === desiredId) ||
    items.find((item) => desiredName && String(item?.name || "").trim().toLowerCase() === desiredName) ||
    null
  );
};

const buildRoutineAlternativeTemplatePayload = ({
  template,
  row,
  checkoutToken,
  checkoutLink,
  dueDateKey,
  todayDateKey,
}) => {
  const renderValue = (value) =>
    applyRoutineVariables({
      template: value,
      row,
      checkoutToken,
      checkoutLink,
      dueDateKey,
      todayDateKey,
    }).trim();

  const headerType = normalizeLocalTemplateHeaderType(template?.headerType || template?.headerFormat || "none");
  const headerText =
    headerType === "text"
      ? renderValue(template?.headerText || template?.headerExample || "")
      : "";
  const headerMediaUrl =
    headerType !== "text" && headerType !== "none"
      ? renderValue(template?.headerMediaUrl || template?.headerExample || "")
      : "";
  const bodyText = renderValue(template?.content || "");
  const footerText = renderValue(template?.footer || "");

  const buttonLines = [];
  if (template?.hasButton && (template?.buttonText || template?.buttonUrl)) {
    const buttonText = String(template?.buttonText || "").trim();
    const buttonUrl = renderValue(template?.buttonUrl || "");
    if (buttonText && buttonUrl) {
      buttonLines.push(`${buttonText}: ${buttonUrl}`);
    } else if (buttonText) {
      buttonLines.push(buttonText);
    } else if (buttonUrl) {
      buttonLines.push(buttonUrl);
    }
  }

  if (Array.isArray(template?.buttonConfig)) {
    template.buttonConfig.forEach((button) => {
      const label = String(button?.text || "").trim();
      if (!label) return;
      if (String(button?.type || "").toLowerCase() === "acessar_site") {
        const url = renderValue(button?.url || "");
        buttonLines.push(url ? `${label}: ${url}` : label);
        return;
      }
      buttonLines.push(label);
    });
  }

  const text = [headerText, bodyText, footerText, ...buttonLines].filter(Boolean).join("\n").trim();
  return {
    templateName: String(template?.name || "").trim(),
    headerType,
    headerMediaUrl,
    text,
  };
};

const findLocalTemplateById = async (templateId) => {
  const desiredId = String(templateId || "").trim();
  if (!desiredId) return null;
  const items = await listLocalTemplates();
  return items.find((item) => String(item?.id || "").trim() === desiredId) || null;
};

const buildLabelCampaignTemplateContext = ({ contact, painelRow }) => {
  const dueDateKey = extractCustomerDueDateKey(painelRow || {}, DEFAULT_ROUTINE_TIMEZONE);
  const createdDateKey = extractCustomerCreatedDateKey(painelRow || {}, DEFAULT_ROUTINE_TIMEZONE);
  const status = String(painelRow?.status || painelRow?.situacao || contact?.status || "").trim();
  const customerName = String(
    painelRow?.usuario ||
      painelRow?.username ||
      contact?.name ||
      contact?.number ||
      "",
  ).trim();
  const phone = normalizePhone(contact?.number || painelRow?.whatsapp || painelRow?.phone || "");
  return {
    nome: customerName,
    usuario: String(painelRow?.usuario || painelRow?.username || customerName).trim(),
    telefone: phone,
    whatsapp: phone,
    plano: String(painelRow?.packageName || painelRow?.planoAtual || "").trim(),
    status,
    situacao: status,
    vencimento: dueDateKey ? formatDateKeyPtBr(dueDateKey) : "",
    cadastro: createdDateKey ? formatDateKeyPtBr(createdDateKey) : "",
    customerId: String(painelRow?.customerId || painelRow?.id || "").trim(),
  };
};

const applyLabelCampaignVariables = (value, context) => {
  const source = String(value || "");
  if (!source) return "";
  const map = {
    nome: context?.nome || "",
    usuario: context?.usuario || "",
    telefone: context?.telefone || "",
    whatsapp: context?.whatsapp || "",
    plano: context?.plano || "",
    status: context?.status || "",
    situacao: context?.situacao || "",
    vencimento: context?.vencimento || "",
    cadastro: context?.cadastro || "",
    customerId: context?.customerId || "",
  };
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => map[key] ?? "");
};

const buildLabelCampaignInternalTemplatePayload = ({ template, context }) => {
  const renderValue = (value) => applyLabelCampaignVariables(value, context).trim();
  const headerType = normalizeLocalTemplateHeaderType(template?.headerType || template?.headerFormat || "none");
  const headerText =
    headerType === "text"
      ? renderValue(template?.headerText || template?.headerExample || "")
      : "";
  const headerMediaUrl =
    headerType !== "text" && headerType !== "none"
      ? renderValue(template?.headerMediaUrl || template?.headerExample || "")
      : "";
  const bodyText = renderValue(template?.content || "");
  const footerText = renderValue(template?.footer || "");
  const buttonLines = [];

  if (template?.hasButton && (template?.buttonText || template?.buttonUrl)) {
    const buttonText = renderValue(template?.buttonText || "");
    const buttonUrl = renderValue(template?.buttonUrl || "");
    if (buttonText && buttonUrl) {
      buttonLines.push(`${buttonText}: ${buttonUrl}`);
    } else if (buttonText) {
      buttonLines.push(buttonText);
    } else if (buttonUrl) {
      buttonLines.push(buttonUrl);
    }
  }

  if (Array.isArray(template?.buttonConfig)) {
    template.buttonConfig.forEach((button) => {
      const label = renderValue(button?.text || "");
      if (!label) return;
      const url = renderValue(button?.url || "");
      buttonLines.push(url ? `${label}: ${url}` : label);
    });
  }

  return {
    templateName: String(template?.name || "").trim(),
    headerType,
    headerMediaUrl,
    text: [headerText, bodyText, footerText, ...buttonLines].filter(Boolean).join("\n").trim(),
  };
};

const collectTemplateIndexedParameters = (text, values = []) => {
  const indexes = Array.from(
    new Set(
      String(text || "")
        .match(/\{\{\d+\}\}/g)?.map((token) => Number(token.replace(/\D/g, ""))) || [],
    ),
  ).sort((a, b) => a - b);
  return indexes.map((index) => String(values[index - 1] || ""));
};

const buildLabelCampaignMetaTemplatePayload = async ({ templateName, language, context }) => {
  const template = await findMetaTemplateForPreview({ templateName, language });
  const orderedValues = [
    context?.nome,
    context?.usuario,
    context?.telefone,
    context?.plano,
    context?.vencimento,
    context?.status,
    context?.cadastro,
    context?.customerId,
  ].map((value) => String(value || ""));
  const bodyComponent = template?.components?.find((component) => String(component?.type || "").toUpperCase() === "BODY");
  const headerComponent = template?.components?.find((component) => String(component?.type || "").toUpperCase() === "HEADER");
  const buttonsComponent = template?.components?.find((component) => String(component?.type || "").toUpperCase() === "BUTTONS");
  const headerFormat = String(headerComponent?.format || "").toUpperCase();
  const buttonUrlTemplate = Array.isArray(buttonsComponent?.buttons)
    ? buttonsComponent.buttons.find((button) => String(button?.type || "").toUpperCase() === "URL")?.url
    : "";
  return {
    template,
    bodyParameters: collectTemplateIndexedParameters(bodyComponent?.text || "", orderedValues),
    headerParameters:
      headerFormat === "TEXT"
        ? collectTemplateIndexedParameters(headerComponent?.text || "", orderedValues)
        : [],
    buttonParameters: collectTemplateIndexedParameters(buttonUrlTemplate || "", orderedValues),
    headerFormat: headerFormat || undefined,
  };
};

const executeFlowPlanForSupport = async ({
  flow,
  runId,
  conversationId,
  waId,
  plan,
  sessionId = null,
  runtimeContext = {},
}) => {
  let currentFlow = flow;
  let currentPlan = plan;
  let currentSessionId = sessionId;
  let trace = Array.isArray(plan?.trace) ? [...plan.trace] : [];

  while (currentFlow && currentPlan) {
    const delivered = await sendFlowOutputsForSupport({ waId, outputs: currentPlan.outputs || [] });
    for (const item of delivered) {
      const responseMessageId = item?.result?.messages?.[0]?.id;
      if (!responseMessageId) continue;
      await upsertAgentMessage({
        to: waId,
        text: item.previewText,
        messageId: responseMessageId,
        origin: "flow",
      });
    }

    if (
      (Array.isArray(currentPlan.labelsToAdd) && currentPlan.labelsToAdd.length) ||
      (Array.isArray(currentPlan.labelsToRemove) && currentPlan.labelsToRemove.length)
    ) {
      void applyFlowLabelsToSupportConversation({
        conversationId,
        labelsToAdd: currentPlan.labelsToAdd,
        labelsToRemove: currentPlan.labelsToRemove,
      }).catch((error) => {
        console.error("[flow] failed to apply labels:", error?.message || error);
      });
    }

    if (Object.keys(currentPlan.patch || {}).length) {
      await applyFlowPatchToSupportConversation(conversationId, currentPlan.patch, []);
    }

    if (currentPlan.pause) {
      await persistFlowPauseForSupport({
        sessionId: currentSessionId,
        flow: currentFlow,
        conversationId,
        waId,
        pause: currentPlan.pause,
        variables: currentPlan.variables || {},
      });
      await completeFlowRun(runId, { status: "completed", trace });
      return { flow: currentFlow, trace, paused: true };
    }

    if (currentPlan.redirect?.flowRef) {
      const flows = await listFlows();
      const targetFlow = resolveRedirectFlowTarget(flows, currentPlan.redirect.flowRef);
      if (!targetFlow || targetFlow.status !== "active") {
        trace.push({
          nodeId: String(currentPlan.redirect.componentId || ""),
          type: "redirect_flow_missing",
          label: String(currentPlan.redirect.flowRef || ""),
        });
        break;
      }

      const redirectedPlan = buildFlowExecutionPlan(targetFlow, {
        ...runtimeContext,
        variables: currentPlan.variables || {},
        startNodeId: resolveRedirectNodeId(targetFlow, currentPlan.redirect),
        resumeAtCurrentNode: false,
      });

      if (!redirectedPlan) {
        trace.push({
          nodeId: String(currentPlan.redirect.componentId || ""),
          type: "redirect_plan_empty",
          label: String(currentPlan.redirect.flowRef || ""),
        });
        break;
      }

      currentFlow = targetFlow;
      currentPlan = redirectedPlan;
      trace = [...trace, ...(Array.isArray(redirectedPlan.trace) ? redirectedPlan.trace : [])];
      continue;
    }

    break;
  }

  if (currentSessionId) {
    await closeFlowSession(currentSessionId, "completed");
  }

  await completeFlowRun(runId, { status: "completed", trace });
  return { flow: currentFlow, trace, paused: false };
};

const executeMatchingFlowForSupportMessage = async ({
  waId,
  content,
  messageId,
  conversationId,
  conversation,
}) => {
  const normalizedPhone = normalizePhone(waId);
  const incomingText = String(content || "").trim();
  if (!normalizedPhone || !incomingText || !messageId) return null;

  if (!shouldExecuteSupportFlows()) {
    logSupportFlowStoreDisabledOnce();
    return null;
  }

  await ensureFlowStoreReady();
  const activeSession = await getActiveFlowSession({
    channel: "support",
    conversationId,
    waId: normalizedPhone,
  });
  const matchedTrigger = await findMatchingFlowForText(incomingText);

  let flowToExecute = null;
  let runKeyword = "";
  let resumeSessionId = null;
  let runtimeContext = null;
  let resumeNodeId = "";

  if (matchedTrigger?.flow) {
    flowToExecute = matchedTrigger.flow;
    runKeyword = matchedTrigger.matchedKeyword;
    runtimeContext = await buildFlowRuntimeContext({
      waId: normalizedPhone,
      conversation,
      incomingText,
    });
    if (activeSession?.id) {
      await closeFlowSession(activeSession.id, "interrupted");
    }
  } else if (activeSession?.flowId && activeSession?.currentNodeId) {
    const flows = await listFlows();
    const matchedFlow = flows.find((item) => item.id === activeSession.flowId) || null;
    if (matchedFlow?.status === "active") {
      flowToExecute = matchedFlow;
      resumeSessionId = activeSession.id;
      resumeNodeId = String(activeSession.currentNodeId || "");
      runtimeContext = await buildFlowRuntimeContext({
        waId: normalizedPhone,
        conversation,
        incomingText,
        variables: activeSession.variables || {},
      });
    }
  }

  if (!flowToExecute) {
    return null;
  }

  const runId = await claimFlowRun({
    flowId: flowToExecute.id,
    channel: "support",
    conversationId,
    waId: normalizedPhone,
    messageId,
    inputText: incomingText,
    matchedKeyword: runKeyword,
  });
  if (!runId) return null;

  try {
    const plan = buildFlowExecutionPlan(flowToExecute, {
      ...runtimeContext,
      startNodeId: resumeNodeId,
      resumeAtCurrentNode: Boolean(resumeNodeId),
    });
    if (!plan) {
      if (resumeSessionId) {
        await closeFlowSession(resumeSessionId, "skipped");
      }
      await completeFlowRun(runId, { status: "skipped", trace: [] });
      return null;
    }

    return await executeFlowPlanForSupport({
      flow: flowToExecute,
      runId,
      conversationId,
      waId: normalizedPhone,
      plan,
      sessionId: resumeSessionId,
      runtimeContext,
    });
  } catch (error) {
    if (resumeSessionId) {
      await closeFlowSession(resumeSessionId, "failed");
    }
    await completeFlowRun(runId, {
      status: "failed",
      trace: [],
      errorMessage: error?.message || "Flow execution failed",
    });
    throw error;
  }
};

const getConversationFlowState = async ({
  conversationId = null,
  waId = null,
}) => {
  await ensureFlowStoreReady();
  const normalizedWaId = normalizePhone(waId);
  const [activeSession, runs, flows] = await Promise.all([
    getActiveFlowSession({
      channel: "support",
      conversationId,
      waId: normalizedWaId,
    }),
    listFlowRunsByConversation({
      channel: "support",
      conversationId,
      waId: normalizedWaId,
      limit: 15,
    }),
    listFlows(),
  ]);

  const latestRun = runs[0] || null;
  const currentFlowId = activeSession?.flowId || latestRun?.flowId || null;
  const flow = currentFlowId ? flows.find((item) => item.id === currentFlowId) || null : null;
  const currentNodeId =
    activeSession?.currentNodeId ||
    (Array.isArray(latestRun?.trace) && latestRun.trace.length > 0
      ? String(latestRun.trace[latestRun.trace.length - 1]?.nodeId || "")
      : null);
  const currentNode =
    currentNodeId && Array.isArray(flow?.nodes)
      ? flow.nodes.find((node) => String(node.id) === String(currentNodeId)) || null
      : null;

  return {
    activeSession,
    latestRun,
    runs,
    flow: flow
      ? {
          id: flow.id,
          name: flow.name,
          status: flow.status,
          triggerKeywords: Array.isArray(flow.trigger_keywords) ? flow.trigger_keywords : [],
        }
      : null,
    currentNode: currentNode
      ? {
          id: String(currentNode.id),
          label: String(currentNode.label || ""),
          type: String(currentNode.type || ""),
        }
      : null,
    startedAt: activeSession?.createdAt || latestRun?.createdAt || null,
    state:
      activeSession
        ? "running"
        : latestRun?.status
          ? String(latestRun.status)
          : "idle",
  };
};































































const readStore = async ({ mutable = true } = {}) => {
  if (isMainStoreCacheFresh()) {
    return mutable ? cloneMainStore(cachedMainStore) : cachedMainStore;
  }
  const parsed = isWhatsappSqliteStoreEnabled()
    ? await readWhatsappSqliteStore({ fallbackLoader: loadLegacyWhatsappStore })
    : await loadLegacyWhatsappStore();
  const normalized = normalizeMainStore(parsed);
  cachedMainStore = cloneMainStore(normalized);
  cachedMainStoreAt = Date.now();
  mainStoreRevision += 1;
  invalidateMainStoreDerivedCaches();
  return mutable ? cloneMainStore(cachedMainStore) : cachedMainStore;
};

const writeStore = async (
  store,
  { assumeOwnership = false, conversationIds = null, fullReplace = false } = {},
) => {
  const measure = startPerfMeasure();
  const isConversationScoped = Array.isArray(conversationIds);
  const conversationCount = isConversationScoped ? conversationIds.length : null;
  const normalized = normalizeMainStore(store);
  cachedMainStore = assumeOwnership ? normalized : cloneMainStore(normalized);
  cachedMainStoreAt = Date.now();
  mainStoreRevision += 1;
  invalidateMainStoreDerivedCaches();
  try {
    if (isWhatsappSqliteStoreEnabled()) {
      await writeWhatsappSqliteStore(normalized, { conversationIds, fullReplace });
      return;
    }
    await writeJsonBackedStore(storePath, normalized, async () => {
      await atomicWriteJson(storePath, normalized);
    });
  } finally {
    const perf = finishPerfMeasure(measure);
    const isWideWrite = fullReplace || !isConversationScoped;
    const shouldLogSlow = shouldLogDuration(
      perf.durationMs,
      WHATSAPP_STORE_WRITE_PERF_THRESHOLD_MS,
      250,
    );
    if (shouldLogSlow || (WHATSAPP_STORE_WRITE_LOG_FULL_REPLACE && isWideWrite)) {
      logPerf("whatsapp-store-perf", {
        mode: isWhatsappSqliteStoreEnabled() ? "sqlite" : "json",
        scope: isConversationScoped ? "conversation" : "all",
        conversationIds: conversationCount ?? "all",
        fullReplace: Boolean(fullReplace),
        assumeOwnership: Boolean(assumeOwnership),
        durationMs: perf.durationMs,
        cpuUserMs: perf.cpuUserMs,
        cpuSystemMs: perf.cpuSystemMs,
        rssMb: perf.rssMb,
        heapUsedMb: perf.heapUsedMb,
      }, { level: shouldLogSlow || isWideWrite ? "warn" : "info" });
    }
  }
};
































































const createCheckoutToken = async (payload) => {































  const store = pruneCheckoutTokens(await readCheckoutTokenStore());































  let token;































  do {































    token = randomBytes(18).toString("base64url");































  } while (store.tokens[token]);































  const ttlMs = Math.max(1, CHECKOUT_TOKEN_TTL_HOURS) * 60 * 60 * 1000;































  const createdAt = new Date().toISOString();































  const expiresAt = new Date(Date.now() + ttlMs).toISOString();































  store.tokens[token] = { ...payload, createdAt, expiresAt };































  await writeCheckoutTokenStore(store);































  return { token, expiresAt };































};































































const resolveCheckoutToken = async (token) => {































  if (!token) return null;































  const store = pruneCheckoutTokens(await readCheckoutTokenStore());

  const payload = store.tokens[token] || null;































  if (!payload) {































    await writeCheckoutTokenStore(store);































    return null;































  }































  return payload;































};































































const loadPainelSyncState = async () => {
  if (painelSyncState) return painelSyncState;
  const parsed = await safeReadJsonFile(painelSyncPath, emptyPainelSyncState());
  painelSyncState = { ...emptyPainelSyncState(), ...parsed };
  return painelSyncState;
};































































const fetchBaileysSession = async () => {































  if (!BAILEYS_API_URL) return null;































  const response = await fetch(`${BAILEYS_API_URL}/api/whatsapp/session`, {































    method: "GET",































  });































  const data = await response.json();































  if (!response.ok) {































    const errorMessage = data?.error || "Baileys session error";































    throw new Error(errorMessage);































  }































  return data;































};































































const proxyBaileysRefresh = async () => {































  if (!BAILEYS_API_URL) {































    throw new Error("Baileys API URL not configured");































  }































  const response = await fetch(`${BAILEYS_API_URL}/api/whatsapp/session/refresh`, {































    method: "POST",































  });































  const data = await response.json();































  if (!response.ok) {































    const errorMessage = data?.error || "Baileys refresh error";































    throw new Error(errorMessage);































  }































  return data;































};































































const savePainelSyncState = async () => {































  if (!painelSyncState) return;































  await fs.mkdir(path.dirname(painelSyncPath), { recursive: true });































  await atomicWriteJson(painelSyncPath, painelSyncState);































};































































const logPainelSync = async (message) => {































  const state = await loadPainelSyncState();































  state.logs.push({ at: nowIso(), message });































  if (state.logs.length > PAINEL_SYNC_LOG_LIMIT) {































    state.logs = state.logs.slice(-PAINEL_SYNC_LOG_LIMIT);































  }































  await savePainelSyncState();































};































































const nowIso = () => new Date().toISOString();

const normalizeUserKey = (value) => String(value || "").trim().toLowerCase();

const isAdminOperationUser = (operationStore, user = {}) => {
  const role = normalizeUserKey(user.role);
  const roleName = normalizeUserKey(user.role_name);
  const roleId = String(user.role_id || "").trim();
  const matchedRole = (Array.isArray(operationStore?.roles) ? operationStore.roles : []).find(
    (item) =>
      String(item?.id || "").trim() === roleId ||
      normalizeUserKey(item?.name) === roleName ||
      normalizeUserKey(item?.name) === role,
  );

  return (
    role === "admin" ||
    roleName === "administrador" ||
    normalizeUserKey(matchedRole?.name) === "administrador" ||
    normalizeUserKey(matchedRole?.department_key) === "administracao"
  );
};

const normalizePresenceItems = (value = []) =>
  (Array.isArray(value) ? value : [])
    .map((item) => ({
      user_id: String(item?.user_id || item?.userId || "").trim(),
      user_name: String(item?.user_name || item?.userName || "").trim(),
      role: String(item?.role || "").trim(),
      status: String(item?.status || "attending").trim(),
      paused_until: String(item?.paused_until || item?.pausedUntil || "").trim(),
      last_seen_at: String(item?.last_seen_at || item?.lastSeenAt || "").trim(),
      updated_at: String(item?.updated_at || item?.updatedAt || item?.last_seen_at || item?.lastSeenAt || "").trim(),
    }))
    .filter((item) => item.user_id && item.last_seen_at);

const mergePresenceItems = (items = []) => {
  const byUserId = new Map();
  normalizePresenceItems(items).forEach((presence) => {
    const previous = byUserId.get(presence.user_id);
    const previousMs = Date.parse(previous?.updated_at || previous?.last_seen_at || "");
    const currentMs = Date.parse(presence.updated_at || presence.last_seen_at || "");
    if (!previous || (Number.isFinite(currentMs) && (!Number.isFinite(previousMs) || currentMs >= previousMs))) {
      byUserId.set(presence.user_id, presence);
    }
  });
  return [...byUserId.values()];
};

const getPersistedPresenceItems = (operationStore = {}) =>
  mergePresenceItems([...listSqlAttendancePresence(), ...(Array.isArray(operationStore.attendancePresence) ? operationStore.attendancePresence : [])]);

const readOperationStore = async () => {
  const data = await safeReadJsonFile(persistedCustomersStorePath, {});
  return data && typeof data === "object" ? data : {};
};

const writeOperationStore = async (operationStore) => {
  await atomicWriteJson(persistedCustomersStorePath, operationStore && typeof operationStore === "object" ? operationStore : {});
};

const getConversationPreferenceKey = (preference = {}) =>
  String(preference?.conversation_id || preference?.conversationId || preference?.id || "").trim();

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
      const time = Date.parse(String(value || ""));
      return Number.isFinite(time) ? time : 0;
    }),
  );
};

const buildPreferenceMap = (operationStore = {}) => {
  const map = new Map();
  (Array.isArray(operationStore.conversationPreferences) ? operationStore.conversationPreferences : []).forEach((preference) => {
    const conversationId = getConversationPreferenceKey(preference);
    if (!conversationId) return;

    const current = map.get(conversationId);
    if (!current || getConversationPreferenceTime(preference) > getConversationPreferenceTime(current)) {
      map.set(conversationId, preference);
    }
  });
  return map;
};

const isResolutionPreferenceActive = (preference = null, conversation = {}) => {
  if (!preference || String(preference?.resolution_status || "").trim() !== "resolved") return false;
  const resolvedAtMs = Date.parse(String(preference.resolved_at || ""));
  if (!Number.isFinite(resolvedAtMs) || resolvedAtMs <= 0) return false;
  const lastClientMs = Date.parse(String(conversation?.lastClientMessageTime || conversation?.last_received_at || ""));
  return !(Number.isFinite(lastClientMs) && lastClientMs > resolvedAtMs);
};

const clearConversationResolutionPreference = (operationStore, conversationId) => {
  const safeConversationId = String(conversationId || "").trim();
  if (!safeConversationId) return false;

  const preferences = Array.isArray(operationStore.conversationPreferences)
    ? operationStore.conversationPreferences
    : [];
  const index = preferences.findIndex(
    (preference) => String(preference?.conversation_id || preference?.conversationId || preference?.id || "").trim() === safeConversationId,
  );
  if (index < 0) return false;

  preferences[index] = {
    ...preferences[index],
    resolution_status: "",
    resolution_type: "",
    resolved_until: "",
    updated_date: nowIso(),
  };
  operationStore.conversationPreferences = preferences;
  return true;
};

const getActiveAttendingUsers = (operationStore = {}) => {
  const users = Array.isArray(operationStore.users) ? operationStore.users : [];
  const usersById = new Map(users.map((user) => [String(user?.id || "").trim(), user]).filter(([id]) => id));
  const activeCutoff = Date.now() - ATTENDANCE_PRESENCE_TTL_MS;

  return getPersistedPresenceItems(operationStore)
    .filter((presence) => {
      const lastSeenMs = Date.parse(presence.last_seen_at || "");
      return Number.isFinite(lastSeenMs) && lastSeenMs >= activeCutoff && presence.status === "attending";
    })
    .map((presence) => {
      const user = usersById.get(presence.user_id);
      if (!user || isAdminOperationUser(operationStore, user)) return null;
      return {
        id: String(user.id || presence.user_id).trim(),
        email: String(user.email || "").trim().toLowerCase(),
        username: String(user.username || "").trim(),
        name: String(user.full_name || presence.user_name || user.username || user.email || "").trim() || "Operador",
      };
    })
    .filter(Boolean);
};

const getUserAssignmentKeys = (user = {}) =>
  [user.id, user.email, user.username].map(normalizeUserKey).filter(Boolean);

const normalizeStringArray = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  );

const LABEL_ID_ALIASES = Object.freeze({
  "label-lead": ["system-lead"],
  "system-lead": ["label-lead"],
  "label-sql": ["system-sql"],
  "system-sql": ["label-sql"],
  "label-customer": ["system-cliente"],
  "system-cliente": ["label-customer"],
  "label-churn": ["system-cancelados"],
  "system-cancelados": ["label-churn"],
});

const expandServiceLabelIds = (value) =>
  Array.from(
    new Set(
      normalizeStringArray(value).flatMap((labelId) => [labelId, ...(LABEL_ID_ALIASES[labelId] || [])]),
    ),
  );

const conversationMatchesService = (conversation = {}, service = {}) => {
  const serviceLabelIds = expandServiceLabelIds(service.label_ids || service.labelIds);
  if (!serviceLabelIds.length) return false;

  const conversationLabelIds = expandServiceLabelIds(conversation.label_ids || conversation.labelIds);
  return serviceLabelIds.some((labelId) => conversationLabelIds.includes(labelId));
};

const resolveConversationServiceIds = (operationStore = {}, conversation = {}) => {
  const services = Array.isArray(operationStore.services) ? operationStore.services : [];
  return services
    .filter((service) => conversationMatchesService(conversation, service))
    .map((service) => String(service.id || "").trim())
    .filter(Boolean);
};

const buildConversationQueueMetadata = (operationStore = {}, conversation = {}, queuedAt = nowIso()) => {
  const serviceIds = resolveConversationServiceIds(operationStore, conversation);
  const services = Array.isArray(operationStore.services) ? operationStore.services : [];
  const serviceNames = serviceIds
    .map((serviceId) => services.find((service) => String(service?.id || "").trim() === serviceId)?.name || "")
    .filter(Boolean);

  return {
    serviceIds,
    patch: {
      queued_service_ids: serviceIds,
      queued_service_id: serviceIds[0] || "",
      queued_service_name: serviceNames[0] || "",
      queued_service_names: serviceNames,
      queue_status: serviceIds.length ? "waiting" : "unclassified",
      queued_at: queuedAt,
    },
  };
};

const setConversationQueueState = (operationStore = {}, conversation = {}, queuedAt = nowIso()) => {
  const { serviceIds, patch } = buildConversationQueueMetadata(operationStore, conversation, queuedAt);
  Object.assign(conversation, patch);
  if (!conversation.assignment_source || conversation.assignment_source === "resolved") {
    conversation.assignment_source = serviceIds.length ? "service_queue" : "unclassified_queue";
  }
  return serviceIds;
};

const resolveConversationLabelIdsForAssignment = async (conversation = {}) => {
  try {
    const persistedCustomerRows = await readPersistedCustomerRows();
    const labelConversation = {
      ...conversation,
      phone: conversation.phone || conversation.contact_phone || conversation.contactPhone || conversation.wa_id || conversation.waId || "",
      wa_id: conversation.wa_id || conversation.waId || conversation.contact_phone || conversation.contactPhone || conversation.phone || "",
      customer: {
        ...(conversation.customer && typeof conversation.customer === "object" ? conversation.customer : {}),
        phone:
          conversation.customer?.phone ||
          conversation.customer?.number ||
          conversation.contact_phone ||
          conversation.contactPhone ||
          conversation.phone ||
          "",
      },
    };
    const resolvedByConversationId = await resolveConversationLabels({
      conversations: [labelConversation],
      painelCustomers: persistedCustomerRows,
    });
    const resolved = resolvedByConversationId.get(String(conversation?.id || "").trim()) || null;
    const labels = Array.isArray(resolved?.labels) ? resolved.labels : [];
    return labels.map((label) => String(label?.id || "").trim()).filter(Boolean);
  } catch (error) {
    console.error("[assignment] failed to resolve conversation labels:", error?.message || error);
    return normalizeStringArray(conversation.label_ids || conversation.labelIds);
  }
};

const resolveUserServiceIds = (operationStore = {}, user = {}) => {
  const userId = String(user.id || "").trim();
  const userEmail = String(user.email || "").trim().toLowerCase();
  return (Array.isArray(operationStore.services) ? operationStore.services : [])
    .filter((service) => {
      const serviceUserIds = normalizeStringArray(service.user_ids || service.userIds);
      const serviceUserEmails = normalizeStringArray(service.user_emails || service.userEmails).map((email) => email.toLowerCase());
      return (userId && serviceUserIds.includes(userId)) || (userEmail && serviceUserEmails.includes(userEmail));
    })
    .map((service) => String(service.id || "").trim())
    .filter(Boolean);
};

const userCanAttendConversationService = (operationStore = {}, user = {}, conversation = {}) => {
  const conversationServiceIds = resolveConversationServiceIds(operationStore, conversation);
  if (!conversationServiceIds.length) return false;
  const userServiceIds = resolveUserServiceIds(operationStore, user);
  return conversationServiceIds.some((serviceId) => userServiceIds.includes(serviceId));
};

const isConversationAssignedToUser = (conversation = {}, user = {}) => {
  const userKeys = getUserAssignmentKeys(user);
  const assignedKeys = [
    conversation.assigned_agent,
    conversation.assigned_agent_id,
    conversation.assigned_agent_email,
  ].map(normalizeUserKey).filter(Boolean);
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
        .map(normalizeUserKey)
        .filter(Boolean),
    ),
  );

const isUserExcludedFromConversationAssignment = (conversation = {}, user = {}) => {
  const excludedKeys = getConversationAssignmentExclusionKeys(conversation);
  if (!excludedKeys.length) return false;
  const userKeys = getUserAssignmentKeys(user);
  return userKeys.some((key) => excludedKeys.includes(key));
};

const clearAssignmentExclusion = (conversation = {}) => {
  conversation.assignment_excluded_user_ids = [];
  conversation.assignment_excluded_user_emails = [];
  conversation.assignment_excluded_usernames = [];
  conversation.assignment_exclusion_reason = '';
};

const isBroadcastAwaitingCustomerReplyForAssignment = (conversation = {}) => {
  const tags = Array.isArray(conversation.tags)
    ? conversation.tags.map((tag) => normalizeUserKey(tag))
    : [];
  if (!tags.includes("disparo") && !conversation.is_broadcast) return false;

  const lastClientMs = Date.parse(
    String(conversation.lastClientMessageTime || conversation.last_client_message_time || conversation.last_received_at || ""),
  );
  const lastSentMs = Date.parse(String(conversation.last_sent_at || conversation.lastMessageTime || conversation.last_message_at || ""));

  if (!Number.isFinite(lastClientMs) || lastClientMs <= 0) return true;
  if (!Number.isFinite(lastSentMs) || lastSentMs <= 0) return true;
  return lastSentMs >= lastClientMs;
};

const hasAnyConversationAssignment = (conversation = {}) =>
  [
    conversation.assigned_agent,
    conversation.assigned_agent_id,
    conversation.assigned_agent_email,
    conversation.assigned_agent_name,
  ].some((value) => String(value || "").trim());

const getAssignedOperationUser = (operationStore = {}, conversation = {}) =>
  (Array.isArray(operationStore.users) ? operationStore.users : []).find((user) =>
    isConversationAssignedToUser(conversation, user),
  ) || null;

const getAssignmentActivityMs = (conversation = {}) => {
  const timestamps = [
    conversation.assigned_at,
    conversation.assignedAt,
    conversation.last_agent_message_at,
    conversation.lastAgentMessageAt,
    conversation.last_sent_at,
    conversation.lastSentAt,
  ]
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value) && value > 0);
  return timestamps.length ? Math.max(...timestamps) : 0;
};

const hasRecentAssignmentActivity = (conversation = {}, referenceMs = Date.now()) => {
  const lastActivityMs = getAssignmentActivityMs(conversation);
  return lastActivityMs > 0 && referenceMs - lastActivityMs < ASSIGNMENT_OFFLINE_REQUEUE_GRACE_MS;
};

const shouldRequeueInactiveAssignment = ({
  operationStore = {},
  conversation = {},
  activeUsers = [],
  referenceMs = Date.now(),
} = {}) => {
  if (!hasAnyConversationAssignment(conversation)) return false;
  const activeAssignedUser = activeUsers.find((user) => isConversationAssignedToUser(conversation, user));
  if (activeAssignedUser) return false;

  const assignedUser = getAssignedOperationUser(operationStore, conversation);
  if (assignedUser) {
    const activeUserIds = new Set(activeUsers.map((user) => String(user?.id || "").trim()).filter(Boolean));
    if (activeUserIds.has(String(assignedUser.id || "").trim())) return false;
  }

  return !hasRecentAssignmentActivity(conversation, referenceMs);
};

const requeueInactiveConversationAssignment = (conversation = {}, queuedAt = nowIso()) => {
  conversation.previous_assigned_agent = conversation.assigned_agent || "";
  conversation.previous_assigned_agent_id = conversation.assigned_agent_id || "";
  conversation.previous_assigned_agent_email = conversation.assigned_agent_email || "";
  conversation.previous_assigned_agent_name = conversation.assigned_agent_name || "";
  conversation.assignment_requeued_at = queuedAt;
  conversation.assigned_agent = "";
  conversation.assigned_agent_id = "";
  conversation.assigned_agent_email = "";
  conversation.assigned_agent_name = "";
  conversation.assigned_at = "";
  conversation.assignment_source = "agent_logout_queue";
  conversation.assignment_exclusion_reason = "offline_requeue";
};

const countOpenAssignedConversations = (store = {}, operationStore = {}, activeUsers = []) => {
  const preferenceMap = buildPreferenceMap(operationStore);
  const counts = new Map(activeUsers.map((user) => [user.id, 0]));
  const conversations = Object.values(store?.conversations || {});

  for (const conversation of conversations) {
    const preference = preferenceMap.get(String(conversation?.id || "").trim());
    if (isResolutionPreferenceActive(preference, conversation)) continue;

    const assignedUser = activeUsers.find((user) => isConversationAssignedToUser(conversation, user));
    if (!assignedUser) continue;
    counts.set(assignedUser.id, (counts.get(assignedUser.id) || 0) + 1);
  }

  return counts;
};

const chooseBalancedAttendingUser = (store, operationStore, activeUsers) => {
  if (!activeUsers.length) return null;
  const counts = countOpenAssignedConversations(store, operationStore, activeUsers);
  const minCount = Math.min(...activeUsers.map((user) => counts.get(user.id) || 0));
  const candidates = activeUsers.filter((user) => (counts.get(user.id) || 0) === minCount);
  return candidates[Math.floor(Math.random() * candidates.length)] || null;
};

const assignConversationToAvailableAgent = ({ store, operationStore, conversation, forceReassign = false, assignedAt = nowIso() }) => {
  if (!conversation?.id) return { assigned: false, reason: "missing_conversation" };
  const conversationServiceIds = setConversationQueueState(operationStore, conversation, assignedAt);
  if (!conversationServiceIds.length) {
    return { assigned: false, reason: "no_matching_service" };
  }

  if (isBroadcastAwaitingCustomerReplyForAssignment(conversation)) {
    conversation.assignment_source = "broadcast_service_queue";
    conversation.queue_status = "waiting";
    return { assigned: false, reason: "broadcast_waiting_customer_reply" };
  }

  const allActiveUsers = getActiveAttendingUsers(operationStore);

  if (!forceReassign && hasAnyConversationAssignment(conversation)) {
    conversation.queue_status = "assigned";
    return { assigned: false, reason: "kept_existing_agent" };
  }

  const activeUsers = allActiveUsers.filter((user) => {
    if (isUserExcludedFromConversationAssignment(conversation, user)) return false;
    const userServiceIds = resolveUserServiceIds(operationStore, user);
    return conversationServiceIds.some((serviceId) => userServiceIds.includes(serviceId));
  });
  if (!activeUsers.length) return { assigned: false, reason: "queued_waiting_agent" };

  if (!forceReassign) {
    const assignedUser = activeUsers.find((user) => isConversationAssignedToUser(conversation, user));
    if (assignedUser) {
      conversation.queue_status = "assigned";
      return { assigned: false, reason: "kept_active_agent", user: assignedUser };
    }
  }

  const selectedUser = chooseBalancedAttendingUser(store, operationStore, activeUsers);
  if (!selectedUser) return { assigned: false, reason: "no_candidate" };

  clearAssignmentExclusion(conversation);
  conversation.assigned_agent = selectedUser.email || selectedUser.id;
  conversation.assigned_agent_id = selectedUser.id;
  conversation.assigned_agent_email = selectedUser.email || "";
  conversation.assigned_agent_name = selectedUser.name;
  conversation.assigned_at = assignedAt;
  conversation.assignment_source = "auto_distribution";
  conversation.queue_status = "assigned";
  conversation.queued_at = "";
  return { assigned: true, reason: "auto_distribution", user: selectedUser };
};

const drainQueuedConversationsToAvailableAgents = async () => {
  const store = await readStore();
  const operationStore = await readOperationStore();
  const preferenceMap = buildPreferenceMap(operationStore);
  const activeUsers = getActiveAttendingUsers(operationStore);
  const assignedAt = nowIso();
  const referenceMs = Date.now();
  const summary = {
    assigned: 0,
    waiting: 0,
    unclassified: 0,
    broadcastWaiting: 0,
    requeued: 0,
  };
  let changed = false;
  const changedConversationIds = new Set();

  for (const conversation of Object.values(store?.conversations || {})) {
    if (!conversation?.id) continue;
    const hadAssignment = hasAnyConversationAssignment(conversation);
    if (
      hadAssignment &&
      !shouldRequeueInactiveAssignment({ operationStore, conversation, activeUsers, referenceMs })
    ) {
      continue;
    }
    const preference = preferenceMap.get(String(conversation.id || "").trim());
    if (isResolutionPreferenceActive(preference, conversation)) continue;

    if (hadAssignment) {
      requeueInactiveConversationAssignment(conversation, assignedAt);
      summary.requeued += 1;
      changed = true;
      changedConversationIds.add(String(conversation.id || "").trim());
    }

    const currentLabelIds = normalizeStringArray(conversation.label_ids || conversation.labelIds);
    if (currentLabelIds.length === 0) {
      const resolvedLabelIds = await resolveConversationLabelIdsForAssignment(conversation);
      if (resolvedLabelIds.length > 0) {
        conversation.label_ids = resolvedLabelIds;
        changed = true;
        changedConversationIds.add(String(conversation.id || "").trim());
      }
    }

    const before = JSON.stringify({
      assigned_agent: conversation.assigned_agent || "",
      assigned_agent_id: conversation.assigned_agent_id || "",
      assigned_agent_email: conversation.assigned_agent_email || "",
      assigned_agent_name: conversation.assigned_agent_name || "",
      assignment_source: conversation.assignment_source || "",
      queue_status: conversation.queue_status || "",
      queued_at: conversation.queued_at || "",
      queued_service_ids: conversation.queued_service_ids || [],
    });

    const result = assignConversationToAvailableAgent({
      store,
      operationStore,
      conversation,
      forceReassign: true,
      assignedAt,
    });

    if (result.assigned) {
      summary.assigned += 1;
    } else if (result.reason === "no_matching_service") {
      summary.unclassified += 1;
    } else if (result.reason === "broadcast_waiting_customer_reply") {
      summary.broadcastWaiting += 1;
    } else if (["queued_waiting_agent", "no_candidate"].includes(result.reason)) {
      summary.waiting += 1;
    }

    const after = JSON.stringify({
      assigned_agent: conversation.assigned_agent || "",
      assigned_agent_id: conversation.assigned_agent_id || "",
      assigned_agent_email: conversation.assigned_agent_email || "",
      assigned_agent_name: conversation.assigned_agent_name || "",
      assignment_source: conversation.assignment_source || "",
      queue_status: conversation.queue_status || "",
      queued_at: conversation.queued_at || "",
      queued_service_ids: conversation.queued_service_ids || [],
    });
    if (before !== after) {
      changed = true;
      changedConversationIds.add(String(conversation.id || "").trim());
    }
  }

  if (changed) {
    await writeStore(store, { conversationIds: [...changedConversationIds].filter(Boolean) });
  }

  return summary;
};































































const maskToken = (value) => {































  if (!value) return null;































  const raw = String(value);































  if (raw.length <= 8) return `${raw.slice(0, 2)}...${raw.slice(-2)}`;































  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;































};































































const resolveMetaConfig = async () => {































  const coex = await readCoexConfig();































  const accessToken = ACCESS_TOKEN || coex.accessToken || "";































  const phoneNumberId = PHONE_NUMBER_ID || coex.phoneNumberId || "";































  const wabaId = TEMPLATE_ACCOUNT_ID || coex.wabaId || "";































































  return {































    accessToken,































    phoneNumberId,































    wabaId,































    displayPhoneNumber: coex.displayPhoneNumber || null,































    coex,































  };































};































































const DEFAULT_COUNTRY_CODE = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || "55";































































const normalizePhone = (value) => {
  if (!value) return "";
  const raw = String(value).trim();
  if (!raw) return "";

  const hasExplicitIntlPrefix = raw.startsWith("+") || raw.startsWith("00");
  let digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (!hasExplicitIntlPrefix && digits.startsWith("0") && digits.length > 11) {
    digits = digits.replace(/^0+/, "");
  }

  if (!digits) return "";
  if (digits.startsWith(DEFAULT_COUNTRY_CODE)) return digits;

  // Explicit international format (+/00) should never be rewritten.
  if (hasExplicitIntlPrefix) return digits;

  // Already looks like E.164 without plus.
  if (digits.length >= 12 && digits.length <= 15) return digits;

  // NANP numbers often arrive as 11 digits starting with 1.
  if (digits.length === 11 && digits.startsWith("1")) return digits;

  // Local numbers fallback to the project default country code.
  if (digits.length === 10 || digits.length === 11) {
    return `${DEFAULT_COUNTRY_CODE}${digits}`;
  }

  return digits;
};















const parsePlanMonths = (label) => {







  const match = String(label || '').match(/\b(1|2|3|6|12)\b/);







  return match ? Number(match[1]) : null;







};







































































const upsertPainelCustomers = (store, rows) => {
  const stats = createPainelUpsertStats(store, rows);































  const updatedAt = nowIso();































  rows.forEach((row, rowIndex) => {































    if (!row || typeof row !== "object") {
      stats.skipped += 1;
      return;
    }
    stats.processed += 1;
    const rawPhoneCandidate =
      row.phone ?? row.whatsapp ?? row.telefone ?? row.mobile ?? row.numero ?? row.number ?? "";
    const rawPhone = String(rawPhoneCandidate || "").trim();
    const normalizedPhone = normalizePhone(rawPhone);
    const customerKey = buildPainelCustomerKey(row, `row-${rowIndex}`);
    const phone = normalizedPhone || rawPhone || "n/a";





























































































    const identityCustomerId = row.customerId || row.id || null;
    const identityUsuario = row.usuario || row.username || row.user || null;
    const identityPhone = normalizedPhone || rawPhone || null;
    let matchedEntry = null;
    let matchedBy = null;
    if (identityCustomerId) {
      matchedEntry = findPainelCustomerEntry(store, { customerId: identityCustomerId });
      if (matchedEntry) matchedBy = "customerId";
    }
    if (!matchedEntry && !identityCustomerId && identityUsuario) {
      const usuarioEntry = findPainelCustomerEntry(store, { usuario: identityUsuario });
      if (usuarioEntry && canMergePainelCustomerByUsuario({ incomingRow: row, existingRow: usuarioEntry.row })) {
        matchedEntry = usuarioEntry;
        matchedBy = "usuario";
      }
    }
    if (!matchedEntry && !identityCustomerId && identityPhone) {
      const phoneEntry = findPainelCustomerEntry(store, { phone: identityPhone });
      if (phoneEntry && canMergePainelCustomerByPhone({ incomingRow: row, existingRow: phoneEntry.row })) {
        matchedEntry = phoneEntry;
        matchedBy = "phone";
      } else if (phoneEntry) {
        stats.phoneConflictSkipped += 1;
      }
    }
    if (matchedBy === "customerId") stats.mergedByCustomerId += 1;
    if (matchedBy === "usuario") stats.mergedByUsuario += 1;
    if (matchedBy === "phone") stats.mergedByPhone += 1;
    const existing = {
      ...((matchedEntry?.row && typeof matchedEntry.row === "object" && matchedEntry.row) ||
        store.customers?.[customerKey] ||
        {}),
    };
    const hadExisting = Object.keys(existing).length > 0;
    if (matchedEntry?.key && matchedEntry.key !== customerKey) {
      delete store.customers[matchedEntry.key];
      stats.aliasKeysRemoved += 1;
    }
    if (hadExisting) {
      stats.updated += 1;
    } else {
      stats.inserted += 1;
    }































    const existingPlaylist =































      existing.Playlist ?? existing.playlist ?? null;































    if ("playlist" in existing) {































      delete existing.playlist;































    }































    if ("Playlist" in existing) {































      delete existing.Playlist;































    }































    const nextPlaylist =































      row.playlist !== undefined ? row.playlist : existingPlaylist;































    store.customers[customerKey] = {































      ...existing,































      phone,































      whatsapp:
        row.whatsapp ?? (phone && phone !== "n/a" ? phone : existing.whatsapp ?? existing.phone ?? null),
      customerId:
        row.customerId ?? row.id ?? existing.customerId ?? existing.id ?? null,
      id:
        row.id ?? row.customerId ?? existing.id ?? existing.customerId ?? null,
      usuario: row.usuario ?? row.username ?? existing.usuario ?? existing.username ?? null,
      username:
        row.username ?? row.usuario ?? existing.username ?? existing.usuario ?? null,































      planoAtual: row.planoAtual ?? existing.planoAtual ?? null,































      conexoes: row.conexoes != null ? Number(row.conexoes) : existing.conexoes ?? null,































      vencimento: row.vencimento ?? existing.vencimento ?? null,































      valor: row.valor ?? existing.valor ?? null,































      Playlist: nextPlaylist,































      notas: row.notas ?? existing.notas ?? null,































      situacao: row.situacao ?? existing.situacao ?? null,































      updatedAt,































    };































  });































  store.updatedAt = updatedAt;
  stats.totalAfter = Object.keys(store?.customers || {}).length;
  stats.delta = stats.totalAfter - stats.totalBefore;
  return stats;































};































































const startPainelSync = async () => {































  const state = await loadPainelSyncState();































  if (painelSyncTask) {































    return state;































  }































































  state.running = true;































  state.startedAt = nowIso();































  state.finishedAt = null;































  state.error = null;































  state.logs = [];































  await savePainelSyncState();































































  painelSyncTask = (async () => {































    await logPainelSync("Iniciando sincronização do painel...");































    await logPainelSync(`URL alvo: ${PAINEL_LOG_URL}`);































    if (process.env.PANEL_NEWBR_SYNC_MAX_ITEMS) {































      await logPainelSync(`Limite de clientes: ${process.env.PANEL_NEWBR_SYNC_MAX_ITEMS}`);































    }































    const store = await readPainelStore();
    const previousStoredTotal = Object.keys(store?.customers || {}).length;
    store.customers = {};
    store.updatedAt = nowIso();
    await writePainelStore(store);
    const syncStats = createPainelUpsertStats(store, []);































    await logPainelSync("Modo: sincronizacao completa (sem limite de clientes).");
    await logPainelSync(`Base local reiniciada para sincronizacao completa. Registros anteriores=${previousStoredTotal}.`);































    const result = await syncPainelCustomers({































      onLog: (message) => logPainelSync(message),































      onPage: async (rows, meta) => {































        const pageStats = upsertPainelCustomers(store, rows);
        mergePainelUpsertStats(syncStats, pageStats);































        await writePainelStore(store);































        await logPainelSync(`Página ${meta.page} salva: ${formatPainelUpsertStats(pageStats)}`);































      },































      maxItems: 0,































      maxPages: 0,































    });































    await logPainelSync(
      `Sincronização concluída: ${result.total} registros em ${result.pages} páginas. ${formatPainelUpsertStats(syncStats)}`,
    );































    state.finishedAt = nowIso();































  })()































    .catch(async (error) => {































      state.error = error.message || "Falha na sincronização";































      await logPainelSync(`Erro: ${state.error}`);































      state.finishedAt = nowIso();































    })































    .finally(async () => {































      state.running = false;































      await savePainelSyncState();































      painelSyncTask = null;































    });































































  return state;































};































































const stripDefaultCountry = (waId) => {































  if (!waId) return "";































  return waId.startsWith(DEFAULT_COUNTRY_CODE)































    ? waId.slice(DEFAULT_COUNTRY_CODE.length)































    : waId;































};































































const resolveConversationIds = (rawId) => {































  if (!rawId) return [];































  let value = String(rawId);































  if (value.startsWith("wa-")) {































    value = value.slice(3);































  }































  const waId = normalizePhone(value) || value;































  if (!waId) return [];































  const ids = new Set([`wa-${waId}`]);































  const shortWaId = stripDefaultCountry(waId);































  if (shortWaId && shortWaId !== waId) {































    ids.add(`wa-${shortWaId}`);































  }































  return Array.from(ids);































};































































const deleteConversationFromStore = (store, conversationId) => {































  const ids = resolveConversationIds(conversationId);































  if (!ids.length) return false;































  let deleted = false;































  ids.forEach((id) => {































    if (store.conversations?.[id]) {































      delete store.conversations[id];































      deleted = true;































    }































    if (store.messages?.[id]) {































      delete store.messages[id];































    }































  });































  return deleted;































};































































const mergeConversationIds = (store, waId) => {































  const canonicalId = `wa-${waId}`;































  const shortWaId = stripDefaultCountry(waId);































  const shortId = shortWaId && shortWaId !== waId ? `wa-${shortWaId}` : null;































































  if (!shortId || !store.conversations?.[shortId]) {































    return canonicalId;































  }































































  const source = store.conversations[shortId];































  const target = store.conversations[canonicalId] || { ...source, id: canonicalId };































































  target.customer = {































    ...source.customer,































    ...target.customer,































    id: `cust-${waId}`,































    phone: `+${waId}`,































    name: target.customer?.name || source.customer?.name || waId,































  };































































  const sourceTime = source.lastMessageTime ? new Date(source.lastMessageTime).getTime() : 0;































  const targetTime = target.lastMessageTime ? new Date(target.lastMessageTime).getTime() : 0;































  if (sourceTime > targetTime) {































    target.lastMessage = source.lastMessage;































    target.lastMessageTime = source.lastMessageTime;































  }































































  target.unreadCount = Math.max(target.unreadCount || 0, source.unreadCount || 0);































  target.tags = Array.from(new Set([...(target.tags || []), ...(source.tags || [])]));































































  const targetMessages = store.messages?.[canonicalId] || [];































  const sourceMessages = store.messages?.[shortId] || [];































  const mergedMap = new Map();































  [...targetMessages, ...sourceMessages].forEach((message) => {































    if (message?.id && !mergedMap.has(message.id)) {































      mergedMap.set(message.id, message);































    }































  });































  const mergedMessages = Array.from(mergedMap.values()).sort(































    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),































  );































































  store.conversations[canonicalId] = target;































  store.messages[canonicalId] = mergedMessages;































  delete store.conversations[shortId];































  delete store.messages[shortId];































































  return canonicalId;































};































































const buildCustomer = ({ waId, name }) => {































  const displayName = name || waId;































  const today = nowIso().slice(0, 10);































  return {































    id: `cust-${waId}`,































    name: displayName,































    phone: `+${waId}`,































    plan: "N\u00e3o informado",































    planStatus: "pending",































    city: "N\u00e3o informado",































    activationDate: today,































    paymentStatus: "pending",































    churnScore: 0,































  };































};































































const isUnknownCustomerName = (value, waId) => {
  if (!value) {
    return true;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return true;
  }

  const lowered = trimmed.toLowerCase();
  if (lowered.includes("desconhe")) {
    return true;
  }

  const waDigits = normalizePhone(waId) || String(waId || "").replace(/\D/g, "");
  const valueDigits = normalizePhone(trimmed) || trimmed.replace(/\D/g, "");

  if (waDigits && valueDigits && waDigits === valueDigits) {
    return true;
  }

  if (waDigits && lowered === waDigits) {
    return true;
  }

  if (waDigits && lowered === `+${waDigits}`) {
    return true;
  }

  return false;
};


const resolvePainelUsuarioByPhone = async (waId) => {
  const normalized = normalizePhone(waId);
  if (!normalized) {
    return null;
  }

  const store = await readPainelStore();
  const stored = findPainelCustomerEntry(store, { phone: normalized })?.row || null;
  if (!stored) {
    return null;
  }

  return stored.usuario || stored.user || stored.username || null;
};


const normalizeMetaLookupValue = (value) => String(value || "").replace(/\D/g, "");

const buildMetaRouteConfigs = (coex = {}) => {
  const defaultConfig = {
    key: "default",
    label: "default",
    webhookPath: WHATSAPP_DEFAULT_WEBHOOK_PATH,
    verifyToken: String(WEBHOOK_VERIFY_TOKEN || "").trim(),
    appSecret: String(WHATSAPP_APP_SECRET || "").trim(),
    accessToken: String(ACCESS_TOKEN || coex.accessToken || "").trim(),
    phoneNumberId: String(PHONE_NUMBER_ID || coex.phoneNumberId || "").trim(),
    wabaId: String(TEMPLATE_ACCOUNT_ID || coex.wabaId || "").trim(),
    displayPhoneNumber: String(WHATSAPP_DISPLAY_PHONE_NUMBER || coex.displayPhoneNumber || "").trim() || null,
  };

  const vendasConfig = {
    key: "vendas",
    label: "vendas",
    webhookPath: WHATSAPP_VENDAS_WEBHOOK_PATH,
    verifyToken: String(WHATSAPP_VENDAS_WEBHOOK_VERIFY_TOKEN || "").trim(),
    appSecret: String(WHATSAPP_VENDAS_APP_SECRET || "").trim(),
    accessToken: String(WHATSAPP_VENDAS_ACCESS_TOKEN || "").trim(),
    phoneNumberId: String(WHATSAPP_VENDAS_PHONE_NUMBER_ID || "").trim(),
    wabaId: String(WHATSAPP_VENDAS_BUSINESS_ACCOUNT_ID || "").trim(),
    displayPhoneNumber: String(WHATSAPP_VENDAS_DISPLAY_PHONE_NUMBER || "").trim() || null,
  };

  const vendas2Config = {
    key: "vendas2",
    label: "vendas2",
    webhookPath: WHATSAPP_VENDAS2_WEBHOOK_PATH,
    verifyToken: String(WHATSAPP_VENDAS2_WEBHOOK_VERIFY_TOKEN || "").trim(),
    appSecret: String(WHATSAPP_VENDAS2_APP_SECRET || "").trim(),
    accessToken: String(WHATSAPP_VENDAS2_ACCESS_TOKEN || "").trim(),
    phoneNumberId: String(WHATSAPP_VENDAS2_PHONE_NUMBER_ID || "").trim(),
    wabaId: String(WHATSAPP_VENDAS2_BUSINESS_ACCOUNT_ID || "").trim(),
    displayPhoneNumber: String(WHATSAPP_VENDAS2_DISPLAY_PHONE_NUMBER || "").trim() || null,
  };

  return [defaultConfig, vendasConfig, vendas2Config];
};

const pickMetaRouteConfig = (configs = [], options = {}) => {
  const routeKey = String(options?.routeKey || "").trim().toLowerCase();
  const webhookPath = String(options?.pathName || options?.webhookPath || "").trim();
  const phoneNumberId = String(options?.phoneNumberId || "").trim();
  const displayPhoneNumber = normalizeMetaLookupValue(options?.displayPhoneNumber);

  if (routeKey) {
    const matchByRouteKey = configs.find((config) => config.key === routeKey);
    if (matchByRouteKey) return matchByRouteKey;
  }

  if (webhookPath) {
    const matchByWebhookPath = configs.find((config) => config.webhookPath === webhookPath);
    if (matchByWebhookPath) return matchByWebhookPath;
  }

  if (phoneNumberId) {
    const matchByPhoneNumberId = configs.find((config) => config.phoneNumberId === phoneNumberId);
    if (matchByPhoneNumberId) return matchByPhoneNumberId;
  }

  if (displayPhoneNumber) {
    const matchByDisplayPhoneNumber = configs.find(
      (config) => normalizeMetaLookupValue(config.displayPhoneNumber) === displayPhoneNumber,
    );
    if (matchByDisplayPhoneNumber) return matchByDisplayPhoneNumber;
  }

  return null;
};

const isSupportedMetaWebhookPath = (pathName = "") => {
  const safePath = String(pathName || "").trim();
  if (!safePath) return false;
  return [WHATSAPP_DEFAULT_WEBHOOK_PATH, WHATSAPP_VENDAS_WEBHOOK_PATH, WHATSAPP_VENDAS2_WEBHOOK_PATH].includes(safePath);
};

const isWhatsappHealthPath = (pathName = "") => String(pathName || "").trim() === "/api/whatsapp/health";

const isWhatsappHttpRoleAllowed = (pathName = "") => {
  if (!WHATSAPP_HTTP_ROLE || WHATSAPP_HTTP_ROLE === "all") return true;
  if (isWhatsappHealthPath(pathName)) return true;
  const isWebhookPath = isSupportedMetaWebhookPath(pathName);
  if (WHATSAPP_HTTP_ROLE === "webhook") return isWebhookPath;
  if (WHATSAPP_HTTP_ROLE === "api") return !isWebhookPath;
  return true;
};

const resolveSelectedMetaConfig = async (options = {}) => {
  const baseConfig = await resolveMetaConfig();
  const coex = baseConfig?.coex || (await readCoexConfig());
  const configs = buildMetaRouteConfigs(coex);
  const explicitConfig = pickMetaRouteConfig(configs, options);
  const fallbackConfig =
    options && options.allowFallback === false
      ? null
      : configs.find((config) => config.key === "default") || configs[0] || null;
  const selected = explicitConfig || fallbackConfig;

  return {
    accessToken: String(selected?.accessToken || "").trim(),
    phoneNumberId: String(selected?.phoneNumberId || "").trim(),
    wabaId: String(selected?.wabaId || "").trim(),
    displayPhoneNumber: selected?.displayPhoneNumber || null,
    verifyToken: String(selected?.verifyToken || "").trim(),
    appSecret: String(selected?.appSecret || "").trim(),
    webhookPath: String(selected?.webhookPath || "").trim(),
    routeKey: String(selected?.key || "").trim() || null,
    label: String(selected?.label || "").trim() || null,
    coex,
    configs,
  };
};

const resolveConversationMetaConfig = async ({ to, phoneNumberId, displayPhoneNumber, routeKey } = {}) => {
  const explicitConfig = await resolveSelectedMetaConfig({
    phoneNumberId,
    displayPhoneNumber,
    routeKey,
    allowFallback: false,
  });
  if (explicitConfig.accessToken && explicitConfig.phoneNumberId) {
    return explicitConfig;
  }

  const waId = normalizePhone(to);
  if (waId) {
    const store = await readStore({ mutable: false });
    const conversationId = mergeConversationIds(store, waId);
    const conversation = store?.conversations?.[conversationId] || null;
    if (conversation) {
      const matchedConversationConfig = await resolveSelectedMetaConfig({
        phoneNumberId: conversation.phone_number_id,
        displayPhoneNumber: conversation.display_phone_number,
        routeKey: conversation.meta_route_key,
        allowFallback: false,
      });
      if (matchedConversationConfig.accessToken && matchedConversationConfig.phoneNumberId) {
        return matchedConversationConfig;
      }
    }
  }

  return resolveSelectedMetaConfig();
};

const verifyWebhookSignature = ({ rawBody, signatureHeader, appSecret }) => {
  const secret = String(appSecret || "").trim();
  if (!secret) return true;

  const header = String(signatureHeader || "").trim();
  if (!header.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = header.slice("sha256=".length);

  try {
    return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
};

const parseWebhookPayloadBuffer = (rawBody) => {
  const payloadText = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  const payload = parseLenientJson(payloadText);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid webhook payload");
  }
  return payload;
};

const resolveRequestedMetaSelector = (req, payload = {}) => ({
  routeKey: String(req?.headers?.["x-whatsapp-route"] || payload?.routeKey || "").trim().toLowerCase() || null,
  phoneNumberId: String(payload?.phoneNumberId || "").trim() || null,
  displayPhoneNumber: String(payload?.displayPhoneNumber || "").trim() || null,
});

const buildConversation = ({ waId, name }) => {































  const timestamp = nowIso();































  return {
    id: `wa-${waId}`,
    customer: buildCustomer({ waId, name }),
    phone_number_id: null,
    display_phone_number: null,
    waba_id: null,
    meta_route_key: null,
    last_webhook_path: null,
    sector: "suporte",
    priority: "low",
    status: "waiting",
    lastMessage: "",
    lastMessageTime: timestamp,
    last_message_at: timestamp,
    lastClientMessageTime: null,
    last_received_at: null,
    last_sent_at: null,
    last_read_at: timestamp,
    unreadCount: 0,
    unread_count: 0,
    is_active_conversation: false,
    is_in_attendance: false,
    is_pending: true,
    is_broadcast: false,
    tags: [],
    createdAt: timestamp,
  };































};































































const sendTemplateMessage = async ({
  to,
  parameters,
  templateName,
  language,
  buttonParameters,
  headerParameters,
  headerFormat,
  metaConfig = null,
  phoneNumberId = null,
  displayPhoneNumber = null,
  routeKey = null,
}) => {
  const waId = normalizePhone(to);
  if (!waId) {
    throw new Error("Invalid 'to' number");
  }
  const selectedMetaConfig =
    metaConfig ||
    (phoneNumberId || displayPhoneNumber || routeKey
      ? await resolveSelectedMetaConfig({
          phoneNumberId,
          displayPhoneNumber,
          routeKey,
        })
      : await resolveSelectedMetaConfig());
  const { accessToken, phoneNumberId: targetPhoneNumberId } = selectedMetaConfig;































  if (!accessToken || !targetPhoneNumberId) {































    throw new Error("Missing WhatsApp access token or phone number id");































  }

  const components = [
    {
      type: "body",
      parameters: parameters.map((text) => ({ type: "text", text })),
    },
  ];
  const normalizedHeaderParams = normalizeTemplateHeaderParameters(headerParameters, headerFormat).filter(
    (text) => text.length > 0,
  );
  const normalizedHeaderFormat = String(headerFormat || "").trim().toUpperCase();
  if (normalizedHeaderParams.length > 0) {
    if (normalizedHeaderFormat && normalizedHeaderFormat !== "TEXT") {
      const mediaType = normalizedHeaderFormat.toLowerCase();
      const link = normalizedHeaderParams[0];
      components.unshift({
        type: "header",
        parameters: [{ type: mediaType, [mediaType]: { link } }],
      });
    } else {
      components.unshift({
        type: "header",
        parameters: normalizedHeaderParams.map((text) => ({ type: "text", text })),
      });
    }
  } else if (normalizedHeaderFormat && normalizedHeaderFormat !== "TEXT") {
    throw new Error("Missing header media URL");
  }
  const normalizedButtonParams = (buttonParameters || [])
    .map((text) => String(text || "").trim())
    .filter((text) => text.length > 0);
  if (normalizedButtonParams.length > 0) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: normalizedButtonParams.map((text) => ({ type: "text", text })),
    });
  }
  const payload = {































    messaging_product: "whatsapp",
    to: waId,































    type: "template",































    template: {































      name: templateName || DEFAULT_TEMPLATE_NAME,































      language: { code: language || DEFAULT_LANGUAGE },































      components,































    },































  };































































  const response = await fetch(































    `https://graph.facebook.com/${API_VERSION}/${targetPhoneNumberId}/messages`,































    {































      method: "POST",































      headers: {































        Authorization: `Bearer ${accessToken}`,































        "Content-Type": "application/json",































      },































      body: JSON.stringify(payload),































    },































  );































































  const data = await response.json();































  if (!response.ok) {































    const error = data?.error?.message || "WhatsApp API error";































    throw new Error(error);































  }































































  return data;































};































































const extractTemplateVariables = (text) => {































  if (!text) return [];































  const matches = [...text.matchAll(/{{\s*([^}]+)\s*}}/g)];































  const vars = matches.map((match) => match[1].trim()).filter((value) => value.length > 0);































  if (!vars.length) return [];































  const unique = [];































  vars.forEach((value) => {































    if (!unique.includes(value)) {































      unique.push(value);































    }































  });































  const allNumeric = unique.every((value) => /^\d+$/.test(value));































  if (allNumeric) {































    return unique.sort((a, b) => Number(a) - Number(b));































  }































  return unique;































};































































const buildTemplateComponents = ({ content, hasButton, buttonText, buttonUrl }) => {
  const components = [
    {
      type: "BODY",
      text: content,
    },
  ];

  if (hasButton && buttonText && buttonUrl) {
    components.push({
      type: "BUTTONS",
      buttons: [
        {
          type: "URL",
          text: buttonText,
          url: buttonUrl,
        },
      ],
    });
  }

  return components;
};
const createTemplate = async ({ name, language, category, content, hasButton, buttonText, buttonUrl }) => {
  const { accessToken, wabaId } = await resolveMetaConfig();
  if (!accessToken) {
    throw new Error("Missing WhatsApp access token");
  }
  if (!wabaId) {
    throw new Error("Missing WHATSAPP_BUSINESS_ACCOUNT_ID or WABA id");
  }
  const payload = {































    name,































    language,































    category: category?.toUpperCase(),































    components: buildTemplateComponents({ content, hasButton, buttonText, buttonUrl }),































  };































































  const response = await fetch(































    `https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates`,































    {































      method: "POST",































      headers: {































        Authorization: `Bearer ${accessToken}`,































        "Content-Type": "application/json",































      },































      body: JSON.stringify(payload),































    },































  );































































  const data = await response.json();































  if (!response.ok) {































    const error = data?.error?.message || "WhatsApp template create error";































    throw new Error(error);































  }































































  return data;































};































































const sendTextMessage = async ({
  to,
  text,
  contextMessageId,
  metaConfig = null,
  phoneNumberId = null,
  displayPhoneNumber = null,
  routeKey = null,
}) => {
  const waId = normalizePhone(to);
  if (!waId) {
    throw new Error("Invalid 'to' number");
  }
  const selectedMetaConfig =
    metaConfig ||
    (await resolveConversationMetaConfig({
      to: waId,
      phoneNumberId,
      displayPhoneNumber,
      routeKey,
    }));
  const { accessToken, phoneNumberId: targetPhoneNumberId } = selectedMetaConfig;































  if (!accessToken || !targetPhoneNumberId) {































    throw new Error("Missing WhatsApp access token or phone number id");































  }

  const payload = {































    messaging_product: "whatsapp",
    to: waId,































    type: "text",































    text: { body: text },
  };
  if (contextMessageId) {
    payload.context = { message_id: contextMessageId };
  }































































  const response = await fetch(































    `https://graph.facebook.com/${API_VERSION}/${targetPhoneNumberId}/messages`,































    {































      method: "POST",































      headers: {































        Authorization: `Bearer ${accessToken}`,































        "Content-Type": "application/json",































      },































      body: JSON.stringify(payload),































    },































  );































































  const data = await response.json();































  if (!response.ok) {































    const error = data?.error?.message || "WhatsApp API error";































    throw new Error(error);































  }































































  return data;































};































































const parseLenientJson = (body) => {

  if (!body) return {};

  const trimmed = String(body).trim();

  if (!trimmed) return {};

  try {

    return JSON.parse(trimmed);

  } catch (error) {

    try {

      const fixed = trimmed.replace(/([\{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

      return JSON.parse(fixed);

    } catch {}

    try {

      const params = new URLSearchParams(trimmed);

      const entries = Array.from(params.entries());

      if (entries.length > 0) {

        return Object.fromEntries(entries);

      }

    } catch {}

    throw error;

  }

};



const readJson = (req) => {
  if (req.__jsonBodyParsed) {
    return Promise.resolve(req.__jsonBody || {});
  }

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = parseLenientJson(body);
        req.__jsonBodyParsed = true;
        req.__jsonBody = parsed;
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
  });
};

const readBuffer = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", (chunk) => {
    chunks.push(chunk);
  });
  req.on("end", () => {
    resolve(Buffer.concat(chunks));
  });
  req.on("error", reject);
});

const panelAgentRequest = async (path, { method = "GET", body } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (PANEL_AGENT_TOKEN) {
    headers["X-Panel-Agent-Token"] = PANEL_AGENT_TOKEN;
  }
  const response = await fetch(`${PANEL_AGENT_BROKER_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    throw new Error(data?.error || `Painel agent ${method} ${path} failed (${response.status})`);
  }
  return { ...data, __metaConfig: selectedMetaConfig };
};

const processLocalChatbotIncomingMessage = async ({
  waId,
  content,
  timestamp,
  messageId,
  conversationId,
  conversation,
}) => {
  const normalizedContent = String(content || "").trim();
  const normalizedConversationId = String(conversationId || "").trim();
  const normalizedMessageId = String(messageId || "").trim();
  if (!normalizedConversationId || !normalizedContent || !normalizedMessageId) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCAL_CHATBOT_TIMEOUT_MS);
  try {
    const response = await fetch(`${LOCAL_CHATBOT_API_BASE_URL}/api/local/chatbot/process-incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: normalizedConversationId,
        phone: waId,
        content: normalizedContent,
        timestamp,
        messageId: normalizedMessageId,
        messageKey: [normalizedConversationId, timestamp || "", normalizedMessageId].join("|"),
        messageType: "text",
        conversation,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!response.ok) {
      throw new Error(data?.error || `Local chatbot processing failed (${response.status})`);
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
};

const wait = (delayMs) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));

const postLocalRealtimeEvent = async (normalizedEventName, payload = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1000, LOCAL_REALTIME_TIMEOUT_MS));

  try {
    const response = await fetch(`${LOCAL_REALTIME_API_BASE_URL}/api/local/events/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: normalizedEventName,
        payload,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `Local realtime publish failed (${response.status})`);
    }

    return true;
  } finally {
    clearTimeout(timeoutId);
  }
};

const publishLocalRealtimeEvent = async (eventName, payload = {}) => {
  const normalizedEventName = String(eventName || "").trim();
  if (!normalizedEventName) return null;

  let lastError = null;
  for (let attempt = 0; attempt <= LOCAL_REALTIME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await postLocalRealtimeEvent(normalizedEventName, payload);
    } catch (error) {
      lastError = error;
      if (attempt < LOCAL_REALTIME_RETRY_ATTEMPTS) {
        await wait(LOCAL_REALTIME_RETRY_DELAY_MS);
      }
    }
  }

  console.error(
    "[realtime] local publish failed:",
    normalizedEventName,
    lastError?.message || lastError,
  );
  return false;
};

const publishConversationMessageEvent = (eventName, { conversationId, conversation, message, status } = {}) => {
  const normalizedConversationId = String(conversationId || conversation?.id || message?.conversationId || "").trim();
  if (!normalizedConversationId) return;

  void publishLocalRealtimeEvent(eventName, {
    conversation_id: normalizedConversationId,
    conversationId: normalizedConversationId,
    conversation: conversation || null,
    message: message || null,
    message_id:
      message?.id ||
      message?.serverMessageId ||
      message?.server_message_id ||
      message?.providerMessageId ||
      message?.provider_message_id ||
      message?.wamid ||
      null,
    status: status || message?.status || null,
  });
};

const PLUSTV_METRICS_API_BASE = String(
  process.env.PLUSTV_METRICS_API_BASE || "https://painel.newbr.top",
).replace(/\/+$/, "");
const PLUSTV_METRICS_USERNAME = String(
  process.env.PLUSTV_METRICS_USERNAME || process.env.PANEL_NEWBR_USERNAME || "suportemaistv",
).trim();
const PLUSTV_METRICS_PASSWORD = String(
  process.env.PLUSTV_METRICS_PASSWORD || process.env.PANEL_NEWBR_PASSWORD || "suporte+TV1",
);
const PLUSTV_METRICS_CACHE_MS = Number.parseInt(
  process.env.PLUSTV_METRICS_CACHE_MS || "300000",
  10,
);
const PLUSTV_METRICS_TIMEOUT_MS = Number.parseInt(
  process.env.PLUSTV_METRICS_TIMEOUT_MS || "60000",
  10,
);
const PLUSTV_METRICS_MAX_CUSTOMER_PAGES = Number.parseInt(
  process.env.PLUSTV_METRICS_MAX_CUSTOMER_PAGES || "500",
  10,
);
const PLUSTV_METRICS_PROXY_URL = String(
  process.env.PLUSTV_METRICS_PROXY_URL || "http://127.0.0.1:3000",
).replace(/\/+$/, "");
const PLUSTV_METRICS_DISK_CACHE_PATH = String(
  process.env.PLUSTV_METRICS_DISK_CACHE_PATH || "server/data/plustv-metrics-cache.json",
);
const plusTvMetricsDiskCachePath = path.resolve(process.cwd(), PLUSTV_METRICS_DISK_CACHE_PATH);
const PLUSTV_TIME_ZONE = "America/Sao_Paulo";
const PLUSTV_METRICS_SALES_USERNAME = String(
  process.env.PLUSTV_METRICS_SALES_USERNAME || "vendaiptv",
).trim();
const PLUSTV_METRICS_SALES_PASSWORD = String(
  process.env.PLUSTV_METRICS_SALES_PASSWORD || "suporte+TV1",
);
const PLUSTV_METRICS_SALES_RESELLER = String(
  process.env.PLUSTV_METRICS_SALES_RESELLER || "vendaiptv",
).trim();
const PLUSTV_METRICS_DAILY_SNAPSHOT_LIMIT = Number.parseInt(
  process.env.PLUSTV_METRICS_DAILY_SNAPSHOT_LIMIT || "400",
  10,
);
let plustvMetricsCache = {
  support: { expiresAt: 0, payload: null },
  sales: { expiresAt: 0, payload: null },
};
let plusTvMetricsDiskWriteQueue = Promise.resolve();

const normalizePlusTvMetricsScope = (value) => {
  const scope = String(value || "").trim().toLowerCase();
  return scope === "sales" || scope === "vendas" ? "sales" : "support";
};

const getPlusTvMetricsScopeConfig = (scopeValue) => {
  const scope = normalizePlusTvMetricsScope(scopeValue);
  if (scope === "sales") {
    return {
      scope,
      username: PLUSTV_METRICS_SALES_USERNAME,
      password: PLUSTV_METRICS_SALES_PASSWORD,
      reseller: PLUSTV_METRICS_SALES_RESELLER,
    };
  }
  return {
    scope,
    username: PLUSTV_METRICS_USERNAME,
    password: PLUSTV_METRICS_PASSWORD,
    reseller: "",
  };
};

class PlusTvMetricsError extends Error {
  constructor(message, status = 500, payload = null) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

const plustvHeaders = (token = "") => ({
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  Origin: PLUSTV_METRICS_API_BASE,
  Referer: `${PLUSTV_METRICS_API_BASE}/`,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

const plustvFetchJson = async (path, { method = "GET", body, token } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLUSTV_METRICS_TIMEOUT_MS);
  try {
    const response = await fetch(`${PLUSTV_METRICS_API_BASE}${path}`, {
      method,
      headers: plustvHeaders(token),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new PlusTvMetricsError("Resposta nao-JSON da NewBR.", response.status || 502, {
        raw: text.slice(0, 500),
      });
    }
    if (!response.ok) {
      throw new PlusTvMetricsError(
        data?.message || data?.error || `Falha na NewBR (${response.status})`,
        response.status,
        data,
      );
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new PlusTvMetricsError("Tempo esgotado ao consultar a NewBR.", 504);
    }
    if (error instanceof PlusTvMetricsError) throw error;
    throw new PlusTvMetricsError(error?.message || "Falha ao consultar a NewBR.", 502);
  } finally {
    clearTimeout(timeout);
  }
};

const plustvProxyFetchJson = async (path, { method = "GET", body, token } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLUSTV_METRICS_TIMEOUT_MS * 3);
  try {
    const response = await fetch(`${PLUSTV_METRICS_PROXY_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new PlusTvMetricsError("Resposta nao-JSON do servico local de metricas.", response.status || 502, {
        raw: text.slice(0, 500),
      });
    }
    if (!response.ok) {
      throw new PlusTvMetricsError(
        data?.details || data?.error || `Servico local de metricas falhou (${response.status})`,
        response.status,
        data,
      );
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new PlusTvMetricsError("Tempo esgotado no servico local de metricas.", 504);
    }
    if (error instanceof PlusTvMetricsError) throw error;
    throw new PlusTvMetricsError(error?.message || "Servico local de metricas indisponivel.", 502);
  } finally {
    clearTimeout(timeout);
  }
};

const fetchPlusTvMetricsFromProxy = async (scopeConfig) => {
  const login = await plustvProxyFetchJson("/api/login", {
    method: "POST",
    body: {
      username: scopeConfig.username,
      password: scopeConfig.password,
    },
  });
  const token = login?.token || "";
  if (!token) throw new PlusTvMetricsError("Servico local de metricas nao retornou token.", 502);
  const payload = await plustvProxyFetchJson("/api/metrics", { token });
  if (!payload?.metrics) {
    throw new PlusTvMetricsError("Servico local de metricas nao retornou payload agregado.", 502);
  }
  return {
    ok: true,
    version: payload.version || "proxy",
    scope: scopeConfig.scope,
    timezone: PLUSTV_TIME_ZONE,
    generatedAt: new Date().toISOString(),
    cached: false,
    metrics: payload.metrics,
  };
};

const formatPlusTvChartCategory = (dateKey) => {
  const day = String(dateKey || "").slice(8, 10);
  const month = String(dateKey || "").slice(5, 7);
  return day && month ? `${day}/${month}` : String(dateKey || "");
};

const mergePlusTvChartHistory = (previousChart, nextChart) => {
  if (!nextChart?.fullDates?.length || !Array.isArray(nextChart.current)) return nextChart;
  const valueMode = nextChart.valueMode || previousChart?.valueMode || "sum";
  const valuesByDate = new Map();
  const previousByDate = new Map();
  const addChart = (chart) => {
    if (!chart?.fullDates?.length || !Array.isArray(chart.current)) return;
    chart.fullDates.forEach((dateKey, index) => {
      if (!dateKey) return;
      valuesByDate.set(String(dateKey), Number(chart.current[index] || 0));
      if (Array.isArray(chart.previous)) {
        previousByDate.set(String(dateKey), Number(chart.previous[index] || 0));
      }
    });
  };
  addChart(previousChart);
  addChart(nextChart);
  const fullDates = Array.from(valuesByDate.keys()).sort();
  const current = fullDates.map((dateKey) => Number(valuesByDate.get(dateKey) || 0));
  const previous = fullDates.map((dateKey) => Number(previousByDate.get(dateKey) || 0));
  const total =
    valueMode === "last"
      ? Number(current[current.length - 1] || 0)
      : current.reduce((sum, item) => sum + item, 0);
  return {
    ...previousChart,
    ...nextChart,
    categories: fullDates.map(formatPlusTvChartCategory),
    current,
    previous,
    fullDates,
    total,
    valueMode,
  };
};

const mergePlusTvMetricsHistory = (previousPayload, nextPayload) => {
  if (!previousPayload?.metrics?.charts || !nextPayload?.metrics?.charts) return nextPayload;
  const charts = { ...nextPayload.metrics.charts };
  for (const key of ["newCustomers", "cancelados", "activeOverview"]) {
    charts[key] = mergePlusTvChartHistory(previousPayload.metrics.charts[key], nextPayload.metrics.charts[key]);
  }
  const newCustomers = charts.newCustomers;
  const cancelados = charts.cancelados;
  const activeOverview = charts.activeOverview;
  const todayParts = getSaoPauloDateParts();
  const monthPrefix = `${todayParts.year}-${String(todayParts.month).padStart(2, "0")}-`;
  const sumChartMonth = (chart) => {
    if (!chart?.fullDates?.length || !Array.isArray(chart.current)) return 0;
    return chart.fullDates.reduce((sum, dateKey, index) => (
      String(dateKey || "").startsWith(monthPrefix) ? sum + Number(chart.current[index] || 0) : sum
    ), 0);
  };
  const salesMonth = Math.round(sumChartMonth(newCustomers));
  const canceladosMes = Number(nextPayload.metrics.summary?.canceladosMes || 0);
  const elapsedDaysMonth = Math.max(todayParts.day, 1);
  const dailySales = salesMonth / elapsedDaysMonth;
  const dailyCancel = canceladosMes / elapsedDaysMonth;
  const cards = Array.isArray(nextPayload.metrics.cards)
    ? nextPayload.metrics.cards.map((card) =>
        card?.id === "vendas-mes" ? { ...card, rawValue: salesMonth } : card,
      )
    : nextPayload.metrics.cards;
  return {
    ...nextPayload,
    metrics: {
      ...nextPayload.metrics,
      cards,
      charts,
      summary: {
        ...nextPayload.metrics.summary,
        vendasMes: salesMonth,
        canceladosMes,
      },
      overviewSummary: {
        ...(nextPayload.metrics.overviewSummary || nextPayload.metrics.summary || {}),
        vendasMes: salesMonth,
        canceladosMes,
      },
      validation: {
        ...nextPayload.metrics.validation,
        salesUsedThisMonth: salesMonth,
        avgDailySales: dailySales,
        avgDailyCancellations: dailyCancel,
        historicalActiveOverviewRows: Array.isArray(activeOverview?.fullDates) ? activeOverview.fullDates.length : 0,
        historicalSalesRows: Array.isArray(newCustomers?.fullDates) ? newCustomers.fullDates.length : 0,
        historicalCancellationRows: Array.isArray(cancelados?.fullDates) ? cancelados.fullDates.length : 0,
      },
    },
  };
};

const normalizePlusTvMetricSummary = (summary) => ({
  ativosAgora: Number(summary?.ativosAgora || 0),
  vendasMes: Number(summary?.vendasMes || 0),
  canceladosMes: Number(summary?.canceladosMes || 0),
  vencemHoje: Number(summary?.vencemHoje || 0),
});

const getPlusTvPayloadDateKey = (payload) => {
  const raw = payload?.generatedAt || payload?.diskCachedAt || new Date().toISOString();
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    return dateKeyFromParts(getSaoPauloDateParts());
  }
  return dateKeyFromParts(getSaoPauloDateParts(date));
};

const buildPlusTvPayloadDailySnapshot = (payload, existingSnapshot = null) => {
  if (!payload?.metrics?.summary) return existingSnapshot;
  const capturedAt = payload.generatedAt || payload.diskCachedAt || new Date().toISOString();
  const summary = normalizePlusTvMetricSummary(payload.metrics.summary);
  const overviewSummary = normalizePlusTvMetricSummary(payload.metrics.overviewSummary || payload.metrics.summary);
  if (!existingSnapshot) {
    return {
      dateKey: getPlusTvPayloadDateKey(payload),
      firstCapturedAt: capturedAt,
      lastCapturedAt: capturedAt,
      firstSummary: summary,
      lastSummary: summary,
      firstOverviewSummary: overviewSummary,
      lastOverviewSummary: overviewSummary,
    };
  }
  return {
    ...existingSnapshot,
    lastCapturedAt: capturedAt,
    lastSummary: summary,
    lastOverviewSummary: overviewSummary,
  };
};

const readPlusTvDailySnapshotsFromPayload = (payload) => {
  const snapshots = payload?.metrics?.history?.dailySnapshots && typeof payload.metrics.history.dailySnapshots === "object"
    ? { ...payload.metrics.history.dailySnapshots }
    : {};
  const fallbackSnapshot = buildPlusTvPayloadDailySnapshot(payload);
  if (fallbackSnapshot?.dateKey && !snapshots[fallbackSnapshot.dateKey]) {
    snapshots[fallbackSnapshot.dateKey] = fallbackSnapshot;
  }
  return snapshots;
};

const prunePlusTvDailySnapshots = (snapshots) => {
  const keys = Object.keys(snapshots || {}).sort();
  const limit = Number.isFinite(PLUSTV_METRICS_DAILY_SNAPSHOT_LIMIT) ? Math.max(30, PLUSTV_METRICS_DAILY_SNAPSHOT_LIMIT) : 400;
  if (keys.length <= limit) return snapshots || {};
  return keys.slice(-limit).reduce((acc, key) => {
    acc[key] = snapshots[key];
    return acc;
  }, {});
};

const mergePlusTvMetricDailySnapshots = (previousPayload, nextPayload) => {
  const snapshots = readPlusTvDailySnapshotsFromPayload(previousPayload);
  const nextDateKey = getPlusTvPayloadDateKey(nextPayload);
  const nextSnapshot = buildPlusTvPayloadDailySnapshot(nextPayload, snapshots[nextDateKey] || null);
  if (nextSnapshot?.dateKey) {
    snapshots[nextSnapshot.dateKey] = nextSnapshot;
  }
  return {
    dailySnapshots: prunePlusTvDailySnapshots(snapshots),
  };
};

const readPlusTvMetricsDiskStore = async () => {
  const stored = await safeReadJsonFile(plusTvMetricsDiskCachePath, null);
  if (stored?.scopes && typeof stored.scopes === "object") return stored;
  if (stored?.metrics) {
    return {
      version: "2026-04-29-plustv-history-v2",
      scopes: {
        support: {
          updatedAt: stored.diskCachedAt || stored.generatedAt || new Date().toISOString(),
          payload: stored,
        },
      },
    };
  }
  return { version: "2026-04-29-plustv-history-v2", scopes: {} };
};

const persistPlusTvMetricsDiskCache = (payload, scopeValue = "support") => {
  if (!payload?.ok || !payload?.metrics) return Promise.resolve(payload);
  const writeTask = plusTvMetricsDiskWriteQueue.then(async () => {
    const scope = normalizePlusTvMetricsScope(scopeValue);
    const stored = await readPlusTvMetricsDiskStore();
    const previousPayload = stored.scopes?.[scope]?.payload || null;
    const now = new Date().toISOString();
    const mergedPayload = {
      ...mergePlusTvMetricsHistory(previousPayload, payload),
      scope,
      cached: false,
      stale: false,
      diskCachedAt: now,
    };
    const history = mergePlusTvMetricDailySnapshots(previousPayload, mergedPayload);
    const persistedPayload = {
      ...mergedPayload,
      metrics: {
        ...mergedPayload.metrics,
        history,
      },
    };
    await atomicWriteJson(plusTvMetricsDiskCachePath, {
      version: "2026-04-29-plustv-history-v2",
      updatedAt: now,
      scopes: {
        ...(stored.scopes || {}),
        [scope]: {
          updatedAt: now,
          payload: persistedPayload,
        },
      },
    });
    return persistedPayload;
  });
  plusTvMetricsDiskWriteQueue = writeTask.catch(() => {});
  return writeTask;
};

const readPlusTvMetricsDiskCache = async (error, scopeValue = "support") => {
  const scope = normalizePlusTvMetricsScope(scopeValue);
  const stored = await readPlusTvMetricsDiskStore();
  const payload = stored.scopes?.[scope]?.payload || null;
  if (!payload?.metrics) return null;
  return {
    ...payload,
    ok: true,
    scope,
    cached: true,
    stale: true,
    source: payload.source || "disk-cache",
    warning:
      error?.message
        ? `Coleta ao vivo indisponivel. Exibindo ultimo cache salvo. Motivo: ${error.message}`
        : "Coleta ao vivo indisponivel. Exibindo ultimo cache salvo.",
  };
};

const extractPlusTvToken = (payload) => {
  if (!payload || typeof payload !== "object") return "";
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  return (
    payload.token ||
    payload.accessToken ||
    payload.access_token ||
    payload.jwt ||
    data.token ||
    data.accessToken ||
    data.access_token ||
    ""
  );
};

const plusTvLogin = async (scopeConfig) => {
  if (!scopeConfig.username || !scopeConfig.password) {
    throw new PlusTvMetricsError("Credenciais NewBR nao configuradas.", 500);
  }
  const payloads = [
    { username: scopeConfig.username, password: scopeConfig.password, captcha: "", twofactor: "" },
    { username: scopeConfig.username, password: scopeConfig.password, captchaToken: "", twofactor: "" },
    { username: scopeConfig.username, password: scopeConfig.password, captcha: null, twofactor: null },
  ];
  let lastError = null;
  for (const body of payloads) {
    try {
      const data = await plustvFetchJson("/api/auth/login", { method: "POST", body });
      const token = extractPlusTvToken(data);
      if (!token) throw new PlusTvMetricsError("Login NewBR sem token reconhecivel.", 502);
      return token;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new PlusTvMetricsError("Falha no login NewBR.", 502);
};

const extractPlusTvRows = (payload) => {
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === "object");
  if (Array.isArray(payload?.data)) return payload.data.filter((item) => item && typeof item === "object");
  return [];
};

const getSaoPauloDateParts = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PLUSTV_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
};

const dateKeyFromParts = ({ year, month, day }) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const addDaysUtc = (dateKey, amount) => {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
};

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const dayOfYearRemaining = ({ year, month, day }) => {
  const today = Date.UTC(year, month - 1, day);
  const end = Date.UTC(year, 11, 31);
  return Math.max(Math.round((end - today) / 86400000), 0);
};

const extractPlusTvDateKey = (value) => {
  if (value === null || value === undefined) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return dateKeyFromParts(getSaoPauloDateParts(parsed));
};

const findPlusTvExpiryDateKey = (customer) => {
  for (const key of ["expires_at_tz", "expires_at", "expiry", "expiration", "due_date", "dueDate", "vencimento"]) {
    const dateKey = extractPlusTvDateKey(customer?.[key]);
    if (dateKey) return dateKey;
  }
  return "";
};

const findPlusTvCreatedDateKey = (customer) => {
  for (const key of ["created_at", "createdAt", "signup_at", "signupAt", "date_created", "dateCreated"]) {
    const dateKey = extractPlusTvDateKey(customer?.[key]);
    if (dateKey) return dateKey;
  }
  return "";
};

const extractPlusTvReseller = (customer) => {
  const candidates = [
    customer?.reseller,
    customer?.reseller_username,
    customer?.resellerUsername,
    customer?.reseller_user,
    customer?.resellerUser,
    customer?.owner,
    customer?.owner_username,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "object") {
      const nested = candidate.username || candidate.name || candidate.login || candidate.user;
      if (nested) return String(nested).trim().toLowerCase();
      continue;
    }
    const value = String(candidate).trim().toLowerCase();
    if (value) return value;
  }
  return "";
};

const extractPlusTvCustomersBreakdown = (payload) => {
  const mine = payload?.mine && typeof payload.mine === "object" ? payload.mine : {};
  const tree = payload?.tree && typeof payload.tree === "object" ? payload.tree : {};
  const mineActive = Number(mine.active || 0);
  const treeActive = Number(tree.active || 0);
  const mineInactive = Number(mine.inactive || 0);
  const treeInactive = Number(tree.inactive || 0);
  const mineToExpire = Number(mine.toExpire || 0);
  const treeToExpire = Number(tree.toExpire || 0);
  return {
    mineActive,
    treeActive,
    mineInactive,
    treeInactive,
    mineToExpire,
    treeToExpire,
    active: mineActive + treeActive,
    inactive: mineInactive + treeInactive,
    toExpire: mineToExpire + treeToExpire,
  };
};

const extractPlusTvChartPayload = (payload, todayKey) => {
  const categories = Array.isArray(payload?.categories) ? payload.categories : [];
  const series = Array.isArray(payload?.series) ? payload.series : [];
  let current = [];
  let previous = [];
  for (const item of series) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name || "").toLowerCase();
    if (!current.length && (name.includes("atual") || name.includes("current"))) {
      current = Array.isArray(item.data) ? item.data : [];
    } else if (!previous.length && (name.includes("anterior") || name.includes("previous"))) {
      previous = Array.isArray(item.data) ? item.data : [];
    }
  }
  if (!current.length && series[0] && Array.isArray(series[0].data)) current = series[0].data;
  if (!previous.length) previous = Array.from({ length: current.length }, () => 0);
  const startOffset = -(current.length - 1);
  return {
    categories: categories.slice(0, current.length).map(String),
    current: current.map((item) => Number(item || 0)),
    previous: previous.slice(0, current.length).map((item) => Number(item || 0)),
    fullDates: current.map((_, index) => addDaysUtc(todayKey, startOffset + index)),
    total: Number(payload?.total || 0),
    valueMode: "sum",
  };
};

const summarizePlusTvCustomers = (rows, todayParts, options = {}) => {
  const todayKey = dateKeyFromParts(todayParts);
  const monthPrefix = `${todayParts.year}-${String(todayParts.month).padStart(2, "0")}-`;
  const vencemHojeReseller = String(options.vencemHojeReseller || "").trim().toLowerCase();
  let canceladosMes = 0;
  let vencemHoje = 0;
  const canceladosPorDia = new Map();
  for (const row of rows) {
    const expiryKey = findPlusTvExpiryDateKey(row);
    if (!expiryKey) continue;
    const status = String(row.status || "").toUpperCase();
    const isTrial = String(row.is_trial || row.isTrial || "").toUpperCase();
    if (status === "EXPIRED" && isTrial === "NO") {
      canceladosPorDia.set(expiryKey, (canceladosPorDia.get(expiryKey) || 0) + 1);
      if (expiryKey.startsWith(monthPrefix)) canceladosMes += 1;
    }
    const matchesVencemHojeReseller = !vencemHojeReseller || extractPlusTvReseller(row) === vencemHojeReseller;
    if (expiryKey === todayKey && isTrial === "NO" && matchesVencemHojeReseller) {
      vencemHoje += 1;
    }
  }
  return { canceladosMes, vencemHoje, canceladosPorDia };
};

const buildPlusTvCanceladosChart = (canceladosPorDia, todayKey, windowDays = 30) => {
  const fullDates = Array.from({ length: windowDays }, (_, index) =>
    addDaysUtc(todayKey, -(windowDays - 1) + index),
  );
  const previousDates = Array.from({ length: windowDays }, (_, index) =>
    addDaysUtc(todayKey, -(windowDays * 2 - 1) + index),
  );
  const current = fullDates.map((dateKey) => Number(canceladosPorDia.get(dateKey) || 0));
  const previous = previousDates.map((dateKey) => Number(canceladosPorDia.get(dateKey) || 0));
  return {
    title: "Cancelados",
    categories: fullDates.map((dateKey) => String(Number(dateKey.slice(8, 10)))),
    current,
    previous,
    fullDates,
    total: current.reduce((sum, item) => sum + item, 0),
    valueMode: "sum",
  };
};

const buildPlusTvActiveHistoryChart = (rows, todayKey, activeNow, windowDays = 120) => {
  const fullDates = Array.from({ length: windowDays }, (_, index) =>
    addDaysUtc(todayKey, -(windowDays - 1) + index),
  );
  const previousDates = Array.from({ length: windowDays }, (_, index) =>
    addDaysUtc(todayKey, -(windowDays * 2 - 1) + index),
  );
  const customers = Array.isArray(rows)
    ? rows.map((row) => ({
        createdKey: findPlusTvCreatedDateKey(row),
        expiryKey: findPlusTvExpiryDateKey(row),
        status: String(row?.status || "").toUpperCase(),
      }))
    : [];

  const countActiveAtDate = (dateKey) =>
    customers.reduce((count, customer) => {
      if (!customer.createdKey && !customer.expiryKey) return count;
      if (customer.createdKey && customer.createdKey > dateKey) return count;
      if (customer.expiryKey && customer.expiryKey < dateKey) return count;
      if (!customer.expiryKey && customer.status && customer.status !== "ACTIVE") return count;
      return count + 1;
    }, 0);

  const current = fullDates.map((dateKey) => countActiveAtDate(dateKey));
  const previous = previousDates.map((dateKey) => countActiveAtDate(dateKey));
  if (current.length) {
    current[current.length - 1] = Number(activeNow || 0);
  }
  return {
    title: "Ativos totais",
    categories: fullDates.map(formatPlusTvChartCategory),
    current,
    previous,
    fullDates,
    total: Number(current[current.length - 1] || 0),
    valueMode: "last",
  };
};

const buildPlusTvProjectionChart = (title, activeNow, dailySales, dailyCancel, todayParts, remainingDays) => {
  const todayKey = dateKeyFromParts(todayParts);
  const fullDates = Array.from({ length: remainingDays + 1 }, (_, index) => addDaysUtc(todayKey, index));
  const current = fullDates.map((_, index) =>
    Math.max(Math.round(activeNow + dailySales * index - dailyCancel * index), 0),
  );
  return {
    title,
    categories: fullDates.map((dateKey) => {
      const day = Number(dateKey.slice(8, 10));
      const month = Number(dateKey.slice(5, 7));
      return remainingDays > 20 ? `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}` : String(day);
    }),
    current,
    previous: fullDates.map(() => activeNow),
    fullDates,
    total: current[current.length - 1] || activeNow,
    valueMode: "last",
  };
};

const buildPlusTvMetricsPayloadFromRaw = ({
  customersCount,
  newCustomers,
  customersAll,
  version = "2026-04-25-node-v2",
  source = "server-newbr",
  scope = "support",
  customerReseller = "",
}) => {
  const rows = Array.isArray(customersAll?.rows) ? customersAll.rows : [];
  const todayParts = getSaoPauloDateParts();
  const todayKey = dateKeyFromParts(todayParts);
  const breakdown = extractPlusTvCustomersBreakdown(customersCount);
  const normalizedScope = normalizePlusTvMetricsScope(scope);
  const normalizedCustomerReseller = String(customerReseller || "").trim();
  const customerSummary = summarizePlusTvCustomers(rows, todayParts, {
    vencemHojeReseller: normalizedScope === "sales" ? normalizedCustomerReseller : "",
  });
  const salesChart = extractPlusTvChartPayload(newCustomers, todayKey);
  const detailActiveNow = normalizedScope === "support" ? breakdown.mineActive : breakdown.active;
  const overviewActiveNow = breakdown.active;
  const activeOverviewChart = buildPlusTvActiveHistoryChart(rows, todayKey, overviewActiveNow);
  const monthPrefix = `${todayParts.year}-${String(todayParts.month).padStart(2, "0")}-`;
  const salesMonth = Math.round(
    salesChart.fullDates.reduce((sum, dateKey, index) => (
      String(dateKey || "").startsWith(monthPrefix) ? sum + Number(salesChart.current[index] || 0) : sum
    ), 0),
  );
  const canceladosMes = customerSummary.canceladosMes;
  const elapsedDaysMonth = Math.max(todayParts.day, 1);
  const dailySales = salesMonth / elapsedDaysMonth;
  const dailyCancel = canceladosMes / elapsedDaysMonth;
  const remainingMonth = Math.max(daysInMonth(todayParts.year, todayParts.month) - todayParts.day, 0);
  const remainingYear = dayOfYearRemaining(todayParts);
  const projectionActiveNow = normalizedScope === "support" ? overviewActiveNow : detailActiveNow;
  const projectedEndMonth = Math.max(Math.round(projectionActiveNow + dailySales * remainingMonth - dailyCancel * remainingMonth), 0);
  const projectedEndYear = Math.max(Math.round(projectionActiveNow + dailySales * remainingYear - dailyCancel * remainingYear), 0);

  return {
    ok: true,
    version,
    source,
    scope: normalizedScope,
    timezone: PLUSTV_TIME_ZONE,
    generatedAt: new Date().toISOString(),
    cached: false,
    stale: false,
    metrics: {
      cards: [
        {
          id: "ativos-agora",
          title: "ATIVOS AGORA",
          rawValue: detailActiveNow,
          note: normalizedScope === "support"
            ? "GET /api/resellers/customers-count (mine.active)"
            : "GET /api/resellers/customers-count",
          icon: "users",
        },
        { id: "vendas-mes", title: "VENDAS NO MES", rawValue: salesMonth, note: "GET /api/dashboard/charts/new-customers", icon: "trend-up" },
        { id: "cancelados-mes", title: "CANCELADOS NO MES", rawValue: canceladosMes, note: "Clientes EXPIRED no mes atual com is_trial = NO", icon: "cancel" },
        {
          id: "vencem-hoje",
          title: "VENCEM HOJE",
          rawValue: customerSummary.vencemHoje,
          note: normalizedScope === "sales" && normalizedCustomerReseller
            ? `Somente is_trial = NO e reseller = ${normalizedCustomerReseller}`
            : "Somente is_trial = NO",
          icon: "calendar",
        },
      ],
      charts: {
        monthForecast: buildPlusTvProjectionChart("Previsao ate terminar o mes", projectionActiveNow, dailySales, dailyCancel, todayParts, remainingMonth),
        yearForecast: buildPlusTvProjectionChart("Previsao ate o final do ano", projectionActiveNow, dailySales, dailyCancel, todayParts, remainingYear),
        newCustomers: { ...salesChart, title: "Vendas novos clientes" },
        cancelados: buildPlusTvCanceladosChart(customerSummary.canceladosPorDia, todayKey),
        activeOverview: activeOverviewChart,
      },
      summary: {
        ativosAgora: detailActiveNow,
        vendasMes: salesMonth,
        canceladosMes,
        vencemHoje: customerSummary.vencemHoje,
      },
      overviewSummary: {
        ativosAgora: overviewActiveNow,
        vendasMes: salesMonth,
        canceladosMes,
        vencemHoje: customerSummary.vencemHoje,
      },
      validation: {
        formula: "Clientes Atuais + (Vendas Diarias x Dias Restantes) - (Cancelamentos Diarios x Dias Restantes)",
        currentActiveTotal: detailActiveNow,
        overviewActiveTotal: overviewActiveNow,
        customersCountMineActive: breakdown.mineActive,
        customersCountTreeActive: breakdown.treeActive,
        customersCountMineToExpire: breakdown.mineToExpire,
        customersCountTreeToExpire: breakdown.treeToExpire,
        salesUsedThisMonth: salesMonth,
        cancellationsUsedThisMonth: canceladosMes,
        elapsedDaysMonth,
        avgDailySales: dailySales,
        avgDailyCancellations: dailyCancel,
        daysRemainingMonth: remainingMonth,
        daysRemainingYear: remainingYear,
        projectedEndMonth,
        projectedEndYear,
        historicalActiveOverviewRows: Array.isArray(activeOverviewChart?.fullDates) ? activeOverviewChart.fullDates.length : 0,
        pagesLoaded: Number(customersAll?.pagesLoaded || 0),
        totalRows: Number(customersAll?.totalRows || rows.length),
      },
      reference: {
        customersCount: "GET /api/resellers/customers-count",
        newCustomers: "GET /api/dashboard/charts/new-customers",
        customers: "GET /api/customers?page=1&...&perPage=100",
        scope: normalizedScope,
        reseller: normalizedCustomerReseller,
      },
    },
  };
};

const fetchAllPlusTvCustomers = async (token, options = {}) => {
  const rows = [];
  let page = 1;
  let pagesLoaded = 0;
  let lastPage = null;
  while (page <= PLUSTV_METRICS_MAX_CUSTOMER_PAGES) {
    const query = new URLSearchParams({
      page: String(page),
      username: "",
      serverId: "",
      packageId: "",
      expiryFrom: "",
      expiryTo: "",
      status: "",
      isTrial: "",
      connections: "",
      perPage: "100",
    });
    if (options.reseller) {
      query.set("reseller", String(options.reseller));
    }
    const payload = await plustvFetchJson(`/api/customers?${query.toString()}`, { token });
    const pageRows = extractPlusTvRows(payload);
    rows.push(...pageRows);
    pagesLoaded += 1;
    const meta = payload?.meta && typeof payload.meta === "object" ? payload.meta : {};
    const currentPage = Number(meta.current_page || page);
    lastPage = Number(meta.last_page || currentPage);
    const total = Number(meta.total || rows.length);
    const perPage = Number(meta.per_page || 100);
    if (currentPage >= lastPage) break;
    if (pageRows.length < perPage) break;
    if (rows.length >= total) break;
    page = currentPage + 1;
  }
  return { rows, pagesLoaded, lastPage, totalRows: rows.length };
};

const buildPlusTvMetricsPayload = async ({ force = false, scope: scopeValue = "support" } = {}) => {
  const now = Date.now();
  const scopeConfig = getPlusTvMetricsScopeConfig(scopeValue);
  const scopeCache = plustvMetricsCache[scopeConfig.scope] || { expiresAt: 0, payload: null };
  if (!force && scopeCache.payload && scopeCache.expiresAt > now) {
    return { ...scopeCache.payload, cached: true, cacheExpiresAt: new Date(scopeCache.expiresAt).toISOString() };
  }

  if (PLUSTV_METRICS_PROXY_URL && scopeConfig.scope !== "sales") {
    try {
      const proxyPayload = await fetchPlusTvMetricsFromProxy(scopeConfig);
      const persistedPayload = await persistPlusTvMetricsDiskCache(proxyPayload, scopeConfig.scope).catch((error) => {
        console.warn(`[plustv-metrics] falha ao salvar cache em disco: ${error?.message || error}`);
        return proxyPayload;
      });
      plustvMetricsCache[scopeConfig.scope] = {
        expiresAt: now + Math.max(0, PLUSTV_METRICS_CACHE_MS),
        payload: persistedPayload,
      };
      return {
        ...persistedPayload,
        cacheExpiresAt: new Date(plustvMetricsCache[scopeConfig.scope].expiresAt).toISOString(),
      };
    } catch (error) {
      console.warn(`[plustv-metrics] proxy indisponivel, tentando fetch direto: ${error?.message || error}`);
    }
  }

  const token = await plusTvLogin(scopeConfig);
  const [customersCount, newCustomers, customersAll] = await Promise.all([
    plustvFetchJson("/api/resellers/customers-count", { token }),
    plustvFetchJson("/api/dashboard/charts/new-customers", { token }),
    fetchAllPlusTvCustomers(token, { reseller: scopeConfig.scope === "sales" ? scopeConfig.reseller : "" }),
  ]);
  const payload = buildPlusTvMetricsPayloadFromRaw({
    customersCount,
    newCustomers,
    customersAll,
    version: "2026-04-25-node-v2",
    source: "server-newbr",
    scope: scopeConfig.scope,
    customerReseller: scopeConfig.scope === "sales" ? scopeConfig.reseller : "",
  });
  const persistedPayload = await persistPlusTvMetricsDiskCache(payload, scopeConfig.scope).catch((error) => {
    console.warn(`[plustv-metrics] falha ao salvar cache em disco: ${error?.message || error}`);
    return payload;
  });
  plustvMetricsCache[scopeConfig.scope] = {
    expiresAt: now + Math.max(0, PLUSTV_METRICS_CACHE_MS),
    payload: persistedPayload,
  };
  return {
    ...persistedPayload,
    cacheExpiresAt: new Date(plustvMetricsCache[scopeConfig.scope].expiresAt).toISOString(),
  };
};

const sendReactionMessage = async ({
  to,
  targetMessageId,
  emoji,
  metaConfig = null,
  phoneNumberId = null,
  displayPhoneNumber = null,
  routeKey = null,
}) => {
  const waId = normalizePhone(to);
  if (!waId) {
    throw new Error("Invalid 'to' number");
  }
  const normalizedTargetMessageId = String(targetMessageId || "").trim();
  if (!normalizedTargetMessageId) {
    throw new Error("Missing target message id");
  }
  const selectedMetaConfig =
    metaConfig ||
    (await resolveConversationMetaConfig({
      to: waId,
      phoneNumberId,
      displayPhoneNumber,
      routeKey,
    }));
  const { accessToken, phoneNumberId: targetPhoneNumberId } = selectedMetaConfig;
  if (!accessToken || !targetPhoneNumberId) {
    throw new Error("Missing WhatsApp access token or phone number id");
  }

  const payload = {
    messaging_product: "whatsapp",
    to: waId,
    type: "reaction",
    reaction: {
      message_id: normalizedTargetMessageId,
      emoji: String(emoji || "").trim(),
    },
  };

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${targetPhoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  const data = await response.json();
  if (!response.ok) {
    const error = data?.error?.message || "WhatsApp reaction error";
    throw new Error(error);
  }

  return { ...data, __metaConfig: selectedMetaConfig };
};

const sendInteractiveMessage = async ({
  to,
  text,
  header = null,
  footer = null,
  buttons = [],
  buttonText = "MENU",
  rows = [],
  contextMessageId,
  metaConfig = null,
  phoneNumberId = null,
  displayPhoneNumber = null,
  routeKey = null,
}) => {
  const waId = normalizePhone(to);
  if (!waId) {
    throw new Error("Invalid 'to' number");
  }
  const selectedMetaConfig =
    metaConfig ||
    (await resolveConversationMetaConfig({
      to: waId,
      phoneNumberId,
      displayPhoneNumber,
      routeKey,
    }));
  const { accessToken, phoneNumberId: targetPhoneNumberId } = selectedMetaConfig;
  if (!accessToken || !targetPhoneNumberId) {
    throw new Error("Missing WhatsApp access token or phone number id");
  }

  const normalizedButtons = Array.isArray(buttons)
    ? buttons
        .map((button) => ({
          id: String(button?.id || "").trim(),
          title: String(button?.title || "").trim(),
        }))
        .filter((button) => button.id && button.title)
        .slice(0, 3)
    : [];

  const normalizedRows = Array.isArray(rows)
    ? rows
        .map((row) => ({
          id: String(row?.id || "").trim(),
          title: String(row?.title || "").trim(),
          description: String(row?.description || "").trim(),
        }))
        .filter((row) => row.id && row.title)
        .slice(0, 10)
    : [];

  let interactive = null;
  if (normalizedButtons.length > 0) {
    interactive = {
      type: "button",
      body: { text: String(text || "").trim() || "Selecione uma opção" },
      action: {
        buttons: normalizedButtons.map((button) => ({
          type: "reply",
          reply: {
            id: button.id,
            title: button.title.slice(0, 20),
          },
        })),
      },
    };
  } else if (normalizedRows.length > 0) {
    interactive = {
      type: "list",
      body: { text: String(text || "").trim() || "Selecione uma opção" },
      action: {
        button: String(buttonText || "MENU").trim().slice(0, 20) || "MENU",
        sections: [
          {
            title: "Opções",
            rows: normalizedRows.map((row) => ({
              id: row.id,
              title: row.title.slice(0, 24),
              description: row.description.slice(0, 72),
            })),
          },
        ],
      },
    };
  } else {
    throw new Error("Interactive message requires buttons or rows");
  }

  if (header && typeof header === "object") {
    const headerType = String(header.type || "text").trim().toLowerCase();
    if (headerType === "text" && String(header.text || "").trim()) {
      interactive.header = {
        type: "text",
        text: String(header.text).trim().slice(0, 60),
      };
    } else if (
      interactive.type === "button" &&
      ["image", "video", "document"].includes(headerType) &&
      String(header.asset || header.link || "").trim()
    ) {
      const mediaLink = String(header.asset || header.link || "").trim();
      interactive.header = {
        type: headerType,
        [headerType]: {
          link: mediaLink,
        },
      };
    }
  }
  const footerText =
    footer && typeof footer === "object"
      ? String(footer.text || "").trim()
      : String(footer || "").trim();
  if (footerText) {
    interactive.footer = {
      text: footerText.slice(0, 60),
    };
  }

  const payload = {
    messaging_product: "whatsapp",
    to: waId,
    type: "interactive",
    interactive,
  };
  if (contextMessageId) {
    payload.context = { message_id: contextMessageId };
  }

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${targetPhoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  const data = await response.json();
  if (!response.ok) {
    const error = data?.error?.message || "WhatsApp interactive API error";
    throw new Error(error);
  }
  return { ...data, __metaConfig: selectedMetaConfig };
};

const proxyBaileysDisconnect = async () => {
  if (!BAILEYS_API_URL) {
    throw new Error("Baileys API URL not configured");
  }

  const response = await fetch(`${BAILEYS_API_URL}/api/whatsapp/session/disconnect`, {
    method: "POST",
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMessage = data?.error || "Baileys disconnect error";
    throw new Error(errorMessage);
  }

  return data;
};

const mimeToExtension = (mimeType, fallback = "bin") => {
  const normalized = String(mimeType || "").toLowerCase().split(";")[0].trim();
  if (!normalized) return fallback;
  const map = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  return map[normalized] || fallback;
};

const normalizeMimeType = (value) => String(value || "").split(";")[0].trim().toLowerCase();

const META_SUPPORTED_AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/amr",
  "audio/ogg",
  "audio/opus",
]);

let ffmpegAvailableCache = null;
const isFfmpegAvailable = () => {
  if (ffmpegAvailableCache !== null) return ffmpegAvailableCache;
  try {
    const check = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    ffmpegAvailableCache = check.status === 0;
  } catch {
    ffmpegAvailableCache = false;
  }
  return ffmpegAvailableCache;
};

const transcodeWebmAudioToOgg = (inputBuffer) =>
  new Promise((resolve, reject) => {
    if (!isFfmpegAvailable()) {
      reject(new Error("ffmpeg nao encontrado na VPS. Instale ffmpeg para converter audio/webm em audio/ogg."));
      return;
    }

    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-c:a",
      "libopus",
      "-f",
      "ogg",
      "pipe:1",
    ]);

    const stdoutChunks = [];
    const stderrChunks = [];

    ffmpeg.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    ffmpeg.on("error", (error) => {
      reject(new Error(`Falha ao iniciar ffmpeg: ${error.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(stderrText || `ffmpeg finalizou com codigo ${code}`));
        return;
      }
      const output = Buffer.concat(stdoutChunks);
      if (!output.length) {
        reject(new Error("ffmpeg nao retornou audio convertido"));
        return;
      }
      resolve(output);
    });

    ffmpeg.stdin.on("error", () => {
      // stream encerrado pelo ffmpeg
    });
    ffmpeg.stdin.write(inputBuffer);
    ffmpeg.stdin.end();
  });

const prepareAudioUpload = async ({ buffer, mimeType }) => {
  const normalizedMime = normalizeMimeType(mimeType) || "audio/ogg";

  if (META_SUPPORTED_AUDIO_MIME_TYPES.has(normalizedMime)) {
    return {
      buffer,
      mimeType: normalizedMime,
      extension: mimeToExtension(normalizedMime, "ogg"),
    };
  }

  if (normalizedMime === "audio/webm" || normalizedMime === "video/webm") {
    const converted = await transcodeWebmAudioToOgg(buffer);
    return {
      buffer: converted,
      mimeType: "audio/ogg",
      extension: "ogg",
    };
  }

  throw new Error(
    `Formato de audio nao suportado pela API Meta (${normalizedMime}). Use ogg/opus, mp3, aac, amr ou mp4.`,
  );
};

const META_SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const IMAGE_MIME_TYPES_REQUIRING_TRANSCODE = new Set([
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp",
  "image/tiff",
]);
const META_SUPPORTED_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/3gpp", "video/3gp"]);
const VIDEO_MIME_TYPES_REQUIRING_TRANSCODE = new Set([
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/avi",
  "video/x-msvideo",
]);

const transcodeVideoToMp4 = (inputBuffer) =>
  new Promise((resolve, reject) => {
    if (!isFfmpegAvailable()) {
      reject(new Error("ffmpeg nao encontrado na VPS. Instale ffmpeg para converter videos para MP4."));
      return;
    }

    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "frag_keyframe+empty_moov",
      "-f",
      "mp4",
      "pipe:1",
    ]);

    const stdoutChunks = [];
    const stderrChunks = [];
    ffmpeg.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    ffmpeg.on("error", (error) => reject(new Error(`Falha ao iniciar ffmpeg: ${error.message}`)));
    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(stderrText || `ffmpeg finalizou com codigo ${code}`));
        return;
      }
      const output = Buffer.concat(stdoutChunks);
      if (!output.length) {
        reject(new Error("ffmpeg nao retornou video convertido"));
        return;
      }
      resolve(output);
    });
    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.write(inputBuffer);
    ffmpeg.stdin.end();
  });

const transcodeImageToPng = (inputBuffer) =>
  new Promise((resolve, reject) => {
    if (!isFfmpegAvailable()) {
      reject(new Error("ffmpeg nao esta disponivel para converter imagem para PNG"));
      return;
    }
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1",
    ]);
    const stdoutChunks = [];
    const stderrChunks = [];
    ffmpeg.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    ffmpeg.on("error", (error) => reject(new Error(`Falha ao iniciar ffmpeg: ${error.message}`)));
    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(stderrText || `ffmpeg finalizou com codigo ${code}`));
        return;
      }
      const output = Buffer.concat(stdoutChunks);
      if (!output.length) {
        reject(new Error("ffmpeg nao retornou imagem convertida"));
        return;
      }
      resolve(output);
    });
    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.write(inputBuffer);
    ffmpeg.stdin.end();
  });

const prepareImageUpload = async ({ buffer, mimeType }) => {
  const normalizedMime = normalizeMimeType(mimeType) || "image/png";
  if (META_SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMime)) {
    return { buffer, mimeType: normalizedMime, extension: mimeToExtension(normalizedMime, "png") };
  }
  if (IMAGE_MIME_TYPES_REQUIRING_TRANSCODE.has(normalizedMime) || normalizedMime.startsWith("image/")) {
    const converted = await transcodeImageToPng(buffer);
    return { buffer: converted, mimeType: "image/png", extension: "png" };
  }
  throw new Error(`Formato de imagem nao suportado pela Meta (${normalizedMime}). Use JPG ou PNG.`);
};

const prepareVideoUpload = async ({ buffer, mimeType }) => {
  const normalizedMime = normalizeMimeType(mimeType) || "video/mp4";
  if (META_SUPPORTED_VIDEO_MIME_TYPES.has(normalizedMime)) {
    return { buffer, mimeType: normalizedMime === "video/3gp" ? "video/3gpp" : normalizedMime, extension: normalizedMime === "video/mp4" ? "mp4" : "3gp" };
  }
  if (VIDEO_MIME_TYPES_REQUIRING_TRANSCODE.has(normalizedMime)) {
    const converted = await transcodeVideoToMp4(buffer);
    return { buffer: converted, mimeType: "video/mp4", extension: "mp4" };
  }
  throw new Error(`Formato de video nao suportado pela Meta (${normalizedMime}). Use MP4/3GP ou envie um video conversivel para MP4.`);
};

const decodeBase64Payload = ({ base64Value, mimeType, fallbackMimeType }) => {
  const raw = String(base64Value || "").trim();
  if (!raw) {
    throw new Error("Payload base64 vazio");
  }

  let detectedMime = String(mimeType || "").trim();
  let payload = raw;

  const dataUrlMatch = raw.match(/^data:([^,]+),(.+)$/i);
  if (dataUrlMatch) {
    const meta = String(dataUrlMatch[1] || "").trim();
    const body = String(dataUrlMatch[2] || "").trim();
    const metaParts = meta.split(";").map((part) => part.trim()).filter(Boolean);
    const mimeFromDataUrl = metaParts[0] && metaParts[0] !== "base64" ? metaParts[0] : "";
    const isBase64DataUrl = metaParts.some((part) => part.toLowerCase() === "base64");

    detectedMime = detectedMime || mimeFromDataUrl;
    if (!isBase64DataUrl) {
      throw new Error("Data URL sem marcador base64");
    }
    payload = body;
  }

  const normalizedPayload = payload.replace(/\s+/g, "");
  const buffer = Buffer.from(normalizedPayload, "base64");
  if (!buffer.length) {
    throw new Error("Nao foi possivel decodificar o payload base64");
  }

  return {
    buffer,
    mimeType: detectedMime || fallbackMimeType,
  };
};

const uploadMediaToMeta = async ({
  buffer,
  mimeType,
  filename,
  metaConfig = null,
  to = null,
  phoneNumberId = null,
  displayPhoneNumber = null,
  routeKey = null,
}) => {
  const selectedMetaConfig =
    metaConfig ||
    (await resolveConversationMetaConfig({
      to,
      phoneNumberId,
      displayPhoneNumber,
      routeKey,
    }));
  const { accessToken, phoneNumberId: targetPhoneNumberId } = selectedMetaConfig;
  if (!accessToken || !targetPhoneNumberId) {
    throw new Error("Missing WhatsApp access token or phone number id");
  }

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mimeType || "application/octet-stream" }), filename || "upload.bin");

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${targetPhoneNumberId}/media`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
    },
  );

  const data = await response.json();
  if (!response.ok) {
    const errorMessage = data?.error?.message || "Failed to upload media to WhatsApp";
    throw new Error(errorMessage);
  }

  const mediaId = String(data?.id || "").trim();
  if (!mediaId) {
    throw new Error("WhatsApp media upload did not return id");
  }
  return mediaId;
};

const sendMediaMessage = async ({
  to,
  mediaType,
  mediaId,
  mediaLink,
  caption,
  filename,
  contextMessageId,
  ptt,
  metaConfig = null,
  phoneNumberId = null,
  displayPhoneNumber = null,
  routeKey = null,
}) => {
  const waId = normalizePhone(to);
  if (!waId) {
    throw new Error("Invalid 'to' number");
  }

  const selectedMetaConfig =
    metaConfig ||
    (await resolveConversationMetaConfig({
      to: waId,
      phoneNumberId,
      displayPhoneNumber,
      routeKey,
    }));
  const { accessToken, phoneNumberId: targetPhoneNumberId } = selectedMetaConfig;
  if (!accessToken || !targetPhoneNumberId) {
    throw new Error("Missing WhatsApp access token or phone number id");
  }

  const payload = {
    messaging_product: "whatsapp",
    to: waId,
    type: mediaType,
    [mediaType]: {
    },
  };

  if (mediaId) {
    payload[mediaType].id = mediaId;
  } else if (mediaLink) {
    payload[mediaType].link = normalizeOutboundMediaLink(mediaLink);
  } else {
    throw new Error("Missing media id or link");
  }

  if (contextMessageId) {
    payload.context = { message_id: contextMessageId };
  }

  if (["image", "video", "document"].includes(mediaType) && caption) {
    payload[mediaType].caption = caption;
  }

  if (mediaType === "document" && filename) {
    payload.document.filename = String(filename || "").trim();
  }

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${targetPhoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  const data = await response.json();
  if (!response.ok) {
    const errorMessage = data?.error?.message || "WhatsApp API media send error";
    throw new Error(errorMessage);
  }

  return { ...data, __metaConfig: selectedMetaConfig };
};

const sendScheduledTextMessage = async ({ to, text }) => {
  const result = await sendTextMessage({ to, text });
  const messageId = result?.messages?.[0]?.id;
  await upsertAgentMessage({
    to,
    text,
    messageId,
    origin: "panel",
  });
  return { result, messageId };
};

const sendScheduledImageMessage = async ({ to, imageBase64, mimeType, caption }) => {
  const decoded = decodeBase64Payload({
    base64Value: imageBase64,
    mimeType,
    fallbackMimeType: "image/png",
  });
  const ext = mimeToExtension(decoded.mimeType, "png");
  const mediaId = await uploadMediaToMeta({
    buffer: decoded.buffer,
    mimeType: decoded.mimeType,
    filename: `scheduled-image-${Date.now()}.${ext}`,
  });
  const result = await sendMediaMessage({
    to,
    mediaType: "image",
    mediaId,
    caption: caption || undefined,
  });
  const messageId = result?.messages?.[0]?.id;
  await upsertAgentMessage({
    to,
    text: caption || "[image]",
    messageId,
    attachments: [{
      id: mediaId,
      type: "image",
      url: resolveMediaProxyUrl(mediaId),
      mimeType: decoded.mimeType,
      name: "Imagem agendada",
    }],
    origin: "panel",
  });
  return { result, messageId };
};

const sendScheduledAudioMessage = async ({ to, audioBase64, mimeType, messageText }) => {
  const decoded = decodeBase64Payload({
    base64Value: audioBase64,
    mimeType,
    fallbackMimeType: "audio/ogg",
  });
  const preparedAudio = await prepareAudioUpload({
    buffer: decoded.buffer,
    mimeType: decoded.mimeType,
  });
  const mediaId = await uploadMediaToMeta({
    buffer: preparedAudio.buffer,
    mimeType: preparedAudio.mimeType,
    filename: `scheduled-audio-${Date.now()}.${preparedAudio.extension}`,
  });
  const result = await sendMediaMessage({
    to,
    mediaType: "audio",
    mediaId,
    ptt: false,
  });
  const messageId = result?.messages?.[0]?.id;
  await upsertAgentMessage({
    to,
    text: "[audio]",
    messageId,
    attachments: [{
      id: mediaId,
      type: "audio",
      url: resolveMediaProxyUrl(mediaId),
      mimeType: preparedAudio.mimeType,
      name: "Audio agendado",
    }],
    origin: "panel",
  });
  if (String(messageText || "").trim()) {
    await sendScheduledTextMessage({ to, text: String(messageText).trim() });
  }
  return { result, messageId };
};

const executeScheduledMessageItem = async (item) => {
  const normalizedTo = normalizePhone(item?.to) || String(item?.to || "").trim();
  if (!normalizedTo) {
    throw new Error("Destino do agendamento invalido");
  }
  const type = normalizeScheduledMessageType(item?.type);
  if (type === "text") {
    await sendScheduledTextMessage({ to: normalizedTo, text: String(item.message || "").trim() });
    return;
  }
  if (type === "quickReply") {
    await sendScheduledTextMessage({ to: normalizedTo, text: String(item.message || "").trim() });
    return;
  }
  if (type === "media") {
    if (!item.imageBase64) {
      throw new Error("Imagem do agendamento ausente");
    }
    await sendScheduledImageMessage({
      to: normalizedTo,
      imageBase64: item.imageBase64,
      mimeType: item.imageName?.toLowerCase().endsWith(".jpg") || item.imageName?.toLowerCase().endsWith(".jpeg")
        ? "image/jpeg"
        : undefined,
      caption: String(item.message || "").trim(),
    });
    return;
  }
  if (type === "audio") {
    if (!item.audioBase64) {
      throw new Error("Audio do agendamento ausente");
    }
    await sendScheduledAudioMessage({
      to: normalizedTo,
      audioBase64: item.audioBase64,
      mimeType: item.audioMimeType || undefined,
      messageText: String(item.message || "").trim(),
    });
    return;
  }
};


const waitPanelAgentJob = async (jobId, timeoutMs = PANEL_AGENT_PLAYLIST_TIMEOUT_MS) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await panelAgentRequest(`/api/painel-agent/jobs/${encodeURIComponent(jobId)}`);
    const job = payload?.job;
    if (!job) throw new Error("Job de playlist nao encontrado no broker");
    if (job.status === "done") return job;
    if (job.status === "failed" || job.status === "rejected" || job.status === "cancelled") {
      throw new Error(job.error || `Playlist ${job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(500, PANEL_AGENT_PLAYLIST_POLL_MS)));
  }
  throw new Error("Timeout aguardando playlist no agente local");
};

const fetchPlaylistViaLocalAgent = async ({ phone, customerId }) => {
  const created = await panelAgentRequest("/api/painel-agent/jobs", {
    method: "POST",
    body: {
      type: "fetch_playlist",
      requestedBy: "whatsapp-server-playlist",
      payload: { phone, customerId },
    },
  });
  const jobId = created?.job?.id;
  if (!jobId) {
    throw new Error("Falha ao criar job de playlist no agente local");
  }
  const job = await waitPanelAgentJob(jobId);
  return { jobId, result: job.result || null };
};


const setCors = (res) => {































  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);































  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");































  res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
  res.setHeader("Access-Control-Expose-Headers", "ETag");































};































































const TEMPLATE_VARIABLE_REGEX = /\{\{\s*\d+\s*\}\}/;
const GENERIC_MESSAGE_REGEX = /^\[[^\]]+\]$/;

const messageContentScore = (value) => {
  const text = String(value || "").trim();
  if (!text) return 0;
  if (TEMPLATE_VARIABLE_REGEX.test(text)) return 1;
  if (GENERIC_MESSAGE_REGEX.test(text)) return 2;
  return 3;
};

const shouldReplaceMessageContent = (currentValue, incomingValue) => {
  return messageContentScore(incomingValue) > messageContentScore(currentValue);
};

const getMessageSender = (kind) => {
  if (kind === "client") return "client";
  if (kind === "agent") return "agent";
  return null;
};

const resolveMessageContentType = ({ kind, content, attachments }) => {
  if (kind === "system") return "system";
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.some((attachment) => attachment?.type === "audio")) return "audio";
  if (list.some((attachment) => attachment?.type === "video")) return "video";
  if (list.some((attachment) => attachment?.type === "document")) return "document";
  if (list.some((attachment) => attachment?.type === "image")) return "image";
  const text = String(content || "").trim();
  if (!text || /^\[(audio|video|image|document)\]$/i.test(text)) {
    return "system";
  }
  return "text";
};

const resolveConversationPreviewText = ({ content, attachments, storedMessage }) => {
  const attachmentList = Array.isArray(attachments)
    ? attachments
    : Array.isArray(storedMessage?.attachments)
      ? storedMessage.attachments
      : [];
  const firstAttachmentType = String(attachmentList?.[0]?.type || "").trim().toLowerCase();
  const firstAttachment = attachmentList?.[0] || null;
  const rawText = String(storedMessage?.content || content || "").trim();

  if (!firstAttachmentType) {
    return rawText;
  }

  if (/^\[[^\]]+\]/.test(rawText)) {
    return rawText;
  }

  const attachmentContextText =
    String(firstAttachment?.contact?.name || "").trim() ||
    String(firstAttachment?.name || "").trim();

  if (rawText) {
    return `[${firstAttachmentType}] ${rawText}`;
  }

  if (attachmentContextText) {
    return `[${firstAttachmentType}] ${attachmentContextText}`;
  }

  return `[${firstAttachmentType}]`;
};

const resolveConversationFlags = (conversation) => {
  const lastClient = conversation?.lastClientMessageTime
    ? new Date(conversation.lastClientMessageTime).getTime()
    : null;
  const withinWindow = lastClient ? Date.now() - lastClient <= 24 * 60 * 60 * 1000 : false;
  const tags = Array.isArray(conversation?.tags) ? conversation.tags : [];
  return {
    is_in_attendance: withinWindow,
    is_pending: !withinWindow,
    is_broadcast: tags.includes("disparo"),
  };
};

const normalizeDeliveryStatus = (value) => {
  const status = String(value || "").toLowerCase();
  if (status === "failed") return "failed";
  if (status === "read") return "read";
  if (status === "delivered") return "delivered";
  if (status === "sent") return "sent";
  return null;
};

const applyOutboundMessageStatus = async ({ messageId, status }) => {
  const resolvedStatus = normalizeDeliveryStatus(status);
  if (!messageId || !resolvedStatus) return;

  const store = await readStore();
  const eventAt = nowIso();
  const target = findOutboundMessageLocation(store, messageId);
  if (!target) return;

  const messages = store.messages?.[target.conversationId];
  if (!Array.isArray(messages)) return;

  const current = messages[target.index];
  if (!current) return;

  const currentStatus = normalizeDeliveryStatus(current.status) || String(current.status || "").toLowerCase();
  const currentRank = getDeliveryStatusRank(currentStatus);
  const nextRank = getDeliveryStatusRank(resolvedStatus);
  if (currentRank >= nextRank) return;

  const next = {
    ...current,
    status: resolvedStatus,
  };
  messages[target.index] = next;
  indexOutboundMessage(target.conversationId, target.index, next);

  const conversation = store.conversations?.[target.conversationId];
  if (conversation && (resolvedStatus === "delivered" || resolvedStatus === "read")) {
    conversation.last_read_at = eventAt;
  }

  await writeStore(store, { conversationIds: [target.conversationId] });
  publishConversationMessageEvent('conversation:message-status-updated', {
    conversationId: target.conversationId,
    conversation,
    message: next,
    status: resolvedStatus,
  });
};

const upsertStoredMessage = async ({
  waId,
  name,
  content,
  timestamp,
  messageId,
  type,
  isRead,
  status,
  attachments,
  templateButtons,
  replyTo,
  incrementUnread = false,
  origin = null,
  phoneNumberId = null,
  displayPhoneNumber = null,
  wabaId = null,
  routeKey = null,
  webhookPath = null,
  senderName = null,
  clientMessageId = null,
  providerMessageId = null,
  replyToId = null,
}) => {





  const store = await readStore({ mutable: false });































  const conversationId = mergeConversationIds(store, waId);































  const existingConversation = store.conversations[conversationId] || buildConversation({ waId, name });
  const resolvedPhoneNumberId =
    String(phoneNumberId || existingConversation.phone_number_id || "").trim() || null;
  const resolvedDisplayPhoneNumber =
    String(displayPhoneNumber || existingConversation.display_phone_number || "").trim() || null;
  const resolvedWabaId = String(wabaId || existingConversation.waba_id || "").trim() || null;
  const resolvedRouteKey =
    String(routeKey || existingConversation.meta_route_key || "").trim().toLowerCase() || null;
  const resolvedWebhookPath =
    String(webhookPath || existingConversation.last_webhook_path || "").trim() || null;































































  const nameLooksUnknown = isUnknownCustomerName(name, waId);

  if (name && !nameLooksUnknown) {
    existingConversation.customer.name = name;
  } else if (type === "client" && isUnknownCustomerName(existingConversation.customer?.name, waId)) {
    const painelUsuario = await resolvePainelUsuarioByPhone(waId);
    if (painelUsuario) {
      existingConversation.customer.name = painelUsuario;
      existingConversation.customer.usuario = painelUsuario;
    }
  }































































  let messages = store.messages[conversationId] || [];































  const normalizedClientMessageId = String(clientMessageId || "").trim();
  const normalizedProviderMessageId = String(providerMessageId || messageId || "").trim();
  const hasMessage = messages.some(
    (message) =>
      (normalizedClientMessageId && String(message.clientMessageId || message.client_message_id || "") === normalizedClientMessageId) ||
      (normalizedProviderMessageId &&
        [message.providerMessageId, message.provider_message_id, message.wamid, message.id]
          .map((value) => String(value || ""))
          .includes(normalizedProviderMessageId)) ||
      message.id === messageId,
  );































  if (!hasMessage) {































    messages.push({
      id: messageId,
      serverMessageId: messageId,
      server_message_id: messageId,
      clientMessageId: normalizedClientMessageId || undefined,
      client_message_id: normalizedClientMessageId || undefined,
      providerMessageId: normalizedProviderMessageId || undefined,
      provider_message_id: normalizedProviderMessageId || undefined,
      wamid: normalizedProviderMessageId || undefined,
      conversationId,
      from: getMessageSender(type) || undefined,
      messageType: resolveMessageContentType({ kind: type, content, attachments }),
      status: status || (type === "agent" ? "sent" : undefined),
      created_at: String(timestamp || nowIso()),
      type,
      content,
      timestamp,
      isRead,
      attachments,
      templateButtons: Array.isArray(templateButtons) ? templateButtons : undefined,
      template_buttons: Array.isArray(templateButtons) ? templateButtons : undefined,
      replyTo,
      reply_to_id: replyToId || undefined,
      replyToId: replyToId || undefined,
      reactions: [],
      origin: origin || undefined,
      phoneNumberId: resolvedPhoneNumberId || undefined,
      displayPhoneNumber: resolvedDisplayPhoneNumber || undefined,
      wabaId: resolvedWabaId || undefined,
      routeKey: resolvedRouteKey || undefined,
      senderName: senderName || undefined,
      sender_name: senderName || undefined,
      agentName: senderName || undefined,
    });































  }
  if (hasMessage) {
    messages = messages.map((message) => {
      const sameMessage =
        message.id === messageId ||
        (normalizedClientMessageId && String(message.clientMessageId || message.client_message_id || "") === normalizedClientMessageId) ||
        (normalizedProviderMessageId &&
          [message.providerMessageId, message.provider_message_id, message.wamid, message.id]
            .map((value) => String(value || ""))
            .includes(normalizedProviderMessageId));
      if (!sameMessage) return message;
      const nextContent = shouldReplaceMessageContent(message.content, content)
        ? content
        : message.content;
      const nextAttachments = Array.isArray(attachments) && attachments.length > 0
        ? attachments
        : message.attachments;
      return {
        ...message,
        from: message.from || getMessageSender(type) || undefined,
        messageType: message.messageType || resolveMessageContentType({ kind: type, content, attachments: nextAttachments }),
        status: status || message.status || (type === "agent" ? "sent" : undefined),
        serverMessageId: message.serverMessageId || messageId,
        server_message_id: message.server_message_id || messageId,
        clientMessageId: normalizedClientMessageId || message.clientMessageId || undefined,
        client_message_id: normalizedClientMessageId || message.client_message_id || undefined,
        providerMessageId: normalizedProviderMessageId || message.providerMessageId || undefined,
        provider_message_id: normalizedProviderMessageId || message.provider_message_id || undefined,
        wamid: normalizedProviderMessageId || message.wamid || undefined,
        created_at: message.created_at || String(timestamp || nowIso()),
        content: nextContent,
        attachments: nextAttachments,
        templateButtons: Array.isArray(templateButtons) && templateButtons.length > 0
          ? templateButtons
          : message.templateButtons,
        template_buttons: Array.isArray(templateButtons) && templateButtons.length > 0
          ? templateButtons
          : message.template_buttons,
        replyTo: replyTo || message.replyTo,
        reply_to_id: replyToId || message.reply_to_id || undefined,
        replyToId: replyToId || message.replyToId || undefined,
        isRead: typeof isRead === "boolean" ? isRead : message.isRead,
        timestamp: message.timestamp || timestamp,
        origin: origin || message.origin || undefined,
        phoneNumberId: resolvedPhoneNumberId || message.phoneNumberId || undefined,
        displayPhoneNumber: resolvedDisplayPhoneNumber || message.displayPhoneNumber || undefined,
        wabaId: resolvedWabaId || message.wabaId || undefined,
        routeKey: resolvedRouteKey || message.routeKey || undefined,
        senderName: senderName || message.senderName || undefined,
        sender_name: senderName || message.sender_name || undefined,
        agentName: senderName || message.agentName || undefined,
    };
  });
  }































































  const storedMessage = messages.find((message) => message.id === messageId);
  const previewText = resolveConversationPreviewText({
    content,
    attachments,
    storedMessage,
  });
  existingConversation.phone_number_id = resolvedPhoneNumberId;
  existingConversation.display_phone_number = resolvedDisplayPhoneNumber;
  existingConversation.waba_id = resolvedWabaId;
  existingConversation.meta_route_key = resolvedRouteKey;
  existingConversation.last_webhook_path = resolvedWebhookPath;
  existingConversation.lastMessage = previewText || existingConversation.lastMessage || "";
  const eventAt = String(timestamp || nowIso());
  existingConversation.lastMessageTime = eventAt;
  existingConversation.last_message_at = eventAt;

  if (type === "client") {
    existingConversation.lastClientMessageTime = eventAt;
    existingConversation.last_received_at = eventAt;
    if (!Array.isArray(existingConversation.tags)) {
      existingConversation.tags = [];
    }
    if (existingConversation.tags.includes("disparo")) {
      existingConversation.tags = existingConversation.tags.filter((tag) => tag !== "disparo");
    }
  }

  if (type === "agent") {
    existingConversation.last_sent_at = eventAt;
  }

  const currentUnread = Number(existingConversation.unreadCount || existingConversation.unread_count || 0);
  if (incrementUnread) {
    const nextUnread = currentUnread + 1;
    existingConversation.unreadCount = nextUnread;
    existingConversation.unread_count = nextUnread;
  } else if (type !== "client") {
    existingConversation.unreadCount = 0;
    existingConversation.unread_count = 0;
    existingConversation.last_read_at = eventAt;
    const hasUnread = messages.some((message) => !message.isRead);
    if (hasUnread) {
      messages = messages.map((message) =>
        message.isRead ? message : { ...message, isRead: true },
      );
    }
  } else {
    existingConversation.unreadCount = currentUnread;
    existingConversation.unread_count = currentUnread;
  }

  let operationStore = null;
  let operationStoreMutated = false;
  if (type === "client") {
    operationStore = await readOperationStore();
    const assignmentLabelIds = await resolveConversationLabelIdsForAssignment(existingConversation);
    if (assignmentLabelIds.length > 0) {
      existingConversation.label_ids = assignmentLabelIds;
    }
    const preferenceMap = buildPreferenceMap(operationStore);
    const preference = preferenceMap.get(conversationId);
    const resolvedAtMs = Date.parse(String(preference?.resolved_at || ""));
    const eventAtMs = Date.parse(eventAt);
    const reopenedByCustomer =
      String(preference?.resolution_status || "").trim() === "resolved" &&
      Number.isFinite(resolvedAtMs) &&
      Number.isFinite(eventAtMs) &&
      eventAtMs > resolvedAtMs;

    if (reopenedByCustomer) {
      operationStoreMutated = clearConversationResolutionPreference(operationStore, conversationId) || operationStoreMutated;
      existingConversation.status = "waiting";
    }

    const assignmentResult = assignConversationToAvailableAgent({
      store,
      operationStore,
      conversation: existingConversation,
      forceReassign: reopenedByCustomer,
      assignedAt: eventAt,
    });

    if (assignmentResult.assigned) {
      console.log(
        `[assignment] conversation=${conversationId} agent=${assignmentResult.user?.email || assignmentResult.user?.id || "unknown"} reason=${assignmentResult.reason}`,
      );
    }
  }

  const conversationFlags = resolveConversationFlags(existingConversation);
  existingConversation.is_in_attendance = conversationFlags.is_in_attendance;
  existingConversation.is_pending = conversationFlags.is_pending;
  existingConversation.is_broadcast = conversationFlags.is_broadcast;































































  store.conversations[conversationId] = existingConversation;































  store.messages[conversationId] = trimStoredMessagesForConversation(messages);































































  await writeStore(store, { assumeOwnership: true, conversationIds: [conversationId] });
  if (operationStoreMutated && operationStore) {
    await writeOperationStore(operationStore);
  }

  return {
    conversationId,
    conversation: existingConversation,
    message: storedMessage || null,
  };































};































































const applyMessageReactionEntry = (message, { from, emoji, reactedAt }) => {
  if (!message || !from) return message;
  const normalizedEmoji = String(emoji || "").trim();
  const reactionList = Array.isArray(message.reactions)
    ? message.reactions
        .map((entry) => ({
          emoji: String(entry?.emoji || "").trim(),
          from:
            entry?.from === "client" || entry?.from === "agent"
              ? entry.from
              : entry?.by === "client" || entry?.by === "agent"
                ? entry.by
                : null,
          reacted_at: entry?.reacted_at || entry?.updatedAt || null,
        }))
        .filter((entry) => entry.emoji && entry.from)
    : [];

  const existingIndex = reactionList.findIndex((entry) => entry.from === from);
  if (!normalizedEmoji) {
    if (existingIndex >= 0) {
      reactionList.splice(existingIndex, 1);
    }
  } else if (existingIndex >= 0) {
    const existing = reactionList[existingIndex];
    if (existing.emoji === normalizedEmoji) {
      reactionList.splice(existingIndex, 1);
    } else {
      reactionList[existingIndex] = {
        emoji: normalizedEmoji,
        from,
        reacted_at: reactedAt || nowIso(),
      };
    }
  } else {
    reactionList.push({
      emoji: normalizedEmoji,
      from,
      reacted_at: reactedAt || nowIso(),
    });
  }

  return {
    ...message,
    reactions: reactionList,
  };
};

const upsertMessageReaction = async ({ conversationId, targetMessageId, from, emoji, reactedAt }) => {
  if (!targetMessageId || !from) {
    return null;
  }
  const store = await readStore();
  const candidateIds = conversationId
    ? [conversationId]
    : Object.keys(store.messages || {});

  let updatedMessage = null;
  let updatedConversationId = null;
  for (const id of candidateIds) {
    const messages = store.messages?.[id];
    if (!Array.isArray(messages) || messages.length === 0) continue;
    const index = messages.findIndex((item) => item.id === targetMessageId);
    if (index < 0) continue;
    const current = messages[index];
    const next = applyMessageReactionEntry(current, { from, emoji, reactedAt });
    messages[index] = next;
    store.messages[id] = messages;
    updatedMessage = next;
    updatedConversationId = id;
    break;
  }

  if (updatedMessage) {
    await writeStore(store, { conversationIds: [updatedConversationId] });
    publishConversationMessageEvent('conversation:message-reaction-updated', {
      conversationId: updatedConversationId,
      conversation: store.conversations?.[updatedConversationId] || null,
      message: updatedMessage,
    });
  }
  return updatedMessage;
};

const applyWebhookReactionMessage = async ({ message, businessNumber, fallbackConversationId = null }) => {
  const from = normalizeWebhookWaId(message?.from);
  const to = normalizeWebhookWaId(message?.to);
  const targetId = String(message?.reaction?.message_id || "").trim();
  const emoji = String(message?.reaction?.emoji || "").trim();
  const reactedAt = parseWebhookTimestamp(message?.timestamp);
  const isAgentReaction = Boolean(businessNumber) && from === businessNumber;
  const userWaId = isAgentReaction ? to : from;
  if (!targetId || !userWaId || (businessNumber && userWaId === businessNumber)) {
    return null;
  }
  const reactionConversationId = fallbackConversationId || `wa-${userWaId}`;
  return upsertMessageReaction({
    conversationId: reactionConversationId,
    targetMessageId: targetId,
    from: isAgentReaction ? "agent" : "client",
    emoji,
    reactedAt,
  });
};


const upsertIncomingMessage = async ({
  waId,
  name,
  content,
  timestamp,
  messageId,
  attachments,
  replyTo,
  incrementUnread = true,
  phoneNumberId = null,
  displayPhoneNumber = null,
  wabaId = null,
  routeKey = null,
  webhookPath = null,
  senderName = null,
  clientMessageId = null,
  replyToId = null,
}) => {
  const processingStartedAt = Date.now();
  let storeElapsedMs = 0;
  let flowElapsedMs = 0;
  let chatbotElapsedMs = 0;

  const storeStartedAt = Date.now();
  const result = await upsertStoredMessage({































  waId,































  name,































  content,































  timestamp,































  messageId,































  type: "client",
  status: "delivered",
  isRead: false,
  attachments,
  replyTo,
  incrementUnread,
  phoneNumberId,
  displayPhoneNumber,
  wabaId,
  routeKey,
  webhookPath,
  senderName,
  clientMessageId,
  replyToId,































  });
  storeElapsedMs = Date.now() - storeStartedAt;

  publishConversationMessageEvent('conversation:message-upserted', {
    conversationId: result?.conversationId || null,
    conversation: result?.conversation || null,
    message: result?.message || null,
  });

  const flowStartedAt = Date.now();
  try {
    await executeMatchingFlowForSupportMessage({
      waId,
      content,
      messageId,
      conversationId: result?.conversationId || null,
      conversation: result?.conversation || null,
    });
  } catch (error) {
    console.error("[flow] support execution failed:", error?.message || error);
  } finally {
    flowElapsedMs = Date.now() - flowStartedAt;
  }

  const chatbotStartedAt = Date.now();
  try {
    await processLocalChatbotIncomingMessage({
      waId,
      content,
      timestamp,
      messageId,
      conversationId: result?.conversationId || null,
      conversation: result?.conversation || null,
    });
  } catch (error) {
    console.error("[chatbot] local incoming processing failed:", error?.message || error);
  } finally {
    chatbotElapsedMs = Date.now() - chatbotStartedAt;
  }

  const totalElapsedMs = Date.now() - processingStartedAt;
  if (totalElapsedMs >= WEBHOOK_SLOW_PROCESSING_THRESHOLD_MS) {
    console.warn(
      `[webhook-perf] slow incoming message total=${totalElapsedMs}ms store=${storeElapsedMs}ms flow=${flowElapsedMs}ms chatbot=${chatbotElapsedMs}ms route=${routeKey || "default"} conversation=${result?.conversationId || ""} message=${messageId || ""}`,
    );
  }

  return result;
};































































const upsertAgentMessage = async ({
  to,
  text,
  messageId,
  timestamp,
  attachments,
  templateButtons,
  replyTo,
  origin = "panel",
  phoneNumberId = null,
  displayPhoneNumber = null,
  wabaId = null,
  routeKey = null,
  webhookPath = null,
  senderName = null,
  clientMessageId = null,
  replyToId = null,
}) => {































  const waId = normalizePhone(to);































  if (!waId) {































    throw new Error("Invalid 'to' number");































  }































































  const selectedMetaConfig =
    phoneNumberId || displayPhoneNumber || routeKey
      ? await resolveSelectedMetaConfig({
          phoneNumberId,
          displayPhoneNumber,
          routeKey,
        })
      : await resolveConversationMetaConfig({ to: waId });
  const resolvedTimestamp = timestamp || nowIso();































  const resolvedId = messageId || `agent-${randomUUID()}`;































  const result = await upsertStoredMessage({































    waId,































    name: null,































    content: text,































    timestamp: resolvedTimestamp,































    messageId: resolvedId,
    clientMessageId,
    providerMessageId: messageId || null,































    type: "agent",
    status: "sent",
    isRead: true,
    attachments,
    templateButtons,
    replyTo,
    replyToId,
    incrementUnread: false,
    origin,
    phoneNumberId: phoneNumberId || selectedMetaConfig.phoneNumberId || null,
    displayPhoneNumber: displayPhoneNumber || selectedMetaConfig.displayPhoneNumber || null,
    wabaId: wabaId || selectedMetaConfig.wabaId || null,
    routeKey: routeKey || selectedMetaConfig.routeKey || null,
    webhookPath: webhookPath || selectedMetaConfig.webhookPath || null,
    senderName,
  });

  publishConversationMessageEvent('conversation:message-upserted', {
    conversationId: result?.conversationId || null,
    conversation: result?.conversation || null,
    message: result?.message || null,
  });
};
const normalizeWebhookWaId = (value) => normalizePhone(value) || (value ? String(value) : "");































































const parseWebhookTimestamp = (value) => {































  const parsed = Number(value);































  if (Number.isFinite(parsed) && parsed > 0) {































    return new Date(parsed * 1000).toISOString();































  }































  return nowIso();































};































































const extractWebhookContent = (message) => {
  if (!message) return "[mensagem]";
  if (message.text?.body) return message.text.body;

  const type = String(message.type || "mensagem").toLowerCase();

  if (type === "reaction") {
    const emoji = String(message.reaction?.emoji || "").trim();
    const targetId = String(message.reaction?.message_id || "").trim();
    if (emoji && targetId) return `[reaction] ${emoji} -> ${targetId}`;
    if (emoji) return `[reaction] ${emoji}`;
  }

  if (type === "interactive") {
    const buttonReply = message.interactive?.button_reply;
    if (buttonReply?.title) return buttonReply.title;
    if (buttonReply?.id) return buttonReply.id;
    const listReply = message.interactive?.list_reply;
    if (listReply?.title) return listReply.title;
    if (listReply?.description) return listReply.description;
    if (listReply?.id) return listReply.id;
  }

  if (type === "button") {
    if (message.button?.text) return message.button.text;
    if (message.button?.payload) return message.button.payload;
  }

  if (type === "location") {
    const label = String(message.location?.name || message.location?.address || "").trim();
    if (label) return `[localizacao] ${label}`;
    return "[localizacao]";
  }

  if (type === "contacts") {
    const first = Array.isArray(message.contacts) ? message.contacts[0] : null;
    const fullName = first?.name?.formatted_name || first?.name?.first_name || first?.name?.last_name;
    if (fullName) return `[contato] ${fullName}`;
    return "[contato]";
  }

  if (type === "unsupported") {
    const unsupportedText = [
      message.errors?.[0]?.title,
      message.errors?.[0]?.message,
      message.errors?.[0]?.details,
      message.unsupported?.description,
    ]
      .map((value) => String(value || "").trim())
      .find(Boolean);
    return unsupportedText ? `[mensagem nao suportada] ${unsupportedText}` : "[mensagem nao suportada]";
  }

  if (type === "edit" || type === "edited") {
    const editedText =
      String(message.edited?.text || "").trim() ||
      String(message.edited?.body || "").trim() ||
      String(message.text?.body || "").trim();
    if (editedText) return `[editado] ${editedText}`;
    return "[mensagem editada]";
  }

  if (type === "revoke" || type === "revoked" || type === "deleted") {
    return "Mensagem apagada pelo cliente.";
  }

  if (type === "order") {
    return "[pedido]";
  }

  const typedPayload = message[type];
  if (typedPayload?.caption) return typedPayload.caption;
  if (typedPayload?.text) return typedPayload.text;

  const labels = {
    image: "imagem",
    audio: "audio",
    video: "video",
    document: "arquivo",
    sticker: "figurinha",
    system: "sistema",
  };

  const normalizedType = labels[type] || type || "mensagem";
  return `[${normalizedType}]`;
};

const resolveMediaProxyUrl = (mediaId) => `/api/whatsapp/media?id=${encodeURIComponent(mediaId)}`;

const extractWebhookAttachments = (message) => {
  if (!message) return [];
  const type = String(message.type || "").toLowerCase();

  const buildMediaAttachment = ({
    mediaType,
    payload,
    name,
    fallbackType,
  }) => {
    if (!payload || typeof payload !== "object") return null;
    const mediaId = String(payload.id || "").trim();
    const directLink = String(payload.link || payload.url || "").trim();
    const attachmentUrl = mediaId ? resolveMediaProxyUrl(mediaId) : directLink;
    if (!attachmentUrl) return null;
    return {
      id: mediaId || `${mediaType || fallbackType || "file"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: mediaType || fallbackType || "document",
      url: attachmentUrl,
      mimeType: payload.mime_type || payload.mimeType,
      name: name || payload.filename || payload.name || "Arquivo",
      size: Number(payload.file_size || payload.size || 0) || undefined,
    };
  };

  if (type === "image") {
    const attachment = buildMediaAttachment({
      mediaType: "image",
      payload: message.image,
      name: "Imagem",
    });
    return attachment ? [attachment] : [];
  }

  if (type === "video") {
    const attachment = buildMediaAttachment({
      mediaType: "video",
      payload: message.video,
      name: "Video",
    });
    return attachment ? [attachment] : [];
  }

  if (type === "audio") {
    const attachment = buildMediaAttachment({
      mediaType: "audio",
      payload: message.audio,
      name: "Audio",
    });
    return attachment ? [attachment] : [];
  }

  if (type === "document") {
    const attachment = buildMediaAttachment({
      mediaType: "document",
      payload: message.document,
      name: message.document?.filename || "Documento",
    });
    return attachment ? [attachment] : [];
  }

  if (type === "sticker") {
    const attachment = buildMediaAttachment({
      mediaType: "sticker",
      payload: message.sticker,
      name: "Sticker",
    });
    return attachment ? [attachment] : [];
  }

  if (type === "contacts") {
    const contacts = Array.isArray(message.contacts) ? message.contacts : [];
    return contacts.map((contact, index) => {
      const contactName = contact?.name?.formatted_name || contact?.name?.first_name || contact?.name?.last_name || "Contato";
      const phones = Array.isArray(contact?.phones)
        ? contact.phones
            .map((phone) => phone?.phone || phone?.wa_id || "")
            .filter(Boolean)
        : [];
      return {
        id: contact?.wa_id || `contact-${Date.now()}-${index}`,
        type: "contact",
        name: contactName,
        contact: {
          name: contactName,
          phones,
        },
      };
    });
  }

  if (type === "location") {
    const latitude = Number(message.location?.latitude);
    const longitude = Number(message.location?.longitude);
    const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
    const url = hasCoordinates
      ? `https://maps.google.com/?q=${encodeURIComponent(`${latitude},${longitude}`)}`
      : "";
    return [{
      id: `location-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "location",
      url: url || undefined,
      mimeType: "application/json",
      name: message.location?.name || message.location?.address || "Localizacao",
    }];
  }

  // Fallback for unknown media-like payloads so messages are never silently dropped.
  const typedPayload = message[type];
  if (typedPayload && typeof typedPayload === "object") {
    const fallbackAttachment = buildMediaAttachment({
      mediaType: type || "document",
      payload: typedPayload,
      name: typedPayload.filename || typedPayload.name || `Arquivo (${type || "desconhecido"})`,
      fallbackType: "document",
    });
    if (fallbackAttachment) return [fallbackAttachment];
  }

  return [];
};































































const upsertContactName = async (waId, name) => {































  if (!waId) return;































  const store = await readStore();































  const conversationId = mergeConversationIds(store, waId);































  const existingConversation = store.conversations[conversationId] || buildConversation({ waId, name });































  if (name) {































    existingConversation.customer.name = name;































  }































  store.conversations[conversationId] = existingConversation;































  await writeStore(store, { conversationIds: [conversationId] });































};































































const handleWebhookPayload = async (payload, options = {}) => {































  const entries = Array.isArray(payload?.entry) ? payload.entry : [];































































  for (const entry of entries) {































    const changes = Array.isArray(entry?.changes) ? entry.changes : [];































    for (const change of changes) {































      const value = change?.value;































      if (!value) continue;































































      const contacts = Array.isArray(value.contacts) ? value.contacts : [];































      const contactNames = new Map(































        contacts































          .filter((contact) => contact?.wa_id)































          .map((contact) => [contact.wa_id, contact.profile?.name]),































      );































































      const linePhoneNumberId = String(
        value?.metadata?.phone_number_id || options?.metaConfig?.phoneNumberId || "",
      ).trim() || null;
      const lineDisplayPhoneNumber =
        String(
          value?.metadata?.display_phone_number || options?.metaConfig?.displayPhoneNumber || "",
        ).trim() || null;
      const lineWabaId = String(entry?.id || options?.metaConfig?.wabaId || "").trim() || null;
      const resolvedLineConfig = await resolveSelectedMetaConfig({
        phoneNumberId: linePhoneNumberId,
        displayPhoneNumber: lineDisplayPhoneNumber,
        routeKey: options?.metaConfig?.routeKey || options?.routeKey || null,
        allowFallback: true,
      });
      const lineRouteKey =
        String(resolvedLineConfig?.routeKey || options?.metaConfig?.routeKey || options?.routeKey || "")
          .trim()
          .toLowerCase() || null;
      const lineWebhookPath =
        String(resolvedLineConfig?.webhookPath || options?.metaConfig?.webhookPath || options?.webhookPath || "")
          .trim() || null;
      const businessNumber = normalizeWebhookWaId(lineDisplayPhoneNumber);

      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const status of statuses) {
        try {
          const statusId = status?.id || "";
          const statusValue = String(status?.status || "").toLowerCase();
          if (shouldSkipMetaStatusEvent({ messageId: statusId, status: statusValue })) {
            continue;
          }
          const recipient = normalizeWebhookWaId(status?.recipient_id);
          const errors = Array.isArray(status?.errors) ? status.errors : [];
          const normalizedErrors = normalizeMetaStatusErrors(errors, statusValue);
          const primaryError = normalizedErrors[0] || null;
          const errorCode = primaryError?.code || "";
          const errorText = normalizedErrors
            .map((item) => item.summary)
            .filter(Boolean)
            .join(" || ");
          const line = `[meta-status] id=${statusId} to=${recipient || "-"} status=${statusValue || "unknown"}${
            errorCode ? ` code=${errorCode}` : ""
          }${
            errorText ? ` error=${errorText}` : ""
          }`;
          if (statusValue === "failed") {
            console.warn(line);
          } else {
            console.log(line);
          }
          await appendMessageDeliveryLog({
            category: "message-status",
            level: statusValue === "failed" ? "error" : "info",
            source: "meta-status",
            event: "meta-status",
            to: recipient || null,
            messageId: statusId || null,
            status: statusValue || null,
            errorCode: errorCode || null,
            errorReason: errorText || null,
            message: errorText
              ? `Status ${statusValue || "unknown"} para ${recipient || "-"}${errorCode ? ` (codigo ${errorCode})` : ""}: ${errorText}`
              : `Status ${statusValue || "unknown"} para ${recipient || "-"}.`,
          });
          if (statusId && statusValue) {
            await applyOutboundMessageStatus({ messageId: statusId, status: statusValue });
          }
        } catch (statusError) {
          console.warn("[meta-status] parse error", statusError?.message || statusError);
        }
      }
      const stateSync = Array.isArray(value.state_sync) ? value.state_sync : [];































      for (const item of stateSync) {































        if (item?.type !== "contact") continue;































        const phone = normalizeWebhookWaId(item?.contact?.phone_number);































        const fullName = item?.contact?.full_name || item?.contact?.first_name || null;































        if (phone && fullName) {































          await upsertContactName(phone, fullName);































        }































      }































































      const messageEchoes = Array.isArray(value.message_echoes) ? value.message_echoes : [];































      for (const message of messageEchoes) {































        const to = normalizeWebhookWaId(message?.to);































        if (!to) continue;































        const messageType = String(message?.type || "").toLowerCase();
        if (messageType === "reaction") {
          await applyWebhookReactionMessage({
            message,
            businessNumber,
            fallbackConversationId: `wa-${to}`,
          });
          continue;
        }
        const content = extractWebhookContent(message);
        const attachments = extractWebhookAttachments(message);































        const timestamp = parseWebhookTimestamp(message?.timestamp);































        const messageId = message?.id || `echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const replyTo = message?.context?.id ? { id: message.context.id } : undefined;































        await upsertAgentMessage({
          to,
          text: content,
          messageId,
          timestamp,
          attachments,
          replyTo,
          origin: "device",
          phoneNumberId: linePhoneNumberId,
          displayPhoneNumber: lineDisplayPhoneNumber,
          wabaId: lineWabaId,
          routeKey: lineRouteKey,
          webhookPath: lineWebhookPath,
        });































      }































































      const historyEntries = Array.isArray(value.history) ? value.history : [];






























































      for (const historyEntry of historyEntries) {































        if (Array.isArray(historyEntry?.errors) && historyEntry.errors.length > 0) {































          console.warn("History sync error", historyEntry.errors);































          continue;































        }































        const threads = Array.isArray(historyEntry?.threads) ? historyEntry.threads : [];































        for (const thread of threads) {































          const threadWaId = normalizeWebhookWaId(thread?.id);































          if (!threadWaId) continue;































          const threadMessages = Array.isArray(thread?.messages) ? thread.messages : [];































          for (const message of threadMessages) {































            const from = normalizeWebhookWaId(message?.from);































            const isClient = from === threadWaId;































            const messageType = String(message?.type || "").toLowerCase();
            if (messageType === "reaction") {
              await applyWebhookReactionMessage({
                message,
                businessNumber,
                fallbackConversationId: `wa-${threadWaId}`,
              });
              continue;
            }
            const content = extractWebhookContent(message);
        const attachments = extractWebhookAttachments(message);































            const timestamp = parseWebhookTimestamp(message?.timestamp);































            const messageId = message?.id || `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const replyTo = message?.context?.id ? { id: message.context.id } : undefined;































            if (isClient) {































              await upsertIncomingMessage({































                waId: threadWaId,































                name: contactNames.get(threadWaId),































                content,































                timestamp,































                messageId, attachments,
    replyTo,
    incrementUnread: false,
    phoneNumberId: linePhoneNumberId,
    displayPhoneNumber: lineDisplayPhoneNumber,
    wabaId: lineWabaId,
    routeKey: lineRouteKey,
    webhookPath: lineWebhookPath,































              });































            } else {































              await upsertAgentMessage({
                to: threadWaId,
                text: content,
                messageId,
                timestamp,
                attachments,
                origin: "device",
                phoneNumberId: linePhoneNumberId,
                displayPhoneNumber: lineDisplayPhoneNumber,
                wabaId: lineWabaId,
                routeKey: lineRouteKey,
                webhookPath: lineWebhookPath,
              });































            }































          }































        }































      }































































      if (change?.field === "history") {































        const historyMessages = Array.isArray(value.messages) ? value.messages : [];































        for (const message of historyMessages) {































          const from = normalizeWebhookWaId(message?.from);































          const to = normalizeWebhookWaId(message?.to);































          const userWaId = to && to !== businessNumber ? to : from;































          if (!userWaId || userWaId === businessNumber) continue;































          const messageType = String(message?.type || "").toLowerCase();
          if (messageType === "reaction") {
            await applyWebhookReactionMessage({
              message,
              businessNumber,
              fallbackConversationId: `wa-${userWaId}`,
            });
            continue;
          }
          const content = extractWebhookContent(message);
        const attachments = extractWebhookAttachments(message);































          const timestamp = parseWebhookTimestamp(message?.timestamp);































          const messageId = message?.id || `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const replyTo = message?.context?.id ? { id: message.context.id } : undefined;































          const isClient = from === userWaId;































          if (isClient) {































            await upsertIncomingMessage({































              waId: userWaId,































              name: contactNames.get(userWaId),































              content,































              timestamp,































              messageId, attachments,
    replyTo,
    incrementUnread: false,
    phoneNumberId: linePhoneNumberId,
    displayPhoneNumber: lineDisplayPhoneNumber,
    wabaId: lineWabaId,
    routeKey: lineRouteKey,
    webhookPath: lineWebhookPath,































            });































          } else {































            await upsertAgentMessage({
              to: userWaId,
              text: content,
              messageId,
              timestamp,
              attachments,
              origin: "device",
              phoneNumberId: linePhoneNumberId,
              displayPhoneNumber: lineDisplayPhoneNumber,
              wabaId: lineWabaId,
              routeKey: lineRouteKey,
              webhookPath: lineWebhookPath,
            });































          }































        }































      }      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        const from = normalizeWebhookWaId(message?.from);
        const to = normalizeWebhookWaId(message?.to);
        if (!from && !to) {
          await appendMessageDeliveryLog({
            category: "incoming-message",
            level: "warning",
            source: "meta-webhook",
            event: "incoming-message-skipped",
            messageId: message?.id || null,
            message: `Mensagem ignorada por falta de remetente e destinatario. Tipo: ${String(message?.type || "desconhecido")}.`,
          });
          continue;
        }
        const messageType = String(message?.type || "").toLowerCase();
        if (messageType === "reaction") {
          await applyWebhookReactionMessage({ message, businessNumber });
          continue;
        }
        const content = extractWebhookContent(message);
        const attachments = extractWebhookAttachments(message);
        const timestamp = parseWebhookTimestamp(message?.timestamp);
        const messageId = message?.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const replyTo = message?.context?.id ? { id: message.context.id } : undefined;
        const isFromBusiness = businessNumber && from === businessNumber;
        if (isFromBusiness) {
          if (!to || to === businessNumber) {
            await appendMessageDeliveryLog({
              category: "incoming-message",
              level: "warning",
              source: "meta-webhook",
              event: "outbound-echo-skipped",
              messageId: messageId || null,
              to: to || null,
              message: `Eco de mensagem ignorado por destinatario invalido. Tipo: ${messageType || "desconhecido"}.`,
            });
            continue;
          }
          await upsertAgentMessage({
            to,
            text: content,
            messageId,
            timestamp,
            attachments,
            replyTo,
            origin: "device",
            phoneNumberId: linePhoneNumberId,
            displayPhoneNumber: lineDisplayPhoneNumber,
            wabaId: lineWabaId,
            routeKey: lineRouteKey,
            webhookPath: lineWebhookPath,
          });
          continue;
        }
        if (!from) {
          await appendMessageDeliveryLog({
            category: "incoming-message",
            level: "warning",
            source: "meta-webhook",
            event: "incoming-message-skipped",
            messageId: messageId || null,
            message: `Mensagem recebida ignorada por remetente invalido. Tipo: ${messageType || "desconhecido"}.`,
          });
          continue;
        }
        const name = contactNames.get(from);
        const result = await upsertIncomingMessage({
          waId: from,
          name,
          content,
          timestamp,
          messageId,
          attachments,
          replyTo,
          phoneNumberId: linePhoneNumberId,
          displayPhoneNumber: lineDisplayPhoneNumber,
          wabaId: lineWabaId,
          routeKey: lineRouteKey,
          webhookPath: lineWebhookPath,
        });
        await appendMessageDeliveryLog({
          category: "incoming-message",
          level: "info",
          source: "meta-webhook",
          event: "incoming-message-stored",
          channel: "support",
          messageId: messageId || null,
          conversationId: result?.conversationId || null,
          phone: from || null,
          preview: String(result?.conversation?.lastMessage || content || "").trim() || null,
          message: `Mensagem recebida registrada na conversa ${String(result?.conversationId || "desconhecida")}.`,
        });
      }































    }































  }































};































































const server = http.createServer(async (req, res) => {































  const url = new URL(req.url, `http://${req.headers.host}`);
  attachSlowRouteLogger(req, res, { source: "whatsapp" });

  if (req.method === "GET" && isWhatsappHealthPath(url.pathname)) {
    setCors(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      role: WHATSAPP_HTTP_ROLE || "all",
      runtimeRole: RUNTIME_ROLE || null,
      schedulersEnabled: WHATSAPP_SCHEDULERS_ENABLED,
      httpEnabled: WHATSAPP_HTTP_ENABLED,
    }));
    return;
  }

  if (!isWhatsappHttpRoleAllowed(url.pathname)) {
    setCors(res);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Route not available for this WhatsApp service role." }));
    return;
  }
































































  if (req.method === "OPTIONS") {































    setCors(res);































    res.writeHead(204);































    res.end();































    return;































  }































































  if (shouldProxyToBaileys(url)) {































    try {































      await proxyBaileysRequest(req, res, url);































    } catch (error) {































      setCors(res);































      res.writeHead(502, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Baileys proxy error" }));































    }































    return;































  }































































  if (req.method === "GET" && isSupportedMetaWebhookPath(url.pathname)) {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const webhookConfig = await resolveSelectedMetaConfig({
      pathName: url.pathname,
      allowFallback: false,
    });
    const expectedToken = String(webhookConfig?.verifyToken || "").trim();

    if (mode === "subscribe" && token && expectedToken && token === expectedToken) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(challenge || "");
      return;
    }

    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Webhook verify failed");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/whatsapp/webhook") {































    const mode = url.searchParams.get("hub.mode");































    const token = url.searchParams.get("hub.verify_token");































    const challenge = url.searchParams.get("hub.challenge");































































    if (mode === "subscribe" && token && token === WEBHOOK_VERIFY_TOKEN) {































      res.writeHead(200, { "Content-Type": "text/plain" });































      res.end(challenge || "");































      return;































    }































































    res.writeHead(403, { "Content-Type": "text/plain" });































    res.end("Webhook verify failed");































    return;































  }































































  if (req.method === "POST" && isSupportedMetaWebhookPath(url.pathname)) {
    setCors(res);

    try {
      const webhookConfig = await resolveSelectedMetaConfig({
        pathName: url.pathname,
        allowFallback: false,
      });
      const rawBody = await readBuffer(req);
      const signatureHeader = req.headers["x-hub-signature-256"];

      if (!verifyWebhookSignature({ rawBody, signatureHeader, appSecret: webhookConfig?.appSecret })) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Webhook signature verification failed" }));
        return;
      }

      const payload = parseWebhookPayloadBuffer(rawBody);

      if (WHATSAPP_WEBHOOK_CHAT_ONLY) {
        const result = await acceptMetaWebhook({ rawBody, payload });
        console.log(
          `[chat-webhook] route=${webhookConfig?.routeKey || "default"} accepted=true duplicate=${Boolean(result?.duplicate)}`,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", accepted: true, duplicate: Boolean(result?.duplicate) }));
        return;
      }

      mirrorMetaWebhookToChatArchitecture({
        rawBody,
        payload,
        routeKey: webhookConfig?.routeKey || null,
      });
      const payloadSummary = Array.isArray(payload?.entry)
        ? payload.entry.reduce(
            (accumulator, entry) => {
              const changes = Array.isArray(entry?.changes) ? entry.changes : [];
              for (const change of changes) {
                const value = change?.value || {};
                const messageCount = Array.isArray(value?.messages) ? value.messages.length : 0;
                const statusCount = Array.isArray(value?.statuses) ? value.statuses.length : 0;
                accumulator.messages += messageCount;
                accumulator.statuses += statusCount;
                if (messageCount > 0) {
                  accumulator.messageFields.add(String(change?.field || "").trim() || "messages");
                }
                if (statusCount > 0) {
                  accumulator.statusFields.add(String(change?.field || "").trim() || "messages");
                }
              }
              return accumulator;
            },
            { messages: 0, statuses: 0, messageFields: new Set(), statusFields: new Set() },
          )
        : { messages: 0, statuses: 0, messageFields: new Set(), statusFields: new Set() };
      console.log(
        `[meta-webhook] route=${webhookConfig?.routeKey || "default"} path=${url.pathname} object=${String(
          payload?.object || "",
        ).trim() || "unknown"}`,
      );
      await appendMessageDeliveryLog({
        category: "meta-webhook",
        level: "info",
        source: "meta-webhook",
        event: "meta-webhook-received",
        routeKey: webhookConfig?.routeKey || null,
        phoneNumberId: webhookConfig?.phoneNumberId || null,
        message:
          payloadSummary.messages > 0
            ? `Webhook ${webhookConfig?.routeKey || "default"} recebeu ${payloadSummary.messages} mensagem(ns) e ${payloadSummary.statuses} status(es).`
            : `Webhook ${webhookConfig?.routeKey || "default"} recebido sem mensagens de cliente (statuses=${payloadSummary.statuses}).`,
        metadata: {
          path: url.pathname,
          object: String(payload?.object || "").trim() || null,
          messages: payloadSummary.messages,
          statuses: payloadSummary.statuses,
          messageFields: Array.from(payloadSummary.messageFields),
          statusFields: Array.from(payloadSummary.statusFields),
        },
      });
      await handleWebhookPayload(payload, {
        metaConfig: webhookConfig,
        routeKey: webhookConfig?.routeKey || null,
        webhookPath: url.pathname,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Webhook error" }));
    }

    return;
  }

  if (req.method === "POST" && url.pathname === "/api/whatsapp/webhook") {































    setCors(res);































    try {

  const payload = await readJson(req);































      await handleWebhookPayload(payload);































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ status: "ok" }));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Webhook error" }));































    }































    return;































  }































































  if (req.method === "GET" && url.pathname === "/api/inbox/section") {
    setCors(res);
    try {
      const section = String(url.searchParams.get("section") || "attending").trim().toLowerCase();
      const channel = String(url.searchParams.get("channel") || "support").trim().toLowerCase();
      const leadSelection = String(url.searchParams.get("leadSelection") || "lead").trim().toLowerCase();
      const search = String(url.searchParams.get("search") || "");
      const selectedLabelIds = normalizeRequestedLabelIds(url.searchParams.get("selectedLabelIds"));
      const outsideWindowChunks = Math.max(
        0,
        Number.parseInt(String(url.searchParams.get("outsideWindowChunks") || "0"), 10) || 0,
      );

      const [context, labels, contacts, scheduledMessageStore] = await Promise.all([
        loadChannelConversationContext(channel),
        listLabels(),
        listResolvedContacts(),
        readScheduledMessageStore(),
      ]);

      const payload = buildInboxSectionPayload({
        conversations: context.conversations,
        customers: context.painelCustomersList,
        contacts,
        availableLabels: labels,
        section,
        leadSelection,
        search,
        selectedLabelIds,
        outsideWindowChunks,
      });
      const scheduledSummaryIndex = buildScheduledMessageSummaryIndex(scheduledMessageStore?.items);
      payload.items = attachScheduledSummariesToConversations(payload.items, scheduledSummaryIndex);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: error?.message || "Inbox section error" }),
      );
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/whatsapp/conversations") {































    setCors(res);































    try {































      const requestedLabelIds = normalizeRequestedLabelIds(url.searchParams.get("labels"));
      const persistedCustomerRows = await readPersistedCustomerRows();
      const painelCustomers = buildPersistedCustomersObject(persistedCustomerRows);
      if (isConversationSummaryRequest(url.searchParams)) {
        const summaryPayload = await loadSqliteConversationSummaryPage({
          searchParams: url.searchParams,
          painelCustomers,
          requestedLabelIds,
        });
        if (summaryPayload) {
          const payload = JSON.stringify(summaryPayload);
          const etag = createPayloadEtag(
            payload,
            `summary|${getMainStoreRevision()}|page:${summaryPayload.page}|limit:${summaryPayload.limit}|labels:${requestedLabelIds
              .slice()
              .sort()
              .join(",")}`,
          );
          sendJsonPayload(req, res, payload, { etag });
          return;
        }
      }

      const cacheKey = `${getMainStoreRevision()}|persisted:${persistedCustomerRows.length}|${
        persistedCustomerRows[persistedCustomerRows.length - 1]?.synced_at || "0"
      }`;
      let baseConversations = conversationsPayloadCache?.key === cacheKey
        ? conversationsPayloadCache.conversations
        : null;
      if (!Array.isArray(baseConversations)) {
        const store = await readStore({ mutable: false });
        baseConversations = buildConversationListResponse(store, painelCustomers);
        conversationsPayloadCache = { key: cacheKey, conversations: baseConversations, payloads: new Map() };
      }
      if (!(conversationsPayloadCache?.payloads instanceof Map)) {
        conversationsPayloadCache.payloads = new Map();
      }
      const pagination = getOptionalPaginationFromSearchParams(url.searchParams, { defaultLimit: 50, maxLimit: 200 });
      const paginatedConversations = paginateItems(baseConversations, pagination);
      const labelCacheKey = [
        requestedLabelIds.slice().sort().join(",") || "all",
        paginatedConversations.paginated ? `page:${paginatedConversations.page}:limit:${paginatedConversations.limit}` : "full",
      ].join("|");
      let payloadEntry = conversationsPayloadCache.payloads.get(labelCacheKey);
      if (!payloadEntry) {
        const conversations = await enrichConversationsWithLabels(
          paginatedConversations.items,
          painelCustomers,
          requestedLabelIds,
        );
        const payload = JSON.stringify(
          paginatedConversations.paginated
            ? {
                items: conversations,
                page: paginatedConversations.page,
                limit: paginatedConversations.limit,
                total: paginatedConversations.total,
                hasMore: paginatedConversations.hasMore,
              }
            : conversations,
        );
        payloadEntry = {
          payload,
          etag: createPayloadEtag(payload, `${cacheKey}|labels:${labelCacheKey}`),
        };
        setBoundedCacheEntry(conversationsPayloadCache.payloads, labelCacheKey, payloadEntry, 50);
      }
      sendJsonPayload(req, res, payloadEntry.payload, { etag: payloadEntry.etag });
      return;





























































































































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }

    return;

  }

  const conversationDetailMatch =
    req.method === "GET"
      ? url.pathname.match(/^\/api\/whatsapp\/conversations\/([^/]+)$/)
      : null;
  if (conversationDetailMatch) {
    setCors(res);
    try {
      const conversationId = decodeURIComponent(conversationDetailMatch[1] || "");
      const phone = url.searchParams.get("phone") || "";
      const requestedLabelIds = normalizeRequestedLabelIds(url.searchParams.get("labels"));
      const persistedCustomerRows = await readPersistedCustomerRows();
      const painelCustomers = buildPersistedCustomersObject(persistedCustomerRows);
      const items = await loadConversationDetailItems({ conversationId, phone, painelCustomers });
      const conversations = await enrichConversationsWithLabels(items, painelCustomers, requestedLabelIds);
      const payload = JSON.stringify({
        items: conversations,
        conversation: conversations[0] || null,
      });
      const etag = createPayloadEtag(
        payload,
        `detail|${getMainStoreRevision()}|${conversationId}|${normalizePhone(phone)}`,
      );
      sendJsonPayload(req, res, payload, { etag });
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error?.message || "Conversation detail error" }));
    }
    return;
  }

  const labelContactsMatch = url.pathname.match(/^\/api\/labels\/([^/]+)\/contacts$/);
  if (req.method === "GET" && url.pathname === "/api/labels") {
    setCors(res);
    try {
      const labels = await listLabels();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ labels }));
    } catch (error) {
      const status = resolveLabelsHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao carregar etiquetas" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/labels/refresh-defaults") {
    setCors(res);
    try {
      const result = await syncCurrentContactsForLabels({ force: true });
      const labels = await listLabels();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, labels, synced: Boolean(result) }));
    } catch (error) {
      const status = resolveLabelsHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao atualizar etiquetas padrao" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/labels") {
    setCors(res);
    try {
      const body = await readJson(req);
      const label = await createContactLabel({
        name: body?.name,
        color: body?.color,
        visibleInFilter: body?.visibleInFilter,
        campaignConfig: body?.campaignConfig,
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ label }));
    } catch (error) {
      const status = resolveLabelsHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao criar etiqueta" }));
    }
    return;
  }

  if (labelContactsMatch && req.method === "GET") {
    setCors(res);
    try {
      const labelId = decodeURIComponent(labelContactsMatch[1]);
      const result = await listLabelContacts(labelId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      const status = resolveLabelsHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao carregar contatos da etiqueta" }));
    }
    return;
  }

  const labelDispatchMatch = url.pathname.match(/^\/api\/labels\/([^/]+)\/dispatch$/);
  if (labelDispatchMatch && req.method === "POST") {
    setCors(res);
    try {
      const labelId = decodeURIComponent(labelDispatchMatch[1]);
      const body = await readJson(req);
      if (body?.skipSync !== true) {
        await syncCurrentContactsForLabels({ force: true });
      }
      const labels = await listLabels();
      const label = labels.find((item) => String(item?.id || "") === labelId) || null;
      if (!label) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Etiqueta nao encontrada" }));
        return;
      }
      const config = normalizeLabelCampaignConfig(label?.campaignConfig);
      if (!config.metaTemplateName) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Configure o HSM da etiqueta antes de disparar." }));
        return;
      }
      const labelsById = new Map(labels.map((item) => [String(item.id), item]));
      const summary = await executeLabelCampaignDispatch({
        label,
        config: {
          ...config,
          enabled: true,
        },
        labelsById,
        now: new Date(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, summary }));
    } catch (error) {
      const status = resolveLabelsHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao executar disparo da etiqueta" }));
    }
    return;
  }

  const labelMatch = url.pathname.match(/^\/api\/labels\/([^/]+)$/);
  if (labelMatch && req.method === "PUT") {
    setCors(res);
    try {
      const labelId = decodeURIComponent(labelMatch[1]);
      const body = await readJson(req);
      const label = await updateLabelById(labelId, {
        name: body?.name,
        color: body?.color,
        visibleInFilter: body?.visibleInFilter,
        campaignConfig: body?.campaignConfig,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ label }));
    } catch (error) {
      const status = resolveLabelsHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao atualizar etiqueta" }));
    }
    return;
  }

  if (labelMatch && req.method === "DELETE") {
    setCors(res);
    try {
      const labelId = decodeURIComponent(labelMatch[1]);
      await deleteLabelById(labelId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      const status = resolveLabelsHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao remover etiqueta" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/campaigns") {
    setCors(res);
    try {
      const items = await listCampaigns();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao carregar campanhas" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/campaigns") {
    setCors(res);
    try {
      const body = await readJson(req);
      const item = await createCampaignDefinition(body || {});
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ item }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao criar campanha" }));
    }
    return;
  }

  const campaignDispatchMatch = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/dispatch$/);
  if (campaignDispatchMatch && req.method === "POST") {
    setCors(res);
    try {
      const campaignId = decodeURIComponent(campaignDispatchMatch[1]);
      const campaign = await getCampaignById(campaignId);
      if (!campaign) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Campanha nao encontrada" }));
        return;
      }
      if (activeCampaignDispatches.has(String(campaign.id || "").trim())) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Ja existe um disparo em andamento para esta campanha." }));
        return;
      }
      const body = await readJson(req);
      const providedContacts = Array.isArray(body?.contacts) ? body.contacts : [];
      if (body?.background === true) {
        const started = startCampaignDispatchInBackground({
          campaign,
          mode: body?.mode,
          contacts: providedContacts,
          persistRun: body?.persistRun !== false,
          trigger: "manual",
          sendIntervalSeconds: body?.sendIntervalSeconds,
          syncBeforeStart: !providedContacts.length && body?.skipSync !== true,
        });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, accepted: true, dispatchId: started.dispatchId }));
        return;
      }
      if (!providedContacts.length && body?.skipSync !== true) {
        await syncCurrentContactsForLabels({ force: true });
      }
      activeCampaignDispatches.add(String(campaign.id || "").trim());
      let summary;
      let item;
      try {
        ({ summary, item } = await executeCampaignDispatchWithPersistence({
          campaign,
          now: new Date(),
          mode: body?.mode,
          contacts: providedContacts,
          persistRun: body?.persistRun !== false,
          trigger: "manual",
          sendIntervalSeconds: body?.sendIntervalSeconds,
        }));
      } finally {
        activeCampaignDispatches.delete(String(campaign.id || "").trim());
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, summary, item }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao executar campanha" }));
    }
    return;
  }

  const campaignMatch = url.pathname.match(/^\/api\/campaigns\/([^/]+)$/);
  if (campaignMatch && req.method === "PUT") {
    setCors(res);
    try {
      const body = await readJson(req);
      const item = await updateCampaignById(decodeURIComponent(campaignMatch[1]), body || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ item }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao atualizar campanha" }));
    }
    return;
  }

  if (campaignMatch && req.method === "DELETE") {
    setCors(res);
    try {
      await deleteCampaignById(decodeURIComponent(campaignMatch[1]));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao remover campanha" }));
    }
    return;
  }

  const contactLabelsDeleteMatch = url.pathname.match(/^\/api\/contacts\/([^/]+)\/labels\/([^/]+)$/);
  if (contactLabelsDeleteMatch && req.method === "DELETE") {
    setCors(res);
    try {
      const contactId = decodeURIComponent(contactLabelsDeleteMatch[1]);
      const labelId = decodeURIComponent(contactLabelsDeleteMatch[2]);
      const labels = await withContactLabelsRetry(() => removeContactLabelsById(contactId, [labelId]));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ labels }));
    } catch (error) {
      const status = resolveLabelsHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao remover etiqueta do contato" }));
    }
    return;
  }

  const contactLabelsMatch = url.pathname.match(/^\/api\/contacts\/([^/]+)\/labels$/);
  if (contactLabelsMatch && req.method === "GET") {
    setCors(res);
    try {
      const contactId = decodeURIComponent(contactLabelsMatch[1]);
      const labels = await withContactLabelsRetry(() => getContactLabelsById(contactId));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ labels }));
    } catch (error) {
      const status = resolveLabelsHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao carregar etiquetas do contato" }));
    }
    return;
  }

  if (contactLabelsMatch && (req.method === "POST" || req.method === "PUT")) {
    setCors(res);
    try {
      const contactId = decodeURIComponent(contactLabelsMatch[1]);
      const body = await readJson(req);
      let nextLabelIds = [];
      if (req.method === "POST") {
        const requestedIds = normalizeRequestedLabelIds(
          Array.isArray(body?.labelIds) ? body.labelIds : body?.labelId,
        );
        const labels = await withContactLabelsRetry(() => addContactLabelsById(contactId, requestedIds));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ labels }));
        return;
      } else {
        nextLabelIds = normalizeRequestedLabelIds(body?.labelIds);
      }
      const labels = await withContactLabelsRetry(() => replaceContactManualLabels(contactId, nextLabelIds));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ labels }));
    } catch (error) {
      const status = resolveLabelsHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao atualizar etiquetas do contato" }));
    }
    return;
  }

  const flowMatch = url.pathname.match(/^\/api\/flows\/([^/]+)$/);
  if (req.method === "GET" && url.pathname === "/api/flows") {
    setCors(res);
    try {
      await ensureFlowStoreReady();
      const flows = await listFlows();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ flows }));
    } catch (error) {
      const status = resolveFlowHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao carregar fluxos" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/flows") {
    setCors(res);
    try {
      const body = await readJson(req);
      const flow = await createFlow(body || {});
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ flow }));
    } catch (error) {
      const status = resolveFlowHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao criar fluxo" }));
    }
    return;
  }

  if (flowMatch && req.method === "PUT") {
    setCors(res);
    try {
      const body = await readJson(req);
      const flowId = decodeURIComponent(flowMatch[1]);
      const flow = await updateFlowById(flowId, body || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ flow }));
    } catch (error) {
      const status = resolveFlowHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao atualizar fluxo" }));
    }
    return;
  }

  if (flowMatch && req.method === "DELETE") {
    setCors(res);
    try {
      const flowId = decodeURIComponent(flowMatch[1]);
      await deleteFlowById(flowId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      const status = resolveFlowHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao remover fluxo" }));
    }
    return;
  }

  const conversationFlowStateMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/flow-state$/);
  if (conversationFlowStateMatch && req.method === "GET") {
    setCors(res);
    try {
      const conversationId = decodeURIComponent(conversationFlowStateMatch[1]);
      const waId = String(url.searchParams.get("waId") || "").trim();
      const state = await getConversationFlowState({ conversationId, waId });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
    } catch (error) {
      const status = resolveFlowHttpStatus(error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Falha ao carregar estado do fluxo" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/plustv/metrics") {
    setCors(res);
    try {
      const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
      const scope = normalizePlusTvMetricsScope(url.searchParams.get("scope"));
      const payload = await buildPlusTvMetricsPayload({ force, scope });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (error) {
      const scope = normalizePlusTvMetricsScope(url.searchParams.get("scope"));
      const fallbackPayload = await readPlusTvMetricsDiskCache(error, scope).catch((cacheError) => {
        console.warn(`[plustv-metrics] falha ao ler cache em disco: ${cacheError?.message || cacheError}`);
        return null;
      });
      if (fallbackPayload) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(fallbackPayload));
        return;
      }
      const status = Number(error?.status || 500);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        error: error?.message || "Falha ao carregar metricas +TV.",
        raw: error?.payload || null,
      }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/plustv/metrics/browser") {
    setCors(res);
    try {
      const body = await readJson(req);
      const raw = body?.raw && typeof body.raw === "object" ? body.raw : body;
      const scopeConfig = getPlusTvMetricsScopeConfig(body?.scope || raw?.scope);
      const customersAll = raw?.customersAll && typeof raw.customersAll === "object" ? raw.customersAll : {};
      if (!raw?.customersCount || !raw?.newCustomers || !Array.isArray(customersAll.rows)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Payload de metricas +TV incompleto." }));
        return;
      }
      const payload = buildPlusTvMetricsPayloadFromRaw({
        customersCount: raw.customersCount,
        newCustomers: raw.newCustomers,
        customersAll,
        version: "2026-04-25-browser-v1",
        source: "browser-newbr",
        scope: scopeConfig.scope,
        customerReseller: body?.customerReseller || raw?.customerReseller || (scopeConfig.scope === "sales" ? scopeConfig.reseller : ""),
      });
      const persistedPayload = await persistPlusTvMetricsDiskCache(payload, scopeConfig.scope);
      plustvMetricsCache[scopeConfig.scope] = {
        expiresAt: Date.now() + Math.max(0, PLUSTV_METRICS_CACHE_MS),
        payload: persistedPayload,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...persistedPayload,
        cacheExpiresAt: new Date(plustvMetricsCache[scopeConfig.scope].expiresAt).toISOString(),
      }));
    } catch (error) {
      const status = Number(error?.status || 500);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        error: error?.message || "Falha ao salvar metricas +TV coletadas pelo navegador.",
      }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/whatsapp/send-document") {
    setCors(res);
    try {
      const payload = await readJson(req);
      const { to, documentBase64, mimetype, filename, caption, contextMessageId, replyTo, origin, agentName, senderName, clientMessageId } = payload;
      const metaSelector = {};
      if (!to || !documentBase64) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'to' or 'documentBase64'" }));
        return;
      }
      const normalizedTo = normalizePhone(to) || String(to || "").trim();
      const safeFilename = String(filename || "documento").trim() || "documento";
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-document",
        event: "send-document-requested",
        to: normalizedTo || null,
        message: `Tentativa de envio de documento para ${normalizedTo || "-"}.`,
      });

      const decoded = decodeBase64Payload({
        base64Value: documentBase64,
        mimeType: mimetype,
        fallbackMimeType: "application/octet-stream",
      });
      const ext = mimeToExtension(decoded.mimeType, "bin");
      const mediaId = await uploadMediaToMeta({
        to: normalizedTo,
        buffer: decoded.buffer,
        mimeType: decoded.mimeType,
        filename: `${safeFilename.replace(/\.[^/.]+$/, "") || "documento"}-${Date.now()}.${ext}`,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });
      const result = await sendMediaMessage({
        to: normalizedTo,
        mediaType: "document",
        mediaId,
        caption,
        filename: safeFilename,
        contextMessageId,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });

      const responseMessageId = result?.messages?.[0]?.id;
      await upsertAgentMessage({
        to: normalizePhone(to) || to,
        text: caption || safeFilename || "[document]",
        messageId: responseMessageId,
        clientMessageId,
        replyToId: contextMessageId,
        attachments: [{
          id: mediaId,
          type: "document",
          url: resolveMediaProxyUrl(mediaId),
          mimeType: decoded.mimeType,
          name: safeFilename,
        }],
        replyTo,
        origin: origin || "panel",
        senderName: senderName || agentName || null,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId || result?.__metaConfig?.phoneNumberId || null,
        displayPhoneNumber:
          metaSelector.displayPhoneNumber || result?.__metaConfig?.displayPhoneNumber || null,
        wabaId: result?.__metaConfig?.wabaId || null,
      });

      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-document",
        event: "send-document-success",
        to: normalizedTo || null,
        messageId: responseMessageId || null,
        message: `Documento enviado para ${normalizedTo || "-"}.`,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "error",
        source: "send-document",
        event: "send-document-failed",
        message: `Falha ao enviar documento: ${error?.message || "erro desconhecido"}`,
        errorReason: error?.message || "erro desconhecido",
      });
      setCors(res);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Server error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/whatsapp/send-video") {
    setCors(res);
    try {
      const payload = await readJson(req);
      const { to, videoBase64, mimetype, filename, caption, contextMessageId, replyTo, origin, agentName, senderName, clientMessageId } = payload;
      const metaSelector = resolveRequestedMetaSelector(req, payload);
      if (!to || !videoBase64) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'to' or 'videoBase64'" }));
        return;
      }
      const normalizedTo = normalizePhone(to) || String(to || "").trim();
      const safeFilename = String(filename || "video").trim() || "video";
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-video",
        event: "send-video-requested",
        to: normalizedTo || null,
        message: `Tentativa de envio de video para ${normalizedTo || "-"}.`,
      });

      const decoded = decodeBase64Payload({
        base64Value: videoBase64,
        mimeType: mimetype,
        fallbackMimeType: "video/mp4",
      });
      const preparedVideo = await prepareVideoUpload({
        buffer: decoded.buffer,
        mimeType: decoded.mimeType,
      });
      const mediaId = await uploadMediaToMeta({
        to: normalizedTo,
        buffer: preparedVideo.buffer,
        mimeType: preparedVideo.mimeType,
        filename: `${safeFilename.replace(/\.[^/.]+$/, "") || "video"}-${Date.now()}.${preparedVideo.extension}`,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });
      const result = await sendMediaMessage({
        to: normalizedTo,
        mediaType: "video",
        mediaId,
        caption,
        contextMessageId,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });

      const responseMessageId = result?.messages?.[0]?.id;
      await upsertAgentMessage({
        to: normalizePhone(to) || to,
        text: caption || safeFilename || "[video]",
        messageId: responseMessageId,
        clientMessageId,
        replyToId: contextMessageId,
        attachments: [{
          id: mediaId,
          type: "video",
          url: resolveMediaProxyUrl(mediaId),
          mimeType: preparedVideo.mimeType,
          name: safeFilename,
        }],
        replyTo,
        origin: origin || "panel",
        senderName: senderName || agentName || null,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId || result?.__metaConfig?.phoneNumberId || null,
        displayPhoneNumber:
          metaSelector.displayPhoneNumber || result?.__metaConfig?.displayPhoneNumber || null,
        wabaId: result?.__metaConfig?.wabaId || null,
      });

      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-video",
        event: "send-video-success",
        to: normalizedTo || null,
        messageId: responseMessageId || null,
        message: `Video enviado para ${normalizedTo || "-"}.`,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "error",
        source: "send-video",
        event: "send-video-failed",
        message: `Falha ao enviar video: ${error?.message || "erro desconhecido"}`,
        errorReason: error?.message || "erro desconhecido",
      });
      setCors(res);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Server error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/whatsapp/send-interactive") {
    setCors(res);
    try {
      const payload = await readJson(req);
      const {
        to,
        text,
        header,
        footer,
        buttons,
        buttonText,
        rows,
        contextMessageId,
        replyTo,
        origin,
        agentName,
        senderName,
      } = payload;
      const metaSelector = resolveRequestedMetaSelector(req, payload);
      const hasButtons = Array.isArray(buttons) && buttons.length > 0;
      const hasRows = Array.isArray(rows) && rows.length > 0;
      if (!to || (!hasButtons && !hasRows)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'to' or interactive options" }));
        return;
      }

      const normalizedTo = normalizePhone(to) || String(to || "").trim();
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-interactive",
        event: "send-interactive-requested",
        to: normalizedTo || null,
        message: `Tentativa de envio interativo para ${normalizedTo || "-"}.`,
      });

      const result = await sendInteractiveMessage({
        to: normalizedTo,
        text,
        header,
        footer,
        buttons,
        buttonText,
        rows,
        contextMessageId,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });

      const responseMessageId = result?.messages?.[0]?.id;
      const previewText = buildFlowOutputPreviewText({
        type: hasButtons ? "interactive_buttons" : "interactive_list",
        text,
        buttons,
        rows,
        buttonText,
      }) || String(text || "[interativo]").trim();
      await upsertAgentMessage({
        to: normalizedTo,
        text: previewText,
        messageId: responseMessageId,
        attachments: [],
        replyTo,
        origin: origin || "panel",
        senderName: senderName || agentName || null,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId || result?.__metaConfig?.phoneNumberId || null,
        displayPhoneNumber:
          metaSelector.displayPhoneNumber || result?.__metaConfig?.displayPhoneNumber || null,
        wabaId: result?.__metaConfig?.wabaId || null,
      });

      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-interactive",
        event: "send-interactive-success",
        to: normalizedTo || null,
        messageId: responseMessageId || null,
        message: `Mensagem interativa enviada para ${normalizedTo || "-"}.`,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "error",
        source: "send-interactive",
        event: "send-interactive-failed",
        message: `Falha ao enviar mensagem interativa: ${error?.message || "erro desconhecido"}`,
        errorReason: error?.message || "erro desconhecido",
      });
      setCors(res);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Server error" }));
    }
    return;
  }




















































































  if (req.method === "GET" && url.pathname === "/api/whatsapp/session") {































    setCors(res);































    try {































      const store = await readStore();































      const assignedUserId = store.session?.assignedUserId ?? null;































      if (BAILEYS_API_URL) {































        const data = await fetchBaileysSession();































        res.writeHead(200, { "Content-Type": "application/json" });































        res.end(































          JSON.stringify({































            ...data,































            assignedUserId,































          }),































        );































        return;































      }































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(































        JSON.stringify({































          connected: false,
          qr: null,
          lastQrAt: null,
          assignedUserId,
          error: "Baileys API URL not configured",































        }),































      );































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































  if (req.method === "POST" && url.pathname === "/api/whatsapp/session/assign") {































    setCors(res);































    try {































      const { userId } = await readJson(req);































      const store = await readStore();































      store.session = {































        assignedUserId: userId ? String(userId) : null,































      };































      await writeStore(store, { conversationIds });































































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ status: "ok", assignedUserId: store.session.assignedUserId }));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































  if (req.method === "GET" && url.pathname === "/api/whatsapp/coexistencia") {































    setCors(res);































    try {































      const metaSelector = resolveRequestedMetaSelector(req);
      const resolvedConfig = await resolveSelectedMetaConfig({
        routeKey: metaSelector.routeKey,
        allowFallback: true,
      });
      const config = resolvedConfig?.coex || (await readCoexConfig());































      const accessToken = resolvedConfig?.accessToken || ACCESS_TOKEN || config.accessToken || null;































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(































        JSON.stringify({































          updatedAt: config.updatedAt,































          wabaId: resolvedConfig?.wabaId || config.wabaId,































          phoneNumberId: resolvedConfig?.phoneNumberId || config.phoneNumberId,































          displayPhoneNumber: resolvedConfig?.displayPhoneNumber || config.displayPhoneNumber,
          routeKey: resolvedConfig?.routeKey || null,































          hasAccessToken: Boolean(accessToken),































          maskedAccessToken: maskToken(accessToken),































          sync: config.sync || {},































        }),































      );































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































  if (req.method === "POST" && url.pathname === "/api/whatsapp/coexistencia") {































    setCors(res);































    try {

  const payload = await readJson(req);































      const config = await readCoexConfig();































      const next = { ...config };































      if ("wabaId" in payload) {































        next.wabaId = payload.wabaId ? String(payload.wabaId).trim() : null;































      }































      if ("phoneNumberId" in payload) {































        next.phoneNumberId = payload.phoneNumberId ? String(payload.phoneNumberId).trim() : null;































      }































      if ("displayPhoneNumber" in payload) {































        next.displayPhoneNumber = payload.displayPhoneNumber ? String(payload.displayPhoneNumber).trim() : null;































      }































      if ("accessToken" in payload) {































        next.accessToken = payload.accessToken ? String(payload.accessToken).trim() : null;































      }































      next.updatedAt = nowIso();































      await writeCoexConfig(next);































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(































        JSON.stringify({































          status: "ok",































          updatedAt: next.updatedAt,































          wabaId: next.wabaId,































          phoneNumberId: next.phoneNumberId,































          displayPhoneNumber: next.displayPhoneNumber,































          hasAccessToken: Boolean(ACCESS_TOKEN || next.accessToken),































        }),































      );































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































  if (req.method === "GET" && url.pathname === "/api/whatsapp/coexistencia/status") {































    setCors(res);































    try {































      const metaSelector = resolveRequestedMetaSelector(req);
      const { accessToken, phoneNumberId } = await resolveSelectedMetaConfig({
        routeKey: metaSelector.routeKey,
        allowFallback: true,
      });































      if (!accessToken || !phoneNumberId) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing WhatsApp access token or phone number id" }));































        return;































      }































      const response = await fetch(































        `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}?fields=is_on_biz_app,platform_type`,































        {































          method: "GET",































          headers: {































            Authorization: `Bearer ${accessToken}`,































          },































        },































      );































      const data = await response.json();































      if (!response.ok) {































        const errorMessage = data?.error?.message || "WhatsApp status error";































        throw new Error(errorMessage);































      }































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify(data));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































  if (req.method === "POST" && url.pathname === "/api/whatsapp/coexistencia/sync") {































    setCors(res);































    try {































      const { syncType } = await readJson(req);































      if (!["smb_app_state_sync", "history"].includes(syncType)) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Invalid syncType" }));































        return;































      }































      const metaSelector = resolveRequestedMetaSelector(req);
      const { accessToken, phoneNumberId, coex } = await resolveSelectedMetaConfig({
        routeKey: metaSelector.routeKey,
        allowFallback: true,
      });































      if (!accessToken || !phoneNumberId) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing WhatsApp access token or phone number id" }));































        return;































      }































      const response = await fetch(































        `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/smb_app_data`,































        {































          method: "POST",































          headers: {































            Authorization: `Bearer ${accessToken}`,































            "Content-Type": "application/json",































          },































          body: JSON.stringify({































            messaging_product: "whatsapp",































            sync_type: syncType,































          }),































        },































      );































      const data = await response.json();































      if (!response.ok) {































        const errorMessage = data?.error?.message || "WhatsApp sync error";































        throw new Error(errorMessage);































      }































      const updated = {































        ...coex,































        updatedAt: nowIso(),































        sync: {































          ...coex.sync,































          lastRequestId: data?.request_id || coex.sync?.lastRequestId || null,































          lastError: null,































          contactsRequestedAt: syncType === "smb_app_state_sync" ? nowIso() : coex.sync?.contactsRequestedAt || null,































          historyRequestedAt: syncType === "history" ? nowIso() : coex.sync?.historyRequestedAt || null,































        },































      };































      await writeCoexConfig(updated);































































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify(data));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































  if (req.method === "POST" && url.pathname === "/api/whatsapp/conversations/mark-read") {

    setCors(res);

    try {

      const { conversationIds } = await readJson(req);

      if (!Array.isArray(conversationIds) || conversationIds.length === 0) {

        res.writeHead(400, { "Content-Type": "application/json" });

        res.end(JSON.stringify({ error: "Missing conversationIds" }));

        return;

      }

      const store = await readStore();

      let count = 0;

      conversationIds.forEach((id) => {

        const conversation = store.conversations?.[id];

        if (!conversation) return;

        conversation.unreadCount = 0;
        conversation.unread_count = 0;
        conversation.last_read_at = nowIso();
        const flags = resolveConversationFlags(conversation);
        conversation.is_in_attendance = flags.is_in_attendance;
        conversation.is_pending = flags.is_pending;
        conversation.is_broadcast = flags.is_broadcast;

        const messages = store.messages?.[id] || [];

        store.messages = store.messages || {};

        store.messages[id] = messages.map((message) =>

          message.isRead ? message : { ...message, isRead: true },

        );

        count += 1;

      });

      await writeStore(store, { conversationIds });

      res.writeHead(200, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ ok: true, count }));

    } catch (error) {

      res.writeHead(500, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ error: error.message || "Server error" }));

    }

    return;

  }

  if (req.method === "POST" && url.pathname === "/api/whatsapp/conversations/delete") {































    setCors(res);































    try {































      const { conversationId } = await readJson(req);































      if (!conversationId) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing 'conversationId'" }));































        return;































      }































































      const store = await readStore();































      const deleted = deleteConversationFromStore(store, conversationId);































      await writeStore(store, { conversationIds: [conversationId] });































































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ status: "ok", deleted }));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































    const transcriptionMatch = url.pathname.match(/^\/api\/whatsapp\/messages\/([^/]+)\/transcription$/);
  if (req.method === "GET" && transcriptionMatch) {
    setCors(res);
    try {
      const messageId = decodeURIComponent(transcriptionMatch[1] || "");
      const identifiers = String(url.searchParams.get("identifiers") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const { location, message } = await getStoreMessageByIdentifier(messageId, {
        mutable: false,
        conversationId: url.searchParams.get("conversationId"),
        sourceConversationId: url.searchParams.get("sourceConversationId"),
        identifiers,
      });
      if (!location || !message) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Mensagem nao encontrada" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        conversationId: location.conversationId,
        messageId,
        transcription: getAudioTranscriptionStatus(message),
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error?.message || "Erro ao consultar transcricao" }));
    }
    return;
  }

  const transcribeMatch = url.pathname.match(/^\/api\/whatsapp\/messages\/([^/]+)\/transcribe$/);
  if (req.method === "POST" && transcribeMatch) {
    setCors(res);
    try {
      const messageId = decodeURIComponent(transcribeMatch[1] || "");
      const payload = await readJson(req);
      const force = parseBooleanEnv(payload?.force, false);
      const lookup = {
        conversationId: payload?.conversationId,
        sourceConversationId: payload?.sourceConversationId,
        identifiers: payload?.identifiers,
      };
      const { location, message } = await getStoreMessageByIdentifier(messageId, {
        mutable: false,
        ...lookup,
      });
      if (!location || !message) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Mensagem nao encontrada" }));
        return;
      }
      const existing = getAudioTranscriptionStatus(message);
      if (existing.status === "processing" && isProcessingTranscriptionFresh(message.transcription) && !force) {
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          conversationId: location.conversationId,
          messageId,
          transcription: existing,
        }));
        return;
      }
      const startedAt = new Date().toISOString();
      const processingTranscription = {
        status: "processing",
        text: existing.text || "",
        error: "",
        model: process.env.WHISPER_MODEL || "tiny",
        language: process.env.WHISPER_LANGUAGE || "pt",
        startedAt,
        updatedAt: startedAt,
      };
      await persistMessageTranscription({ messageId, transcription: processingTranscription, lookup });
      startAudioTranscriptionJob({
        message,
        messageId,
        force,
        lookup,
      });
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        conversationId: location.conversationId,
        messageId,
        transcription: processingTranscription,
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error?.message || "Erro ao transcrever audio" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/whatsapp/media") {
    setCors(res);
    try {
      const mediaId = url.searchParams.get("id");
      if (!mediaId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing media id" }));
        return;
      }
      const cachedMedia = getCachedMediaProxyPayload(mediaId);
      if (cachedMedia) {
        res.writeHead(200, {
          "Content-Type": cachedMedia.mimeType || "application/octet-stream",
          "Cache-Control": "private, max-age=300",
          "X-SaaSTV-Media-Cache": "hit",
        });
        res.end(cachedMedia.buffer);
        return;
      }
      const { accessToken } = await resolveMetaConfig();
      if (!accessToken) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing WhatsApp access token" }));
        return;
      }
      const metaResponse = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${mediaId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );
      if (!metaResponse.ok) {
        const text = await metaResponse.text();
        res.writeHead(metaResponse.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to fetch media metadata", details: text }));
        return;
      }
      const meta = await metaResponse.json();
      const mediaUrl = meta?.url;
      const mimeType = meta?.mime_type || "application/octet-stream";
      if (!mediaUrl) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Media URL not available" }));
        return;
      }
      const mediaResponse = await fetch(mediaUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!mediaResponse.ok) {
        const text = await mediaResponse.text();
        res.writeHead(mediaResponse.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to download media", details: text }));
        return;
      }
      const buffer = Buffer.from(await mediaResponse.arrayBuffer());
      setCachedMediaProxyPayload({ mediaId, mimeType, buffer });
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Cache-Control": "private, max-age=300",
        "X-SaaSTV-Media-Cache": "miss",
      });
      res.end(buffer);
    } catch (error) {
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "error",
        source: "media-proxy",
        event: "media-proxy-failed",
        message: `Falha no proxy de midia: ${error?.message || "erro desconhecido"}`,
        errorReason: error?.message || "erro desconhecido",
      });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error?.message || "Media proxy error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/whatsapp/scheduled-messages") {
    setCors(res);
    try {
      const conversationId = String(url.searchParams.get("conversationId") || "").trim();
      const store = await readScheduledMessageStore();
      const items = (Array.isArray(store.items) ? store.items : [])
        .filter((item) => !conversationId || item.conversationId === conversationId)
        .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error?.message || "Server error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/whatsapp/scheduled-messages") {
    setCors(res);
    try {
      const payload = await readJson(req);
      const item = normalizeScheduledMessageItem(payload);
      if (!item.conversationId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing conversationId" }));
        return;
      }
      if (!item.to) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing destination phone" }));
        return;
      }
      if (!item.date || !item.time) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing date or time" }));
        return;
      }
      const store = await readScheduledMessageStore();
      store.items.push(item);
      await writeScheduledMessageStore(store);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ item }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error?.message || "Server error" }));
    }
    return;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/whatsapp/scheduled-messages/")) {
    setCors(res);
    try {
      const id = decodeURIComponent(url.pathname.split("/").pop() || "");
      const payload = await readJson(req);
      const store = await readScheduledMessageStore();
      const index = store.items.findIndex((item) => item.id === id);
      if (index < 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Scheduled message not found" }));
        return;
      }
      const existing = store.items[index];
      const item = normalizeScheduledMessageItem({
        ...existing,
        ...payload,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
        status: "scheduled",
        error: null,
        lastRunAt: existing.lastRunAt,
      });
      if (!item.conversationId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing conversationId" }));
        return;
      }
      if (!item.to) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing destination phone" }));
        return;
      }
      if (!item.date || !item.time) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing date or time" }));
        return;
      }
      store.items[index] = item;
      await writeScheduledMessageStore(store);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ item }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error?.message || "Server error" }));
    }
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/whatsapp/scheduled-messages/")) {
    setCors(res);
    try {
      const id = decodeURIComponent(url.pathname.split("/").pop() || "");
      const store = await readScheduledMessageStore();
      const before = store.items.length;
      store.items = store.items.filter((item) => item.id !== id);
      const deleted = before !== store.items.length;
      if (deleted) {
        await writeScheduledMessageStore(store);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ deleted }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error?.message || "Server error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/whatsapp/history/messages") {
    setCors(res);
    try {
      const conversationId = String(url.searchParams.get("conversationId") || "").trim();
      const phoneRaw = String(url.searchParams.get("phone") || "").trim();
      const untilRaw = String(url.searchParams.get("until") || "").trim();
      const tailRaw = Number.parseInt(String(url.searchParams.get("tail") || "1000"), 10);
      const windowDaysRaw = Number.parseInt(String(url.searchParams.get("windowDays") || "7"), 10);
      const tail = Number.isFinite(tailRaw) ? Math.max(20, Math.min(2000, tailRaw)) : 1000;
      const windowDays = Number.isFinite(windowDaysRaw) ? Math.max(1, Math.min(31, windowDaysRaw)) : 7;

      let phone = phoneRaw.replace(/\D/g, "");
      if (!phone && conversationId) {
        const readOnlyStore = await readStore({ mutable: false });
        const conversation = readOnlyStore.conversations?.[conversationId] || null;
        phone = String(
          conversation?.contact_phone ||
            conversation?.phone ||
            conversation?.customer?.phone ||
            "",
        ).replace(/\D/g, "");
      }

      if (!phone && !conversationId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing phone or conversationId" }));
        return;
      }

      const historyResult = queryWhatsappHistoryMessages({
        phone,
        conversationId,
        until: untilRaw,
        limit: tail,
        windowDays,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(historyResult));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Server error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/whatsapp/messages") {































    setCors(res);































    try {































      const conversationId = url.searchParams.get("conversationId");
      const tailRaw = Number.parseInt(String(url.searchParams.get("tail") || "0"), 10);
      const sinceRaw = String(url.searchParams.get("since") || "").trim();
      const untilRaw = String(url.searchParams.get("until") || "").trim();
      const markRead = String(url.searchParams.get("markRead") || "").trim() === "1";
      const tail = Number.isFinite(tailRaw) && tailRaw > 0
        ? Math.max(20, Math.min(2000, tailRaw))
        : 0;
      const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
      const untilMs = untilRaw ? Date.parse(untilRaw) : NaN;































      if (!conversationId) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing 'conversationId'" }));































        return;































      }































































      let usedSqliteDirectRead = false;
      let storedMessages = [];
      let filteredMessages = [];
      let existingConversation = null;

      if (isWhatsappSqliteStoreEnabled()) {
        const [sqliteConversation, sqliteMessages] = await Promise.all([
          getWhatsappSqliteConversation(conversationId, { fallbackLoader: loadLegacyWhatsappStore }),
          listWhatsappSqliteMessages(conversationId, {
            tail,
            sinceMs,
            untilMs,
            fallbackLoader: loadLegacyWhatsappStore,
          }),
        ]);
        if (Array.isArray(sqliteMessages)) {
          usedSqliteDirectRead = true;
          existingConversation = sqliteConversation;
          storedMessages = sqliteMessages;
          filteredMessages = sqliteMessages;
        }
      }

      if (!usedSqliteDirectRead) {
        const readOnlyStore = await readStore({ mutable: false });
        storedMessages = readOnlyStore.messages?.[conversationId] || [];
        filteredMessages =
          Number.isFinite(sinceMs) || Number.isFinite(untilMs)
            ? storedMessages.filter((message) => {
                const timestampMs = toTimeMs(message?.timestamp);
                if (Number.isFinite(sinceMs) && timestampMs < sinceMs) return false;
                if (Number.isFinite(untilMs) && timestampMs >= untilMs) return false;
                return true;
              })
            : storedMessages;
        existingConversation = readOnlyStore.conversations?.[conversationId];
      }

      const currentUnread = existingConversation
        ? Number(existingConversation.unreadCount || existingConversation.unread_count || 0)
        : 0;
      const hadUnreadMessages = currentUnread > 0;

      let responseMessages = [];
      if (tail > 0 && filteredMessages.length > tail) {
        // Fast path for atendimento: render only most recent chunk without sorting full history.
        const windowSize = Math.min(filteredMessages.length, Math.max(tail * 2, tail));
        const recentWindow = filteredMessages.slice(-windowSize);
        const sortedWindow = isMessagesChronological(recentWindow)
          ? recentWindow
          : [...recentWindow].sort((a, b) => toTimeMs(a?.timestamp) - toTimeMs(b?.timestamp));
        responseMessages =
          sortedWindow.length > tail ? sortedWindow.slice(-tail) : sortedWindow;
      } else {
        const sortedMessages = filteredMessages === storedMessages
          ? getSortedMessages(conversationId, storedMessages)
          : [...filteredMessages].sort((a, b) => toTimeMs(a?.timestamp) - toTimeMs(b?.timestamp));
        responseMessages =
          tail > 0 && sortedMessages.length > tail
            ? sortedMessages.slice(-tail)
            : sortedMessages;
      }

      if (hadUnreadMessages) {
        responseMessages = responseMessages.map((message) =>
          message.isRead ? message : { ...message, isRead: true },
        );
      }

      const messageListSignature = buildMessageListSignature(responseMessages);
      const payloadCacheKey = `${conversationId}|tail=${tail || 0}|since=${sinceRaw}|until=${untilRaw}`;

      let payload = "";
      if (!hadUnreadMessages) {
        const cachedPayload = messageResponsePayloadCache.get(payloadCacheKey);
        if (cachedPayload?.signature === messageListSignature) {
          payload = cachedPayload.payload;
        }
      }

      if (!payload) {
        payload = JSON.stringify(responseMessages);
        if (!hadUnreadMessages) {
          setBoundedCacheEntry(
            messageResponsePayloadCache,
            payloadCacheKey,
            {
              signature: messageListSignature,
              payload,
            },
            messageResponsePayloadCacheMaxEntries,
          );
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);

      if (markRead && (hadUnreadMessages || currentUnread > 0)) {
        if (usedSqliteDirectRead && isWhatsappSqliteStoreEnabled()) {
          const flags = existingConversation ? resolveConversationFlags(existingConversation) : null;
          void markWhatsappSqliteConversationRead(conversationId, {
            readAt: nowIso(),
            conversationPatch: flags
              ? {
                  is_in_attendance: flags.is_in_attendance,
                  is_pending: flags.is_pending,
                  is_broadcast: flags.is_broadcast,
                }
              : null,
            fallbackLoader: loadLegacyWhatsappStore,
          })
            .then((changed) => {
              if (changed) {
                invalidateMainStoreAfterDirectPersistence();
              }
            })
            .catch((persistError) => {
              console.error(
                "[messages] falha ao persistir leitura:",
                persistError?.message || persistError,
              );
            });
        } else {
          const store = await readStore();
          let shouldPersist = false;

          const writableConversation = store.conversations?.[conversationId];
          if (writableConversation) {
            if (currentUnread > 0) {
              writableConversation.unreadCount = 0;
              writableConversation.unread_count = 0;
              shouldPersist = true;
            }
            writableConversation.last_read_at = nowIso();
            const flags = resolveConversationFlags(writableConversation);
            writableConversation.is_in_attendance = flags.is_in_attendance;
            writableConversation.is_pending = flags.is_pending;
            writableConversation.is_broadcast = flags.is_broadcast;
            shouldPersist = true;
          }

          if (hadUnreadMessages) {
            const writableMessages = Array.isArray(store.messages?.[conversationId])
              ? store.messages[conversationId]
              : [];
            if (writableMessages.length > 0) {
              store.messages = store.messages || {};
              store.messages[conversationId] = writableMessages.map((message) =>
                message.isRead ? message : { ...message, isRead: true },
              );
              shouldPersist = true;
            }
          }

          if (shouldPersist) {
            // Nao bloqueia a resposta do operador; persiste em background.
            void writeStore(store, { conversationIds: [conversationId] }).catch((persistError) => {
              console.error(
                "[messages] falha ao persistir leitura:",
                persistError?.message || persistError,
              );
            });
          }
        }
      }































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































    if (req.method === "GET" && url.pathname === "/api/ui/preferences") {

    setCors(res);

    try {

      const data = await readUiPreferencesStore();

      res.writeHead(200, { "Content-Type": "application/json" });

      res.end(JSON.stringify(data));

    } catch (error) {

      res.writeHead(500, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ error: error.message || "Server error" }));

    }

    return;

  }

  if (req.method === "POST" && url.pathname === "/api/ui/preferences") {

    setCors(res);

    try {

      const payload = await readJson(req);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid payload" }));
        return;
      }
      const data = await patchUiPreferencesStore(payload);

      res.writeHead(200, { "Content-Type": "application/json" });

      res.end(JSON.stringify(data));

    } catch (error) {

      res.writeHead(400, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ error: error.message || "Server error" }));

    }

    return;

  }

    if (req.method === "GET" && url.pathname === "/api/quick-replies") {

    setCors(res);

    try {

      const items = await listQuickReplies();

      res.writeHead(200, { "Content-Type": "application/json" });

      res.end(JSON.stringify(items));

    } catch (error) {

      res.writeHead(500, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ error: error.message || "Server error" }));

    }

    return;

  }



  if (req.method === "POST" && url.pathname === "/api/quick-replies") {

    setCors(res);

    try {

      const payload = await readJson(req);

      if (Array.isArray(payload?.items)) {

        const normalized = payload.items.map((item) => normalizeQuickReply(item));

        await writeQuickRepliesStore({ items: normalized });

        res.writeHead(200, { "Content-Type": "application/json" });

        res.end(JSON.stringify({ items: normalized }));

        return;

      }

      const item = await upsertQuickReplyStore(payload);

      res.writeHead(200, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ item }));

    } catch (error) {

      res.writeHead(400, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ error: error.message || "Server error" }));

    }

    return;

  }



  if (req.method === "POST" && url.pathname === "/api/quick-replies/delete") {

    setCors(res);

    try {

      const { id } = await readJson(req);

      if (!id) {

        res.writeHead(400, { "Content-Type": "application/json" });

        res.end(JSON.stringify({ error: "Missing id" }));

        return;

      }

      const ok = await deleteQuickReplyStore(id);

      res.writeHead(200, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ ok }));

    } catch (error) {

      res.writeHead(500, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ error: error.message || "Server error" }));

    }

    return;

  }

  if (req.method === "POST" && url.pathname === "/api/whatsapp/templates/local/media/upload") {

    setCors(res);

    try {

      const payload = await readJson(req);
      const saved = await persistTemplateMediaFromPayload(payload);
      const mediaUrl = buildTemplateMediaPublicUrl(req, saved.fileName);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          fileName: saved.fileName,
          mimeType: saved.mimeType,
          size: saved.size,
          url: mediaUrl,
        }),
      );

    } catch (error) {

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Template media upload error" }));

    }

    return;

  }

  const templateMediaMatch =
    req.method === "GET"
      ? url.pathname.match(/^\/api\/whatsapp\/templates\/local\/media\/([a-zA-Z0-9._-]+)$/)
      : null;
  if (templateMediaMatch) {

    setCors(res);

    try {
      const fileName = decodeRouteSegment(templateMediaMatch[1]);
      if (!fileName) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing media file name" }));
        return;
      }
      const fullPath = path.resolve(templateMediaDirPath, fileName);
      if (!fullPath.startsWith(templateMediaDirPath)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid media path" }));
        return;
      }
      const binary = await fs.readFile(fullPath);
      const ext = String(path.extname(fileName) || "").replace(".", "").toLowerCase();
      const mimeType = TEMPLATE_MEDIA_MIME_FROM_EXT[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(binary);
    } catch (error) {
      if (error?.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Media not found" }));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Template media fetch error" }));
    }

    return;
  }

  if (req.method === "GET" && url.pathname === "/api/whatsapp/templates/local") {

    setCors(res);

    try {

      const store = await readLocalTemplateStore();

      const items = Array.isArray(store.items) ? store.items : [];

      res.writeHead(200, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ updatedAt: store.updatedAt || null, items }));

    } catch (error) {

      res.writeHead(500, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ error: error.message || "Server error" }));

    }

    return;

  }

  if (req.method === "POST" && url.pathname === "/api/whatsapp/templates/local") {

    setCors(res);

    try {

      const payload = await readJson(req);

      if (Array.isArray(payload?.items)) {

        const items = await replaceLocalTemplateStore(payload.items);

        res.writeHead(200, { "Content-Type": "application/json" });

        res.end(JSON.stringify({ items }));

        return;

      }

      const item = await upsertLocalTemplateStore(payload);

      res.writeHead(200, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ item }));

    } catch (error) {

      res.writeHead(400, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ error: error.message || "Server error" }));

    }

    return;

  }

  if (req.method === "POST" && url.pathname === "/api/whatsapp/templates/local/delete") {

    setCors(res);

    try {

      const { id } = await readJson(req);

      if (!id) {

        res.writeHead(400, { "Content-Type": "application/json" });

        res.end(JSON.stringify({ error: "Missing id" }));

        return;

      }

      const ok = await deleteLocalTemplateStore(id);

      res.writeHead(200, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ ok }));

    } catch (error) {

      res.writeHead(500, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ error: error.message || "Server error" }));

    }

    return;

  }

if (req.method === "GET" && url.pathname === "/api/whatsapp/templates") {































    setCors(res);































    try {































      const { accessToken, wabaId } = await resolveMetaConfig();































      if (!accessToken) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing WhatsApp access token" }));































        return;































      }































      if (!wabaId) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing WHATSAPP_BUSINESS_ACCOUNT_ID or WABA id" }));































        return;































      }































































            let templates = [];
      let nextUrl = new URL(`https://graph.facebook.com/${API_VERSION}/${wabaId}/message_templates`);
      nextUrl.searchParams.set("fields", "name,language,status,category,components");
      nextUrl.searchParams.set("limit", "250");
      nextUrl.searchParams.set("access_token", accessToken);
      let pageCount = 0;
      while (nextUrl) {
        const response = await fetch(nextUrl.toString(), {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        const data = await response.json();
        if (!response.ok) {
          const error = data?.error?.message || "WhatsApp template list error";
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error }));
          return;
        }

        if (Array.isArray(data?.data)) {
          templates = templates.concat(data.data);
        }

        const next = data?.paging?.next;
        if (next && pageCount < 20) {
          nextUrl = new URL(next);
          pageCount += 1;
        } else {
          nextUrl = null;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(templates));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































  if (req.method === "GET" && url.pathname === "/api/painel/renew/logs") {
    setCors(res);
    try {
      const phone = url.searchParams.get("phone") || "";
      if (!phone) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing phone" }));
        return;
      }

      const logs = await getRenewLogs(phone);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ phone, logs }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Renew log error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/painel/logs") {
    setCors(res);
    try {
      const limitRaw = url.searchParams.get("limit") || "300";
      const limit = Math.max(1, Number.parseInt(limitRaw, 10) || 300);
      const syncLogs = await getPainelSyncLogs();
      const renewLogs = await getAllRenewLogs();
      const messageLogs = await getMessageDeliveryLogs();
      const merged = [...syncLogs, ...renewLogs, ...messageLogs]
        .filter((entry) => entry && entry.at)
        .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
        .slice(0, limit);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ logs: merged }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Painel logs error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/painel/message-logs") {
    setCors(res);
    try {
      const limitRaw = url.searchParams.get("limit") || "300";
      const limit = Math.max(1, Number.parseInt(limitRaw, 10) || 300);
      const logs = (await getMessageDeliveryLogs())
        .filter((entry) => entry && entry.at)
        .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
        .slice(0, limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ logs }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Painel message logs error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/routines") {
    setCors(res);
    try {
      const store = await readRoutineStore();
      const routines = sortRoutineList(Array.isArray(store.routines) ? store.routines : []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ routines }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Routine list error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/routines/logs") {
    setCors(res);
    try {
      const routineId = String(url.searchParams.get("routineId") || "").trim();
      const limitRaw = Number.parseInt(url.searchParams.get("limit") || "200", 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : 200;
      const logStore = await readRoutineLogStore();
      let logs = Array.isArray(logStore.logs) ? logStore.logs : [];
      if (routineId) {
        logs = logs.filter((entry) => String(entry?.routineId || "") === routineId);
      }
      logs = logs
        .filter((entry) => entry && entry.at)
        .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
        .slice(0, limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ logs }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Routine logs error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/routines") {
    setCors(res);
    try {
      const payload = await readJson(req);
      const store = await readRoutineStore();
      const routines = Array.isArray(store.routines) ? store.routines : [];
      const normalized = normalizeRoutineDefinition(payload);
      routines.unshift(normalized);
      store.routines = routines;
      await writeRoutineStore(store);
      await appendRoutineLog({
        routineId: normalized.id,
        routineTitle: normalized.title,
        level: "info",
        message: "Rotina criada.",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ routine: normalized }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Routine create error" }));
    }
    return;
  }

  const routineIdPutMatch =
    req.method === "PUT" ? url.pathname.match(/^\/api\/routines\/([^/]+)$/) : null;
  if (routineIdPutMatch) {
    setCors(res);
    try {
      const routineId = decodeRouteSegment(routineIdPutMatch[1]);
      if (!routineId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing routine id" }));
        return;
      }
      const payload = await readJson(req);
      const store = await readRoutineStore();
      const routines = Array.isArray(store.routines) ? store.routines : [];
      const index = routines.findIndex((item) => item?.id === routineId);
      if (index < 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Routine not found" }));
        return;
      }
      const current = routines[index];
      const normalized = normalizeRoutineDefinition({ ...current, ...payload }, current);
      routines[index] = normalized;
      store.routines = routines;
      await writeRoutineStore(store);
      await appendRoutineLog({
        routineId: normalized.id,
        routineTitle: normalized.title,
        level: "info",
        message: "Rotina atualizada.",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ routine: normalized }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Routine update error" }));
    }
    return;
  }

  const routineIdDeleteMatch =
    req.method === "DELETE" ? url.pathname.match(/^\/api\/routines\/([^/]+)$/) : null;
  if (routineIdDeleteMatch) {
    setCors(res);
    try {
      const routineId = decodeRouteSegment(routineIdDeleteMatch[1]);
      if (!routineId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing routine id" }));
        return;
      }
      const store = await readRoutineStore();
      const routines = Array.isArray(store.routines) ? store.routines : [];
      const next = routines.filter((item) => item?.id !== routineId);
      if (next.length === routines.length) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Routine not found" }));
        return;
      }
      store.routines = next;
      await writeRoutineStore(store);
      await appendRoutineLog({
        routineId,
        level: "info",
        message: "Rotina removida.",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Routine delete error" }));
    }
    return;
  }

  const routinePreviewMatch =
    req.method === "POST" ? url.pathname.match(/^\/api\/routines\/([^/]+)\/preview$/) : null;
  if (routinePreviewMatch) {
    setCors(res);
    try {
      const routineId = decodeRouteSegment(routinePreviewMatch[1]);
      const payload = await readJson(req);
      const store = await readRoutineStore();
      const routine = (store.routines || []).find((item) => item?.id === routineId);
      if (!routine) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Routine not found" }));
        return;
      }
      const preview = await buildRoutinePreviewPayload(routine, {
        limit: payload?.limit,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ preview }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Routine preview error" }));
    }
    return;
  }

  const routineRunNowMatch =
    req.method === "POST" ? url.pathname.match(/^\/api\/routines\/([^/]+)\/run-now$/) : null;
  if (routineRunNowMatch) {
    setCors(res);
    try {
      const routineId = decodeRouteSegment(routineRunNowMatch[1]);
      const store = await readRoutineStore();
      const routine = (store.routines || []).find((item) => item?.id === routineId);
      if (!routine) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Routine not found" }));
        return;
      }
      const result = await executeRoutineNow(routine, { runKey: null });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", summary: result.summary }));
    } catch (error) {
      const message = error?.message || "Routine run error";
      const statusCode = /execucao/i.test(message) ? 409 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/painel/customers") {
    setCors(res);
    try {
      const store = await readPainelStore();
      const rawStoredRows = Object.values(store?.customers || {});
      const dedupedStore = emptyPainelStore();
      const dedupeStats = upsertPainelCustomers(dedupedStore, rawStoredRows);
      const rows = Object.values(dedupedStore?.customers || {}).map((row) => ({
        ...row,
        missingInSync: Boolean(row?.missingInSync),
      }));
      const existingIdentitySet = new Set();
      rows.forEach((row) => {
        const identity = normalizePainelCustomerIdentity(row?.customerId || row?.id || "");
        const usuario = normalizePainelCustomerIdentity(row?.usuario || row?.username || "");
        const phone = normalizePhone(row?.whatsapp || row?.phone || "");
        if (identity) existingIdentitySet.add(`id:${identity}`);
        if (usuario) existingIdentitySet.add(`user:${usuario}`);
        if (phone) existingIdentitySet.add(`ph:${phone}`);
      });

      const missingReport = await readPainelMissingReport();
      const missingRows = Array.isArray(missingReport?.missingAfter) ? missingReport.missingAfter : [];
      const appendedRows = [];
      const appendedKeySet = new Set();
      for (const missingRow of missingRows) {
        const normalizedRow = normalizePainelMissingCustomerRow(missingRow);
        const identity = normalizePainelCustomerIdentity(
          normalizedRow.customerId || normalizedRow.id || "",
        );
        const usuario = normalizePainelCustomerIdentity(
          normalizedRow.usuario || normalizedRow.username || "",
        );
        const phone = normalizePhone(normalizedRow.whatsapp || normalizedRow.phone || "");
        const candidateKeys = [];
        if (identity) candidateKeys.push(`id:${identity}`);
        if (usuario) candidateKeys.push(`user:${usuario}`);
        if (phone) candidateKeys.push(`ph:${phone}`);
        const exists =
          candidateKeys.some((key) => existingIdentitySet.has(key)) ||
          candidateKeys.some((key) => appendedKeySet.has(key));
        if (exists) continue;
        candidateKeys.forEach((key) => appendedKeySet.add(key));
        appendedRows.push(normalizedRow);
      }

      const mergedRows = [...rows, ...appendedRows];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        updatedAt: missingReport?.updatedAt || dedupedStore?.updatedAt || store?.updatedAt || null,
        total: mergedRows.length,
        diagnostics: {
          rawStoredTotal: rawStoredRows.length,
          dedupedStoredTotal: rows.length,
          duplicatesCollapsed: Math.max(0, rawStoredRows.length - rows.length),
          dedupe: dedupeStats,
        },
        missingReport: {
          missingBeforeCount: Number(missingReport?.missingBeforeCount || 0),
          missingAfterCount: Number(missingReport?.missingAfterCount || 0),
          appendedCount: appendedRows.length,
        },
        rows: mergedRows,
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Painel customers error" }));
    }
    return;
  }
if (req.method === "GET" && url.pathname === "/api/painel/customer") {































    setCors(res);































    try {































      const phone = url.searchParams.get("phone");































      const source = url.searchParams.get("source") || "auto";































      if (!phone) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing 'phone'" }));































        return;































      }































































      const normalized = normalizePhone(phone);































      const store = await readPainelStore();































      const stored = findPainelCustomerEntry(store, { phone: normalized })?.row || null;































































      if (source === "store") {































        if (!stored) {































          res.writeHead(404, { "Content-Type": "application/json" });































          res.end(JSON.stringify({ error: "Customer not found in store" }));































          return;































        }































        res.writeHead(200, { "Content-Type": "application/json" });































        res.end(JSON.stringify({































          usuario: stored.usuario || normalized,
          id: stored.id || stored.customerId || null,
          customerId: stored.customerId || stored.id || null,
          username: stored.username || stored.usuario || null,
          whatsapp: stored.whatsapp || stored.phone || normalized || null,
          planoAtual: stored.planoAtual || null,
          packageName: stored.packageName || stored.planoAtual || null,
          packageId: stored.packageId || stored.package_id || null,
          package_id: stored.package_id || stored.packageId || null,
          conexoes: stored.conexoes ?? null,
          connections: stored.connections ?? stored.conexoes ?? null,
          vencimento: stored.vencimento || null,
          expiresAt: stored.expiresAt || null,
          expiresAtTz: stored.expiresAtTz || null,
          valor: stored.valor || null,
          notas: stored.notas || null,
          note: stored.note || stored.notas || null,
          situacao: stored.situacao || null,
          status: stored.status || stored.situacao || null,
          renewUrl: stored.renewUrl || null,
          renew_url: stored.renewUrl || null,
          playlist: stored.playlist || stored.Playlist || null,
          checkoutPlanMonths: sanitizeCheckoutPlanMonths(stored.checkoutPlanMonths) || null,
          checkoutPlanLabel: stored.checkoutPlanLabel || null,
          checkoutPackageId: stored.checkoutPackageId || null,































        }));































        return;































      }































































      if (source === "auto" && stored) {































        res.writeHead(200, { "Content-Type": "application/json" });































        res.end(JSON.stringify({































          usuario: stored.usuario || normalized,
          id: stored.id || stored.customerId || null,
          customerId: stored.customerId || stored.id || null,
          username: stored.username || stored.usuario || null,
          whatsapp: stored.whatsapp || stored.phone || normalized || null,
          planoAtual: stored.planoAtual || null,
          packageName: stored.packageName || stored.planoAtual || null,
          packageId: stored.packageId || stored.package_id || null,
          package_id: stored.package_id || stored.packageId || null,
          conexoes: stored.conexoes ?? null,
          connections: stored.connections ?? stored.conexoes ?? null,
          vencimento: stored.vencimento || null,
          expiresAt: stored.expiresAt || null,
          expiresAtTz: stored.expiresAtTz || null,
          valor: stored.valor || null,
          notas: stored.notas || null,
          note: stored.note || stored.notas || null,
          situacao: stored.situacao || null,
          status: stored.status || stored.situacao || null,
          renewUrl: stored.renewUrl || null,
          renew_url: stored.renewUrl || null,
          playlist: stored.playlist || stored.Playlist || null,
          checkoutPlanMonths: sanitizeCheckoutPlanMonths(stored.checkoutPlanMonths) || null,
          checkoutPlanLabel: stored.checkoutPlanLabel || null,
          checkoutPackageId: stored.checkoutPackageId || null,































        }));































        return;































      }































































      const data = await fetchPainelCustomer(phone);































      let playlistText = null;































      if (source === "panel") {































        try {































          const playlist = await fetchPainelPlaylist(phone);































          playlistText = playlist?.text ?? null;































        } catch {































          playlistText = null;































        }































      }































      const updatedStore = store;































      const row = {































        phone: normalized || data.usuario,































        usuario: data.usuario,































        planoAtual: data.planoAtual,































        conexoes: data.conexoes,































        vencimento: data.vencimento,































        valor: data.valor,































        notas: data.notas,































        situacao: data.situacao,































      };































      if (playlistText) {































        row.playlist = playlistText;































      }































      upsertPainelCustomers(updatedStore, [row]);
      await writePainelStore(updatedStore);
      const persisted =
        findPainelCustomerEntry(updatedStore, {
          customerId: row.customerId || row.id || null,
          usuario: row.usuario || null,
          phone: normalized || row.phone || null,
        })?.row || null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...data,
        checkoutPlanMonths: sanitizeCheckoutPlanMonths(persisted?.checkoutPlanMonths) || null,
        checkoutPlanLabel: persisted?.checkoutPlanLabel || null,
        checkoutPackageId: persisted?.checkoutPackageId || null,
      }));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Painel error" }));































    }































    return;































  }































































































  if (req.method === "POST" && url.pathname === "/api/painel/customer/checkout-plan") {
    setCors(res);
    try {
      const payload = await readJson(req);
      const phone = normalizePhone(payload?.phone || "");
      const customerId = String(payload?.customerId || payload?.id || "").trim();
      const usuario = String(payload?.usuario || payload?.username || payload?.user || "").trim();
      const planMonths = sanitizeCheckoutPlanMonths(payload?.planMonths);
      if ((!phone && !customerId && !usuario) || !planMonths) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing customer reference (phone/customerId/usuario) or invalid planMonths" }));
        return;
      }

      const planConfig = resolveCheckoutPlanConfig(planMonths);
      const store = await readPainelStore();
      if (!store.customers || typeof store.customers !== "object") {
        store.customers = {};
      }

      let targets = [];
      const explicitEntry = findPainelCustomerEntry(store, { phone, customerId, usuario });
      if (explicitEntry) {
        targets = [explicitEntry];
      } else if (phone) {
        targets = findPainelCustomerEntriesByPhone(store, phone);
      }

      if (!targets.length) {
        const fallbackKey = buildPainelCustomerKey(
          { phone: phone || null, customerId: customerId || null, usuario: usuario || null },
          `checkout-plan-${Date.now()}`,
        );
        store.customers[fallbackKey] = {
          phone: phone || "n/a",
          whatsapp: phone || "n/a",
          customerId: customerId || null,
          id: customerId || null,
          usuario: usuario || null,
        };
        targets = [{ key: fallbackKey, row: store.customers[fallbackKey] }];
      }

      let lastCustomer = null;
      targets.forEach(({ key, row }) => {
        const existing = row && typeof row === "object" ? row : {};
        const normalizedRowPhone = normalizePhone(existing?.phone || existing?.whatsapp || "") || phone || "";
        const next = {
          ...existing,
          phone: normalizedRowPhone || existing?.phone || "n/a",
          whatsapp: normalizedRowPhone || existing?.whatsapp || existing?.phone || "n/a",
          checkoutPlanMonths: planConfig.months,
          checkoutPlanLabel: planConfig.planLabel,
          checkoutPackageId: planConfig.packageId,
        };
        store.customers[key] = next;
        lastCustomer = next;
      });

      await writePainelStore(store);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        updatedCount: targets.length,
        customer: lastCustomer,
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Checkout plan update error" }));
    }
    return;
  }

if (req.method === "POST" && url.pathname === "/api/checkout/token") {































    setCors(res);































    try {

  const payload = await readJson(req);































      const phone = payload?.phone;































      if (!phone) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing 'phone'" }));































        return;































      }































































      const normalized = normalizePhone(phone) || String(phone).trim();































      const requestedPlanMonths = sanitizeCheckoutPlanMonths(payload?.planMonths || payload?.plan);
      const requestedPackageId = payload?.packageId ? String(payload.packageId).trim() : "";































      const rawConnections = payload?.connections;
      const ownerWorkerId = payload?.ownerWorkerId ? String(payload.ownerWorkerId).trim() : "";















      const connections = rawConnections === undefined ? NaN : Number(rawConnections);































      const shouldSync = payload?.sync === true;































































      let tokenPayload;































































      if (shouldSync) {































        let panelData = null;































        try {































          panelData = await fetchPainelCustomer(phone);































        } catch (error) {































          const message = error?.message || "Painel sync failed";































          res.writeHead(500, { "Content-Type": "application/json" });































          res.end(JSON.stringify({ error: message }));































          return;































        }































































        const planConfig = resolveCheckoutPlanConfig(
          requestedPlanMonths || panelData?.checkoutPlanMonths || panelData?.plan,
        );
        tokenPayload = {































          user: panelData?.usuario || normalized,































          whatsapp: normalized,































          plan: planConfig.months,































          connections: Number.isFinite(connections) && connections > 0 ? connections : panelData?.conexoes ?? 1,
          ownerWorkerId: ownerWorkerId || undefined,
          customer_id: payload?.customer_id || payload?.customerId || panelData?.customerId || panelData?.id || undefined,
          customerId: payload?.customerId || payload?.customer_id || panelData?.customerId || panelData?.id || undefined,
          package_id: requestedPackageId || panelData?.checkoutPackageId || planConfig.packageId,
          plan_label: panelData?.checkoutPlanLabel || planConfig.planLabel,































        };































      } else {































        const store = await readPainelStore();
        const payloadUser = payload?.user ? String(payload.user).trim() : '';
        const payloadWhatsapp = payload?.whatsapp ? String(payload.whatsapp).trim() : '';
        const stored =
          findPainelCustomerEntry(store, {
            phone: normalized,
            usuario: payloadUser || null,
          })?.row || null;































        const user = payloadUser || stored?.usuario || normalized;































        const whatsapp = payloadWhatsapp || normalized;































        const safeConnections = Number.isFinite(connections) && connections > 0































          ? connections































          : stored?.conexoes ?? 1;































        const storedPlanMonths = sanitizeCheckoutPlanMonths(stored?.checkoutPlanMonths);
        const planConfig = resolveCheckoutPlanConfig(storedPlanMonths || requestedPlanMonths);
        tokenPayload = {































          user,































          whatsapp,































          plan: planConfig.months,































          connections: safeConnections,
          ownerWorkerId: ownerWorkerId || undefined,
          customer_id: payload?.customer_id || payload?.customerId || stored?.customerId || stored?.id || undefined,
          customerId: payload?.customerId || payload?.customer_id || stored?.customerId || stored?.id || undefined,
          package_id: requestedPackageId || stored?.checkoutPackageId || planConfig.packageId,
          plan_label: stored?.checkoutPlanLabel || planConfig.planLabel,































        };































      }































































      const { token, expiresAt } = await createCheckoutToken(tokenPayload);

      await appendRenewLog(phone, `Checkout gerado. Token: ${token}`, { source: "checkout" });































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ token, expiresAt }));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Checkout token error" }));































    }































    return;































  }































































  if (req.method === "GET" && url.pathname === "/api/checkout/resolve") {































    setCors(res);































    try {































      const token = url.searchParams.get("token");































      if (!token) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing 'token'" }));































        return;































      }

  const payload = await resolveCheckoutToken(token);































      if (!payload) {































        res.writeHead(404, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Token not found or expired" }));































        return;































      }































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify(payload));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Checkout token error" }));































    }































    return;































  }

































































  if (req.method === "POST" && url.pathname === "/api/painel/due-date") {
    setCors(res);
    try {
  const payload = await readJson(req);
      const dueDate = payload?.dueDate
        || payload?.date
        || url.searchParams.get("dueDate")
        || url.searchParams.get("date");
      if (!dueDate) {

        res.writeHead(400, { "Content-Type": "application/json" });

        res.end(JSON.stringify({ error: "Missing 'dueDate'" }));

        return;

      }


      const maxPages = payload?.maxPages;
      const maxItems = payload?.maxItems;
      const countOnly = payload?.countOnly === true;
      const includeLinks = countOnly ? false : payload?.includeLinks !== false;

      const dueDateTimeoutMs = Number.parseInt(
        process.env.PANEL_NEWBR_DUE_DATE_TIMEOUT_MS || "180000",
        10,
      );
      const effectiveTimeoutMs =
        Number.isFinite(dueDateTimeoutMs) && dueDateTimeoutMs > 0
          ? dueDateTimeoutMs
          : 180000;

      console.log(`[due-date] Inicio: ${dueDate}`);
      console.log(
        `[due-date] Config: maxPages=${maxPages || "auto"} maxItems=${maxItems || "auto"} timeoutMs=${effectiveTimeoutMs}`,
      );

      const pauseMarkers = ["um momento", "cloudflare", "desafio", "turnstile", "login manual"];
      const resumeMarkers = [
        "painel carregado",
        "login conclu",
        "painel pronto",
        "dashboard:",
        "redirecionando para a tela de clientes",
      ];

      let lastProgressAt = Date.now();
      let timeoutPaused = false;
      const markProgress = (message) => {
        if (typeof message === "string") {
          const lower = message.toLowerCase();
          if (pauseMarkers.some((marker) => lower.includes(marker))) {
            timeoutPaused = true;
          }
          if (resumeMarkers.some((marker) => lower.includes(marker))) {
            timeoutPaused = false;
          }
        }
        lastProgressAt = Date.now();
      };

      const onLog = (message) => {
        console.log(`[due-date] ${message}`);
        markProgress(message);
      };

      markProgress("inicio");

      const runPromise = fetchPainelCustomersByDueDate({
        dueDate,
        maxPages: Number.isFinite(Number(maxPages)) ? Number(maxPages) : undefined,
        maxItems: Number.isFinite(Number(maxItems)) ? Number(maxItems) : undefined,
        countOnly,
        onLog,
      });

      let intervalId;
      const timeoutPromise = new Promise((_, reject) => {
        intervalId = setInterval(() => {
          if (timeoutPaused) return;
          if (Date.now() - lastProgressAt > effectiveTimeoutMs) {
            clearInterval(intervalId);
            reject(new Error(`Timeout ao buscar clientes (${effectiveTimeoutMs}ms sem progresso)`));
          }
        }, 1000);
      });

      let result;
      try {
        result = await Promise.race([runPromise, timeoutPromise]);
      } finally {
        if (intervalId) clearInterval(intervalId);
      }

      const baseUrl = CHECKOUT_PUBLIC_URL || "";
      const rows = result.rows || [];
      let outputRows = rows;



      if (includeLinks) {

        outputRows = [];

        for (const row of rows) {

          const phone = normalizePhone(row.phone) || row.phone || '';

          const planMonths = parsePlanMonths(row.planoAtual) || 1;

          const connections = row.conexoes ?? 1;

          const { token, expiresAt } = await createCheckoutToken({

            user: row.usuario || phone,

            whatsapp: phone,

            plan: planMonths,

            connections: Number.isFinite(connections) ? connections : 1,

          });

          const link = baseUrl ? `${baseUrl}?token=${encodeURIComponent(token)}` : null;

          outputRows.push({

            ...row,

            phone,

            token,

            expiresAt,

            checkoutLink: link,

          });

        }

      }



      res.writeHead(200, { "Content-Type": "application/json" });

      res.end(JSON.stringify({

        dueDate: result.dueDate,

        total: outputRows.length,

        pages: result.pages,

        rows: outputRows,

      }));

    } catch (error) {

      res.writeHead(500, { "Content-Type": "application/json" });

      res.end(JSON.stringify({ error: error.message || "Painel due date error" }));

    }

    return;

  }





if (req.method === "GET" && url.pathname === "/api/painel/playlist") {
    setCors(res);
    try {
      const phone = url.searchParams.get("phone");
      const customerIdQuery = String(url.searchParams.get("customerId") || "").trim();
      if (!phone) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'phone'" }));
        return;
      }

      const normalized = normalizePhone(phone);
      const store = await readPainelStore();
      const stored = findPainelCustomerEntry(store, { phone: normalized })?.row || null;
      const customerId =
        customerIdQuery ||
        String(stored?.customerId || stored?.id || "").trim() ||
        null;

      try {
        const agentResponse = await fetchPlaylistViaLocalAgent({
          phone: normalized || phone,
          customerId,
        });
        const remoteText = agentResponse?.result?.text
          ? String(agentResponse.result.text).trim()
          : "";
        if (remoteText && normalized) {
          upsertPainelCustomers(store, [{
            phone: normalized,
            customerId: customerId || undefined,
            playlist: remoteText,
          }]);
          await writePainelStore(store);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          text: remoteText,
          source: "local-agent",
          customerId: customerId || null,
        }));
        return;
      } catch (remoteError) {
        const storedPlaylist =
          stored?.playlist ??
          stored?.Playlist ??
          stored?.m3uUrl ??
          stored?.m3u_url ??
          stored?.m3uUrlShort ??
          stored?.m3u_url_short ??
          null;

        if (storedPlaylist) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              text: String(storedPlaylist),
              source: "store-fallback",
              warning: remoteError?.message || "Falha ao consultar playlist no painel",
            }),
          );
          return;
        }

        throw remoteError;
      }
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Painel error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/painel/sync") {































    setCors(res);































    try {































      const state = await loadPainelSyncState();































      if (state.running && !painelSyncTask) {































        state.running = false;































        state.finishedAt = nowIso();































        state.error = state.error || "Sincronizacao interrompida";































        await savePainelSyncState();































      }































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify(state));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Painel sync error" }));































    }































    return;































  }































































  if (req.method === "POST" && url.pathname === "/api/painel/sync") {































    setCors(res);































    try {































      const state = await startPainelSync();































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify(state));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Painel sync error" }));































    }































    return;































  }































































  if (req.method === "GET" && url.pathname === "/api/painel/sync/report-missing") {
    setCors(res);
    try {
      const fallback = {
        generatedAt: null,
        updatedAt: null,
        sourceBaseUrl: null,
        sourceTotalRows: 0,
        importedRows: 0,
        pages: 0,
        reimportedRows: 0,
        missingBeforeCount: 0,
        missingAfterCount: 0,
        sourceWithoutIdentityCount: 0,
        missingBefore: [],
        missingAfter: [],
        sourceWithoutIdentity: [],
      };
      const report = await safeReadJsonFile(painelMissingReportPath, fallback);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(report));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error?.message || "Failed to read painel missing report",
        }),
      );
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/painel/sync/report-missing") {
    setCors(res);
    try {
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid payload" }));
        return;
      }

      const toRows = (value) =>
        Array.isArray(value)
          ? value
              .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
              .map((entry) => ({ ...entry }))
          : [];
      const missingBefore = toRows(body.missingBefore);
      const missingAfter = toRows(body.missingAfter);
      const sourceWithoutIdentity = toRows(body.sourceWithoutIdentity);

      const report = {
        generatedAt: body.generatedAt ? String(body.generatedAt) : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceBaseUrl: body.sourceBaseUrl ? String(body.sourceBaseUrl) : null,
        sourceTotalRows: Number.isFinite(Number(body.sourceTotalRows))
          ? Number(body.sourceTotalRows)
          : 0,
        importedRows: Number.isFinite(Number(body.importedRows)) ? Number(body.importedRows) : 0,
        pages: Number.isFinite(Number(body.pages)) ? Number(body.pages) : 0,
        reimportedRows: Number.isFinite(Number(body.reimportedRows))
          ? Number(body.reimportedRows)
          : 0,
        missingBeforeCount: Number.isFinite(Number(body.missingBeforeCount))
          ? Number(body.missingBeforeCount)
          : missingBefore.length,
        missingAfterCount: Number.isFinite(Number(body.missingAfterCount))
          ? Number(body.missingAfterCount)
          : missingAfter.length,
        sourceWithoutIdentityCount: Number.isFinite(Number(body.sourceWithoutIdentityCount))
          ? Number(body.sourceWithoutIdentityCount)
          : sourceWithoutIdentity.length,
        missingBefore,
        missingAfter,
        sourceWithoutIdentity,
      };

      await atomicWriteJson(painelMissingReportPath, report);
      const upsertResult = await upsertMissingCustomersIntoPainelStore(report.missingAfter);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          path: PAINEL_MISSING_REPORT_PATH,
          missingAfterCount: report.missingAfterCount,
          missingBeforeCount: report.missingBeforeCount,
          insertedInCustomers: upsertResult.inserted,
          updatedInCustomers: upsertResult.updated,
        }),
      );
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error?.message || "Failed to save painel missing report",
        }),
      );
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/whatsapp/templates") {































    setCors(res);































    try {































      const { name, language, category, content, hasButton, buttonText, buttonUrl } = await readJson(req);































      if (!name || !language || !category || !content) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing template fields" }));































        return;































      }































































      const result = await createTemplate({































        name,































        language,































        category,































        content,































        hasButton,































        buttonText,































        buttonUrl,































      });































































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify(result));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































  if (req.method === "POST" && url.pathname === "/api/whatsapp/send-template") {































    setCors(res);































    try {































      const payload = await readJson(req);
      const {
        to,
        parameters,
        buttonParameters,
        headerParameters,
        headerFormat,
        templateName,
        language,
        previewText,
        replyTo,
        origin,
        agentName,
        senderName,
      } = payload;
      const metaSelector = resolveRequestedMetaSelector(req, payload);































































      const normalizedParameters = Array.isArray(parameters) ? parameters : [];
      const normalizedButtonParameters = Array.isArray(buttonParameters) ? buttonParameters : [];
      const normalizedHeaderFormat = String(headerFormat || "").trim().toUpperCase();
      const normalizedHeaderParameters = normalizeTemplateHeaderParameters(headerParameters, normalizedHeaderFormat);
      const normalizedTo = normalizePhone(to);
      if (!normalizedTo) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing 'to' or 'parameters'" }));































        return;































      }































      if (!templateName && !DEFAULT_TEMPLATE_NAME) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing template name" }));































        return;































      }































































      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-template",
        event: "send-template-requested",
        to: normalizedTo,
        templateName: String(templateName || DEFAULT_TEMPLATE_NAME || "").trim() || null,
        message: `Tentativa de envio de template para ${normalizedTo}.`,
      });

            const result = await sendTemplateMessage({
        to: normalizedTo,
        parameters: normalizedParameters,
        buttonParameters: normalizedButtonParameters,
        headerParameters: normalizedHeaderParameters,
        headerFormat,
        templateName,
        language,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });































































      const previewValue = typeof previewText === "string" ? previewText.trim() : "";
      const templateLabel = String(templateName || DEFAULT_TEMPLATE_NAME || "").trim();































      let text =
        previewValue ||
        (await buildTemplatePreviewText({
          templateName: templateName || DEFAULT_TEMPLATE_NAME,
          language,
          bodyParameters: normalizedParameters,
          headerParameters: normalizedHeaderParameters,
          buttonParameters: normalizedButtonParameters,
        })) ||
        normalizedParameters.join(" ");
      const headerMediaLink =
        normalizedHeaderFormat && normalizedHeaderFormat !== "TEXT"
          ? String(normalizedHeaderParameters[0] || "").trim()
          : "";
      if (headerMediaLink) {
        text = text.replace(/(^|\n)Midia header:\s*https?:\/\/\S+/i, "$1").trim();
      }
      if (!text) {
        text = templateLabel ? `Template: ${templateLabel}` : "Template enviado";
      }
      const templateAttachments = [];
      if (normalizedHeaderFormat === "IMAGE" && headerMediaLink) {
        templateAttachments.push({
          id: `tpl-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: "image",
          url: headerMediaLink,
          name: "Template header image",
        });
      }
      const templateButtons = await buildTemplateButtonPreviewItems({
        templateName: templateName || DEFAULT_TEMPLATE_NAME,
        language,
        buttonParameters: normalizedButtonParameters,
      });































      const responseMessageId = result?.messages?.[0]?.id;
      await upsertAgentMessage({
        to: normalizePhone(to) || to,
        text,
        messageId: responseMessageId,
        attachments: templateAttachments,
        templateButtons,
        replyTo,
        origin: origin || "panel",
        senderName: senderName || agentName || null,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId || result?.__metaConfig?.phoneNumberId || null,
        displayPhoneNumber:
          metaSelector.displayPhoneNumber || result?.__metaConfig?.displayPhoneNumber || null,
        wabaId: result?.__metaConfig?.wabaId || null,
      });
      if (normalizedTo) {
        const store = await readStore();
        const conversationId = mergeConversationIds(store, normalizedTo);
        const conversation =
          store.conversations[conversationId] || buildConversation({ waId: normalizedTo, name: null });
        const tags = new Set(conversation.tags || []);
        tags.add("disparo");
        conversation.tags = Array.from(tags);
        store.conversations[conversationId] = conversation;
        await writeStore(store, { conversationIds: [conversationId] });
      }

      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-template",
        event: "send-template-success",
        to: normalizedTo,
        messageId: responseMessageId || null,
        templateName: String(templateName || DEFAULT_TEMPLATE_NAME || "").trim() || null,
        message: `Template enviado para ${normalizedTo}.`,
      });






























































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify(result));
    } catch (error) {
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "error",
        source: "send-template",
        event: "send-template-failed",
        to: normalizePhone(typeof to !== "undefined" ? to : "") || null,
        templateName: String(typeof templateName !== "undefined" ? templateName : DEFAULT_TEMPLATE_NAME || "").trim() || null,
        message: `Falha ao enviar template: ${error?.message || "erro desconhecido"}`,
        errorReason: error?.message || "erro desconhecido",
      });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Server error" }));
    }
    return;
  }































































  if (req.method === "POST" && url.pathname === "/api/whatsapp/send-text") {































    setCors(res);































    try {































      const payload = await readJson(req);
      const { to, text, contextMessageId, replyTo, origin, agentName, senderName, clientMessageId } = payload;
      const metaSelector = resolveRequestedMetaSelector(req, payload);































      if (!to || !text) {































        res.writeHead(400, { "Content-Type": "application/json" });































        res.end(JSON.stringify({ error: "Missing 'to' or 'text'" }));































        return;































      }































































      const normalizedTo = normalizePhone(to) || String(to || "").trim();
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-text",
        event: "send-text-requested",
        to: normalizedTo || null,
        message: `Tentativa de envio de texto para ${normalizedTo || "-"}.`,
      });
      const result = await sendTextMessage({
        to: normalizedTo,
        text,
        contextMessageId,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });































      const responseMessageId = result?.messages?.[0]?.id;
      await upsertAgentMessage({
        to: normalizePhone(to) || to,
        text,
        messageId: responseMessageId,
        clientMessageId,
        replyToId: contextMessageId,
        replyTo,
        origin: origin || "panel",
        senderName: senderName || agentName || null,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId || result?.__metaConfig?.phoneNumberId || null,
        displayPhoneNumber:
          metaSelector.displayPhoneNumber || result?.__metaConfig?.displayPhoneNumber || null,
        wabaId: result?.__metaConfig?.wabaId || null,
      });
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-text",
        event: "send-text-success",
        to: normalizedTo || null,
        messageId: responseMessageId || null,
        message: `Texto enviado para ${normalizedTo || "-"}.`,
      });































































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify(result));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Server error" }));































    }































    return;































  }































































  if (req.method === "POST" && url.pathname === "/api/whatsapp/send-audio") {
    setCors(res);
    try {
      const payload = await readJson(req);
      const { to, audioBase64, mimetype, ptt, contextMessageId, replyTo, origin, agentName, senderName, clientMessageId } = payload;
      const metaSelector = resolveRequestedMetaSelector(req, payload);
      if (!to || !audioBase64) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'to' or 'audioBase64'" }));
        return;
      }
      const normalizedTo = normalizePhone(to) || String(to || "").trim();
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-audio",
        event: "send-audio-requested",
        to: normalizedTo || null,
        message: `Tentativa de envio de audio para ${normalizedTo || "-"}.`,
      });

      const decoded = decodeBase64Payload({
        base64Value: audioBase64,
        mimeType: mimetype,
        fallbackMimeType: "audio/ogg",
      });
      const preparedAudio = await prepareAudioUpload({
        buffer: decoded.buffer,
        mimeType: decoded.mimeType,
      });
      const mediaId = await uploadMediaToMeta({
        to: normalizedTo,
        buffer: preparedAudio.buffer,
        mimeType: preparedAudio.mimeType,
        filename: `audio-${Date.now()}.${preparedAudio.extension}`,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });
      const result = await sendMediaMessage({
        to: normalizedTo,
        mediaType: "audio",
        mediaId,
        contextMessageId,
        ptt: typeof ptt === "boolean" ? ptt : true,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });

      const responseMessageId = result?.messages?.[0]?.id;
      await upsertAgentMessage({
        to: normalizePhone(to) || to,
        text: "[audio]",
        messageId: responseMessageId,
        clientMessageId,
        replyToId: contextMessageId,
        attachments: [{
          id: mediaId,
          type: "audio",
          url: resolveMediaProxyUrl(mediaId),
          mimeType: preparedAudio.mimeType,
          name: "Audio",
        }],
        replyTo,
        origin: origin || "panel",
        senderName: senderName || agentName || null,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId || result?.__metaConfig?.phoneNumberId || null,
        displayPhoneNumber:
          metaSelector.displayPhoneNumber || result?.__metaConfig?.displayPhoneNumber || null,
        wabaId: result?.__metaConfig?.wabaId || null,
      });

      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-audio",
        event: "send-audio-success",
        to: normalizedTo || null,
        messageId: responseMessageId || null,
        message: `Audio enviado para ${normalizedTo || "-"}.`,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "error",
        source: "send-audio",
        event: "send-audio-failed",
        message: `Falha ao enviar audio: ${error?.message || "erro desconhecido"}`,
        errorReason: error?.message || "erro desconhecido",
      });
      setCors(res);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Server error" }));
    }
    return;
  }































































  if (req.method === "POST" && url.pathname === "/api/whatsapp/send-image") {
    setCors(res);
    try {
      const payload = await readJson(req);
      const { to, imageBase64, mimetype, caption, contextMessageId, replyTo, origin, agentName, senderName, clientMessageId } = payload;
      const metaSelector = resolveRequestedMetaSelector(req, payload);
      if (!to || !imageBase64) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'to' or 'imageBase64'" }));
        return;
      }
      const normalizedTo = normalizePhone(to) || String(to || "").trim();
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-image",
        event: "send-image-requested",
        to: normalizedTo || null,
        message: `Tentativa de envio de imagem para ${normalizedTo || "-"}.`,
      });

      const decoded = decodeBase64Payload({
        base64Value: imageBase64,
        mimeType: mimetype,
        fallbackMimeType: "image/png",
      });
      const preparedImage = await prepareImageUpload({
        buffer: decoded.buffer,
        mimeType: decoded.mimeType,
      });
      const mediaId = await uploadMediaToMeta({
        to: normalizedTo,
        buffer: preparedImage.buffer,
        mimeType: preparedImage.mimeType,
        filename: `image-${Date.now()}.${preparedImage.extension}`,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });
      const result = await sendMediaMessage({
        to: normalizedTo,
        mediaType: "image",
        mediaId,
        caption,
        contextMessageId,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId,
        displayPhoneNumber: metaSelector.displayPhoneNumber,
      });

      const responseMessageId = result?.messages?.[0]?.id;
      await upsertAgentMessage({
        to: normalizePhone(to) || to,
        text: caption || "[image]",
        messageId: responseMessageId,
        clientMessageId,
        replyToId: contextMessageId,
        attachments: [{
          id: mediaId,
          type: "image",
          url: resolveMediaProxyUrl(mediaId),
          mimeType: preparedImage.mimeType,
          name: "Imagem",
        }],
        replyTo,
        origin: origin || "panel",
        senderName: senderName || agentName || null,
        routeKey: metaSelector.routeKey,
        phoneNumberId: metaSelector.phoneNumberId || result?.__metaConfig?.phoneNumberId || null,
        displayPhoneNumber:
          metaSelector.displayPhoneNumber || result?.__metaConfig?.displayPhoneNumber || null,
        wabaId: result?.__metaConfig?.wabaId || null,
      });

      await appendMessageDeliveryLog({
        category: "message-send",
        level: "info",
        source: "send-image",
        event: "send-image-success",
        to: normalizedTo || null,
        messageId: responseMessageId || null,
        message: `Imagem enviada para ${normalizedTo || "-"}.`,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "error",
        source: "send-image",
        event: "send-image-failed",
        message: `Falha ao enviar imagem: ${error?.message || "erro desconhecido"}`,
        errorReason: error?.message || "erro desconhecido",
      });
      setCors(res);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Server error" }));
    }
    return;
  }































































  if (req.method === "POST" && url.pathname === "/api/whatsapp/messages/react") {
    setCors(res);
    try {
      const { conversationId, messageId, emoji, from } = await readJson(req);
      if (!messageId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing messageId" }));
        return;
      }
      const source = from === "client" ? "client" : "agent";
      const normalizedEmoji = String(emoji || "").trim();
      if (source === "agent") {
        const store = await readStore();
        const conversation =
          store.conversations?.[String(conversationId || "").trim()] ||
          Object.values(store.conversations || {}).find((item) =>
            item?.id === String(conversationId || "").trim(),
          ) ||
          null;
        const destinationPhone = normalizePhone(
          conversation?.customer?.phone || String(conversationId || "").replace(/^wa-/, ""),
        );
        if (!destinationPhone) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Conversation destination not found" }));
          return;
        }
        await sendReactionMessage({
          to: destinationPhone,
          targetMessageId: String(messageId),
          emoji: normalizedEmoji,
        });
      }
      const updated = await upsertMessageReaction({
        conversationId,
        targetMessageId: String(messageId),
        from: source,
        emoji: normalizedEmoji,
        reactedAt: nowIso(),
      });
      if (!updated) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Message not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: updated }));
    } catch (error) {
      await appendMessageDeliveryLog({
        category: "message-send",
        level: "error",
        source: "send-text",
        event: "send-text-failed",
        message: `Falha ao enviar texto: ${error?.message || "erro desconhecido"}`,
        errorReason: error?.message || "erro desconhecido",
      });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Reaction error" }));
    }
    return;
  }



if (req.method === "POST" && url.pathname === "/api/whatsapp/session/refresh") {































    setCors(res);































    try {































      const data = await proxyBaileysRefresh();































      res.writeHead(200, { "Content-Type": "application/json" });































      res.end(JSON.stringify(data));































    } catch (error) {































      res.writeHead(500, { "Content-Type": "application/json" });































      res.end(JSON.stringify({ error: error.message || "Baileys refresh error" }));































    }































    return;































  }
































































  if (req.method === "POST" && url.pathname === "/api/whatsapp/session/disconnect") {
    setCors(res);
    try {
      const data = await proxyBaileysDisconnect();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Baileys disconnect error" }));
    }
    return;
  }

  setCors(res);































  res.writeHead(404, { "Content-Type": "application/json" });































  res.end(JSON.stringify({ error: "Not found" }));































});































































let routineSchedulerTimer = null;
let routineSchedulerBusy = false;
let labelsRefreshTimer = null;
let labelsRefreshBusy = false;
let scheduledMessagesTimer = null;
let scheduledMessagesBusy = false;
let labelCampaignTimer = null;
let labelCampaignBusy = false;
let campaignsTimer = null;
let campaignsBusy = false;
let assignmentQueueTimer = null;
let assignmentQueueBusy = false;

const startRoutineScheduler = () => {
  if (routineSchedulerTimer) return;
  const intervalMs =
    Number.isFinite(ROUTINE_SCHEDULER_INTERVAL_MS) && ROUTINE_SCHEDULER_INTERVAL_MS > 0
      ? ROUTINE_SCHEDULER_INTERVAL_MS
      : 15000;
  const runTick = async () => {
    if (routineSchedulerBusy) return;
    routineSchedulerBusy = true;
    try {
      await runRoutineSchedulerTick();
    } catch (error) {
      console.error("[routine] scheduler tick failed:", error?.message || error);
    } finally {
      routineSchedulerBusy = false;
    }
  };
  routineSchedulerTimer = setInterval(() => {
    void runTick();
  }, intervalMs);
  if (typeof routineSchedulerTimer.unref === "function") {
    routineSchedulerTimer.unref();
  }
  setTimeout(() => {
    void runTick();
  }, 2000);
};

const startLabelsRefreshScheduler = () => {
  if (labelsRefreshTimer) return;
  const intervalMs = getDefaultLabelsRefreshIntervalMs();
  const runTick = async () => {
    if (labelsRefreshBusy) return;
    labelsRefreshBusy = true;
    try {
      await syncCurrentContactsForLabels({ force: true });
      console.log("[labels] default-label snapshot refreshed");
    } catch (error) {
      console.error("[labels] refresh tick failed:", error?.message || error);
    } finally {
      labelsRefreshBusy = false;
    }
  };
  labelsRefreshTimer = setInterval(() => {
    void runTick();
  }, intervalMs);
  if (typeof labelsRefreshTimer.unref === "function") {
    labelsRefreshTimer.unref();
  }
  setTimeout(() => {
    void runTick();
  }, 5000);
};

const startScheduledMessagesScheduler = () => {
  if (scheduledMessagesTimer) return;
  const intervalMs =
    Number.isFinite(SCHEDULED_MESSAGES_SCHEDULER_INTERVAL_MS) && SCHEDULED_MESSAGES_SCHEDULER_INTERVAL_MS > 0
      ? SCHEDULED_MESSAGES_SCHEDULER_INTERVAL_MS
      : 15000;
  const runTick = async () => {
    if (scheduledMessagesBusy) return;
    scheduledMessagesBusy = true;
    try {
      await runScheduledMessagesSchedulerTick();
    } catch (error) {
      console.error("[scheduled-messages] scheduler tick failed:", error?.message || error);
    } finally {
      scheduledMessagesBusy = false;
    }
  };
  scheduledMessagesTimer = setInterval(() => {
    void runTick();
  }, intervalMs);
  if (typeof scheduledMessagesTimer.unref === "function") {
    scheduledMessagesTimer.unref();
  }
  setTimeout(() => {
    void runTick();
  }, 3000);
};

const startLabelCampaignScheduler = () => {
  if (labelCampaignTimer) return;
  const intervalMs =
    Number.isFinite(LABEL_CAMPAIGN_SCHEDULER_INTERVAL_MS) && LABEL_CAMPAIGN_SCHEDULER_INTERVAL_MS > 0
      ? LABEL_CAMPAIGN_SCHEDULER_INTERVAL_MS
      : 60000;
  const runTick = async () => {
    if (labelCampaignBusy) return;
    labelCampaignBusy = true;
    try {
      await runLabelCampaignSchedulerTick();
    } catch (error) {
      console.error("[label-campaign] scheduler tick failed:", error?.message || error);
    } finally {
      labelCampaignBusy = false;
    }
  };
  labelCampaignTimer = setInterval(() => {
    void runTick();
  }, intervalMs);
  if (typeof labelCampaignTimer.unref === "function") {
    labelCampaignTimer.unref();
  }
  setTimeout(() => {
    void runTick();
  }, 4000);
};

const startCampaignsScheduler = () => {
  if (campaignsTimer) return;
  const runTick = async () => {
    if (campaignsBusy) return;
    campaignsBusy = true;
    try {
      await runCampaignSchedulerTick();
    } catch (error) {
      console.error("[campaigns] scheduler tick failed:", error?.message || error);
    } finally {
      campaignsBusy = false;
    }
  };
  campaignsTimer = setInterval(() => {
    void runTick();
  }, 60000);
  if (typeof campaignsTimer.unref === "function") {
    campaignsTimer.unref();
  }
  setTimeout(() => {
    void runTick();
  }, 5000);
};

const startAssignmentQueueScheduler = () => {
  if (assignmentQueueTimer) return;
  const intervalMs =
    Number.isFinite(ASSIGNMENT_QUEUE_SCHEDULER_INTERVAL_MS) && ASSIGNMENT_QUEUE_SCHEDULER_INTERVAL_MS > 0
      ? ASSIGNMENT_QUEUE_SCHEDULER_INTERVAL_MS
      : 30000;
  const runTick = async () => {
    if (assignmentQueueBusy) return;
    assignmentQueueBusy = true;
    try {
      const summary = await drainQueuedConversationsToAvailableAgents();
      if (summary.assigned > 0 || summary.requeued > 0) {
        console.log(
          `[assignment] queue drain assigned=${summary.assigned} requeued=${summary.requeued} waiting=${summary.waiting} unclassified=${summary.unclassified}`,
        );
      }
    } catch (error) {
      console.error("[assignment] queue drain failed:", error?.message || error);
    } finally {
      assignmentQueueBusy = false;
    }
  };
  assignmentQueueTimer = setInterval(() => {
    void runTick();
  }, intervalMs);
  if (typeof assignmentQueueTimer.unref === "function") {
    assignmentQueueTimer.unref();
  }
  setTimeout(() => {
    void runTick();
  }, 7000);
};

const startBackgroundSchedulers = () => {
  void ensureLabelsReady().catch((error) => {
    console.error("[labels] initialization failed:", error?.message || error);
  });
  startLabelsRefreshScheduler();
  startScheduledMessagesScheduler();
  startCampaignsScheduler();
  startRoutineScheduler();
  startAssignmentQueueScheduler();
};

if (WHATSAPP_SCHEDULERS_ENABLED) {
  startBackgroundSchedulers();
} else {
  console.log("[maistv-whatsapp] background schedulers disabled for this process");
}

if (WHATSAPP_HTTP_ENABLED) {
server.listen(PORT, HOST, () => {































  console.log(`WhatsApp server running on http://${HOST}:${PORT}`);































});
} else {
  console.log("[maistv-worker] HTTP server disabled; running background schedulers only");
}



















