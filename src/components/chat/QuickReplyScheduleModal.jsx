import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createQuickReplySchedule } from '@/lib/quick-reply-schedules';

const todayKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toDateTime = (date, time) => new Date(`${date}T${time || '00:00'}:00`);

const getTemplateName = (template = {}) => String(template.name || template.identifier || template.templateName || '').trim();
const getTemplateLanguage = (template = {}) => String(template.language || 'pt_BR').trim() || 'pt_BR';
const getTemplateId = (template = {}) => String(template.id || template.code || `${getTemplateName(template)}::${getTemplateLanguage(template)}`).trim();

const extractVariableIndexes = (text, configured = []) => {
  const indexes = new Set();
  (Array.isArray(configured) ? configured : []).forEach((_, index) => indexes.add(index + 1));
  String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, index) => {
    indexes.add(Number(index));
    return '';
  });
  return Array.from(indexes).filter(Boolean).sort((left, right) => left - right);
};

const getHeaderKind = (template = {}) => {
  const type = String(template.headerType || '').toLowerCase();
  const format = String(template.headerFormat || '').toLowerCase();
  return type || format || 'none';
};

export default function QuickReplyScheduleModal({
  open,
  onOpenChange,
  selectedReply,
  quickReplies = [],
  conversation,
  currentUser,
  templates = [],
  isWithin24hWindow = false,
  scheduleSettings = null,
}) {
  const queryClient = useQueryClient();
  const [quickReplyId, setQuickReplyId] = useState('');
  const [scheduledDate, setScheduledDate] = useState(todayKey());
  const [scheduledTime, setScheduledTime] = useState('');
  const [hsmTemplateId, setHsmTemplateId] = useState('');
  const [hsmVariables, setHsmVariables] = useState({ body: {}, header: {}, buttons: {} });
  const [hsmMedia, setHsmMedia] = useState({});

  useEffect(() => {
    if (!open) return;
    setQuickReplyId(selectedReply?.id || '');
    setScheduledDate(todayKey());
    setScheduledTime('');
    setHsmTemplateId(scheduleSettings?.hsmTemplateId || '');
    setHsmVariables(scheduleSettings?.hsmVariables || { body: {}, header: {}, buttons: {} });
    setHsmMedia(scheduleSettings?.hsmMedia || {});
  }, [open, scheduleSettings, selectedReply?.id]);

  const selectedQuickReply = useMemo(
    () => selectedReply || quickReplies.find((reply) => reply.id === quickReplyId) || null,
    [quickReplyId, quickReplies, selectedReply]
  );

  const selectedTemplate = useMemo(
    () => templates.find((template) => getTemplateId(template) === hsmTemplateId) || null,
    [hsmTemplateId, templates]
  );

  const bodyIndexes = useMemo(
    () => extractVariableIndexes(selectedTemplate?.content || selectedTemplate?.body, selectedTemplate?.bodyVariables),
    [selectedTemplate]
  );
  const headerIndexes = useMemo(
    () => extractVariableIndexes(selectedTemplate?.headerText, selectedTemplate?.headerVariables),
    [selectedTemplate]
  );
  const buttonIndexes = useMemo(
    () => extractVariableIndexes((selectedTemplate?.buttons || []).map((button) => button.url || '').join('\n'), selectedTemplate?.buttonVariables),
    [selectedTemplate]
  );

  const scheduledAt = useMemo(() => {
    if (!scheduledDate || !scheduledTime) return null;
    const value = toDateTime(scheduledDate, scheduledTime);
    return Number.isNaN(value.getTime()) ? null : value;
  }, [scheduledDate, scheduledTime]);

  const windowExpiresAt = useMemo(() => {
    const reference =
      conversation?.last_client_message_time ||
      conversation?.last_received_at ||
      conversation?.lastClientMessageTime ||
      conversation?.last_message_time ||
      '';
    const referenceMs = Date.parse(reference);
    if (!Number.isFinite(referenceMs)) return '';
    return new Date(referenceMs + 24 * 60 * 60 * 1000).toISOString();
  }, [conversation]);

  const requiresHsm = useMemo(() => {
    if (!scheduledAt) return !isWithin24hWindow;
    const expiresMs = Date.parse(windowExpiresAt || '');
    if (!Number.isFinite(expiresMs)) return !isWithin24hWindow;
    return scheduledAt.getTime() > expiresMs;
  }, [isWithin24hWindow, scheduledAt, windowExpiresAt]);

  const createMutation = useMutation({
    mutationFn: (payload) => createQuickReplySchedule(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quick-reply-schedules'] });
      toast.success('Agendamento criado.');
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error?.message || 'Nao foi possivel criar o agendamento.');
    },
  });

  const validate = () => {
    if (!conversation?.id) return 'Selecione uma conversa antes de criar o agendamento.';
    if (!quickReplyId) return 'Selecione uma mensagem rapida.';
    if (!scheduledDate) return 'Informe a data.';
    if (!scheduledTime) return 'Informe a hora.';
    if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) return 'Informe uma data e hora validas.';
    if (scheduledAt.getTime() < Date.now() - 30000) return 'A data e hora nao podem estar no passado.';
    if (requiresHsm && !selectedTemplate) return 'Configure o HSM padrao em Configuracoes > Agendamentos.';

    if (selectedTemplate) {
      const missingBody = bodyIndexes.find((index) => !String(hsmVariables.body?.[index] || '').trim());
      const missingHeader = headerIndexes.find((index) => !String(hsmVariables.header?.[index] || '').trim());
      const missingButton = buttonIndexes.find((index) => !String(hsmVariables.buttons?.[index] || '').trim());
      if (missingBody) return `Configure a variavel ${missingBody} do HSM em Configuracoes > Agendamentos.`;
      if (missingHeader) return `Configure a variavel de cabecalho ${missingHeader} do HSM em Configuracoes > Agendamentos.`;
      if (missingButton) return `Configure a variavel de botao ${missingButton} do HSM em Configuracoes > Agendamentos.`;
      const headerKind = getHeaderKind(selectedTemplate);
      const needsMedia = ['image', 'video', 'document'].includes(headerKind);
      if (needsMedia && !hsmMedia?.dataUrl && !hsmMedia?.url && !selectedTemplate.headerMediaUrl) {
        return 'Configure a midia exigida pelo HSM em Configuracoes > Agendamentos.';
      }
    }

    return '';
  };

  const handleCreate = () => {
    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }

    createMutation.mutate({
      title: selectedQuickReply?.title || '',
      conversationId: conversation.id,
      customerId: conversation.customer?.id || conversation.customer_id || '',
      customerName: conversation.contact_name || conversation.customer?.name || '',
      customerPhone: conversation.contact_phone || conversation.customer?.phone || '',
      quickReplyId,
      scheduledDate,
      scheduledTime,
      scheduledAt: scheduledAt.toISOString(),
      windowExpiresAt,
      status: 'pending',
      hsmTemplateId: selectedTemplate ? getTemplateId(selectedTemplate) : '',
      hsmTemplateName: selectedTemplate ? getTemplateName(selectedTemplate) : '',
      hsmLanguage: selectedTemplate ? getTemplateLanguage(selectedTemplate) : 'pt_BR',
      hsmVariables,
      hsmMedia: hsmMedia || {},
      conversationSnapshot: {
        id: conversation.id,
        contact_name: conversation.contact_name,
        contact_phone: conversation.contact_phone,
        customer: conversation.customer || {},
        last_client_message_time: conversation.last_client_message_time || conversation.last_received_at || '',
        phone_number_id: conversation.phone_number_id || null,
        display_phone_number: conversation.display_phone_number || null,
        meta_route_key: conversation.meta_route_key || null,
      },
      createdBy: currentUser?.id || currentUser?.email || '',
      createdByName: currentUser?.full_name || currentUser?.name || currentUser?.username || 'Agente',
    });
  };

  const renderVariableFields = (group, indexes, labelPrefix) =>
    indexes.map((index) => (
      <div key={`${group}-${index}`} className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">
          {labelPrefix} {index}
        </Label>
        <div className="min-h-9 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
          {hsmVariables[group]?.[index] || 'Nao configurada'}
        </div>
      </div>
    ));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-hidden border-border bg-card p-0 text-foreground sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>Criar Agendamento</DialogTitle>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="absolute right-4 top-4 rounded-md text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </DialogHeader>

        <div className="flex max-h-[calc(92vh-132px)] flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <Label>Selecionar mensagem rapida</Label>
            <div className="min-h-10 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
              {selectedQuickReply?.title || 'Mensagem rapida selecionada'}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Data</Label>
              <Input type="date" min={todayKey()} value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} className="border-border bg-background" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Hora</Label>
              <Input type="time" value={scheduledTime} onChange={(event) => setScheduledTime(event.target.value)} className="border-border bg-background" />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>HSM para envio fora das 24h{requiresHsm ? ' *' : ''}</Label>
            <div className="min-h-10 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
              {selectedTemplate ? `${getTemplateName(selectedTemplate)} - ${getTemplateLanguage(selectedTemplate)}` : 'Configure em Configuracoes > Agendamentos'}
            </div>
          </div>

          {selectedTemplate ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-background/60 p-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{getTemplateName(selectedTemplate)}</p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{selectedTemplate.content || selectedTemplate.body || 'Template sem previa.'}</p>
              </div>
              {renderVariableFields('body', bodyIndexes, 'Variavel')}
              {renderVariableFields('header', headerIndexes, 'Cabecalho')}
              {renderVariableFields('buttons', buttonIndexes, 'Botao')}
              {['image', 'video', 'document'].includes(getHeaderKind(selectedTemplate)) ? (
                <div className="flex flex-col gap-1.5">
                  <Label>Midia do HSM</Label>
                  <div className="min-h-9 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
                    {hsmMedia?.fileName || hsmMedia?.url || selectedTemplate.headerMediaUrl || 'Nenhuma midia configurada.'}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t border-border px-5 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={createMutation.isPending}>
            Cancelar
          </Button>
          <Button type="button" onClick={handleCreate} disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Criando...' : 'Criar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
