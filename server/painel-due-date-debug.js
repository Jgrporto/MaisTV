import "dotenv/config";

import { chromium as pwChromium } from "playwright";

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return "";
};

const showUsage = () => {
  console.log("Uso:");
  console.log("  node server/painel-due-date-debug.js --due-date 2026-02-06");
  console.log("Opcoes:");
  console.log("  --proxy http://user:pass@host:port");
  console.log("  --proxy-brd (monta proxy Bright Data via env BRD_PROXY_*)");
  console.log("  --headed (forca headless=false)");
  console.log("  --headless (forca headless=true)");
  console.log("  --max-pages N");
  console.log("  --max-items N");
  console.log("  --first (imprime 1 cliente: usuario + telefone)");
  console.log("  --no-preflight (pula teste do proxy no geo.brdtest.com)");
  console.log("  --pause (aguarda Enter para fechar)");
};

const dueDate = getArg("--due-date");
if (!dueDate) {
  showUsage();
  process.exit(1);
}

const maskProxyUser = (value) => {
  const raw = String(value || "");
  if (!raw) return "";
  const maskRawUser = (user) => {
    const u = String(user || "");
    if (!u) return "";
    if (u.length <= 4) return `${u.slice(0, 1)}***`;
    return `${u.slice(0, 2)}***${u.slice(-2)}`;
  };
  if (!raw.includes("@") && !raw.includes("://")) {
    return maskRawUser(raw);
  }
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    const user = url.username ? decodeURIComponent(url.username) : "";
    return maskRawUser(user);
  } catch {
    return "";
  }
};

const buildBrightDataProxyFromEnv = () => {
  // Prefer BRD_PROXY_*; fallback to existing PANEL_NEWBR_PROXY (already complete).
  const existing = process.env.PANEL_NEWBR_PROXY || "";
  const server = process.env.BRD_PROXY_SERVER || "brd.superproxy.io:33335";
  const username = process.env.BRD_PROXY_USER || "";
  const password = process.env.BRD_PROXY_PASS || "";
  if (!username || !password) {
    if (existing) return existing;
    throw new Error("Missing BRD_PROXY_USER or BRD_PROXY_PASS for --proxy-brd.");
  }
  const normalizedServer = server.includes("://") ? server.replace(/^https?:\/\//, "") : server;
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${normalizedServer}`;
};

const proxyArg = getArg("--proxy");
const shouldBuildBrightDataProxy = hasFlag("--proxy-brd");
if (shouldBuildBrightDataProxy) {
  process.env.PANEL_NEWBR_PROXY = buildBrightDataProxyFromEnv();
} else if (proxyArg) {
  process.env.PANEL_NEWBR_PROXY = proxyArg;
}

// Nao sobrescreve PANEL_NEWBR_URL aqui. O fluxo por vencimento ja navega para o dashboard,
// e PANEL_NEWBR_URL precisa apontar para a rota de clientes para o navigateToCustomers funcionar.

if (hasFlag("--headless")) {
  process.env.PANEL_NEWBR_HEADLESS = "true";
} else {
  process.env.PANEL_NEWBR_HEADLESS = "false";
}
if (hasFlag("--headed")) {
  process.env.PANEL_NEWBR_HEADLESS = "false";
}

process.env.PANEL_NEWBR_DUE_DATE_DIAG = "true";
process.env.PANEL_NEWBR_DEBUG ||= "true";

const maxPagesRaw = getArg("--max-pages");
const maxItemsRaw = getArg("--max-items");
const maxPages = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : undefined;
const maxItems = maxItemsRaw ? Number.parseInt(maxItemsRaw, 10) : undefined;
const shouldPrintFirst = hasFlag("--first");
const shouldPreflight = !hasFlag("--no-preflight");
const shouldPause = hasFlag("--pause");

const log = (msg) => console.log(`[painel-due-date] ${msg}`);

const preflightProxy = async (proxyUrl) => {
  if (!proxyUrl) return;

  let server = "";
  let username = "";
  let password = "";
  try {
    const parsed = new URL(proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`);
    server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    username = parsed.username ? decodeURIComponent(parsed.username) : "";
    password = parsed.password ? decodeURIComponent(parsed.password) : "";
  } catch {
    server = proxyUrl;
  }

  if (proxyUrl.includes("http://user:pass@")) {
    throw new Error("Proxy parece placeholder (user:pass). Use credenciais reais ou --proxy-brd.");
  }

  log(`Preflight proxy: ${server}${username ? ` (user: ${maskProxyUser(username)})` : ""}`);
  const browser = await pwChromium.launch({
    headless: true,
    proxy: username || password ? { server, username, password } : { server },
  });
  try {
    const page = await browser.newPage();
    const resp = await page.goto("https://geo.brdtest.com/welcome.txt?product=isp&method=native", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const status = resp?.status();
    const body = await page.content().catch(() => "");
    log(`Preflight OK. geo status: ${typeof status === "number" ? status : "?"}`);
    if (body) {
      const snippet = body.replace(/\s+/g, " ").slice(0, 160);
      log(`Preflight body: ${snippet}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
};

const run = async () => {
  const { fetchPainelCustomersByDueDate } = await import("./painel-newbr.js");
  log(`Due date: ${dueDate}`);
  const proxy = process.env.PANEL_NEWBR_PROXY || "";
  log(`Proxy ativo: ${proxy ? `sim (user: ${maskProxyUser(proxy) || "?"})` : "nenhum"}`);
  log(`Headless: ${process.env.PANEL_NEWBR_HEADLESS !== "false"}`);

  if (shouldPreflight && proxy) {
    await preflightProxy(proxy);
  }

  const result = await fetchPainelCustomersByDueDate({
    dueDate,
    maxPages: Number.isFinite(maxPages) ? maxPages : undefined,
    maxItems: Number.isFinite(maxItems) ? maxItems : undefined,
    onLog: (message) => log(message),
  });

  if (shouldPrintFirst) {
    const first = Array.isArray(result?.rows) ? result.rows.find((row) => row && row.phone) : null;
    if (!first) {
      log("Nenhum cliente com telefone encontrado neste vencimento.");
    } else {
      console.log(JSON.stringify({ usuario: first.usuario || null, phone: first.phone || null }, null, 2));
    }
  } else {
    log(`Resultado: ${JSON.stringify(result)}`);
  }

  if (shouldPause) {
    log("Pressione Enter para encerrar...");
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once("data", resolve));
  }
};

run().catch((error) => {
  console.error(`[painel-due-date] Erro: ${error?.message || error}`);
  process.exit(1);
});
