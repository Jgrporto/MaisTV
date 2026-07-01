import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from './queue-names.mjs';
let queuesPromise;
export const getQueuePrefix = () => String(process.env.BULLMQ_PREFIX || 'maistv').trim() || 'maistv';
export const normalizeBullMqJobId = (value) => String(value ?? '').trim().replace(/:/g, '-');
export const getRedisConnectionOptions = () => {
  const url = String(process.env.REDIS_URL || '').trim();
  if (!url) {
    const host=String(process.env.REDIS_HOST||'').trim();
    if(!host)throw new Error('Configure REDIS_URL or REDIS_HOST for BullMQ and Redis Pub/Sub.');
    return {host,port:Number(process.env.REDIS_PORT||6379),username:process.env.REDIS_USERNAME||undefined,password:process.env.REDIS_PASSWORD||undefined,db:Number(process.env.REDIS_DB||0),tls:String(process.env.REDIS_TLS||'').toLowerCase()==='true'?{}:undefined,maxRetriesPerRequest:null};
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL.'); }
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://.');
  const db = Number.parseInt(parsed.pathname.replace(/^\//, '') || '0', 10);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number.isFinite(db) ? db : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
};
export const getQueues = async () => {
  if (!queuesPromise) queuesPromise = import('bullmq').then(({ Queue }) => {
    const connection = getRedisConnectionOptions();
    return Object.fromEntries(Object.entries(QUEUE_NAMES).map(([key,name]) => [key,new Queue(name,{ connection,prefix:getQueuePrefix(),defaultJobOptions:DEFAULT_JOB_OPTIONS })]));
  }).catch((error) => { queuesPromise = undefined; throw new Error(`BullMQ unavailable. Install bullmq and configure REDIS_URL: ${error.message}`, { cause:error }); });
  return queuesPromise;
};
export const addJob = async (queueKey, name, data, options = {}) => {
  const queues = await getQueues();
  if (!queues[queueKey]) throw new Error(`Unknown queue: ${queueKey}`);
  const nextOptions = {...DEFAULT_JOB_OPTIONS,...options};
  if (Object.hasOwn(nextOptions,'jobId')) {
    const normalizedJobId = normalizeBullMqJobId(nextOptions.jobId);
    if (normalizedJobId) nextOptions.jobId = normalizedJobId;
    else delete nextOptions.jobId;
  }
  return queues[queueKey].add(name,data,nextOptions);
};
export const checkQueues = async () => {
  const queues = await getQueues();
  const counts = {};
  for (const [key,queue] of Object.entries(queues)) counts[key] = await queue.getJobCounts('waiting','active','failed','delayed');
  return { ok:true, counts };
};
