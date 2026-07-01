import 'dotenv/config';

import { closePostgres, query } from '../server/db/postgres.mjs';
import { checkQueues, closeQueues } from '../server/queues/queues.mjs';

const parseArgs = (argv) => {
  const args = {
    tenantId: process.env.CHAT_DEFAULT_TENANT_ID || process.env.CHATBOT_TENANT_ID || 'maistv',
    conversationId: '',
    limit: 30,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : '';
    if (item === '--tenant') args.tenantId = value || args.tenantId;
    if (item === '--conversation-id') args.conversationId = value;
    if (item === '--limit') args.limit = Math.max(1, Math.min(200, Number(value || 30)));
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const values = [args.tenantId];
  let conversationParameter = '';
  if (args.conversationId) {
    values.push(args.conversationId);
    conversationParameter = `$${values.length}::uuid`;
  }
  values.push(args.limit);
  const limitParameter = `$${values.length}`;
  const [batches, events, sessions, queues] = await Promise.all([
    query(`
      SELECT b.*,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id',i.id,
          'outputIndex',i.output_index,
          'outputType',i.output_type,
          'status',i.status,
          'messageId',i.message_id,
          'queuedAt',i.queued_at,
          'sentAt',i.sent_at,
          'failedAt',i.failed_at,
          'errorMessage',i.error_message
        ) ORDER BY i.output_index) FILTER (WHERE i.id IS NOT NULL),'[]'::jsonb) AS items
      FROM chatbot_output_batches b
      LEFT JOIN chatbot_output_items i ON i.tenant_id=b.tenant_id AND i.batch_id=b.id
      WHERE b.tenant_id=$1${conversationParameter ? ` AND b.conversation_id=${conversationParameter}` : ''}
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT ${limitParameter}
    `, values),
    query(`
      SELECT event_type, conversation_id, message_id, flow_id, flow_version_id,
        session_id, mode, payload, created_at
      FROM chatbot_events
      WHERE tenant_id=$1${conversationParameter ? ` AND conversation_id=${conversationParameter}` : ''}
      ORDER BY created_at DESC
      LIMIT ${limitParameter}
    `, values),
    query(`
      SELECT * FROM chatbot_sessions
      WHERE tenant_id=$1${conversationParameter ? ` AND conversation_id=${conversationParameter}` : ''}
      ORDER BY updated_at DESC
      LIMIT ${limitParameter}
    `, values),
    checkQueues(),
  ]);
  const statusCounts = batches.rows.reduce((summary, batch) => {
    summary[batch.status] = (summary[batch.status] || 0) + 1;
    return summary;
  }, {});
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    tenantId: args.tenantId,
    conversationId: args.conversationId || null,
    summary: { batches: batches.rowCount, batchStatusCounts: statusCounts },
    queues,
    batches: batches.rows,
    sessions: sessions.rows,
    events: events.rows,
  }, null, 2));
};

main()
  .catch((error) => {
    console.error('[chatbot:sequence:report] erro:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([
      closePostgres().catch(() => {}),
      closeQueues().catch(() => {}),
    ]);
  });
