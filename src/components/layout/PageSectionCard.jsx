import React from 'react';

import { cn } from '@/lib/utils';

export default function PageSectionCard({ className, children }) {
  return (
    <section
      className={cn(
        'rounded-lg border border-border bg-card shadow-[0_2px_4px_rgba(0,0,0,0.05)]',
        className
      )}
    >
      {children}
    </section>
  );
}
