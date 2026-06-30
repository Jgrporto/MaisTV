/// <reference types="vite/client" />

const normalizeBaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

const isLocalBrowser = () =>
  typeof window !== 'undefined' && ['127.0.0.1', 'localhost'].includes(window.location.hostname);

export const resolveChatApiBaseUrl = () => {
  const configured = normalizeBaseUrl(import.meta.env.VITE_CHAT_API_BASE_URL);
  if (configured) return configured;
  if (isLocalBrowser() && window.location.port !== '5053') return `${window.location.protocol}//127.0.0.1:5053`;
  return '';
};

export const buildChatApiUrl = (path) => `${resolveChatApiBaseUrl()}${path}`;

export const buildChatSseUrl = ({ conversationIds = [] } = {}) => {
  const configured = normalizeBaseUrl(import.meta.env.VITE_SSE_URL);
  const baseUrl = configured
    ? `${configured}/api/events`
    : isLocalBrowser()
      ? `${window.location.protocol}//127.0.0.1:5055/api/events`
      : '/api/events';
  const normalizedIds = Array.from(new Set(
    (Array.isArray(conversationIds) ? conversationIds : [conversationIds])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )).slice(0, 10);
  if (!normalizedIds.length) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}conversations=${encodeURIComponent(normalizedIds.join(','))}`;
};

export const requestChatJson = async (path, options = {}) => {
  const response = await fetch(buildChatApiUrl(path), { credentials: 'include', ...options });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Compatibility and health endpoints may return an empty response.
  }
  if (!response.ok) {
    throw Object.assign(new Error(data?.message || data?.error || `Falha na requisicao ${path}`), {
      status: response.status,
      payload: data,
      path,
    });
  }
  return data;
};
