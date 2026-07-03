import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { handleCustomerReadRoutes } from './customers.routes.mjs';
import { handleConversationPreferenceReadRoutes } from './conversation-preferences.routes.mjs';

const createResponse = () => ({
  statusCode: 0,
  payload: null,
  headers: {},
});

const sendJson = (res, statusCode, payload, headers = {}) => {
  res.statusCode = statusCode;
  res.payload = payload;
  res.headers = headers;
};

const sendJsonText = (res, statusCode, json, headers = {}) => {
  res.statusCode = statusCode;
  res.payload = JSON.parse(json);
  res.headers = headers;
};

test('customers defaults to 50 rows, caps at 200, and never includes raw in list responses', async () => {
  const customers = Array.from({ length: 240 }, (_, index) => ({
    id: `customer-${index}`,
    username: `user-${index}`,
    phone_digits: `5524999${String(index).padStart(6, '0')}`,
    raw: { large: 'x'.repeat(1000), password: index === 0 ? 'credential-0' : '' },
  }));
  const deps = {
    readStore: async () => ({ customers, customerSync: {} }),
    getPublicCustomerSyncState: () => ({}),
    sendJson,
    sendJsonText,
  };

  const defaultResponse = createResponse();
  await handleCustomerReadRoutes(
    { method: 'GET' },
    defaultResponse,
    new URL('http://local/api/local/customers'),
    deps,
  );
  assert.equal(defaultResponse.payload.rows.length, 50);
  assert.equal(defaultResponse.payload.limit, 50);
  assert.equal(defaultResponse.payload.hasMore, true);
  assert.equal('raw' in defaultResponse.payload.rows[0], false);

  const cappedResponse = createResponse();
  await handleCustomerReadRoutes(
    { method: 'GET' },
    cappedResponse,
    new URL('http://local/api/local/customers?page=1&limit=999'),
    deps,
  );
  assert.equal(cappedResponse.payload.rows.length, 200);
  assert.equal(cappedResponse.payload.limit, 200);

  const detailResponse = createResponse();
  await handleCustomerReadRoutes(
    { method: 'GET' },
    detailResponse,
    new URL('http://local/api/local/customers/customer-0'),
    deps,
  );
  assert.equal(detailResponse.statusCode, 200);
  assert.equal('raw' in detailResponse.payload, false);
  assert.equal(detailResponse.payload.password, 'credential-0');
});

test('conversation preferences only returns requested visible conversation ids', async () => {
  const response = createResponse();
  await handleConversationPreferenceReadRoutes(
    { method: 'GET' },
    response,
    new URL('http://local/api/local/conversation-preferences?ids=conversation-1,conversation-3'),
    {
      readStore: async () => ({
        conversationPreferences: [
          { id: 'conversation-1', is_pinned: true },
          { id: 'conversation-2', is_pinned: true },
          { conversation_id: 'conversation-3', manual_unread: true },
        ],
      }),
      sendJson,
    },
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.map((item) => item.id || item.conversation_id), ['conversation-1', 'conversation-3']);
});

test('conversation preferences rejects unbounded and oversized reads', async () => {
  const deps = { readStore: async () => ({ conversationPreferences: [] }), sendJson };
  const missingIdsResponse = createResponse();
  await handleConversationPreferenceReadRoutes(
    { method: 'GET' },
    missingIdsResponse,
    new URL('http://local/api/local/conversation-preferences'),
    deps,
  );
  assert.equal(missingIdsResponse.statusCode, 400);
  assert.equal(missingIdsResponse.payload.error, 'conversation_ids_required');

  const oversizedResponse = createResponse();
  const ids = Array.from({ length: 101 }, (_, index) => `conversation-${index}`).join(',');
  await handleConversationPreferenceReadRoutes(
    { method: 'GET' },
    oversizedResponse,
    new URL(`http://local/api/local/conversation-preferences?ids=${ids}`),
    deps,
  );
  assert.equal(oversizedResponse.statusCode, 400);
  assert.equal(oversizedResponse.payload.error, 'too_many_conversation_ids');
  assert.equal(oversizedResponse.payload.max, 100);
});

test('quick reply collections have bounded defaults and lightweight schedule projections', async () => {
  const localApi = await fs.readFile(new URL('../local-api.mjs', import.meta.url), 'utf8');
  assert.match(localApi, /QuickReply:\s*50/);
  assert.match(localApi, /QuickReplySchedule:\s*50/);
  assert.match(localApi, /QuickReplySchedule:\s*100/);
  const scheduleProjection = localApi.match(/if \(entityName === 'QuickReplySchedule'\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.doesNotMatch(scheduleProjection, /quickReplySnapshot|conversationSnapshot|hsmVariables|hsmMedia/);
});

test('attendance hot path has no full customer or legacy conversation fetch', async () => {
  const [attendance, notificationBridge] = await Promise.all([
    fs.readFile(new URL('../../src/pages/Attendance.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../src/components/layout/SiteNotificationBridge.jsx', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(attendance, /fetchAllPersistedCustomers|fetchPersistedCustomers/);
  assert.doesNotMatch(notificationBridge, /fetchAllPersistedCustomers|fetchPersistedCustomers|fetchWhatsappConversations/);
  assert.match(notificationBridge, /useConversations/);
  const preferenceClient = await fs.readFile(new URL('../../src/lib/conversation-preferences.js', import.meta.url), 'utf8');
  assert.match(preferenceClient, /index \+= 100/);
});
