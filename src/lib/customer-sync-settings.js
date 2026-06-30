import { parseJsonResponse, requestLocalApi } from '@/lib/local-api';

export const DEFAULT_CUSTOMER_SYNC_SETTINGS = {
  autoSyncIntervalMinutes: 60,
  nextScheduledAt: null,
  updatedAt: null,
};

export const CUSTOMER_SYNC_INTERVAL_OPTIONS = [
  { value: 30, label: '30 minutos' },
  { value: 60, label: '1 hora' },
  { value: 120, label: '2 horas' },
  { value: 240, label: '4 horas' },
  { value: 360, label: '6 horas' },
  { value: 720, label: '12 horas' },
  { value: 1440, label: '24 horas' },
];

const normalizeCustomerSyncSettings = (value) => {
  const interval = Number.parseInt(String(value?.autoSyncIntervalMinutes ?? ''), 10);

  return {
    ...DEFAULT_CUSTOMER_SYNC_SETTINGS,
    ...(value && typeof value === 'object' ? value : {}),
    autoSyncIntervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_CUSTOMER_SYNC_SETTINGS.autoSyncIntervalMinutes,
    nextScheduledAt: value?.nextScheduledAt ? String(value.nextScheduledAt) : null,
    updatedAt: value?.updatedAt ? String(value.updatedAt) : null,
  };
};

const requestCustomerSyncSettingsJson = async (path = '', options = {}) => {
  const response = await requestLocalApi(`/settings/customer-sync${path}`, options);
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Falha ao salvar configuracoes da sincronizacao automatica.');
  }

  return normalizeCustomerSyncSettings(data);
};

export const fetchCustomerSyncSettings = async () => {
  return await requestCustomerSyncSettingsJson('', { method: 'GET' });
};

export const saveCustomerSyncSettings = async (value) => {
  const normalized = normalizeCustomerSyncSettings(value);
  return await requestCustomerSyncSettingsJson('', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      autoSyncIntervalMinutes: normalized.autoSyncIntervalMinutes,
    }),
  });
};

export const readCustomerSyncSettings = (value) => normalizeCustomerSyncSettings(value);

export const formatCustomerSyncIntervalLabel = (minutes) =>
  CUSTOMER_SYNC_INTERVAL_OPTIONS.find((option) => option.value === Number(minutes))?.label || `${minutes} minutos`;
