import { Edit3, Loader2, MoreHorizontal, Play, Power, Trash2 } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import StatusBadge from './StatusBadge';
import {
  ROUTINE_RULES,
  ROUTINE_TYPES,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  formatDateTime,
  getEnabledScheduleText,
  getFollowUpScheduleText,
  getFollowUpTargetLabelText,
  getNextRoutineRunAt,
  normalizeFollowUpConfig,
} from './utils';

const findLabelNames = (labels = [], ids = []) =>
  ids
    .map((id) => labels.find((label) => label.id === id)?.name)
    .filter(Boolean)
    .join(', ');

const compactValue = (value, fallback = '-') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const getFirstScheduleTime = (routine, type) => {
  if (type === 'follow_up') {
    const config = normalizeFollowUpConfig(routine.followUp);
    const step = config.steps.find((item) => item.enabled);
    return step ? String(step.time || '09:00').slice(0, 5) : '-';
  }

  const schedule = routine.weeklySchedule || {};
  const firstDay = WEEKDAY_KEYS.find((key) => schedule?.[key]?.enabled);
  return firstDay ? String(schedule[firstDay]?.time || routine.scheduledTime || '08:00').slice(0, 5) : String(routine.scheduledTime || '-').slice(0, 5);
};

const getCompactWeeklyScheduleText = (weeklySchedule = {}) =>
  WEEKDAY_KEYS.filter((key) => weeklySchedule?.[key]?.enabled)
    .map((key) => WEEKDAY_LABELS[key])
    .join('-') || 'Nenhum dia ativo';

const Metric = ({ label, value }) => (
  <div className="min-w-0 rounded-md border border-border bg-background px-3 py-2 shadow-sm">
    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
    <div className="mt-1 truncate text-base font-semibold text-foreground" title={String(value || '-')}>
      {value || '-'}
    </div>
  </div>
);

const Detail = ({ label, value }) => (
  <div className="min-w-0 text-xs leading-relaxed">
    <span className="font-semibold text-muted-foreground">{label}: </span>
    <span className="break-words text-foreground">{value || '-'}</span>
  </div>
);

export default function RoutineCard({ routine, templateName, labels = [], isRunning, isToggling = false, onEdit, onDelete, onRun, onToggle }) {
  const type = routine.type === 'etiqueta' ? 'etiqueta' : routine.type === 'follow_up' ? 'follow_up' : 'disparo';
  const addLabels = findLabelNames(labels, routine.labelActions?.add || []);
  const removeLabels = findLabelNames(labels, routine.labelActions?.remove || []);
  const intervalSeconds = routine.sendIntervalSeconds || Math.max(1, Math.round(Number(routine.sendIntervalMs || 0) / 1000));
  const nextRunAt = routine.nextRunAt || getNextRoutineRunAt(routine);
  const summary = routine.lastRunSummary || {};
  const firstTime = getFirstScheduleTime(routine, type);

  const ruleText =
    type === 'disparo'
      ? `${ROUTINE_RULES[routine.rule] || '-'} | ${Number.isFinite(Number(routine.ruleDays)) ? Number(routine.ruleDays) : 0} dias`
      : null;
  const labelsText = `${routine.labelActions?.add?.length || 0} add / ${routine.labelActions?.remove?.length || 0} rem`;
  const actionsText = [addLabels ? `Adicionar ${addLabels}` : '', removeLabels ? `Remover ${removeLabels}` : ''].filter(Boolean).join(' | ') || 'Nenhuma ação configurada';
  const scheduleText = type === 'follow_up' ? getFollowUpScheduleText(routine.followUp) : `${getCompactWeeklyScheduleText(routine.weeklySchedule)} ${firstTime}`;

  const metrics =
    type === 'follow_up'
      ? [
          { label: 'HORÁRIO INÍCIO', value: firstTime },
          { label: 'ETIQUETA ALVO', value: getFollowUpTargetLabelText(routine.followUp) },
          { label: 'ENVIADOS', value: summary.sent ?? 0 },
          { label: 'ÚLTIMA EXECUÇÃO', value: formatDateTime(routine.lastRunAt) },
        ]
      : type === 'etiqueta'
        ? [
            { label: 'HORÁRIO', value: firstTime },
            { label: 'ETIQUETAS', value: labelsText },
            { label: 'ALTERADOS', value: summary.changed ?? 0 },
            { label: 'ÚLTIMA EXECUÇÃO', value: formatDateTime(routine.lastRunAt) },
          ]
        : [
            { label: 'HORÁRIO', value: firstTime },
            { label: 'INTERVALO', value: `${intervalSeconds}s` },
            { label: 'ENVIADOS', value: summary.sent ?? 0 },
            { label: 'ÚLTIMA EXECUÇÃO', value: formatDateTime(routine.lastRunAt) },
          ];

  return (
    <article className={`relative overflow-hidden rounded-lg border bg-card p-4 shadow-sm transition hover:border-primary/40 hover:shadow-md ${isRunning ? 'border-primary/50 shadow-primary/10' : 'border-border'}`}>
      <div className={`absolute inset-x-0 top-0 h-1 ${isRunning ? 'bg-primary' : routine.status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-base font-semibold text-foreground">{routine.name}</h3>
            <StatusBadge status={routine.status} />
            {isRunning ? (
              <span className="inline-flex rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium leading-none text-primary">
                Executando
              </span>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span className="rounded-full border border-border bg-muted/30 px-2 py-0.5 text-xs font-medium text-foreground">{ROUTINE_TYPES[type]}</span>
            {ruleText ? <span>{ruleText}</span> : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 self-start">
          <button
            type="button"
            onClick={onRun}
            disabled={isRunning}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Executar
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground" title="Ações da rotina">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={onEdit}>
                <Edit3 className="h-4 w-4" />
                Editar
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onToggle} disabled={isToggling}>
                {isToggling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                {routine.status === 'active' ? 'Pausar' : 'Ativar'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
                <Trash2 className="h-4 w-4" />
                Excluir
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Metric key={metric.label} label={metric.label} value={metric.value} />
        ))}
      </div>

      <div className="mt-4 grid gap-2 border-t border-border pt-3">
        {type === 'disparo' ? <Detail label="HSM" value={compactValue(templateName || routine.hsm?.templateName || routine.templateName, 'Não selecionado')} /> : null}
        {type === 'etiqueta' ? <Detail label="Ações" value={actionsText} /> : null}
        <Detail label="Agenda" value={scheduleText || getEnabledScheduleText(routine.weeklySchedule)} />
        <Detail label="Próxima" value={formatDateTime(nextRunAt)} />
      </div>
    </article>
  );
}
