import "dotenv/config";

process.env.MAISTV_RUNTIME_ROLE = "worker";
process.env.WHATSAPP_HTTP_ENABLED = "false";
process.env.WHATSAPP_SCHEDULERS_ENABLED = "true";

await import("./whatsapp-server.js");

setInterval(() => {}, 60 * 60 * 1000);
