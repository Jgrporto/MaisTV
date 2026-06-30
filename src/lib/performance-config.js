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
  120000,
);

export const CONVERSATION_SUMMARY_LIMIT = parsePositiveInt(
  import.meta.env.VITE_CONVERSATION_SUMMARY_LIMIT,
  500,
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
