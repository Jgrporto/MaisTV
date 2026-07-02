import {
  assignConversation,
  getAttendingUsers,
  getPresenceStatus,
  pausePresence,
  resumePresence,
  startPresence,
  stopPresence,
  transferConversation,
  unassignConversation,
} from '../services/assignment.service.mjs';
import { getConversationAssignmentHistory } from '../repositories/assignment.repository.mjs';
import { assertConversationVisible } from '../services/assignment.service.mjs';

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export const createAssignmentRouter = async ({ authMiddleware } = {}) => {
  const { default: express } = await import('express');
  const router = express.Router();
  if (authMiddleware) router.use(authMiddleware);
  const parseJson = express.json({ limit: '32kb' });

  router.post('/conversations/:conversationId/assign', parseJson, asyncRoute(async (req, res) => {
    const conversation = await assignConversation({
      auth: req.chatAuth,
      conversationId: req.params.conversationId,
      targetUserId: req.body?.userId || req.chatAuth.userId,
      reason: req.body?.reason || 'manual_assignment',
    });
    res.json({ ok: true, conversationId: conversation.id, conversation });
  }));
  router.post('/conversations/:conversationId/unassign', parseJson, asyncRoute(async (req, res) => {
    const conversation = await unassignConversation({ auth: req.chatAuth, conversationId: req.params.conversationId, targetQueueId: req.body?.queueId || req.body?.serviceId, reason: req.body?.reason || 'manual_unassign' });
    res.json({ ok: true, conversationId: conversation.id, conversation });
  }));
  router.post('/conversations/:conversationId/transfer', parseJson, asyncRoute(async (req, res) => {
    const conversation = await transferConversation({
      auth: req.chatAuth,
      conversationId: req.params.conversationId,
      targetUserId: req.body?.userId,
      targetQueueId: req.body?.queueId || req.body?.serviceId,
      reason: req.body?.reason || 'manual_transfer',
    });
    res.json({ ok: true, conversationId: conversation.id, conversation });
  }));
  router.get('/conversations/:conversationId/assignment-history', asyncRoute(async (req, res) => {
    await assertConversationVisible({ auth: req.chatAuth, conversationId: req.params.conversationId });
    res.json({ items: await getConversationAssignmentHistory({ tenantId: req.chatAuth.tenantId, conversationId: req.params.conversationId }) });
  }));

  router.post('/presence/start', parseJson, asyncRoute(async (req, res) => res.json(await startPresence({ auth: req.chatAuth }))));
  router.post('/presence/stop', parseJson, asyncRoute(async (req, res) => res.json(await stopPresence({
    auth: req.chatAuth,
    recoverAssignments: req.body?.recoverAssignments !== false,
    reason: req.body?.reason,
  }))));
  router.post('/presence/pause-distribution', parseJson, asyncRoute(async (req, res) => res.json(await pausePresence({ auth: req.chatAuth, reason: req.body?.reason, durationMinutes: req.body?.durationMinutes }))));
  router.post('/presence/resume-distribution', parseJson, asyncRoute(async (req, res) => res.json(await resumePresence({ auth: req.chatAuth }))));
  router.get('/presence/status', asyncRoute(async (req, res) => res.json(await getPresenceStatus({ auth: req.chatAuth }))));
  router.get('/presence/attending-users', asyncRoute(async (req, res) => res.json(await getAttendingUsers({ auth: req.chatAuth }))));

  return router;
};
