import { requestLocalApi } from '@/lib/local-api';

export const QUICK_REPLY_ACTION_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'timer',
  'wait',
  'ura',
  'transfer',
  'newbr_test',
  'utility',
  'unsupported',
];

const createActionId = () => `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const sortReplies = (items) =>
  [...items].sort((left, right) =>
    String(left?.title || '').localeCompare(String(right?.title || ''), 'pt-BR', {
      sensitivity: 'base',
    })
  );

const clampDelay = (value) => Math.max(0, Math.min(300, Number.isFinite(Number(value)) ? Number(value) : 0));

const normalizeUraOptions = (options = []) =>
  (Array.isArray(options) ? options : [])
    .map((option, optionIndex) => ({
      id: String(option.id || `ura-option-${optionIndex + 1}`),
      label: String(option.label || option.title || '').trim(),
      value: String(option.value || option.label || option.title || '').trim(),
      description: String(option.description || '').trim(),
    }))
    .filter((option) => option.label)
    .slice(0, 3);

export const normalizeQuickReplyAction = (action = {}, index = 0) => {
  const type = QUICK_REPLY_ACTION_TYPES.includes(String(action.type || '').trim())
    ? String(action.type || '').trim()
    : 'text';

  return {
    id: String(action.id || createActionId()),
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
    displayOnce: Boolean(action.displayOnce),
    typingDelaySeconds: clampDelay(action.typingDelaySeconds),
    nextActionDelaySeconds: clampDelay(action.nextActionDelaySeconds),
    waitSeconds: clampDelay(action.waitSeconds ?? action.nextActionDelaySeconds),
    ura:
      action.ura && typeof action.ura === 'object'
        ? {
            title: String(action.ura.title || action.metadata?.listTitle || '').trim(),
            description: String(action.ura.description || action.metadata?.description || '').trim(),
            buttonText: String(action.ura.buttonText || action.metadata?.buttonText || 'Selecionar').trim() || 'Selecionar',
            footer: String(action.ura.footer || action.metadata?.footer || '').trim(),
            options: normalizeUraOptions(action.ura.options || action.metadata?.uraOptions),
          }
        : {
            title: String(action.metadata?.listTitle || '').trim(),
            description: String(action.metadata?.description || '').trim(),
            buttonText: String(action.metadata?.buttonText || 'Selecionar').trim() || 'Selecionar',
            footer: String(action.metadata?.footer || '').trim(),
            options: normalizeUraOptions(action.metadata?.uraOptions),
          },
    metadata: {
      ...(action.metadata && typeof action.metadata === 'object' ? action.metadata : {}),
      uraOptions: normalizeUraOptions(action.metadata?.uraOptions || action.ura?.options),
      targetDepartment: String(action.metadata?.targetDepartment || '').trim(),
      targetAgent: String(action.metadata?.targetAgent || '').trim(),
      internalMessage: String(action.metadata?.internalMessage || '').trim(),
      customerMessage: String(action.metadata?.customerMessage || '').trim(),
      description: String(action.metadata?.description || action.ura?.description || '').trim(),
      listTitle: String(action.metadata?.listTitle || action.ura?.title || '').trim(),
      buttonText: String(action.metadata?.buttonText || action.ura?.buttonText || 'Selecionar').trim() || 'Selecionar',
      footer: String(action.metadata?.footer || action.ura?.footer || '').trim(),
    },
    label: String(action.label || (type === 'newbr_test' ? 'Teste completo 4 horas' : '')).trim(),
    durationMinutes: Number.isFinite(Number(action.durationMinutes)) ? Number(action.durationMinutes) : type === 'newbr_test' ? 240 : 0,
    followUpEnabled: type === 'newbr_test' ? action.followUpEnabled !== false : Boolean(action.followUpEnabled),
    followUpBeforeMinutes: Number.isFinite(Number(action.followUpBeforeMinutes))
      ? Number(action.followUpBeforeMinutes)
      : type === 'newbr_test'
        ? 10
        : 0,
    followUpMessage: String(
      action.followUpMessage ||
        (type === 'newbr_test'
          ? 'Seu teste esta quase acabando. Ainda posso te ajudar a ativar o acesso definitivo?'
          : '')
    ),
    sortOrder: Number.isFinite(Number(action.sortOrder)) ? Number(action.sortOrder) : index,
  };
};

export const getQuickReplyActions = (reply = {}) => {
  const actions = Array.isArray(reply.actions)
    ? reply.actions.map((action, index) => normalizeQuickReplyAction(action, index))
    : [];

  if (actions.length > 0) {
    return actions;
  }

  const content = String(reply.content || '').trim();
  if (!content) return [];

  return [
    normalizeQuickReplyAction({
      id: `legacy-${String(reply.id || 'reply')}`,
      type: 'text',
      title: 'Mensagem de texto',
      content,
    }),
  ];
};

export const getQuickReplyPreviewText = (reply = {}) => {
  const actions = getQuickReplyActions(reply);
  const firstText = actions.find((action) => action.content || action.caption);
  return String(firstText?.content || firstText?.caption || reply.content || '').trim();
};

const normalizeReply = (reply = {}, index = 0) => {
  const actions = getQuickReplyActions(reply);
  const content = String(reply.content || getQuickReplyPreviewText({ ...reply, actions }) || '').trim();

  return {
    id: String(reply.id || `reply-${index}-${Date.now()}`),
    title: String(reply.title || '').trim(),
    content,
    shortcut: String(reply.shortcut || '').trim(),
    category: String(reply.category || 'other').trim() || 'other',
    categoryId: String(reply.categoryId || '').trim(),
    type: String(reply.type || actions[0]?.type || 'text').trim(),
    usageCount: Math.max(0, Number.isFinite(Number(reply.usageCount)) ? Number(reply.usageCount) : 0),
    actions,
    created_date: String(reply.created_date || reply.createdAt || new Date().toISOString()),
    updated_date: String(reply.updated_date || reply.updatedAt || ''),
  };
};

const requestLocalEntity = async (entityName, { method = 'GET', id = '', body, searchParams } = {}) => {
  const params = new URLSearchParams(searchParams || {});
  const query = params.toString();
  const target = `/entities/${entityName}${id ? `/${id}` : ''}${query ? `?${query}` : ''}`;
  const response = await requestLocalApi(target, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Falha ao acessar ${entityName}.`);
  }

  return payload;
};

