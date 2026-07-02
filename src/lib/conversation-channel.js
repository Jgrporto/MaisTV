const text = (value) => String(value || '').trim();

export const normalizeRouteSelector = (selector = null) => {
  if (!selector || typeof selector !== 'object') return null;
  const phoneNumberId = text(selector.phoneNumberId || selector.phone_number_id);
  const displayPhoneNumber = text(selector.displayPhoneNumber || selector.display_phone_number);
  const routeKey = text(selector.routeKey || selector.route_key || selector.meta_route_key).toLowerCase();
  if (!phoneNumberId && !displayPhoneNumber && !routeKey) return null;
  return {
    phoneNumberId: phoneNumberId || null,
    displayPhoneNumber: displayPhoneNumber || null,
    routeKey: routeKey || null,
  };
};

const messageSelector = (message = {}) => normalizeRouteSelector({
    ...{
    phoneNumberId: message.phone_number_id || message.phoneNumberId,
    displayPhoneNumber: message.display_phone_number || message.displayPhoneNumber,
    routeKey: message.route_key || message.routeKey || message.meta_route_key,
  },
    ...(message.route_selector && typeof message.route_selector === 'object' ? message.route_selector : {}),
  });

export const resolveConversationReplyRouteSelector = ({ conversation = {}, messages = [] } = {}) => {
  const persistedLastInbound = normalizeRouteSelector({
    phoneNumberId: conversation.last_inbound_phone_number_id || conversation.lastInboundPhoneNumberId,
    routeKey: conversation.last_inbound_route_key || conversation.lastInboundRouteKey,
  });
  if (persistedLastInbound) return persistedLastInbound;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] || {};
    const senderType = text(message.sender_type || message.senderType).toLowerCase();
    const direction = text(message.direction).toLowerCase();
    if (senderType !== 'client' && direction !== 'inbound') continue;
    const selector = messageSelector(message);
    if (selector) return selector;
  }

  return normalizeRouteSelector({
    phoneNumberId:
      conversation.phone_number_id ||
      conversation.phoneNumberId,
    displayPhoneNumber: conversation.display_phone_number || conversation.displayPhoneNumber,
    routeKey:
      conversation.route_key ||
      conversation.routeKey ||
      conversation.meta_route_key,
  }) || normalizeRouteSelector(conversation.active_route_selector)
    || normalizeRouteSelector(conversation.default_route_selector);
};
