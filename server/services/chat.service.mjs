import crypto from 'node:crypto';
import { decodeCursor,encodeCursor,parseLimit } from './cursor.service.mjs';
import { listConversations,getConversation } from '../repositories/conversations.repository.mjs';
import { listMessages,insertPendingOutbound } from '../repositories/messages.repository.mjs';
import { updateConversationLastOutbound } from '../repositories/conversations.repository.mjs';
import { addJob } from '../queues/queues.mjs';
import { getChatAccessFilter } from './chat-authorization.service.mjs';
import { withTransaction } from '../db/postgres.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
const mediaShape=(row)=>row.media_id?{id:row.media_id,mimeType:null,size:null,thumbnailUrl:null,originalUrl:null,status:'pending'}:null;
export const getConversationPage=async({auth,limit,cursor,status})=>{
  const tenantId=auth.tenantId;const access=getChatAccessFilter(auth);
  const pageSize=parseLimit(limit,30,50); const decoded=decodeCursor(cursor,'conversation');
  const rows=await listConversations({tenantId,status,limit:pageSize,cursor:decoded,access}); const hasMore=rows.length>pageSize; const items=rows.slice(0,pageSize);
  return {items:items.map((r)=>({id:r.id,customer_id:r.customer_id,contact_name:r.contact_name,contact_phone:r.contact_phone,avatar_url:r.avatar_url,last_message:r.last_message,last_message_type:r.last_message_type,last_message_at:r.last_message_at,unread_count:r.unread_count,status:r.status,priority:r.priority,assigned_agent_id:r.assigned_agent_id,assigned_agent_name:r.assigned_agent_name,queue_id:r.queue_id,service_id:r.service_id,tags:r.tags_json||[],labels:r.labels_json||[],is_pinned:r.is_pinned,manual_unread:r.manual_unread,is_within_customer_window:null,source_accounts:r.source_accounts_json||[],default_route_selector:r.default_route_selector_json,active_route_selector:r.active_route_selector_json})),nextCursor:hasMore?encodeCursor(items.at(-1),'cursor_at'):null,hasMore};
};
export const getMessagePage=async({auth,conversationId,limit,before})=>{
  const tenantId=auth.tenantId;const access=getChatAccessFilter(auth);
  if(!await getConversation(tenantId,conversationId,access)) throw Object.assign(new Error('Conversation not found.'),{statusCode:404});
  const pageSize=parseLimit(limit,20,100); const rows=await listMessages({tenantId,conversationId,limit:pageSize,cursor:decodeCursor(before,'message')}); const hasMore=rows.length>pageSize; const selected=rows.slice(0,pageSize); const oldest=selected.at(-1);
  return {items:selected.reverse().map((r)=>({...r,media:mediaShape(r),raw_json:undefined})),prevCursor:hasMore&&oldest?encodeCursor(oldest):null,hasMore};
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
