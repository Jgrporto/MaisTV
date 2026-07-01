import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { withTransaction, query } from '../../../server/db/postgres.mjs';

export const args = new Set(process.argv.slice(2));
export const valueArg = (name, fallback = '') => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
};
export const tenantId = valueArg('--tenant', process.env.CHAT_DEFAULT_TENANT_ID || 'maistv');
export const isConfirmed = args.has('--confirm') && !args.has('--dry-run');
const root = path.resolve(import.meta.dirname, '../../..');
const parse = (value, fallback = {}) => { try { return JSON.parse(String(value || '')); } catch { return fallback; } };
const digits = (value) => String(value || '').replace(/\D/g, '');
const iso = (value) => { const date = new Date(Number(value) > 10_000_000_000 ? Number(value) : Number(value) > 0 ? Number(value) * 1000 : value || Date.now()); return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(); };
const uuid = (key) => { const h = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32).split(''); h[12] = '5'; h[16] = ['8','9','a','b'][parseInt(h[16],16)%4]; return `${h.slice(0,8).join('')}-${h.slice(8,12).join('')}-${h.slice(12,16).join('')}-${h.slice(16,20).join('')}-${h.slice(20).join('')}`; };
const stableClientId = (key) => `legacy-${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0,48)}`;
const array = (value) => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
const exists = (file) => Boolean(file && fs.existsSync(file));

const normalizeConversation = (raw, source, fallbackId = '') => {
  const phone = digits(raw?.contact_phone || raw?.phone || raw?.customer?.phone || raw?.wa_id || raw?.jid || '');
  if (!phone) return null;
  const legacyId = String(raw?.id || raw?.conversation_id || fallbackId || phone);
  const routeSelector=raw?.active_route_selector||raw?.activeRouteSelector||raw?.default_route_selector||raw?.defaultRouteSelector||((raw?.phone_number_id||raw?.phoneNumberId||raw?.meta_route_key||raw?.routeKey)?{phoneNumberId:raw?.phone_number_id||raw?.phoneNumberId||null,displayPhoneNumber:raw?.display_phone_number||raw?.displayPhoneNumber||null,routeKey:raw?.meta_route_key||raw?.routeKey||null}:null);
  const sourceAccounts=array(raw?.source_accounts||raw?.sourceAccounts).length?array(raw?.source_accounts||raw?.sourceAccounts):(routeSelector?[routeSelector]:[]);
  return { legacyId, phone, name:String(raw?.contact_name || raw?.name || raw?.customer?.name || '').trim(), status:String(raw?.status || 'open'), queueId:raw?.queue_id || raw?.service_id || null, serviceId:raw?.service_id || null, assignedAgentId:raw?.assigned_agent_id || raw?.assigned_agent || null, lastMessage:raw?.last_message || '', lastMessageType:raw?.last_message_type || 'text', lastMessageAt:iso(raw?.last_message_at || raw?.last_message_at_ms || raw?.updated_at || Date.now()), unreadCount:Math.max(0,Number(raw?.unread_count || 0)),routeSelector,sourceAccounts, source };
};
const normalizeMessage = (raw, source, conversationLegacyId = '', fallbackPhone = '') => {
  const legacyId = String(raw?.id || raw?.message_id || raw?.provider_message_id || `${conversationLegacyId}:${raw?.timestamp_ms || raw?.timestamp || raw?.created_at || ''}:${raw?.body || raw?.content || ''}`);
  const providerId = String(raw?.provider_message_id || raw?.wamid || (String(raw?.id || '').startsWith('wamid.') ? raw.id : '')).trim() || null;
  const direction = String(raw?.direction || '').toLowerCase() === 'outbound' || ['agent','system'].includes(String(raw?.sender_type || raw?.from || '').toLowerCase()) ? 'outbound' : 'inbound';
  return { legacyId, conversationLegacyId:String(raw?.conversation_id || conversationLegacyId || ''), phone:digits(raw?.phone || raw?.contact_phone || fallbackPhone), providerId, clientId:String(raw?.client_message_id || '').trim() || (!providerId ? stableClientId(`${source}:${legacyId}`) : null), direction, senderType:String(raw?.sender_type || (direction === 'outbound' ? 'agent' : 'customer')), type:String(raw?.message_type || raw?.type || 'text'), body:raw?.body ?? raw?.content ?? raw?.text?.body ?? '', status:String(raw?.status || (direction === 'inbound' ? 'received' : 'sent')), createdAt:iso(raw?.created_at || raw?.created_date || raw?.timestamp_ms || raw?.timestamp || Date.now()), raw, source };
};

