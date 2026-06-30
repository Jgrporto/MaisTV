import React, { useEffect, useState } from 'react';
import { useLazyMedia } from '../hooks/useLazyMedia';

export default function LazyMedia({
  children,
  className = '',
  loadOnInteraction = false,
  placeholder = null,
  rootMargin = undefined,
  onActivate = undefined,
  sourceUrl = '',
  resolveSource = undefined,
}) {
  const { targetRef, shouldLoad, activate } = useLazyMedia({ loadOnInteraction, rootMargin });
  const [resolvedSource, setResolvedSource] = useState(sourceUrl);

  useEffect(() => {
    setResolvedSource(sourceUrl);
  }, [sourceUrl]);

  useEffect(() => {
    if (!shouldLoad || resolvedSource || typeof resolveSource !== 'function') return undefined;
    let active = true;
    void resolveSource().then((url) => {
      if (active && url) setResolvedSource(url);
    }).catch(() => {});
    return () => {
      active = false;
    };
  }, [resolveSource, resolvedSource, shouldLoad]);
  const handleActivate = () => {
    activate();
    onActivate?.();
  };
  const canRenderMedia = shouldLoad && (Boolean(resolvedSource) || typeof resolveSource !== 'function');

  return (
    <div ref={targetRef} className={className}>
      {canRenderMedia
        ? (typeof children === 'function' ? children({ activate: handleActivate, src: resolvedSource }) : children)
        : (typeof placeholder === 'function' ? placeholder({ activate: handleActivate }) : placeholder)}
    </div>
  );
}
