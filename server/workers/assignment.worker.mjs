import 'dotenv/config';

import { QUEUE_NAMES } from '../queues/queue-names.mjs';
import { autoAssignConversation } from '../services/assignment.service.mjs';
import { getLogger } from '../services/logger.service.mjs';
import { startWorker } from './worker-runtime.mjs';

const enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.ASSIGNMENT_WORKER_ENABLED || '').trim().toLowerCase());
const allowedRoutes = String(process.env.ASSIGNMENT_ALLOWED_ROUTES || 'vendas')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

if (!enabled) throw new Error('Assignment worker is disabled. Set ASSIGNMENT_WORKER_ENABLED=true only in controlled homologation.');

await startWorker(QUEUE_NAMES.assignment, async (job) => {
  const logger = await getLogger();
  const result = await autoAssignConversation({
    tenantId: job.data.tenantId,
    conversationId: job.data.conversationId,
    allowedRoutes,
    maxQueueAgeMinutes: Math.max(1, Number(process.env.ASSIGNMENT_MAX_QUEUE_AGE_MINUTES || 60)),
    presenceTtlSeconds: Math.max(30, Number(process.env.ASSIGNMENT_PRESENCE_TTL_SECONDS || 90)),
  });
  logger.info({
    tenantId: job.data.tenantId,
    conversationId: job.data.conversationId,
    routeKey: job.data.routeKey,
    skipped: result.skipped,
    reason: result.reason,
    assignedAgentId: result.conversation?.assigned_agent_id,
  }, 'assignment job processed');
  return result;
}, { concurrency: Math.max(1, Number(process.env.ASSIGNMENT_WORKER_CONCURRENCY || 2)) });
