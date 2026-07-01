import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { format } from 'date-fns';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const MEDIA_STAGE_CLASS =
  'relative flex h-[min(74vh,820px)] w-[min(78vw,1100px)] max-w-full items-center justify-center overflow-hidden rounded-3xl bg-[#111] shadow-2xl';

export default function ChatMediaLightbox({
  open,
  onOpenChange,
  items = [],
  activeId = '',
  onActiveIdChange,
}) {
  const [zoom, setZoom] = useState(1);
  const [resolvedUrls, setResolvedUrls] = useState({});
  const [loadError, setLoadError] = useState('');

  const activeIndex = useMemo(
    () => items.findIndex((item) => item.id === activeId),
    [activeId, items]
  );
  const activeItem = activeIndex >= 0 ? items[activeIndex] : items[0] || null;
  const activeUrl = activeItem ? (resolvedUrls[activeItem.id] || activeItem.url || '') : '';

  useEffect(() => {
    if (!open) {
      setResolvedUrls({});
      return;
    }
    setZoom(1);
    setLoadError('');
  }, [activeItem?.id, open]);

  useEffect(() => {
    if (!open || !activeItem || activeUrl || typeof activeItem.resolveUrl !== 'function') return undefined;
    let active = true;
    void activeItem.resolveUrl().then((url) => {
      if (!active) return;
      if (!url) throw new Error('URL da midia indisponivel.');
      setResolvedUrls((current) => ({ ...current, [activeItem.id]: url }));
    }).catch((error) => {
      if (active) setLoadError(error?.message || 'Nao foi possivel abrir a midia.');
    });
    return () => { active = false; };
  }, [activeItem, activeUrl, open]);

  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'ArrowLeft' && activeIndex > 0) {
        onActiveIdChange(items[activeIndex - 1]?.id || '');
      } else if (event.key === 'ArrowRight' && activeIndex < items.length - 1) {
        onActiveIdChange(items[activeIndex + 1]?.id || '');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, items, onActiveIdChange, open]);

  if (!activeItem) {
    return null;
  }

  const canGoPrev = activeIndex > 0;
  const canGoNext = activeIndex >= 0 && activeIndex < items.length - 1;
  const caption = String(activeItem.caption || '').trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[100vh] max-w-none rounded-none border-0 bg-black/95 p-0 text-white [&>button:last-child]:hidden">
        <DialogTitle className="sr-only">Visualizar midia</DialogTitle>

        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{activeItem.name || 'Midia'}</p>
              <p className="text-xs text-white/55">
                {activeItem.senderName || 'Agente'} ·{' '}
                {activeItem.createdDate ? format(new Date(activeItem.createdDate), 'dd/MM/yyyy HH:mm') : '--'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-full text-white/80 hover:bg-white/10 hover:text-white"
                onClick={() => {
                  if (!activeUrl) return;
                  window.open(activeUrl, '_blank', 'noopener,noreferrer');
                }}
              >
                <Download data-icon="inline-start" />
                Baixar
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="rounded-full text-white/80 hover:bg-white/10 hover:text-white"
                onClick={() => onOpenChange(false)}
              >
                <X />
              </Button>
            </div>
          </div>

          <div className="relative flex-1 overflow-hidden">
            {canGoPrev ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute left-4 top-1/2 z-20 size-11 -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-black/55"
                onClick={() => onActiveIdChange(items[activeIndex - 1]?.id || '')}
              >
                <ChevronLeft />
              </Button>
            ) : null}

            {canGoNext ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-4 top-1/2 z-20 size-11 -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-black/55"
                onClick={() => onActiveIdChange(items[activeIndex + 1]?.id || '')}
              >
                <ChevronRight />
              </Button>
            ) : null}

            <div className="flex h-full items-center justify-center px-[5vw] py-6">
              <div
                className={MEDIA_STAGE_CLASS}
                onWheel={(event) => {
                  if (activeItem.kind !== 'image' && activeItem.kind !== 'video' && activeItem.kind !== 'sticker') {
                    return;
                  }

                  event.preventDefault();
                  setZoom((currentZoom) => clamp(currentZoom + (event.deltaY < 0 ? 0.12 : -0.12), 1, 4));
                }}
              >
                {!activeUrl ? (
                  <div className="px-6 text-center text-sm text-white/70">
                    {loadError || 'Carregando midia...'}
                  </div>
                ) : activeItem.kind === 'video' ? (
                  <video
                    controls
                    preload="metadata"
                    className="max-h-full max-w-full rounded-2xl object-contain transition-transform duration-150"
                    style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                  >
                    <source src={activeUrl} type={activeItem.mimeType || 'video/mp4'} />
                  </video>
                ) : (
                  <img
                    src={activeUrl}
                    alt={activeItem.name || 'Midia'}
                    className="max-h-full max-w-full rounded-2xl object-contain transition-transform duration-150"
                    style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                  />
                )}
              </div>
            </div>
          </div>

          <div className="border-t border-white/10 px-5 py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-xs text-white/55">Zoom: {(zoom * 100).toFixed(0)}%</div>
              {caption ? <p className="line-clamp-2 max-w-[70ch] text-sm text-white/70">{caption}</p> : <span />}
            </div>

            <ScrollArea className="w-full whitespace-nowrap">
              <div className="flex items-center gap-3 pr-4">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(
                      'overflow-hidden rounded-2xl border transition-colors',
                      item.id === activeItem.id
                        ? 'border-primary bg-primary/10'
                        : 'border-white/10 bg-white/5 hover:border-white/20'
                    )}
                    onClick={() => onActiveIdChange(item.id)}
                  >
                    {item.url ? (item.kind === 'video' ? (
                      <video className="h-16 w-16 object-cover" preload="none">
                        <source src={item.url} type={item.mimeType || 'video/mp4'} />
                      </video>
                    ) : (
                      <img src={item.url} alt={item.name || 'Midia'} loading="lazy" className="h-16 w-16 object-cover" />
                    )) : (
                      <div className="flex h-16 w-16 items-center justify-center bg-white/5 text-[10px] text-white/60">Midia</div>
                    )}
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
