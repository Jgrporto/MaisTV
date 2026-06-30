import 'dotenv/config';import { QUEUE_NAMES } from '../queues/queue-names.mjs';import { startWorker } from './worker-runtime.mjs';import { processInboundWebhook } from '../services/inbound-message.service.mjs';
await startWorker(QUEUE_NAMES.inbound,(job)=>processInboundWebhook(job.data));
