const labels = {
  active: 'Ativa',
  inactive: 'Pausado',
  paused: 'Pausado',
  draft: 'Rascunho',
};

const classes = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
  inactive: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  paused: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  draft: 'border-slate-500/30 bg-slate-500/10 text-slate-600',
};

export default function StatusBadge({ status }) {
  const key = ['active', 'inactive', 'paused', 'draft'].includes(status) ? status : 'inactive';
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium leading-none ${classes[key]}`}>{labels[key]}</span>;
}
