import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPhoneLookupKeys, normalizePhone, phonesMatch } from '../utils/phone-normalization.mjs';
import { classifyCustomerRows, STANDARD_LABELS } from './customer-profile.service.mjs';
import { resolveOutboundChannel } from './channel-routing.service.mjs';

test('normalizes Brazilian phone variants to one identity', () => {
  assert.equal(normalizePhone('5524998210417'), '5524998210417');
  assert.equal(normalizePhone('24998210417'), '5524998210417');
  assert.equal(normalizePhone('998210417'), '5524998210417');
  assert.equal(phonesMatch('5524998210417', '998210417'), true);
  assert.ok(buildPhoneLookupKeys('5524998210417').includes('24998210417'));
});

test('confirmed customer wins over trial and respects classification priority', () => {
  const now = new Date('2026-07-01T12:00:00.000Z');
  const result = classifyCustomerRows([
    { id: 'trial-1', is_trial: true, status: 'EXPIRED' },
    { id: 'customer-1', is_trial: false, expires_at: '2026-06-20T00:00:00.000Z', created_at: '2025-01-01T00:00:00.000Z' },
  ], now);
  assert.equal(result.label, STANDARD_LABELS.CANCELLED);
  assert.equal(result.confirmed.id, 'customer-1');
});

test('classifies post-sale, customer, SQL and lead profiles', () => {
  const now = new Date('2026-07-01T12:00:00.000Z');
  assert.equal(classifyCustomerRows([{ is_trial: false, created_at: '2026-06-15', expires_at: '2026-08-01' }], now).label, STANDARD_LABELS.POST_SALE);
  assert.equal(classifyCustomerRows([{ is_trial: false, created_at: '2025-01-01', expires_at: '2026-08-01' }], now).label, STANDARD_LABELS.CUSTOMER);
  assert.equal(classifyCustomerRows([{ is_trial: false, created_at: '2026-06-15', expires_at: '2026-07-01T06:00:00.000Z' }], now).label, STANDARD_LABELS.CUSTOMER);
  assert.equal(classifyCustomerRows([{ is_trial: true, status: 'EXPIRED' }], now).label, STANDARD_LABELS.SQL);
  assert.equal(classifyCustomerRows([], now).label, STANDARD_LABELS.LEAD);
});

test('free text uses last inbound channel while the customer window is open', () => {
  const channel = resolveOutboundChannel({
    conversation: {
      last_inbound_route_key: 'vendas2',
      last_inbound_phone_number_id: '222',
      last_24h_window_expires_at: '2026-07-02T12:00:00.000Z',
    },
    now: Date.parse('2026-07-01T12:00:00.000Z'),
  });
  assert.deepEqual(channel, {
    allowed: true, deliveryKind: 'free_text', routeKey: 'vendas2', phoneNumberId: '222', reason: 'last_inbound_channel',
  });
});

test('closed window blocks free text and templates always use default', () => {
  const conversation = {
    last_inbound_route_key: 'vendas',
    last_24h_window_expires_at: '2026-06-30T12:00:00.000Z',
  };
  assert.equal(resolveOutboundChannel({ conversation, now: Date.parse('2026-07-01T12:00:00.000Z') }).reason, 'customer_window_closed');
  assert.deepEqual(resolveOutboundChannel({ conversation, deliveryKind: 'template' }), {
    allowed: true, deliveryKind: 'template', routeKey: 'default', phoneNumberId: '', reason: 'template_uses_default',
  });
});
