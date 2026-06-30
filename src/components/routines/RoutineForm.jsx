import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, Clock, FileAudio, FileText, Folder, Image as ImageIcon, MessageSquareText, RefreshCw, Search, Send, Tag, Upload, Video, X, Zap } from 'lucide-react';

import ManualRunDialog from './ManualRunDialog';
import TemplatePreview from './TemplatePreview';
import QuickReplyActionBuilder from '@/components/chat/QuickReplyActionBuilder';
import { uploadHsmMedia } from '@/lib/hsm-api';
import { getQuickReplyActions, getQuickReplyPreviewText } from '@/lib/quick-replies';
import { DEFAULT_QUICK_REPLY_CATEGORIES, listQuickReplyCategories } from '@/lib/quick-reply-categories';
import {
  ROUTINE_RULES,
  ROUTINE_TYPES,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  buildPreviewFromTemplate,
  buildRoutinePayload,
  countBodyVariables,
  countHeaderVariables,
  getEnabledScheduleText,
  getFollowUpLimitText,
  getFollowUpScheduleText,
  getTemplateButtons,
  getTemplateLanguage,
  getTemplateName,
  isTemplateSendable,
  normalizeRoutineForForm,
} from './utils';

const Section = ({ title, description, children }) => (
  <section className="rounded-lg border border-border bg-card/70 p-4 shadow-sm">
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
    </div>
    {children}
  </section>
);

