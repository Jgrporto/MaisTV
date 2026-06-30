import { verifyMetaSignature,acceptMetaWebhook } from '../services/meta-webhook.service.mjs';
export const createWebhookRouter=async()=>{
  const {default:express}=await import('express').catch(e=>{throw new Error(`Express webhook routes unavailable. Install express: ${e.message}`)});
  const router=express.Router();
  router.get('/webhooks/meta',(req,res)=>{const valid=req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===process.env.META_WEBHOOK_VERIFY_TOKEN;if(!valid)return res.sendStatus(403);return res.status(200).send(String(req.query['hub.challenge']||''));});
  router.post('/webhooks/meta',express.raw({type:'application/json',limit:'2mb'}),async(req,res,next)=>{try{const raw=Buffer.isBuffer(req.body)?req.body:Buffer.from('');if(!verifyMetaSignature(raw,req.headers['x-hub-signature-256']))return res.status(401).json({error:'invalid_signature'});const payload=JSON.parse(raw.toString('utf8'));const result=await acceptMetaWebhook({rawBody:raw,payload});return res.status(200).json(result);}catch(error){return next(error);}});
  return router;
};
