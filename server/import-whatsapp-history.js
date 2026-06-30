import fs from "node:fs";
import { closeWhatsappHistoryStore, upsertWhatsappHistoryMessage } from "./whatsapp-history-store.js";

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");

const getArgValue = (name) => {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : "";
};

const sourcePath =
  getArgValue("source") ||
  process.argv[2] ||
  process.env.WHATSAPP_HISTORY_IMPORT_SOURCE ||
  "server/data/store.json";

const targetDates = new Set(
  (getArgValue("dates") || process.env.WHATSAPP_HISTORY_IMPORT_DATES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const importAllHistory =
  process.argv.includes("--all") ||
  String(process.env.WHATSAPP_HISTORY_IMPORT_ALL || "").trim() === "1";

const timeZone = process.env.WHATSAPP_HISTORY_IMPORT_TIMEZONE || "America/Sao_Paulo";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const resolveSaoPauloDateKey = (value) => {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "";
  return dateFormatter.format(date);
};

const resolveDefaultTargetDates = () => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return new Set([resolveSaoPauloDateKey(now), resolveSaoPauloDateKey(yesterday)]);
};

const includedDates = importAllHistory
  ? null
  : targetDates.size > 0
    ? targetDates
    : resolveDefaultTargetDates();

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
};

const asMessageArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((item) => (Array.isArray(item) ? item : [item]));
};

const resolveConversationPhone = (conversation = {}) =>
  normalizePhone(
    conversation.contact_phone ||
      conversation.phone ||
      conversation.customer?.phone ||
      conversation.customerPhone ||
      conversation.customer_phone ||
      "",
  );

const resolvePhoneFromConversationId = (conversationId) => {
  const raw = String(conversationId || "").trim();
  if (!raw.startsWith("wa-")) return "";
  return normalizePhone(raw.slice(3));
};

const resolveMessageConversationId = (message = {}) =>
  String(message.conversation_id || message.conversationId || message.chat_id || "").trim();

const resolveMessageTimestamp = (message = {}) =>
  String(
    message.created_at ||
      message.created_date ||
      message.timestamp ||
      message.client_sort_at ||
      "",
  ).trim();

const resolveMessageId = (message = {}, index = 0) =>
  String(
    message.id ||
      message.message_key ||
      message.server_message_id ||
      message.provider_message_id ||
      `${resolveMessageConversationId(message)}:${resolveMessageTimestamp(message)}:${index}`,
  ).trim();

const resolveSenderType = (message = {}) => {
  const raw = String(message.sender_type || message.type || message.from || "").trim().toLowerCase();
  if (raw === "agent" || raw === "system") return raw;
  return "client";
};

const resolvePayload = (message = {}, legacyConversationId = "") => {
  const timestamp = resolveMessageTimestamp(message);
  const senderType = resolveSenderType(message);
  return {
    ...message,
    id: resolveMessageId(message),
    conversationId: legacyConversationId || resolveMessageConversationId(message),
    conversation_id: legacyConversationId || resolveMessageConversationId(message),
    sender_type: senderType,
    type: senderType,
    messageType: message.messageType || message.message_type || "text",
    message_type: message.message_type || message.messageType || "text",
    content: String(message.content || message.text || ""),
    created_at: message.created_at || message.created_date || timestamp,
    created_date: message.created_date || message.created_at || timestamp,
    timestamp,
    status: message.status || "delivered",
    origin: message.origin || "legacy-history",
    legacy_history: true,
  };
};

const raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const conversations = asArray(raw.conversations);
const messages = asMessageArray(raw.messages);
const phoneByConversationId = new Map();

for (const conversation of conversations) {
  const id = String(conversation?.id || "").trim();
  if (!id) continue;
  const phone = resolveConversationPhone(conversation) || resolvePhoneFromConversationId(id);
  if (phone) {
    phoneByConversationId.set(id, phone);
  }
}

let scanned = 0;
let skippedDate = 0;
let skippedPhone = 0;
let imported = 0;

for (const [index, message] of messages.entries()) {
  scanned += 1;
  const timestamp = resolveMessageTimestamp(message);
  const dateKey = resolveSaoPauloDateKey(timestamp);
  if (includedDates && !includedDates.has(dateKey)) {
    skippedDate += 1;
    continue;
  }

  const legacyConversationId = resolveMessageConversationId(message);
  const phone =
    normalizePhone(message.phone || message.contact_phone || message.customer_phone) ||
    phoneByConversationId.get(legacyConversationId) ||
    resolvePhoneFromConversationId(legacyConversationId);

  if (!phone) {
    skippedPhone += 1;
    continue;
  }

  const timestampMs = Date.parse(timestamp);
  const payload = resolvePayload(message, legacyConversationId);
  const ok = upsertWhatsappHistoryMessage({
    id: `legacy:${resolveMessageId(message, index)}`,
    legacyConversationId,
    phone,
    direction: resolveSenderType(message),
    payload,
    timestampMs,
    createdAt: payload.created_at,
    routeKey: message.meta_route_key || message.route_key || "",
  });

  if (ok) imported += 1;
}

closeWhatsappHistoryStore();

console.log(JSON.stringify({
  source: sourcePath,
  dates: includedDates ? Array.from(includedDates).sort() : "all",
  scanned,
  imported,
  skippedDate,
  skippedPhone,
}, null, 2));
