import fs from "node:fs/promises";
import path from "node:path";
import { normalizeTemplateMediaUrl } from "./template-media-url.js";

const CAMPAIGNS_STORE_PATH =
  process.env.CAMPAIGNS_STORE_PATH || "server/data/campaigns.json";

const storePath = path.resolve(process.cwd(), CAMPAIGNS_STORE_PATH);

const ensureParentDir = async (targetPath) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
};

const safeReadJson = async (targetPath, fallback) => {
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    return fallback;
  }
};

const atomicWriteJson = async (targetPath, data) => {
  await ensureParentDir(targetPath);
  const tempPath = `${targetPath}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tempPath, targetPath);
};

const nowIso = () => new Date().toISOString();

const createId = (prefix) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeString = (value) => String(value || "").trim();

const normalizeWeekdays = (value) => {
  const allowed = new Set([
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ]);
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => normalizeString(item).toLowerCase())
        .filter((item) => allowed.has(item)),
    ),
  );
};

const normalizeStringList = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => normalizeString(item))
        .filter(Boolean),
    ),
  );

const normalizeTemplateMediaValue = (value) =>
  normalizeTemplateMediaUrl(value, {
    publicOrigin: process.env.WHATSAPP_TEMPLATE_MEDIA_PUBLIC_ORIGIN,
    apiBaseUrl: process.env.VITE_WHATSAPP_API_BASE_URL || process.env.VITE_API_BASE_URL,
  });

const normalizeSendIntervalSeconds = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 12;
  return Math.min(120, Math.max(3, Math.round(parsed)));
};

const normalizeRows = (value) =>
  (Array.isArray(value) ? value : [])
    .map((row) => ({
      id: normalizeString(row?.id) || createId("row"),
      title: normalizeString(row?.title),
      description: normalizeString(row?.description),
    }))
    .filter((row) => row.title);

const normalizeAction = (action) => {
  const type = normalizeString(action?.type).toLowerCase();
  const base = {
    id: normalizeString(action?.id) || createId("action"),
    type,
    title: normalizeString(action?.title),
  };

  if (type === "send_text") {
    const typingSeconds = Number(action?.typingSeconds);
    const nextDelaySeconds = Number(action?.nextDelaySeconds);
    return {
      ...base,
      message: String(action?.message || ""),
      typingSeconds: Number.isFinite(typingSeconds)
        ? Math.max(0, Math.round(typingSeconds))
        : 0,
      nextDelaySeconds: Number.isFinite(nextDelaySeconds)
        ? Math.max(0, Math.round(nextDelaySeconds))
        : 0,
    };
  }
  if (type === "send_media") {
    return {
      ...base,
      mediaType: normalizeString(action?.mediaType).toLowerCase() || "image",
      message: String(action?.message || ""),
      mediaUrl: normalizeTemplateMediaValue(normalizeString(action?.mediaUrl)),
      mediaName: normalizeString(action?.mediaName),
      mimeType: normalizeString(action?.mimeType),
    };
  }
  if (type === "send_quick_reply") {
    return {
      ...base,
      quickReplyId: normalizeString(action?.quickReplyId),
      quickReplyTitle: normalizeString(action?.quickReplyTitle),
      message: String(action?.message || ""),
    };
  }
  if (type === "send_list") {
    return {
      ...base,
      message: String(action?.message || ""),
      buttonText: normalizeString(action?.buttonText) || "MENU",
      rows: normalizeRows(action?.rows),
    };
  }
  if (type === "label_add" || type === "label_remove") {
    return {
      ...base,
      labelIds: normalizeStringList(action?.labelIds),
    };
  }
  if (type === "label_remove_all") {
    return base;
  }
  if (type === "wait_seconds") {
    const seconds = Number(action?.seconds);
    return {
      ...base,
      seconds: Number.isFinite(seconds) ? Math.max(1, Math.round(seconds)) : 1,
    };
  }
  if (type === "utility_pin" || type === "utility_unpin" || type === "utility_mark_unread") {
    return base;
  }
  return null;
};

const normalizeActions = (value) =>
  (Array.isArray(value) ? value : [])
    .map((action) => normalizeAction(action))
    .filter(Boolean);

const normalizeCampaign = (item) => {
  const recipients = item?.recipients && typeof item.recipients === "object" ? item.recipients : {};
  const config = item?.config && typeof item.config === "object" ? item.config : {};
  return {
    id: normalizeString(item?.id) || createId("campaign"),
    name: normalizeString(item?.name) || "Nova campanha",
    status: normalizeString(item?.status).toLowerCase() === "active" ? "active" : "draft",
    recipients: {
      labelIds: normalizeStringList(recipients?.labelIds),
    },
    actions: normalizeActions(item?.actions),
    config: {
      weekdays: normalizeWeekdays(config?.weekdays),
      time: normalizeString(config?.time),
      sendIntervalSeconds: normalizeSendIntervalSeconds(config?.sendIntervalSeconds),
      metaTemplateName: normalizeString(config?.metaTemplateName),
      metaTemplateLanguage: normalizeString(config?.metaTemplateLanguage) || "pt_BR",
      metaBodyParameters: normalizeStringList(config?.metaBodyParameters),
      metaHeaderParameters: normalizeStringList(config?.metaHeaderParameters).map((item) =>
        normalizeTemplateMediaValue(item),
      ),
      metaButtonParameters: normalizeStringList(config?.metaButtonParameters),
      useInternalTemplateOn24h: Boolean(config?.useInternalTemplateOn24h),
      internalTemplateId: normalizeString(config?.internalTemplateId),
      internalQuickReplyId: normalizeString(config?.internalQuickReplyId),
      internalQuickReplyTitle: normalizeString(config?.internalQuickReplyTitle),
      includeScheduledContacts:
        typeof config?.includeScheduledContacts === "boolean" ? config.includeScheduledContacts : true,
      active: Boolean(config?.active),
    },
    createdAt: normalizeString(item?.createdAt) || nowIso(),
    updatedAt: nowIso(),
    lastRunAt: normalizeString(item?.lastRunAt) || null,
    lastRunSlot: normalizeString(item?.lastRunSlot) || null,
    lastRunSummary:
      item?.lastRunSummary && typeof item.lastRunSummary === "object" ? item.lastRunSummary : null,
  };
};

const emptyCampaignStore = () => ({
  updatedAt: null,
  items: [],
});

const readCampaignStore = async () => {
  const data = await safeReadJson(storePath, emptyCampaignStore());
  const items = Array.isArray(data?.items) ? data.items.map((item) => normalizeCampaign(item)) : [];
  return {
    updatedAt: normalizeString(data?.updatedAt) || null,
    items,
  };
};

const writeCampaignStore = async (store) => {
  const normalized = {
    updatedAt: nowIso(),
    items: (Array.isArray(store?.items) ? store.items : []).map((item) => normalizeCampaign(item)),
  };
  await atomicWriteJson(storePath, normalized);
  return normalized;
};

export const listCampaigns = async () => {
  const store = await readCampaignStore();
  return store.items.sort(
    (a, b) =>
      Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0),
  );
};

export const getCampaignById = async (campaignId) => {
  const store = await readCampaignStore();
  return store.items.find((item) => item.id === String(campaignId || "")) || null;
};

export const createCampaign = async (payload) => {
  const store = await readCampaignStore();
  const item = normalizeCampaign({
    ...payload,
    id: createId("campaign"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  store.items.unshift(item);
  await writeCampaignStore(store);
  return item;
};

export const updateCampaignById = async (campaignId, payload) => {
  const store = await readCampaignStore();
  const index = store.items.findIndex((item) => item.id === String(campaignId || ""));
  if (index < 0) {
    throw new Error("Campanha nao encontrada");
  }
  const current = store.items[index];
  const next = normalizeCampaign({
    ...current,
    ...payload,
    id: current.id,
    createdAt: current.createdAt,
    lastRunAt: payload?.lastRunAt ?? current.lastRunAt ?? null,
    lastRunSlot: payload?.lastRunSlot ?? current.lastRunSlot ?? null,
    lastRunSummary: payload?.lastRunSummary ?? current.lastRunSummary ?? null,
  });
  store.items[index] = next;
  await writeCampaignStore(store);
  return next;
};

export const deleteCampaignById = async (campaignId) => {
  const store = await readCampaignStore();
  const nextItems = store.items.filter((item) => item.id !== String(campaignId || ""));
  if (nextItems.length === store.items.length) {
    throw new Error("Campanha nao encontrada");
  }
  store.items = nextItems;
  await writeCampaignStore(store);
};

export const remapCampaignLabelIds = async (labelIdMap = {}) => {
  const validEntries = Object.entries(labelIdMap).filter(
    ([fromId, toId]) => normalizeString(fromId) && normalizeString(toId) && fromId !== toId,
  );
  if (!validEntries.length) return false;

  const replaceIds = (values) =>
    Array.from(
      new Set(
        (Array.isArray(values) ? values : [])
          .map((value) => {
            const normalized = normalizeString(value);
            return labelIdMap[normalized] || normalized;
          })
          .filter(Boolean),
      ),
    );

  const store = await readCampaignStore();
  let changed = false;
  const nextItems = store.items.map((item) => {
    const nextRecipientLabelIds = replaceIds(item?.recipients?.labelIds);
    const nextActions = (Array.isArray(item?.actions) ? item.actions : []).map((action) => {
      if (action?.type === "label_add" || action?.type === "label_remove") {
        const nextLabelIds = replaceIds(action.labelIds);
        if (JSON.stringify(nextLabelIds) !== JSON.stringify(action.labelIds || [])) {
          changed = true;
        }
        return { ...action, labelIds: nextLabelIds };
      }
      return action;
    });

    if (JSON.stringify(nextRecipientLabelIds) !== JSON.stringify(item?.recipients?.labelIds || [])) {
      changed = true;
    }

    return {
      ...item,
      recipients: {
        ...(item?.recipients && typeof item.recipients === "object" ? item.recipients : {}),
        labelIds: nextRecipientLabelIds,
      },
      actions: nextActions,
    };
  });

  if (!changed) return false;
  await writeCampaignStore({ ...store, items: nextItems });
  return true;
};
