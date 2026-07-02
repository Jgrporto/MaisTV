import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCustomerPhoneLookupKeys,
  clearCustomerSummaryCache,
  enrichConversationsWithCustomerSummaries,
  shapeCustomerListItem,
} from './customer-summary.service.mjs';

test('customer summaries resolve a page in one indexed pass without raw fields', () => {
  clearCustomerSummaryCache();
  const store = {
    customers: [{
      id: 'customer-1',
      display_name: 'Cliente Um',
      username: 'cliente1',
      phone_digits: '24999157259',
      whatsapp: '24999157259',
      status: 'ACTIVE',
      status_label: 'Ativo',
      package: 'Plano HD',
      connections: 2,
      expires_at: '2026-07-31T00:00:00.000Z',
      raw: { secret: 'must-not-leak' },
    }],
  };
  const [conversation] = enrichConversationsWithCustomerSummaries([
    { id: 'conversation-1', contact_phone: '5524999157259' },
  ], store);

  assert.equal(conversation.customer_summary.id, 'customer-1');
  assert.equal(conversation.customer_summary.phoneDigits, '24999157259');
  assert.equal(conversation.customer_summary.planName, 'Plano HD');
  assert.equal(conversation.customer_summary.existsInBase, true);
  assert.equal('raw' in conversation.customer_summary, false);
  assert.equal('raw' in shapeCustomerListItem(store.customers[0]), false);
});

test('customer id wins and Brazilian phone alternatives include country and local forms', () => {
  clearCustomerSummaryCache();
  const store = {
    customers: [
      { id: 'by-id', phone_digits: '21999999999', display_name: 'Por ID' },
      { id: 'by-phone', phone_digits: '24999157259', display_name: 'Por telefone' },
    ],
  };
  const [conversation] = enrichConversationsWithCustomerSummaries([
    { customer_id: 'by-id', contact_phone: '5524999157259' },
  ], store);
  assert.equal(conversation.customer_summary.id, 'by-id');
  assert.deepEqual(new Set(buildCustomerPhoneLookupKeys('55 24 99915-7259')), new Set([
    '5524999157259', '24999157259', '2499157259', '552499157259',
  ]));
});

test('confirmed customer with the latest expiry wins for duplicate phone records', () => {
  clearCustomerSummaryCache();
  const [conversation] = enrichConversationsWithCustomerSummaries([
    { contact_phone: '5524999157259' },
  ], {
    customers: [
      { id: 'old', phone_digits: '24999157259', expires_at: '2026-07-01', is_trial: false },
      { id: 'trial', phone_digits: '24999157259', expires_at: '2027-01-01', is_trial: true },
      { id: 'current', phone_digits: '24999157259', expires_at: '2026-12-01', is_trial: false },
    ],
  });
  assert.equal(conversation.customer_summary.id, 'current');
});
