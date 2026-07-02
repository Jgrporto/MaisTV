import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createAssignmentRouter } from './assignment.routes.mjs';
import { createQueueConfigRouter } from './queue-config.routes.mjs';

test('unrelated assignment and queue parsers do not reject a media payload', async () => {
  const app = express();
  const authMiddleware = (req, _res, next) => {
    req.chatAuth = { tenantId: 'maistv', userId: 'test', roles: ['admin'], queueIds: [] };
    next();
  };
  app.use('/api', await createAssignmentRouter({ authMiddleware }));
  app.use('/api', await createQueueConfigRouter({ authMiddleware }));
  app.post('/api/media/send', express.json({ limit: '1mb' }), (req, res) => res.json({ size: req.body.dataBase64.length }));

  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    const dataBase64 = 'A'.repeat(200_000);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/media/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataBase64 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { size: dataBase64.length });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
