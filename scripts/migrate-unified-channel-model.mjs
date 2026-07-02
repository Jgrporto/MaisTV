import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJsonBackedStore } from '../server/sql-store.js';
import { withTransaction, closePostgres } from '../server/db/postgres.mjs';
import { saveQueueConfiguration } from '../server/repositories/queue-config.repository.mjs';
import { syncCustomerProfilesFromRows } from '../server/services/customer-profile.service.mjs';

const confirmed = process.argv.includes('--confirm');
const tenantId = process.env.CHAT_DEFAULT_TENANT_ID || 'maistv';
const storePath = process.env.MAIN_STORE_PATH || path.resolve('server/data/store.json');
const readJson = async () => {
  try { return JSON.parse(await fs.readFile(storePath, 'utf8')); } catch { return {}; }
};

try {
  const store = await readJsonBackedStore(storePath, {}, readJson);
  const services = Array.isArray(store?.services) ? store.services : [];
  const customers = Array.isArray(store?.customers) ? store.customers : [];
  const plan = {
    tenantId,
    queues: services.map((service) => ({
      id: String(service.id || '').trim(),
      name: String(service.name || service.id || '').trim(),
      labelIds: Array.from(new Set(service.label_ids || service.labelIds || [])).filter(Boolean),
      userIds: Array.from(new Set(service.user_ids || service.userIds || [])).filter(Boolean),
    })).filter((queue) => queue.id && queue.name),
    customerRows: customers.length,
  };
  if (!confirmed) {
    console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    process.exitCode = 0;
  } else {
    await withTransaction(async (client) => {
      for (const queue of plan.queues) {
        await saveQueueConfiguration({
          tenantId, id: queue.id, name: queue.name,
          description: String(services.find((service) => String(service.id) === queue.id)?.description || ''),
          iconKey: String(services.find((service) => String(service.id) === queue.id)?.icon_key || 'headphones'),
          isActive: true, priority: 100, labelIds: queue.labelIds, userIds: queue.userIds,
        }, client);
      }
    });
    const profiles = await syncCustomerProfilesFromRows({ tenantId, rows: customers });
    console.log(JSON.stringify({ dryRun: false, migratedQueues: plan.queues.length, ...profiles }, null, 2));
  }
} finally {
  await closePostgres();
}