const Field = ({ label, children, hint }) => (
  <label className="space-y-1.5 text-sm">
    <span className="font-medium text-foreground">{label}</span>
    {children}
    {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
  </label>
);

const TextInput = ({ className = '', ...props }) => (
  <input
    {...props}
    className={`w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary ${className}`}
  />
);

const SelectInput = ({ className = '', ...props }) => (
  <select
    {...props}
    className={`w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary ${className}`}
  />
);

const Toggle = ({ checked, onChange }) => (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    className={`relative h-6 w-11 rounded-full border transition ${checked ? 'border-primary bg-primary' : 'border-border bg-muted'}`}
  >
    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-background transition ${checked ? 'left-5' : 'left-0.5'}`} />
  </button>
);

const getTemplateHeaderKind = (template = {}) => String(template.headerType || template.headerFormat || '').toLowerCase();

const getMediaAccept = (template = {}) => {
  const headerKind = getTemplateHeaderKind(template);
  if (headerKind.includes('image')) return 'image/png,image/jpeg,image/jpg,image/webp,image/gif';
  if (headerKind.includes('video')) return 'video/mp4,video/webm,video/quicktime';
  return '.pdf,.doc,.docx,text/plain,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
};

const isMediaHeaderTemplate = (template = {}) => ['image', 'video', 'document'].some((type) => getTemplateHeaderKind(template).includes(type));

const normalizeTextForSearch = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const actionTypeLabels = {
  text: 'Texto',
  image: 'Imagem',
  video: 'Vídeo',
  audio: 'Áudio',
  document: 'Documento',
  timer: 'Timer',
  wait: 'Espera',
  ura: 'URA',
  transfer: 'Transferência',
  utility: 'Utilitário',
  unsupported: 'Não suportada',
};

const quickReplyActionIcons = {
  text: FileText,
  image: ImageIcon,
  video: Video,
  audio: FileAudio,
  document: FileText,
  timer: Clock,
  wait: Clock,
  ura: FileText,
  transfer: Send,
  utility: FileText,
  unsupported: FileText,
};

const legacyCategoryLabels = {
  greeting: 'Saudação',
  farewell: 'Despedida',
  faq: 'FAQ',
  sales: 'Vendas',
  support: 'Suporte',
  disparo: 'Disparo',
  other: 'Sem Categoria',
};

const resolveQuickReplyCategory = (reply, categories = []) => {
  const byId = categories.find((category) => category.id === reply.categoryId);
  if (byId) return byId;
  const legacyName = legacyCategoryLabels[reply.category] || reply.category || 'Sem Categoria';
  return (
    categories.find((category) => String(category.name || '').toLowerCase() === String(legacyName || '').toLowerCase()) || {
      ...DEFAULT_QUICK_REPLY_CATEGORIES[3],
      name: legacyName || 'Sem Categoria',
    }
  );
};

const getActionPreview = (action = {}) => {
  if (action.type === 'timer' || action.type === 'wait') return `${action.waitSeconds ?? action.nextActionDelaySeconds ?? 0}s`;
  if (['image', 'video', 'audio', 'document'].includes(action.type)) return action.media?.fileName || action.caption || 'Mídia';
  if (action.type === 'ura') return action.ura?.title || action.metadata?.listTitle || action.content || 'URA';
  if (action.type === 'transfer') return action.metadata?.targetDepartment || action.metadata?.targetAgent || 'Transferência';
  return action.content || action.caption || action.title || 'Sem prévia';
};

const createQuickReplySnapshot = (reply = {}) => ({
  id: String(reply.id || '').trim(),
  title: String(reply.title || '').trim(),
  category: String(reply.category || reply.categoryName || 'Sem categoria').trim() || 'Sem categoria',
  categoryId: String(reply.categoryId || '').trim(),
  actions: getQuickReplyActions(reply),
});

const FollowUpActionList = ({ title, actions = [], startIndex = 1, emptyText }) => (
  <div className="rounded-lg border border-border bg-background/70 p-3">
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</span>
      <span className="text-xs text-muted-foreground">{actions.length} ação(ões)</span>
    </div>
    {actions.length ? (
      <div className="space-y-1.5">
        {actions.map((action, index) => (
          <div key={action.id || `${title}-${index}`} className="flex gap-2 rounded-md border border-border/80 bg-card px-2 py-1.5 text-xs">
            <span className="font-semibold text-muted-foreground">{startIndex + index}.</span>
            <span className="font-medium text-foreground">{actionTypeLabels[action.type] || action.type || 'Ação'}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">— {getActionPreview(action)}</span>
          </div>
        ))}
      </div>
    ) : (
      <p className="text-xs text-muted-foreground">{emptyText}</p>
    )}
  </div>
);

export default function RoutineForm({
  routine,
  initialType = 'disparo',
  templates = [],
  quickReplies = [],
  labels = [],
  customers = [],
  sampleCustomer = {},
  onCancel,
  onSubmit,
  onManualRun,
  onRefreshTemplates,
  isSaving,
  isManualRunning,
}) {
  const [draft, setDraft] = useState(() => normalizeRoutineForForm(routine || { type: initialType }));
  const [activeFollowUpPeriod, setActiveFollowUpPeriod] = useState('0');
  const [quickReplySearch, setQuickReplySearch] = useState('');
  const [quickReplyExpandedCategories, setQuickReplyExpandedCategories] = useState(() => new Set(['cat-apps', 'cat-tests', 'cat-payment', 'cat-none']));
  const [exceptionDate, setExceptionDate] = useState('');
  const [error, setError] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [mediaUpload, setMediaUpload] = useState({ loading: false, error: '' });

  const sendableTemplates = useMemo(() => templates.filter(isTemplateSendable), [templates]);
  const dispatchReplies = useMemo(
    () => quickReplies.filter((reply) => String(reply.category || '').toLowerCase() === 'disparo'),
    [quickReplies],
  );
  const quickReplyCategoriesQuery = useQuery({
    queryKey: ['quick-reply-categories', 'routine-form'],
    queryFn: listQuickReplyCategories,
    enabled: draft.type === 'follow_up',
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const quickReplyCategories = useMemo(() => {
    const loaded = Array.isArray(quickReplyCategoriesQuery.data) ? quickReplyCategoriesQuery.data : [];
    const byName = new Map();
    [...loaded, ...DEFAULT_QUICK_REPLY_CATEGORIES].forEach((category) => {
      const key = String(category.name || '').trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, category);
    });
    return Array.from(byName.values()).sort((left, right) => {
      const leftName = String(left.name || '').toLowerCase();
      const rightName = String(right.name || '').toLowerCase();
      const leftIsFallback = left.id === 'cat-none' || leftName === 'sem categoria';
      const rightIsFallback = right.id === 'cat-none' || rightName === 'sem categoria';
      if (leftIsFallback !== rightIsFallback) return leftIsFallback ? 1 : -1;
      const leftOrder = Number.isFinite(Number(left.sortOrder)) ? Number(left.sortOrder) : 9999;
      const rightOrder = Number.isFinite(Number(right.sortOrder)) ? Number(right.sortOrder) : 9999;
      return leftOrder - rightOrder || String(left.name || '').localeCompare(String(right.name || ''), 'pt-BR');
    });
  }, [quickReplyCategoriesQuery.data]);
  const groupedQuickRepliesForFollowUp = useMemo(() => {
    const search = normalizeTextForSearch(quickReplySearch);
    const groups = new Map();
    quickReplies
      .filter((reply) => {
        const category = resolveQuickReplyCategory(reply, quickReplyCategories);
        const actions = getQuickReplyActions(reply);
        const haystack = [
          reply.title,
          reply.content,
          reply.shortcut,
          category.name,
          ...actions.flatMap((action) => [
            action.type,
            action.content,
            action.caption,
            action.media?.fileName,
            action.metadata?.listTitle,
            action.metadata?.description,
            action.metadata?.targetDepartment,
          ]),
        ]
          .join(' ')
          .toLowerCase();
        return !search || normalizeTextForSearch(haystack).includes(search);
      })
      .forEach((reply) => {
        const category = resolveQuickReplyCategory(reply, quickReplyCategories);
        const key = category.id || category.name;
        if (!groups.has(key)) groups.set(key, { category, items: [] });
        groups.get(key).items.push(reply);
      });
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        items: group.items.sort((left, right) => String(left.title || '').localeCompare(String(right.title || ''), 'pt-BR')),
      }))
      .sort((left, right) => {
        const leftName = String(left.category.name || '').toLowerCase();
        const rightName = String(right.category.name || '').toLowerCase();
        const leftIsFallback = left.category.id === 'cat-none' || leftName === 'sem categoria';
        const rightIsFallback = right.category.id === 'cat-none' || rightName === 'sem categoria';
        if (leftIsFallback !== rightIsFallback) return leftIsFallback ? 1 : -1;
        const leftOrder = Number.isFinite(Number(left.category.sortOrder)) ? Number(left.category.sortOrder) : 9999;
        const rightOrder = Number.isFinite(Number(right.category.sortOrder)) ? Number(right.category.sortOrder) : 9999;
        return leftOrder - rightOrder || String(left.category.name || '').localeCompare(String(right.category.name || ''), 'pt-BR');
      });
  }, [quickReplies, quickReplyCategories, quickReplySearch]);
  const selectedTemplate = useMemo(
    () =>
      templates.find((template) => {
        const id = String(template.id || template.code || '');
        return id === draft.hsm.templateId || (getTemplateName(template) === draft.hsm.templateName && getTemplateLanguage(template) === draft.hsm.language);
      }) || null,
    [draft.hsm.language, draft.hsm.templateId, draft.hsm.templateName, templates],
  );
  const selectedFollowUpLabel = useMemo(
    () => labels.find((label) => String(label.id || '') === String(draft.followUp.targetLabelId || '')) || null,
    [draft.followUp.targetLabelId, labels],
  );

  const bodyVariableCount = selectedTemplate ? countBodyVariables(selectedTemplate) : 0;
  const headerVariableCount = selectedTemplate ? countHeaderVariables(selectedTemplate) : 0;
  const buttons = selectedTemplate ? getTemplateButtons(selectedTemplate) : [];
  const preview = selectedTemplate ? buildPreviewFromTemplate(selectedTemplate, draft, sampleCustomer) : null;
  const modalTitle = routine?.id ? 'Editar rotina' : 'Nova rotina';
  const ruleHelper =
    draft.rule === 'before_due'
      ? `A rotina será executada ${draft.ruleDays || 0} dia(s) antes do vencimento do cliente.`
      : draft.rule === 'after_due'
        ? `A rotina será executada ${draft.ruleDays || 0} dia(s) após o vencimento do cliente.`
        : `A rotina será executada ${draft.ruleDays || 0} dia(s) após a data de criação do cliente.`;

  const updateDraft = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const updateHsm = (patch) => setDraft((current) => ({ ...current, hsm: { ...current.hsm, ...patch } }));
  const updateFollowUp = (patch) => setDraft((current) => ({ ...current, followUp: { ...current.followUp, ...patch } }));
  const updateFollowUpStep = (stepIndex, patch) =>
    setDraft((current) => {
      const steps = Array.isArray(current.followUp.steps) ? current.followUp.steps : [];
      return {
        ...current,
        followUp: {
          ...current.followUp,
          steps: steps.map((step, index) => (index === stepIndex ? { ...step, ...patch } : step)),
          maxSendsPerCustomer: steps.length,
        },
      };
    });
  const applyQuickReplyToFollowUpStep = (stepIndex, quickReplyId) => {
    const reply = quickReplies.find((item) => String(item.id || '') === String(quickReplyId || '')) || null;
    updateFollowUpStep(stepIndex, {
      quickReplyId: quickReplyId || '',
      quickReplyTitle: reply?.title || '',
      quickReplySnapshot: reply ? createQuickReplySnapshot(reply) : null,
    });
  };
  const updateOverrides = (patch) =>
    setDraft((current) => ({
      ...current,
      hsm: {
        ...current.hsm,
        parameterOverrides: { ...current.hsm.parameterOverrides, ...patch },
      },
    }));

  const selectTemplate = (templateId) => {
    const template = templates.find((item) => String(item.id || item.code || '') === templateId) || null;
    updateHsm({
      templateId,
      templateName: template ? getTemplateName(template) : '',
      language: template ? getTemplateLanguage(template) : 'pt_BR',
      parameterOverrides: {
        body: Array.from({ length: template ? countBodyVariables(template) : 0 }, (_, index) => draft.hsm.parameterOverrides.body[index] || ''),
        header: Array.from({ length: template ? countHeaderVariables(template) : 0 }, (_, index) => draft.hsm.parameterOverrides.header[index] || ''),
        buttons: draft.hsm.parameterOverrides.buttons || [],
      },
      mediaOverride: {},
    });
  };

  const updateScheduleDay = (weekday, patch) =>
    updateDraft({
      weeklySchedule: {
        ...draft.weeklySchedule,
        [weekday]: { ...draft.weeklySchedule[weekday], ...patch },
      },
    });

  const toggleLabel = (target, labelId) => {
    const current = draft.labelActions[target] || [];
    updateDraft({
      labelActions: {
        ...draft.labelActions,
        [target]: current.includes(labelId) ? current.filter((item) => item !== labelId) : [...current, labelId],
      },
    });
  };

  const toggleQuickReplyCategory = (groupId) => {
    setQuickReplyExpandedCategories((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const addException = () => {
    if (!exceptionDate || draft.exceptions.includes(exceptionDate)) return;
    updateDraft({ exceptions: [...draft.exceptions, exceptionDate].sort() });
    setExceptionDate('');
  };

  const handleRoutineMediaUpload = async (file) => {
    if (!file) return;
    setMediaUpload({ loading: true, error: '' });
    try {
      const uploaded = await uploadHsmMedia(file);
      const url = String(uploaded?.url || uploaded?.mediaUrl || uploaded?.fileUrl || uploaded?.path || '').trim();
      if (!url) throw new Error('Upload concluido sem URL de midia.');
      updateHsm({
        mediaOverride: {
          url,
          filename: file.name,
          mimeType: file.type,
          uploadedAt: new Date().toISOString(),
        },
      });
    } catch (uploadError) {
      setMediaUpload({
        loading: false,
        error: uploadError instanceof Error ? uploadError.message : 'Falha ao enviar a midia da rotina.',
      });
      return;
    }
    setMediaUpload({ loading: false, error: '' });
  };

  const validate = () => {
    if (!draft.name.trim()) return 'Informe o nome da rotina.';
    if (draft.type === 'disparo' && !draft.rule) return 'Selecione uma regra.';
    if (draft.type === 'disparo' && (!Number.isFinite(Number(draft.ruleDays)) || Number(draft.ruleDays) < 0)) return 'Informe os dias da regra.';
    const enabledDays = WEEKDAY_KEYS.filter((key) => draft.weeklySchedule?.[key]?.enabled);
    if (draft.type !== 'follow_up' && !enabledDays.length) return 'Ative pelo menos um dia da agenda semanal.';
    if (draft.type !== 'follow_up' && enabledDays.some((key) => !draft.weeklySchedule?.[key]?.time)) return 'Informe horario para todos os dias ativos.';
    if (draft.type === 'disparo') {
      if (!draft.hsm.templateId) return 'Selecione um HSM.';
      if (!Number.isFinite(Number(draft.sendIntervalSeconds)) || Number(draft.sendIntervalSeconds) <= 0) {
        return 'Informe o intervalo entre disparos em segundos.';
      }
    }
    if (draft.type === 'etiqueta' && !draft.labelActions.add.length && !draft.labelActions.remove.length) {
      return 'Selecione pelo menos uma etiqueta para adicionar ou remover.';
    }
    if (draft.type === 'follow_up') {
      if (Number(draft.followUp.minHoursWithoutInteraction) <= 0) return 'Informe o tempo minimo sem interacao.';
      const activeSteps = Array.isArray(draft.followUp.steps) ? draft.followUp.steps.filter((step) => step.enabled) : [];
      if (!activeSteps.length) return 'Ative pelo menos uma mensagem de follow up.';
      const invalidStep = activeSteps.some((step) => {
        if (!String(step.time || '').trim()) return true;
        return !String(step.quickReplyId || '').trim() && !(step.additionalActions || []).length;
      });
      if (invalidStep) return 'Configure uma resposta rapida base ou adicione uma acao para cada mensagem ativa.';
    }    return '';
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    onSubmit(buildRoutinePayload(draft));
  };

  const renderLabelPicker = (target, title) => (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-foreground">{title}</h4>
      <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
        {labels.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Nenhuma etiqueta cadastrada.</p>
        ) : (
          labels.map((label) => (
            <button
              key={`${target}-${label.id}`}
              type="button"
              onClick={() => toggleLabel(target, label.id)}
              className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left transition ${
                draft.labelActions[target].includes(label.id) ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-muted/40'
              }`}
            >
              <span>
                <span className="block text-sm font-semibold text-foreground">{label.name}</span>
                <span className="text-xs text-muted-foreground">{label.kind === 'system' ? 'Etiqueta padrão' : 'Etiqueta customizada'}</span>
              </span>
              <span className="h-4 w-4 rounded-full border border-primary" />
            </button>
          ))
        )}
      </div>
    </div>
  );
  const followUpSteps = Array.isArray(draft.followUp.steps) ? draft.followUp.steps : [];
  const activeFollowUpStepIndex = Math.max(0, Math.min(followUpSteps.length - 1, Number(activeFollowUpPeriod) || 0));
  const activeFollowUpPeriodDraft = followUpSteps[activeFollowUpStepIndex] || {};
  const activeFollowUpBaseTitle =
    activeFollowUpPeriodDraft.quickReplyTitle ||
    activeFollowUpPeriodDraft.quickReplySnapshot?.title ||
    quickReplies.find((reply) => String(reply.id || '') === String(activeFollowUpPeriodDraft.quickReplyId || ''))?.title ||
    '';

  return (
    <form onSubmit={handleSubmit} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
        <header className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{modalTitle}</h2>
            <p className="mt-1 text-sm text-muted-foreground">Configure disparos automáticos com HSMs ou rotinas de etiqueta.</p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {error ? (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_390px]">
            <div className="space-y-5">
              <Section title="Dados da rotina">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Tipo de rotina">
                    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground">{ROUTINE_TYPES[draft.type]}</div>
                  </Field>
                  <Field label="Status">
                    <SelectInput value={draft.status} onChange={(event) => updateDraft({ status: event.target.value })}>
                      <option value="active">Ativo</option>
                      <option value="inactive">Inativo</option>
                    </SelectInput>
                  </Field>
                </div>
                <div className="mt-4">
                  <Field label="Nome da rotina">
                    <TextInput value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder="Ex: Disparo no dia do vencimento" />
                  </Field>
                </div>
              </Section>

              {draft.type === 'disparo' ? (
              <Section title="Regra de execução">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Regra">
                    <SelectInput value={draft.rule} onChange={(event) => updateDraft({ rule: event.target.value })}>
                      {Object.entries(ROUTINE_RULES).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label="Dias da regra" hint="0 significa no próprio dia base.">
                    <TextInput type="number" min="0" value={draft.ruleDays} onChange={(event) => updateDraft({ ruleDays: event.target.value })} />
                  </Field>
                </div>
                <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-muted-foreground">{ruleHelper}</div>
              </Section>
              ) : null}

              {draft.type === 'disparo' ? (
                <Section title="Configuração de disparo">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="HSM">
                      <SelectInput value={draft.hsm.templateId} onChange={(event) => selectTemplate(event.target.value)}>
                        <option value="">Selecione um HSM aprovado</option>
                        {sendableTemplates.map((template) => (
                          <option key={template.id || template.code || getTemplateName(template)} value={template.id || template.code}>
                            {getTemplateName(template)} ({getTemplateLanguage(template)}) - {template.status || template.category || 'local'}
                          </option>
                        ))}
                      </SelectInput>
                    </Field>
                    <Field label="Intervalo entre disparos (segundos)">
                      <TextInput
                        type="number"
                        min="1"
                        placeholder="Ex: 12"
                        value={draft.sendIntervalSeconds}
                        onChange={(event) => updateDraft({ sendIntervalSeconds: event.target.value })}
                      />
                    </Field>
                  </div>

                  <div className="mt-4">
                    <Field label="Resposta rápida em caso de janela de 24h">
                      <SelectInput value={draft.quickReplyId || ''} onChange={(event) => updateDraft({ quickReplyId: event.target.value })}>
                        <option value="">Não usar resposta rápida</option>
                        {dispatchReplies.map((reply) => (
                          <option key={reply.id} value={reply.id}>
                            {reply.title}
                          </option>
                        ))}
                      </SelectInput>
                    </Field>
                    {dispatchReplies.length === 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">Nenhuma resposta rápida da categoria Disparo encontrada.</p>
                    ) : null}
                  </div>

                  {selectedTemplate ? (
                    <div className="mt-5 space-y-4 rounded-lg border border-border p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h4 className="text-sm font-semibold text-foreground">Parâmetros do HSM</h4>
                          <p className="text-xs text-muted-foreground">Sobrescritos apenas nesta rotina, sem alterar o HSM salvo.</p>
                        </div>
                        <button type="button" onClick={onRefreshTemplates} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
                          <RefreshCw className="h-3.5 w-3.5" />
                          Atualizar templates
                        </button>
                      </div>

                      {bodyVariableCount > 0 ? (
                        <div>
                          <h5 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Corpo da mensagem</h5>
                          <div className="grid gap-3 md:grid-cols-2">
                            {Array.from({ length: bodyVariableCount }).map((_, index) => (
                              <Field key={`body-${index}`} label={`Corpo ${index + 1}`}>
                                <TextInput
                                  placeholder="{{nome}}, {{plano}}, {{vencimento}}"
                                  value={draft.hsm.parameterOverrides.body[index] || ''}
                                  onChange={(event) => {
                                    const body = [...draft.hsm.parameterOverrides.body];
                                    body[index] = event.target.value;
                                    updateOverrides({ body });
                                  }}
                                />
                              </Field>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div>
                        <h5 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Header</h5>
                        <div className="grid gap-3 md:grid-cols-2">
                          {Array.from({ length: headerVariableCount }).map((_, index) => (
                            <Field key={`header-${index}`} label={`Header ${index + 1}`}>
                              <TextInput
                                value={draft.hsm.parameterOverrides.header[index] || ''}
                                onChange={(event) => {
                                  const header = [...draft.hsm.parameterOverrides.header];
                                  header[index] = event.target.value;
                                  updateOverrides({ header });
                                }}
                              />
                            </Field>
                          ))}
                        </div>
                      </div>

                      {isMediaHeaderTemplate(selectedTemplate) ? (
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-foreground">Mídia específica da rotina</div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={mediaUpload.loading}
                              onClick={() => document.getElementById('routine-media-upload')?.click()}
                              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <Upload className="h-4 w-4" />
                              {mediaUpload.loading ? 'Enviando...' : 'Enviar mídia'}
                            </button>
                            <input
                              id="routine-media-upload"
                              type="file"
                              className="hidden"
                              accept={getMediaAccept(selectedTemplate)}
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                void handleRoutineMediaUpload(file);
                                event.target.value = '';
                              }}
                            />
                            {draft.hsm.mediaOverride.url ? (
                              <>
                                <span className="max-w-[260px] truncate text-xs text-muted-foreground">
                                  {draft.hsm.mediaOverride.filename || 'Mídia da rotina configurada'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => updateHsm({ mediaOverride: {} })}
                                  className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                                >
                                  Remover
                                </button>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">Use uma mídia da rotina ou mantenha a mídia padrão do HSM.</span>
                            )}
                          </div>
                          {mediaUpload.error ? <p className="text-xs text-destructive">{mediaUpload.error}</p> : null}
                        </div>
                      ) : null}

                      {buttons.length > 0 ? (
                        <div>
                          <h5 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Botões</h5>
                          <div className="grid gap-3 md:grid-cols-2">
                            {buttons.map((button, index) => (
                              <Field key={button.id || index} label={`${button.label || button.text || 'Botão'} ${index + 1}`}>
                                <TextInput
                                  value={draft.hsm.parameterOverrides.buttons[index]?.value || ''}
                                  onChange={(event) => {
                                    const nextButtons = [...draft.hsm.parameterOverrides.buttons];
                                    nextButtons[index] = { index, type: button.type || 'quick_reply', value: event.target.value };
                                    updateOverrides({ buttons: nextButtons });
                                  }}
                                />
                              </Field>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </Section>
              ) : draft.type === 'follow_up' ? (
                <Section title="Follow Up" description="Sequencia diaria por etiqueta alvo. Cada execucao envia a proxima mensagem do ciclo do cliente.">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg border border-border bg-background p-4">
                      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                        <Tag className="h-4 w-4 text-primary" />
                        Etiqueta alvo
                      </div>
                      <SelectInput
                        value={draft.followUp.targetLabelId || ''}
                        onChange={(event) => {
                          const targetLabel = labels.find((label) => String(label.id || '') === event.target.value) || null;
                          updateFollowUp({
                            targetLabelId: targetLabel?.id || '',
                            targetLabelName: targetLabel?.name || '',
                          });
                        }}
                      >
                        {labels.map((label) => (
                          <option key={`follow-up-target-${label.id}`} value={label.id}>
                            {label.name}
                          </option>
                        ))}
                      </SelectInput>
                      <p className="mt-2 text-xs text-muted-foreground">Atual: {selectedFollowUpLabel?.name || draft.followUp.targetLabelName || 'Nao definido'}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-background p-4">
                      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                        <Clock className="h-4 w-4 text-primary" />
                        Inatividade
                      </div>
                      <Field label="Min. sem interacao">
                        <TextInput type="number" min="1" value={draft.followUp.minHoursWithoutInteraction} onChange={(event) => updateFollowUp({ minHoursWithoutInteraction: event.target.value })} />
                      </Field>
                      <p className="mt-2 text-xs text-muted-foreground">Cliente ou agente sem resposta por este periodo. Agendados ficam fora.</p>
                    </div>
                    <div className="rounded-lg border border-border bg-background p-4">
                      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                        <MessageSquareText className="h-4 w-4 text-primary" />
                        Ciclo
                      </div>
                      <Field label="Encerramento">
                        <TextInput value={draft.followUp.completionLabel || 'Encerrado por desistencia'} onChange={(event) => updateFollowUp({ completionLabel: event.target.value })} />
                      </Field>
                      <p className="mt-2 text-xs text-muted-foreground">{draft.followUp.steps?.length || 0} mensagem(ns) configurada(s).</p>
                    </div>
                  </div>

                  <div className="mt-5 rounded-lg border border-border bg-background">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3">
                      <div>
                        <h4 className="text-sm font-semibold text-foreground">Sequencia de mensagens</h4>
                        <p className="text-xs text-muted-foreground">A cada execucao elegivel, o cliente recebe a proxima mensagem desta lista.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => updateFollowUp({
                          steps: [
                            ...(draft.followUp.steps || []),
                            {
                              id: `follow-up-step-${Date.now()}`,
                              enabled: true,
                              order: (draft.followUp.steps || []).length + 1,
                              label: `Mensagem ${(draft.followUp.steps || []).length + 1}`,
                              time: '09:00',
                              message: '',
                              quickReplyId: '',
                              quickReplyTitle: '',
                              quickReplySnapshot: null,
                              additionalActions: [],
                            },
                          ],
                          maxSendsPerCustomer: (draft.followUp.steps || []).length + 1,
                        })}
                        className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
                      >
                        Adicionar mensagem
                      </button>
                    </div>

                    <div className="grid gap-4 p-4">
                      {(draft.followUp.steps || []).map((step, stepIndex) => {
                        const baseActions = step.quickReplySnapshot?.actions || [];
                        const additionalActions = Array.isArray(step.additionalActions) ? step.additionalActions : [];
                        const selectedBaseTitle =
                          step.quickReplyTitle ||
                          step.quickReplySnapshot?.title ||
                          quickReplies.find((reply) => String(reply.id || '') === String(step.quickReplyId || ''))?.title ||
                          '';
                        const totalActions = baseActions.length + additionalActions.length;
                        return (
                          <div key={step.id || stepIndex} className={`rounded-lg border bg-card p-4 transition ${String(activeFollowUpPeriod) === String(stepIndex) ? 'border-primary/60 shadow-sm' : 'border-border/80'}`}>
                            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                              <button type="button" onClick={() => setActiveFollowUpPeriod(String(stepIndex))} className="text-left">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-semibold text-foreground">{step.label || `Mensagem ${stepIndex + 1}`}</span>
                                  <span className={`rounded-full border px-2 py-1 text-[11px] font-medium ${step.enabled ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/30 bg-amber-500/10 text-amber-700'}`}>
                                    {step.enabled ? 'Ativa' : 'Inativa'}
                                  </span>
                                  <span className="rounded-full border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">{selectedBaseTitle ? 'Com base' : 'Sem base'}</span>
                                  <span className="rounded-full border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">{totalActions} acao(oes)</span>
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">Janela {step.time || '09:00'} | Ordem {stepIndex + 1}</p>
                              </button>
                              <div className="flex items-center gap-3">
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <input type="checkbox" checked={Boolean(step.enabled)} onChange={(event) => updateFollowUpStep(stepIndex, { enabled: event.target.checked })} />
                                  Ativa
                                </label>
                                <div className="w-32">
                                  <TextInput type="time" value={step.time || '09:00'} onChange={(event) => updateFollowUpStep(stepIndex, { time: event.target.value })} />
                                </div>
                                {(draft.followUp.steps || []).length > 1 ? (
                                  <button
                                    type="button"
                                    onClick={() => updateFollowUp({ steps: (draft.followUp.steps || []).filter((_, index) => index !== stepIndex).map((item, index) => ({ ...item, order: index + 1, label: item.label || `Mensagem ${index + 1}` })), maxSendsPerCustomer: Math.max(1, (draft.followUp.steps || []).length - 1) })}
                                    className="rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:text-destructive"
                                  >
                                    Remover
                                  </button>
                                ) : null}
                              </div>
                            </div>

                            <div className="grid gap-3">
                              <Field label="Nome da mensagem">
                                <TextInput value={step.label || ''} onChange={(event) => updateFollowUpStep(stepIndex, { label: event.target.value })} />
                              </Field>
                              <QuickReplyActionBuilder
                                actions={additionalActions}
                                onActionsChange={(nextActions) => updateFollowUpStep(stepIndex, { additionalActions: nextActions })}
                                variables={[{ key: 'nome' }, { key: 'telefone' }, { key: 'protocolo' }, { key: 'atendente' }]}
                                leadingContent={
                                  selectedBaseTitle || baseActions.length ? (
                                    <div className="rounded-lg border border-border bg-background/70 p-3">
                                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                        <div className="min-w-0">
                                          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Base selecionada</div>
                                          <div className="mt-1 truncate text-sm font-medium text-foreground">{selectedBaseTitle}</div>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <button type="button" onClick={() => setActiveFollowUpPeriod(String(stepIndex))} className="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted">
                                            Trocar resposta base
                                          </button>
                                          {step.quickReplyId ? (
                                            <button
                                              type="button"
                                              onClick={() => updateFollowUpStep(stepIndex, { quickReplyId: '', quickReplyTitle: '', quickReplySnapshot: null })}
                                              className="rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:text-destructive"
                                            >
                                              Remover base
                                            </button>
                                          ) : null}
                                        </div>
                                      </div>
                                      <FollowUpActionList title="Acoes da base" actions={baseActions} emptyText="A resposta rapida selecionada nao possui acoes salvas." />
                                    </div>
                                  ) : null
                                }
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </Section>              ) : (
                <Section title="Configuração de etiqueta">
                  <div className="grid gap-4 md:grid-cols-2">
                    {renderLabelPicker('add', 'Etiquetas para adicionar')}
                    {renderLabelPicker('remove', 'Etiquetas para remover')}
                  </div>
                </Section>
              )}

              {draft.type !== 'follow_up' ? (
              <Section title="Agenda semanal" description="Defina quais dias executam e o horário de cada um.">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {WEEKDAY_KEYS.map((weekday) => (
                    <div key={weekday} className="rounded-lg border border-border bg-background p-3">
                      <div className="mb-3 flex items-center justify-between">
                        <span className="text-sm font-semibold text-foreground">{WEEKDAY_LABELS[weekday]}</span>
                        <Toggle checked={Boolean(draft.weeklySchedule[weekday]?.enabled)} onChange={(enabled) => updateScheduleDay(weekday, { enabled })} />
                      </div>
                      <TextInput type="time" value={draft.weeklySchedule[weekday]?.time || '08:00'} onChange={(event) => updateScheduleDay(weekday, { time: event.target.value })} />
                    </div>
                  ))}
                </div>
              </Section>
              ) : null}

              {draft.type !== 'follow_up' ? (
              <Section title="Exceções" description="Datas em que a rotina não deve rodar, mesmo que o dia e horário estejam liberados.">
                <div className="flex flex-col gap-2 md:flex-row">
                  <TextInput type="date" value={exceptionDate} onChange={(event) => setExceptionDate(event.target.value)} />
                  <button type="button" onClick={addException} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted">
                    Adicionar exceção
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {draft.exceptions.length === 0 ? (
                    <span className="text-sm text-muted-foreground">Nenhuma exceção cadastrada.</span>
                  ) : (
                    draft.exceptions.map((date) => (
                      <button
                        key={date}
                        type="button"
                        onClick={() => updateDraft({ exceptions: draft.exceptions.filter((item) => item !== date) })}
                        className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-foreground"
                      >
                        {date}
                        <X className="h-3 w-3" />
                      </button>
                    ))
                  )}
                </div>
              </Section>
              ) : null}

              {draft.type === 'disparo' ? (
                <Section title="Envio manual" description="Selecione clientes da base do SaaSTV e execute esta rotina sem depender da regra de data.">
                  <button
                    type="button"
                    onClick={() => setManualOpen(true)}
                    disabled={!draft.id || !draft.hsm.templateId}
                    className="rounded-md border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Envio manual
                  </button>
                  {!draft.id ? <p className="mt-2 text-xs text-muted-foreground">Salve a rotina antes de executar envio manual.</p> : null}
                </Section>
              ) : null}
            </div>

            <aside className="space-y-5 lg:sticky lg:top-0 lg:self-start">
              {draft.type === 'follow_up' ? (
                <section className="overflow-hidden rounded-lg border border-border bg-card/70 shadow-sm">
                  <div className="border-b border-border p-3">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Zap className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-foreground">Respostas rápidas</h3>
                          <p className="truncate text-[11px] text-muted-foreground">
                            Base para {activeFollowUpPeriodDraft.label || `Mensagem ${activeFollowUpStepIndex + 1}`}
                          </p>
                        </div>
                      </div>
                      <span className="rounded-full border border-border bg-muted px-2 py-1 text-[10px] text-muted-foreground">
                        {groupedQuickRepliesForFollowUp.reduce((total, group) => total + group.items.length, 0)} item(ns)
                      </span>
                    </div>

                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        value={quickReplySearch}
                        onChange={(event) => setQuickReplySearch(event.target.value)}
                        placeholder="Pesquisar resposta rápida"
                        className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-primary"
                      />
                    </div>

                    <div className="mt-3 rounded-lg border border-border bg-background/70 p-3 text-sm">
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Período ativo</div>
                      <div className="mt-1 font-medium text-foreground">{activeFollowUpPeriodDraft.label || `Mensagem ${activeFollowUpStepIndex + 1}`}</div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">Base aplicada: {activeFollowUpBaseTitle || 'Nenhuma'}</div>
                    </div>
                  </div>

                  <div className="max-h-[58vh] overflow-y-auto overflow-x-hidden p-3">
                    {quickReplyCategoriesQuery.isLoading ? (
                      <div className="py-8 text-center text-sm text-muted-foreground">Carregando respostas rápidas...</div>
                    ) : groupedQuickRepliesForFollowUp.length ? (
                      <div className="space-y-3">
                        {groupedQuickRepliesForFollowUp.map(({ category, items }) => {
                          const groupId = category.id || category.name;
                          const isOpen = quickReplyExpandedCategories.has(groupId);
                          return (
                            <section key={groupId} className="overflow-hidden rounded-xl border border-border bg-background/60">
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                                onClick={() => toggleQuickReplyCategory(groupId)}
                                style={{ background: `linear-gradient(90deg, ${category.color || '#94a3b8'}18, transparent)` }}
                              >
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${category.color || '#94a3b8'}22`, color: category.color || '#94a3b8' }}>
                                  <Folder className="h-3.5 w-3.5" />
                                </span>
                                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{category.name}</span>
                                <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{items.length}</span>
                                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${!isOpen ? '-rotate-90' : ''}`} />
                              </button>

                              {isOpen ? (
                                <div className="divide-y divide-border/60">
                                  {items.map((reply) => {
                                    const actions = getQuickReplyActions(reply);
                                    const selected = String(activeFollowUpPeriodDraft.quickReplyId || '') === String(reply.id || '');
                                    const primaryType = actions[0]?.type || reply.type || 'text';
                                    const Icon = quickReplyActionIcons[primaryType] || FileText;
                                    return (
                                      <button
                                        key={reply.id}
                                        type="button"
                                        onClick={() => applyQuickReplyToFollowUpStep(activeFollowUpStepIndex, reply.id)}
                                        className={`flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left transition ${selected ? 'bg-primary/10' : 'hover:bg-accent/40'}`}
                                      >
                                        <Icon className="h-4 w-4 shrink-0 text-primary" />
                                        <span className="min-w-0 flex-1">
                                          <span className="block truncate text-xs font-semibold text-foreground">{reply.title}</span>
                                          <span className="block truncate text-[11px] text-muted-foreground">{getQuickReplyPreviewText(reply) || `${actions.length} ação(ões)`}</span>
                                        </span>
                                        <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{actions.length}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </section>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex min-h-[180px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background/50 p-6 text-center">
                        <Zap className="mb-3 h-9 w-9 text-muted-foreground" />
                        <p className="text-sm font-semibold text-foreground">Nenhuma resposta rápida encontrada.</p>
                      </div>
                    )}
                  </div>
                </section>
              ) : null}
              {draft.type !== 'follow_up' ? (
                <>
              <Section title="Resumo">
                <div className="space-y-3 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-primary">{ROUTINE_TYPES[draft.type]}</span>
                    {draft.type === 'follow_up' ? (
                      <span className="rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
                        {draft.followUp.minHoursWithoutInteraction}h a {draft.followUp.maxHoursWithoutInteraction}h
                      </span>
                    ) : (
                      <span className="rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
                        {ROUTINE_RULES[draft.rule]} | {draft.ruleDays} dias
                      </span>
                    )}
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Nome</div>
                    <div className="font-medium text-foreground">{draft.name || 'Sem nome'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Status</div>
                    <div className="font-medium text-foreground">{draft.status === 'active' ? 'Ativo' : 'Inativo'}</div>
                  </div>
                  {draft.type !== 'follow_up' ? (
                  <div>
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Agenda semanal</div>
                    <div className="font-medium text-foreground">{getEnabledScheduleText(draft.weeklySchedule)}</div>
                  </div>
                  ) : null}
                  {draft.type === 'disparo' ? (
                    <>
                      <div>
                        <div className="text-xs font-semibold uppercase text-muted-foreground">HSM selecionado</div>
                        <div className="font-medium text-foreground">{draft.hsm.templateName || 'Não selecionado'}</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold uppercase text-muted-foreground">Resposta 24h</div>
                        <div className="font-medium text-foreground">
                          {dispatchReplies.find((reply) => reply.id === draft.quickReplyId)?.title || 'Não configurada'}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold uppercase text-muted-foreground">Intervalo</div>
                        <div className="font-medium text-foreground">{draft.sendIntervalSeconds || 0}s</div>
                      </div>
                    </>
                  ) : draft.type === 'follow_up' ? (
                    <>
                      <div>
                        <div className="text-xs font-semibold uppercase text-muted-foreground">Etiqueta alvo</div>
                        <div className="font-medium text-foreground">{selectedFollowUpLabel?.name || draft.followUp.targetLabelName || 'Nao definido'}</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold uppercase text-muted-foreground">Agenda de follow up</div>
                        <div className="font-medium text-foreground">{getFollowUpScheduleText(draft.followUp)}</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold uppercase text-muted-foreground">Limite</div>
                        <div className="font-medium text-foreground">{getFollowUpLimitText(draft.followUp)}</div>
                      </div>
                    </>
                  ) : (
                    <div>
                      <div className="text-xs font-semibold uppercase text-muted-foreground">Etiquetas</div>
                      <div className="font-medium text-foreground">
                        {draft.labelActions.add.length || draft.labelActions.remove.length
                          ? `${draft.labelActions.add.length} adicionar | ${draft.labelActions.remove.length} remover`
                          : 'Nenhuma etiqueta selecionada.'}
                      </div>
                    </div>
                  )}
                  {draft.type !== 'follow_up' ? (
                  <div>
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Exceções</div>
                    <div className="font-medium text-foreground">{draft.exceptions.length ? draft.exceptions.join(', ') : 'Nenhuma'}</div>
                  </div>
                  ) : null}
                </div>
              </Section>

              {draft.type === 'disparo' ? (
                <Section title="Prévia da rotina">
                  <TemplatePreview preview={preview} />
                </Section>
              ) : draft.type === 'follow_up' ? (
                <Section title="Como essa rotina funciona">
                  <ol className="space-y-2 text-sm text-muted-foreground">
                    <li>1. Agrupa conversas pelo telefone normalizado do cliente.</li>
                    <li>2. Confere se o cliente possui a etiqueta alvo configurada.</li>
                    <li>3. Bloqueia envio fora da janela Meta de 24h.</li>
                    <li>4. Evita duplicar follow up quando o cliente respondeu ou ja atingiu o limite.</li>
                  </ol>
                </Section>
              ) : (
                <Section title="Como essa rotina funciona">
                  <ol className="space-y-2 text-sm text-muted-foreground">
                    <li>1. Localiza os contatos pelas etiquetas marcadas em remover.</li>
                    <li>2. Aplica as etiquetas marcadas em adicionar.</li>
                    <li>3. Remove as etiquetas marcadas em remover.</li>
                    <li>4. Registra o total alterado no card e no log operacional.</li>
                  </ol>
                </Section>
              )}
                </>
              ) : null}
            </aside>
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-border bg-background px-5 py-4">
          <button type="button" onClick={onCancel} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted">
            Cancelar
          </button>
          <button type="submit" disabled={isSaving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
            {isSaving ? 'Salvando...' : 'Salvar rotina'}
          </button>
        </footer>
      </div>
      <ManualRunDialog
        open={manualOpen}
        routine={draft}
        template={selectedTemplate}
        customers={customers}
        sampleCustomer={sampleCustomer}
        isRunning={isManualRunning}
        onClose={() => setManualOpen(false)}
        onConfirm={(customerIds) => onManualRun?.(draft, customerIds)}
      />
    </form>
  );
}

