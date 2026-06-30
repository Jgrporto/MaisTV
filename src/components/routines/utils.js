export const normalizeText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

export const getTemplateName = (template = {}) => String(template.name || template.identifier || template.templateName || '').trim();

export const getTemplateLanguage = (template = {}) => String(template.language || 'pt_BR').trim() || 'pt_BR';

export const getTemplateBody = (template = {}) => String(template.content || template.body || '').trim();

export const getTemplateButtons = (template = {}) => {
  if (Array.isArray(template.buttons) && template.buttons.length) return template.buttons;
  if (Array.isArray(template.buttonConfig) && template.buttonConfig.length) {
    return template.buttonConfig.map((button, index) => ({
      id: button.id || `button-${index}`,
      type: button.type || button.buttonType || 'quick_reply',
      label: button.label || button.text || '',
      url: button.url || '',
      phoneNumber: button.phoneNumber || button.phone_number || '',
      offerCode: button.offerCode || button.offer_code || '',
      flowId: button.flowId || '',
    }));
  }
  const buttonComponent = Array.isArray(template.components)
    ? template.components.find((component) => String(component?.type || '').toUpperCase() === 'BUTTONS')
    : null;
  if (Array.isArray(buttonComponent?.buttons) && buttonComponent.buttons.length) {
    return buttonComponent.buttons.map((button, index) => ({
      id: button.id || `button-${index}`,
      type: button.type || button.buttonType || 'quick_reply',
      label: button.label || button.text || '',
      url: button.url || '',
      phoneNumber: button.phoneNumber || button.phone_number || '',
      offerCode: button.offerCode || button.offer_code || '',
      flowId: button.flowId || '',
    }));
  }
  return [];
};

export const ROUTINE_TYPES = {
  disparo: 'Rotina de Disparo',
  etiqueta: 'Rotina de Etiqueta',
  follow_up: 'Rotina de Follow Up',
};

export const ROUTINE_RULES = {
  before_due: 'Envio antes do vencimento',
  after_due: 'Envio após vencimento',
  after_installation: 'Envio após instalação',
};

export const WEEKDAY_LABELS = {
  mon: 'Seg',
  tue: 'Ter',
  wed: 'Qua',
  thu: 'Qui',
  fri: 'Sex',
  sat: 'Sáb',
  sun: 'Dom',
};

export const WEEKDAY_KEYS = Object.keys(WEEKDAY_LABELS);

export const FOLLOW_UP_PERIODS = [
  { key: 'morning', label: 'Manhã', defaultTime: '07:00' },
  { key: 'afternoon', label: 'Tarde', defaultTime: '12:00' },
  { key: 'night', label: 'Noite', defaultTime: '19:00' },
];

export const FOLLOW_UP_MODELS = [
  { key: 'model1', label: 'Modelo 1' },
  { key: 'model2', label: 'Modelo 2' },
];

export const FOLLOW_UP_LEAD_DEFAULT_TIMES = ['07:00', '12:00', '19:00', '11:00', '20:00'];
export const FOLLOW_UP_SQL_DEFAULT_TIMES = ['07:00', '12:00', '20:00', '11:00'];

const FOLLOW_UP_ACTION_TYPES = ['text', 'image', 'video', 'audio', 'document', 'timer', 'wait', 'ura', 'transfer', 'utility', 'unsupported'];

const normalizeFollowUpAction = (action = {}, index = 0) => {
  const type = FOLLOW_UP_ACTION_TYPES.includes(String(action.type || '').trim()) ? String(action.type || '').trim() : 'text';
  return {
    ...action,
    id: String(action.id || `follow-up-action-${Date.now()}-${index}`),
    type,
    title: String(action.title || '').trim(),
    content: String(action.content || '').trim(),
    caption: String(action.caption || '').trim(),
    media:
      action.media && typeof action.media === 'object'
        ? {
            dataUrl: String(action.media.dataUrl || action.media.base64 || ''),
            fileName: String(action.media.fileName || action.media.filename || ''),
            mimeType: String(action.media.mimeType || action.media.mimetype || ''),
            kind: String(action.media.kind || type),
          }
        : { dataUrl: '', fileName: '', mimeType: '', kind: type },
    typingDelaySeconds: Math.max(0, Math.min(300, Number(action.typingDelaySeconds) || 0)),
    nextActionDelaySeconds: Math.max(0, Math.min(300, Number(action.nextActionDelaySeconds ?? action.waitSeconds) || 0)),
    waitSeconds: Math.max(0, Math.min(300, Number(action.waitSeconds ?? action.nextActionDelaySeconds) || 0)),
    metadata: action.metadata && typeof action.metadata === 'object' ? action.metadata : {},
    sortOrder: Number.isFinite(Number(action.sortOrder)) ? Number(action.sortOrder) : index,
  };
};

