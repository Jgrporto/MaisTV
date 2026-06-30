import { Activity, AlertCircle, CheckCircle2, PauseCircle, Send } from 'lucide-react';

const Stat = ({ icon: Icon, label, value, tone = 'default', description = null }) => {
  const toneClass =
    tone === 'success'
      ? 'text-emerald-600'
      : tone === 'warning'
        ? 'text-amber-600'
        : tone === 'error'
          ? 'text-destructive'
          : 'text-muted-foreground';

  const DescriptionIcon = description?.icon || null;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold leading-none text-foreground">{value}</div>
        </div>
        <span className={`hidden h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30 sm:inline-flex ${toneClass}`}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      {description ? (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          {DescriptionIcon ? <DescriptionIcon className={`h-3.5 w-3.5 ${description.toneClass || ''}`} /> : null}
          <span>{description.text}</span>
        </div>
      ) : null}
    </div>
  );
};

export default function StatsHeader({ routines = [] }) {
  const active = routines.filter((routine) => routine.status === 'active').length;
  const paused = routines.filter((routine) => routine.status !== 'active').length;
  const lastSent = routines.reduce((total, routine) => total + Number(routine?.lastRunSummary?.sent || 0), 0);
  const recentErrors = routines.reduce((total, routine) => total + Number(routine?.lastRunSummary?.failed || 0), 0);

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Stat icon={Activity} label="Total Rotinas" value={routines.length} />
      <Stat icon={CheckCircle2} label="Ativas" value={active} tone="success" />
      <Stat icon={PauseCircle} label="Pausadas" value={paused} tone="warning" />
      <Stat
        icon={Send}
        label="Últimos envios OK"
        value={lastSent}
        tone="success"
        description={{
          icon: AlertCircle,
          text: `${recentErrors} erro(s) recente(s)`,
          toneClass: recentErrors > 0 ? 'text-destructive' : 'text-muted-foreground',
        }}
      />
    </div>
  );
}
