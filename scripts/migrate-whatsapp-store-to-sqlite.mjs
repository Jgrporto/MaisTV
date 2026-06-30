import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonBackedStore } from "../server/sql-store.js";
import {
  getWhatsappSqliteStoreStatus,
  isWhatsappSqliteStoreEnabled,
  replaceWhatsappSqliteStore,
} from "../server/whatsapp-sqlite-store.js";

const whatsappStorePath = path.resolve(
  process.cwd(),
  process.env.WHATSAPP_STORE_PATH || "server/data/whatsapp-store.json",
);

const emptyWhatsappStore = () => ({
  conversations: {},
  messages: {},
  session: {
    status: "disconnected",
    qrCode: null,
    lastConnectedAt: null,
    updatedAt: null,
  },
});

const readFromJsonFile = async () => {
  try {
    const raw = await fs.readFile(whatsappStorePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : emptyWhatsappStore();
  } catch (error) {
    if (error?.code === "ENOENT") return emptyWhatsappStore();
    throw error;
  }
};

const normalizeStore = (store = {}) => ({
  ...emptyWhatsappStore(),
  ...(store && typeof store === "object" ? store : {}),
  conversations:
    store?.conversations && typeof store.conversations === "object" && !Array.isArray(store.conversations)
      ? store.conversations
      : {},
  messages:
    store?.messages && typeof store.messages === "object" && !Array.isArray(store.messages)
      ? store.messages
      : {},
});

const main = async () => {
  if (!isWhatsappSqliteStoreEnabled()) {
    throw new Error("WHATSAPP_SQLITE_STORE_ENABLED/SQL_STORE_DRIVER=sqlite nao esta ativo.");
  }

  const source = normalizeStore(
    await readJsonBackedStore(whatsappStorePath, emptyWhatsappStore(), readFromJsonFile),
  );
  const conversationCount = Object.keys(source.conversations || {}).length;
  const messageCount = Object.values(source.messages || {}).reduce(
    (total, messages) => total + (Array.isArray(messages) ? messages.length : 0),
    0,
  );

  await replaceWhatsappSqliteStore(source);
  const status = getWhatsappSqliteStoreStatus();

  console.log(
    JSON.stringify(
      {
        ok: true,
        source: whatsappStorePath,
        migrated: {
          conversations: conversationCount,
          messages: messageCount,
        },
        sqlite: status,
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  console.error("[migrate-whatsapp-store-to-sqlite] erro:", error?.message || error);
  process.exit(1);
});
