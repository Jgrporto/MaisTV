import { checkPostgres } from '../db/postgres.mjs';
import { checkQueues } from '../queues/queues.mjs';
import { getRedisConnectionOptions } from '../queues/queues.mjs';
import { getRealtimeHealth } from '../realtime/sse.service.mjs';
const checkRedis=async()=>{const {default:Redis}=await import('ioredis').catch(e=>{throw new Error(`Redis health unavailable. Install ioredis: ${e.message}`)});const redis=new Redis({...getRedisConnectionOptions(),lazyConnect:true,maxRetriesPerRequest:1});try{await redis.connect();return {ok:(await redis.ping())==='PONG'};}finally{redis.disconnect();}};
const wrap=(fn)=>async(_req,res)=>{try{res.json(await fn());}catch(error){res.status(503).json({ok:false,error:error.message});}};
const architectureEnabled=()=>['true','1','yes','sim'].includes(String(process.env.CHAT_ARCHITECTURE_ENABLED||'').trim().toLowerCase());
const health=(component,fn)=>wrap(()=>architectureEnabled()?fn():{ok:true,status:'disabled',component});
export const createHealthRouter=async()=>{const {default:express}=await import('express').catch(e=>{throw new Error(`Express health routes unavailable. Install express: ${e.message}`)});const r=express.Router();r.get('/health/postgres',health('postgres',checkPostgres));r.get('/health/redis',health('redis',checkRedis));r.get('/health/queues',health('queues',checkQueues));r.get('/health/realtime',health('realtime',async()=>getRealtimeHealth()));return r;};
