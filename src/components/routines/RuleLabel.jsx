export default function RuleLabel({ routine }) {
  const audience = routine?.audience || {};
  const type = audience.type === 'manual' ? 'Seleção manual' : 'Filtros da base';
  const scheduledTime = routine?.scheduledTime || '09:00';
  const intervalSeconds = Math.round((Number(routine?.sendIntervalMs) || 0) / 1000);

  return (
    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
      <span className="rounded-full bg-muted px-2.5 py-1">{type}</span>
      <span className="rounded-full bg-muted px-2.5 py-1">{scheduledTime} America/São_Paulo</span>
      <span className="rounded-full bg-muted px-2.5 py-1">Intervalo {intervalSeconds}s</span>
    </div>
  );
}
