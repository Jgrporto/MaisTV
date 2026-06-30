import { getConversationPage,getMessagePage,queueOutboundMessage } from '../services/chat.service.mjs';
const asyncRoute=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
export const createChatRouter=async({authMiddleware}={})=>{
  const {default:express}=await import('express').catch(e=>{throw new Error(`Express chat routes unavailable. Install express: ${e.message}`)});
  const router=express.Router(); if(authMiddleware)router.use(authMiddleware);
  router.get('/conversations',asyncRoute(async(req,res)=>res.json(await getConversationPage({auth:req.chatAuth,limit:req.query.limit,cursor:req.query.cursor,status:req.query.status}))));
  router.get('/conversations/:conversationId/messages',asyncRoute(async(req,res)=>res.json(await getMessagePage({auth:req.chatAuth,conversationId:req.params.conversationId,limit:req.query.limit,before:req.query.before}))));
  router.post('/messages/send',express.json({limit:'256kb'}),asyncRoute(async(req,res)=>res.status(202).json({item:await queueOutboundMessage({auth:req.chatAuth,input:req.body||{}})})));
  return router;
};
