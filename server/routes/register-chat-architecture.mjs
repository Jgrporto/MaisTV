import { createAuthMiddleware,createLegacyAuthResolver } from '../services/auth-adapter.service.mjs';
import { createChatRouter } from './chat.routes.mjs';
import { createMediaRouter } from './media.routes.mjs';
import { createWebhookRouter } from './webhook.routes.mjs';
import { createHealthRouter } from './health.routes.mjs';
import { createSseRouter } from './sse.routes.mjs';
import { createBullBoardRouter } from './bull-board.routes.mjs';
import { createAssignmentRouter } from './assignment.routes.mjs';
import { getLogger } from '../services/logger.service.mjs';
import { initSentry } from '../observability/index.mjs';
export const registerChatArchitecture=async(app,{resolveSession,includeSse=true,includeBullBoard=true}={})=>{
  await initSentry();
  const [{default:pinoHttp},logger]=await Promise.all([import('pino-http'),getLogger()]);
  app.use(pinoHttp({logger,redact:['req.headers.authorization','req.headers.cookie']}));
  app.use((req,res,next)=>{const origin=String(req.headers.origin||'');const configured=String(process.env.CHAT_CORS_ORIGINS||'').split(',').map((value)=>value.trim()).filter(Boolean);const development=process.env.NODE_ENV==='production'?[]:['http://127.0.0.1:5173','http://localhost:5173'];if([...configured,...development].includes(origin)){res.set('Access-Control-Allow-Origin',origin);res.set('Access-Control-Allow-Credentials','true');res.set('Vary','Origin');}next();});
  const auth=createAuthMiddleware({resolveSession:resolveSession||createLegacyAuthResolver()});
  const adminAuth=(req,res,next)=>auth(req,res,()=>{
    const roles=Array.isArray(req.chatAuth?.roles)?req.chatAuth.roles:[];
    const allowed=roles.some((role)=>['admin','administrador'].includes(String(role).trim().toLowerCase()));
    if(!allowed)return res.status(403).json({error:'chat_admin_required',message:'Administrator access is required.'});
    return next();
  });
  app.use('/api',await createWebhookRouter()); app.use('/api',await createHealthRouter());
  app.use('/api',await createChatRouter({authMiddleware:auth})); app.use('/api',await createAssignmentRouter({authMiddleware:auth})); app.use('/api',await createMediaRouter({authMiddleware:auth}));
  if(includeSse)app.use('/api',await createSseRouter({authMiddleware:auth}));
  if(includeBullBoard){try{app.use('/admin/queues',await createBullBoardRouter({authMiddleware:adminAuth}));}catch(error){app.get('/admin/queues',adminAuth,(_req,res)=>res.status(503).json({ok:false,error:error.message}));}}
  return app;
};
