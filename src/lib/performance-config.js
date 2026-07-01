const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const LABEL_REFRESH_INTERVAL_MS = parsePositiveInt(
  import.meta.env.VITE_LABEL_REFRESH_INTERVAL_MS,
  30000,
);

export const CONVERSATION_REFRESH_INTERVAL_MS = parsePositiveInt(
  import.meta.env.VITE_CONVERSATION_REFRESH_INTERVAL_MS,
  300000,
);

export const CONVERSATION_SUMMARY_LIMIT = parsePositiveInt(
  import.meta.env.VITE_CONVERSATION_SUMMARY_LIMIT,
  30,
);

export const MESSAGE_PAGE_LIMIT = parsePositiveInt(
  import.meta.env.VITE_MESSAGE_PAGE_LIMIT,
  20,
);

export const CHAT_MAX_CACHED_MESSAGES_PER_CONVERSATION = parsePositiveInt(
  import.meta.env.VITE_CHAT_MAX_CACHED_MESSAGES_PER_CONVERSATION,
  200,
);

export const CHAT_CACHED_CONVERSATIONS_LIMIT = parsePositiveInt(
  import.meta.env.VITE_CHAT_CACHED_CONVERSATIONS_LIMIT,
  10,
);

export const MEDIA_LAZY_ROOT_MARGIN = String(
  import.meta.env.VITE_MEDIA_LAZY_ROOT_MARGIN || '300px',
).trim();

const parseBoolean = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
};

export const ENABLE_SSE_REALTIME = parseBoolean(import.meta.env.VITE_ENABLE_SSE_REALTIME, false);
export const ENABLE_CHAT_VIRTUALIZATION = parseBoolean(import.meta.env.VITE_ENABLE_CHAT_VIRTUALIZATION, true);
export const ENABLE_NEW_CHAT_DATA_LAYER = parseBoolean(import.meta.env.VITE_ENABLE_NEW_CHAT_DATA_LAYER, false);
export const ENABLE_CHECKOUT_RENEWAL_WORKER = parseBoolean(
  import.meta.env.VITE_CHECKOUT_RENEWAL_WORKER_ENABLED,
  true,
);

export const CONVERSATION_BACKGROUND_SUMMARY_LIMIT = parsePositiveInt(
  import.meta.env.VITE_CONVERSATION_BACKGROUND_SUMMARY_LIMIT,
  1000,
);

export const BACKGROUND_REFRESH_INTERVAL_MS = parsePositiveInt(
  import.meta.env.VITE_BACKGROUND_REFRESH_INTERVAL_MS,
  60000,
);

export const AUTH_REFRESH_INTERVAL_MS = parsePositiveInt(
  import.meta.env.VITE_AUTH_REFRESH_INTERVAL_MS,
  60000,
);

export const CUSTOMER_CACHE_REFRESH_INTERVAL_MS = parsePositiveInt(
  import.meta.env.VITE_CUSTOMER_CACHE_REFRESH_INTERVAL_MS,
  120000,
);

export const NOTIFICATION_SETTINGS_REFRESH_INTERVAL_MS = parsePositiveInt(
  import.meta.env.VITE_NOTIFICATION_SETTINGS_REFRESH_INTERVAL_MS,
  60000,
);

export const CHATBOT_RUNTIME_REFRESH_INTERVAL_MS = parsePositiveInt(
  import.meta.env.VITE_CHATBOT_RUNTIME_REFRESH_INTERVAL_MS,
  30000,
);

export const SERVICES_REFRESH_INTERVAL_MS = BACKGROUND_REFRESH_INTERVAL_MS;
export const SCHEDULES_REFRESH_INTERVAL_MS = BACKGROUND_REFRESH_INTERVAL_MS;
export const PRESENCE_REFRESH_INTERVAL_MS = BACKGROUND_REFRESH_INTERVAL_MS;
