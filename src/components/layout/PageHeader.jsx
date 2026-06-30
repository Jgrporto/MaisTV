import React from 'react';

import { cn } from '@/lib/utils';

export default function PageHeader({ title, description, actions, className }) {
  return (
    <div className={cn('flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between', className)}>
      <div className="space-y-1">
        <h1 className="text-[28px] font-bold tracking-[-0.02em] text-foreground">{title}</h1>
        {description ? <p className="max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