const normalizeQuickReplySnapshot = (snapshot = null) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return {
    id: String(snapshot.id || '').trim(),
    title: String(snapshot.title || '').trim(),
    category: String(snapshot.category || snapshot.categoryName || '').trim(),
    categoryId: String(snapshot.categoryId || '').trim(),
    actions: Array.isArray(snapshot.actions) ? snapshot.actions.map(normalizeFollowUpAction) : [],
  };
};

export const normalizeFollowUpStep = (step = {}, index = 0, fallbackTime = '09:00') => {
  const current = step && typeof step === 'object' ? step : {};
  const snapshot = normalizeQuickReplySnapshot(current.quickReplySnapshot);
  return {
    id: String(current.id || `follow-up-step-${index + 1}`).trim(),
    enabled: typeof current.enabled === 'boolean' ? current.enabled : true,
    order: Math.max(1, Number(current.order || index + 1) || index + 1),
    label: String(current.label || `Mensagem ${index + 1}`).trim(),
    time: String(current.time || fallbackTime).slice(0, 5),
    message: String(current.message || '').trim(),
    quickReplyId: String(current.quickReplyId || '').trim(),
    quickReplyTitle: String(current.quickReplyTitle || snapshot?.title || '').trim(),
    quickReplySnapshot: snapshot,
    additionalActions: Array.isArray(current.additionalActions) ? current.additionalActions.map(normalizeFollowUpAction) : [],
  };
};

const buildLegacyFollowUpSteps = (models = {}, fallbackTimes = FOLLOW_UP_LEAD_DEFAULT_TIMES) => {
  const legacy = [];
  FOLLOW_UP_MODELS.forEach((model) => {
    FOLLOW_UP_PERIODS.forEach((period) => {
      const config = models?.[model.key]?.[period.key];
      if (config && typeof config === 'object') {
        legacy.push({ ...config, time: config.time || period.defaultTime });
      }
    });
  });
  const base = legacy.filter((item) => item.enabled !== false);
  return (base.length ? base : fallbackTimes.map((time) => ({ time }))).map((item, index) =>
    normalizeFollowUpStep(
      {
        ...item,
        label: item.label || `Mensagem ${index + 1}`,
        order: index + 1,
      },
      index,
      fallbackTimes[index % fallbackTimes.length] || '09:00',
    ),
  );
};

export const createDefaultWeeklySchedule = (time = '08:00') =>
  WEEKDAY_KEYS.reduce((schedule, key) => {
    schedule[key] = {
      enabled: ['mon', 'tue', 'wed', 'thu', 'fri'].includes(key),
      time,
    };
    return schedule;
  }, {});

export const createDefaultFollowUpConfig = () => ({
  targetLabelId: 'system-lead',
  targetLabelName: 'Lead',
  minHoursWithoutInteraction: 1,
  maxHoursWithoutInteraction: 0,
  maxSendsPerCustomer: 5,
  toleranceMinutes: 5,
  completionLabel: 'Encerrado por desistencia',
  steps: FOLLOW_UP_LEAD_DEFAULT_TIMES.map((time, index) => normalizeFollowUpStep({}, index, time)),
  models: FOLLOW_UP_MODELS.reduce((models, model) => {
    models[model.key] = FOLLOW_UP_PERIODS.reduce((periods, period) => {
      periods[period.key] = {
        enabled: true,
        time: period.defaultTime,
        message: '',
      };
      return periods;
    }, {});
    return models;
  }, {}),
});

