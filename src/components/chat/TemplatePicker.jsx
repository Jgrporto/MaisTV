import React, { useMemo, useState } from 'react';
import { FileText, Search } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

function buildTemplatePreview(template) {
  const body = String(template?.content || '').trim();
  const variables = Array.isArray(template?.bodyVariables) ? template.bodyVariables : [];

  if (!body) return '';

  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, index) => {
    const item = variables[Number(index) - 1];
    return String(item || `var${index}`);
  });
}

const getTemplateButtons = (template = {}) => {
  if (Array.isArray(template.buttons) && template.buttons.length) return template.buttons;
  if (Array.isArray(template.buttonConfig) && template.buttonConfig.length) {
    return template.buttonConfig.map((button, index) => ({
      id: button.id || `button-${index}`,
      type: button.type || button.buttonType || 'quick_reply',
      label: button.label || button.text || '',
      url: button.url || '',
      phoneNumber: button.phoneNumber || button.phone_number || '',
      offerCode: button.offerCode || button.offer_code || '',
      flowId: button.flowId || '',
    }));
  }
  return [];
};

export default function TemplatePicker({ open, onOpenChange, templates, onSelect, isSending }) {
  const [search, setSearch] = useState('');

  const filteredTemplates = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    if (!normalizedSearch) return templates;

    return templates.filter((template) => {
      return (
        String(template?.name || '').toLowerCase().includes(normalizedSearch) ||
        String(template?.content || '').toLowerCase().includes(normalizedSearch)
      );
    });
  }, [search, templates]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Enviar HSM</DialogTitle>
          <DialogDescription>
            Este cliente esta fora da janela de 24 horas. Selecione um template aprovado para continuar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar template por nome ou conteudo"
              className="pl-9"
            />
          </div>

          <div className="max-h-[60vh] overflow-y-auto space-y-3 pr-1">
            {filteredTemplates.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                Nenhum template encontrado.
              </div>
            ) : (
              filteredTemplates.map((template) => (
                <div key={template.id || template.name} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium text-foreground break-all">{template.name}</h3>
                        <Badge variant="outline">{template.language || 'pt_BR'}</Badge>
                        <Badge variant="secondary">{template.category || 'utility'}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                        {buildTemplatePreview(template) || 'Sem preview disponivel'}
                      </p>
                      {template.headerType && template.headerType !== 'none' && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <FileText className="w-3.5 h-3.5" />
                          Header: {template.headerType}
                        </div>
                      )}
                      {getTemplateButtons(template).length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {getTemplateButtons(template).map((button, index) => (
                            <Badge key={button.id || `${template.name}-button-${index}`} variant="outline" className="text-[11px]">
                              {button.label || button.text || 'Botão'}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      onClick={() => onSelect(template)}
                      disabled={isSending}
                      className="flex-shrink-0"
                    >
                      {isSending ? 'Enviando...' : 'Usar template'}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
