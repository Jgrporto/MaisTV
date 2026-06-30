import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { syncPainelCustomers } from "./painel-newbr.js";

const API_BASE = String(process.env.PANEL_NEWBR_BASE_URL || "https://painel.newbr.top")
  .trim()
  .replace(/\/+$/, "");
const API_USERNAME = String(process.env.PANEL_NEWBR_USERNAME || "").trim();
const API_PASSWORD = String(process.env.PANEL_NEWBR_PASSWORD || "").trim();
const LOCAL_API_BASE = String(process.env.LOCAL_API_BASE || "http://127.0.0.1:5050")
  .trim()
  .replace(/\/+$/, "");
const PER_PAGE = Number.parseInt(process.env.PANEL_MISSING_PER_PAGE || "200", 10);
const MAX_PAGES = Number.parseInt(process.env.PANEL_MISSING_MAX_PAGES || "200", 10);
const REPORT_PATH = process.env.PANEL_MISSING_REPORT_PATH || "server/data/painel-missing-report.json";
const FORCE_BROWSER_SYNC = process.env.PANEL_MISSING_FORCE_BROWSER_SYNC === "true";

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits === "n/a") return "";
  if (digits.length >= 12 && digits.startsWith("55")) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
};

const normalizeIdentity = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const customerIdentity = (row) => {
  const customerId = normalizeIdentity(row?.customerId || row?.id || "");
  if (customerId) return `id:${customerId}`;
  const usuario = normalizeIdentity(row?.usuario || row?.username || row?.user || "");
  if (usuario) return `user:${usuario}`;
  const phone = normalizePhone(
    row?.whatsapp || row?.phone || row?.telefone || row?.mobile || row?.numero || row?.number || "",
  );
  if (phone) return `ph:${phone}`;
  return null;
};

const toComparableRow = (row) => ({
  identity: customerIdentity(row),
  customerId: row?.customerId || row?.id || null,
  usuario: row?.usuario || row?.username || row?.user || null,
  phone:
    normalizePhone(row?.whatsapp || row?.phone || row?.telefone || row?.mobile || row?.numero || row?.number) ||
    String(row?.phone || row?.whatsapp || "n/a"),
  planoAtual: row?.planoAtual || row?.packageName || null,
  vencimento: row?.vencimento || row?.expiresAtTz || row?.expiresAt || null,
});

const extractRowsFromPayload = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === "object");
  if (typeof payload === "object") {
    const keys = ["data", "items", "results", "customers", "rows"];
    for (const key of keys) {
      if (Array.isArray(payload[key])) {
        return payload[key].filter((item) => item && typeof item === "object");
      }
    }
  }
  return [];
};

const loginNewbr = async () => {
  if (!API_USERNAME || !API_PASSWORD) {
    throw new Error("Missing PANEL_NEWBR_USERNAME/PANEL_NEWBR_PASSWORD");
  }
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      captcha: "not-a-robot",
      captchaChecked: true,
      username: API_USERNAME,
      password: API_PASSWORD,
      twofactor_code: "",
      twofactor_recovery_code: "",
      twofactor_trusted_device_id: "",
    }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(`login failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const token =
    data?.token ||
    data?.access_token ||
    data?.accessToken ||
    data?.data?.token ||
    data?.data?.access_token ||
    data?.data?.accessToken ||
    null;
  if (!token) {
    throw new Error("login ok but token not found in response");
  }
  return token;
};

const fetchNewbrPage = async (token, page) => {
  const params = new URLSearchParams({
    page: String(page),
    perPage: String(PER_PAGE),
    username: "",
    serverId: "",
    packageId: "",
    expiryFrom: "",
    expiryTo: "",
    status: "",
    isTrial: "",
    connections: "",
  });
  const response = await fetch(`${API_BASE}/api/customers?${params.toString()}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(`customers page ${page} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return data;
};

const fetchAllNewbrCustomers = async () => {
  const token = await loginNewbr();
  const rows = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const payload = await fetchNewbrPage(token, page);
    const pageRows = extractRowsFromPayload(payload);
    rows.push(...pageRows);
    if (pageRows.length < PER_PAGE) break;
    page += 1;
  }
  return rows;
};

const fetchAllNewbrCustomersViaBrowserSync = async () => {
  const rows = [];
  await syncPainelCustomers({
    maxPages: Number.isFinite(MAX_PAGES) && MAX_PAGES > 0 ? MAX_PAGES : 0,
    onLog: (message) => {
      if (process.env.PANEL_MISSING_VERBOSE === "true") {
        console.log(`[missing-report][sync] ${message}`);
      }
    },
    onPage: async (pageRows) => {
      if (Array.isArray(pageRows)) rows.push(...pageRows);
    },
  });
  return rows;
};

const fetchLocalCustomers = async () => {
  const response = await fetch(`${LOCAL_API_BASE}/api/painel/customers`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`local /api/painel/customers failed (${response.status})`);
  }
  return Array.isArray(data?.rows) ? data.rows : [];
};

const main = async () => {
  console.log(`[missing-report] source=${API_BASE} local=${LOCAL_API_BASE}`);
  let sourceRowsRaw = [];
  let sourceMode = "api";
  if (FORCE_BROWSER_SYNC) {
    sourceMode = "browser-sync";
    sourceRowsRaw = await fetchAllNewbrCustomersViaBrowserSync();
  } else {
    try {
      sourceRowsRaw = await fetchAllNewbrCustomers();
    } catch (error) {
      const message = String(error?.message || error || "");
      const looksLikeCloudflare =
        /404|cloudflare|challenge|requested url was not found/i.test(message);
      if (!looksLikeCloudflare) throw error;
      console.log("[missing-report] API bloqueada (Cloudflare/404). Usando browser sync...");
      sourceMode = "browser-sync";
      sourceRowsRaw = await fetchAllNewbrCustomersViaBrowserSync();
    }
  }
  const localRowsRaw = await fetchLocalCustomers();
  const sourceRows = sourceRowsRaw.map(toComparableRow);
  const localRows = localRowsRaw.map(toComparableRow);

  const localSet = new Set(localRows.map((row) => row.identity).filter(Boolean));
  const sourceSet = new Set(sourceRows.map((row) => row.identity).filter(Boolean));
  const sourceWithIdentity = sourceRows.filter((row) => row.identity);
  const sourceWithoutIdentity = sourceRows.filter((row) => !row.identity);

  const missingInLocal = sourceWithIdentity.filter((row) => !localSet.has(row.identity));
  const localNotInSource = localRows.filter((row) => row.identity && !sourceSet.has(row.identity));

  const report = {
    generatedAt: new Date().toISOString(),
    sourceBaseUrl: API_BASE,
    sourceMode,
    localApiBase: LOCAL_API_BASE,
    totals: {
      sourceRaw: sourceRowsRaw.length,
      sourceComparable: sourceWithIdentity.length,
      sourceWithoutIdentity: sourceWithoutIdentity.length,
      localRaw: localRowsRaw.length,
      localComparable: localRows.filter((row) => row.identity).length,
      missingInLocal: missingInLocal.length,
      localNotInSource: localNotInSource.length,
    },
    missingInLocal,
    sourceWithoutIdentity,
    localNotInSource,
  };

  const outPath = path.resolve(process.cwd(), REPORT_PATH);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("[missing-report] done");
  console.log(JSON.stringify(report.totals, null, 2));
  console.log(`[missing-report] report: ${outPath}`);
};

main().catch((error) => {
  console.error(`[missing-report] error: ${error?.message || error}`);
  process.exit(1);
});