export const normalizeFollowUpConfig = (value = {}) => {
  const fallback = createDefaultFollowUpConfig();
  const source = value && typeof value === 'object' ? value : {};
  const models = source.models && typeof source.models === 'object' ? source.models : {};
  const targetLabelId = String(source.targetLabelId || fallback.targetLabelId).trim();
  const targetLabelName = String(source.targetLabelName || fallback.targetLabelName).trim();
  const defaultTimes = normalizeText(`${targetLabelId} ${targetLabelName}`).includes('sql') ? FOLLOW_UP_SQL_DEFAULT_TIMES : FOLLOW_UP_LEAD_DEFAULT_TIMES;
  const steps = (Array.isArray(source.steps) && source.steps.length ? source.steps : buildLegacyFollowUpSteps(models, defaultTimes))
    .map((step, index) => normalizeFollowUpStep(step, index, defaultTimes[index % defaultTimes.length] || '09:00'))
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));

  return {
    ...fallback,
    ...source,
    targetLabelId,
    targetLabelName,
    minHoursWithoutInteraction: Number(source.minHoursWithoutInteraction ?? fallback.minHoursWithoutInteraction) || 1,
    maxHoursWithoutInteraction: Number(source.maxHoursWithoutInteraction ?? 0) || 0,
    maxSendsPerCustomer: Number(source.maxSendsPerCustomer ?? steps.length) || steps.length,
    toleranceMinutes: Number(source.toleranceMinutes ?? fallback.toleranceMinutes) || 5,
    completionLabel: String(source.completionLabel || fallback.completionLabel).trim(),
    steps,
    models: {},
  };
};

export const normalizeRoutineForForm = (routine = null) => {
  const type = routine?.type === 'etiqueta' ? 'etiqueta' : routine?.type === 'follow_up' ? 'follow_up' : 'disparo';
  const sendIntervalSeconds =
    Number(routine?.sendIntervalSeconds) ||
    (Number(routine?.sendIntervalMs) ? Math.max(1, Math.round(Number(routine.sendIntervalMs) / 1000)) : 12);
  const hsm = routine?.hsm && typeof routine.hsm === 'object' ? routine.hsm : {};

  return {
    id: routine?.id || '',
    name: routine?.name || '',
    description: routine?.description || '',
    type,
    status: routine?.status === 'inactive' || routine?.status === 'paused' ? 'inactive' : 'active',
    rule: routine?.rule || 'before_due',
    ruleDays: Number.isFinite(Number(routine?.ruleDays)) ? Number(routine.ruleDays) : 0,
    weeklySchedule: {
      ...createDefaultWeeklySchedule(routine?.scheduledTime || '08:00'),
      ...(routine?.weeklySchedule || {}),
    },
    exceptions: Array.isArray(routine?.exceptions) ? routine.exceptions : [],
    sendIntervalSeconds,
    sendIntervalMs: sendIntervalSeconds * 1000,
    hsm: {
      templateId: hsm.templateId || routine?.templateId || '',
      templateName: hsm.templateName || routine?.templateName || '',
      language: hsm.language || routine?.templateLanguage || 'pt_BR',
      parameterOverrides: {
        body: Array.isArray(hsm?.parameterOverrides?.body)
          ? hsm.parameterOverrides.body
          : Array.isArray(routine?.variables?.body)
            ? routine.variables.body
            : [],
        header: Array.isArray(hsm?.parameterOverrides?.header)
          ? hsm.parameterOverrides.header
          : Array.isArray(routine?.variables?.header)
            ? routine.variables.header
            : [],
        buttons: Array.isArray(hsm?.parameterOverrides?.buttons)
          ? hsm.parameterOverrides.buttons
          : Array.isArray(routine?.variables?.buttons)
            ? routine.variables.buttons
            : [],
      },
      mediaOverride: hsm.mediaOverride || {},
    },
    quickReplyId: routine?.quickReplyId || '',
    followUp: normalizeFollowUpConfig(routine?.followUp),
    labelActions: {
      add: Array.isArray(routine?.labelActions?.add) ? routine.labelActions.add : [],
      remove: Array.isArray(routine?.labelActions?.remove) ? routine.labelActions.remove : [],
    },
  };
};

export const getEnabledScheduleText = (weeklySchedule = {}) =>
  WEEKDAY_KEYS.filter((key) => weeklySchedule?.[key]?.enabled)
    .map((key) => `${WEEKDAY_LABELS[key]} ${weeklySchedule[key]?.time || '08:00'}`)
    .join(' | ') || 'Nenhum dia ativo';

export const getFollowUpTargetLabelText = (followUp = {}) => {
  const config = normalizeFollowUpConfig(followUp);
  return String(config.targetLabelName || config.targetLabelId || 'LEAD').trim() || 'LEAD';
};

export const getFollowUpWindowText = (followUp = {}) => {
  const config = normalizeFollowUpConfig(followUp);
  return `${config.minHoursWithoutInteraction}h a ${config.maxHoursWithoutInteraction}h`;
};

