import { requestLocalApiJson } from '@/lib/local-api';

export const DEFAULT_DASHBOARD_SETTINGS = {
  adKeywords: [],
  appointmentAttributionWindowDays: 7,
  newCustomerWindowDays: 30,
  templateResponseWindowDays: 3,
  templateRecoveryWindowDays: 30,
  salesGoalsByUserId: {},
  updatedAt: null,
};

const normalizeStringList = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );

const normalizePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const normalizeDashboardSettings = (value) => ({
  ...DEFAULT_DASHBOARD_SETTINGS,
  ...(value && typeof value === 'object' ? value : {}),
  adKeywords: normalizeStringList(value?.adKeywords),
  appointmentAttributionWindowDays: normalizePositiveInteger(
    value?.appointmentAttributionWindowDays,
    DEFAULT_DASHBOARD_SETTINGS.appointmentAttributionWindowDays,
  ),
  newCustomerWindowDays: normalizePositiveInteger(value?.newCustomerWindowDays, DEFAULT_DASHBOARD_SETTINGS.newCustomerWindowDays),
  templateResponseWindowDays: normalizePositiveInteger(
    value?.templateResponseWindowDays,
    DEFAULT_DASHBOARD_SETTINGS.templateResponseWindowDays,
  ),
  templateRecoveryWindowDays: normalizePositiveInteger(
    value?.templateRecoveryWindowDays,
    DEFAULT_DASHBOARD_SETTINGS.templateRecoveryWindowDays,
  ),
  salesGoalsByUserId: Object.fromEntries(
    Object.entries(value?.salesGoalsByUserId && typeof value.salesGoalsByUserId === 'object' ? value.salesGoalsByUserId : {})
      .map(([key, goal]) => {
        const parsed = Number.parseInt(String(goal ?? ''), 10);
        return [String(key || '').trim(), Number.isFinite(parsed) && parsed > 0 ? parsed : 0];
      })
      .filter(([key]) => key),
  ),
  updatedAt: value?.updatedAt ? String(value.updatedAt) : null,
});

export const fetchDashboardSettings = async () =>
  normalizeDashboardSettings(await requestLocalApiJson('/settings/dashboard', { method: 'GET' }));

export const saveDashboardSettings = async (value) =>
  normalizeDashboardSettings(await requestLocalApiJson('/settings/dashboard', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizeDashboardSettings(value)),
  }));
