import React, { useEffect, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const DEFAULT_FORM = {
  name: '',
  description: '',
  color: '#14B8A6',
};

export default function LabelFormDialog({
  open,
  onOpenChange,
  onSubmit,
  initialValue = null,
  title = 'Nova etiqueta',
  description = 'Defina título, cor e contexto operacional para a etiqueta personalizada.',
  submitLabel = 'Salvar etiqueta',
}) {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;

    setForm({
      name: String(initialValue?.name || '').trim(),
      description: String(initialValue?.description || '').trim(),
      color: String(initialValue?.color || DEFAULT_FORM.color).trim() || DEFAULT_FORM.color,
    });
    setIsSubmitting(false);
  }, [initialValue, open]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) return;

    setIsSubmitting(true);

    try {
      await onSubmit({
        name: form.name.trim(),
        description: form.description.trim(),
        color: form.color.trim() || DEFAULT_FORM.color,
      });
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const previewColor = /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(form.color) ? form.color : DEFAULT_FORM.color;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Título</label>
            <Input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Ex.: Reativacao VIP"
              maxLength={40}
              disabled={isSubmitting}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Descrição</label>
            <Textarea
              value={form.description}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
              placeholder="Quando usar esta etiqueta e o que ela sinaliza para a operação."
              className="min-h-[96px]"
              maxLength={180}
              disabled={isSubmitting}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Cor</label>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
              <input
                type="color"
                value={previewColor}
                onChange={(event) => setForm((current) => ({ ...current, color: event.target.value }))}
                className="h-10 w-14 cursor-pointer rounded border border-border bg-transparent"
                disabled={isSubmitting}
              />
              <Input
                value={form.color}
                onChange={(event) => setForm((current) => ({ ...current, color: event.target.value }))}
                placeholder="#14B8A6"
                className="h-9"
                disabled={isSubmitting}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting || !form.name.trim()}>
              {isSubmitting ? 'Salvando...' : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
