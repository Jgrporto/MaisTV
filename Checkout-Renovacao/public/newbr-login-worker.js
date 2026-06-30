const NEWBR_BASE_URL = "https://painel.newbr.top";
const NEWBR_LOGIN_URL = `${NEWBR_BASE_URL}/api/auth/login`;

/*
  Coloque aqui o usuário e senha da NewBR.

  Atenção:
  este arquivo é público no frontend.
*/
const SAVED_USERNAME = "COLOQUE_O_USUARIO_AQUI";
const SAVED_PASSWORD = "COLOQUE_A_SENHA_AQUI";

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

  // Formato observado na NewBR: número|string
  if (/^[0-9]+\|[A-Za-z0-9_-]{20,}$/.test(token)) {
    return true;
  }

  // Formato alternativo: texto|string
  if (/^[A-Za-z0-9_-]+\|[A-Za-z0-9_-]{20,}$/.test(token)) {
    return true;
  }

  return false;
}

function findToken(data) {
  if (!data) return null;

  const tokenKeys = [
    "token",
    "access_token",
    "bearer_token",
    "jwt"
  ];

  // Se vier string solta, só aceita se parecer token NewBR.
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
    // 1. Primeiro procura SOMENTE campos com nome de token.
    for (const key of tokenKeys) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const value = data[key];

        if (typeof value === "string") {
          const token = cleanToken(value);

          if (looksLikeNewbrToken(token)) {
            return token;
          }
        }
      }
    }

    // 2. Depois procura em objetos filhos, mas ainda respeitando a regra acima.
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
    throw new Error("Credenciais não configuradas no arquivo newbr-login-worker.js.");
  }
}

async function parseResponse(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

async function loginWithSavedCredentials() {
  ensureCredentials();

  const payload = {
    captcha: "not-a-robot",
    captchaChecked: true,
    username: SAVED_USERNAME,
    password: SAVED_PASSWORD,
    twofactor_code: "",
    twofactor_recovery_code: "",
    twofactor_trusted_device_id: ""
  };

  const response = await fetch(NEWBR_LOGIN_URL, {
    method: "POST",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Locale": "pt",
      "X-App-Version": "3.81"
    },
    body: JSON.stringify(payload),
    credentials: "omit",
    referrerPolicy: "strict-origin-when-cross-origin"
  });

  const data = await parseResponse(response);
  const token = findToken(data);

  return {
    ok: response.ok,
    status: response.status,
    token,
    data
  };
}

async function renewCustomerWithToken(token, renewal) {
  const cleanBearerToken = cleanToken(token);

  if (!cleanBearerToken || cleanBearerToken.length < 20) {
    throw new Error("Token inválido para montar Authorization.");
  }

  const customerId = cleanHeaderValue(renewal.customer_id);
  const packageId = cleanHeaderValue(renewal.package_id);
  const connections = Number(renewal.connections || 1);

  if (!customerId) {
    throw new Error("customer_id ausente.");
  }

  if (!packageId) {
    throw new Error("package_id ausente.");
  }

  const url = `${NEWBR_BASE_URL}/api/customers/${encodeURIComponent(customerId)}/renew`;

  const payload = {
    package_id: packageId,
    connections
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cleanBearerToken}`,
      "Locale": "pt",
      "X-App-Version": "3.81"
    },
    body: JSON.stringify(payload),
    credentials: "omit",
    referrerPolicy: "strict-origin-when-cross-origin"
  });

  const data = await parseResponse(response);

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

self.onmessage = async function(event) {
  const message = event.data || {};
  const type = message.type;
  const renewal = message.renewal || null;

  if (!["PREPARE_ONLY", "RENEW_NOW_BROWSER"].includes(type)) return;

  try {
    const login = await loginWithSavedCredentials();

    let renew = null;

    if (type === "RENEW_NOW_BROWSER" && login.ok && login.token) {
      if (!renewal || !renewal.customer_id || !renewal.package_id) {
        throw new Error("Dados de renovação ausentes.");
      }

      renew = await renewCustomerWithToken(login.token, renewal);
    }

    self.postMessage({
      type: "FLOW_RESULT",
      mode: type,
      login,
      renew
    });

  } catch (error) {
    self.postMessage({
      type: "FLOW_ERROR",
      ok: false,
      message: error.message
    });
  }
};
