import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { getSqlStoreConfig, upsertSqlStoreValue } from "./sql-store.js";

const sourcePath = path.resolve(
  process.cwd(),
  process.argv[2] || process.env.MAISTV_STORE_JSON_SOURCE || "server/data/store.json",
);

const objectCount = (value) => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
};

const normalizeCollection = (value, fallback) => {
  if (Array.isArray(fallback)) return Array.isArray(value) ? value : [];
  if (fallback && typeof fallback === "object") {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  return value ?? fallback;
};

const buildCleanMainStore = (source) => ({
  users: normalizeCollection(source.users, []),
  quickReplies: normalizeCollection(source.quickReplies, []),
  customers: normalizeCollection(source.customers, []),
  customerSync: normalizeCollection(source.customerSync, {}),
  customerSyncContext: normalizeCollection(source.customerSyncContext, {}),
  roles: normalizeCollection(source.roles, []),
  notificationSettings: normalizeCollection(source.notificationSettings, {}),
  labels: normalizeCollection(source.labels, {}),
  services: normalizeCollection(source.services, []),
  auth: normalizeCollection(source.auth, {}),
  customerSyncSettings: normalizeCollection(source.customerSyncSettings, {}),
  chatbotFlows: normalizeCollection(source.chatbotFlows, []),
  chatbotAssets: normalizeCollection(source.chatbotAssets, []),
  routines: normalizeCollection(source.routines, {}),
  quickReplyCategories: normalizeCollection(source.quickReplyCategories, []),
  quickReplySchedules: normalizeCollection(source.quickReplySchedules, []),

  conversations: {},
  messages: {},
  conversationPreferences: [],
  customerSyncLogs: [],
  chatbotExecutions: {},
  chatbotEvents: [],
});

const main = async () => {
  const config = getSqlStoreConfig();
  if (!config.enabled || config.driver !== "sqlite") {
    throw new Error("Configure SQL_STORE_DRIVER=sqlite, SQL_STORE_ENABLED=true e SQLITE_DB_PATH antes de migrar.");
  }

  const raw = await fs.readFile(sourcePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("O arquivo de origem precisa conter um objeto JSON.");
  }

  const cleanStore = buildCleanMainStore(parsed);
  await upsertSqlStoreValue("main_store", cleanStore);

  const summaryKeys = [
    "users",
    "quickReplies",
    "customers",
    "customerSync",
    "customerSyncContext",
    "roles",
    "notificationSettings",
    "labels",
    "services",
    "auth",
    "customerSyncSettings",
    "chatbotFlows",
    "chatbotAssets",
    "routines",
    "quickReplyCategories",
    "quickReplySchedules",
    "conversations",
    "messages",
    "conversationPreferences",
    "customerSyncLogs",
    "chatbotExecutions",
    "chatbotEvents",
  ];

  console.log("[migrate-store-json-to-sqlite] main_store migrado");
  console.log(
    JSON.stringify(
      {
        source: sourcePath,
        sqlitePath: config.sqlitePath,
        counts: Object.fromEntries(summaryKeys.map((key) => [key, objectCount(cleanStore[key])])),
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  console.error("[migrate-store-json-to-sqlite] erro:", error?.message || error);
  process.exit(1);
});
