import { withTransaction } from '../db/postgres.mjs';
import { getConversation } from '../repositories/conversations.repository.mjs';
import {
  getAgentPresence,
  listAgentPresence,
  syncQueueMemberships,
  upsertAgentPresence,
} from '../repositories/assignment.repository.mjs';
import { addJob } from '../queues/queues.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
import { getChatAccessFilter, isPrivilegedChatUser } from './chat-authorization.service.mjs';

const text = (value) => String(value || '').trim();
const userNameOf = (auth = {}) => text(auth.raw?.full_name || auth.raw?.username || auth.raw?.email || auth.userId);
const userEmailOf = (auth = {}) => text(auth.raw?.email);
const roleOf = (auth = {}) => text(auth.roles?.[0] || auth.raw?.role || auth.raw?.role_name);
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const assignmentStatuses = new Set(['unassigned', 'queued', 'assigned', 'closed', 'transferred']);

const shapePresence = (row = {}) => ({
  id: row.user_id,
  user_id: row.user_id,
  user_name: row.user_name || row.user_id,
  full_name: row.user_name || row.user_id,
  name: row.user_name || row.user_id,
  email: row.user_email || '',
  role: row.role || '',
  status: row.status === 'online' ? 'attending' : row.status,
  paused_until: row.paused_until,
  pause_reason: row.pause_reason || '',
  last_seen_at: row.last_seen_at,
  queue_ids: row.queue_ids || [],
  service_ids: row.queue_ids || [],
});

const publishAssignment = async ({ conversation, type, data = {} }) => {
  const scope = {
    tenantId: conversation.tenant_id,
    conversationId: conversation.id,
    queueId: conversation.queue_id,
    assignedAgentId: conversation.assigned_agent_id,
    customerPhone: conversation.contact_phone,
  };
  await publishRealtimeEvent({ ...scope, type, data: { conversationId: conversation.id, conversation, ...data } });
  await publishRealtimeEvent({ ...scope, type: 'conversation_updated', data: { conversationId: conversation.id, conversation } });
};

const publishPresence = ({ tenantId, userId, presence }) => publishRealtimeEvent({
  tenantId,
  type: 'presence_updated',
  data: { userId, presence },
});

const isAssignmentEnqueueEnabled = () => ['1', 'true', 'yes', 'on'].includes(String(process.env.ASSIGNMENT_ENQUEUE_ENABLED || '').trim().toLowerCase());
const attendingUsersCache = new Map();
const presenceStatusCache = new Map();
const presenceStartCache = new Map();
const presenceStartInFlight = new Map();
const PRESENCE_STATUS_CACHE_MS = 3000;
const PRESENCE_START_DEDUPE_MS = 5000;

const presenceUserKey = ({ tenantId, userId }) => `${text(tenantId)}:${text(userId)}`;
const presenceStartKey = ({ auth, sessionId = '' }) => `${presenceUserKey(auth)}:${text(sessionId) || 'default'}`;
const clearPresenceReadCaches = ({ tenantId, userId }) => {
  presenceStatusCache.delete(presenceUserKey({ tenantId, userId }));
  const tenantPrefix = `${text(tenantId)}:`;
  for (const key of attendingUsersCache.keys()) {
    if (key.startsWith(tenantPrefix)) attendingUsersCache.delete(key);
  }
};
const clearPresenceStartCache = ({ tenantId, userId }) => {
  const userPrefix = `${presenceUserKey({ tenantId, userId })}:`;
  for (const key of presenceStartCache.keys()) {
    if (key.startsWith(userPrefix)) presenceStartCache.delete(key);
  }
};

export const clearPresenceCaches = () => {
  attendingUsersCache.clear();
  presenceStatusCache.clear();
  presenceStartCache.clear();
  presenceStartInFlight.clear();
};

