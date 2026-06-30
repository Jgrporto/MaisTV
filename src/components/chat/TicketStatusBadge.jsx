import React from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STATUS_LABELS = {
  open: 'Ticket aberto',
  in_analysis: 'Em analise',
  waiting_customer: 'Aguardando cliente',
  resolved: 'Resolvido',
  cancelled: 'Cancelado',
};

const STATUS_CLASSES = {
  open: 'border-amber-500/25 bg-amber-500/10 text-amber-700',
  in_analysis: 'border-blue-500/25 bg-blue-500/10 text-blue-700',
  waiting_customer: 'border-violet-500/25 bg-violet-500/10 text-violet-700',
  resolved: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700',
  cancelled: 'border-slate-500/25 bg-slate-500/10 text-slate-600',
  none: 'border-border bg-muted/30 text-muted-foreground',
};

export default function TicketStatusBadge({ summary, onClick }) {
  const activeCount = Number(summary?.open || 0);
  const status = activeCount > 0 ? 'open' : 'none';
  const label = status === 'none' ? 'Sem ticket' : STATUS_LABELS[status] || 'Ticket';

  return (
    <button type="button" onClick={onClick} className="inline-flex">
      <Badge
        variant="outline"
        className={cn('h-5 cursor-pointer gap-1 text-[10px] transition hover:brightness-95', STATUS_CLASSES[status])}
      >
        <span>{label}</span>
        {activeCount > 1 ? <span className="font-semibold">· {activeCount}</span> : null}
      </Badge>
    </button>
  );
}
