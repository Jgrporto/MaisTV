import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import {
  isSqlStoreEnabled,
  resolveStoreKeyByPath,
  upsertSqlStoreValue,
} from "./sql-store.js";

const DEFAULT_FILES = [
  process.env.WHATSAPP_STORE_PATH || "server/data/whatsapp-store.json",
  process.env.WHATSAPP_COEXISTENCE_PATH || "server/data/whatsapp-coexistencia.json",
  process.env.PANEL_NEWBR_CUSTOMERS_PATH || "server/data/painel-customers.json",
  process.env.PANEL_NEWBR_SYNC_STATE_PATH || "server/data/painel-sync.json",
  process.env.MESSAGE_DELIVERY_LOG_PATH || "server/data/message-delivery-log.json",
  process.env.WHATSAPP_QUICK_REPLIES_PATH || "server/data/quick-replies.json",
  process.env.WHATSAPP_LOCAL_TEMPLATES_PATH || "server/data/whatsapp-local-templates.json",
  process.env.ROUTINES_STORE_PATH || "server/data/routines.json",
  process.env.ROUTINE_LOG_STORE_PATH || "server/data/routine-logs.json",
  process.env.UI_PREFERENCES_PATH || "server/data/ui-preferences.json",
  process.env.PANEL_AGENT_JOBS_PATH || "server/data/painel-agent-jobs.json",
  process.env.PANEL_NEWBR_STORAGE_PATH || "server/data/painel-newbr.json",
];

const parseJsonFile = async (absolutePath) => {
  const raw = await fs.readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("JSON raiz precisa ser um objeto");
  }
  return parsed;
};

const main = async () => {
  if (!isSqlStoreEnabled()) {
    throw new Error(
      "SQL store desabilitado. Defina SQL_STORE_ENABLED=true e SQL_STORE_DATABASE_URL.",
    );
  }

  let migrated = 0;
  let skipped = 0;
  for (const relativeFile of DEFAULT_FILES) {
    const absolutePath = path.resolve(process.cwd(), relativeFile);
    const storeKey = resolveStoreKeyByPath(absolutePath);
    if (!storeKey) {
      skipped += 1;
      console.log(`[skip] sem mapeamento SQL: ${relativeFile}`);
      continue;
    }
    try {
      const payload = await parseJsonFile(absolutePath);
      await upsertSqlStoreValue(storeKey, payload);
      migrated += 1;
      console.log(`[ok] ${relativeFile} -> ${storeKey}`);
    } catch (error) {
      if (error?.code === "ENOENT") {
        skipped += 1;
        console.log(`[skip] arquivo ausente: ${relativeFile}`);
        continue;
      }
      throw new Error(`[fail] ${relativeFile}: ${error?.message || error}`);
    }
  }

  console.log(`[done] migrados=${migrated} ignorados=${skipped}`);
};

main().catch((error) => {
  console.error("[migrate-json-to-sql] erro:", error?.message || error);
  process.exit(1);
});