const readJsonSource = (file, source) => {
  if (!exists(file)) return { conversations:[], messages:[], skipped:[`${source}: arquivo ausente (${file})`] };
  const store = parse(fs.readFileSync(file, 'utf8'));
  const base = store.whatsapp || store.whatsappStore || store;
  const conversations = array(base.conversations).map((item) => normalizeConversation(item, source)).filter(Boolean);
  const messages = array(base.messages).flatMap((item) => Array.isArray(item) ? item : [item]).map((item) => normalizeMessage(item, source, item?.conversation_id)).filter(Boolean);
  return { conversations, messages, skipped:[] };
};
const tableExists = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const readSqliteSource = (file, source) => {
  if (!exists(file)) return { conversations:[], messages:[], skipped:[`${source}: arquivo ausente (${file})`] };
  const db = new Database(file, { readonly:true, fileMustExist:true });
  try {
    const conversations = tableExists(db,'whatsapp_conversations') ? db.prepare('SELECT * FROM whatsapp_conversations').all().map((row) => normalizeConversation({ ...parse(row.payload), ...row }, source, row.id)).filter(Boolean) : [];
    const messages = tableExists(db,'whatsapp_messages') ? db.prepare('SELECT * FROM whatsapp_messages').all().map((row) => normalizeMessage({ ...parse(row.payload), ...row }, source, row.conversation_id)).filter(Boolean) : [];
    return { conversations, messages, skipped:[] };
  } finally { db.close(); }
};
const readHistorySource = (file) => {
  if (!exists(file)) return { conversations:[], messages:[], skipped:[`history-sqlite: arquivo ausente (${file})`] };
  const db = new Database(file, { readonly:true, fileMustExist:true });
  try {
    if (!tableExists(db,'history_messages')) return { conversations:[], messages:[], skipped:['history-sqlite: tabela history_messages ausente'] };
    const rows = db.prepare('SELECT * FROM history_messages').all();
    const conversations = rows.map((row) => normalizeConversation({ id:row.legacy_conversation_id || `history:${row.phone}`, phone:row.phone, last_message_at:row.timestamp_ms }, 'history-sqlite')).filter(Boolean);
    const messages = rows.map((row) => normalizeMessage({ ...parse(row.payload), ...row, conversation_id:row.legacy_conversation_id || `history:${row.phone}` }, 'history-sqlite', row.legacy_conversation_id, row.phone));
    return { conversations, messages, skipped:[] };
  } finally { db.close(); }
};

export const collectPlan = ({ only = 'all' } = {}) => {
  const jsonFiles = [process.env.LEGACY_WHATSAPP_JSON_PATH || path.join(root,'server/data/whatsapp-store.json'),process.env.LEGACY_MAIN_STORE_JSON_PATH || path.join(root,'server/data/store.json')];
  const mainSqlite = process.env.WHATSAPP_BACKFILL_SQLITE_PATH || process.env.SQLITE_DB_PATH || path.join(root,'server/data/maistv.sqlite');
  const historySqlite = process.env.WHATSAPP_HISTORY_DB_PATH || path.join(root,'server/data/maistv-history.sqlite');
  const sources = only === 'json' ? jsonFiles.map((file,index)=>readJsonSource(file,`json-${index+1}`)) : only === 'sqlite' ? [readSqliteSource(mainSqlite,'whatsapp-sqlite'),readHistorySource(historySqlite)] : [...jsonFiles.map((file,index)=>readJsonSource(file,`json-${index+1}`)),readSqliteSource(mainSqlite,'whatsapp-sqlite'),readHistorySource(historySqlite)];
  const legacyConversationRows=sources.reduce((total,source)=>total+source.conversations.length,0);
  const legacyMessageRows=sources.reduce((total,source)=>total+source.messages.length,0);
  const conversationsByPhone = new Map();
  const legacyToPhone = new Map();
  for (const item of sources.flatMap((source)=>source.conversations)) { legacyToPhone.set(item.legacyId,item.phone); const current=conversationsByPhone.get(item.phone); if(!current || Date.parse(item.lastMessageAt)>=Date.parse(current.lastMessageAt)) conversationsByPhone.set(item.phone,{...current,...item}); }
  const messagesByKey = new Map();
  let messagesWithoutConversation=0;
  for (const item of sources.flatMap((source)=>source.messages)) { const phone=item.phone||legacyToPhone.get(item.conversationLegacyId)||''; if(!phone){messagesWithoutConversation+=1;continue;} if(!conversationsByPhone.has(phone)) conversationsByPhone.set(phone,normalizeConversation({phone,id:item.conversationLegacyId,last_message_at:item.createdAt},item.source)); const bodyHash=crypto.createHash('sha256').update(String(item.body||'')).digest('hex'); const clientId=item.providerId?item.clientId:stableClientId(`${tenantId}:${phone}:${item.direction}:${item.createdAt}:${bodyHash}`); const key=item.providerId?`provider:${item.providerId}`:`client:${clientId}`; if(!messagesByKey.has(key)) messagesByKey.set(key,{...item,clientId,phone}); }
  return { tenantId, generatedAt:new Date().toISOString(), mode:isConfirmed?'confirm':'dry-run', conversations:[...conversationsByPhone.values()], messages:[...messagesByKey.values()], stats:{legacyConversationRows,legacyMessageRows,distinctConversations:conversationsByPhone.size,distinctMessages:messagesByKey.size,messagesWithoutConversation,duplicateMessagesIgnored:Math.max(0,legacyMessageRows-messagesByKey.size-messagesWithoutConversation)}, skipped:sources.flatMap((source)=>source.skipped) };
};

