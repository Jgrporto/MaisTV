import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number.parseInt(process.env.CHECKOUT_SERVER_PORT || "5051", 10);
const ALLOWED_ORIGIN = process.env.CHECKOUT_ALLOWED_ORIGIN || "*";
const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const MERCADOPAGO_PUBLIC_KEY = process.env.MERCADOPAGO_PUBLIC_KEY;
const MERCADOPAGO_DEFAULT_DESCRIPTION =
  process.env.MERCADOPAGO_DEFAULT_DESCRIPTION || "Plano Teste";
const MERCADOPAGO_NOTIFICATION_URL = process.env.MERCADOPAGO_NOTIFICATION_URL || "";
const MERCADOPAGO_CHECKOUT_BACK_URL = process.env.MERCADOPAGO_CHECKOUT_BACK_URL || "";
const MERCADOPAGO_API_BASE_URL = process.env.MERCADOPAGO_API_BASE_URL || "https://api.mercadopago.com";
const CHECKOUT_WHATSAPP_API_URL = process.env.CHECKOUT_WHATSAPP_API_URL || "http://localhost:5050";
const CHECKOUT_RENEWAL_DISABLED =
  String(process.env.CHECKOUT_RENEWAL_DISABLED || "").toLowerCase() === "true";
const CHECKOUT_NOTIFY_PHONE = process.env.CHECKOUT_NOTIFY_PHONE || "5524999157259";
const CHECKOUT_RENEWAL_STORE_PATH =
  process.env.CHECKOUT_RENEWAL_STORE_PATH || "server/data/checkout-renewals.json";
const CHECKOUT_RENEWAL_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.CHECKOUT_RENEWAL_MAX_ATTEMPTS || "1", 10) || 1,
);
const CHECKOUT_RENEWAL_AUTH_TTL_HOURS = Math.max(
  1,
  Number.parseInt(process.env.CHECKOUT_RENEWAL_AUTH_TTL_HOURS || "6", 10) || 6,
);
const CHECKOUT_RENEWAL_MAX_DAYS = Number.parseInt(
  process.env.CHECKOUT_RENEWAL_MAX_DAYS || "60",
  10,
);
const CHECKOUT_RENEWAL_MAX_ITEMS = Number.parseInt(
  process.env.CHECKOUT_RENEWAL_MAX_ITEMS || "5000",
  10,
);
const CHECKOUT_RENEW_LOG_PATH =
  process.env.CHECKOUT_RENEW_LOG_PATH || "server/data/painel-renew-log.json";
const CHECKOUT_TOKEN_STORE_PATH =
  process.env.CHECKOUT_TOKEN_STORE_PATH || "server/data/checkout-tokens.json";
const CHECKOUT_RENEW_LOG_LIMIT = Number.parseInt(
  process.env.CHECKOUT_RENEW_LOG_LIMIT || "300",
  10,
);
const NEWBR_CHECKOUT_BASE_URL = String(
  process.env.NEWBR_CHECKOUT_BASE_URL ||
    process.env.PANEL_NEWBR_BASE_URL ||
    process.env.VITE_NEWBR_BASE_URL ||
    "https://painel.newbr.top",
)
  .trim()
  .replace(/\/+$/, "");
const NEWBR_CHECKOUT_USERNAME = String(
  process.env.NEWBR_CHECKOUT_USERNAME ||
    process.env.VITE_NEWBR_USERNAME ||
    "",
).trim();
const NEWBR_CHECKOUT_PASSWORD = String(
  process.env.NEWBR_CHECKOUT_PASSWORD ||
    process.env.VITE_NEWBR_PASSWORD ||
    "",
).trim();
const NEWBR_CHECKOUT_TOKEN_CACHE_MS = Number.parseInt(
  process.env.NEWBR_CHECKOUT_TOKEN_CACHE_MS || "600000",
  10,
);
const CHECKOUT_RENEWAL_QUEUE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.CHECKOUT_RENEWAL_QUEUE_CONCURRENCY || "3", 10) || 3,
);
const CHECKOUT_RENEWAL_QUEUE_MAX_SIZE = Math.max(
  1,
  Number.parseInt(process.env.CHECKOUT_RENEWAL_QUEUE_MAX_SIZE || "2000", 10) || 2000,
);
const CHECKOUT_RECONCILE_ENABLED =
  String(process.env.CHECKOUT_RECONCILE_ENABLED || "true").toLowerCase() !== "false";
const CHECKOUT_RECONCILE_INTERVAL_MS = Math.max(
  15_000,
  Number.parseInt(process.env.CHECKOUT_RECONCILE_INTERVAL_MS || "45000", 10) || 45000,
);
const CHECKOUT_RECONCILE_MIN_INTERVAL_MS = Math.max(
  5_000,
  Number.parseInt(process.env.CHECKOUT_RECONCILE_MIN_INTERVAL_MS || "15000", 10) || 15000,
);
const CHECKOUT_RECONCILE_LOOKBACK_HOURS = Math.max(
  1,
  Number.parseInt(process.env.CHECKOUT_RECONCILE_LOOKBACK_HOURS || "24", 10) || 24,
);
const CHECKOUT_RECONCILE_LIMIT = Math.max(
  1,
  Math.min(200, Number.parseInt(process.env.CHECKOUT_RECONCILE_LIMIT || "100", 10) || 100),
);
const CHECKOUT_BROWSER_WORKER_CLAIM_TTL_MS = Math.max(
  30_000,
  Number.parseInt(process.env.CHECKOUT_BROWSER_WORKER_CLAIM_TTL_MS || "300000", 10) || 300000,
);
const CHECKOUT_BROWSER_WORKER_RETRY_BASE_MS = Math.max(
  15_000,
  Number.parseInt(process.env.CHECKOUT_BROWSER_WORKER_RETRY_BASE_MS || "60000", 10) || 60000,
);
const CHECKOUT_BROWSER_WORKER_RETRY_MAX_MS = Math.max(
  CHECKOUT_BROWSER_WORKER_RETRY_BASE_MS,
  Number.parseInt(process.env.CHECKOUT_BROWSER_WORKER_RETRY_MAX_MS || "900000", 10) || 900000,
);
const CHECKOUT_BROWSER_WORKER_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.CHECKOUT_BROWSER_WORKER_MAX_ATTEMPTS || "2", 10) || 2,
);

let newbrAuthCache = null;

const renewQueue = [];
let renewQueueActive = 0;
const inFlightPaymentLocks = new Set();
let reconcileRunningPromise = null;
let reconcileLastRunAt = 0;
let renewalStoreMutation = Promise.resolve();

const withRenewalStoreMutation = (task) => {
  const run = renewalStoreMutation.then(task, task);
  renewalStoreMutation = run.catch(() => {});
  return run;
};

const pumpRenewQueue = () => {
  while (renewQueueActive < CHECKOUT_RENEWAL_QUEUE_CONCURRENCY && renewQueue.length > 0) {
    const next = renewQueue.shift();
    renewQueueActive += 1;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        renewQueueActive = Math.max(0, renewQueueActive - 1);
        pumpRenewQueue();
      });
  }
};

const enqueueRenewal = (task) =>
  new Promise((resolve, reject) => {
    if (renewQueue.length >= CHECKOUT_RENEWAL_QUEUE_MAX_SIZE) {
      reject(new Error("Fila de renovacao lotada"));
      return;
    }
    renewQueue.push({ task, resolve, reject });
    pumpRenewQueue();
  });

const tryLockPayment = (paymentKey) => {
  if (inFlightPaymentLocks.has(paymentKey)) return false;
  inFlightPaymentLocks.add(paymentKey);
  return true;
};

const unlockPayment = (paymentKey) => {
  inFlightPaymentLocks.delete(paymentKey);
};

const setCors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
  });

const safeReadJsonFile = async (filePath, fallback) => {
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
      await fs.rename(filePath, `${filePath}.corrupt-${suffix}`);
    } catch {
      // ignore rename errors, we'll reset the file
    }
    return fallback;
  }
};

const normalizeDigits = (value) => String(value || "").replace(/\D/g, "");

const toNullableString = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const parseUnknownJson = (raw) => {
  if (!raw || typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
};

const resolvePayloadErrorMessage = (payload, fallback) => {
  if (!payload || typeof payload !== "object") return fallback;
  const source = payload;
  const candidates = [
    source.error,
    source.message,
    source.error_description,
    source.msg,
    source.detail,
    source.raw,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const nested = resolvePayloadErrorMessage(candidate, "");
      if (nested) return nested;
    }
  }
  return fallback;
};

const resolveBearerFromPayload = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  const source = payload;
  const nested =
    source.data && typeof source.data === "object"
      ? source.data
      : source.result && typeof source.result === "object"
        ? source.result
        : null;
  const candidates = [
    source.token,
    source.access_token,
    source.bearer,
    nested?.token,
    nested?.access_token,
    nested?.bearer,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
};

const clearNewbrAuthCache = () => {
  newbrAuthCache = null;
};

const buildNewbrCredentialKey = ({ username }) =>
  `${NEWBR_CHECKOUT_BASE_URL}|${String(username || "").trim().toLowerCase()}`;

