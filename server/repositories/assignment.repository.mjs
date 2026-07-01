import { query, withTransaction } from '../db/postgres.mjs';

const executorOf = (executor) => executor || { query };

export const resolveRouteQueueMapping = async ({
  tenantId,
  routeKey,
  phoneNumberId = '',
  fallbackQueueId = '',
  fallbackServiceId = '',
}) => {
  const normalizedRoute = String(routeKey || 'default').trim().toLowerCase() || 'default';
  const normalizedPhone = String(phoneNumberId || '').replace(/\D/g, '');
  const result = await query(`
    SELECT * FROM queue_route_mappings
    WHERE tenant_id=$1 AND route_key=$2 AND is_active=true
      AND phone_number_id IN ($3,'')
    ORDER BY CASE WHEN phone_number_id=$3 AND $3<>'' THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `, [tenantId, normalizedRoute, normalizedPhone]);
  if (result.rows[0]) return result.rows[0];
  const queueId = String(fallbackQueueId || '').trim();
  const serviceId = String(fallbackServiceId || '').trim() || null;
  if (!queueId) return null;
  return withTransaction(async (client) => {
    await client.query(`
      INSERT INTO support_queues (tenant_id,id,name,service_id)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id,id) DO UPDATE SET
        service_id=COALESCE(EXCLUDED.service_id,support_queues.service_id),updated_at=now()
    `, [tenantId, queueId, normalizedRoute, serviceId]);
    return (await client.query(`
      INSERT INTO queue_route_mappings (tenant_id,route_key,phone_number_id,queue_id,service_id)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id,route_key,phone_number_id) DO UPDATE SET
        queue_id=EXCLUDED.queue_id,service_id=EXCLUDED.service_id,is_active=true,updated_at=now()
      RETURNING *
    `, [tenantId, normalizedRoute, normalizedPhone, queueId, serviceId])).rows[0];
  });
};

export const syncQueueMemberships = async ({ tenantId, userId, userName = '', queueIds = [], isAssignable = true }, executor = null) => {
  const client = executorOf(executor);
  const authQueueIds = Array.from(new Set(queueIds.map((value) => String(value || '').trim()).filter(Boolean)));
  const mappedQueueIds = authQueueIds.length ? (await client.query(`
    SELECT id FROM support_queues
    WHERE tenant_id=$1 AND is_active=true AND (id=ANY($2::text[]) OR service_id=ANY($2::text[]))
  `, [tenantId, authQueueIds])).rows.map((row) => String(row.id)) : [];
  const normalizedQueueIds = Array.from(new Set([...authQueueIds, ...mappedQueueIds]));
  for (const queueId of normalizedQueueIds) {
    await client.query(`
      INSERT INTO support_queues (tenant_id,id,name)
      VALUES ($1,$2,$2)
      ON CONFLICT (tenant_id,id) DO NOTHING
    `, [tenantId, queueId]);
    await client.query(`
      INSERT INTO queue_memberships (tenant_id,queue_id,user_id,user_name,is_active,is_assignable)
      VALUES ($1,$2,$3,$4,true,$5)
      ON CONFLICT (tenant_id,queue_id,user_id) DO UPDATE SET
        user_name=EXCLUDED.user_name,is_active=true,is_assignable=EXCLUDED.is_assignable,updated_at=now()
    `, [tenantId, queueId, userId, userName || null, Boolean(isAssignable)]);
  }
  return normalizedQueueIds;
};

export const upsertAgentPresence = async ({
  tenantId,
  userId,
  userName = '',
  userEmail = '',
  role = '',
  status,
  pausedUntil = null,
  pauseReason = null,
}, executor = null) => (await executorOf(executor).query(`
  INSERT INTO agent_presence (tenant_id,user_id,user_name,user_email,role,status,paused_until,pause_reason,last_seen_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
  ON CONFLICT (tenant_id,user_id) DO UPDATE SET
    user_name=EXCLUDED.user_name,user_email=EXCLUDED.user_email,role=EXCLUDED.role,status=EXCLUDED.status,paused_until=EXCLUDED.paused_until,
    pause_reason=EXCLUDED.pause_reason,last_seen_at=now(),updated_at=now()
  RETURNING *
`, [tenantId, userId, userName || null, userEmail || null, role || null, status, pausedUntil, pauseReason])).rows[0];

export const getAgentPresence = async ({ tenantId, userId }) =>
  (await query('SELECT * FROM agent_presence WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId])).rows[0] || null;

export const listAgentPresence = async ({ tenantId, ttlSeconds = 90 }) => (await query(`
  SELECT p.*,
    COALESCE(array_agg(m.queue_id ORDER BY m.queue_id) FILTER (WHERE m.queue_id IS NOT NULL AND m.is_active),'{}') AS queue_ids
  FROM agent_presence p
  LEFT JOIN queue_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
  WHERE p.tenant_id=$1 AND p.status IN ('online','paused')
    AND p.last_seen_at >= now()-make_interval(secs=>$2::int)
  GROUP BY p.tenant_id,p.user_id
  ORDER BY p.user_name,p.user_id
`, [tenantId, ttlSeconds])).rows;

export const getConversationAssignmentHistory = async ({ tenantId, conversationId, limit = 50 }) =>
  (await query(`
    SELECT * FROM conversation_assignment_events
    WHERE tenant_id=$1 AND conversation_id=$2
    ORDER BY created_at DESC LIMIT $3
  `, [tenantId, conversationId, limit])).rows;
