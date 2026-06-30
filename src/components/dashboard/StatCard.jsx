import React from 'react';

import { cn } from '@/lib/utils';

export default function StatCard({ title, value, subtitle, icon: Icon, trend, trendUp }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5 shadow-[0_2px_4px_rgba(0,0,0,0.05)] transition-shadow duration-200 hover:shadow-[0_8px_20px_rgba(0,0,0,0.08)]">
      <div className="mb-4 flex items-start justify-between">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        {trend ? (
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-[11px] font-semibold',
              trendUp ? 'bg-[#E6F7ED] text-primary' : 'bg-[#F8D7DA] text-destructive'
            )}
          >
            {trendUp ? '↑' : '↓'} {trend}
          </span>
        ) : null}
      </div>
      <p className="text-3xl font-bold tracking-[-0.02em] text-foreground">{value}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{title}</p>
      {subtitle ? <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p> : null}
    </div>
  );
}
