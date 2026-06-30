const NEWBR_BASE_URL = "https://painel.newbr.top";
const NEWBR_LOGIN_URL = `${NEWBR_BASE_URL}/api/auth/login`;

/*
  Coloque aqui o usuario e senha da NewBR.

  Atencao:
  este arquivo e publico no frontend.
*/
const SAVED_USERNAME = "suportemaistv";
const SAVED_PASSWORD = "suporte+TV1";

function cleanHeaderValue(value) {
  return String(value || "")
    .replace(/[\r\n\t]/g, "")
    .trim();
}

function cleanToken(value) {
  return String(value || "")
    .replace(/^Bearer\s+/i, "")
    .replace(/[\r\n\t]/g, "")
    .trim();
}

function looksLikeNewbrToken(value) {
  const token = cleanToken(value);
  if (!token) return false;
  return /^[A-Za-z0-9_-]+\|[A-Za-z0-9_-]{20,}$/.test(token);
}

function findToken(data) {
  if (!data) return null;

  const tokenKeys = ["token", "access_token", "bearer_token", "jwt"];

  if (typeof data === "string") {
    const token = cleanToken(data);
    return looksLikeNewbrToken(token) ? token : null;
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findToken(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof data === "object") {
    for (const key of tokenKeys) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const value = data[key];
        if (typeof value === "string") {
          const token = cleanToken(value);
          if (looksLikeNewbrToken(token)) return token;
        }
      }
    }

    for (const value of Object.values(data)) {
      if (value && typeof value === "object") {
        const found = findToken(value);
        if (found) return found;
      }
    }
  }

  return null;
}

function ensureCredentials() {
  if (
    !SAVED_USERNAME ||
    !SAVED_PASSWORD ||
    SAVED_USERNAME.includes("COLOQUE_") ||
    SAVED_PASSWORD.includes("COLOQUE_")
  ) {
    throw new Error("Credenciais nao configuradas no arquivo newbr-login-worker.js.");
  }
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function loginWithSavedCredentials() {
  ensureCredentials();

  const response = await fetch(NEWBR_LOGIN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Locale: "pt",
      "X-App-Version": "3.81",
    },
    body: JSON.stringify({
      captcha: "not-a-robot",
      captchaChecked: true,
      username: SAVED_USERNAME,
      password: SAVED_PASSWORD,
      twofactor_code: "",
      twofactor_recovery_code: "",
      twofactor_trusted_device_id: "",
    }),
    credentials: "omit",
    referrerPolicy: "strict-origin-when-cross-origin",
  });

  const data = await parseResponse(response);
  const token = findToken(data);

  return {
    ok: response.ok,
    status: response.status,
    username: SAVED_USERNAME,
    token,
    data,
  };
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeNewbrId(value) {
  return String(value || "")
    .replace(/^newbr-/i, "")
    .trim()
    .toLowerCase();
}

function extractCustomerRows(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.customers)) return payload.customers;
  if (payload.result && Array.isArray(payload.result.data)) return payload.result.data;
  return [];
}

function customerMatchesRenewal(row, renewal) {
  const renewalPhone = normalizeDigits(
    renewal.phone ||
      renewal.whatsapp ||
      renewal.customer_phone ||
      renewal.customerPhone ||
      ""
  );

  const renewalUsername = String(
    renewal.username ||
      renewal.user ||
      renewal.usuario ||
      ""
  )
    .trim()
    .toLowerCase();

  const renewalCustomerId = normalizeNewbrId(
    renewal.customer_id ||
      renewal.customerId ||
      ""
  );

  const rowPhone = normalizeDigits(
    row.whatsapp ||
      row.phone ||
      row.telefone ||
      row.mobile ||
      ""
  );

  const rowUsername = String(
    row.username ||
      row.usuario ||
      row.user ||
      ""
  )
    .trim()
    .toLowerCase();

  const rowId = normalizeNewbrId(row.id || row.customer_id || row.customerId || "");

  if (renewalPhone && rowPhone && rowPhone === renewalPhone) return true;
  if (renewalUsername && rowUsername && rowUsername === renewalUsername) return true;
  if (renewalCustomerId && rowId && rowId === renewalCustomerId) return true;

  return false;
}