const loginNewbr = async ({ username, password } = {}) => {
  const safeUsername = String(username || "").trim();
  const safePassword = String(password || "");
  if (!safeUsername || !safePassword) {
    throw new Error("Credenciais NewBR ausentes para renovacao via checkout.");
  }

  const loginPayloads = [
    {
      captcha: "not-a-robot",
      captchaChecked: true,
      username: safeUsername,
      password: safePassword,
      twofactor_code: "",
      twofactor_recovery_code: "",
      twofactor_trusted_device_id: "",
    },
    { username: safeUsername, password: safePassword, captchaToken: "", twofactor: "" },
    { username: safeUsername, password: safePassword, captcha: null, twofactor: null },
  ];
  let lastError = null;

  for (const payload of loginPayloads) {
    const response = await fetch(`${NEWBR_CHECKOUT_BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        locale: "pt",
      },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    const data = parseUnknownJson(raw);
    if (!response.ok) {
      lastError = new Error(resolvePayloadErrorMessage(data, `Falha no login NewBR (${response.status})`));
      continue;
    }
    const token = resolveBearerFromPayload(data);
    if (!token) {
      lastError = new Error("Token Bearer nao encontrado no login NewBR.");
      continue;
    }
    return {
      token,
      username: safeUsername,
      expiresAt: new Date(
        Date.now() + CHECKOUT_RENEWAL_AUTH_TTL_HOURS * 60 * 60 * 1000,
      ).toISOString(),
    };
  }

  throw lastError || new Error("Falha no login NewBR.");
};

const ensureNewbrToken = async ({ forceRefresh = false, authorization = null, credentials = null } = {}) => {
  const auth = authorization && typeof authorization === "object" ? authorization : null;
  const authToken = String(auth?.bearerToken || auth?.token || "").trim();
  const authExpiresAt = Date.parse(String(auth?.expiresAt || ""));
  if (!forceRefresh && authToken && Number.isFinite(authExpiresAt) && authExpiresAt > Date.now()) {
    return authToken;
  }

  const username = String(credentials?.username || auth?.username || NEWBR_CHECKOUT_USERNAME || "").trim();
  const password = String(credentials?.password || NEWBR_CHECKOUT_PASSWORD || "");
  if (!username || !password) {
    throw new Error("Autorizacao NewBR ausente ou expirada para renovacao via checkout.");
  }

  const cacheKey = buildNewbrCredentialKey({ username });
  if (
    !forceRefresh &&
    newbrAuthCache &&
    newbrAuthCache.expiresAt > Date.now() &&
    newbrAuthCache.cacheKey === cacheKey
  ) {
    return newbrAuthCache.token;
  }

  const login = await loginNewbr({ username, password });
  newbrAuthCache = {
    cacheKey,
    token: login.token,
    expiresAt: Date.now() + Math.max(60_000, NEWBR_CHECKOUT_TOKEN_CACHE_MS || 600000),
  };
  return login.token;
};

const requestNewbr = async (
  apiPath,
  { method = "GET", body, retryAuth = true, authorization = null, credentials = null } = {},
) => {
  const token = await ensureNewbrToken({ authorization, credentials });
  const response = await fetch(`${NEWBR_CHECKOUT_BASE_URL}${apiPath}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      Locale: "pt",
      "X-App-Version": "3.81",
      Origin: NEWBR_CHECKOUT_BASE_URL,
      Referer: `${NEWBR_CHECKOUT_BASE_URL}/`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  const payload = parseUnknownJson(raw);

  if ((response.status === 401 || response.status === 403) && retryAuth) {
    clearNewbrAuthCache();
    return requestNewbr(apiPath, { method, body, retryAuth: false, authorization: null, credentials });
  }

  if (!response.ok) {
    const message = resolvePayloadErrorMessage(payload, `NewBR request falhou (${response.status})`);
    throw new Error(message);
  }

  return payload;
};

const extractRowsFromPayload = (payload) => {
  if (!payload || typeof payload !== "object") return [];
  const source = payload;
  const roots = [source, source.data, source.result].filter(Boolean);
  for (const root of roots) {
    if (Array.isArray(root)) return root;
    if (!root || typeof root !== "object") continue;
    for (const key of ["rows", "items", "customers", "data", "results"]) {
      const value = root[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
};

const extractLastPageFromPayload = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  const source = payload;
  const candidates = [
    source?.meta?.last_page,
    source?.meta?.lastPage,
    source?.pagination?.last_page,
    source?.pagination?.lastPage,
    source?.last_page,
    source?.lastPage,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const mapRawCustomerRow = (row) => ({
  phone: toNullableString(row?.whatsapp || row?.phone || row?.telefone || row?.mobile) || "",
  customerId: toNullableString(row?.customerId || row?.customer_id || row?.id),
  id: toNullableString(row?.id || row?.customerId || row?.customer_id),
  username: toNullableString(row?.username || row?.usuario || row?.user || row?.login),
  usuario: toNullableString(row?.usuario || row?.username || row?.user || row?.login),
  packageId: toNullableString(row?.packageId || row?.package_id || row?.package?.id),
  package_id: toNullableString(row?.package_id || row?.packageId || row?.package?.id),
  packageName: toNullableString(
    row?.packageName ||
      row?.package_name ||
      row?.package?.name ||
      row?.planName ||
      row?.planoAtual,
  ),
  planoAtual: toNullableString(
    row?.planoAtual ||
      row?.packageName ||
      row?.package_name ||
      row?.package?.name ||
      row?.planName,
  ),
  connections:
    Number.isFinite(Number(row?.connections)) && Number(row?.connections) >= 0
      ? Number(row.connections)
      : null,
  conexoes:
    Number.isFinite(Number(row?.connections)) && Number(row?.connections) >= 0
      ? Number(row.connections)
      : null,
  status: toNullableString(row?.status || row?.situacao),
  situacao: toNullableString(row?.situacao || row?.status),
  valor: toNullableString(row?.valor || row?.price || row?.amount),
  expiresAtTz: toNullableString(row?.expiresAtTz || row?.expires_at_tz),
  expiresAt: toNullableString(row?.expiresAt || row?.expires_at),
  vencimento: toNullableString(row?.vencimento || row?.expiresAtTz || row?.expiresAt),
  whatsapp: toNullableString(row?.whatsapp || row?.phone || row?.telefone || row?.mobile),
});

const rowMatchesPhone = (row, normalizedPhone) => {
  const candidates = [
    row?.whatsapp,
    row?.phone,
    row?.telefone,
    row?.mobile,
    row?.contact,
    row?.username,
    row?.usuario,
  ];
  for (const candidate of candidates) {
    const digits = normalizeDigits(candidate);
    if (!digits) continue;
    if (digits === normalizedPhone) return true;
    if (digits.endsWith(normalizedPhone)) return true;
    if (normalizedPhone.endsWith(digits)) return true;
  }
  return false;
};

const findCustomerByPhoneFromNewbr = async (rawPhone, authContext = {}) => {
  const normalizedPhone = normalizeDigits(rawPhone);
  if (!normalizedPhone) return null;

  const searchTerms = [
    normalizedPhone,
    normalizedPhone.startsWith("55") ? normalizedPhone.slice(2) : "",
  ].filter(Boolean);

  for (const search of searchTerms) {
    const params = new URLSearchParams({
      page: "1",
      username: search,
      serverId: "",
      packageId: "",
      expiryFrom: "",
      expiryTo: "",
      status: "",
      isTrial: "",
      connections: "",
      perPage: "100",
    });
    const payload = await requestNewbr(`/api/customers?${params.toString()}`, authContext);
    const rows = extractRowsFromPayload(payload);
    const found = rows.find((row) => rowMatchesPhone(row, normalizedPhone));
    if (found) return mapRawCustomerRow(found);
    if (rows.length === 1) return mapRawCustomerRow(rows[0]);
  }

  let page = 1;
  let lastPage = null;
  while (page <= 50) {
    const params = new URLSearchParams({
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
    const payload = await requestNewbr(`/api/customers?${params.toString()}`, authContext);
    const rows = extractRowsFromPayload(payload);
    if (lastPage === null) {
      lastPage = extractLastPageFromPayload(payload);
    }
    const found = rows.find((row) => rowMatchesPhone(row, normalizedPhone));
    if (found) return mapRawCustomerRow(found);
    if (!rows.length) break;
    if (lastPage && page >= lastPage) break;
    page += 1;
  }
  return null;
};

const renewViaNewbrApi = async ({
  phone,
  planMonths,
  planLabel,
  connections,
  customerId,
  packageId,
  authorization = null,
  credentials = null,
}) => {
  const normalizedPhone = normalizeDigits(phone);
  if (!normalizedPhone) {
    throw new Error("Telefone invalido para renovacao.");
  }

  let resolvedCustomerId = String(customerId || "").trim();
  let resolvedPackageId = String(packageId || "").trim();

  const customer = await findCustomerByPhoneFromNewbr(normalizedPhone, { authorization, credentials }).catch(() => null);

if (customer) {
  resolvedCustomerId = String(customer.customerId || customer.id || "").trim() || resolvedCustomerId;
  resolvedPackageId = resolvedPackageId || String(customer.packageId || customer.package_id || "").trim();
}

  if (!resolvedCustomerId || !resolvedPackageId) {
    throw new Error("Dados insuficientes para renovar (customerId/packageId).");
  }

  const safeConnections = Math.max(1, Number(connections || 1) || 1);

  await requestNewbr(`/api/customers/${encodeURIComponent(resolvedCustomerId)}/renew`, {
    method: "POST",
    authorization,
    credentials,
    body: {
      package_id: resolvedPackageId,
      connections: safeConnections,
    },
  });

  const snapshot = await findCustomerByPhoneFromNewbr(normalizedPhone, { authorization, credentials }).catch(() => null);
  return {
    confirmed: true,
    planMonths: Number(planMonths || 0) || 0,
    confirmation: planLabel || null,
    customerSnapshot: snapshot,
  };
};

const atomicWriteJson = async (filePath, data) => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, filePath);
};

const readCheckoutTokenStore = async () =>
  safeReadJsonFile(CHECKOUT_TOKEN_STORE_PATH, { tokens: {} });

const resolveOwnerWorkerIdByCheckoutToken = async (checkoutToken) => {
  const token = String(checkoutToken || "").trim();
  if (!token) return null;
  const store = await readCheckoutTokenStore();
  const payload = store?.tokens && typeof store.tokens === "object" ? store.tokens[token] : null;
  const ownerWorkerId = payload?.ownerWorkerId ? String(payload.ownerWorkerId).trim() : "";
  return ownerWorkerId || null;
};

const resolveCheckoutTokenPayload = async (checkoutToken) => {
  const token = String(checkoutToken || "").trim();
  if (!token) return null;
  const store = await readCheckoutTokenStore();
  const payload = store?.tokens && typeof store.tokens === "object" ? store.tokens[token] : null;
  if (!payload) return null;
  const expiresAt = Date.parse(String(payload.expiresAt || ""));
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null;
  return payload && typeof payload === "object" ? payload : null;
};

const sanitizeAuthorizationForClient = (authorization = null) => {
  if (!authorization || typeof authorization !== "object") return null;
  return {
    authorized: Boolean(authorization.authorized),
    username: toNullableString(authorization.username),
    authorizedAt: toIso(authorization.authorizedAt),
    expiresAt: toIso(authorization.expiresAt),
  };
};

const buildRenewalAuthorization = ({ username, token, expiresAt, source = "checkout" }) => ({
  authorized: true,
  username: String(username || "").trim(),
  bearerToken: String(token || "").trim(),
  source,
  authorizedAt: new Date().toISOString(),
  expiresAt:
    toIso(expiresAt) ||
    new Date(Date.now() + CHECKOUT_RENEWAL_AUTH_TTL_HOURS * 60 * 60 * 1000).toISOString(),
});

const isRenewalAuthorizationValid = (authorization = null) => {
  if (!authorization || typeof authorization !== "object") return false;
  if (!authorization.authorized) return false;
  const token = String(authorization.bearerToken || authorization.token || "").trim();
  const expiresAt = Date.parse(String(authorization.expiresAt || ""));
  return Boolean(token && Number.isFinite(expiresAt) && expiresAt > Date.now());
};

const getRenewalStatusMessage = (status) => {
  switch (String(status || "")) {
    case "missing_authorization":
      return "Pagamento confirmado, mas a renovacao ainda nao foi concluida por falta de autorizacao.";
    case "renewal_failed":
    case "manual_required":
      return "Pagamento confirmado, mas a renovacao automatica falhou. Acao manual necessaria.";
    case "duplicate_blocked":
      return "Pagamento confirmado, mas a renovacao automatica foi bloqueada para evitar duplicidade. Revisao manual necessaria.";
    case "payment_confirmed":
      return "Pagamento confirmado. Renovacao automatica ainda nao concluida.";
    default:
      return "";
  }
};

const readRenewalStore = async () => safeReadJsonFile(CHECKOUT_RENEWAL_STORE_PATH, { payments: {} });

const writeRenewalStore = async (store) => {
  await atomicWriteJson(CHECKOUT_RENEWAL_STORE_PATH, store);
};

const readRenewLogStore = async () => safeReadJsonFile(CHECKOUT_RENEW_LOG_PATH, { byPhone: {} });

const writeRenewLogStore = async (store) => {
  await atomicWriteJson(CHECKOUT_RENEW_LOG_PATH, store);
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

const pruneRenewalStore = (store) => {
  if (!store?.payments || typeof store.payments !== "object") {
    return { ...(store && typeof store === "object" ? store : {}), payments: {} };
  }
  const maxAgeMs = Number.isFinite(CHECKOUT_RENEWAL_MAX_DAYS)
    ? CHECKOUT_RENEWAL_MAX_DAYS * 24 * 60 * 60 * 1000
    : 0;
  const now = Date.now();
  const entries = Object.entries(store.payments)
    .map(([id, data]) => [id, data])
    .filter(([, data]) => {
      if (!data?.updatedAt) return true;
      const updatedAt = Date.parse(data.updatedAt);
      if (!Number.isFinite(updatedAt)) return true;
      return maxAgeMs <= 0 || now - updatedAt <= maxAgeMs;
    });

  if (Number.isFinite(CHECKOUT_RENEWAL_MAX_ITEMS) && entries.length > CHECKOUT_RENEWAL_MAX_ITEMS) {
    entries.sort(([, a], [, b]) => {
      const aTime = Date.parse(a.updatedAt || "") || 0;
      const bTime = Date.parse(b.updatedAt || "") || 0;
      return bTime - aTime;
    });
    entries.length = CHECKOUT_RENEWAL_MAX_ITEMS;
  }

  return {
    ...store,
    payments: Object.fromEntries(entries),
  };
};

const toIso = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const toNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const mapRenewalPayment = (paymentId, entry) => ({
  paymentId: String(paymentId),
  status: String(entry?.status || ""),
  updatedAt: toIso(entry?.updatedAt),
  renewedAt: toIso(entry?.renewedAt),
  phone: String(entry?.phone || ""),
  username: toNullableString(entry?.username),
  planMonths: toNumberOrNull(entry?.planMonths),
  planLabel: toNullableString(entry?.planLabel),
  connections: toNumberOrNull(entry?.connections),
  amount: toNumberOrNull(entry?.amount),
  customerId: toNullableString(entry?.customerId),
  packageId: toNullableString(entry?.packageId),
  attempts: Number(entry?.attempts || 0) || 0,
  lastError: toNullableString(entry?.lastError),
  processingWorker: toNullableString(entry?.processingWorker),
  processingStartedAt: toIso(entry?.processingStartedAt),
  ownerWorkerId: toNullableString(entry?.ownerWorkerId),
  checkoutToken: toNullableString(entry?.checkoutToken),
  duplicateOfPaymentId: toNullableString(entry?.duplicateOfPaymentId),
  duplicateOfRenewedAt: toIso(entry?.duplicateOfRenewedAt),
  manualRequired: Boolean(entry?.manualRequired),
  authorization: sanitizeAuthorizationForClient(entry?.authorization),
});

const BROWSER_WORKER_RENEWAL_STATUSES = new Set([
  "awaiting_browser_renewal",
  "browser_renewal_failed",
]);

const isProcessingClaimStale = (entry) => {
  const startedAt = Date.parse(String(entry?.processingStartedAt || ""));
  return !Number.isFinite(startedAt) || Date.now() - startedAt > CHECKOUT_BROWSER_WORKER_CLAIM_TTL_MS;
};

const isBrowserWorkerClaimableRenewal = (paymentId, entry, filters = {}) => {
  if (!paymentId || !entry || typeof entry !== "object") return false;
  const status = String(entry.status || "");
  if (status === "renewed") return false;
  if (filters.paymentId && String(paymentId) !== String(filters.paymentId)) return false;
  if (filters.checkoutToken && String(entry.checkoutToken || "") !== String(filters.checkoutToken)) return false;
  if (!entry.customerId || !entry.packageId) return false;
  if ((Number(entry.browserWorkerAttempts || 0) || 0) >= CHECKOUT_BROWSER_WORKER_MAX_ATTEMPTS) return false;
  if (status === "processing_frontend") return false;
  if (status !== "processing_frontend" && !BROWSER_WORKER_RENEWAL_STATUSES.has(status)) return false;
  const nextClaimAt = Date.parse(String(entry.nextClaimAt || ""));
  if (Number.isFinite(nextClaimAt) && nextClaimAt > Date.now()) return false;
  return true;
};

const buildBrowserWorkerRenewalJob = (paymentId, entry) => {
  const authorization = isRenewalAuthorizationValid(entry?.authorization) ? entry.authorization : null;
  const payment = mapRenewalPayment(paymentId, entry);
  return {
    payment,
    renewal: {
      paymentId: String(paymentId),
      checkoutToken: toNullableString(entry.checkoutToken),
      checkout_token: toNullableString(entry.checkoutToken),
      externalReference: toNullableString(entry.externalReference),
      external_reference: toNullableString(entry.externalReference),
      customerId: toNullableString(entry.customerId),
      customer_id: toNullableString(entry.customerId),
      packageId: toNullableString(entry.packageId),
      package_id: toNullableString(entry.packageId),
      connections: Number(entry.connections || 1) || 1,
      phone: normalizeDigits(entry.phone),
      whatsapp: normalizeDigits(entry.phone),
      username: toNullableString(entry.username),
      planMonths: toNumberOrNull(entry.planMonths),
      plan_months: toNumberOrNull(entry.planMonths),
      planLabel: toNullableString(entry.planLabel),
      plan_label: toNullableString(entry.planLabel),
      amount: toNumberOrNull(entry.amount),
    },
    authorization: authorization
      ? {
          authorized: true,
          username: authorization.username || null,
          expiresAt: authorization.expiresAt || null,
          bearerToken: authorization.bearerToken || authorization.token || null,
        }
      : {
          authorized: false,
          username: null,
          expiresAt: null,
          bearerToken: null,
        },
  };
};

const getBrowserWorkerRetryDelayMs = (attempts) => {
  const safeAttempts = Math.max(1, Number(attempts || 1) || 1);
  const multiplier = Math.min(8, 2 ** Math.max(0, safeAttempts - 1));
  return Math.min(CHECKOUT_BROWSER_WORKER_RETRY_MAX_MS, CHECKOUT_BROWSER_WORKER_RETRY_BASE_MS * multiplier);
};

const ensureMercadoPagoConfig = (res) => {
  if (!MERCADOPAGO_ACCESS_TOKEN) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing MERCADOPAGO_ACCESS_TOKEN" }));
    return false;
  }
  return true;
};

const sanitizeAmount = (value, fallback = 1) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallback;
  }
  return Math.round(amount * 100) / 100;
};

const buildPayer = (payer = {}) => {
  if (!payer) return null;
  const email = typeof payer.email === "string" ? payer.email.trim() : "";
  if (!email) return null;

  const identificationType =
    typeof payer.identification?.type === "string" ? payer.identification.type.trim() : "";
  const identificationNumber =
    typeof payer.identification?.number === "string" ? payer.identification.number.trim() : "";
  const identification =
    identificationType && identificationNumber
      ? { type: identificationType, number: identificationNumber }
      : undefined;

  const firstName = typeof payer.firstName === "string" ? payer.firstName.trim() : "";
  const lastName = typeof payer.lastName === "string" ? payer.lastName.trim() : "";

  return {
    email,
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    identification,
  };
};

const mpFetch = async ({ path: mpPath, payload, idempotencyKey }) => {
  const response = await fetch(`${MERCADOPAGO_API_BASE_URL}${mpPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  return { response, data };
};

const mpGetPayment = async (paymentId) => {
  const response = await fetch(`${MERCADOPAGO_API_BASE_URL}/v1/payments/${paymentId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
};

const mpSearchPayments = async ({ limit = CHECKOUT_RECONCILE_LIMIT } = {}) => {
  const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || CHECKOUT_RECONCILE_LIMIT));
  const query = new URLSearchParams({
    sort: "date_created",
    criteria: "desc",
    limit: String(normalizedLimit),
  });
  const response = await fetch(`${MERCADOPAGO_API_BASE_URL}/v1/payments/search?${query.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
};

const buildRenewalCandidateFromPayment = (payment) => {
  if (!payment || typeof payment !== "object") return null;
  const metadata = payment.metadata || {};
  const paymentId = payment.data?.id || payment.id || payment.resource?.id || null;
  const status = payment.status || "";
  const planMonthsRaw = metadata.plan_months || metadata.plan || metadata.months;
  const planMonths = planMonthsRaw ? Number(planMonthsRaw) : null;
  const phone = metadata.whatsapp || metadata.phone || null;
  const username = metadata.user || metadata.usuario || metadata.username || null;
  const planLabel = metadata.plan_label || null;
  const checkoutToken = metadata.checkout_token || metadata.token || null;
  const externalReference = payment.external_reference || metadata.external_reference || metadata.externalReference || null;
  const ownerWorkerId = metadata.owner_worker_id || metadata.ownerWorkerId || null;
  const connectionsRaw = metadata.connections || metadata.conexoes || null;
  const connections = connectionsRaw ? Number(connectionsRaw) : null;
  return {
    paymentId: paymentId ? String(paymentId) : null,
    status: String(status || "").toLowerCase(),
    planMonths,
    phone,
    username,
    planLabel,
    checkoutToken,
    externalReference,
    ownerWorkerId,
    connections,
    amount: payment.transaction_amount,
    customerId: metadata.customer_id || metadata.customerId || null,
    packageId: metadata.package_id || metadata.packageId || null,
    approvedAt: payment.date_approved || payment.date_created || null,
  };
};

const isPaymentInsideLookbackWindow = (value) => {
  if (!value) return false;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return false;
  const maxAgeMs = CHECKOUT_RECONCILE_LOOKBACK_HOURS * 60 * 60 * 1000;
  return Date.now() - parsed <= maxAgeMs;
};

const mergeRenewalCandidateWithCheckoutToken = async (candidate = {}) => {
  const externalReference = String(candidate.externalReference || "").trim();
  const tokenFromReference = externalReference.startsWith("checkout:")
    ? externalReference.slice("checkout:".length).trim()
    : "";
  const checkoutToken = String(candidate.checkoutToken || tokenFromReference || "").trim();
  const tokenPayload = checkoutToken ? await resolveCheckoutTokenPayload(checkoutToken) : null;
  const renewalStore = externalReference ? await readRenewalStore().catch(() => null) : null;
  const intent = externalReference && renewalStore?.intents?.[externalReference]
    ? renewalStore.intents[externalReference]
    : null;
  const planMonthsRaw = candidate.planMonths || intent?.planMonths || intent?.plan_months || tokenPayload?.plan || tokenPayload?.planMonths || tokenPayload?.months;
  const connectionsRaw = candidate.connections || intent?.connections || tokenPayload?.connections || tokenPayload?.conexoes;
  return {
    paymentId: String(candidate.paymentId || "").trim(),
    status: String(candidate.status || "").toLowerCase(),
    phone: normalizeDigits(candidate.phone || intent?.phone || intent?.whatsapp || tokenPayload?.whatsapp || tokenPayload?.phone || ""),
    planMonths: Number(planMonthsRaw || 0) || null,
    planLabel: candidate.planLabel || intent?.planLabel || intent?.plan_label || tokenPayload?.plan_label || tokenPayload?.planLabel || null,
    connections: Math.max(1, Number(connectionsRaw || 1) || 1),
    amount: toNumberOrNull(candidate.amount),
    username: candidate.username || intent?.username || intent?.user || tokenPayload?.user || tokenPayload?.usuario || tokenPayload?.username || null,
    customerId: candidate.customerId || intent?.customerId || intent?.customer_id || tokenPayload?.customer_id || tokenPayload?.customerId || null,
    packageId: candidate.packageId || intent?.packageId || intent?.package_id || tokenPayload?.package_id || tokenPayload?.packageId || null,
    checkoutToken: checkoutToken || null,
    ownerWorkerId: candidate.ownerWorkerId || intent?.ownerWorkerId || intent?.owner_worker_id || tokenPayload?.ownerWorkerId || tokenPayload?.owner_worker_id || null,
    externalReference: externalReference || null,
  };
};

const processApprovedCheckoutRenewal = async ({ candidate, source = "checkout-webhook" } = {}) => {
  const resolved = await mergeRenewalCandidateWithCheckoutToken(candidate);
  if (
    !resolved.paymentId ||
    resolved.status !== "approved" ||
    !resolved.phone ||
    !resolved.planMonths ||
    CHECKOUT_RENEWAL_DISABLED
  ) {
    return { processed: false, reason: "invalid-or-disabled" };
  }

  if (!tryLockPayment(resolved.paymentId)) {
    return { processed: false, reason: "inflight", paymentId: resolved.paymentId };
  }

  let renewalJob = null;
  try {
    renewalJob = await withRenewalStoreMutation(async () => {
      const nowIso = new Date().toISOString();
      const store = pruneRenewalStore(await readRenewalStore());
      if (!store.payments) store.payments = {};
      if (!store.authorizations || typeof store.authorizations !== "object") {
        store.authorizations = {};
      }

      const existing = store.payments[resolved.paymentId] || {};
      if (existing.status === "renewed") {
        return { shouldRenew: false, reason: "already-renewed", payment: mapRenewalPayment(resolved.paymentId, existing) };
      }
      const attempts = Number(existing.attempts || 0) || 0;
      if (attempts >= CHECKOUT_RENEWAL_MAX_ATTEMPTS) {
        const next = {
          ...existing,
          ...resolved,
          status: existing.status === "renewal_failed" ? "renewal_failed" : "manual_required",
          attempts,
          manualRequired: true,
          updatedAt: nowIso,
          lastError: existing.lastError || "Limite de tentativa automatica atingido.",
        };
        store.payments[resolved.paymentId] = next;
        await writeRenewalStore(store);
        return { shouldRenew: false, reason: "max-attempts", payment: mapRenewalPayment(resolved.paymentId, next) };
      }

      const storedAuthorization =
        existing.authorization ||
        (resolved.checkoutToken ? store.authorizations[resolved.checkoutToken] : null) ||
        null;

      const baseEntry = {
        ...existing,
        ...resolved,
        updatedAt: nowIso,
        createdAt: existing.createdAt || nowIso,
        status: "payment_confirmed",
        attempts,
        manualRequired: false,
        lastError: null,
        processingWorker: null,
        processingStartedAt: null,
      };

      const next = {
        ...baseEntry,
        status: "processing",
        attempts: attempts + 1,
        authorization: isRenewalAuthorizationValid(storedAuthorization) ? storedAuthorization : null,
        processingStartedAt: nowIso,
      };
      store.payments[resolved.paymentId] = next;
      await writeRenewalStore(store);
      return {
        shouldRenew: true,
        paymentId: resolved.paymentId,
        payment: mapRenewalPayment(resolved.paymentId, next),
        entry: next,
      };
    });

    if (!renewalJob?.shouldRenew) {
      const payment = renewalJob?.payment;
      if (payment?.phone && renewalJob?.reason === "missing-authorization") {
        await appendRenewLog(payment.phone, getRenewalStatusMessage("missing_authorization"), {
          paymentId: payment.paymentId,
          source,
          event: "checkout-renew-missing-authorization",
        });
      }
      return { processed: false, reason: renewalJob?.reason || "skipped", payment };
    }
const browserWorkerAttempts = Number(renewalJob.entry.browserWorkerAttempts || 0) || 0;

if (browserWorkerAttempts >= CHECKOUT_BROWSER_WORKER_MAX_ATTEMPTS) {
  const blocked = await withRenewalStoreMutation(async () => {
    const nowIso = new Date().toISOString();
    const store = pruneRenewalStore(await readRenewalStore());
    if (!store.payments) store.payments = {};

    const entry = store.payments[resolved.paymentId] || renewalJob.entry;

    const next = {
      ...entry,
      status: "manual_required",
      updatedAt: nowIso,
      processingStartedAt: null,
      processingWorker: null,
      manualRequired: true,
      nextClaimAt: null,
      lastError:
        entry.lastError ||
        `Limite do Worker do site atingido: ${browserWorkerAttempts}/${CHECKOUT_BROWSER_WORKER_MAX_ATTEMPTS}.`,
    };

    store.payments[resolved.paymentId] = next;
    await writeRenewalStore(store);

    return mapRenewalPayment(resolved.paymentId, next);
  });

  await appendRenewLog(blocked.phone, "Renovacao bloqueada: limite do Worker do site atingido.", {
    paymentId: blocked.paymentId,
    source,
    event: "checkout-browser-worker-max-attempts",
  });

  return { processed: false, reason: "browser-worker-max-attempts", payment: blocked };
}

    if (renewalJob.entry.checkoutToken && renewalJob.entry.customerId && renewalJob.entry.packageId) {
      const waiting = await withRenewalStoreMutation(async () => {
        const nowIso = new Date().toISOString();
        const store = pruneRenewalStore(await readRenewalStore());
        if (!store.payments) store.payments = {};
        const entry = store.payments[resolved.paymentId] || renewalJob.entry;
        const next = {
          ...entry,
          status: "awaiting_browser_renewal",
          attempts: Math.max(0, Number(entry.attempts || 1) - 1),
          updatedAt: nowIso,
          processingStartedAt: null,
          processingWorker: null,
          manualRequired: false,
          lastError: null,
          nextClaimAt: null,
        };
        store.payments[resolved.paymentId] = next;
        await writeRenewalStore(store);
        return mapRenewalPayment(resolved.paymentId, next);
      });

      await appendRenewLog(waiting.phone, "Pagamento aprovado. Renovacao enfileirada para o Worker do site.", {
        paymentId: waiting.paymentId,
        source,
        event: "checkout-browser-worker-queued",
      });

      return { processed: false, reason: "awaiting-browser-renewal", payment: waiting };
    }

    const result = await enqueueRenewal(() =>
      renewViaNewbrApi({
        phone: renewalJob.entry.phone,
        planMonths: renewalJob.entry.planMonths,
        planLabel: renewalJob.entry.planLabel,
        connections: renewalJob.entry.connections,
        customerId: renewalJob.entry.customerId,
        packageId: renewalJob.entry.packageId,
        authorization: renewalJob.entry.authorization,
      }),
    );

    const updated = await withRenewalStoreMutation(async () => {
      const nowIso = new Date().toISOString();
      const store = pruneRenewalStore(await readRenewalStore());
      if (!store.payments) store.payments = {};
      const entry = store.payments[resolved.paymentId] || renewalJob.entry;
      const next = {
        ...entry,
        status: "renewed",
        updatedAt: nowIso,
        processingStartedAt: null,
        confirmation: result?.confirmation || entry?.planLabel || null,
        customerSnapshot: result?.customerSnapshot || null,
        lastError: null,
        manualRequired: false,
      };
      store.payments[resolved.paymentId] = next;
      await writeRenewalStore(store);
      return mapRenewalPayment(resolved.paymentId, next);
    });

    await appendRenewLog(updated.phone, "Renovacao confirmada automaticamente pelo checkout-server.", {
      paymentId: updated.paymentId,
      source,
      event: "checkout-renew-success-direct",
    });
    return { processed: true, reason: "renewed", payment: updated };
  } catch (error) {
    const message = error?.message || "Falha na renovacao automatica.";
    const failed = await withRenewalStoreMutation(async () => {
      const nowIso = new Date().toISOString();
      const store = pruneRenewalStore(await readRenewalStore());
      if (!store.payments) store.payments = {};
      const entry = store.payments[resolved.paymentId] || renewalJob?.entry || resolved;
      const next = {
        ...entry,
        status: "renewal_failed",
        updatedAt: nowIso,
        processingStartedAt: null,
        lastError: message,
        manualRequired: true,
      };
      store.payments[resolved.paymentId] = next;
      await writeRenewalStore(store);
      return mapRenewalPayment(resolved.paymentId, next);
    });
    await appendRenewLog(failed.phone, `${getRenewalStatusMessage("renewal_failed")} Erro: ${message}`, {
      paymentId: failed.paymentId,
      source,
      event: "checkout-renew-failed-direct",
    });
    return { processed: false, reason: "renewal-failed", payment: failed, error: message };
  } finally {
    unlockPayment(resolved.paymentId);
  }
};

const reconcilePendingFrontendRenewals = async ({ force = false, source = "checkout-reconcile" } = {}) => {
  if (!CHECKOUT_RECONCILE_ENABLED || !MERCADOPAGO_ACCESS_TOKEN) {
    return { scanned: 0, queued: 0, skipped: true };
  }
  const now = Date.now();
  if (!force && reconcileRunningPromise) {
    return reconcileRunningPromise;
  }
  if (!force && now - reconcileLastRunAt < CHECKOUT_RECONCILE_MIN_INTERVAL_MS) {
    return { scanned: 0, queued: 0, skipped: true };
  }

  reconcileRunningPromise = (async () => {
    let scanned = 0;
    let processed = 0;
    const processedItems = [];
    const { response, data } = await mpSearchPayments({ limit: CHECKOUT_RECONCILE_LIMIT });
    if (!response.ok) {
      const message =
        data?.message || data?.error?.message || `Mercado Pago search error (${response.status})`;
      throw new Error(message);
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const raw of results) {
      const candidate = buildRenewalCandidateFromPayment(raw);
      if (!candidate) continue;
      if (candidate.status !== "approved") continue;
      if (!isPaymentInsideLookbackWindow(candidate.approvedAt)) continue;
      if (!candidate.paymentId || !candidate.phone || !candidate.planMonths) continue;
      scanned += 1;
      const result = await processApprovedCheckoutRenewal({ candidate, source });
      if (result.processed) {
        processed += 1;
        processedItems.push(`${candidate.paymentId}:${candidate.phone}`);
      }
    }
    if (processed > 0) {
      console.log(
        `[checkout] reconciliacao: ${processed} pagamento(s) aprovado(s) renovado(s): ${processedItems.join(", ")}`,
      );
    }
    return { scanned, processed, queued: 0, recovered: 0, skipped: false };
  })();

  try {
    return await reconcileRunningPromise;
  } finally {
    reconcileLastRunAt = Date.now();
    reconcileRunningPromise = null;
  }
};

const mpCreatePreference = async ({ payload, idempotencyKey }) => {
  const response = await fetch(`${MERCADOPAGO_API_BASE_URL}/checkout/preferences`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
};

const formatCurrency = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  return amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
};

const isLegacyRenewConfirmationMessage = (text) => {
  const normalized = String(text || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  return (
    normalized.includes("renovacao confirmada!") &&
    normalized.includes("a +tv agradece!")
  );
};

const notifyWhatsApp = async ({ phone, text }) => {
  if (!phone || !text) return false;
  if (isLegacyRenewConfirmationMessage(text)) {
    console.log("[checkout] mensagem legado de renovacao bloqueada.");
    return false;
  }
  try {
    const response = await fetch(`${CHECKOUT_WHATSAPP_API_URL}/api/whatsapp/send-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: phone, text }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error || "WhatsApp send-text error");
    }
    return true;
  } catch (error) {
    console.error(`[checkout] falha ao enviar WhatsApp: ${error.message || error}`);
    return false;
  }
};

const buildCheckoutApprovedAlert = ({
  paymentId,
  phone,
  username,
  planLabel,
  planMonths,
  connections,
  amount,
}) => {
  const label = planLabel || (planMonths ? `${planMonths} mes(es)` : "-");
  return [
    "Pagamento confirmado (checkout)",
    `Telefone: ${phone || "-"}`,
    `Usuario: ${username || "-"}`,
    `Plano escolhido: ${label}`,
    `Conexoes: ${Number.isFinite(connections) ? connections : "-"}`,
    `Valor: ${Number.isFinite(amount) ? formatCurrency(amount) : "-"}`,
    paymentId ? `Pagamento ID: ${paymentId}` : null,
  ]
    .filter(Boolean)
    .join("\n");
};

const getCustomerRenewalStatus = async (phone) => {
  const normalizedPhone = normalizeDigits(phone);
  if (!normalizedPhone) {
    return { hasAlert: false, status: null, message: "", paymentId: null, updatedAt: null };
  }
  const store = pruneRenewalStore(await readRenewalStore());
  const payments = store.payments && typeof store.payments === "object" ? store.payments : {};
  const matches = Object.entries(payments)
    .map(([paymentId, entry]) => ({ paymentId, entry }))
    .filter(({ entry }) => {
      const entryPhone = normalizeDigits(entry?.phone);
      return entryPhone && (entryPhone === normalizedPhone || entryPhone.endsWith(normalizedPhone) || normalizedPhone.endsWith(entryPhone));
    })
    .sort((left, right) => {
      const leftTime = Date.parse(String(left.entry?.updatedAt || left.entry?.createdAt || "")) || 0;
      const rightTime = Date.parse(String(right.entry?.updatedAt || right.entry?.createdAt || "")) || 0;
      return rightTime - leftTime;
    });

  const alertStatuses = new Set(["missing_authorization", "renewal_failed", "manual_required", "duplicate_blocked"]);
  const match = matches.find(({ entry }) => alertStatuses.has(String(entry?.status || ""))) || matches[0] || null;
  if (!match) {
    return { hasAlert: false, status: null, message: "", paymentId: null, updatedAt: null };
  }

  const status = String(match.entry?.status || "");
  const message = getRenewalStatusMessage(status);
  return {
    hasAlert: Boolean(message && alertStatuses.has(status)),
    status: status || null,
    message,
    paymentId: match.paymentId,
    updatedAt: toIso(match.entry?.updatedAt || match.entry?.createdAt),
  };
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/checkout/newbr/authorize") {
    setCors(res);
    try {
      const body = await readJson(req);
      const checkoutToken = String(body?.token || body?.checkoutToken || "").trim();
      const username = String(body?.username || body?.user || body?.usuario || "").trim();
      const password = String(body?.password || "");

      if (!checkoutToken || !username || !password) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          authorized: false,
          message: "Informe token, usuario e senha NewBR.",
        }));
        return;
      }

      const tokenPayload = await resolveCheckoutTokenPayload(checkoutToken);
      if (!tokenPayload) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          authorized: false,
          message: "Token de checkout invalido ou expirado.",
        }));
        return;
      }

      const login = await loginNewbr({ username, password });
      const authorization = buildRenewalAuthorization({
        username: login.username,
        token: login.token,
        expiresAt: login.expiresAt,
      });

      await withRenewalStoreMutation(async () => {
        const store = pruneRenewalStore(await readRenewalStore());
        if (!store.payments) store.payments = {};
        if (!store.authorizations || typeof store.authorizations !== "object") {
          store.authorizations = {};
        }
        store.authorizations[checkoutToken] = authorization;
        for (const [paymentId, entry] of Object.entries(store.payments)) {
          if (String(entry?.checkoutToken || "") !== checkoutToken) continue;
          if (String(entry?.status || "") === "renewed") continue;
          store.payments[paymentId] = {
            ...entry,
            authorization,
            updatedAt: new Date().toISOString(),
          };
        }
        await writeRenewalStore(store);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        authorized: true,
        message: "Autorizacao NewBR validada com sucesso.",
      }));
    } catch {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        authorized: false,
        message: "Nao foi possivel validar o login NewBR.",
      }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/checkout/newbr/browser-start") {
    setCors(res);
    try {
      const body = await readJson(req);
      const checkoutToken = String(body?.checkoutToken || body?.checkout_token || "").trim();
      const renewal = body?.renewal && typeof body.renewal === "object" ? body.renewal : {};
      const phone = normalizeDigits(renewal?.phone || renewal?.whatsapp || "");

      if (phone) {
        await appendRenewLog(phone, "Preparacao NewBR iniciada pelo checkout.", {
          source: "checkout-browser-worker",
          checkoutToken,
          event: "checkout-newbr-browser-start",
        });
      }

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, accepted: true }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message || "Browser start error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/checkout/newbr/browser-token") {
    setCors(res);
    try {
      const body = await readJson(req);
      const checkoutToken = String(body?.checkoutToken || body?.checkout_token || "").trim();
      const bearerToken = String(body?.bearerToken || body?.token || "").replace(/^Bearer\s+/i, "").trim();
      const username = String(body?.username || body?.user || body?.usuario || "browser-worker").trim();

      if (!checkoutToken || !bearerToken) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "Informe checkoutToken e token NewBR." }));
        return;
      }

      if (!/^[A-Za-z0-9_-]+\|[A-Za-z0-9_-]{20,}$/.test(bearerToken)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "Token NewBR invalido." }));
        return;
      }

      const tokenPayload = await resolveCheckoutTokenPayload(checkoutToken);
      if (!tokenPayload) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "Token de checkout invalido ou expirado." }));
        return;
      }

      const authorization = buildRenewalAuthorization({
        username,
        token: bearerToken,
        source: "checkout-browser-worker",
      });

      await withRenewalStoreMutation(async () => {
        const store = pruneRenewalStore(await readRenewalStore());
        if (!store.authorizations || typeof store.authorizations !== "object") {
          store.authorizations = {};
        }
        store.authorizations[checkoutToken] = authorization;

        for (const [paymentId, entry] of Object.entries(store.payments || {})) {
          if (String(entry?.checkoutToken || "") !== checkoutToken) continue;
          if (String(entry?.status || "") === "renewed") continue;
          store.payments[paymentId] = {
            ...entry,
            authorization,
            updatedAt: new Date().toISOString(),
          };
        }

        await writeRenewalStore(store);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        authorized: true,
        message: "Token NewBR salvo para renovacao automatica.",
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message || "Browser token error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/checkout/renewals/intent") {
    setCors(res);
    try {
      const body = await readJson(req);
      const checkoutToken = String(body?.checkoutToken || body?.checkout_token || "").trim();
      const externalReference = String(body?.external_reference || body?.externalReference || "").trim();
      const tokenPayload = checkoutToken ? await resolveCheckoutTokenPayload(checkoutToken) : null;

      if (!checkoutToken || !externalReference || !tokenPayload) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "checkoutToken/external_reference invalidos." }));
        return;
      }

      const intent = {
        status: "pending_payment",
        accountKey: toNullableString(body?.account_key || body?.accountKey),
        checkoutToken,
        externalReference,
        phone: normalizeDigits(body?.phone || body?.whatsapp || tokenPayload?.whatsapp || tokenPayload?.phone || ""),
        username: toNullableString(body?.username || body?.user || tokenPayload?.user || tokenPayload?.username),
        customerId: toNullableString(body?.customerId || body?.customer_id || tokenPayload?.customerId || tokenPayload?.customer_id),
        packageId: toNullableString(body?.packageId || body?.package_id || tokenPayload?.packageId || tokenPayload?.package_id),
        connections: Number(body?.connections || tokenPayload?.connections || tokenPayload?.conexoes || 1) || 1,
        planMonths: Number(body?.planMonths || body?.plan_months || tokenPayload?.plan || tokenPayload?.planMonths || 0) || null,
        planLabel: toNullableString(body?.planLabel || body?.plan_label || tokenPayload?.plan_label || tokenPayload?.planLabel),
        amount: toNumberOrNull(body?.amount),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await withRenewalStoreMutation(async () => {
        const store = pruneRenewalStore(await readRenewalStore());
        if (!store.intents || typeof store.intents !== "object") {
          store.intents = {};
        }
        const existing = store.intents[externalReference] || {};
        store.intents[externalReference] = {
          ...existing,
          ...intent,
          createdAt: existing.createdAt || intent.createdAt,
        };
        await writeRenewalStore(store);
      });

      if (intent.phone) {
        await appendRenewLog(intent.phone, "Intencao de renovacao registrada no checkout.", {
          source: "checkout-browser-worker",
          checkoutToken,
          externalReference,
          event: "checkout-renewal-intent",
        });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, intent }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message || "Renewal intent error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/checkout/renewals/checkout-status") {
    setCors(res);
    try {
      const checkoutToken = String(url.searchParams.get("token") || "").trim();
      if (!checkoutToken) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "Missing token" }));
        return;
      }

      const store = pruneRenewalStore(await readRenewalStore());
      const payments = Object.entries(store.payments || {})
        .filter(([, entry]) => String(entry?.checkoutToken || "") === checkoutToken)
        .map(([paymentId, entry]) => mapRenewalPayment(paymentId, entry))
        .sort((a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0));
      const externalReference = `checkout:${checkoutToken}`;
      const intent = store.intents?.[externalReference] || null;
      const authorization = store.authorizations?.[checkoutToken] || null;
      const token = String(authorization?.bearerToken || authorization?.token || "").trim();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        checkoutToken,
        externalReference,
        payment: payments[0] || null,
        payments,
        intent,
        authorization: {
          authorized: isRenewalAuthorizationValid(authorization),
          username: authorization?.username || null,
          expiresAt: authorization?.expiresAt || null,
          bearerToken: token || null,
        },
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message || "Checkout status error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/checkout/newbr/browser-renewal-result") {
    setCors(res);
    try {
      const body = await readJson(req);
      const checkoutToken = String(body?.checkoutToken || body?.checkout_token || "").trim();
      const externalReference = String(body?.externalReference || body?.external_reference || `checkout:${checkoutToken}`).trim();
      const renew = body?.renew && typeof body.renew === "object" ? body.renew : {};
      const ok = Boolean(renew?.ok || body?.ok);

      if (!checkoutToken) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "Missing checkoutToken" }));
        return;
      }

      const updated = await withRenewalStoreMutation(async () => {
        const store = pruneRenewalStore(await readRenewalStore());
        const entries = Object.entries(store.payments || {})
          .filter(([, entry]) => String(entry?.checkoutToken || "") === checkoutToken)
          .sort(([, a], [, b]) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0));
        const [paymentId, entry] = entries[0] || [];
        if (!paymentId || !entry) return null;
        if (entry.status === "renewed") {
          return { paymentId, payment: mapRenewalPayment(paymentId, entry), raw: entry, alreadyRenewed: true };
        }

        const attempts = Number(entry.browserWorkerAttempts || 1) || 1;
        const reachedMaxAttempts = attempts >= CHECKOUT_BROWSER_WORKER_MAX_ATTEMPTS;
        const next = {
          ...entry,
          status: ok ? "renewed" : reachedMaxAttempts ? "manual_required" : "browser_renewal_failed",
          updatedAt: new Date().toISOString(),
          renewedAt: ok ? new Date().toISOString() : entry.renewedAt || null,
          manualRequired: !ok && reachedMaxAttempts,
          lastError: ok ? null : resolvePayloadErrorMessage(renew?.data, `Browser renewal failed (${renew?.status || "unknown"})`),
          nextClaimAt: ok
            ? null
            : reachedMaxAttempts
              ? null
              : new Date(Date.now() + getBrowserWorkerRetryDelayMs(attempts)).toISOString(),
          browserRenewal: {
            ok,
            status: renew?.status || null,
            response: renew?.data || null,
            externalReference,
            finishedAt: new Date().toISOString(),
          },
          processingStartedAt: null,
          processingWorker: null,
        };
        store.payments[paymentId] = next;
        await writeRenewalStore(store);
        return { paymentId, payment: mapRenewalPayment(paymentId, next), raw: next };
      });

      if (!updated) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "Payment not found for checkoutToken" }));
        return;
      }

      if (!updated.alreadyRenewed) {
        await appendRenewLog(updated.raw.phone, ok ? "Renovacao confirmada pelo Worker do checkout." : "Renovacao pelo Worker do checkout falhou.", {
          paymentId: updated.paymentId,
          source: "checkout-browser-worker",
          event: ok ? "checkout-browser-renew-success" : "checkout-browser-renew-failed-requeued",
        });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, payment: updated.payment }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message || "Browser renewal result error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/checkout/renewals/customer-status") {
    setCors(res);
    try {
      const phone = url.searchParams.get("phone") || "";
      const status = await getCustomerRenewalStatus(phone);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Renewal status error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/mercadopago/config") {
    setCors(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      publicKey: MERCADOPAGO_PUBLIC_KEY || null,
      description: MERCADOPAGO_DEFAULT_DESCRIPTION,
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/mercadopago/preference") {
    setCors(res);
    if (!ensureMercadoPagoConfig(res)) return;

    try {
      const { amount, title, description, payer, metadata, externalReference } = await readJson(req);
      const transactionAmount = sanitizeAmount(amount, 1);
      const itemTitle =
        (typeof title === "string" && title.trim()) ||
        (typeof description === "string" && description.trim()) ||
        MERCADOPAGO_DEFAULT_DESCRIPTION;

      const preferencePayload = {
        items: [
          {
            title: itemTitle,
            quantity: 1,
            unit_price: transactionAmount,
            currency_id: "BRL",
          },
        ],
        payer: buildPayer(payer) || undefined,
        metadata: metadata && typeof metadata === "object" ? metadata : undefined,
        external_reference:
          typeof externalReference === "string" && externalReference.trim()
            ? externalReference.trim()
            : undefined,
        auto_return: "approved",
      };

      if (MERCADOPAGO_NOTIFICATION_URL) {
        preferencePayload.notification_url = MERCADOPAGO_NOTIFICATION_URL;
      }
      if (MERCADOPAGO_CHECKOUT_BACK_URL) {
        preferencePayload.back_urls = {
          success: MERCADOPAGO_CHECKOUT_BACK_URL,
          pending: MERCADOPAGO_CHECKOUT_BACK_URL,
          failure: MERCADOPAGO_CHECKOUT_BACK_URL,
        };
      }

      const { response, data } = await mpCreatePreference({
        payload: preferencePayload,
        idempotencyKey: crypto.randomUUID(),
      });

      if (!response.ok) {
        const error = data?.message || data?.error?.message || "Mercado Pago preference error";
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error, details: data }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: data?.id || null,
          init_point: data?.init_point || null,
          sandbox_init_point: data?.sandbox_init_point || null,
        }),
      );
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Mercado Pago preference error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/mercadopago/pix") {
    setCors(res);
    if (!ensureMercadoPagoConfig(res)) return;

    try {
      const { amount, description, payer, metadata, externalReference } = await readJson(req);
      const transaction_amount = sanitizeAmount(amount, 1);
      const resolvedPayer = buildPayer(payer);
      if (!resolvedPayer) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing payer email" }));
        return;
      }

      const payload = {
        transaction_amount,
        description:
          typeof description === "string" && description.trim().length > 0
            ? description.trim()
            : MERCADOPAGO_DEFAULT_DESCRIPTION,
        payment_method_id: "pix",
        payer: resolvedPayer,
        metadata: metadata && typeof metadata === "object" ? metadata : undefined,
        external_reference:
          typeof externalReference === "string" && externalReference.trim()
            ? externalReference.trim()
            : undefined,
      };

      if (MERCADOPAGO_NOTIFICATION_URL) {
        payload.notification_url = MERCADOPAGO_NOTIFICATION_URL;
      }

      const { response, data } = await mpFetch({
        path: "/v1/payments",
        payload,
        idempotencyKey: crypto.randomUUID(),
      });

      if (!response.ok) {
        const error = data?.message || data?.error?.message || "Mercado Pago error";
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error, details: data }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Mercado Pago error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/mercadopago/card") {
    setCors(res);
    if (!ensureMercadoPagoConfig(res)) return;

    try {
      const { amount, description, token, issuer_id, payment_method_id, installments, payer, metadata, externalReference } =
        await readJson(req);
      if (!token || !payment_method_id || !installments) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing card payment fields" }));
        return;
      }

      const transaction_amount = sanitizeAmount(amount, 1);
      const resolvedPayer = buildPayer(payer);
      if (!resolvedPayer) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing payer email" }));
        return;
      }

      const payload = {
        transaction_amount,
        token,
        description:
          typeof description === "string" && description.trim().length > 0
            ? description.trim()
            : MERCADOPAGO_DEFAULT_DESCRIPTION,
        installments: Number(installments),
        payment_method_id,
        issuer_id: issuer_id || undefined,
        payer: resolvedPayer,
        metadata: metadata && typeof metadata === "object" ? metadata : undefined,
        external_reference:
          typeof externalReference === "string" && externalReference.trim()
            ? externalReference.trim()
            : undefined,
      };

      if (MERCADOPAGO_NOTIFICATION_URL) {
        payload.notification_url = MERCADOPAGO_NOTIFICATION_URL;
      }

      const { response, data } = await mpFetch({
        path: "/v1/payments",
        payload,
        idempotencyKey: crypto.randomUUID(),
      });

      if (!response.ok) {
        const error = data?.message || data?.error?.message || "Mercado Pago error";
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error, details: data }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Mercado Pago error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/mercadopago/webhook") {
    setCors(res);
    try {
      const payload = await readJson(req);
      console.log("Mercado Pago webhook:", JSON.stringify(payload));
      const paymentId =
        payload?.data?.id ||
        payload?.id ||
        payload?.resource?.id ||
        payload?.resourceId ||
        null;

      if (paymentId && MERCADOPAGO_ACCESS_TOKEN) {
        const { response, data } = await mpGetPayment(paymentId);
        if (response.ok) {
          const status = data?.status || "";
          const metadata = data?.metadata || {};
          const planMonthsRaw = metadata?.plan_months || metadata?.plan || metadata?.months;
          const planMonths = planMonthsRaw ? Number(planMonthsRaw) : null;
          const phone = metadata?.whatsapp || metadata?.phone || null;
          const username = metadata?.user || metadata?.usuario || metadata?.username || null;
          const planLabel = metadata?.plan_label || null;
          const checkoutToken = metadata?.checkout_token || metadata?.token || null;
          const externalReference =
            data?.external_reference || metadata?.external_reference || metadata?.externalReference || null;
          const ownerWorkerIdFromMetadata =
            metadata?.owner_worker_id || metadata?.ownerWorkerId || null;
          const resolvedOwnerWorkerId =
            ownerWorkerIdFromMetadata || (await resolveOwnerWorkerIdByCheckoutToken(checkoutToken));
          const connectionsRaw = metadata?.connections || metadata?.conexoes || null;
          const connections = connectionsRaw ? Number(connectionsRaw) : null;
          const transactionAmount = data?.transaction_amount;

          if (status === "approved" && phone && planMonths) {
            const paymentKey = String(paymentId);
            if (CHECKOUT_RENEWAL_DISABLED) {
              const nowIso = new Date().toISOString();
              let store = pruneRenewalStore(await readRenewalStore());
              const existing = store.payments?.[paymentKey];
              if (existing?.status !== "notified") {
                store = pruneRenewalStore(await readRenewalStore());
                if (!store.payments) store.payments = {};
                store.payments[paymentKey] = {
                  status: "notified",
                  updatedAt: nowIso,
                  phone,
                  planMonths,
                  planLabel,
                  connections,
                  amount: transactionAmount,
                  username,
                };
                await writeRenewalStore(store);

                const alertText = buildCheckoutApprovedAlert({
                  paymentId: paymentKey,
                  phone,
                  username,
                  planLabel,
                  planMonths,
                  connections,
                  amount: transactionAmount,
                });
                await notifyWhatsApp({ phone: CHECKOUT_NOTIFY_PHONE, text: alertText });
                await appendRenewLog(
                  phone,
                  "Pagamento aprovado. Renovacao via checkout desativada. Aviso enviado.",
                  {
                    paymentId: paymentKey,
                    status,
                    notifyPhone: CHECKOUT_NOTIFY_PHONE,
                    source: "checkout-webhook",
                    event: "checkout-renew-disabled",
                  },
                );
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "ok", notified: true }));
              return;
            }

            const renewResult = await processApprovedCheckoutRenewal({
              source: "checkout-webhook",
              candidate: {
                paymentId: paymentKey,
                status: String(status || "").toLowerCase(),
                phone,
                planMonths,
                planLabel,
                checkoutToken,
                externalReference,
                ownerWorkerId: resolvedOwnerWorkerId,
                connections,
                amount: transactionAmount,
                username,
                customerId: metadata?.customer_id || metadata?.customerId || null,
                packageId: metadata?.package_id || metadata?.packageId || null,
              },
            });
            if (renewResult.processed) {
              console.log(
                `[checkout] pagamento ${paymentKey} aprovado para ${phone}; renovacao automatica concluida no checkout-server.`,
              );
            } else if (renewResult.reason === "missing-authorization") {
              console.log(
                `[checkout] pagamento ${paymentKey} aprovado para ${phone}; renovacao pendente por falta de autorizacao NewBR.`,
              );
            }
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Webhook error" }));
    }
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/api/checkout/renewals/claim" || url.pathname === "/api/mercadopago/renewals/claim")
  ) {
    setCors(res);
    try {
      const body = await readJson(req);
      const workerId = String(body?.workerId || body?.worker_id || `site-worker-${crypto.randomUUID()}`).trim();
      const limit = Math.max(1, Math.min(10, Number(body?.limit || 3) || 3));
      const filters = {
        paymentId: String(body?.paymentId || body?.payment_id || "").trim(),
        checkoutToken: String(body?.checkoutToken || body?.checkout_token || "").trim(),
      };
      const claimed = await withRenewalStoreMutation(async () => {
        const store = pruneRenewalStore(await readRenewalStore());
        if (!store.payments) store.payments = {};
        const nowIso = new Date().toISOString();
        const blockedLogs = [];
        let storeChanged = false;

        for (const [paymentId, entry] of Object.entries(store.payments)) {
          if (String(entry?.status || "") !== "processing_frontend") continue;
          if (!isProcessingClaimStale(entry)) continue;
          const next = {
            ...entry,
            status: "manual_required",
            updatedAt: nowIso,
            processingWorker: null,
            processingStartedAt: null,
            manualRequired: true,
            nextClaimAt: null,
            lastError:
              entry.lastError ||
              "Resultado do Worker desconhecido. Bloqueado para evitar renovacao duplicada.",
          };
          store.payments[paymentId] = next;
          storeChanged = true;
          blockedLogs.push({
            paymentId,
            phone: String(entry.phone || ""),
            event: "checkout-site-worker-stale-blocked",
            message: "Processamento do Worker expirou sem confirmacao. Renovacao automatica bloqueada.",
          });
        }

        const entries = Object.entries(store.payments)
          .filter(([paymentId, entry]) => isBrowserWorkerClaimableRenewal(paymentId, entry, filters))
          .sort(([, a], [, b]) => {
            const aTime = Date.parse(a.updatedAt || a.createdAt || "") || 0;
            const bTime = Date.parse(b.updatedAt || b.createdAt || "") || 0;
            return bTime - aTime;
          });

        const jobs = [];
        for (const [paymentId, entry] of entries) {
          if (jobs.length >= limit) break;
          if (entry.status === "renewed") continue;
          const next = {
            ...entry,
            status: "processing_frontend",
            updatedAt: nowIso,
            processingWorker: workerId,
            processingStartedAt: nowIso,
            manualRequired: false,
            nextClaimAt: null,
            browserWorkerAttempts: (Number(entry.browserWorkerAttempts || 0) || 0) + 1,
          };
          store.payments[paymentId] = next;
          storeChanged = true;
          jobs.push(buildBrowserWorkerRenewalJob(paymentId, next));
        }

        if (storeChanged) {
          await writeRenewalStore(store);
        }
        return { jobs, blockedLogs };
      });

      if (claimed.blockedLogs?.length > 0) {
        for (const blocked of claimed.blockedLogs) {
          await appendRenewLog(blocked.phone, blocked.message, {
            paymentId: blocked.paymentId,
            source: "checkout-site-worker",
            event: blocked.event,
            workerId,
            duplicateOfPaymentId: blocked.duplicateOfPaymentId || null,
          });
        }
      }

      if (claimed.jobs.length > 0) {
        for (const job of claimed.jobs) {
          await appendRenewLog(job.renewal.phone, "Renovacao reivindicada pelo Worker do site.", {
            paymentId: job.payment.paymentId,
            source: "checkout-site-worker",
            event: "checkout-site-worker-claimed",
            workerId,
          });
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ workerId, claimed: claimed.jobs }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Claim renewal error" }));
    }
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/api/checkout/renewals/complete" || url.pathname === "/api/mercadopago/renewals/complete")
  ) {
    setCors(res);
    try {
      const body = await readJson(req);
      const paymentId = String(body?.paymentId || "").trim();
      if (!paymentId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing paymentId" }));
        return;
      }

      const success = Boolean(body?.success);
      const workerId = String(body?.workerId || "").trim();
      const source = String(body?.source || "checkout-site-worker").trim();
      const errorMessage = typeof body?.error === "string" ? body.error.trim() : "";
      const result = body?.result && typeof body.result === "object" ? body.result : null;
      const nowIso = new Date().toISOString();

      const payment = await withRenewalStoreMutation(async () => {
        const store = pruneRenewalStore(await readRenewalStore());
        if (!store.payments) store.payments = {};
        const entry = store.payments[paymentId];
        if (!entry) return null;
        const ownerWorker = String(entry?.processingWorker || "").trim();
        if (
          entry?.status === "processing_frontend" &&
          ownerWorker &&
          workerId &&
          ownerWorker !== workerId
        ) {
          return {
            ...mapRenewalPayment(paymentId, entry),
            ignored: true,
            reason: "worker-mismatch",
          };
        }

        const phone = String(entry.phone || body?.phone || "");
        if (entry?.status === "renewed") {
          return mapRenewalPayment(paymentId, entry);
        }

        if (success) {
          store.payments[paymentId] = {
            ...entry,
            status: "renewed",
            updatedAt: nowIso,
            renewedAt: nowIso,
            processingWorker: null,
            processingStartedAt: null,
            confirmation: result?.confirmation || entry?.planLabel || null,
            customerSnapshot: result?.customerSnapshot || null,
            lastError: null,
            manualRequired: false,
            nextClaimAt: null,
          };
          await appendRenewLog(phone, "Renovacao confirmada pelo Worker do site.", {
            paymentId,
            source,
            event: "checkout-site-worker-renew-success",
            workerId,
          });
        } else {
          const attempts = Number(entry.browserWorkerAttempts || 1) || 1;
          const reachedMaxAttempts = attempts >= CHECKOUT_BROWSER_WORKER_MAX_ATTEMPTS;
          store.payments[paymentId] = {
            ...entry,
            status: reachedMaxAttempts ? "manual_required" : "browser_renewal_failed",
            updatedAt: nowIso,
            processingWorker: null,
            processingStartedAt: null,
            lastError: errorMessage || "Renovacao nao confirmada pelo Worker do site",
            manualRequired: reachedMaxAttempts,
            nextClaimAt: reachedMaxAttempts
              ? null
              : new Date(Date.now() + getBrowserWorkerRetryDelayMs(attempts)).toISOString(),
          };
          await appendRenewLog(
            phone,
            reachedMaxAttempts
              ? `Renovacao falhou pelo Worker do site: ${errorMessage || "erro desconhecido"}. Limite automatico atingido.`
              : `Renovacao falhou pelo Worker do site: ${errorMessage || "erro desconhecido"}. Permanecera na fila.`,
            {
              paymentId,
              source,
              event: "checkout-site-worker-renew-failed-requeued",
              workerId,
            },
          );
        }

        await writeRenewalStore(store);
        return mapRenewalPayment(paymentId, store.payments[paymentId]);
      });
      if (!payment) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payment not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", payment }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Complete renewal error" }));
    }
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/api/checkout/renewals/requeue" || url.pathname === "/api/mercadopago/renewals/requeue")
  ) {
    setCors(res);
    try {
      const body = await readJson(req);
      const paymentId = String(body?.paymentId || "").trim();
      const reason = String(body?.reason || "Reenfileirado manualmente").trim();
      if (!paymentId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing paymentId" }));
        return;
      }

      const allowForce = body?.force === true;
      const payload = await withRenewalStoreMutation(async () => {
        const store = pruneRenewalStore(await readRenewalStore());
        if (!store.payments) store.payments = {};
        const entry = store.payments[paymentId];
        if (!entry) return { error: "Payment not found", code: 404 };
        if (entry.status === "renewed" && !allowForce) {
          return {
            error: "Pagamento ja renovado. Requeue bloqueado para evitar renovacao dupla.",
            code: 409,
            payment: mapRenewalPayment(paymentId, entry),
          };
        }
        const nowIso = new Date().toISOString();
        store.payments[paymentId] = {
          ...entry,
          status: "validating_frontend",
          updatedAt: nowIso,
          processingWorker: null,
          processingStartedAt: null,
        };
        await writeRenewalStore(store);
        await appendRenewLog(String(entry.phone || ""), `Pagamento reenfileirado: ${reason}`, {
          paymentId,
          source: "checkout-frontend",
          event: "checkout-renew-requeue",
        });
        return {
          code: 200,
          payment: mapRenewalPayment(paymentId, store.payments[paymentId]),
        };
      });

      if (payload.error) {
        res.writeHead(payload.code || 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: payload.error, payment: payload.payment || null }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", payment: payload.payment }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Requeue renewal error" }));
    }
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/api/checkout/renewals/manual-approve" ||
      url.pathname === "/api/mercadopago/renewals/manual-approve")
  ) {
    setCors(res);
    try {
      const body = await readJson(req);
      const paymentId = String(body?.paymentId || "").trim();
      if (!paymentId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing paymentId" }));
        return;
      }

      const payload = await withRenewalStoreMutation(async () => {
        const store = pruneRenewalStore(await readRenewalStore());
        if (!store.payments) store.payments = {};
        const entry = store.payments[paymentId];
        if (!entry) return { error: "Payment not found", code: 404 };
        if (entry.status === "renewed") {
          return {
            error: "Pagamento ja renovado.",
            code: 409,
            payment: mapRenewalPayment(paymentId, entry),
          };
        }
        const nowIso = new Date().toISOString();
        store.payments[paymentId] = {
          ...entry,
          status: "validating_frontend",
          updatedAt: nowIso,
          ownerWorkerId: null,
          processingWorker: null,
          processingStartedAt: null,
          lastError: null,
        };
        await writeRenewalStore(store);
        await appendRenewLog(String(entry.phone || ""), "Renovacao aprovada manualmente no painel de logs.", {
          paymentId,
          source: "checkout-frontend",
          event: "checkout-renew-manual-approved",
        });
        return {
          code: 200,
          payment: mapRenewalPayment(paymentId, store.payments[paymentId]),
        };
      });

      if (payload.error) {
        res.writeHead(payload.code || 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: payload.error, payment: payload.payment || null }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", payment: payload.payment }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Manual approve renewal error" }));
    }
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/api/checkout/renewals/manual-cancel" ||
      url.pathname === "/api/mercadopago/renewals/manual-cancel")
  ) {
    setCors(res);
    try {
      const body = await readJson(req);
      const paymentId = String(body?.paymentId || "").trim();
      const reason = String(body?.reason || "Cancelado manualmente no painel de logs.").trim();
      if (!paymentId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing paymentId" }));
        return;
      }

      const payload = await withRenewalStoreMutation(async () => {
        const store = pruneRenewalStore(await readRenewalStore());
        if (!store.payments) store.payments = {};
        const entry = store.payments[paymentId];
        if (!entry) return { error: "Payment not found", code: 404 };
        if (entry.status === "renewed") {
          return {
            error: "Pagamento ja renovado. Nao e possivel cancelar.",
            code: 409,
            payment: mapRenewalPayment(paymentId, entry),
          };
        }
        const nowIso = new Date().toISOString();
        store.payments[paymentId] = {
          ...entry,
          status: "cancelled_frontend",
          updatedAt: nowIso,
          ownerWorkerId: null,
          processingWorker: null,
          processingStartedAt: null,
          lastError: reason || entry?.lastError || null,
        };
        await writeRenewalStore(store);
        await appendRenewLog(String(entry.phone || ""), `Renovacao cancelada manualmente. Motivo: ${reason}`, {
          paymentId,
          source: "checkout-frontend",
          event: "checkout-renew-manual-cancelled",
        });
        return {
          code: 200,
          payment: mapRenewalPayment(paymentId, store.payments[paymentId]),
        };
      });

      if (payload.error) {
        res.writeHead(payload.code || 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: payload.error, payment: payload.payment || null }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", payment: payload.payment }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Manual cancel renewal error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/checkout/notify-test") {
    setCors(res);
    try {
      const payload = await readJson(req);
      const phone = payload?.phone || payload?.whatsapp || payload?.to || null;
      const username = payload?.username || payload?.user || payload?.usuario || null;
      const planLabel = payload?.planLabel || payload?.plan || null;
      const planMonthsRaw = payload?.planMonths || payload?.months || null;
      const planMonths = planMonthsRaw ? Number(planMonthsRaw) : null;
      const connectionsRaw = payload?.connections || payload?.conexoes || null;
      const connections = connectionsRaw ? Number(connectionsRaw) : null;
      const amountRaw = payload?.amount || payload?.valor || null;
      const amount = amountRaw ? Number(amountRaw) : null;
      const paymentId = payload?.paymentId || payload?.id || null;

      const alertText = buildCheckoutApprovedAlert({
        paymentId,
        phone,
        username,
        planLabel,
        planMonths,
        connections,
        amount,
      });
      const notified = await notifyWhatsApp({
        phone: CHECKOUT_NOTIFY_PHONE,
        text: alertText,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", notified, notifyPhone: CHECKOUT_NOTIFY_PHONE }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Notify test error" }));
    }
    return;
  }
if (req.method === "POST" && url.pathname === "/api/painel/renew") {
    setCors(res);
    let requestPhone = null;
    try {
      const { phone, planMonths, planLabel, connections, customerId, packageId } = await readJson(req);
      requestPhone = phone || null;
      if (!phone || !planMonths) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing phone or planMonths" }));
        return;
      }

      const label = planLabel || `${planMonths} mes(es)`;
      await appendRenewLog(phone, `Solicitacao manual de renovacao (${label}).`, { source: "manual" });

      const result = await enqueueRenewal(async () => {
        await appendRenewLog(phone, "Fila de renovacao API: iniciado.", { source: "manual-api" });
        const renew = await renewViaNewbrApi({
          phone,
          planMonths: Number(planMonths),
          planLabel: typeof planLabel === "string" ? planLabel : undefined,
          connections: typeof connections === "number" ? connections : Number(connections),
          customerId: typeof customerId === "string" ? customerId : undefined,
          packageId: typeof packageId === "string" ? packageId : undefined,
        });
        return renew || null;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", result }));

      if (result?.confirmed) {
        await appendRenewLog(phone, "Renovacao confirmada.", { source: "manual" });
      }
    } catch (error) {
      console.error(`[painel-renew-api] erro: ${error.message || error}`);
      if (requestPhone) {
        await appendRenewLog(requestPhone, `Erro: ${error.message || error}`, { source: "manual-api" });
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Painel renew error" }));
    }
    return;
  }

  setCors(res);
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

if (CHECKOUT_RECONCILE_ENABLED && MERCADOPAGO_ACCESS_TOKEN) {
  setInterval(() => {
    void reconcilePendingFrontendRenewals({ source: "checkout-reconcile-interval" }).catch((error) => {
      console.error(`[checkout] reconciliacao automatica falhou: ${error.message || error}`);
    });
  }, CHECKOUT_RECONCILE_INTERVAL_MS);
  setTimeout(() => {
    void reconcilePendingFrontendRenewals({ force: true, source: "checkout-reconcile-startup" }).catch(
      (error) => {
        console.error(`[checkout] reconciliacao inicial falhou: ${error.message || error}`);
      },
    );
  }, 3000);
}

server.listen(PORT, () => {
  console.log(`Checkout server running on http://localhost:${PORT}`);
});







