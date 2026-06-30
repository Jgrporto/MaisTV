import 'dotenv/config';
import { QUEUE_NAMES } from '../queues/queue-names.mjs';
import { startWorker } from './worker-runtime.mjs';
import { putObject } from '../storage/storage.service.mjs';
import { markMediaAvailable } from '../repositories/media.repository.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';

await startWorker(QUEUE_NAMES.media, async (job) => {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN is required by media worker.');

  const metaResponse = await fetch(
    `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}/${job.data.providerMediaId}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const meta = await metaResponse.json();
  if (!metaResponse.ok || !meta.url) throw new Error(`Meta media metadata failed (${metaResponse.status}).`);

  const mediaResponse = await fetch(meta.url, { headers: { authorization: `Bearer ${token}` } });
  if (!mediaResponse.ok) throw new Error(`Meta media download failed (${mediaResponse.status}).`);

  const body = Buffer.from(await mediaResponse.arrayBuffer());
  const contentType = meta.mime_type || mediaResponse.headers.get('content-type') || 'application/octet-stream';
  const key = `${job.data.tenantId}/media/${job.data.mediaId}`;
  await putObject({ key, body, contentType });

  let thumbnailKey = null;
  if (contentType.startsWith('image/')) {
    const { default: sharp } = await import('sharp');
    const thumbnail = await sharp(body, { animated: false })
      .rotate()
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72, progressive: true })
      .toBuffer();
    thumbnailKey = `${key}.thumbnail.jpg`;
    await putObject({ key: thumbnailKey, body: thumbnail, contentType: 'image/jpeg' });
  }

  const result = await markMediaAvailable({
    tenantId: job.data.tenantId,
    id: job.data.mediaId,
    storageKey: key,
    thumbnailKey,
    sizeBytes: body.length,
    mimeType: contentType,
  });
  const media = result.rows[0];
  if (media) {
    await publishRealtimeEvent({
      tenantId: job.data.tenantId,
      conversationId: media.conversation_id,
      type: 'media_updated',
      data: { mediaId: media.id, status: 'available', hasThumbnail: Boolean(thumbnailKey) },
    });
  }
  return { sizeBytes: body.length, thumbnailCreated: Boolean(thumbnailKey) };
}, { concurrency: Number(process.env.MEDIA_WORKER_CONCURRENCY || 2) });
