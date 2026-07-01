import { createSubscriber } from './pubsub.mjs';
import { getConversation } from '../repositories/conversations.repository.mjs';
import { getChatAccessFilter } from '../services/chat-authorization.service.mjs';
const ALLOWED_EVENTS = new Set(['new_message','conversation_updated','message_status_updated','queue_updated','agent_assigned','media_updated','conversation_read']);
const clients = new Set();
let subscriberPromise;
const heartbeatMs = Math.max(5_000, Number(process.env.SSE_HEARTBEAT_MS || 25_000));
const authRevalidateMs = Math.max(heartbeatMs, Number(process.env.SSE_AUTH_REVALIDATE_MS || 60_000));
const send = (res,event,data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
const ensureSubscriber = async () => {
  if (!subscriberPromise) subscriberPromise = createSubscriber().then(async (redis) => {
    await redis.connect();
    await redis.psubscribe('tenant:*','user:*','conversation:*','queue:*');
    redis.on('pmessage',async(_pattern,channel,raw) => {
      let payload; try { payload=JSON.parse(raw); } catch { return; }
      if (!ALLOWED_EVENTS.has(payload.type)) return;
      for (const client of clients) {
        if (payload.type==='conversation_read') {
          const eventUserId=String(payload.data?.userId||payload.data?.user_id||payload.scope?.userId||'').trim();
          if (!eventUserId || eventUserId!==String(client.auth.userId||'')) continue;
        }
        const scope=payload.scope||{};
        const privileged = (Array.isArray(client.auth.roles) ? client.auth.roles : [])
          .some((role)=>['admin','administrador'].includes(String(role).trim().toLowerCase()));
        const assignedAgentId=String(scope.assignedAgentId||scope.userId||'').trim();
        const queueId=String(scope.queueId||'').trim();
        const conversationId=String(scope.conversationId||'').trim();
        const queueIds=Array.isArray(client.auth.queueIds)?client.auth.queueIds.map(String):[];
        const hasRoutingScope=Boolean(assignedAgentId||queueId||conversationId);
        let authorizedByRepository=false;
        if(!privileged&&!assignedAgentId&&!queueId&&conversationId&&!client.conversations.has(conversationId)){
          authorizedByRepository=Boolean(await getConversation(client.auth.tenantId,conversationId,getChatAccessFilter(client.auth)).catch(()=>null));
        }
        const routingAllowed=privileged||
          (assignedAgentId&&assignedAgentId===String(client.auth.userId||''))||
          (queueId&&queueIds.includes(queueId))||
          (conversationId&&client.conversations.has(conversationId))||authorizedByRepository;
        const authorized=scope.tenantId===client.auth.tenantId&&(!hasRoutingScope||routingAllowed);
        if (!authorized || (payload.eventId && client.seenEventIds.has(payload.eventId))) continue;
        if (payload.eventId) {
          client.seenEventIds.add(payload.eventId);
          if (client.seenEventIds.size > 200) client.seenEventIds.delete(client.seenEventIds.values().next().value);
        }
        send(client.res,payload.type,{
          ...(payload.data && typeof payload.data === 'object' ? payload.data : { value: payload.data }),
          conversationId: payload.data?.conversationId || scope.conversationId || undefined,
          queueId: payload.data?.queueId || scope.queueId || undefined,
          assignedAgentId: payload.data?.assignedAgentId || scope.assignedAgentId || scope.userId || undefined,
          customerPhone: payload.data?.customerPhone || scope.customerPhone || undefined,
        });
      }
    });
    return redis;
  }).catch((error) => { subscriberPromise=undefined; throw error; });
  return subscriberPromise;
};
export const openSseConnection = async (req,res) => {
  await ensureSubscriber();
  const requestedConversationIds=Array.from(new Set([
    String(req.query.conversationId||'').trim(),
    ...String(req.query.conversations||'').split(',').map((value)=>value.trim()),
  ].filter(Boolean))).slice(0,10);
  const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(requestedConversationIds.some((conversationId)=>!uuidPattern.test(conversationId))){
    throw Object.assign(new Error('Invalid SSE conversation subscription.'),{statusCode:400});
  }
  const access=getChatAccessFilter(req.chatAuth);
  const authorizedConversations=await Promise.all(requestedConversationIds.map((conversationId)=>
    getConversation(req.chatAuth.tenantId,conversationId,access)));
  if(authorizedConversations.some((conversation)=>!conversation)){
    throw Object.assign(new Error('Conversation subscription is not allowed.'),{statusCode:403});
  }
  const requestOrigin=String(req.headers.origin||'');
  const configuredOrigins=String(process.env.SSE_CORS_ORIGINS||'').split(',').map((value)=>value.trim()).filter(Boolean);
  const developmentOrigins=process.env.NODE_ENV==='production'?[]:['http://127.0.0.1:5173','http://localhost:5173'];
  const allowedOrigin=[...configuredOrigins,...developmentOrigins].includes(requestOrigin)?requestOrigin:'';
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no',...(allowedOrigin?{'Access-Control-Allow-Origin':allowedOrigin,'Access-Control-Allow-Credentials':'true','Vary':'Origin'}:{})});
  res.write('retry: 5000\n\n');
  const conversations = new Set(requestedConversationIds);
  const client={res,auth:req.chatAuth,conversations,seenEventIds:new Set()}; clients.add(client);
  send(res,'connected',{userId:req.chatAuth.userId,heartbeatMs});
  let lastAuthCheckAt=Date.now();let authCheckRunning=false;
  const heartbeat=setInterval(async()=>{res.write(': ping\n\n');if(authCheckRunning||Date.now()-lastAuthCheckAt<authRevalidateMs||typeof req.reauthorizeChatSession!=='function')return;authCheckRunning=true;try{const refreshed=await req.reauthorizeChatSession();if(!refreshed?.tenantId||refreshed.tenantId!==client.auth.tenantId)throw new Error('Session scope changed.');const refreshedAccess=getChatAccessFilter(refreshed);const stillAuthorized=await Promise.all([...client.conversations].map((conversationId)=>getConversation(refreshed.tenantId,conversationId,refreshedAccess)));if(stillAuthorized.some((conversation)=>!conversation))throw new Error('Conversation scope changed.');client.auth=refreshed;lastAuthCheckAt=Date.now();}catch{send(res,'auth_expired',{reason:'session_invalid'});res.end();}finally{authCheckRunning=false;}},heartbeatMs);
  const close=()=>{clearInterval(heartbeat);clients.delete(client);};
  req.on('close',close); req.on('error',close);
};
export const getRealtimeHealth = () => ({ok:true,connections:clients.size,subscriberStarted:Boolean(subscriberPromise)});
