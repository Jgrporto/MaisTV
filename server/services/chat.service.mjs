import crypto from 'node:crypto';
import { decodeCursor,encodeCursor,parseLimit } from './cursor.service.mjs';
import { listConversations,getConversation } from '../repositories/conversations.repository.mjs';
import { listMessages,insertPendingOutbound } from '../repositories/messages.repository.mjs';
import { updateConversationLastOutbound } from '../repositories/conversations.repository.mjs';
import {
  countUnreadForUser,
  findLatestConversationMessage,
  findMessageReadCursor,
  upsertConversationRead,
} from '../repositories/conversation-reads.repository.mjs';
import { addJob } from '../queues/queues.mjs';
import { getChatAccessFilter } from './chat-authorization.service.mjs';
import { withTransaction } from '../db/postgres.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
const mediaShape=(row)=>row.media_id?{
  id:row.joined_media_id||row.media_id,
  mediaId:row.joined_media_id||row.media_id,
  type:row.media_type||row.type||'document',
  name:row.media_original_filename||'',
  mimeType:row.media_mime_type||null,
  size:row.media_size_bytes==null?null:Number(row.media_size_bytes),
  thumbnailUrl:null,
  originalUrl:null,
  status:row.media_status||'pending',
  hasThumbnail:Boolean(row.media_thumbnail_key),
  error:row.media_error_message||null,
}:null;
const CUSTOMER_WINDOW_MS=24*60*60*1000;
export const shapeConversationSummary=(row,now=Date.now())=>{
  const lastReceivedAt=row.last_received_at||null;
  const lastReceivedAtMs=Date.parse(String(lastReceivedAt||''));
  const isWithinCustomerWindow=Number.isFinite(lastReceivedAtMs)&&now-lastReceivedAtMs<=CUSTOMER_WINDOW_MS;
  const userUnreadCount=Number.isFinite(Number(row.user_unread_count))?Number(row.user_unread_count):Number(row.unread_count||0);
  return {id:row.id,customer_id:row.customer_id,contact_name:row.contact_name,contact_phone:row.contact_phone,avatar_url:row.avatar_url,last_message:row.last_message,last_message_type:row.last_message_type,last_message_at:row.last_message_at,last_received_at:lastReceivedAt,last_client_message_time:lastReceivedAt,unread_count:userUnreadCount,unreadCount:userUnreadCount,isUnread:userUnreadCount>0,status:row.status,priority:row.priority,assigned_agent_id:row.assigned_agent_id,assigned_agent_name:row.assigned_agent_name,queue_id:row.queue_id,service_id:row.service_id,tags:row.tags_json||[],labels:row.labels_json||[],is_pinned:row.is_pinned,manual_unread:row.manual_unread,is_within_customer_window:isWithinCustomerWindow,source_accounts:row.source_accounts_json||[],default_route_selector:row.default_route_selector_json,active_route_selector:row.active_route_selector_json};
};
export const getConversationPage=async({auth,limit,cursor,status})=>{
  const tenantId=auth.tenantId;const access=getChatAccessFilter(auth);
  const pageSize=parseLimit(limit,30,50); const decoded=decodeCursor(cursor,'conversation');
  const rows=await listConversations({tenantId,status,limit:pageSize,cursor:decoded,access}); const hasMore=rows.length>pageSize; const items=rows.slice(0,pageSize);
  return {items:items.map((r)=>shapeConversationSummary(r)),nextCursor:hasMore?encodeCursor(items.at(-1),'cursor_at'):null,hasMore};
};
export const getMessagePage=async({auth,conversationId,limit,before})=>{
  const tenantId=auth.tenantId;const access=getChatAccessFilter(auth);
  if(!await getConversation(tenantId,conversationId,access)) throw Object.assign(new Error('Conversation not found.'),{statusCode:404});
  const pageSize=parseLimit(limit,20,100); const rows=await listMessages({tenantId,conversationId,limit:pageSize,cursor:decodeCursor(before,'message')}); const hasMore=rows.length>pageSize; const selected=rows.slice(0,pageSize); const oldest=selected.at(-1);
  return {items:selected.reverse().map((r)=>({...r,media:mediaShape(r),transcription:r.transcription_json||null,raw_json:undefined})),prevCursor:hasMore&&oldest?encodeCursor(oldest):null,hasMore};
};
export const queueOutboundMessage=async({auth,input})=>{
  const tenantId=auth.tenantId;const userId=auth.userId;const access=getChatAccessFilter(auth);
  if(!input.conversationId||!input.body) throw Object.assign(new Error('conversationId and body are required.'),{statusCode:400});
  const messageType=String(input.type||'text').trim().toLowerCase();
  if(messageType!=='text')throw Object.assign(new Error('The new outbound route currently accepts text only; use the compatible /api/whatsapp/send-* media routes.'),{statusCode:400});
  const conversation=await getConversation(tenantId,input.conversationId,access);
  if(!conversation) throw Object.assign(new Error('Conversation not found.'),{statusCode:404});
  const clientMessageId=String(input.clientMessageId||crypto.randomUUID());
  const result=await withTransaction(async(client)=>{
    const message=await insertPendingOutbound({tenantId,conversationId:input.conversationId,clientMessageId,type:messageType,body:input.body,raw:{requestedBy:userId}},client);
    const updatedConversation=await updateConversationLastOutbound(client,input.conversationId,message);
    return {message,conversation:updatedConversation||conversation};
  });
  const message=result.message;
  await addJob('outbound','send-message',{tenantId,messageId:message.id,userId},{jobId:`outbound:${tenantId}:${clientMessageId}`});
  const eventScope={tenantId,conversationId:conversation.id,queueId:conversation.queue_id,assignedAgentId:conversation.assigned_agent_id,customerPhone:conversation.contact_phone};
  await publishRealtimeEvent({...eventScope,type:'new_message',data:{conversationId:conversation.id,message}});
  await publishRealtimeEvent({...eventScope,type:'conversation_updated',data:{conversationId:conversation.id,conversation:result.conversation}});
  return message;
};

