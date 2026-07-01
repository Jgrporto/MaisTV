import crypto from 'node:crypto';
import 'dotenv/config';

const args = process.argv.slice(2);
const valueArg = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
};

if (!args.includes('--confirm')) {
  throw new Error('Use --confirm for the isolated homologation webhook test.');
}

const route = String(valueArg('--route', 'vendas2')).trim().toLowerCase();
const routes = {
  default: {
    path: '/api/whatsapp/webhook',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID,
    appSecret: process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET,
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  },
  vendas: {
    path: '/api/whatsapp/webhook-vendas',
    phoneNumberId: process.env.WHATSAPP_VENDAS_PHONE_NUMBER_ID,
    appSecret: process.env.WHATSAPP_VENDAS_APP_SECRET,
    businessAccountId: process.env.WHATSAPP_VENDAS_BUSINESS_ACCOUNT_ID,
  },
  vendas2: {
    path: '/api/whatsapp/webhook-vendas2',
    phoneNumberId: process.env.WHATSAPP_VENDAS2_PHONE_NUMBER_ID,
    appSecret: process.env.WHATSAPP_VENDAS2_APP_SECRET,
    businessAccountId: process.env.WHATSAPP_VENDAS2_BUSINESS_ACCOUNT_ID,
  },
};

const selected = routes[route];
if (!selected) throw new Error('Use --route default, --route vendas or --route vendas2.');

const url = valueArg('--url', `http://127.0.0.1:5350${selected.path}`);
const customerPhone = String(valueArg('--customer', '5500000000000')).replace(/\D/g, '');
const phoneNumberId = String(valueArg('--phone-number-id', selected.phoneNumberId || '')).trim();
const appSecret = String(selected.appSecret || '').trim();
if (!phoneNumberId || !appSecret) {
  throw new Error(`Phone number id and app secret are required for route ${route}.`);
}

const timestamp = Math.floor(Date.now() / 1000);
const providerMessageId = `wamid.HOMOLOG.${crypto.randomUUID()}`;
const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: selected.businessAccountId || 'homolog',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: {
          display_phone_number: process.env.WHATSAPP_DISPLAY_PHONE_NUMBER || '',
          phone_number_id: phoneNumberId,
        },
        contacts: [{ profile: { name: 'Teste Homologacao' }, wa_id: customerPhone }],
        messages: [{
          from: customerPhone,
          id: providerMessageId,
          timestamp: String(timestamp),
          text: { body: `[HOMOLOG:${route}] evento sintetico ${new Date().toISOString()}` },
          type: 'text',
        }],
      },
    }],
  }],
};

const raw = Buffer.from(JSON.stringify(payload));
const signature = `sha256=${crypto.createHmac('sha256', appSecret).update(raw).digest('hex')}`;
const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  body: raw,
});
const body = await response.text();
if (!response.ok) throw new Error(`Webhook test failed (${response.status}): ${body}`);
console.log(JSON.stringify({ ok: true, status: response.status, route, url, providerMessageId, response: body }, null, 2));
