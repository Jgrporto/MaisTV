import React from 'react';

import { cn } from '@/lib/utils';
import { getServiceIconMeta } from '@/lib/services';

export default function ServiceIconBadge({
  service,
  className = '',
  iconClassName = '',
  title = '',
}) {
  const iconMeta = getServiceIconMeta(service?.icon_key);
  const Icon = iconMeta.icon;
  const accessibleTitle = title || service?.name || iconMeta.label;

  return (
    <span
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-full border',
        className,
      )}
      style={{
        color: '#FFFFFF',
        borderColor: iconMeta.color,
        backgroundColor: iconMeta.color,
      }}
      title={accessibleTitle}
    >
      <Icon className={cn('h-3.5 w-3.5', iconClassName)} />
    </span>
  );
}
