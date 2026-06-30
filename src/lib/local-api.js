const DEFAULT_LOCAL_API_BASE_URL = '/api/local';

export const LOCAL_AUTH_UNAUTHORIZED_EVENT = 'saastv:auth:unauthorized';

const canUseBrowser = () => typeof window !== 'undefined';

export const resolveLocalApiBaseUrl = () => {
  const configuredBaseUrl = String(import.meta.env.VITE_LOCAL_API_BASE_URL || '').trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, '');
  }

  if (canUseBrowser()) {
    const { hostname, port, protocol } = window.location;
    if ((hostname === '127.0.0.1' || hostname === 'localhost') && port && port !== '5053') {
      return `${protocol}//127.0.0.1:5053/api/local`;
    }
  }

  return DEFAULT_LOCAL_API_BASE_URL;
};

export const buildLocalApiUrl = (path) => {
  const baseUrl = resolveLocalApiBaseUrl();
  return baseUrl ? `${baseUrl}${path}` : path;
};

export const parseJsonResponse = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export const emitLocalAuthUnauthorized = (detail = {}) => {
  if (!canUseBrowser()) {
    return;
  }

  window.dispatchEvent(new CustomEvent(LOCAL_AUTH_UNAUTHORIZED_EVENT, { detail }));
};

export const subscribeToLocalAuthUnauthorized = (callback) => {
  if (!canUseBrowser()) {
    return () => {};
  }

  const handler = (event) => callback(event?.detail || {});
  window.addEventListener(LOCAL_AUTH_UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(LOCAL_AUTH_UNAUTHORIZED_EVENT, handler);
};

export const requestLocalApi = async (path, options = {}) => {
  const { timeoutMs, signal, ...fetchOptions } = options || {};
  const timeout = Number(timeoutMs);
  const shouldTimeout = Number.isFinite(timeout) && timeout > 0;
  const controller = shouldTimeout ? new AbortController() : null;
  let timeoutId = null;
  let abortHandler = null;

  if (controller) {
    timeoutId = globalThis.setTimeout(() => controller.abort(), timeout);
    if (signal) {
      abortHandler = () => controller.abort();
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    }
  }

  const response = await fetch(buildLocalApiUrl(path), {
    credentials: 'include',
    ...fetchOptions,
    signal: controller?.signal || signal,
  }).finally(() => {
    if (timeoutId) {
      globalThis.clearTimeout(timeoutId);
    }
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
  });

  if (response.status === 401) {
    emitLocalAuthUnauthorized({ path, method: fetchOptions?.method || 'GET' });
  }

  return response;
};

export const requestLocalApiJson = async (path, options = {}, fallbackMessage = 'Falha na requisição local.') => {
  const response = await requestLocalApi(path, options);
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    const error = new Error(data?.error || fallbackMessage);
    error.status = response.status;
    error.code = data?.code;
    error.payload = data?.payload;
    throw error;
  }

  if (response.status !== 204 && data == null) {
    throw new Error('Resposta inválida da API local.');
  }

  return data;
};
