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

  const activeIndex = useMemo(
    () => items.findIndex((item) => item.id === activeId),
    [activeId, items]
  );
  const activeItem = activeIndex >= 0 ? items[activeIndex] : items[0] || null;

  useEffect(() => {
    if (!open) return;
    setZoom(1);
  }, [activeItem?.id, open]);

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
                  if (!activeItem.url) return;
                  window.open(activeItem.url, '_blank', 'noopener,noreferrer');
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
                {activeItem.kind === 'video' ? (
                  <video
                    controls
                    preload="metadata"
                    className="max-h-full max-w-full rounded-2xl object-contain transition-transform duration-150"
                    style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                  >
                    <source src={activeItem.url} type={activeItem.mimeType || 'video/mp4'} />
                  </video>
                ) : (
                  <img
                    src={activeItem.url}
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
                    {item.kind === 'video' ? (
                      <video className="h-16 w-16 object-cover">
                        <source src={item.url} type={item.mimeType || 'video/mp4'} />
                      </video>
                    ) : (
                      <img src={item.url} alt={item.name || 'Midia'} className="h-16 w-16 object-cover" />
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
