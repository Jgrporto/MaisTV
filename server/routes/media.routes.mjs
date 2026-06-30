import { getMedia } from '../repositories/media.repository.mjs';
import { createSignedDownloadUrl } from '../storage/storage.service.mjs';
import { canAccessConversation } from '../services/chat-authorization.service.mjs';
const asyncRoute=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
export const createMediaRouter=async({authMiddleware}={})=>{
  const {default:express}=await import('express').catch(e=>{throw new Error(`Express media routes unavailable. Install express: ${e.message}`)});
  const router=express.Router(); if(authMiddleware)router.use(authMiddleware);
  const resolve=async(req,key)=>{const media=await getMedia(req.chatAuth.tenantId,req.params.mediaId);if(!media||!canAccessConversation(req.chatAuth,media))throw Object.assign(new Error('Media not found.'),{statusCode:404});if(media.status!=='available'||!media[key])throw Object.assign(new Error(key==='thumbnail_key'?'Thumbnail is not available.':'Original media is not available.'),{statusCode:409});return media;};
  router.get('/media/:mediaId/thumbnail',asyncRoute(async(req,res)=>{const media=await resolve(req,'thumbnail_key');res.set('Cache-Control','private, max-age=60').json({url:await createSignedDownloadUrl(media.thumbnail_key,300),expiresIn:300});}));
  router.get('/media/:mediaId/signed-url',asyncRoute(async(req,res)=>{const media=await resolve(req,'storage_key');res.set('Cache-Control','no-store').json({url:await createSignedDownloadUrl(media.storage_key,300),expiresIn:300});}));
  return router;
};
