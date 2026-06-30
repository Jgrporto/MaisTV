import React, { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

function buildInitials(name) {
  const safeName = String(name || '').trim();
  if (!safeName) return '?';

  const parts = safeName.split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) || '';
  const second = parts.length > 1 ? parts[1]?.charAt(0) || '' : '';
  return String(`${first}${second}` || '?').toUpperCase();
}

export default function ContactAvatar({
  src,
  name,
  className,
  fallbackClassName,
  textClassName,
}) {
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [src]);

  if (src && !hasError) {
    return (
      <img
        src={src}
        alt={name || 'Contato'}
        className={cn('rounded-full object-cover', className)}
        onError={() => setHasError(true)}
        loading="lazy"
      />
    );
  }

  return (
    <div
      className={cn(
        'rounded-full bg-gradient-to-br from-primary/40 to-primary flex items-center justify-center font-bold text-white',
        className,
        fallbackClassName
      )}
      aria-label={name || 'Contato'}
      title={name || 'Contato'}
    >
      <span className={cn(textClassName)}>{buildInitials(name)}</span>
    </div>
  );
}