const enqueueAssignmentJob = async ({ tenantId, conversation, source, ignoreQueueAge = false }) => {
  const enabled = isAssignmentEnqueueEnabled();
  if (!enabled) return { conversationId: conversation.id, queued: false, reason: 'assignment_enqueue_disabled' };
  if (!conversation.queue_id) return { conversationId: conversation.id, queued: false, reason: 'queue_missing' };

  try {
    await addJob('assignment', 'assign-conversation', {
      tenantId,
      conversationId: conversation.id,
      routeKey: conversation.last_inbound_route_key || conversation.route_key || 'default',
      ignoreQueueAge,
      source,
    }, { jobId: `assignment:${source}:${tenantId}:${conversation.id}:${Date.now()}` });
    return { conversationId: conversation.id, queued: true };
  } catch (err) {
    return { conversationId: conversation.id, queued: false, reason: err?.message || 'assignment_enqueue_failed' };
  }
};

const enqueuePendingAssignmentsForQueues = async ({ tenantId, queueIds = [], source = 'presence_start' }) => {
  if (!isAssignmentEnqueueEnabled()) return { skipped: true, reason: 'assignment_enqueue_disabled', jobs: [] };
  const uniqueQueueIds = Array.from(new Set(queueIds.map(text).filter(Boolean)));
  if (!uniqueQueueIds.length) return { skipped: true, reason: 'queue_missing', jobs: [] };
  const limit = Math.max(1, Math.min(500, Number(process.env.ASSIGNMENT_LOGIN_SWEEP_LIMIT || 100)));
  const maxAgeMinutes = Math.max(0, Number(process.env.ASSIGNMENT_LOGIN_SWEEP_MAX_AGE_MINUTES || 0));
  const ignoreQueueAge = maxAgeMinutes === 0;
  const values = [tenantId, uniqueQueueIds, limit];
  const ageFilter = maxAgeMinutes > 0 ? 'AND COALESCE(last_message_at,updated_at,created_at) >= now()-make_interval(mins=>$4::int)' : '';
  if (maxAgeMinutes > 0) values.push(maxAgeMinutes);
  const conversations = (await withTransaction(async (client) => (await client.query(`
    SELECT id,queue_id,route_key,last_inbound_route_key,last_message_at,updated_at
    FROM conversations
    WHERE tenant_id=$1
      AND queue_id=ANY($2::text[])
      AND status<>'closed'
      AND assigned_agent_id IS NULL
      AND assignment_status IN ('queued','unassigned')
      ${ageFilter}
    ORDER BY last_message_at DESC NULLS LAST,updated_at DESC
    LIMIT $3
  `, values)).rows)) || [];
  const jobs = await Promise.all(conversations.map((conversation) => enqueueAssignmentJob({
    tenantId,
    conversation,
    source,
    ignoreQueueAge,
  })));
  return { skipped: false, scannedQueueIds: uniqueQueueIds, conversationIds: conversations.map((conversation) => conversation.id), jobs };
};

const ensureTargetMembership = async (client, { tenantId, queueId, targetUserId }) => {
  const membership = (await client.query(`
    SELECT * FROM queue_memberships
    WHERE tenant_id=$1 AND queue_id=$2 AND user_id=$3 AND is_active=true
    FOR UPDATE
  `, [tenantId, queueId, targetUserId])).rows[0];
  if (!membership) throw error('O usuario de destino nao pertence a esta fila.', 403);
  return membership;
};

const hasConversationQueueAccess = (access = {}, conversation = {}, userId = '') => {
  const allowedIds = access.queueOrServiceIds || access.queueIds || [];
  const queueId = text(conversation.queue_id);
  const serviceId = text(conversation.service_id);
  return Boolean(
    text(conversation.assigned_agent_id) === text(userId) ||
    (queueId && allowedIds.includes(queueId)) ||
    (serviceId && allowedIds.includes(serviceId))
  );
};

