import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const requiredFiles = [
  '.env.homolog.example',
  'docker-compose.homolog.yml',
  'infra/nginx/homolog-test.conf',
  'infra/nginx/production-webhook-cutover.conf',
  'infra/nginx/production-webhook-cutover-vendas-only.conf',
  'infra/nginx/production-webhook-cutover-vendas.conf',
  'infra/nginx/production-webhook-cutover-all.conf',
  'infra/systemd/maistv-next-api.service',
  'infra/systemd/maistv-next-auth.service',
  'infra/systemd/maistv-next-whatsapp.service',
  'infra/systemd/maistv-next-checkout.service',
  'infra/systemd/maistv-next-sse.service',
  'infra/systemd/maistv-next-chat-worker@.service',
  'infra/systemd/maistv-next-worker.service',
  'infra/systemd/maistv-next-routine-worker.service',
  'infra/systemd/maistv-next-assignment-worker.service',
  'infra/systemd/maistv-next-transcription.service',
  'infra/systemd/cutover/maistv-next-worker.override.conf',
  'infra/systemd/cutover/maistv-next-routine-worker.override.conf',
  'scripts/prepare-maistv-next-webhook-cutover.sh',
  'scripts/enable-maistv-next-webhook-cutover.sh',
  'scripts/rollback-maistv-next-webhook-cutover.sh',
  'docs/maistv-next-webhook-cutover.md',
];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root,file))) throw new Error(`Missing blue-green deployment file: ${file}`);
}
const infraFiles = fs.readdirSync(path.join(root,'infra/systemd')).filter((file)=>file.endsWith('.service'));
for (const file of infraFiles) {
  if (!file.startsWith('maistv-next-')) throw new Error(`Unsafe systemd unit name: ${file}`);
  const content=fs.readFileSync(path.join(root,'infra/systemd',file),'utf8');
  if (content.includes('/root/SaasTV')) throw new Error(`Production path leaked into ${file}`);
  if (!content.includes('/root/MaisTV')) throw new Error(`Missing isolated working directory in ${file}`);
}
const nginx=fs.readFileSync(path.join(root,'infra/nginx/homolog-test.conf'),'utf8');
for (const expected of ['homolog-test.hakione.tech','api-homolog-test.hakione.tech','127.0.0.1:5350','127.0.0.1:5353','127.0.0.1:5355','127.0.0.1:5356']) {
  if (!nginx.includes(expected)) throw new Error(`Nginx homologation config is missing ${expected}`);
}
const firstCutover=fs.readFileSync(path.join(root,'infra/nginx/production-webhook-cutover.conf'),'utf8');
if (!firstCutover.includes('location = /api/whatsapp/webhook-vendas2')) throw new Error('Initial cutover must include vendas2.');
for (const expected of ['127.0.0.1:5350','X-Hub-Signature-256','Content-Type']) {
  if (!firstCutover.includes(expected)) throw new Error(`Initial cutover is missing ${expected}.`);
}
for (const forbidden of ['location = /api/whatsapp/webhook {','location = /api/whatsapp/webhook-vendas {']) {
  if (firstCutover.includes(forbidden)) throw new Error(`Initial cutover has an unsafe extra route: ${forbidden}`);
}
for (const unit of ['maistv-next-whatsapp.service','maistv-next-checkout.service']) {
  const content=fs.readFileSync(path.join(root,'infra/systemd',unit),'utf8');
  if (!content.includes('127.0.0.1')) throw new Error(`Missing loopback bind in ${unit}`);
}
const homologEnv=fs.readFileSync(path.join(root,'.env.homolog.example'),'utf8');
for (const expected of ['WHATSAPP_SERVER_HOST=127.0.0.1','CHECKOUT_SERVER_HOST=127.0.0.1','WHATSAPP_WEBHOOK_CHAT_ONLY=true','SUPPORT_FLOW_EXECUTION_ENABLED=false']) {
  if (!homologEnv.includes(expected)) throw new Error(`Homologation environment is missing ${expected}.`);
}
console.log(JSON.stringify({ok:true,systemdUnits:infraFiles.sort(),nginxDomains:['homolog-test.hakione.tech','api-homolog-test.hakione.tech']},null,2));
