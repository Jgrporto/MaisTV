import 'dotenv/config';

process.env.MAISTV_RUNTIME_ROLE = process.env.MAISTV_RUNTIME_ROLE || 'routine-worker';
process.env.MAISTV_LOCAL_API_ROLE = process.env.MAISTV_LOCAL_API_ROLE || 'routine-worker';
process.env.LOCAL_API_HTTP_ENABLED = process.env.LOCAL_API_HTTP_ENABLED || 'false';
process.env.ROUTINE_DISPATCH_QUEUE_ENABLED = process.env.ROUTINE_DISPATCH_QUEUE_ENABLED || 'true';
process.env.ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED = process.env.ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED || 'true';
process.env.ROUTINE_SCHEDULER_ENABLED = process.env.ROUTINE_SCHEDULER_ENABLED || 'true';
process.env.QUICK_REPLY_SCHEDULE_ENABLED = process.env.QUICK_REPLY_SCHEDULE_ENABLED || 'true';

await import('./local-api.mjs');

setInterval(() => {}, 60 * 60 * 1000);
