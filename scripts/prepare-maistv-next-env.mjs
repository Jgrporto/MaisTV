import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
const valueArg = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
};
const sourcePath = path.resolve(valueArg('--source', '/root/SaasTV/.env'));
const outputPath = path.resolve(valueArg('--output', '/etc/maistv-next/maistv-next.env'));
if (!args.includes('--confirm')) throw new Error('Use --confirm to write the isolated homologation environment file.');
if (!fs.existsSync(sourcePath)) throw new Error(`Source environment not found: ${sourcePath}`);

const source = dotenv.parse(fs.readFileSync(sourcePath, 'utf8'));
const existing = fs.existsSync(outputPath) ? dotenv.parse(fs.readFileSync(outputPath, 'utf8')) : {};
const postgresPassword = existing.POSTGRES_PASSWORD || crypto.randomBytes(32).toString('hex');
const tenantId = 'maistv';
const next = {
  ...source,
  NODE_ENV: 'production',
  CHAT_DEFAULT_TENANT_ID: tenantId,
  CHAT_ARCHITECTURE_ENABLED: 'true',
  CHAT_MIRROR_META_WEBHOOK_ENABLED: 'false',
  WHATSAPP_WEBHOOK_CHAT_ONLY: 'true',
  WHATSAPP_SERVER_HOST: '127.0.0.1',
  WHATSAPP_SERVER_PORT: '5350',
  CHECKOUT_SERVER_HOST: '127.0.0.1',
  CHECKOUT_SERVER_PORT: '5351',
  WHISPER_SERVICE_HOST: '127.0.0.1',
  WHISPER_SERVICE_PORT: '5354',
  WHISPER_SERVICE_URL: 'http://127.0.0.1:5354',
  AUTH_API_PORT: '5355',
  SSE_HOST: '127.0.0.1',
  SSE_PORT: '5356',
  LEGACY_AUTH_ME_URL: 'http://127.0.0.1:5355/api/local/auth/me',
  VITE_APP_BASE_URL: 'https://homolog-test.hakione.tech',
  VITE_API_BASE_URL: 'https://api-homolog-test.hakione.tech',
  VITE_LOCAL_API_BASE_URL: 'https://api-homolog-test.hakione.tech/api/local',
  VITE_WHATSAPP_API_BASE_URL: 'https://api-homolog-test.hakione.tech',
  VITE_CHAT_API_BASE_URL: 'https://api-homolog-test.hakione.tech',
  VITE_SSE_URL: 'https://api-homolog-test.hakione.tech',
  VITE_CHECKOUT_PUBLIC_URL: 'https://homolog-test.hakione.tech/checkout',
  CHECKOUT_PUBLIC_URL: 'https://homolog-test.hakione.tech/checkout',
  CHECKOUT_ALLOWED_ORIGIN: 'https://homolog-test.hakione.tech',
  WHATSAPP_ALLOWED_ORIGIN: 'https://homolog-test.hakione.tech',
  LOCAL_WHATSAPP_API_BASE_URL: 'http://127.0.0.1:5350',
  WHATSAPP_API_BASE_URL: 'http://127.0.0.1:5350',
  LOCAL_CHECKOUT_API_BASE_URL: 'http://127.0.0.1:5351',
  CHECKOUT_API_BASE_URL: 'http://127.0.0.1:5351',
  LOCAL_CHECKOUT_TOKEN_API_BASE_URL: 'http://127.0.0.1:5350',
  CHECKOUT_TOKEN_API_BASE_URL: 'http://127.0.0.1:5350',
  CHECKOUT_WHATSAPP_API_URL: 'http://127.0.0.1:5350',
  LOCAL_CHATBOT_API_BASE_URL: 'http://127.0.0.1:5353',
  WHATSAPP_TEMPLATE_MEDIA_PUBLIC_ORIGIN: 'https://api-homolog-test.hakione.tech',
  MERCADOPAGO_NOTIFICATION_URL: 'https://api-homolog-test.hakione.tech/api/mercadopago/webhook',
  MERCADOPAGO_CHECKOUT_BACK_URL: 'https://homolog-test.hakione.tech/checkout',
  VITE_ENABLE_NEW_CHAT_DATA_LAYER: 'true',
  VITE_ENABLE_SSE_REALTIME: 'true',
  VITE_ENABLE_CHAT_VIRTUALIZATION: 'true',
  VITE_CHECKOUT_RENEWAL_WORKER_ENABLED: 'false',
  CHAT_CORS_ORIGINS: 'https://homolog-test.hakione.tech',
  SSE_CORS_ORIGINS: 'https://homolog-test.hakione.tech',
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_BIND_HOST: '127.0.0.1',
  POSTGRES_PORT: '55432',
  POSTGRES_DATABASE: 'maistv_next',
  POSTGRES_USER: 'maistv_next',
  POSTGRES_PASSWORD: postgresPassword,
  POSTGRES_SSL: 'false',
  DATABASE_URL: '',
  REDIS_HOST: '127.0.0.1',
  REDIS_BIND_HOST: '127.0.0.1',
  REDIS_PORT: '56379',
  REDIS_DB: '0',
  REDIS_TLS: 'false',
  REDIS_URL: '',
  BULLMQ_PREFIX: 'maistv-next',
  CHAT_BACKFILL_BATCH_SIZE: '500',
  SQLITE_DB_PATH: '/root/MaisTV/server/data/maistv.sqlite',
  WHATSAPP_BACKFILL_SQLITE_PATH: '/root/MaisTV/server/data/maistv.sqlite',
  WHATSAPP_HISTORY_DB_PATH: '/root/MaisTV/server/data/maistv-history.sqlite',
  LEGACY_MAIN_STORE_JSON_PATH: '/root/MaisTV/server/data/store.json',
  WHATSAPP_HTTP_ENABLED: 'true',
  SUPPORT_FLOW_EXECUTION_ENABLED: 'false',
  WHATSAPP_SCHEDULERS_ENABLED: 'false',
  ROUTINE_SCHEDULER_ENABLED: 'false',
  QUICK_REPLY_SCHEDULE_ENABLED: 'false',
  ROUTINE_DISPATCH_QUEUE_ENABLED: 'false',
  ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED: 'false',
  CHECKOUT_RENEWAL_DISABLED: 'true',
  META_ACCESS_TOKEN: source.WHATSAPP_ACCESS_TOKEN || '',
  META_APP_SECRET: source.WHATSAPP_APP_SECRET || '',
  META_WEBHOOK_VERIFY_TOKEN: source.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
  META_PHONE_NUMBER_ID: source.WHATSAPP_PHONE_NUMBER_ID || '',
  META_GRAPH_VERSION: source.WHATSAPP_API_VERSION || 'v19.0',
  STORAGE_PROVIDER: existing.STORAGE_PROVIDER || 'r2',
  S3_ENDPOINT: existing.S3_ENDPOINT || '',
  S3_REGION: existing.S3_REGION || 'auto',
  S3_BUCKET: existing.S3_BUCKET || '',
  S3_ACCESS_KEY_ID: existing.S3_ACCESS_KEY_ID || '',
  S3_SECRET_ACCESS_KEY: existing.S3_SECRET_ACCESS_KEY || '',
  S3_PUBLIC_BASE_URL: existing.S3_PUBLIC_BASE_URL || '',
  S3_FORCE_PATH_STYLE: existing.S3_FORCE_PATH_STYLE || 'false',
  MEDIA_SIGNED_URL_TTL_SECONDS: existing.MEDIA_SIGNED_URL_TTL_SECONDS || '300',
};

for (const phoneNumberId of [source.WHATSAPP_PHONE_NUMBER_ID,source.WHATSAPP_VENDAS_PHONE_NUMBER_ID,source.WHATSAPP_VENDAS2_PHONE_NUMBER_ID]) {
  const normalized = String(phoneNumberId || '').replace(/\D/g, '');
  if (normalized) next[`META_TENANT_${normalized}`] = tenantId;
}
delete next.PORT;

const serialize = (value) => JSON.stringify(String(value ?? ''));
const content = `${Object.keys(next).sort().map((key) => `${key}=${serialize(next[key])}`).join('\n')}\n`;
fs.mkdirSync(path.dirname(outputPath), { recursive:true, mode:0o750 });
fs.writeFileSync(outputPath,content,{mode:0o600});
fs.chmodSync(outputPath,0o600);
console.log(JSON.stringify({ok:true,source:sourcePath,output:outputPath,keys:Object.keys(next).length,ports:{whatsapp:5350,checkout:5351,api:5353,whisper:5354,auth:5355,sse:5356,postgres:55432,redis:56379}},null,2));
