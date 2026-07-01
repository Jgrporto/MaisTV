const clean = (value) => String(value || '').trim();
const envForPhone = (prefix, phoneNumberId) => process.env[`${prefix}_${clean(phoneNumberId).replace(/\D/g, '')}`];

const configuredRoutes = () => [
  {
    routeKey: 'default',
    phoneNumberId: clean(process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID),
    displayPhoneNumber: clean(process.env.WHATSAPP_DISPLAY_PHONE_NUMBER),
    accessToken: clean(process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN),
    appSecret: clean(process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET),
  },
  {
    routeKey: 'vendas',
    phoneNumberId: clean(process.env.WHATSAPP_VENDAS_PHONE_NUMBER_ID),
    displayPhoneNumber: clean(process.env.WHATSAPP_VENDAS_DISPLAY_PHONE_NUMBER),
    accessToken: clean(process.env.WHATSAPP_VENDAS_ACCESS_TOKEN),
    appSecret: clean(process.env.WHATSAPP_VENDAS_APP_SECRET),
  },
  {
    routeKey: 'vendas2',
    phoneNumberId: clean(process.env.WHATSAPP_VENDAS2_PHONE_NUMBER_ID),
    displayPhoneNumber: clean(process.env.WHATSAPP_VENDAS2_DISPLAY_PHONE_NUMBER),
    accessToken: clean(process.env.WHATSAPP_VENDAS2_ACCESS_TOKEN),
    appSecret: clean(process.env.WHATSAPP_VENDAS2_APP_SECRET),
  },
].filter((route) => route.phoneNumberId);

export const resolveMetaConfig = ({ phoneNumberId = '', routeKey = '' } = {}) => {
  const normalizedPhoneId = clean(phoneNumberId);
  const normalizedRouteKey = clean(routeKey).toLowerCase();
  const routes = configuredRoutes();
  const matched = routes.find((route) => normalizedPhoneId && route.phoneNumberId === normalizedPhoneId)
    || routes.find((route) => normalizedRouteKey && route.routeKey === normalizedRouteKey)
    || routes.find((route) => route.routeKey === 'default')
    || {};
  const selectedPhoneId = normalizedPhoneId || matched.phoneNumberId || '';
  return {
    routeKey: normalizedRouteKey || matched.routeKey || 'default',
    phoneNumberId: selectedPhoneId,
    displayPhoneNumber: matched.displayPhoneNumber || '',
    accessToken: clean(envForPhone('META_ACCESS_TOKEN', selectedPhoneId) || matched.accessToken),
    appSecret: clean(envForPhone('META_APP_SECRET', selectedPhoneId) || matched.appSecret),
  };
};

export const buildMetaRouteSelector = ({ phoneNumberId = '', displayPhoneNumber = '', routeKey = '' } = {}) => {
  const config = resolveMetaConfig({ phoneNumberId, routeKey });
  if (!config.phoneNumberId && !routeKey) return null;
  return {
    phoneNumberId: config.phoneNumberId || clean(phoneNumberId) || null,
    displayPhoneNumber: clean(displayPhoneNumber) || config.displayPhoneNumber || null,
    routeKey: config.routeKey || clean(routeKey).toLowerCase() || null,
  };
};
