import "dotenv/config";

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return "";
};

const showUsage = () => {
  console.log("Uso:");
  console.log("  node server/painel-sync-now-debug.js --phone 5524992478084");
  console.log("Opcoes:");
  console.log("  --api-base http://localhost:5050");
};

const phone = getArg("--phone");
if (!phone) {
  showUsage();
  process.exit(1);
}

const apiBase = getArg("--api-base") || "http://localhost:5050";
const baseUrl = apiBase.replace(/\/+$/, "");
const url = `${baseUrl}/api/painel/customer?phone=${encodeURIComponent(phone)}&source=panel`;

const run = async () => {
  console.log(`[painel-sync-now] GET ${url}`);
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  try {
    const data = JSON.parse(text);
    console.log(JSON.stringify(data, null, 2));
  } catch {
    console.log(text);
  }
};

run().catch((error) => {
  console.error(`[painel-sync-now] Erro: ${error?.message || error}`);
  process.exit(1);
});
