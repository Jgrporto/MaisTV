import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getQueues } from '../server/queues/queues.mjs';
import { query } from '../server/db/postgres.mjs';

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const limitArg = args.indexOf('--limit');
const limit = Math.max(1, Math.min(500, Number(limitArg >= 0 ? args[limitArg + 1] : 100) || 100));
const queues = await getQueues();
const failed = await queues.media.getFailed(0, limit - 1);
const report = {
  generatedAt: new Date().toISOString(),
  mode: confirm ? 'reprocess' : 'dry-run',
  failedCount: failed.length,
  jobs: failed.map((job) => ({ id: job.id, name: job.name, data: job.data, attemptsMade: job.attemptsMade, failedReason: job.failedReason, processedOn: job.processedOn, finishedOn: job.finishedOn })),
};

if (confirm) {
  for (const job of failed) {
    await job.retry('failed');
  }
  report.retried = failed.length;
}

const mediaIds = report.jobs.map((job) => job.data?.mediaId).filter(Boolean);
report.mediaRows = mediaIds.length ? (await query(`SELECT id,tenant_id,provider_media_id,message_id,type,mime_type,size_bytes,status,storage_key,thumbnail_key,error_message,last_attempt_at,available_at
  FROM media_files WHERE id = ANY($1::uuid[]) ORDER BY updated_at`, [mediaIds])).rows : [];
const reportDir = path.resolve('scripts', 'reports', 'media');
await fs.mkdir(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-media-reprocess.json`);
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
await Promise.all(Object.values(queues).map((queue) => queue.close()));