const mutateAssignment = async ({ auth, conversationId, targetUserId = '', action, targetQueueId = '', reason = '' }) => {
  const tenantId = auth.tenantId;
  const actorUserId = text(auth.userId);
  const privileged = isPrivilegedChatUser(auth);
  const result = await withTransaction(async (client) => {
    const conversation = (await client.query(`
      SELECT * FROM conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE
    `, [tenantId, conversationId])).rows[0];
    if (!conversation) throw error('Conversa nao encontrada.', 404);
    const access = getChatAccessFilter(auth);
    const hasQueueAccess = privileged || hasConversationQueueAccess(access, conversation, actorUserId);
    if (!hasQueueAccess) throw error('Voce nao possui acesso a esta conversa.', 403);
    if (conversation.assignment_status === 'closed' || conversation.status === 'closed') {
      throw error('Conversa encerrada nao pode ser redistribuida.', 409);
    }

    const fromQueueId = conversation.queue_id;
    const fromAgentId = conversation.assigned_agent_id;
    let queueId = text(targetQueueId || conversation.queue_id);
    let agentId = text(targetUserId);
    let agentName = null;
    let status = conversation.assignment_status;

    if (action === 'assign') {
      if (!queueId) throw error('A conversa ainda nao possui fila.', 409);
      if (!agentId) agentId = actorUserId;
      if (!privileged && agentId !== actorUserId) throw error('Atendente pode assumir somente para si.', 403);
      if (fromAgentId && fromAgentId !== agentId && !privileged) throw error('Conversa ja atribuida a outro atendente.', 409);
      const membership = await ensureTargetMembership(client, { tenantId, queueId, targetUserId: agentId });
      agentName = membership.user_name || agentId;
      status = 'assigned';
    } else if (action === 'transfer') {
      if (!queueId || !agentId) throw error('Fila e atendente de destino sao obrigatorios.', 400);
      if (!privileged && fromAgentId !== actorUserId) throw error('Somente o responsavel atual ou admin pode transferir.', 403);
      const membership = await ensureTargetMembership(client, { tenantId, queueId, targetUserId: agentId });
      agentName = membership.user_name || agentId;
      status = 'transferred';
    } else if (action === 'unassign') {
      if (!privileged && fromAgentId !== actorUserId) throw error('Somente o responsavel atual ou admin pode devolver para a fila.', 403);
      if (queueId) {
        const targetQueue = (await client.query(`SELECT * FROM support_queues WHERE tenant_id=$1 AND id=$2 AND is_active=true`, [tenantId, queueId])).rows[0];
        if (!targetQueue) throw error('Fila de destino nao encontrada ou inativa.', 404);
        const allowedIds = access.queueOrServiceIds || access.queueIds || [];
        if (!privileged && !allowedIds.includes(queueId) && !allowedIds.includes(text(targetQueue.service_id))) {
          throw error('Voce nao possui acesso a fila de destino.', 403);
        }
      }
      agentId = '';
      agentName = null;
      status = queueId ? 'queued' : 'unassigned';
    } else {
      throw error('Acao de atribuicao invalida.', 400);
    }

    const updated = (await client.query(`
      UPDATE conversations SET
        queue_id=$3,assigned_agent_id=NULLIF($4,''),assigned_agent_name=$5,
        assigned_at=CASE WHEN NULLIF($4,'') IS NULL THEN NULL ELSE now() END,
        assignment_status=$6,last_assignment_at=now(),updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING *
    `, [tenantId, conversationId, queueId || null, agentId, agentName, status])).rows[0];
    if (!assignmentStatuses.has(updated.assignment_status)) throw error('Estado de atribuicao invalido.', 500);
    await client.query(`
      INSERT INTO conversation_assignment_events (
        tenant_id,conversation_id,event_type,from_queue_id,to_queue_id,
        from_agent_id,to_agent_id,actor_user_id,reason,metadata_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    `, [tenantId, conversationId, action, fromQueueId, queueId || null, fromAgentId, agentId || null, actorUserId, reason || null, JSON.stringify({ source: 'chat-api' })]);
    if (agentId) {
      await client.query(`UPDATE queue_memberships SET last_assigned_at=now(),updated_at=now()
        WHERE tenant_id=$1 AND queue_id=$2 AND user_id=$3`, [tenantId, queueId, agentId]);
    }
    return updated;
  });
  await publishAssignment({ conversation: result, type: action === 'unassign' ? 'queue_updated' : 'agent_assigned', data: { action } });
  return result;
};

