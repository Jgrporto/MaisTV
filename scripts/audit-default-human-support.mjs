import 'dotenv/config';

import { closePostgres, query } from '../server/db/postgres.mjs';

const tenantId = String(process.env.CHAT_DEFAULT_TENANT_ID || 'maistv').trim();
const strict = process.argv.includes('--strict');
const requiredColumns = [
  'normalized_phone',
  'last_inbound_route_key',
  'last_inbound_phone_number_id',
  'last_customer_message_at',
  'last_24h_window_expires_at',
  'standard_label',
];
const requiredRelations = [
  'customer_profiles',
  'queue_label_mappings',
  'conversation_merge_audit',
  'support_queues',
  'queue_memberships',
  'agent_presence',
  'conversation_assignment_events',
];
const standardLabels = ['system-lead', 'system-sql', 'system-cliente', 'system-pos-venda', 'system-cancelados'];

const safeRows = async (sql, values = []) => {
  try {
    return { rows: (await query(sql, values)).rows, error: null };
  } catch (error) {
    return { rows: [], error: error.message };
  }
};

try {
  const columns = await safeRows(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema=ANY(current_schemas(false)) AND table_name='conversations'
      AND column_name=ANY($1::text[])
    ORDER BY column_name
  `, [requiredColumns]);
  const relations = await safeRows(`
    SELECT name,to_regclass(name) IS NOT NULL AS present
    FROM unnest($1::text[]) AS relation_name(name) ORDER BY name
  `, [requiredRelations]);
  const migration = await safeRows(`
    SELECT filename,applied_at FROM chat_schema_migrations
    WHERE filename='008_unified_customer_channels.sql'
  `);
  const counts = await safeRows(`
    SELECT
      (SELECT count(*)::int FROM conversations WHERE tenant_id=$1) AS conversations,
      (SELECT count(*)::int FROM messages WHERE tenant_id=$1) AS messages,
      (SELECT count(*)::int FROM customer_profiles WHERE tenant_id=$1) AS customer_profiles,
      (SELECT count(*)::int FROM conversation_merge_audit WHERE tenant_id=$1) AS merge_audit_rows,
      (SELECT count(*)::int FROM conversations WHERE tenant_id=$1 AND normalized_phone IS NULL) AS unnormalized_conversations,
      (SELECT count(*)::int FROM conversations c LEFT JOIN customer_profiles p
        ON p.tenant_id=c.tenant_id AND p.normalized_phone=c.normalized_phone
        WHERE c.tenant_id=$1 AND c.normalized_phone IS NOT NULL AND p.normalized_phone IS NULL) AS conversations_without_profile,
      (SELECT count(*)::int FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id
        WHERE m.tenant_id=$1 AND c.id IS NULL) AS orphan_messages
  `, [tenantId]);
  const duplicates = await safeRows(`
    SELECT normalized_phone,count(*)::int AS conversations
    FROM conversations WHERE tenant_id=$1 AND normalized_phone IS NOT NULL
    GROUP BY normalized_phone HAVING count(*)>1 ORDER BY count(*) DESC,normalized_phone LIMIT 20
  `, [tenantId]);
  const queues = await safeRows(`
    SELECT id,name,service_id,is_active,priority FROM support_queues
    WHERE tenant_id=$1 ORDER BY priority,name,id
  `, [tenantId]);
  const labelMappings = await safeRows(`
    SELECT m.label_key,m.queue_id,m.priority,m.is_active,q.name AS queue_name,q.is_active AS queue_active
    FROM queue_label_mappings m
    LEFT JOIN support_queues q ON q.tenant_id=m.tenant_id AND q.id=m.queue_id
    WHERE m.tenant_id=$1 ORDER BY m.priority,m.label_key
  `, [tenantId]);
  const memberships = await safeRows(`
    SELECT m.queue_id,m.user_id,m.user_name,m.is_active,m.is_assignable,m.updated_at,
      p.user_email,p.role,p.status,p.last_seen_at
    FROM queue_memberships m
    LEFT JOIN agent_presence p ON p.tenant_id=m.tenant_id AND p.user_id=m.user_id
    WHERE m.tenant_id=$1 ORDER BY m.queue_id,m.user_id
  `, [tenantId]);
  const presence = await safeRows(`
    SELECT user_id,user_name,user_email,role,status,paused_until,last_seen_at,updated_at
    FROM agent_presence WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 50
  `, [tenantId]);
  const routeMappings = await safeRows(`
    SELECT route_key,phone_number_id,queue_id,service_id,is_active
    FROM queue_route_mappings WHERE tenant_id=$1 ORDER BY route_key,phone_number_id
  `, [tenantId]);

  const presentColumns = new Set(columns.rows.map((row) => row.column_name));
  const presentRelations = new Set(relations.rows.filter((row) => row.present).map((row) => row.name));
  const activeLabels = new Set(labelMappings.rows
    .filter((row) => row.is_active && row.queue_active)
    .map((row) => row.label_key));
  const missingColumns = requiredColumns.filter((name) => !presentColumns.has(name));
  const missingRelations = requiredRelations.filter((name) => !presentRelations.has(name));
  const missingStandardLabels = standardLabels.filter((name) => !activeLabels.has(name));
  const activeAttendantMemberships = memberships.rows.filter((row) => row.is_active && row.is_assignable);
  const presenceTtlMs = Math.max(30, Number(process.env.ASSIGNMENT_PRESENCE_TTL_SECONDS || 90)) * 1_000;
  const hasFreshOnlineAttendant = activeAttendantMemberships.some((row) =>
    row.status === 'online' && Date.parse(String(row.last_seen_at || '')) >= Date.now() - presenceTtlMs);
  const checks = {
    migration008Applied: migration.rows.length === 1,
    requiredColumnsPresent: missingColumns.length === 0,
    requiredRelationsPresent: missingRelations.length === 0,
    noDuplicateNormalizedPhones: !duplicates.error && duplicates.rows.length === 0,
    noOrphanMessages: counts.rows[0]?.orphan_messages === 0,
    allConversationsNormalized: counts.rows[0]?.unnormalized_conversations === 0,
    allNormalizedConversationsHaveProfile: counts.rows[0]?.conversations_without_profile === 0,
    allStandardLabelsMappedToActiveQueues: missingStandardLabels.length === 0,
    hasAssignableMembership: activeAttendantMemberships.length > 0,
    activeMembershipsHaveObservedIdentity: activeAttendantMemberships.every((row) => Boolean(row.user_email || row.last_seen_at)),
    hasObservedAuthenticatedIdentity: presence.rows.length > 0,
    hasFreshOnlineAssignableAttendant: hasFreshOnlineAttendant,
    assignmentEnqueueDisabled: !['1', 'true', 'yes', 'on'].includes(String(process.env.ASSIGNMENT_ENQUEUE_ENABLED || '').toLowerCase()),
    assignmentWorkerDisabledByEnv: !['1', 'true', 'yes', 'on'].includes(String(process.env.ASSIGNMENT_WORKER_ENABLED || '').toLowerCase()),
  };
  const errors = [columns, relations, migration, counts, duplicates, queues, labelMappings, memberships, presence, routeMappings]
    .map((result) => result.error).filter(Boolean);
  const ready = Object.values(checks).every(Boolean) && errors.length === 0;

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(), tenantId, ready, checks, errors,
    schema: { missingColumns, missingRelations, migration008: migration.rows[0] || null },
    integrity: { counts: counts.rows[0] || null, duplicateNormalizedPhones: duplicates.rows },
    queues: queues.rows,
    standardLabels: { required: standardLabels, missing: missingStandardLabels, mappings: labelMappings.rows },
    memberships: memberships.rows,
    observedAuthIdentities: presence.rows,
    userSource: 'external_legacy_auth; configure the real user service/queue grants there, then presence syncs queue_memberships into PostgreSQL',
    routeMappings: routeMappings.rows,
    note: 'queue_route_mappings are informational; operational queue selection is label-based through queue_label_mappings',
  }, null, 2));
  if (strict && (!ready || errors.length)) process.exitCode = 2;
} catch (error) {
  console.error('[default-human-support:audit] erro:', error.message);
  process.exitCode = 1;
} finally {
  await closePostgres().catch(() => {});
}
