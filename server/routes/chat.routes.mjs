import { getConversationPage,getMessagePage,markConversationRead,queueOutboundMessage } from '../services/chat.service.mjs';
import { getChatTranscription,startChatTranscription } from '../services/chat-transcription.service.mjs';
import { canAccessConversation } from '../services/chat-authorization.service.mjs';
const asyncRoute=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
export const createChatRouter=async({authMiddleware,customerSummaryProvider}={})=>{
  const {default:express}=await import('express').catch(e=>{throw new Error(`Express chat routes unavailable. Install express: ${e.message}`)});
  const router=express.Router(); if(authMiddleware)router.use(authMiddleware);
  router.get('/conversations',asyncRoute(async(req,res)=>res.json(await getConversationPage({auth:req.chatAuth,limit:req.query.limit,cursor:req.query.cursor,status:req.query.status,customerSummaryProvider}))));
  router.get('/conversations/:conversationId/messages',asyncRoute(async(req,res)=>res.json(await getMessagePage({auth:req.chatAuth,conversationId:req.params.conversationId,limit:req.query.limit,before:req.query.before}))));
  router.post('/conversations/:conversationId/read',express.json({limit:'16kb'}),asyncRoute(async(req,res)=>res.json(await markConversationRead({auth:req.chatAuth,conversationId:req.params.conversationId,input:req.body||{}}))));
  router.get('/messages/:messageId/transcription',asyncRoute(async(req,res)=>{const result=await getChatTranscription(req.chatAuth.tenantId,req.params.messageId);if(!result||!canAccessConversation(req.chatAuth,result.message))return res.status(404).json({error:'message_not_found'});return res.json({messageId:req.params.messageId,conversationId:result.message.conversation_id,transcription:result.transcription});}));
  router.post('/messages/:messageId/transcribe',express.json({limit:'16kb'}),asyncRoute(async(req,res)=>{const current=await getChatTranscription(req.chatAuth.tenantId,req.params.messageId);if(!current||!canAccessConversation(req.chatAuth,current.message))return res.status(404).json({error:'message_not_found'});const transcription=await startChatTranscription({tenantId:req.chatAuth.tenantId,messageId:req.params.messageId,force:Boolean(req.body?.force)});return res.status(202).json({messageId:req.params.messageId,conversationId:current.message.conversation_id,transcription});}));
  router.post('/messages/send',express.json({limit:'256kb'}),asyncRoute(async(req,res)=>res.status(202).json({item:await queueOutboundMessage({auth:req.chatAuth,input:req.body||{}})})));
  return router;
};