export const getFollowUpLimitText = (followUp = {}) => {
  const config = normalizeFollowUpConfig(followUp);
  return `${config.maxSendsPerCustomer} follow up${Number(config.maxSendsPerCustomer) === 1 ? '' : 's'}`;
};

export const getFollowUpScheduleText = (followUp = {}) => {
  const config = normalizeFollowUpConfig(followUp);
  return config.steps
    .filter((step) => step.enabled)
    .map((step) => `${step.label}: ${step.time}`)
    .join(' | ') || 'Nenhum periodo ativo';
};
export const buildRoutinePayload = (draft) => ({
  ...draft,
  status: draft.status === 'active' ? 'active' : 'inactive',
  timezone: 'America/Sao_Paulo',
  scheduledTime:
    WEEKDAY_KEYS.map((key) => draft.weeklySchedule?.[key])
      .find((day) => day?.enabled)?.time || '08:00',
  sendIntervalSeconds: Math.max(1, Number(draft.sendIntervalSeconds) || 1),
  sendIntervalMs: Math.max(1, Number(draft.sendIntervalSeconds) || 1) * 1000,
  templateId: draft.type === 'disparo' ? draft.hsm.templateId : '',
  templateName: draft.type === 'disparo' ? draft.hsm.templateName : '',
  templateLanguage: draft.type === 'disparo' ? draft.hsm.language : 'pt_BR',
  variables:
    draft.type === 'disparo'
      ? {
          body: draft.hsm.parameterOverrides.body || [],
          header: draft.hsm.parameterOverrides.header || [],
          buttons: draft.hsm.parameterOverrides.buttons || [],
        }
      : { body: [], header: [], buttons: [] },
  hsm: draft.type === 'disparo' ? draft.hsm : null,
  quickReplyId: draft.type === 'disparo' ? draft.quickReplyId || null : null,
  labelActions: draft.type === 'etiqueta' ? draft.labelActions : { add: [], remove: [] },
  followUp: draft.type === 'follow_up' ? normalizeFollowUpConfig(draft.followUp) : normalizeFollowUpConfig({}),
});

export const countBodyVariables = (template = {}) => {
  const matches = getTemplateBody(template).match(/\{\{\s*\d+\s*\}\}/g);
  return matches ? matches.length : 0;
};

export const countHeaderVariables = (template = {}) => {
  const matches = String(template.headerText || '').match(/\{\{\s*\d+\s*\}\}/g);
  return matches ? matches.length : 0;
};

export const isTemplateSendable = (template = {}) => {
  const status = normalizeText(template.status);
  const active = template.active !== false;
  return active && (!status || ['approved', 'aprovado', 'ativo'].includes(status));
};

export const getCustomerLabel = (customer = {}) =>
  String(customer.display_name || customer.name || customer.username || customer.whatsapp || 'Cliente sem nome');

export const getCustomerPhone = (customer = {}) => String(customer.whatsapp || customer.phone_digits || '');

const formatDateVariable = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : (() => {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
  })();
  if (!dateKey) return raw;
  const [year, month, day] = dateKey.split('-');
  return year && month && day ? `${day}/${month}/${year}` : raw;
};

export const getCustomerValue = (customer = {}, key = '') => {
  const raw = customer.raw && typeof customer.raw === 'object' ? customer.raw : {};
  const dueDateValue =
    customer.expires_at ||
    customer.due_date ||
    raw.expires_at_tz ||
    raw.vencimento ||
    raw.due_date ||
    raw.expiration_date ||
    raw.expires_at ||
    '';
  const customerName = String(raw.nome || raw.name || customer.name || customer.display_name || customer.username || '').trim();
  const source = {
    ...raw,
    nome: customerName,
    name: customerName,
    cliente: customerName,
    nome_cliente: customerName,
    usuario: customer.username || raw.username || raw.user || raw.login || '',
    telefone: customer.whatsapp || raw.whatsapp || raw.telefone || raw.phone || '',
    whatsapp: customer.whatsapp || raw.whatsapp || raw.telefone || raw.phone || '',
    plano: customer.package || customer.plan_name || raw.plano || raw.plan || raw.package || '',
    vencimento: formatDateVariable(dueDateValue),
    data_vencimento: formatDateVariable(dueDateValue),
    status: customer.status_label || customer.status || raw.status || '',
    revendedor: customer.reseller || raw.revendedor || raw.reseller || '',
    conexoes: customer.connections ?? raw.connections ?? '',
    dia_hoje: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date()),
    data_hoje: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date()),
    checkoutoken: 'token_gerado_no_envio',
    checkouttoken: 'token_gerado_no_envio',
    checkoutlink: 'link_gerado_no_envio',
  };
  const exact = source[key];
  if (exact != null) return exact;
  const matchedKey = Object.keys(source).find((candidate) => candidate.toLowerCase() === String(key).toLowerCase());
  return matchedKey ? source[matchedKey] : '';
};

