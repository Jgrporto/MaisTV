import { parseJsonResponse, requestLocalApi } from '@/lib/local-api';
export const DEFAULT_NEWBR_BROWSER_BASE_URL =
  String(import.meta.env.VITE_NEWBR_SYNC_BASE_URL || 'https://painel.newbr.top')
    .trim()
    .replace(/\/+$/, '');
export const DEFAULT_NEWBR_BROWSER_USERNAME =
  String(import.meta.env.VITE_NEWBR_SYNC_USERNAME || 'suportemaistv').trim();
export const DEFAULT_NEWBR_BROWSER_PASSWORD =
  String(import.meta.env.VITE_NEWBR_SYNC_PASSWORD || 'suporte+TV1');

const requestLocalApiJson = async (path, options = {}) => {
  const response = await requestLocalApi(path, options);
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || `Falha na requisicao ${path}`);
  }

  return data;
};

export const fetchPersistedCustomers = async () => {
  return await requestLocalApiJson('/customers', { method: 'GET' });
};

export const fetchAllPersistedCustomers = async ({ limit = 200 } = {}) => {
  const safeLimit = Math.min(200, Math.max(1, Number.parseInt(String(limit), 10) || 200));
  const rows = [];
  let sync = null;
  let page = 1;

  while (true) {
    const data = await requestLocalApiJson(`/customers?page=${page}&limit=${safeLimit}`, { method: 'GET' });
    const pageRows = Array.isArray(data?.rows) ? data.rows : [];
    rows.push(...pageRows);
    sync = data?.sync || sync;

    if (!data?.hasMore || pageRows.length === 0) {
      return {
        ...data,
        rows,
        sync,
        page: 1,
        limit: safeLimit,
        total: Number.isFinite(Number(data?.total)) ? Number(data.total) : rows.length,
        hasMore: false,
      };
    }

    page += 1;
  }
};

export const fetchCustomerSyncState = async () => {
  return await requestLocalApiJson('/customers/sync', { method: 'GET' });
};

