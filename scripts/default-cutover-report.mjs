import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { closePostgres, query } from '../server/db/postgres.mjs';
import { closeQueues, getQueues } from '../server/queues/queues.mjs';
import { normalizePhone } from '../server/utils/phone-normalization.mjs';

const args = process.argv.slice(2);
const valueArg = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
};

const tenantId = String(valueArg('--tenant', process.env.CHAT_DEFAULT_TENANT_ID || 'maistv')).trim();
const customerInput = String(valueArg('--customer')).trim();
const conversationId = String(valueArg('--conversation-id')).trim();
const outputPath = String(valueArg('--output')).trim();
const failedLimit = Math.min(100, Math.max(1, Number(valueArg('--failed-limit', '20')) || 20));
const apiBaseUrl = String(valueArg('--api-base', 'http://127.0.0.1:5353')).replace(/\/+$/, '');
const sseBaseUrl = String(valueArg('--sse-base', 'http://127.0.0.1:5356')).replace(/\/+$/, '');

if (args.includes('--help')) {
  console.log(`Uso: npm run default:cutover:report -- [opcoes]

Relatorio estritamente de leitura. Nao envia mensagens, nao reprocessa e nao remove jobs.

  --customer NUMERO          filtra a conversa pelo telefone normalizado
  --conversation-id UUID     filtra diretamente pelo id da conversa
  --tenant TENANT            padrao: CHAT_DEFAULT_TENANT_ID ou maistv
  --failed-limit N           jobs failed exibidos por fila (padrao: 20)
  --api-base URL             API de health (padrao: http://127.0.0.1:5353)
  --sse-base URL             SSE de health (padrao: http://127.0.0.1:5356)
  --output ARQUIVO           tambem grava o JSON neste arquivo
`);
  process.exit(0);
}

const safeQuery = async (name, sql, values = []) => {
  try {
    return { name, ok: true, rows: (await query(sql, values)).rows };
  } catch (error) {
    return { name, ok: false, error: error.message };
  }
};

const healthRequest = async (baseUrl, path) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* preserve non-JSON response */ }
    return { url: `${baseUrl}${path}`, status: response.status, ok: response.ok, body };
  } catch (error) {
    return { url: `${baseUrl}${path}`, status: 0, ok: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timeout);
  }
};

