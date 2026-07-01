import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const requiredFiles = [
  '.env.homolog.example',
  'docker-compose.homolog.yml',
  'infra/nginx/homolog-test.conf',
  'infra/nginx/production-webhook-cutover.conf',
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
console.log(JSON.stringify({ok:true,systemdUnits:infraFiles.sort(),nginxDomains:['homolog-test.hakione.tech','api-homolog-test.hakione.tech']},null,2));
