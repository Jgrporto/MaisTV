import 'dotenv/config';

import { closePostgres, query, withTransaction } from '../server/db/postgres.mjs';

const standardLabels = ['system-lead', 'system-sql', 'system-cliente', 'system-pos-venda', 'system-cancelados'];
const args = process.argv.slice(2);
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] || '') : fallback;
};
const mappings = args.flatMap((item, index) => item === '--map' ? [String(args[index + 1] || '')] : [])
  .map((item) => item.split('=').map((value) => value.trim()))
  .filter(([label, queueId]) => label && queueId);
const tenantId = valueOf('tenant', process.env.CHAT_DEFAULT_TENANT_ID || 'maistv').trim();
const confirm = args.includes('--confirm');

try {
  const invalidLabels = mappings.map(([label]) => label).filter((label) => !standardLabels.includes(label));
  if (invalidLabels.length) throw new Error(`Etiquetas invalidas: ${invalidLabels.join(', ')}`);
  if (new Set(mappings.map(([label]) => label)).size !== mappings.length) throw new Error('Nao repita --map para a mesma etiqueta.');

  const [queuesResult, existingResult] = await Promise.all([
    query('SELECT id,name,is_active FROM support_queues WHERE tenant_id=$1 ORDER BY name,id', [tenantId]),
    query(`SELECT label_key,queue_id,is_active FROM queue_label_mappings
      WHERE tenant_id=$1 AND label_key=ANY($2::text[])`, [tenantId, standardLabels]),
  ]);
  const activeQueues = new Map(queuesResult.rows.filter((row) => row.is_active).map((row) => [row.id, row]));
  const unknownQueues = mappings.map(([, queueId]) => queueId).filter((queueId) => !activeQueues.has(queueId));
  if (unknownQueues.length) throw new Error(`Filas inexistentes ou inativas: ${Array.from(new Set(unknownQueues)).join(', ')}`);

  const finalMappings = new Map(existingResult.rows.filter((row) => row.is_active).map((row) => [row.label_key, row.queue_id]));
  for (const [label, queueId] of mappings) finalMappings.set(label, queueId);
  const missingLabels = standardLabels.filter((label) => !activeQueues.has(finalMappings.get(label)));
  const plan = {
    tenantId, confirmed: confirm, changed: false,
    requestedMappings: Object.fromEntries(mappings),
    finalMappings: Object.fromEntries(standardLabels.map((label) => [label, finalMappings.get(label) || null])),
    missingLabels,
    availableActiveQueues: Array.from(activeQueues.values()),
  };
  if (missingLabels.length) throw Object.assign(new Error(`Mapeamentos obrigatorios ausentes: ${missingLabels.join(', ')}`), { plan });
  if (!confirm) {
    console.log(JSON.stringify({ ...plan, reason: 'dry_run_use_confirm' }, null, 2));
  } else {
    await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`label-queue-config:${tenantId}`]);
      for (const [label, queueId] of mappings) {
        await client.query(`
          INSERT INTO queue_label_mappings (tenant_id,queue_id,label_key,priority,is_active)
          VALUES ($1,$2,$3,100,true)
          ON CONFLICT (tenant_id,label_key) DO UPDATE SET
            queue_id=EXCLUDED.queue_id,is_active=true,updated_at=now()
        `, [tenantId, queueId, label]);
      }
    });
    console.log(JSON.stringify({ ...plan, changed: mappings.length > 0 }, null, 2));
  }
} catch (error) {
  console.error('[assignment:labels:configure] erro:', error.message);
  if (error.plan) console.error(JSON.stringify(error.plan, null, 2));
  process.exitCode = 1;
} finally {
  await closePostgres().catch(() => {});
}
