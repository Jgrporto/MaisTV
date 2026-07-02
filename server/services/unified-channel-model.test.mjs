import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPhoneLookupKeys, normalizePhone, phonesMatch } from '../utils/phone-normalization.mjs';
import { classifyCustomerRows, STANDARD_LABELS } from './customer-profile.service.mjs';
import { resolveOutboundChannel } from './channel-routing.service.mjs';
import { buildInteractivePayload } from './interactive-message.service.mjs';
import { resolveConversationReplyRouteSelector } from '../../src/lib/conversation-channel.js';
import { decodeOutboundMediaInput } from './outbound-media.service.mjs';
import { buildStoredMediaMessagePayload } from './meta-outbound-media.service.mjs';

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

test('default inbound channel is preserved for free text inside the customer window', () => {
  assert.deepEqual(resolveOutboundChannel({
    conversation: {
      last_inbound_route_key: 'default',
      last_inbound_phone_number_id: '779406741922236',
      last_customer_message_at: '2026-07-01T12:00:00.000Z',
    },
    now: Date.parse('2026-07-02T11:59:59.000Z'),
  }), {
    allowed: true,
    deliveryKind: 'free_text',
    routeKey: 'default',
    phoneNumberId: '779406741922236',
    reason: 'last_inbound_channel',
  });
});

test('fallback 24h window closes after last customer message plus 24 hours', () => {
  const conversation = {
    last_customer_message_at: '2026-07-01T12:00:00.000Z',
    last_inbound_route_key: 'default',
  };
  assert.equal(resolveOutboundChannel({
    conversation,
    now: Date.parse('2026-07-02T12:00:00.000Z'),
  }).allowed, true);
  assert.equal(resolveOutboundChannel({
    conversation,
    now: Date.parse('2026-07-02T12:00:00.001Z'),
  }).reason, 'customer_window_closed');
});

test('panel interactive quick reply keeps buttons and footer for Meta', () => {
  assert.deepEqual(buildInteractivePayload({
    body: 'Escolha:',
    raw_json: { interactivePayload: {
      text: 'Escolha:', footer: 'Atendimento MaisTV', displayAs: 'buttons',
      options: [{ id: 'sales', title: 'Vendas' }, { id: 'support', title: 'Suporte' }],
    } },
  }), {
    type: 'interactive',
    interactive: {
      type: 'button', body: { text: 'Escolha:' }, footer: { text: 'Atendimento MaisTV' },
      action: { buttons: [
        { type: 'reply', reply: { id: 'sales', title: 'Vendas' } },
        { type: 'reply', reply: { id: 'support', title: 'Suporte' } },
      ] },
    },
  });
});

test('media reply uses the latest inbound channel from Postgres message fields', () => {
  assert.deepEqual(resolveConversationReplyRouteSelector({
    messages: [
      { sender_type: 'client', route_key: 'vendas', phone_number_id: '111' },
      { sender_type: 'agent', route_key: 'vendas', phone_number_id: '111' },
      { sender_type: 'client', route_key: 'vendas2', phone_number_id: '222' },
    ],
  }), {
    routeKey: 'vendas2',
    phoneNumberId: '222',
    displayPhoneNumber: null,
  });
});

test('media reply falls back to the persisted last inbound conversation channel', () => {
  assert.deepEqual(resolveConversationReplyRouteSelector({
    conversation: {
      last_inbound_route_key: 'vendas2',
      last_inbound_phone_number_id: '222',
      route_key: 'vendas',
      phone_number_id: '111',
    },
  }), {
    routeKey: 'vendas2',
    phoneNumberId: '222',
    displayPhoneNumber: null,
  });
});

test('persisted last inbound channel wins over a stale loaded message page', () => {
  assert.deepEqual(resolveConversationReplyRouteSelector({
    conversation: {
      last_inbound_route_key: 'vendas2',
      last_inbound_phone_number_id: '222',
    },
    messages: [
      { sender_type: 'client', route_key: 'vendas', phone_number_id: '111' },
    ],
  }), {
    routeKey: 'vendas2',
    phoneNumberId: '222',
    displayPhoneNumber: null,
  });
});

test('empty attendance state does not crash while no conversation is selected', () => {
  assert.equal(resolveConversationReplyRouteSelector({ conversation: null, messages: null }), null);
});

test('decodes outbound media for durable storage before enqueueing', () => {
  const media = decodeOutboundMediaInput({
    type: 'image',
    dataBase64: 'data:image/png;base64,aGVsbG8=',
    filename: 'teste.png',
    caption: 'Imagem persistida',
  });
  assert.equal(media.type, 'image');
  assert.equal(media.mimeType, 'image/png');
  assert.equal(media.filename, 'teste.png');
  assert.equal(media.caption, 'Imagem persistida');
  assert.equal(media.body.toString('utf8'), 'hello');
});

test('rejects unsupported outbound media types', () => {
  assert.throws(
    () => decodeOutboundMediaInput({ type: 'sticker', dataBase64: 'aGVsbG8=' }),
    /Tipo de midia invalido/,
  );
});

test('builds Meta payloads for all durable outbound media types', () => {
  assert.deepEqual(buildStoredMediaMessagePayload({
    conversation: { contact_phone: '5524999157259' },
    message: { type: 'image', client_message_id: 'client-1', raw_json: { caption: 'Foto' } },
    providerMediaId: 'meta-media-1',
  }), {
    messaging_product: 'whatsapp',
    to: '5524999157259',
    type: 'image',
    image: { id: 'meta-media-1', caption: 'Foto' },
    biz_opaque_callback_data: 'client-1',
  });
  assert.deepEqual(buildStoredMediaMessagePayload({
    conversation: { contact_phone: '5524999157259' },
    message: { type: 'document', client_message_id: 'client-2', raw_json: { filename: 'arquivo.pdf' } },
    providerMediaId: 'meta-media-2',
  }).document, { id: 'meta-media-2', filename: 'arquivo.pdf' });
  assert.deepEqual(buildStoredMediaMessagePayload({
    conversation: { contact_phone: '5524999157259' },
    message: { type: 'audio', client_message_id: 'client-3' },
    providerMediaId: 'meta-media-3',
  }).audio, { id: 'meta-media-3' });
  assert.deepEqual(buildStoredMediaMessagePayload({
    conversation: { contact_phone: '5524999157259' },
    message: { type: 'video', client_message_id: 'client-4', raw_json: { caption: 'Video' } },
    providerMediaId: 'meta-media-4',
  }).video, { id: 'meta-media-4', caption: 'Video' });
});
