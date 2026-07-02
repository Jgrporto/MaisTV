import React, { useEffect, useMemo, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  DEFAULT_SERVICE_ICON_KEY,
  EMPTY_SERVICE,
  getServiceIconMeta,
  normalizeService,
  SERVICE_ICON_OPTIONS,
} from '@/lib/services';

const buildFormState = (value = null) => {
  const normalized = normalizeService(value || EMPTY_SERVICE);
  return {
    id: normalized.id,
    name: normalized.name,
    description: normalized.description,
    user_ids: normalized.user_ids,
    user_emails: normalized.user_emails,
    label_ids: normalized.label_ids,
    icon_key: normalized.icon_key || DEFAULT_SERVICE_ICON_KEY,
  };
};

function ToggleList({
  title,
  description,
  items,
  selectedIds,
  onToggle,
  disabled = false,
  emptyMessage = 'Nenhuma opcao disponivel.',
  renderLabel,
}) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>

      <div className="max-h-44 space-y-2 overflow-y-auto rounded-xl border border-border bg-secondary/15 p-3">
        {items.length === 0 ? (
          <div className="text-xs text-muted-foreground">{emptyMessage}</div>
        ) : (
          items.map((item) => (
            <label
              key={item.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-2"
            >
              <Checkbox
                checked={selectedIds.includes(item.id)}
                onCheckedChange={(checked) => onToggle(item, Boolean(checked))}
                disabled={disabled}
              />
              <span className="min-w-0 space-y-1">
                {renderLabel(item)}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

export default function ServiceFormDialog({
  open,
  onOpenChange,
  onSubmit,
  mode = 'create',
  initialValue = null,
  users = [],
  labelOptions = [],
}) {
  const [form, setForm] = useState(buildFormState(initialValue));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isReadOnly = mode === 'view';

  useEffect(() => {
    if (!open) {
      return;
    }

    setForm(buildFormState(initialValue));
    setIsSubmitting(false);
  }, [initialValue, open]);

  const selectedIconMeta = useMemo(() => getServiceIconMeta(form.icon_key), [form.icon_key]);
  const SelectedIcon = selectedIconMeta.icon;

  const handleToggleArray = (field, itemId, checked) => {
    setForm((current) => {
      const currentItems = Array.isArray(current[field]) ? current[field] : [];
      const nextItems = checked
        ? Array.from(new Set([...currentItems, itemId]))
        : currentItems.filter((value) => value !== itemId);

      return {
        ...current,
        [field]: nextItems,
      };
    });
  };

  const handleToggleUser = (user, checked) => {
    setForm((current) => {
      const currentIds = Array.isArray(current.user_ids) ? current.user_ids : [];
      const currentEmails = Array.isArray(current.user_emails) ? current.user_emails : [];
      const userId = String(user?.id || '').trim();
      const userEmail = String(user?.email || '').trim().toLowerCase();

      return {
        ...current,
        user_ids: checked
          ? Array.from(new Set(userId ? [...currentIds, userId] : currentIds))
          : currentIds.filter((value) => value !== userId),
        user_emails: checked
          ? Array.from(new Set(userEmail ? [...currentEmails, userEmail] : currentEmails))
          : currentEmails.filter((value) => value !== userEmail),
      };
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isReadOnly) {
      onOpenChange(false);
      return;
    }

    if (!form.name.trim()) {
      return;
    }

    setIsSubmitting(true);

    try {
      await onSubmit({
        name: form.name.trim(),
        description: form.description.trim(),
        phone_numbers: [],
        user_ids: form.user_ids,
        user_emails: form.user_emails,
        label_ids: form.label_ids,
        icon_key: form.icon_key,
      });
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const title =
    mode === 'create' ? 'Criar servico' : mode === 'edit' ? 'Editar servico' : 'Visualizar servico';
  const description =
    mode === 'create'
      ? 'Cadastre a fila, os usuarios responsaveis e as etiquetas que definem o destino operacional.'
      : 'Revise ou ajuste a configuracao operacional deste servico.';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Nome</label>
              <Input
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                disabled={isReadOnly || isSubmitting}
                maxLength={60}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Icone do servico</label>
              <div className="rounded-xl border border-border bg-secondary/15 p-3">
                <div className="mb-3 flex items-center gap-3">
                  <span
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full border"
                    style={{
                      color: selectedIconMeta.color,
                      borderColor: `${selectedIconMeta.color}33`,
                      backgroundColor: `${selectedIconMeta.color}1A`,
                    }}
                    >
                      <SelectedIcon className="h-5 w-5" />
                    </span>
                  <div>
                    <div className="text-sm font-medium text-foreground">{selectedIconMeta.label}</div>
                    <div className="text-xs text-muted-foreground">
                      Escolha um icone fixo para representar o servico no atendimento.
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {SERVICE_ICON_OPTIONS.map((option) => {
                    const Icon = option.icon;
                    const isSelected = form.icon_key === option.id;

                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => !isReadOnly && setForm((current) => ({ ...current, icon_key: option.id }))}
                        disabled={isReadOnly || isSubmitting}
                        className={cn(
                          'flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors',
                          isSelected ? 'border-primary bg-primary/5' : 'border-border bg-background hover:bg-muted/30',
                        )}
                      >
                        <span
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full border"
                          style={{
                            color: option.color,
                            borderColor: `${option.color}33`,
                            backgroundColor: `${option.color}1A`,
                          }}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="text-xs font-medium text-foreground">{option.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-foreground">Descricao</label>
              <Textarea
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                disabled={isReadOnly || isSubmitting}
                rows={4}
                maxLength={220}
              />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ToggleList
              title="Usuarios atribuidos"
              description="Usuarios selecionados poderao enxergar esta fila no atendimento."
              items={users.map((user) => ({ ...user, id: String(user.id || '') }))}
              selectedIds={form.user_ids}
              onToggle={(item, checked) => handleToggleUser(item, checked)}
              disabled={isReadOnly || isSubmitting}
              emptyMessage="Nenhum usuario disponivel."
              renderLabel={(item) => (
                <>
                  <span className="block text-sm font-medium text-foreground">{item.full_name || 'Sem nome'}</span>
                  <span className="block text-xs text-muted-foreground">
                    @{item.username || 'sem-usuario'} {item.email ? `- ${item.email}` : ''}
                  </span>
                </>
              )}
            />

            <ToggleList
              title="Etiquetas atribuidas"
              description="A etiqueta padrao persistida define em qual fila o cliente entra."
              items={labelOptions.filter((label) => label.kind === 'system').map((label) => ({ ...label, id: String(label.id || '') }))}
              selectedIds={form.label_ids}
              onToggle={(item, checked) => handleToggleArray('label_ids', item.id, checked)}
              disabled={isReadOnly || isSubmitting}
              emptyMessage="Nenhuma etiqueta disponivel."
              renderLabel={(item) => (
                <div className="flex items-center gap-2">
                  <span className="block text-sm font-medium text-foreground">{item.name}</span>
                  <Badge variant="outline" className="rounded-full text-[10px] text-muted-foreground">
                    {item.kind === 'system' ? 'Sistema' : 'Custom'}
                  </Badge>
                </div>
              )}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              {isReadOnly ? 'Fechar' : 'Cancelar'}
            </Button>
            {!isReadOnly ? (
              <Button
                type="submit"
                disabled={
                  isSubmitting ||
                  !form.name.trim() ||
                  form.user_ids.length === 0 ||
                  form.label_ids.length === 0
                }
              >
                {isSubmitting ? 'Salvando...' : 'Salvar servico'}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
