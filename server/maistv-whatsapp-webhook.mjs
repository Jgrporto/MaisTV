import 'dotenv/config';

process.env.MAISTV_RUNTIME_ROLE = process.env.MAISTV_RUNTIME_ROLE || 'whatsapp-webhook';
process.env.WHATSAPP_HTTP_ENABLED = process.env.WHATSAPP_HTTP_ENABLED || 'true';
process.env.WHATSAPP_SCHEDULERS_ENABLED = process.env.WHATSAPP_SCHEDULERS_ENABLED || 'false';
process.env.WHATSAPP_HTTP_ROLE = process.env.WHATSAPP_HTTP_ROLE || 'webhook';

await import('./whatsapp-server.js');
