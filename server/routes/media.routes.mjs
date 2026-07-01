import { getMedia } from '../repositories/media.repository.mjs';
import { createSignedDownloadUrl,getStorageConfig } from '../storage/storage.service.mjs';
import { createLocalInternalRedirect } from '../storage/local-storage.service.mjs';
import { createLocalStorageToken, verifyLocalStorageToken } from '../storage/media-access-token.service.mjs';
import { canAccessConversation } from '../services/chat-authorization.service.mjs';
const asyncRoute=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const absoluteApiUrl=(req,path)=>`${String(req.headers['x-forwarded-proto']||req.protocol||'https').split(',')[0]}://${req.get('host')}${path}`;
const encodeDownloadName=(value)=>String(value||'media').replace(/[\r\n"]/g,'_').slice(0,180);
const contentDispositionFor=(media,type)=>{if(type==='thumbnail')return 'inline';const mime=String(media.mime_type||'').toLowerCase();const inline=mime.startsWith('image/')||mime.startsWith('audio/')||mime.startsWith('video/');return `${inline?'inline':'attachment'}; filename="${encodeDownloadName(media.original_filename||media.id)}"`;};
const localUrlFor=(req,media,key,type,route)=>{
  const ttl=getStorageConfig().signedUrlTtlSeconds;
  const token=createLocalStorageToken({tenantId:req.chatAuth.tenantId,mediaId:media.id,userId:req.chatAuth.userId,sessionId:req.chatAuth.sessionId,key,type,expiresIn:ttl});
  return {url:absoluteApiUrl(req,`/api/media/${encodeURIComponent(media.id)}/${route}?token=${encodeURIComponent(token)}`),expiresIn:ttl};
};
export const createMediaRouter=async({authMiddleware}={})=>{
  const {default:express}=await import('express').catch(e=>{throw new Error(`Express media routes unavailable. Install express: ${e.message}`)});
  const router=express.Router(); if(authMiddleware)router.use(authMiddleware);
  const resolve=async(req,key)=>{const media=await getMedia(req.chatAuth.tenantId,req.params.mediaId);if(!media||!canAccessConversation(req.chatAuth,media))throw Object.assign(new Error('Media not found.'),{statusCode:404});if(media.status!=='available'||!media[key])throw Object.assign(new Error(key==='thumbnail_key'?'Thumbnail is not available.':'Original media is not available.'),{statusCode:409});return media;};
  const deliverLocal=async(req,res,keyName,type)=>{if(getStorageConfig().provider!=='local')return res.status(404).json({error:'local_media_only'});const token=verifyLocalStorageToken(req.query.token);const media=await resolve(req,keyName);if(token.tenantId!==req.chatAuth.tenantId||token.mediaId!==media.id||token.key!==media[keyName]||token.type!==type)throw Object.assign(new Error('Invalid media token scope.'),{statusCode:401});const { headObject }=await import('../storage/storage.service.mjs');const head=await headObject(media[keyName]);res.set('Cache-Control','private, no-store');res.set('Content-Type',head.ContentType||media.mime_type||'application/octet-stream');if(head.ContentLength!=null)res.set('Content-Length',String(head.ContentLength));res.set('Content-Disposition',contentDispositionFor(media,type));res.set('X-Accel-Redirect',createLocalInternalRedirect(media[keyName]));return res.status(200).end();};
  router.get('/media/:mediaId/thumbnail',asyncRoute(async(req,res)=>{const media=await resolve(req,'thumbnail_key');if(getStorageConfig().provider==='local'){res.set('Cache-Control','private, max-age=60').json(localUrlFor(req,media,media.thumbnail_key,'thumbnail','thumbnail-file'));return;}const ttl=getStorageConfig().signedUrlTtlSeconds;res.set('Cache-Control','private, max-age=60').json({url:await createSignedDownloadUrl(media.thumbnail_key,ttl),expiresIn:ttl});}));
  router.get('/media/:mediaId/signed-url',asyncRoute(async(req,res)=>{const media=await resolve(req,'storage_key');if(getStorageConfig().provider==='local'){res.set('Cache-Control','no-store').json(localUrlFor(req,media,media.storage_key,'original','download'));return;}const ttl=getStorageConfig().signedUrlTtlSeconds;res.set('Cache-Control','no-store').json({url:await createSignedDownloadUrl(media.storage_key,ttl),expiresIn:ttl});}));
  router.get('/media/:mediaId/download',asyncRoute(async(req,res)=>deliverLocal(req,res,'storage_key','original')));
  router.get('/media/:mediaId/thumbnail-file',asyncRoute(async(req,res)=>deliverLocal(req,res,'thumbnail_key','thumbnail')));
  return router;
};