const getQueueReport = async () => {
  try {
    const queues = await getQueues();
    const report = {};
    for (const [key, queue] of Object.entries(queues)) {
      const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
      const failed = counts.failed > 0
        ? await queue.getJobs(['failed'], 0, failedLimit - 1, false)
        : [];
      report[key] = {
        name: queue.name,
        counts,
        failed: failed.map((job) => ({
          id: job.id,
          name: job.name,
          attemptsMade: job.attemptsMade,
          failedReason: String(job.failedReason || '').slice(0, 1_000),
          references: Object.fromEntries([
            'tenantId', 'conversationId', 'messageId', 'mediaId', 'providerMessageId',
            'routeKey', 'phoneNumberId',
          ].filter((field) => job.data?.[field] != null).map((field) => [field, job.data[field]])),
          timestamp: job.timestamp ? new Date(job.timestamp).toISOString() : null,
          processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
          finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        })),
      };
    }
    return { ok: true, queues: report };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

const normalizedPhone = customerInput ? normalizePhone(customerInput) : '';
const report = {
  generatedAt: new Date().toISOString(),
  mode: 'read_only',
  tenantId,
  filters: { customerInput: customerInput || null, normalizedPhone: normalizedPhone || null, conversationId: conversationId || null },
  configuration: {
    architectureEnabled: process.env.CHAT_ARCHITECTURE_ENABLED || null,
    defaultDisplayPhone: process.env.WHATSAPP_DISPLAY_PHONE_NUMBER || null,
    defaultPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || null,
    defaultAccessTokenConfigured: Boolean(process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN),
    defaultAppSecretConfigured: Boolean(process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET),
    outboundMediaMaxBytes: process.env.OUTBOUND_MEDIA_MAX_BYTES || null,
    storageProvider: process.env.STORAGE_PROVIDER || null,
    assignmentWorkerEnabled: process.env.ASSIGNMENT_WORKER_ENABLED || null,
    assignmentEnqueueEnabled: process.env.ASSIGNMENT_ENQUEUE_ENABLED || null,
    routineSchedulerEnabled: process.env.ROUTINE_SCHEDULER_ENABLED || null,
    routineDispatchQueueEnabled: process.env.ROUTINE_DISPATCH_QUEUE_ENABLED || null,
    routineDispatchWorkerEnabled: process.env.ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED || null,
    whatsappSchedulersEnabled: process.env.WHATSAPP_SCHEDULERS_ENABLED || null,
  },
  expectedStandardLabels: ['system-lead', 'system-sql', 'system-cliente', 'system-pos-venda', 'system-cancelados'],
  manualChecksStillRequired: [
    'real inbound message to the default WhatsApp number',
    'authenticated agent visibility and manual assignment in the panel',
    'authenticated SSE delivery without browser refresh',
    'real outbound text, quick reply, image, audio, document and video',
    'media remains available after a full page reload',
  ],
};

try {
  const baseQueries = await Promise.all([
    safeQuery('schema', `SELECT table_name,column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND (
        (table_name='conversations' AND column_name IN (
          'normalized_phone','last_inbound_route_key','last_inbound_phone_number_id',
          'last_customer_message_at','last_24h_window_expires_at','standard_label',
          'unread_count','last_read_at','last_read_by'
        )) OR table_name IN (
          'customer_profiles','queue_label_mappings','conversation_merge_audit','support_queues',
          'queue_memberships','agent_presence','conversation_assignment_events','conversation_reads','media_files'
        )
      ) ORDER BY table_name,column_name`),
    safeQuery('totals', `SELECT
      (SELECT COUNT(*)::int FROM conversations WHERE tenant_id=$1) AS conversations,
      (SELECT COUNT(*)::int FROM messages WHERE tenant_id=$1) AS messages,
      (SELECT COUNT(*)::int FROM customer_profiles WHERE tenant_id=$1) AS customer_profiles,
      (SELECT COUNT(*)::int FROM conversation_merge_audit WHERE tenant_id=$1) AS merge_audit_rows,
      (SELECT COUNT(*)::int FROM messages m LEFT JOIN conversations c
        ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id
        WHERE m.tenant_id=$1 AND c.id IS NULL) AS orphan_messages`, [tenantId]),
    safeQuery('duplicateConversations', `SELECT tenant_id,normalized_phone,COUNT(*)::int AS count
      FROM conversations WHERE tenant_id=$1 AND normalized_phone IS NOT NULL
      GROUP BY tenant_id,normalized_phone HAVING COUNT(*)>1 ORDER BY count DESC LIMIT 20`, [tenantId]),
    safeQuery('globalUnread', `SELECT
      COUNT(*) FILTER (WHERE unread_count>0)::int AS conversations_with_unread,
      COALESCE(SUM(unread_count),0)::int AS unread_messages
      FROM conversations WHERE tenant_id=$1`, [tenantId]),
    safeQuery('supportQueues', `SELECT tenant_id,id,name,service_id,is_active,description,icon_key,priority,created_at,updated_at
      FROM support_queues WHERE tenant_id=$1 ORDER BY priority,name`, [tenantId]),
    safeQuery('labelMappings', `SELECT tenant_id,label_key,queue_id,priority,is_active,created_at,updated_at
      FROM queue_label_mappings WHERE tenant_id=$1 ORDER BY priority,label_key`, [tenantId]),
    safeQuery('memberships', `SELECT tenant_id,queue_id,user_id,user_name,is_active,is_assignable,last_assigned_at,created_at,updated_at
      FROM queue_memberships WHERE tenant_id=$1 ORDER BY queue_id,user_id`, [tenantId]),
    safeQuery('presence', `SELECT tenant_id,user_id,user_name,user_email,role,status,paused_until,pause_reason,last_seen_at,updated_at
      FROM agent_presence WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 50`, [tenantId]),
  ]);
  report.database = Object.fromEntries(baseQueries.map((item) => [item.name, item.ok ? item.rows : { error: item.error }]));

  const usersColumns = await safeQuery('usersColumns', `SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'`);
  const availableUserColumns = new Set((usersColumns.rows || []).map((row) => row.column_name));
  const allowedUserColumns = ['id', 'name', 'email', 'role', 'is_active', 'created_at'].filter((column) => availableUserColumns.has(column));
  report.database.users = allowedUserColumns.includes('id')
    ? (await safeQuery('users', `SELECT ${allowedUserColumns.join(',')} FROM users ORDER BY ${availableUserColumns.has('created_at') ? 'created_at' : 'id'}`)).rows
    : { unavailable: true, reason: 'public.users with id column was not found' };

  let selectedConversationId = conversationId;
  if (!selectedConversationId && normalizedPhone) {
    const selected = await safeQuery('conversationLookup', `SELECT id FROM conversations
      WHERE tenant_id=$1 AND (normalized_phone=$2 OR regexp_replace(contact_phone,'\\D','','g')=$2)
      ORDER BY updated_at DESC LIMIT 1`, [tenantId, normalizedPhone]);
    selectedConversationId = selected.rows?.[0]?.id || '';
  }

  if (selectedConversationId) {
    const detailQueries = await Promise.all([
      safeQuery('conversation', `SELECT id,tenant_id,contact_phone,normalized_phone,contact_name,status,
        route_key,phone_number_id,last_inbound_route_key,last_inbound_phone_number_id,
        standard_label,queue_id,service_id,assignment_status,assigned_agent_id,assigned_agent_name,assigned_at,
        unread_count,last_read_at,last_read_by,last_customer_message_at,last_24h_window_expires_at,
        last_message,last_message_type,last_message_at,created_at,updated_at
        FROM conversations WHERE tenant_id=$1 AND id=$2`, [tenantId, selectedConversationId]),
      safeQuery('messages', `SELECT id,conversation_id,direction,sender_type,type,body,status,route_key,phone_number_id,
        provider_message_id,client_message_id,media_id,error_message,created_at,sent_at,delivered_at,read_at
        FROM messages WHERE tenant_id=$1 AND conversation_id=$2
        ORDER BY created_at DESC,id DESC LIMIT 50`, [tenantId, selectedConversationId]),
      safeQuery('media', `SELECT mf.id,mf.message_id,mf.type,mf.mime_type,mf.size_bytes,mf.status,
        mf.storage_key,mf.thumbnail_key,mf.provider_media_id,mf.original_filename,mf.error_message,
        mf.created_at,mf.updated_at,mf.available_at
        FROM media_files mf JOIN messages m ON m.tenant_id=mf.tenant_id AND m.id=mf.message_id
        WHERE mf.tenant_id=$1 AND m.conversation_id=$2 ORDER BY mf.created_at DESC LIMIT 50`, [tenantId, selectedConversationId]),
      safeQuery('assignmentEvents', `SELECT id,event_type,from_queue_id,to_queue_id,from_agent_id,to_agent_id,
        actor_user_id,reason,created_at FROM conversation_assignment_events
        WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 50`, [tenantId, selectedConversationId]),
      safeQuery('reads', `SELECT user_id,last_read_message_id,last_read_at,updated_at FROM conversation_reads
        WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY updated_at DESC`, [tenantId, selectedConversationId]),
    ]);
    report.selectedConversation = Object.fromEntries(detailQueries.map((item) => [item.name, item.ok ? item.rows : { error: item.error }]));
  } else {
    report.selectedConversation = { skipped: true, reason: 'pass --customer or --conversation-id for conversation-level evidence' };
  }

  report.health = await Promise.all([
    healthRequest(apiBaseUrl, '/api/health/postgres'),
    healthRequest(apiBaseUrl, '/api/health/redis'),
    healthRequest(apiBaseUrl, '/api/health/queues'),
    healthRequest(sseBaseUrl, '/api/health/realtime'),
  ]);
  report.bullmq = await getQueueReport();
} catch (error) {
  report.fatal = error.message;
  process.exitCode = 1;
} finally {
  await Promise.all([closePostgres().catch(() => {}), closeQueues().catch(() => {})]);
}

const json = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json, 'utf8');
}
process.stdout.write(json);
