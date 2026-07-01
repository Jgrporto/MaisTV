import 'dotenv/config';

import { closePostgres, withTransaction } from '../server/db/postgres.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((entries, item, index, all) => {
  if (item.startsWith('--')) entries.push([item.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1] || 'true']);
  return entries;
}, []));

const tenantId = String(args.tenant || process.env.CHAT_DEFAULT_TENANT_ID || 'maistv').trim();
const routeKey = String(args.route || '').trim().toLowerCase();
const phoneNumberId = String(args['phone-number-id'] || '').replace(/\D/g, '');
const queueId = String(args['queue-id'] || '').trim();
const serviceId = String(args['service-id'] || '').trim();
const queueName = String(args['queue-name'] || routeKey).trim();
const confirm = args.confirm === 'true';

try {
  if (!routeKey || !queueId) throw new Error('Informe --route e --queue-id.');
  const plan = { tenantId, routeKey, phoneNumberId, queueId, serviceId: serviceId || null, queueName, confirmed: confirm };
  if (!confirm) {
    console.log(JSON.stringify({ ...plan, changed: false, reason: 'dry_run_use_confirm' }, null, 2));
  } else {
    const result = await withTransaction(async (client) => {
      await client.query(`INSERT INTO support_queues (tenant_id,id,name,service_id,is_active)
        VALUES ($1,$2,$3,$4,true) ON CONFLICT (tenant_id,id) DO UPDATE SET
        name=EXCLUDED.name,service_id=EXCLUDED.service_id,is_active=true,updated_at=now()`,
      [tenantId, queueId, queueName, serviceId || null]);
      return (await client.query(`INSERT INTO queue_route_mappings
        (tenant_id,route_key,phone_number_id,queue_id,service_id,is_active)
        VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (tenant_id,route_key,phone_number_id) DO UPDATE SET
        queue_id=EXCLUDED.queue_id,service_id=EXCLUDED.service_id,is_active=true,updated_at=now() RETURNING *`,
      [tenantId, routeKey, phoneNumberId, queueId, serviceId || null])).rows[0];
    });
    console.log(JSON.stringify({ ...plan, changed: true, mapping: result }, null, 2));
  }
} catch (error) {
  console.error('[assignment:route:configure] erro:', error.message);
  process.exitCode = 1;
} finally {
  await closePostgres().catch(() => {});
}
