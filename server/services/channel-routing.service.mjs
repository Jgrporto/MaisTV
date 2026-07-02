const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;
const text = (value) => String(value || '').trim();

export const resolveWindowExpiresAt = (conversation = {}) => {
  const persisted = conversation.last_24h_window_expires_at || conversation.windowExpiresAt;
  const persistedMs = Date.parse(String(persisted || ''));
  if (Number.isFinite(persistedMs)) return new Date(persistedMs).toISOString();
  const lastCustomerMs = Date.parse(String(conversation.last_customer_message_at || conversation.last_received_at || ''));
  return Number.isFinite(lastCustomerMs) ? new Date(lastCustomerMs + CUSTOMER_WINDOW_MS).toISOString() : null;
};

export const isCustomerWindowOpen = (conversation = {}, now = Date.now()) => {
  const expiresAtMs = Date.parse(String(resolveWindowExpiresAt(conversation) || ''));
  return Number.isFinite(expiresAtMs) && now <= expiresAtMs;
};

export const resolveOutboundChannel = ({ conversation = {}, deliveryKind = 'free_text', now = Date.now() } = {}) => {
  const kind = text(deliveryKind).toLowerCase() || 'free_text';
  if (['hsm', 'template'].includes(kind)) {
    return { allowed: true, deliveryKind: 'template', routeKey: 'default', phoneNumberId: '', reason: 'template_uses_default' };
  }
  if (!isCustomerWindowOpen(conversation, now)) {
    return { allowed: false, deliveryKind: 'free_text', routeKey: '', phoneNumberId: '', reason: 'customer_window_closed' };
  }
  return {
    allowed: true,
    deliveryKind: 'free_text',
    routeKey: text(conversation.last_inbound_route_key || conversation.route_key) || 'default',
    phoneNumberId: text(conversation.last_inbound_phone_number_id || conversation.phone_number_id),
    reason: 'last_inbound_channel',
  };
};