const batches = (items,size) => Array.from({length:Math.ceil(items.length/size)},(_,index)=>items.slice(index*size,(index+1)*size));
export const applyPlan = async (plan) => {
  const batchSize=Math.max(50,Math.min(1000,Number(process.env.CHAT_BACKFILL_BATCH_SIZE||500)));
  const ids=new Map();let insertedConversations=0;let insertedMessages=0;
  for(const batch of batches(plan.conversations,Math.min(batchSize,250))){
    await withTransaction(async(client)=>{for(const item of batch){
      const id=uuid(`${plan.tenantId}:conversation:${item.phone}`);
      const result=await client.query(`INSERT INTO conversations (id,tenant_id,contact_phone,contact_name,status,queue_id,service_id,assigned_agent_id,last_message,last_message_type,last_message_at,unread_count,source_accounts_json,active_route_selector_json,default_route_selector_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$14::jsonb) ON CONFLICT (tenant_id,contact_phone) DO UPDATE SET contact_name=COALESCE(NULLIF(conversations.contact_name,''),EXCLUDED.contact_name),queue_id=COALESCE(conversations.queue_id,EXCLUDED.queue_id),service_id=COALESCE(conversations.service_id,EXCLUDED.service_id),assigned_agent_id=COALESCE(conversations.assigned_agent_id,EXCLUDED.assigned_agent_id),source_accounts_json=CASE WHEN EXCLUDED.source_accounts_json='[]'::jsonb THEN conversations.source_accounts_json ELSE EXCLUDED.source_accounts_json END,active_route_selector_json=COALESCE(EXCLUDED.active_route_selector_json,conversations.active_route_selector_json),default_route_selector_json=COALESCE(conversations.default_route_selector_json,EXCLUDED.default_route_selector_json),last_message=CASE WHEN conversations.last_message_at IS NULL OR EXCLUDED.last_message_at>conversations.last_message_at THEN EXCLUDED.last_message ELSE conversations.last_message END,last_message_type=CASE WHEN conversations.last_message_at IS NULL OR EXCLUDED.last_message_at>conversations.last_message_at THEN EXCLUDED.last_message_type ELSE conversations.last_message_type END,last_message_at=GREATEST(conversations.last_message_at,EXCLUDED.last_message_at),unread_count=GREATEST(conversations.unread_count,EXCLUDED.unread_count),updated_at=now() RETURNING id,(xmax=0) AS inserted`,[id,plan.tenantId,item.phone,item.name||null,item.status||'open',item.queueId,item.serviceId,item.assignedAgentId,item.lastMessage||null,item.lastMessageType||'text',item.lastMessageAt,item.unreadCount,JSON.stringify(item.sourceAccounts||[]),item.routeSelector?JSON.stringify(item.routeSelector):null]);
      ids.set(item.phone,result.rows[0].id);insertedConversations+=result.rows[0].inserted?1:0;
    }});
  }
  for(const batch of batches(plan.messages,batchSize)){
    await withTransaction(async(client)=>{for(const item of batch){
      const conversationId=ids.get(item.phone);if(!conversationId)continue;
      const result=await client.query(`INSERT INTO messages (id,tenant_id,conversation_id,provider_message_id,client_message_id,direction,sender_type,type,body,status,raw_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) ON CONFLICT DO NOTHING RETURNING id`,[uuid(`${plan.tenantId}:message:${item.providerId||item.clientId}`),plan.tenantId,conversationId,item.providerId,item.clientId,item.direction,item.senderType,item.type,item.body||null,item.status,JSON.stringify({legacy:item.raw,backfillSource:item.source}),item.createdAt]);
      insertedMessages+=result.rowCount;
    }});
  }
  return {insertedConversations,insertedMessages,plannedConversations:plan.conversations.length,plannedMessages:plan.messages.length,batchSize};
};

export const validateTenant = async () => { const [conversations,messages,orphans,duplicates]=await Promise.all([query('SELECT count(*)::int AS count FROM conversations WHERE tenant_id=$1',[tenantId]),query('SELECT count(*)::int AS count FROM messages WHERE tenant_id=$1',[tenantId]),query('SELECT count(*)::int AS count FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id WHERE m.tenant_id=$1 AND c.id IS NULL',[tenantId]),query(`SELECT count(*)::int AS count FROM (SELECT COALESCE(provider_message_id,client_message_id) AS key,count(*) FROM messages WHERE tenant_id=$1 GROUP BY COALESCE(provider_message_id,client_message_id) HAVING count(*)>1) duplicate_groups`,[tenantId])]); return {tenantId,postgresConversations:conversations.rows[0].count,postgresMessages:messages.rows[0].count,orphanMessages:orphans.rows[0].count,duplicateGroups:duplicates.rows[0].count}; };
export const writeReport = (name, payload) => { const requested=valueArg('--report',''); const directory=path.join(import.meta.dirname,'reports'); fs.mkdirSync(requested?path.dirname(path.resolve(requested)):directory,{recursive:true}); const file=requested?path.resolve(requested):path.join(directory,`${new Date().toISOString().replace(/[:.]/g,'-')}-${name}.json`); fs.writeFileSync(file,JSON.stringify(payload,null,2)); return file; };
