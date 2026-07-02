import assert from 'node:assert/strict';
import test from 'node:test';

import { syncQueueMemberships } from './assignment.repository.mjs';

test('syncQueueMemberships only persists queues already configured for the tenant', async () => {
  const calls = [];
  const executor = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('SELECT id FROM support_queues')) return { rows: [{ id: 'queue-sales' }] };
      return { rows: [] };
    },
  };

  const queueIds = await syncQueueMemberships({
    tenantId: 'maistv',
    userId: 'real-user',
    userName: 'Real User',
    queueIds: ['service-sales', 'unknown-service'],
  }, executor);

  assert.deepEqual(queueIds, ['queue-sales']);
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO support_queues')), false);
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO queue_memberships')).length, 1);
  assert.deepEqual(calls.find(({ sql }) => sql.includes('UPDATE queue_memberships')).values[2], ['queue-sales']);
});

test('syncQueueMemberships deactivates stale memberships when auth has no configured queues', async () => {
  const calls = [];
  const executor = { async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; } };

  const queueIds = await syncQueueMemberships({
    tenantId: 'maistv', userId: 'real-user', queueIds: [],
  }, executor);

  assert.deepEqual(queueIds, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE queue_memberships/);
  assert.deepEqual(calls[0].values[2], []);
});
