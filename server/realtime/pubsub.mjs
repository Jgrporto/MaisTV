import { getLogger } from '../services/logger.service.mjs';
import crypto from 'node:crypto';
import { getRedisConnectionOptions } from '../queues/queues.mjs';
let publisherPromise;
const createRedis = async () => {
  const { default: Redis } = await import('ioredis').catch((error) => { throw new Error(`Redis Pub/Sub unavailable. Install ioredis: ${error.message}`); });
  return new Redis({ ...getRedisConnectionOptions(),lazyConnect:true });
};
export const getPublisher = async () => {
  if (!publisherPromise) publisherPromise = createRedis().then(async (redis) => { await redis.connect(); return redis; }).catch((error) => { publisherPromise=undefined; throw error; });
  return publisherPromise;
};
export const publishRealtimeEvent = async ({ tenantId,userId,conversationId,queueId,type,data }) => {
  if (!tenantId || !type) throw new Error('tenantId and type are required to publish realtime events.');
  const payload = JSON.stringify({ eventId:crypto.randomUUID(),type,data,scope:{tenantId,userId:userId||null,conversationId:conversationId||null,queueId:queueId||null},occurredAt:new Date().toISOString() });
  const channels = [`tenant:${tenantId}`];
  if (userId) channels.push(`user:${userId}`);
  if (conversationId) channels.push(`conversation:${conversationId}`);
  if (queueId) channels.push(`queue:${queueId}`);
  const publisher = await getPublisher();
  await Promise.all(channels.map((channel) => publisher.publish(channel,payload)));
  (await getLogger()).debug({type,channels},'realtime event published');
};
export const createSubscriber = createRedis;
