import { requestLocalApiJson } from '@/lib/local-api';

const normalizePhoneDigits = (value = '') => String(value || '').replace(/\D/g, '');

export const fetchCheckoutRenewalCustomerStatus = async (phone) => {
  const normalizedPhone = normalizePhoneDigits(phone);
  if (!normalizedPhone) {
    return { hasAlert: false, status: null, message: '', paymentId: null, updatedAt: null };
  }
  const params = new URLSearchParams({ phone: normalizedPhone });
  return requestLocalApiJson(
    `/checkout/renewals/customer-status?${params.toString()}`,
    { method: 'GET' },
    'Nao foi possivel consultar o status da renovacao.',
  );
};