export const assignConversation = ({ auth, conversationId, targetUserId, reason }) =>
  mutateAssignment({ auth, conversationId, targetUserId, action: 'assign', reason });
export const unassignConversation = ({ auth, conversationId, targetQueueId, reason }) =>
  mutateAssignment({ auth, conversationId, targetQueueId, action: 'unassign', reason });
export const transferConversation = ({ auth, conversationId, targetUserId, targetQueueId, reason }) =>
  mutateAssignment({ auth, conversationId, targetUserId, targetQueueId, action: 'transfer', reason });

const startPresenceUncached = async ({ auth }) => {
  const queueIds = await syncQueueMemberships({ tenantId: auth.tenantId, userId: auth.userId, userName: userNameOf(auth), queueIds: auth.queueIds || [], isAssignable: !isPrivilegedChatUser(auth) });
  const current = await getAgentPresence({ tenantId: auth.tenantId, userId: auth.userId });
  const pauseActive = current?.status === 'paused' && Date.parse(String(current.paused_until || '')) > Date.now();
  const presence = await upsertAgentPresence({
    tenantId: auth.tenantId,
    userId: auth.userId,
    userName: userNameOf(auth),
    userEmail: userEmailOf(auth),
    role: roleOf(auth),
    status: pauseActive ? 'paused' : 'online',
    pausedUntil: pauseActive ? current.paused_until : null,
    pauseReason: pauseActive ? current.pause_reason : null,
  });
  const shaped = shapePresence({ ...presence, queue_ids: queueIds });
  if (!current || current.status !== presence.status || String(current.paused_until || '') !== String(presence.paused_until || '')) {
    await publishPresence({ tenantId: auth.tenantId, userId: auth.userId, presence: shaped });
  }
  if (!pauseActive && !isPrivilegedChatUser(auth)) {
    void enqueuePendingAssignmentsForQueues({
      tenantId: auth.tenantId,
      queueIds,
      source: 'presence_start',
    }).catch(() => {});
  }
  clearPresenceReadCaches(auth);
  return { ok: true, presence: shaped, distributionPause: { active: pauseActive, pausedUntil: presence.paused_until, remainingMs: pauseActive ? Date.parse(presence.paused_until)-Date.now() : 0, reason: presence.pause_reason || '' } };
};

export const startPresence = async ({ auth, sessionId = '' }) => {
  const key = presenceStartKey({ auth, sessionId });
  for (const [candidateKey, candidate] of presenceStartCache) {
    if (candidate.expiresAt <= Date.now()) presenceStartCache.delete(candidateKey);
  }
  const cached = presenceStartCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (presenceStartInFlight.has(key)) return presenceStartInFlight.get(key);

  const pending = startPresenceUncached({ auth })
    .then((value) => {
      presenceStartCache.set(key, { expiresAt: Date.now() + PRESENCE_START_DEDUPE_MS, value });
      return value;
    })
    .finally(() => presenceStartInFlight.delete(key));
  presenceStartInFlight.set(key, pending);
  return pending;
};

export const heartbeatPresence = async ({ auth }) => {
  const current = await getAgentPresence({ tenantId: auth.tenantId, userId: auth.userId });
  const pauseActive = current?.status === 'paused' && Date.parse(String(current.paused_until || '')) > Date.now();
  const presence = await upsertAgentPresence({
    tenantId: auth.tenantId,
    userId: auth.userId,
    userName: userNameOf(auth),
    userEmail: userEmailOf(auth),
    role: roleOf(auth),
    status: pauseActive ? 'paused' : 'online',
    pausedUntil: pauseActive ? current.paused_until : null,
    pauseReason: pauseActive ? current.pause_reason : null,
  });
  const shaped = shapePresence(presence);
  presenceStatusCache.set(presenceUserKey(auth), {
    expiresAt: Date.now() + PRESENCE_STATUS_CACHE_MS,
    value: { ok: true, presence: shaped, distributionPause: {
      active: pauseActive,
      pausedUntil: pauseActive ? presence.paused_until : null,
      remainingMs: pauseActive ? Math.max(0, Date.parse(presence.paused_until) - Date.now()) : 0,
      reason: pauseActive ? presence.pause_reason || '' : '',
    } },
  });
  return { ok: true, presence: shaped };
};

