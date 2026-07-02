import { query } from '../db/postgres.mjs';

const executorOf = (executor) => executor || { query };

export const getCustomerProfile = async ({ tenantId, normalizedPhone }, executor = null) =>
  (await executorOf(executor).query(
    'SELECT * FROM customer_profiles WHERE tenant_id=$1 AND normalized_phone=$2',
    [tenantId, normalizedPhone],
  )).rows[0] || null;

export const upsertCustomerProfile = async (profile, executor = null) =>
  (await executorOf(executor).query(`
    INSERT INTO customer_profiles (
      tenant_id,normalized_phone,display_phone,standard_label,standard_label_source,
      standard_label_reason,standard_label_overridden,standard_label_updated_at,
      confirmed_customer_id,trial_id,trial_status,customer_due_date,customer_created_at,last_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12,$13)
    ON CONFLICT (tenant_id,normalized_phone) DO UPDATE SET
      display_phone=COALESCE(NULLIF(EXCLUDED.display_phone,''),customer_profiles.display_phone),
      standard_label=CASE WHEN customer_profiles.standard_label_overridden THEN customer_profiles.standard_label ELSE EXCLUDED.standard_label END,
      standard_label_source=CASE WHEN customer_profiles.standard_label_overridden THEN customer_profiles.standard_label_source ELSE EXCLUDED.standard_label_source END,
      standard_label_reason=CASE WHEN customer_profiles.standard_label_overridden THEN customer_profiles.standard_label_reason ELSE EXCLUDED.standard_label_reason END,
      standard_label_updated_at=CASE WHEN customer_profiles.standard_label_overridden THEN customer_profiles.standard_label_updated_at ELSE now() END,
      confirmed_customer_id=EXCLUDED.confirmed_customer_id,trial_id=EXCLUDED.trial_id,trial_status=EXCLUDED.trial_status,
      customer_due_date=EXCLUDED.customer_due_date,customer_created_at=EXCLUDED.customer_created_at,
      last_synced_at=EXCLUDED.last_synced_at,updated_at=now()
    RETURNING *
  `, [
    profile.tenantId, profile.normalizedPhone, profile.displayPhone || null,
    profile.standardLabel, profile.standardLabelSource || 'automatic', profile.standardLabelReason || null,
    Boolean(profile.standardLabelOverridden), profile.confirmedCustomerId || null, profile.trialId || null,
    profile.trialStatus || null, profile.customerDueDate || null, profile.customerCreatedAt || null,
    profile.lastSyncedAt || new Date().toISOString(),
  ])).rows[0];

export const upsertCustomerProfilesBulk = async ({ tenantId, profiles }, executor = null) => {
  if (!profiles.length) return [];
  return (await executorOf(executor).query(`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
        normalized_phone text,display_phone text,standard_label text,standard_label_source text,
        standard_label_reason text,confirmed_customer_id text,trial_id text,trial_status text,
        customer_due_date timestamptz,customer_created_at timestamptz,last_synced_at timestamptz
      )
    )
    INSERT INTO customer_profiles (
      tenant_id,normalized_phone,display_phone,standard_label,standard_label_source,standard_label_reason,
      confirmed_customer_id,trial_id,trial_status,customer_due_date,customer_created_at,last_synced_at
    )
    SELECT $1,normalized_phone,display_phone,standard_label,standard_label_source,standard_label_reason,
      confirmed_customer_id,trial_id,trial_status,customer_due_date,customer_created_at,last_synced_at
    FROM incoming
    ON CONFLICT (tenant_id,normalized_phone) DO UPDATE SET
      display_phone=COALESCE(NULLIF(EXCLUDED.display_phone,''),customer_profiles.display_phone),
      standard_label=CASE WHEN customer_profiles.standard_label_overridden THEN customer_profiles.standard_label ELSE EXCLUDED.standard_label END,
      standard_label_source=CASE WHEN customer_profiles.standard_label_overridden THEN customer_profiles.standard_label_source ELSE EXCLUDED.standard_label_source END,
      standard_label_reason=CASE WHEN customer_profiles.standard_label_overridden THEN customer_profiles.standard_label_reason ELSE EXCLUDED.standard_label_reason END,
      standard_label_updated_at=CASE WHEN customer_profiles.standard_label_overridden THEN customer_profiles.standard_label_updated_at ELSE now() END,
      confirmed_customer_id=EXCLUDED.confirmed_customer_id,trial_id=EXCLUDED.trial_id,trial_status=EXCLUDED.trial_status,
      customer_due_date=EXCLUDED.customer_due_date,customer_created_at=EXCLUDED.customer_created_at,
      last_synced_at=EXCLUDED.last_synced_at,updated_at=now()
    RETURNING *
  `, [tenantId, JSON.stringify(profiles)])).rows;
};

