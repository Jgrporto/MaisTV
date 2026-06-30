import React from 'react';

import { cn } from '@/lib/utils';

export default function PageShell({ className, children }) {
  return (
    <div className={cn('mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-5 py-5 lg:px-6 lg:py-6', className)}>
      {children}
    </div>
  );
}