export const stopPresence = async ({ auth, recoverAssignments = true, reason = 'logout' }) => {
  const presence = await upsertAgentPresence({ tenantId: auth.tenantId, userId: auth.userId, userName: userNameOf(auth), userEmail: userEmailOf(auth), role: roleOf(auth), status: 'offline', pauseReason: reason });
  const shaped = shapePresence(presence);
  clearPresenceReadCaches(auth);
  clearPresenceStartCache(auth);
  const recoveredConversations = recoverAssignments ? await withTransaction(async (client) => {
    const result = await client.query(`
      WITH selected AS (
        SELECT id,queue_id,assigned_agent_id
        FROM conversations
        WHERE tenant_id=$1
          AND assigned_agent_id=$2
          AND status<>'closed'
          AND assignment_status IN ('assigned','transferred')
        FOR UPDATE
      ),
      updated AS (
        UPDATE conversations c SET
          assigned_agent_id=NULL,
          assigned_agent_name=NULL,
          assigned_at=NULL,
          assignment_status=CASE WHEN NULLIF(c.queue_id,'') IS NULL THEN 'unassigned' ELSE 'queued' END,
          last_assignment_at=now(),
          updated_at=now()
        FROM selected s
        WHERE c.tenant_id=$1 AND c.id=s.id
        RETURNING c.*,s.queue_id AS previous_queue_id,s.assigned_agent_id AS previous_assigned_agent_id
      )
      SELECT * FROM updated
    `, [auth.tenantId, auth.userId]);

    for (const conversation of result.rows) {
      await client.query(`
        INSERT INTO conversation_assignment_events (
          tenant_id,conversation_id,event_type,from_queue_id,to_queue_id,
          from_agent_id,to_agent_id,actor_user_id,reason,metadata_json
        ) VALUES ($1,$2,'logout_requeue',$3,$4,$5,NULL,$6,$7,$8::jsonb)
      `, [
        auth.tenantId,
        conversation.id,
        conversation.previous_queue_id || null,
        conversation.queue_id || null,
        conversation.previous_assigned_agent_id || auth.userId,
        auth.userId,
        reason || 'logout',
        JSON.stringify({ source: 'presence_stop', recoverAssignments: true }),
      ]);
    }

    return result.rows;
  }) : [];

  await publishPresence({ tenantId: auth.tenantId, userId: auth.userId, presence: shaped });
  await Promise.all(recoveredConversations.map((conversation) => publishAssignment({
    conversation,
    type: 'queue_updated',
    data: { action: 'logout_requeue', reason },
  })));
  const assignmentRecoveryJobs = await Promise.all(recoveredConversations.map((conversation) => enqueueAssignmentJob({
    tenantId: auth.tenantId,
    conversation,
    source: 'logout_requeue',
  })));
  return {
    ok: true,
    presence: shaped,
    requeuedConversationIds: recoveredConversations.map((conversation) => conversation.id),
    requeuedConversations: recoveredConversations,
    assignmentRecoveryJobs,
  };
};

