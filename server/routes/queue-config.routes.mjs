import { listQueues, removeQueue, saveQueue } from '../services/queue-config.service.mjs';
import { overrideStandardLabel } from '../services/customer-profile.service.mjs';

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const isAdmin = (auth = {}) => (auth.roles || []).some((role) => ['admin', 'administrador'].includes(String(role).toLowerCase()));
const requireAdmin = (req, _res, next) => isAdmin(req.chatAuth) ? next() : next(Object.assign(new Error('Acesso administrativo obrigatorio.'), { statusCode: 403 }));

export const createQueueConfigRouter = async ({ authMiddleware } = {}) => {
  const { default: express } = await import('express');
  const router = express.Router();
  if (authMiddleware) router.use(authMiddleware);
  const parseJson = express.json({ limit: '64kb' });
  router.get('/queues', asyncRoute(async (req, res) => res.json(await listQueues({ auth: req.chatAuth }))));
  router.post('/queues', parseJson, requireAdmin, asyncRoute(async (req, res) => res.status(201).json(await saveQueue({ auth: req.chatAuth, input: req.body }))));
  router.put('/queues/:queueId', parseJson, requireAdmin, asyncRoute(async (req, res) => res.json(await saveQueue({ auth: req.chatAuth, queueId: req.params.queueId, input: req.body }))));
  router.delete('/queues/:queueId', requireAdmin, asyncRoute(async (req, res) => res.json(await removeQueue({ auth: req.chatAuth, queueId: req.params.queueId }))));
  router.put('/customer-profiles/:phone/standard-label', parseJson, requireAdmin, asyncRoute(async (req, res) => {
    const result = await overrideStandardLabel({
      tenantId: req.chatAuth.tenantId,
      phone: req.params.phone,
      label: req.body?.standardLabel || req.body?.standard_label,
      actorUserId: req.chatAuth.userId,
    });
    res.json({ ok: true, ...result });
  }));
  return router;
};