export const markCustomerBrowserSyncStarted = async (payload = {}) => {
  return await requestLocalApiJson('/customers/sync/browser-start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
};

export const startCustomerSync = async (payload = {}) => {
  return await requestLocalApiJson('/customers/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
};

export const fetchCustomerSyncLogs = async () => {
  return await requestLocalApiJson('/customers/logs?limit=50', { method: 'GET' });
};

export const fetchNewbrBrowserAuthConfig = async () => {
  const data = await requestLocalApiJson('/newbr/browser-auth-config', { method: 'GET' });
  return {
    baseUrl: String(data?.baseUrl || DEFAULT_NEWBR_BROWSER_BASE_URL).trim() || DEFAULT_NEWBR_BROWSER_BASE_URL,
    username: String(data?.username || DEFAULT_NEWBR_BROWSER_USERNAME).trim() || DEFAULT_NEWBR_BROWSER_USERNAME,
    password: String(data?.password || DEFAULT_NEWBR_BROWSER_PASSWORD),
    source: String(data?.source || '').trim(),
    configured: data?.configured !== false,
  };
};

export const importCollectedCustomers = async (payload) => {
  return await requestLocalApiJson('/customers/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
};

export const reportCustomerBrowserSyncFailure = async (payload = {}) => {
  return await requestLocalApiJson('/customers/sync/browser-failure', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
};

const parseJsonLike = (raw) => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { raw };
  }
};

const looksLikeCloudflareHtml = (raw) => {
  const snippet = String(raw || '')
    .slice(0, 4000)
    .toLowerCase();

  return [
    'just a moment',
    'cloudflare',
    'cf-browser-verification',
    'challenge-platform',
    'attention required',
  ].some((marker) => snippet.includes(marker));
};

const resolveBearerToken = (payload) => {
  if (!payload || typeof payload !== 'object') return '';
  const source = payload;
  const data = source.data && typeof source.data === 'object' ? source.data : {};
  const result = source.result && typeof source.result === 'object' ? source.result : {};
  const candidates = [
    source.token,
    source.access_token,
    source.accessToken,
    source.bearer,
    source.bearerToken,
    data.token,
    data.access_token,
    data.accessToken,
    result.token,
    result.access_token,
  ];

  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const normalized = value.replace(/^Bearer\s+/i, '').trim();
    if (normalized) return normalized;
  }

  return '';
};

const extractRowsFromCustomersPayload = (payload) => {
  if (Array.isArray(payload)) {
    return payload.filter((row) => row && typeof row === 'object');
  }

  if (payload && typeof payload === 'object') {
    for (const key of ['data', 'rows', 'items', 'customers', 'results']) {
      const value = payload[key];
      if (Array.isArray(value)) {
        return value.filter((row) => row && typeof row === 'object');
      }
    }

    if (payload.data && typeof payload.data === 'object') {
      for (const key of ['data', 'rows', 'items', 'customers', 'results']) {
        const value = payload.data[key];
        if (Array.isArray(value)) {
          return value.filter((row) => row && typeof row === 'object');
        }
      }
    }
  }

  return [];
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

const extractMetaContainer = (payload) => {
  if (payload && typeof payload === 'object') {
    if (payload.meta && typeof payload.meta === 'object') return payload.meta;
    if (payload.data && typeof payload.data === 'object' && payload.data.meta && typeof payload.data.meta === 'object') {
      return payload.data.meta;
    }
  }
  return {};
};

const extractLastPageFromPayload = (payload) => {
  const meta = extractMetaContainer(payload);
  const value = findNumberDeep(meta, ['last_page', 'lastPage']) ?? findNumberDeep(payload, ['last_page', 'lastPage']);
  return value != null ? Number(value) : null;
};

const defaultLoginPayloads = (username, password) => [
  {
    captcha: 'not-a-robot',
    captchaChecked: true,
    username,
    password,
    twofactor_code: '',
    twofactor_recovery_code: '',
    twofactor_trusted_device_id: '',
  },
  {
    username,
    password,
    captcha: '',
    twofactor: '',
  },
];

export const authenticateNewbrInBrowser = async ({
  baseUrl = DEFAULT_NEWBR_BROWSER_BASE_URL,
  username,
  password,
  signal,
} = {}) => {
  const sanitizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!sanitizedBaseUrl) {
    throw new Error('Base URL do NewBr nao informada.');
  }
  if (!String(username || '').trim() || !String(password || '').trim()) {
    throw new Error('Informe usuario e senha do NewBr.');
  }

  let bearerToken = '';
  let lastLoginError = null;

  for (const payload of defaultLoginPayloads(String(username || '').trim(), String(password || ''))) {
    const loginResponse = await fetch(`${sanitizedBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });

    const loginRaw = await loginResponse.text();
    const loginPayload = parseJsonLike(loginRaw);

    if (!loginResponse.ok) {
      if (looksLikeCloudflareHtml(loginRaw)) {
        lastLoginError =
          'Cloudflare bloqueou o login no navegador. Abra o painel NewBr neste mesmo navegador, conclua o desafio e tente novamente.';
        continue;
      }

      lastLoginError =
        typeof loginPayload === 'object'
          ? JSON.stringify(loginPayload)
          : loginRaw || `Falha no login (${loginResponse.status}).`;
      continue;
    }

    if (looksLikeCloudflareHtml(loginRaw)) {
      lastLoginError =
        'Cloudflare devolveu HTML no lugar do JSON de login. Abra o painel NewBr neste mesmo navegador, conclua o desafio e tente novamente.';
      continue;
    }

    bearerToken = resolveBearerToken(loginPayload);
    if (bearerToken) {
      break;
    }

    lastLoginError = 'Token Bearer nao encontrado no retorno do login.';
  }

  if (!bearerToken) {
    throw new Error(
      `Falha no login do NewBr pelo navegador. Abra o painel nesse mesmo navegador e refaca a tentativa. Detalhe: ${lastLoginError || 'sem retorno valido'}`,
    );
  }

  return {
    baseUrl: sanitizedBaseUrl,
    token: bearerToken,
    capturedAt: new Date().toISOString(),
    source: 'browser-login',
  };
};

export const collectNewbrCustomersInBrowser = async ({
  baseUrl = DEFAULT_NEWBR_BROWSER_BASE_URL,
  username,
  password,
  perPage = 100,
  maxPages = 500,
  signal,
  onProgress,
} = {}) => {
  const sanitizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!sanitizedBaseUrl) {
    throw new Error('Base URL do NewBr nao informada.');
  }
  if (!String(username || '').trim() || !String(password || '').trim()) {
    throw new Error('Informe usuario e senha do NewBr.');
  }

  const auth = await authenticateNewbrInBrowser({
    baseUrl: sanitizedBaseUrl,
    username,
    password,
    signal,
  });
  const bearerToken = auth.token;

  onProgress?.('Coletando base paginada de clientes pelo navegador...');

  const rows = [];
  let page = 1;
  let pagesLoaded = 0;
  let lastPage = null;

  while (page <= maxPages) {
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
      perPage: String(perPage),
    });

    const response = await fetch(`${sanitizedBaseUrl}/api/customers?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
      signal,
    });

    const raw = await response.text();
    const payload = parseJsonLike(raw);

    if (looksLikeCloudflareHtml(raw)) {
      throw new Error(
        'Cloudflare voltou a interceptar a sessao durante a leitura dos clientes. Reabra o painel NewBr neste navegador e tente novamente.',
      );
    }

    if (!response.ok) {
      throw new Error(
        `Falha ao carregar pagina ${page} (${response.status}). Abra o painel nesse navegador para renovar a sessao e tente novamente.`,
      );
    }

    const pageRows = extractRowsFromCustomersPayload(payload);
    if (lastPage === null) {
      lastPage = extractLastPageFromPayload(payload);
    }

    pagesLoaded += 1;

    if (!pageRows.length) {
      onProgress?.(`Pagina ${page}: sem registros. Encerrando.`);
      break;
    }

    rows.push(...pageRows);
    onProgress?.(`Pagina ${page}: +${pageRows.length} cliente(s), total ${rows.length}.`);

    if (lastPage && page >= lastPage) {
      break;
    }

    page += 1;
  }

  return {
    rows,
    pagesLoaded,
    lastPage,
    totalRows: rows.length,
    source: 'browser-newbr',
    mode: 'browser_manual',
    auth,
  };
};