export const markConversationRead=async({auth,conversationId,input={}})=>{
  const tenantId=auth.tenantId;const userId=String(auth.userId||'').trim();const access=getChatAccessFilter(auth);
  if(!userId) throw Object.assign(new Error('Authenticated user is required to mark a conversation as read.'),{statusCode:401});
  const conversation=await getConversation(tenantId,conversationId,access);
  if(!conversation) throw Object.assign(new Error('Conversation not found.'),{statusCode:404});
  const requestedMessageId=String(input.lastReadMessageId||input.last_read_message_id||'').trim();
  const result=await withTransaction(async(client)=>{
    const cursor=requestedMessageId
      ? await findMessageReadCursor({tenantId,conversationId,userId,messageId:requestedMessageId},client)
      : await findLatestConversationMessage({tenantId,conversationId},client);
    const lastReadAt=cursor?.created_at||new Date().toISOString();
    const read=await upsertConversationRead({
      tenantId,
      conversationId,
      userId,
      lastReadMessageId:cursor?.id||null,
      lastReadAt,
    },client);
    const unreadCount=await countUnreadForUser({tenantId,conversationId,userId},client);
    return {read,unreadCount};
  });
  const data={
    conversationId,
    userId,
    unreadCount:result.unreadCount,
    unread_count:result.unreadCount,
    lastReadAt:result.read.last_read_at,
    last_read_at:result.read.last_read_at,
    lastReadMessageId:result.read.last_read_message_id,
    last_read_message_id:result.read.last_read_message_id,
  };
  await publishRealtimeEvent({
    tenantId,
    userId,
    conversationId,
    queueId:conversation.queue_id,
    customerPhone:conversation.contact_phone,
    type:'conversation_read',
    data,
  });
  return data;
};
