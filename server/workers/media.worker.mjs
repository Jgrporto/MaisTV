import 'dotenv/config';
import { QUEUE_NAMES } from '../queues/queue-names.mjs';
import { startWorker } from './worker-runtime.mjs';
import { processMediaJob } from '../services/media-processing.service.mjs';

await startWorker(QUEUE_NAMES.media, processMediaJob, {
  concurrency: Number(process.env.MEDIA_WORKER_CONCURRENCY || 2),
});
