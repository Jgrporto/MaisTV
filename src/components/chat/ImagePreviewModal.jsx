import React, { useEffect, useState } from 'react';
import { X, Send, Plus, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { validateWhatsappMediaFile } from '@/lib/whatsapp-media';

function normalizeImageEntry(item) {
  if (!item?.file || !item?.url) return null;
  return {
    ...item,
    caption: String(item?.caption || ''),
  };
}

export default function ImagePreviewModal({ files, onSend, onClose }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [imageList, setImageList] = useState(files);

  useEffect(() => {
    setImageList(Array.isArray(files) ? files.map(normalizeImageEntry).filter(Boolean) : []);
    setSelectedIndex(0);
  }, [files]);

  const handleAddMore = async (event) => {
    const newFiles = Array.from(event.target.files || []);
    event.target.value = '';
    if (!newFiles.length) return;

    const validEntries = [];
    for (const file of newFiles) {
      const validation = await validateWhatsappMediaFile(file);
      if (!validation.ok || validation.kind !== 'image') {
        toast.error(validation.reason || 'Nao foi possivel anexar esta imagem.');
        continue;
      }

      validEntries.push({ file, url: URL.createObjectURL(file), caption: '' });
    }

    if (validEntries.length === 0) return;

    setImageList((currentItems) => [...currentItems, ...validEntries]);
  };

  const handleRemove = (index) => {
    if (imageList.length === 1) {
      onClose();
      return;
    }
    setImageList((prev) => prev.filter((_, i) => i !== index));
    setSelectedIndex((prev) => {
      if (prev > index) return prev - 1;
      return Math.min(prev, imageList.length - 2);
    });
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSend = () => {
    if (sending) return;
    setSending(true);
    onClose();
    void onSend({
      items: imageList,
    });
  };

  const current = imageList[selectedIndex];
  const currentCaption = String(current?.caption || '');

  const handleCaptionChange = (nextCaption) => {
    setImageList((currentItems) =>
      currentItems.map((item, index) =>
        index === selectedIndex
          ? {
              ...item,
              caption: nextCaption,
            }
          : item
      )
    );
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[#111] overflow-hidden">
      <div className="flex flex-col w-full h-full bg-[#111]">

        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
          <button onClick={onClose} className="text-white/70 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
          <span className="text-white/60 text-sm font-medium">
            {imageList.length} {imageList.length === 1 ? 'imagem' : 'imagens'}
          </span>
          <div className="w-5" />
        </div>

        {/* Main image preview */}
        <div className="flex-1 flex items-center justify-center bg-black/40 relative overflow-hidden">
          <img
            src={current?.url}
            alt="preview"
            className="max-w-full max-h-full object-contain"
          />
        </div>

        {/* Caption input */}
        <div className="px-4 py-3 bg-[#111] border-t border-white/10 flex-shrink-0">
          <div className="flex items-center gap-2 bg-white/10 rounded-full px-4 py-2">
            <Pencil className="w-4 h-4 text-white/40 flex-shrink-0" />
            <textarea
              value={currentCaption}
              onChange={(e) => handleCaptionChange(e.target.value)}
              placeholder="Digite uma mensagem"
              rows={1}
              className="max-h-28 flex-1 resize-none bg-transparent text-white text-sm leading-relaxed placeholder:text-white/40 outline-none"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
            />
          </div>
        </div>

        {/* Bottom bar: thumbnails + send */}
        <div className="px-4 pb-4 flex items-center gap-3 bg-[#111] flex-shrink-0">
          {/* Thumbnails */}
          <div className="flex-1 flex items-center gap-2 overflow-x-auto pb-1">
            {imageList.map((item, i) => (
              <div
                key={i}
                className={cn(
                  "relative flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden cursor-pointer border-2 transition-all",
                  i === selectedIndex ? "border-primary" : "border-transparent opacity-60 hover:opacity-90",
                  item.caption?.trim() ? "ring-1 ring-white/30" : ""
                )}
                onClick={() => setSelectedIndex(i)}
                title={item.caption?.trim() ? 'Imagem com legenda' : 'Imagem sem legenda'}
              >
                <img src={item.url} alt="" className="w-full h-full object-cover" />
                <button
                  onClick={(e) => { e.stopPropagation(); handleRemove(i); }}
                  className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 rounded-full flex items-center justify-center hover:bg-black/90 transition-colors"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              </div>
            ))}

            {/* Add more */}
            <label className="flex-shrink-0 w-14 h-14 rounded-lg border-2 border-dashed border-white/30 flex items-center justify-center cursor-pointer hover:border-white/60 transition-colors">
              <Plus className="w-5 h-5 text-white/50" />
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => void handleAddMore(event)}
              />
            </label>
          </div>

          {/* Send button */}
          <Button
            onClick={handleSend}
            disabled={sending}
            className="h-12 w-12 rounded-full bg-primary hover:bg-primary/90 flex-shrink-0 shadow-lg"
            size="icon"
          >
            {sending ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