async function fetchCustomersBySearch(token, search) {
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
    perPage: "20",
  });

  const response = await fetch(`${NEWBR_BASE_URL}/api/customers?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      Locale: "pt",
      "X-App-Version": "3.81",
    },
    credentials: "omit",
    referrerPolicy: "strict-origin-when-cross-origin",
  });

  const data = await parseResponse(response);

  if (!response.ok) {
    const message =
      typeof data?.message === "string"
        ? data.message
        : typeof data?.error === "string"
          ? data.error
          : `Falha ao pesquisar cliente NewBR (${response.status}).`;

    throw new Error(message);
  }

  return extractCustomerRows(data);
}

async function resolveNewbrCustomerForRenewal(token, renewal) {
  const phone = normalizeDigits(
    renewal.phone ||
      renewal.whatsapp ||
      renewal.customer_phone ||
      renewal.customerPhone ||
      ""
  );

  const username = String(
    renewal.username ||
      renewal.user ||
      renewal.usuario ||
      ""
  ).trim();

  const customerId = String(
    renewal.customer_id ||
      renewal.customerId ||
      ""
  ).trim();

  const searchTerms = [
    phone,
    phone.startsWith("55") ? phone.slice(2) : "",
    username,
    customerId.replace(/^newbr-/i, ""),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);

  for (const search of searchTerms) {
    const rows = await fetchCustomersBySearch(token, search);

    const exact = rows.find((row) => customerMatchesRenewal(row, renewal));
    if (exact) return exact;

    if (rows.length === 1) return rows[0];
  }

  throw new Error(
    `Cliente NewBR não encontrado para renovação. Telefone: ${phone || "-"} | Usuário: ${username || "-"}`
  );
}

async function renewCustomerWithToken(token, renewal) {
  const cleanBearerToken = cleanToken(token);

  if (!cleanBearerToken || cleanBearerToken.length < 20) {
    throw new Error("Token invalido para montar Authorization.");
  }

  const requestedPackageId = cleanHeaderValue(renewal.package_id || renewal.packageId);
  const requestedConnections = Number(renewal.connections || 1);

  if (!requestedPackageId) throw new Error("package_id ausente.");

  const customer = await resolveNewbrCustomerForRenewal(cleanBearerToken, renewal);

  const resolvedCustomerId = cleanHeaderValue(customer.id || customer.customer_id || customer.customerId);
  const resolvedPackageId = requestedPackageId || cleanHeaderValue(customer.package_id || customer.packageId);
  const resolvedConnections = Math.max(
    1,
    Number(requestedConnections || customer.connections || 1) || 1
  );

  if (!resolvedCustomerId) {
    throw new Error("ID real do cliente NewBR não encontrado.");
  }

  if (/^newbr-/i.test(resolvedCustomerId)) {
  throw new Error(
    `ID inválido para renovar: ${resolvedCustomerId}. A renovação precisa usar o id real retornado por /api/customers, não o customerId local.`
  );
}

  if (!resolvedPackageId) {
    throw new Error("package_id ausente após pesquisa do cliente.");
  }

  const response = await fetch(`${NEWBR_BASE_URL}/api/customers/${encodeURIComponent(resolvedCustomerId)}/renew`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${cleanBearerToken}`,
      Locale: "pt",
      "X-App-Version": "3.81",
    },
    body: JSON.stringify({
      package_id: resolvedPackageId,
      connections: resolvedConnections,
    }),
    credentials: "omit",
    referrerPolicy: "strict-origin-when-cross-origin",
  });

  const data = await parseResponse(response);

  return {
    ok: response.ok,
    status: response.status,
    data,
    resolvedCustomer: {
      id: resolvedCustomerId,
      username: customer.username || null,
      whatsapp: customer.whatsapp || null,
      package_id: customer.package_id || null,
      connections: customer.connections || null,
    },
    renewPayload: {
      package_id: resolvedPackageId,
      connections: resolvedConnections,
    },
  };
}

self.onmessage = async function onMessage(event) {
  const message = event.data || {};
  const type = message.type;
  const renewal = message.renewal || null;
  const savedToken = cleanToken(message.token || message.bearerToken || "");

  if (!["PREPARE_ONLY", "RENEW_NOW_BROWSER"].includes(type)) return;

  try {
    const login = savedToken
      ? {
          ok: true,
          status: 200,
          username: SAVED_USERNAME,
          token: savedToken,
          data: { source: "saved-token" },
        }
      : await loginWithSavedCredentials();
    let renew = null;

    if (type === "RENEW_NOW_BROWSER" && login.ok && login.token) {
      if (type === "RENEW_NOW_BROWSER" && login.ok && login.token) {
  const hasLookup =
    renewal &&
    (
      renewal.phone ||
      renewal.whatsapp ||
      renewal.username ||
      renewal.user ||
      renewal.usuario ||
      renewal.customer_id ||
      renewal.customerId
    );

  const hasPackage = renewal && (renewal.package_id || renewal.packageId);

  if (!hasLookup || !hasPackage) {
    throw new Error("Dados de renovacao ausentes: informe telefone/usuario e package_id.");
  }

  renew = await renewCustomerWithToken(login.token, renewal);
}
    }

    self.postMessage({
      type: "FLOW_RESULT",
      mode: type,
      login,
      renew,
    });
  } catch (error) {
    self.postMessage({
      type: "FLOW_ERROR",
      ok: false,
      message: error.message,
    });
  }
};