export const interpolateValue = (value, customer) =>
  String(value ?? '').replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\{#\s*([A-Za-z0-9_.-]+)\s*\}|\{\s*([A-Za-z0-9_.-]+)\s*\}/g, (_, keyA, keyB, keyC) => {
    const resolved = getCustomerValue(customer, keyA || keyB || keyC);
    return resolved == null ? '' : String(resolved);
  });

export const replaceTemplateParameters = (text, parameters = []) =>
  String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, indexText) => {
    const index = Number.parseInt(indexText, 10) - 1;
    return parameters[index] != null ? String(parameters[index]) : '';
  });

export const buildPreviewFromTemplate = (template, routine = {}, sampleCustomer = {}) => {
  const overrides = routine?.hsm?.parameterOverrides || {};
  const bodyParameters = Array.isArray(overrides?.body)
    ? overrides.body.map((value) => interpolateValue(value, sampleCustomer))
    : Array.isArray(routine?.variables?.body)
      ? routine.variables.body.map((value) => interpolateValue(value, sampleCustomer))
    : [];
  const headerParameters = Array.isArray(overrides?.header)
    ? overrides.header.map((value) => interpolateValue(value, sampleCustomer))
    : Array.isArray(routine?.variables?.header)
      ? routine.variables.header.map((value) => interpolateValue(value, sampleCustomer))
    : [];
  const buttonParameters = Array.isArray(overrides?.buttons)
    ? overrides.buttons.map((button) => ({ ...button, value: interpolateValue(button.value, sampleCustomer) }))
    : Array.isArray(routine?.variables?.buttons)
      ? routine.variables.buttons.map((button) => ({ ...button, value: interpolateValue(button.value, sampleCustomer) }))
    : [];

  return {
    body: replaceTemplateParameters(getTemplateBody(template), bodyParameters),
    footer: template?.footer || '',
    headerText: replaceTemplateParameters(template?.headerText || '', headerParameters),
    headerMediaUrl: routine?.hsm?.mediaOverride?.url || template?.headerMediaUrl || template?.headerExample || '',
    headerType: template?.headerType || template?.headerFormat || '',
    buttons: getTemplateButtons(template),
    bodyParameters,
    headerParameters,
    buttonParameters,
  };
};

export const formatDateTime = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
};

const WEEKDAY_INDEX_TO_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const getDateKey = (date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

export const getNextRoutineRunAt = (routine = {}, fromDate = new Date()) => {
  if (routine.type === 'follow_up') {
    const config = normalizeFollowUpConfig(routine.followUp);
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = new Date(fromDate);
      candidate.setDate(candidate.getDate() + offset);
      for (const step of config.steps.filter((item) => item.enabled)) {
        const [hourText = '00', minuteText = '00'] = String(step.time || '09:00').split(':');
        const runAt = new Date(candidate);
        runAt.setHours(Number(hourText) || 0, Number(minuteText) || 0, 0, 0);
        if (runAt.getTime() > fromDate.getTime()) return runAt.toISOString();
      }
    }
    return null;
  }

  const schedule = routine.weeklySchedule || {};
  const exceptions = new Set(Array.isArray(routine.exceptions) ? routine.exceptions : []);

  for (let offset = 0; offset <= 30; offset += 1) {
    const candidate = new Date(fromDate);
    candidate.setDate(candidate.getDate() + offset);
    const weekday = WEEKDAY_INDEX_TO_KEY[candidate.getDay()];
    const day = schedule?.[weekday];
    if (!day?.enabled) continue;
    const dateKey = getDateKey(candidate);
    if (exceptions.has(dateKey)) continue;
    const [hourText = '08', minuteText = '00'] = String(day.time || routine.scheduledTime || '08:00').split(':');
    const runAt = new Date(candidate);
    runAt.setHours(Number(hourText) || 0, Number(minuteText) || 0, 0, 0);
    if (runAt.getTime() <= fromDate.getTime()) continue;
    return runAt.toISOString();
  }

  return null;
};