export const resolveQueueForLabel = async ({ tenantId, labelKey }, executor = null) =>
  (await executorOf(executor).query(`
    SELECT q.*,m.label_key,m.priority AS mapping_priority
    FROM queue_label_mappings m
    JOIN support_queues q ON q.tenant_id=m.tenant_id AND q.id=m.queue_id
    WHERE m.tenant_id=$1 AND m.label_key=$2 AND m.is_active=true AND q.is_active=true
    ORDER BY m.priority ASC,q.id ASC LIMIT 1
  `, [tenantId, labelKey])).rows[0] || null;

export const applyProfileToConversations = async ({ tenantId, normalizedPhone, profile, queue }, executor = null) =>
  (await executorOf(executor).query(`
    UPDATE conversations SET
      standard_label=$3,standard_label_source=$4,standard_label_reason=$5,
      standard_label_overridden=$6,standard_label_updated_at=$7,
      queue_id=$8,service_id=$8,
      assignment_status=CASE
        WHEN status='closed' OR assignment_status='closed' THEN 'closed'
        WHEN assigned_agent_id IS NOT NULL THEN assignment_status
        WHEN $8::text IS NOT NULL THEN 'queued'
        ELSE 'unassigned'
      END,
      updated_at=now()
    WHERE tenant_id=$1 AND normalized_phone=$2
      AND (
        standard_label IS DISTINCT FROM $3 OR standard_label_source IS DISTINCT FROM $4 OR
        standard_label_reason IS DISTINCT FROM $5 OR standard_label_overridden IS DISTINCT FROM $6 OR
        queue_id IS DISTINCT FROM $8 OR service_id IS DISTINCT FROM $8
      )
    RETURNING *
  `, [
    tenantId, normalizedPhone, profile.standard_label, profile.standard_label_source,
    profile.standard_label_reason, profile.standard_label_overridden, profile.standard_label_updated_at,
    queue?.id || null,
  ])).rows;

export const applyAllProfilesToConversations = async ({ tenantId }, executor = null) =>
  (await executorOf(executor).query(`
    WITH resolved AS (
      SELECT p.*,(SELECT m.queue_id
        FROM queue_label_mappings m
        JOIN support_queues q ON q.tenant_id=m.tenant_id AND q.id=m.queue_id
        WHERE m.tenant_id=p.tenant_id AND m.label_key=p.standard_label AND m.is_active=true AND q.is_active=true
        ORDER BY m.priority,m.queue_id LIMIT 1) AS resolved_queue_id
      FROM customer_profiles p WHERE p.tenant_id=$1
    )
    UPDATE conversations c SET
      standard_label=resolved.standard_label,standard_label_source=resolved.standard_label_source,
      standard_label_reason=resolved.standard_label_reason,standard_label_overridden=resolved.standard_label_overridden,
      standard_label_updated_at=resolved.standard_label_updated_at,
      queue_id=resolved.resolved_queue_id,service_id=resolved.resolved_queue_id,
      assignment_status=CASE
        WHEN c.status='closed' OR c.assignment_status='closed' THEN 'closed'
        WHEN c.assigned_agent_id IS NOT NULL THEN c.assignment_status
        WHEN resolved.resolved_queue_id IS NOT NULL THEN 'queued' ELSE 'unassigned' END,
      updated_at=now()
    FROM resolved
    WHERE c.tenant_id=resolved.tenant_id AND c.normalized_phone=resolved.normalized_phone
      AND (
        c.standard_label IS DISTINCT FROM resolved.standard_label OR
        c.standard_label_source IS DISTINCT FROM resolved.standard_label_source OR
        c.standard_label_reason IS DISTINCT FROM resolved.standard_label_reason OR
        c.standard_label_overridden IS DISTINCT FROM resolved.standard_label_overridden OR
        c.queue_id IS DISTINCT FROM resolved.resolved_queue_id OR c.service_id IS DISTINCT FROM resolved.resolved_queue_id
      )
    RETURNING c.*
  `, [tenantId])).rows;
