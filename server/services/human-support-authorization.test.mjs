import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEffectiveUser } from '../../src/lib/current-user.js';
import { isAdminLikeUser } from '../../src/lib/navigation-permissions.js';
import { canAccessConversation, getChatAccessFilter, isPrivilegedChatUser } from './chat-authorization.service.mjs';

test('authenticated users do not inherit the local admin fallback', () => {
  const user = resolveEffectiveUser({
    id: 'teste-system',
    email: 'teste@system',
    full_name: 'Teste System',
  });

  assert.equal(user.role || '', '');
  assert.equal(user.role_name || '', '');
  assert.equal(isAdminLikeUser(user), false);
});

test('chat admin detection only accepts explicit admin markers', () => {
  assert.equal(isPrivilegedChatUser({ roles: ['Suporte'], raw: { role_id: 'role-admin' } }), false);
  assert.equal(isPrivilegedChatUser({ roles: [], raw: { role: 'admin' } }), true);
  assert.equal(isPrivilegedChatUser({ roles: [], raw: { role_name: 'Administrador' } }), true);
  assert.equal(isPrivilegedChatUser({ roles: [], raw: { role_id: 'admin' } }), true);
});

test('non-admin attendant can access conversations by assigned agent, queue or service', () => {
  const auth = {
    userId: 'agent-1',
    queueIds: ['queue-default'],
    serviceIds: ['service-support'],
    roles: ['Atendente'],
  };
  const access = getChatAccessFilter(auth);
  assert.deepEqual(access.queueOrServiceIds, ['queue-default', 'service-support']);

  assert.equal(canAccessConversation(auth, { assigned_agent_id: 'agent-1' }), true);
  assert.equal(canAccessConversation(auth, { queue_id: 'queue-default' }), true);
  assert.equal(canAccessConversation(auth, { service_id: 'service-support' }), true);
  assert.equal(canAccessConversation(auth, { queue_id: 'queue-sales', service_id: 'service-sales' }), false);
});