export const pausePresence = async ({ auth, reason = 'lunch', durationMinutes = 10 }) => {
  const minutes = Math.max(1, Math.min(120, Number(durationMinutes || 10)));
  const pausedUntil = new Date(Date.now() + minutes * 60_000).toISOString();
  const presence = await upsertAgentPresence({ tenantId: auth.tenantId, userId: auth.userId, userName: userNameOf(auth), userEmail: userEmailOf(auth), role: roleOf(auth), status: 'paused', pausedUntil, pauseReason: reason });
  const shaped = shapePresence(presence);
  clearPresenceReadCaches(auth);
  clearPresenceStartCache(auth);
  await publishPresence({ tenantId: auth.tenantId, userId: auth.userId, presence: shaped });
  return { ok: true, presence: shaped, distributionPause: { active: true, pausedUntil, remainingMs: minutes * 60_000, reason } };
};

export const resumePresence = async ({ auth }) => {
  const queueIds = await syncQueueMemberships({ tenantId: auth.tenantId, userId: auth.userId, userName: userNameOf(auth), queueIds: auth.queueIds || [], isAssignable: !isPrivilegedChatUser(auth) });
  const presence = await upsertAgentPresence({ tenantId: auth.tenantId, userId: auth.userId, userName: userNameOf(auth), userEmail: userEmailOf(auth), role: roleOf(auth), status: 'online' });
  const shaped = shapePresence({ ...presence, queue_ids: queueIds });
  clearPresenceReadCaches(auth);
  clearPresenceStartCache(auth);
  await publishPresence({ tenantId: auth.tenantId, userId: auth.userId, presence: shaped });
  if (!isPrivilegedChatUser(auth)) {
    void enqueuePendingAssignmentsForQueues({
      tenantId: auth.tenantId,
      queueIds,
      source: 'presence_resume',
    }).catch(() => {});
  }
  return { ok: true, presence: shaped, distributionPause: { active: false, remainingMs: 0 } };
};
export const getPresenceStatus = async ({ auth }) => {
  const cacheKey = presenceUserKey(auth);
  const cached = presenceStatusCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const row = await getAgentPresence({ tenantId: auth.tenantId, userId: auth.userId });
  const pausedUntilMs = Date.parse(String(row?.paused_until || ''));
  const active = row?.status === 'paused' && Number.isFinite(pausedUntilMs) && pausedUntilMs > Date.now();
  const value = { ok: true, presence: row ? shapePresence(row) : null, distributionPause: { active, pausedUntil: row?.paused_until || null, remainingMs: active ? pausedUntilMs - Date.now() : 0, reason: row?.pause_reason || '' } };
  presenceStatusCache.set(cacheKey, { expiresAt: Date.now() + PRESENCE_STATUS_CACHE_MS, value });
  return value;
};
export const getAttendingUsers = async ({ auth }) => {
  const ttlSeconds = Math.max(30, Number(process.env.ASSIGNMENT_PRESENCE_TTL_SECONDS || 90));
  const cacheKey = `${auth.tenantId}:${ttlSeconds}`;
  const cached = attendingUsersCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  const items = (await listAgentPresence({ tenantId: auth.tenantId, ttlSeconds })).map(shapePresence);
  attendingUsersCache.set(cacheKey, { expiresAt: Date.now() + 7500, items });
  return items;
};

export const queueConversationAssignment = async ({ tenantId, conversationId, inboundMessageId, routeKey }) => {
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.ASSIGNMENT_ENQUEUE_ENABLED || '').trim().toLowerCase());
  if (!enabled) return { skipped: true, reason: 'assignment_enqueue_disabled' };
  return addJob('assignment', 'assign-conversation', { tenantId, conversationId, inboundMessageId, routeKey }, { jobId: `assignment:${tenantId}:${inboundMessageId || conversationId}` });
};

