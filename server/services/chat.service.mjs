import crypto from 'node:crypto';
import { decodeCursor,encodeCursor,parseLimit } from './cursor.service.mjs';
import { listConversations,getConversation,markConversationReadGlobal } from '../repositories/conversations.repository.mjs';
import { listMessages,insertPendingOutbound } from '../repositories/messages.repository.mjs';
import { updateConversationLastOutbound } from '../repositories/conversations.repository.mjs';
import { findLatestConversationMessage,findMessageReadCursor } from '../repositories/conversation-reads.repository.mjs';
import { addJob } from '../queues/queues.mjs';
import { getChatAccessFilter } from './chat-authorization.service.mjs';
import { withTransaction } from '../db/postgres.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
import { resolveOutboundChannel, resolveWindowExpiresAt } from './channel-routing.service.mjs';
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
export const shapeConversationSummary=(row,now=Date.now())=>{
  const lastReceivedAt=row.last_customer_message_at||row.last_received_at||null;
  const windowExpiresAt=resolveWindowExpiresAt(row);
  const windowExpiresAtMs=Date.parse(String(windowExpiresAt||''));
  const isWithinCustomerWindow=Number.isFinite(windowExpiresAtMs)&&now<=windowExpiresAtMs;
  const userUnreadCount=Number.isFinite(Number(row.user_unread_count))?Number(row.user_unread_count):Number(row.unread_count||0);
  return {id:row.id,customer_id:row.customer_id,contact_name:row.contact_name,contact_phone:row.contact_phone,normalized_phone:row.normalized_phone,avatar_url:row.avatar_url,last_message:row.last_message,last_message_type:row.last_message_type,last_message_at:row.last_message_at,last_received_at:lastReceivedAt,last_client_message_time:lastReceivedAt,lastCustomerMessageAt:lastReceivedAt,windowExpiresAt,is24hWindowOpen:isWithinCustomerWindow,unread_count:userUnreadCount,unreadCount:userUnreadCount,isUnread:userUnreadCount>0,status:row.status,priority:row.priority,assigned_agent_id:row.assigned_agent_id,assigned_agent_name:row.assigned_agent_name,assigned_at:row.assigned_at,assignment_status:row.assignment_status,last_assignment_at:row.last_assignment_at,queue_id:row.queue_id,service_id:row.service_id,route_key:row.last_inbound_route_key||row.route_key,phone_number_id:row.last_inbound_phone_number_id||row.phone_number_id,last_inbound_route_key:row.last_inbound_route_key,last_inbound_phone_number_id:row.last_inbound_phone_number_id,last_24h_window_expires_at:windowExpiresAt,standard_label:row.standard_label,standard_label_source:row.standard_label_source,standard_label_reason:row.standard_label_reason,standard_label_overridden:row.standard_label_overridden,standard_label_updated_at:row.standard_label_updated_at,last_read_at:row.last_read_at,last_read_by:row.last_read_by,tags:row.tags_json||[],labels:row.labels_json||[],is_pinned:row.is_pinned,manual_unread:row.manual_unread,is_within_customer_window:isWithinCustomerWindow,source_accounts:row.source_accounts_json||[],default_route_selector:row.default_route_selector_json,active_route_selector:row.active_route_selector_json};
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
  const outboundChannel=resolveOutboundChannel({conversation,deliveryKind:'free_text'});
  if(!outboundChannel.allowed){
    throw Object.assign(new Error('A janela de 24h esta fechada. Use um template HSM, que sera enviado pelo numero default.'),{statusCode:409,code:'customer_window_closed'});
  }
  const clientMessageId=String(input.clientMessageId||crypto.randomUUID());
  const result=await withTransaction(async(client)=>{
    const locked=(await client.query('SELECT * FROM conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,input.conversationId])).rows[0];
    const lockedChannel=resolveOutboundChannel({conversation:locked,deliveryKind:'free_text'});
    if(!lockedChannel.allowed) throw Object.assign(new Error('A janela de 24h esta fechada. Use um template HSM.'),{statusCode:409,code:'customer_window_closed'});
    const routeKey=lockedChannel.routeKey;
    const phoneNumberId=lockedChannel.phoneNumberId;
    const message=await insertPendingOutbound({tenantId,conversationId:input.conversationId,clientMessageId,type:messageType,body:input.body,routeKey,phoneNumberId,raw:{requestedBy:userId,deliveryKind:'free_text',routeKey,phoneNumberId}},client);
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
    const updated=await markConversationReadGlobal(client,{tenantId,conversationId,userId,lastReadMessageId:cursor?.id||null,lastReadAt});
    return {updated,unreadCount:0,lastReadAt,lastReadMessageId:cursor?.id||null};
  });
  const data={
    conversationId,
    userId,
    unreadCount:result.unreadCount,
    unread_count:result.unreadCount,
    lastReadAt:result.lastReadAt,
    last_read_at:result.lastReadAt,
    lastReadMessageId:result.lastReadMessageId,
    last_read_message_id:result.lastReadMessageId,
  };
  await publishRealtimeEvent({
    tenantId,
    conversationId,
    queueId:conversation.queue_id,
    assignedAgentId:conversation.assigned_agent_id,
    customerPhone:conversation.contact_phone,
    type:'conversation_read',
    data,
  });
  return data;
};
