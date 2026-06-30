import 'dotenv/config';
import { readSqlStoreValue, upsertSqlStoreValue } from '../server/sql-store.js';

const nowIso = () => new Date().toISOString();

const normalizeText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const normalizeAction = (action = {}, index = 0) => ({
  ...action,
  id: String(action.id || `follow-up-action-${Date.now()}-${index}`),
  type: String(action.type || 'text').trim().toLowerCase() || 'text',
  title: String(action.title || '').trim(),
  content: String(action.content || '').trim(),
  caption: String(action.caption || '').trim(),
  media: action.media && typeof action.media === 'object' ? action.media : { dataUrl: '', fileName: '', mimeType: '', kind: String(action.type || 'text') },
  typingDelaySeconds: Math.max(0, Math.min(300, Number(action.typingDelaySeconds) || 0)),
  nextActionDelaySeconds: Math.max(0, Math.min(300, Number(action.nextActionDelaySeconds ?? action.waitSeconds) || 0)),
  waitSeconds: Math.max(0, Math.min(300, Number(action.waitSeconds ?? action.nextActionDelaySeconds) || 0)),
  metadata: action.metadata && typeof action.metadata === 'object' ? action.metadata : {},
  sortOrder: Number.isFinite(Number(action.sortOrder)) ? Number(action.sortOrder) : index,
});

const normalizeSnapshot = (snapshot = null) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return {
    id: String(snapshot.id || '').trim(),
    title: String(snapshot.title || '').trim(),
    category: String(snapshot.category || snapshot.categoryName || '').trim(),
    categoryId: String(snapshot.categoryId || '').trim(),
    actions: Array.isArray(snapshot.actions) ? snapshot.actions.map(normalizeAction) : [],
  };
};

const collectLegacyMessages = (followUp = {}) => {
  if (Array.isArray(followUp.steps) && followUp.steps.length) {
    return followUp.steps;
  }
  const items = [];
  const models = followUp.models && typeof followUp.models === 'object' ? followUp.models : {};
  ['model1', 'model2'].forEach((modelKey) => {
    ['morning', 'afternoon', 'night'].forEach((periodKey) => {
      const item = models?.[modelKey]?.[periodKey];
      if (!item || typeof item !== 'object') return;
      if (!String(item.quickReplyId || item.message || '').trim() && !item.quickReplySnapshot && !Array.isArray(item.additionalActions)) return;
      items.push(item);
    });
  });
  return items;
};

const buildSteps = (routine = {}, times = []) => {
  const legacy = collectLegacyMessages(routine.followUp || {});
  return times.map((time, index) => {
    const source = legacy[index] || {};
    const snapshot = normalizeSnapshot(source.quickReplySnapshot);
    return {
      id: `follow-up-step-${index + 1}`,
      enabled: true,
      order: index + 1,
      label: `Mensagem ${index + 1}`,
      time,
      message: String(source.message || '').trim(),
      quickReplyId: String(source.quickReplyId || '').trim(),
      quickReplyTitle: String(source.quickReplyTitle || snapshot?.title || '').trim(),
      quickReplySnapshot: snapshot,
      additionalActions: Array.isArray(source.additionalActions) ? source.additionalActions.map(normalizeAction) : [],
    };
  });
};

const configureRoutine = (routine = {}, config) => {
  const timestamp = nowIso();
  return {
    ...routine,
    name: config.name,
    type: 'follow_up',
    status: 'inactive',
    hsm: null,
    quickReplyId: null,
    templateId: '',
    templateName: '',
    templateLanguage: 'pt_BR',
    variables: { body: [], header: [], buttons: [] },
    labelActions: { add: [], remove: [] },
    followUp: {
      targetLabelId: config.targetLabelId,
      targetLabelName: config.targetLabelName,
      minHoursWithoutInteraction: 1,
      maxHoursWithoutInteraction: 0,
      maxSendsPerCustomer: config.times.length,
      toleranceMinutes: 5,
      completionLabel: 'Encerrado por desistencia',
      steps: buildSteps(routine, config.times).map((step, index) => ({
        ...step,
        quickReplyId: step.quickReplyId || config.quickReplyIds?.[index] || '',
        message: step.message || (config.quickReplyIds?.[index] ? '' : config.messages?.[index] || ''),
      })),
    },
    followUpState: routine.followUpState && typeof routine.followUpState === 'object' ? routine.followUpState : {},
    updatedAt: timestamp,
  };
};

const main = (await readSqlStoreValue('main_store')).payload || {};
const routines = main.routines && typeof main.routines === 'object' ? main.routines : { items: [], logs: [] };
const items = Array.isArray(routines.items) ? routines.items : [];

const configs = [
  {
    matcher: (routine) => normalizeText(routine.name).includes('follow up') && normalizeText(routine.name).includes('lead'),
    name: 'Follow Up - LEAD',
    targetLabelId: 'system-lead',
    targetLabelName: 'Lead',
    times: ['07:00', '12:00', '19:00', '11:00', '20:00'],
    quickReplyIds: ['quickreply-mpbmli40-vacxft', '', '', 'quickreply-mpbmli41-hbw21b', ''],
    messages: [
      '',
      'Oi, {{nome}}. Passando para saber se ainda posso te ajudar.',
      'Ainda estou por aqui caso queira continuar o atendimento.',
      '',
      'Como nao tive retorno, vou encerrar este atendimento por desistencia. Se precisar, e so chamar novamente.',
    ],
  },
  {
    matcher: (routine) => normalizeText(routine.name).includes('follow up') && normalizeText(routine.name).includes('sql'),
    name: 'Follow Up - SQL',
    targetLabelId: 'system-sql',
    targetLabelName: 'SQL',
    times: ['07:00', '12:00', '20:00', '11:00'],
    quickReplyIds: ['quickreply-mpbmli41-knisfi', '', '', 'quickreply-mpbmli41-43aa22'],
    messages: [
      '',
      'Oi, {{nome}}. Conseguiu verificar as informacoes que te enviei?',
      'Passando para confirmar se ainda faz sentido continuarmos seu atendimento.',
      '',
    ],
  },
];

const changed = [];
const nextItems = items.map((routine) => {
  const config = configs.find((item) => item.matcher(routine));
  if (!config) return routine;
  changed.push(config.name);
  return configureRoutine(routine, config);
});

main.routines = {
  ...routines,
  items: nextItems,
};

if (changed.length > 0) {
  await upsertSqlStoreValue('main_store', main);
}

console.log(JSON.stringify({ ok: true, changed }, null, 2));
