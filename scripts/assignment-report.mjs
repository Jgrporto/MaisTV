import 'dotenv/config';

import { closePostgres, query } from '../server/db/postgres.mjs';
import { checkQueues, closeQueues } from '../server/queues/queues.mjs';

const tenantId = process.env.CHAT_DEFAULT_TENANT_ID || 'maistv';
try {
  const [mappings, presence, memberships, queued, assigned, events, queues] = await Promise.all([
    query('SELECT * FROM queue_route_mappings WHERE tenant_id=$1 ORDER BY route_key,phone_number_id', [tenantId]),
    query('SELECT * FROM agent_presence WHERE tenant_id=$1 ORDER BY updated_at DESC', [tenantId]),
    query('SELECT * FROM queue_memberships WHERE tenant_id=$1 ORDER BY queue_id,user_id', [tenantId]),
    query(`SELECT id,contact_phone,route_key,phone_number_id,queue_id,service_id,assignment_status,unread_count,last_message_at
      FROM conversations WHERE tenant_id=$1 AND assignment_status IN ('queued','unassigned') ORDER BY updated_at DESC LIMIT 50`, [tenantId]),
    query(`SELECT id,contact_phone,route_key,queue_id,assigned_agent_id,assigned_agent_name,assignment_status,assigned_at,last_message_at
      FROM conversations WHERE tenant_id=$1 AND assigned_agent_id IS NOT NULL ORDER BY assigned_at DESC NULLS LAST LIMIT 50`, [tenantId]),
    query('SELECT * FROM conversation_assignment_events WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100', [tenantId]),
    checkQueues(),
  ]);
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),tenantId,queues,
    mappings: mappings.rows,presence: presence.rows,memberships: memberships.rows,
    queued: queued.rows,assigned: assigned.rows,events: events.rows,
  }, null, 2));
} catch (error) {
  console.error('[assignment:report] erro:', error.message);
  process.exitCode = 1;
} finally {
  await Promise.all([closePostgres().catch(() => {}), closeQueues().catch(() => {})]);
}
