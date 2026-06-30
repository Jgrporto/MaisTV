import React from 'react';

import { Badge } from '@/components/ui/badge';
import { getLabelBadgeStyle } from '@/lib/labels';
import { cn } from '@/lib/utils';

export default function LabelBadge({ label, className, compact = false }) {
  if (!label) return null;

  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full border font-semibold',
        compact ? 'h-4 px-1.5 text-[9px] leading-none' : 'h-5 px-2 text-[10px] leading-none',
        className
      )}
      style={getLabelBadgeStyle(label)}
    >
      {label.name}
    </Badge>
  );
}