export const autoAssignConversation = async ({ tenantId, conversationId, allowedRoutes = [], ignoreQueueAge = false, maxQueueAgeMinutes = 60, presenceTtlSeconds = 90 }) => {
  const result = await withTransaction(async (client) => {
    const conversation = (await client.query(`SELECT * FROM conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, conversationId])).rows[0];
    if (!conversation) return { skipped: true, reason: 'conversation_not_found' };
    const routeKey = text(conversation.route_key || conversation.last_inbound_route_key || 'default').toLowerCase() || 'default';
    if (allowedRoutes.length && !allowedRoutes.includes(routeKey)) return { skipped: true, reason: 'route_not_allowed' };
    if (conversation.status === 'closed' || conversation.assignment_status === 'closed') return { skipped: true, reason: 'closed' };
    const lastMessageAt = Date.parse(String(conversation.last_message_at || conversation.updated_at || ''));
    if (!ignoreQueueAge && Number.isFinite(lastMessageAt) && Date.now() - lastMessageAt > maxQueueAgeMinutes * 60_000) return { skipped: true, reason: 'conversation_too_old' };
    if (conversation.assigned_agent_id || !['queued', 'unassigned'].includes(conversation.assignment_status)) return { skipped: true, reason: 'already_assigned' };
    if (!conversation.queue_id) return { skipped: true, reason: 'queue_missing' };
    const activeSession = (await client.query(`SELECT 1 FROM chatbot_sessions WHERE tenant_id=$1 AND conversation_id=$2 AND status='active' LIMIT 1`, [tenantId, conversationId])).rows[0];
    if (activeSession) return { skipped: true, reason: 'chatbot_session_active' };
    const candidate = (await client.query(`
      SELECT m.user_id,m.user_name,
        (SELECT COUNT(*)::int FROM conversations c
          WHERE c.tenant_id=m.tenant_id AND c.assigned_agent_id=m.user_id
            AND c.assignment_status IN ('assigned','transferred') AND c.status<>'closed') AS active_count
      FROM queue_memberships m
      JOIN agent_presence p ON p.tenant_id=m.tenant_id AND p.user_id=m.user_id
      WHERE m.tenant_id=$1 AND m.queue_id=$2 AND m.is_active=true AND m.is_assignable=true
        AND (p.status='online' OR (p.status='paused' AND p.paused_until<=now()))
        AND p.last_seen_at >= now()-make_interval(secs=>$3::int)
      ORDER BY active_count ASC,m.last_assigned_at ASC NULLS FIRST,m.user_id ASC
      LIMIT 1
      FOR UPDATE OF m SKIP LOCKED
    `, [tenantId, conversation.queue_id, presenceTtlSeconds])).rows[0];
    if (!candidate) return { skipped: true, reason: 'no_available_agent' };
    const updated = (await client.query(`
      UPDATE conversations SET assigned_agent_id=$3,assigned_agent_name=$4,assigned_at=now(),
        assignment_status='assigned',last_assignment_at=now(),updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND assigned_agent_id IS NULL RETURNING *
    `, [tenantId, conversationId, candidate.user_id, candidate.user_name || candidate.user_id])).rows[0];
    if (!updated) return { skipped: true, reason: 'assignment_race_lost' };
    await client.query(`UPDATE queue_memberships SET last_assigned_at=now(),updated_at=now()
      WHERE tenant_id=$1 AND queue_id=$2 AND user_id=$3`, [tenantId, conversation.queue_id, candidate.user_id]);
    await client.query(`INSERT INTO conversation_assignment_events
      (tenant_id,conversation_id,event_type,from_queue_id,to_queue_id,to_agent_id,actor_user_id,reason,metadata_json)
      VALUES ($1,$2,'automatic_assignment',$3,$3,$4,'assignment-worker','balanced_available_agent',$5::jsonb)`,
    [tenantId, conversationId, conversation.queue_id, candidate.user_id, JSON.stringify({ activeCountBefore: candidate.active_count })]);
    return { skipped: false, conversation: updated, activeCountBefore: candidate.active_count };
  });
  if (!result.skipped) await publishAssignment({ conversation: result.conversation, type: 'agent_assigned', data: { action: 'automatic_assignment' } });
  return result;
};

export const assertConversationVisible = async ({ auth, conversationId }) => {
  const conversation = await getConversation(auth.tenantId, conversationId, getChatAccessFilter(auth));
  if (!conversation) throw error('Conversa nao encontrada.', 404);
  return conversation;
};
