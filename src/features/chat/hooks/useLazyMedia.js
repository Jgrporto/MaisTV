import { useCallback, useEffect, useRef, useState } from 'react';
import { MEDIA_LAZY_ROOT_MARGIN } from '@/lib/performance-config';

export function useLazyMedia({ enabled = true, loadOnInteraction = false, rootMargin = MEDIA_LAZY_ROOT_MARGIN } = {}) {
  const targetRef = useRef(null);
  const [isNearViewport, setIsNearViewport] = useState(!enabled || loadOnInteraction);
  const [isActivated, setIsActivated] = useState(!loadOnInteraction);

  useEffect(() => {
    if (!enabled || loadOnInteraction || isNearViewport) return undefined;
    const element = targetRef.current;
    if (!element || typeof IntersectionObserver !== 'function') {
      setIsNearViewport(true);
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setIsNearViewport(true);
      observer.disconnect();
    }, { rootMargin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, isNearViewport, loadOnInteraction, rootMargin]);

  const activate = useCallback(() => setIsActivated(true), []);
  return {
    targetRef,
    activate,
    shouldLoad: enabled ? (loadOnInteraction ? isActivated : isNearViewport) : true,
  };
}
