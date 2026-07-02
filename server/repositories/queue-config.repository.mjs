import { query } from '../db/postgres.mjs';

const executorOf = (executor) => executor || { query };

export const listQueueConfigurations = async ({ tenantId }, executor = null) =>
  (await executorOf(executor).query(`
    SELECT q.*,
      COALESCE(array_agg(DISTINCT lm.label_key) FILTER (WHERE lm.label_key IS NOT NULL),'{}') AS label_ids,
      COALESCE(array_agg(DISTINCT qm.user_id) FILTER (WHERE qm.user_id IS NOT NULL AND qm.is_active),'{}') AS user_ids,
      COALESCE(array_agg(DISTINCT ap.user_email) FILTER (WHERE ap.user_email IS NOT NULL AND qm.is_active),'{}') AS user_emails
    FROM support_queues q
    LEFT JOIN queue_label_mappings lm ON lm.tenant_id=q.tenant_id AND lm.queue_id=q.id AND lm.is_active=true
    LEFT JOIN queue_memberships qm ON qm.tenant_id=q.tenant_id AND qm.queue_id=q.id
    LEFT JOIN agent_presence ap ON ap.tenant_id=qm.tenant_id AND ap.user_id=qm.user_id
    WHERE q.tenant_id=$1
    GROUP BY q.tenant_id,q.id
    ORDER BY q.name,q.id
  `, [tenantId])).rows;

export const saveQueueConfiguration = async ({ tenantId, id, name, description, iconKey, isActive, priority, labelIds, userIds }, executor = null) => {
  const client = executorOf(executor);
  const queue = (await client.query(`
    INSERT INTO support_queues (tenant_id,id,name,service_id,is_active,description,icon_key,priority)
    VALUES ($1,$2,$3,$2,$4,$5,$6,$7)
    ON CONFLICT (tenant_id,id) DO UPDATE SET
      name=EXCLUDED.name,service_id=EXCLUDED.service_id,is_active=EXCLUDED.is_active,
      description=EXCLUDED.description,icon_key=EXCLUDED.icon_key,priority=EXCLUDED.priority,updated_at=now()
    RETURNING *
  `, [tenantId, id, name, Boolean(isActive), description || null, iconKey || 'headphones', priority])).rows[0];
  await client.query('DELETE FROM queue_label_mappings WHERE tenant_id=$1 AND queue_id=$2', [tenantId, id]);
  for (const labelId of labelIds) {
    await client.query(`
      INSERT INTO queue_label_mappings (tenant_id,queue_id,label_key,priority,is_active)
      VALUES ($1,$2,$3,$4,true)
      ON CONFLICT (tenant_id,label_key) DO UPDATE SET queue_id=EXCLUDED.queue_id,priority=EXCLUDED.priority,is_active=true,updated_at=now()
    `, [tenantId, id, labelId, priority]);
  }
  await client.query('UPDATE queue_memberships SET is_active=false,updated_at=now() WHERE tenant_id=$1 AND queue_id=$2', [tenantId, id]);
  for (const userId of userIds) {
    await client.query(`
      INSERT INTO queue_memberships (tenant_id,queue_id,user_id,user_name,is_active,is_assignable)
      VALUES ($1,$2,$3,$3,true,true)
      ON CONFLICT (tenant_id,queue_id,user_id) DO UPDATE SET is_active=true,updated_at=now()
    `, [tenantId, id, userId]);
  }
  return queue;
};

export const deleteQueueConfiguration = async ({ tenantId, id }, executor = null) =>
  (await executorOf(executor).query(`
    UPDATE support_queues SET is_active=false,updated_at=now()
    WHERE tenant_id=$1 AND id=$2 RETURNING *
  `, [tenantId, id])).rows[0] || null;

export const reassignConversationsByLabelMappings = async ({ tenantId }, executor = null) =>
  (await executorOf(executor).query(`
    WITH resolved AS (
      SELECT c.id,(
        SELECT m.queue_id FROM queue_label_mappings m
        JOIN support_queues q ON q.tenant_id=m.tenant_id AND q.id=m.queue_id
        WHERE m.tenant_id=c.tenant_id AND m.label_key=c.standard_label AND m.is_active=true AND q.is_active=true
        ORDER BY m.priority,m.queue_id LIMIT 1
      ) AS resolved_queue_id
      FROM conversations c WHERE c.tenant_id=$1 AND c.standard_label IS NOT NULL
    )
    UPDATE conversations c SET
      queue_id=resolved.resolved_queue_id,service_id=resolved.resolved_queue_id,
      assignment_status=CASE
        WHEN c.status='closed' OR c.assignment_status='closed' THEN 'closed'
        WHEN c.assigned_agent_id IS NOT NULL THEN c.assignment_status
        WHEN resolved.resolved_queue_id IS NOT NULL THEN 'queued'
        ELSE 'unassigned'
      END,updated_at=now()
    FROM resolved
    WHERE c.id=resolved.id AND (c.queue_id IS DISTINCT FROM resolved.resolved_queue_id OR c.service_id IS DISTINCT FROM resolved.resolved_queue_id)
    RETURNING c.*
  `, [tenantId])).rows;