export const listQuickReplies = async (options = {}) => {
  const searchParams = {
    sortBy: 'title',
    limit: options.limit || 100,
  };
  if (options.includeActions) searchParams.include = 'actions';
  if (options.search) searchParams.search = options.search;
  const data = await requestLocalEntity('QuickReply', {
    method: 'GET',
    searchParams,
  });
  const items = Array.isArray(data) ? data : [];

  return sortReplies(
    items
      .map((item, index) => normalizeReply(item, index))
      .filter((item) => item.title && (item.content || item.actions.length > 0))
  );
};

export const saveQuickReply = async (payload, existingId = null) => {
  const reply = normalizeReply(
    {
      ...payload,
      id: existingId || payload?.id || `reply-${Date.now()}`,
    },
    0
  );

  const response = await requestLocalEntity('QuickReply', {
    method: existingId ? 'PUT' : 'POST',
    id: existingId || '',
    body: reply,
  });

  return normalizeReply(response, 0);
};

export const incrementQuickReplyUsage = async (reply) => {
  if (!reply?.id) return null;
  const normalized = normalizeReply(reply, 0);
  const nextReply = {
    ...normalized,
    usageCount: normalized.usageCount + 1,
  };

  const response = await requestLocalEntity('QuickReply', {
    method: 'PUT',
    id: normalized.id,
    body: nextReply,
  });

  return normalizeReply(response, 0);
};

export const deleteQuickReply = async (id) => {
  await requestLocalEntity('QuickReply', {
    method: 'DELETE',
    id,
  });
  return true;
};
