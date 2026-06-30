import { requestLocalApiJson } from '@/lib/local-api';

const normalizePhoneDigits = (value = '') => String(value || '').replace(/\D/g, '');

const normalizePhoneDisplay = (value = '') => {
  const digits = normalizePhoneDigits(value);
  return digits ? `+${digits}` : '';
};

const buildNewbrTestPayload = ({
  appName = 'Teste Completo 4 horas',
  customerName = '',
  customerPhone = '',
  devicePhone = '',
} = {}) => ({
  appName,
  messageDateTime: Math.floor(Date.now() / 1000),
  devicePhone: normalizePhoneDisplay(devicePhone || customerPhone),
  deviceName: 'MaisTV Device',
  senderMessage: 'Gerado com SaasTV',
  senderPhone: normalizePhoneDisplay(customerPhone),
  customerWhatsapp: normalizePhoneDisplay(customerPhone),
  senderName: String(customerName || '').trim(),
  customerName: String(customerName || '').trim(),
  userAgent: '+TV',
});

export const createNewbrTest = async (payload = {}) => {
  const requestPayload = buildNewbrTestPayload({
    appName: payload.appName || 'Teste Completo 4 horas',
    customerName: payload.customerName || '',
    customerPhone: payload.customerPhone || payload.phone || payload.whatsapp || '',
    devicePhone: payload.devicePhone || '',
  });

  return await requestLocalApiJson(
    '/newbr/tests',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        requestPayload,
      }),
      timeoutMs: 45000,
    },
    'Nao foi possivel criar o teste NewBR pelo servidor.',
  );
};

export const fetchActiveNewbrTest = async ({ conversationId = '', phone = '' } = {}) => {
  const params = new URLSearchParams();
  if (conversationId) params.set('conversationId', conversationId);
  if (phone) params.set('phone', phone);
  return requestLocalApiJson(`/newbr/tests/active?${params.toString()}`, {}, 'Nao foi possivel consultar o teste ativo.');
};
