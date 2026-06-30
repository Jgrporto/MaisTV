process.env.MAISTV_LOCAL_API_ROLE = process.env.MAISTV_LOCAL_API_ROLE || 'auth-api';
process.env.PORT = process.env.PORT || '5054';
process.env.LOCAL_API_HTTP_ENABLED = process.env.LOCAL_API_HTTP_ENABLED || 'true';
process.env.ASSIGNMENT_RECOVERY_WORKER_ENABLED = process.env.ASSIGNMENT_RECOVERY_WORKER_ENABLED || 'false';
process.env.ROUTINE_SCHEDULER_ENABLED = process.env.ROUTINE_SCHEDULER_ENABLED || 'false';
process.env.ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED = process.env.ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED || 'false';
process.env.QUICK_REPLY_SCHEDULE_ENABLED = process.env.QUICK_REPLY_SCHEDULE_ENABLED || 'false';
process.env.NEWBR_TEST_SESSION_SCHEDULER_ENABLED = process.env.NEWBR_TEST_SESSION_SCHEDULER_ENABLED || 'false';

await import('./local-api.mjs');
