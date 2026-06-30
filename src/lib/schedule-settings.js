import { requestLocalApi } from './local-api';

export const DEFAULT_SCHEDULE_SETTINGS = {
  hsmTemplateId: '',
  hsmTemplateName: '',
  hsmLanguage: 'pt_BR',
  hsmVariables: { body: {}, header: {}, buttons: {} },
  hsmMedia: {},
};

export const normalizeScheduleSettings = (value = {}) => ({
  ...DEFAULT_SCHEDULE_SETTINGS,
  ...(value && typeof value === 'object' ? value : {}),
  hsmTemplateId: String(value?.hsmTemplateId || '').trim(),
  hsmTemplateName: String(value?.hsmTemplateName || '').trim(),
  hsmLanguage: String(value?.hsmLanguage || 'pt_BR').trim() || 'pt_BR',
  hsmVariables:
    value?.hsmVariables && typeof value.hsmVariables === 'object'
      ? value.hsmVariables
      : { body: {}, header: {}, buttons: {} },
  hsmMedia: value?.hsmMedia && typeof value.hsmMedia === 'object' ? value.hsmMedia : {},
});

const requestScheduleSettingsJson = async (path = '', options = {}) => {
  const response = await requestLocalApi(`/settings/schedules${path}`, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || 'Falha ao salvar configuracoes de agendamento.');
  }
  return normalizeScheduleSettings(data);
};

export const fetchScheduleSettings = async () => {
  return await requestScheduleSettingsJson('', { method: 'GET' });
};

export const saveScheduleSettings = async (value) => {
  return await requestScheduleSettingsJson('', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizeScheduleSettings(value)),
  });
};
