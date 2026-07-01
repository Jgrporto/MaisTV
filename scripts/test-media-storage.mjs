import 'dotenv/config';
import crypto from 'node:crypto';
import { deleteObject, getObject, getStorageConfig, headObject, putObject, createSignedDownloadUrl } from '../server/storage/storage.service.mjs';

const args = new Set(process.argv.slice(2));
if (!args.has('--confirm')) throw new Error('Use --confirm to perform the reversible storage smoke test.');

const config = getStorageConfig();
const nonce = crypto.randomUUID();
const key = `maistv/storage-smoke/${nonce}.txt`;
const body = Buffer.from(`maistv-storage-smoke:${nonce}`, 'utf8');
const report = { provider: config.provider, bucket: config.bucket, endpoint: config.endpoint || 'aws-default', key, uploaded: false, head: false, read: false, signedUrl: false, signedDownload: false, deleted: false };

try {
  await putObject({ key, body, contentType: 'text/plain; charset=utf-8', metadata: { smoke: 'true' } });
  report.uploaded = true;
  const head = await headObject(key);
  report.head = Number(head.ContentLength) === body.length;
  const object = await getObject(key);
  const downloaded = typeof object.Body?.transformToByteArray === 'function'
    ? Buffer.from(await object.Body.transformToByteArray())
    : Buffer.concat(await Array.fromAsync(object.Body, (chunk) => Buffer.from(chunk)));
  report.read = downloaded.equals(body);
  const url = await createSignedDownloadUrl(key);
  report.signedUrl = /^https?:\/\//.test(url);
  const response = await fetch(url);
  report.signedDownload = response.ok && Buffer.from(await response.arrayBuffer()).equals(body);
} finally {
  await deleteObject(key).then(() => { report.deleted = true; }).catch((error) => { report.deleteError = error.message; });
}

console.log(JSON.stringify(report, null, 2));
if (!report.uploaded || !report.head || !report.read || !report.signedUrl || !report.signedDownload || !report.deleted) process.exitCode = 1;
