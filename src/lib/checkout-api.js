const DEFAULT_PRODUCTION_API_BASE_URL = 'https://api.maistv.hakione.tech';

const normalizeBaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

const canUseBrowser = () => typeof window !== 'undefined';

const resolveApiHostFromLocation = () => {
  if (!canUseBrowser()) {
    return DEFAULT_PRODUCTION_API_BASE_URL;
  }

  const { hostname, protocol } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return '';
  }

  const cleanHost = hostname.replace(/^www\./i, '');
  if (cleanHost === 'maistv.hakione.tech') {
    return `${protocol}//api.maistv.hakione.tech`;
  }

  return `${protocol}//${cleanHost}`;
};

export const resolveCheckoutTokenApiBaseUrl = () => {
  const configured = normalizeBaseUrl(import.meta.env.VITE_CHECKOUT_TOKEN_API_BASE_URL);
  if (configured) return configured;

  if (canUseBrowser()) {
    const { hostname } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://127.0.0.1:5050';
    }
  }

  return normalizeBaseUrl(resolveApiHostFromLocation());
};

export const resolveCheckoutPaymentsApiBaseUrl = () => {
  const configured = normalizeBaseUrl(import.meta.env.VITE_CHECKOUT_PAYMENTS_API_BASE_URL);
  if (configured) return configured;

  if (canUseBrowser()) {
    const { hostname } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://127.0.0.1:5051';
    }
  }

  return normalizeBaseUrl(resolveApiHostFromLocation());
};

const buildUrl = (baseUrl, path) => {
  const base = normalizeBaseUrl(baseUrl);
  return base ? `${base}${path}` : path;
};

const parseJsonResponse = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const requestJson = async (baseUrl, path, options = {}, fallbackMessage = 'Falha na requisicao.') => {
  const response = await fetch(buildUrl(baseUrl, path), {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || fallbackMessage);
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data;
};

export const resolveCheckoutToken = async (token) => {
  const params = new URLSearchParams({ token });
  return requestJson(
    resolveCheckoutTokenApiBaseUrl(),
    `/api/checkout/resolve?${params.toString()}`,
    { method: 'GET' },
    'Token de checkout invalido ou expirado.',
  );
};

export const fetchMercadoPagoConfig = async () =>
  requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    '/api/mercadopago/config',
    { method: 'GET' },
    'Nao foi possivel carregar a configuracao do Mercado Pago.',
  );

export const createMercadoPagoPreference = async (payload) =>
  requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    '/api/mercadopago/preference',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    'Nao foi possivel iniciar o pagamento.',
  );

export const createPixPayment = async (payload) =>
  requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    '/api/mercadopago/pix',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    'Nao foi possivel gerar o Pix.',
  );

export const notifyCheckoutNewbrBrowserStart = async (payload) =>
  requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    '/api/checkout/newbr/browser-start',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    'Nao foi possivel iniciar a preparacao NewBR.',
  );

export const saveCheckoutNewbrBrowserToken = async (payload) =>
  requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    '/api/checkout/newbr/browser-token',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    'Nao foi possivel salvar o token NewBR.',
  );

export const saveCheckoutRenewalIntent = async (payload) =>
  requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    '/api/checkout/renewals/intent',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    'Nao foi possivel registrar a intencao de renovacao.',
  );

export const fetchCheckoutRenewalCheckoutStatus = async (token) => {
  const params = new URLSearchParams({ token });
  return requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    `/api/checkout/renewals/checkout-status?${params.toString()}`,
    { method: 'GET' },
    'Nao foi possivel consultar o status do pagamento.',
  );
};

export const saveCheckoutBrowserRenewalResult = async (payload) =>
  requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    '/api/checkout/newbr/browser-renewal-result',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    'Nao foi possivel salvar o resultado da renovacao.',
  );

export const claimCheckoutRenewals = async (payload = {}) =>
  requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    '/api/checkout/renewals/claim',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    'Nao foi possivel buscar renovacoes pendentes.',
  );

export const completeCheckoutRenewal = async (payload = {}) =>
  requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    '/api/checkout/renewals/complete',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    'Nao foi possivel concluir a renovacao pendente.',
  );

export const createCardPayment = async (payload) =>
  requestJson(
    resolveCheckoutPaymentsApiBaseUrl(),
    '/api/mercadopago/card',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    'Nao foi possivel processar o cartao.',
  );
