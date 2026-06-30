import "dotenv/config";

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return "";
};

const proxyArg = getArg("--proxy");
if (proxyArg) {
  process.env.PANEL_NEWBR_PROXY = proxyArg;
}

if (hasFlag("--headed")) {
  process.env.PANEL_NEWBR_HEADLESS = "false";
}
if (hasFlag("--headless")) {
  process.env.PANEL_NEWBR_HEADLESS = "true";
}

process.env.PANEL_NEWBR_DEBUG ||= "true";
process.env.PANEL_NEWBR_DEBUG_PAGE_DUMP ||= "true";
process.env.PANEL_NEWBR_DEBUG_PAGE_WAIT_MS ||= "15000";

const log = (msg) => console.log(`[painel-debug] ${msg}`);

const showUsage = () => {
  console.log("Uso:");
  console.log("  node server/painel-debug-run.js --phone 5524992478084");
  console.log("  node server/painel-debug-run.js --sync");
  console.log("Opcoes:");
  console.log("  --proxy http://user:pass@host:port");
  console.log("  --headed (forca headless=false)");
  console.log("  --headless (forca headless=true)");
};

const phone = getArg("--phone");
const shouldSync = hasFlag("--sync");

if (!phone && !shouldSync) {
  showUsage();
  process.exit(1);
}

log(`Proxy ativo: ${process.env.PANEL_NEWBR_PROXY || "nenhum"}`);
log(`Headless: ${process.env.PANEL_NEWBR_HEADLESS !== "false"}`);

const run = async () => {
  const { fetchPainelCustomer, syncPainelCustomers } = await import("./painel-newbr.js");
  if (shouldSync) {
    log("Iniciando sync de teste...");
    const result = await syncPainelCustomers({
      onLog: (message) => log(message),
    });
    log(`Sync finalizado: ${JSON.stringify(result)}`);
    return;
  }

  log(`Buscando cliente: ${phone}`);
  const data = await fetchPainelCustomer(phone);
  console.log(JSON.stringify(data, null, 2));
};

run().catch((error) => {
  console.error(`[painel-debug] Erro: ${error?.message || error}`);
  process.exit(1);
});
