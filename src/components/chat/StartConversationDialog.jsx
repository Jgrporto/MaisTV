import React, { useEffect, useMemo, useState } from 'react';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fetchLocalHsms, uploadHsmMedia } from '@/lib/hsm-api';
import { sendWhatsappTemplateMessage } from '@/lib/whatsapp-api';

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'sim'].includes(normalized);
};

const normalizeTemplate = (item = {}) => ({
  ...item,
  id: String(item.id || item.name || ''),
  name: String(item.name || '').trim(),
  language: String(item.language || 'pt_BR').trim() || 'pt_BR',
  content: String(item.content || '').trim(),
  active: normalizeBoolean(item.active),
  status: String(item.status || '').trim().toLowerCase(),
  serviceIds: Array.from(new Set([
    ...(Array.isArray(item.serviceIds) ? item.serviceIds : []),
    ...(Array.isArray(item.service_ids) ? item.service_ids : []),
    item.serviceId,
    item.service_id,
    item.service,
    item.assignedServiceId,
    item.assigned_service_id,
  ].map((value) => String(value || '').trim()).filter(Boolean))),
  serviceId: String(
    item.serviceId ||
      item.service_id ||
      item.service ||
      item.assignedServiceId ||
      item.assigned_service_id ||
      '',
  ).trim(),
  headerType: String(item.headerType || 'none').trim().toLowerCase(),
  headerFormat: String(item.headerFormat || '').trim().toUpperCase(),
  headerMediaUrl: String(item.headerMediaUrl || item.headerExample || '').trim(),
  bodyVariables: Array.isArray(item.bodyVariables) ? item.bodyVariables : [],
  headerVariables: Array.isArray(item.headerVariables) ? item.headerVariables : [],
  buttonVariables: Array.isArray(item.buttonVariables) ? item.buttonVariables : [],
  buttons: Array.isArray(item.buttons) ? item.buttons : Array.isArray(item.buttonConfig) ? item.buttonConfig : [],
});

const countBodyVariables = (template = {}) => {
  const matches = String(template.content || '').match(/\{\{\s*\d+\s*\}\}/g);
  return matches ? matches.length : 0;
};

const getBodyPreview = (template, parameters = []) =>
  String(template?.content || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, index) => {
    const value = parameters[Number(index) - 1];
    return String(value || `var${index}`);
  });

const normalizePhone = (value) => String(value || '').replace(/\D/g, '');

export default function StartConversationDialog({
  open,
  onOpenChange,
  services = [],
  defaultServiceId = '',
  initialPhone = '',
  currentUser = null,
}) {
  const [templates, setTemplates] = useState([]);
  const [destination, setDestination] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [bodyParameters, setBodyParameters] = useState([]);
  const [buttonParameters, setButtonParameters] = useState([]);
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDestination(normalizePhone(initialPhone));
    setServiceId(defaultServiceId || services[0]?.id || '');
    setTemplateId('');
    setBodyParameters([]);
    setButtonParameters([]);
    setHeaderMediaUrl('');
  }, [defaultServiceId, initialPhone, open]);

  useEffect(() => {
    if (!open || serviceId) return;
    const nextServiceId = defaultServiceId || services[0]?.id || '';
    if (nextServiceId) setServiceId(nextServiceId);
  }, [defaultServiceId, open, serviceId, services]);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setIsLoadingTemplates(true);
    fetchLocalHsms()
      .then((payload) => {
        if (!active) return;
        const items = Array.isArray(payload?.items) ? payload.items : [];
        setTemplates(items.map(normalizeTemplate).filter((item) => item.active && item.status === 'approved' && item.serviceIds.length));
      })
      .catch((error) => toast.error(error?.message || 'Não foi possível carregar HSMs.'))
      .finally(() => {
        if (active) setIsLoadingTemplates(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  const filteredTemplates = useMemo(
    () => templates.filter((template) => template.serviceIds.map(String).includes(String(serviceId))),
    [serviceId, templates],
  );

  const selectedTemplate = useMemo(
    () => filteredTemplates.find((template) => String(template.id || template.name) === String(templateId)) || null,
    [filteredTemplates, templateId],
  );

  useEffect(() => {
    if (!filteredTemplates.length) {
      setTemplateId('');
      return;
    }
    if (!filteredTemplates.some((template) => String(template.id || template.name) === String(templateId))) {
      setTemplateId(String(filteredTemplates[0].id || filteredTemplates[0].name));
    }
  }, [filteredTemplates, templateId]);

  useEffect(() => {
    if (!selectedTemplate) {
      setBodyParameters([]);
      setButtonParameters([]);
      setHeaderMediaUrl('');
      return;
    }

    setBodyParameters(
      Array.from({ length: countBodyVariables(selectedTemplate) }, (_, index) =>
        String(selectedTemplate.bodyVariables?.[index] || (index === 0 ? 'conversar' : index === 1 ? 'me manda um oi' : '')),
      ),
    );
    setButtonParameters(
      (selectedTemplate.buttons || []).map((button, index) => ({
        index,
        type: button.type || button.buttonType || '',
        value: String(selectedTemplate.buttonVariables?.[index]?.value || selectedTemplate.buttonVariables?.[index] || ''),
      })),
    );
    setHeaderMediaUrl(selectedTemplate.headerMediaUrl || '');
  }, [selectedTemplate]);

  const handleUploadHeader = async (file) => {
    if (!file) return;
    setIsUploading(true);
    try {
      const uploaded = await uploadHsmMedia(file);
      setHeaderMediaUrl(String(uploaded?.url || ''));
    } catch (error) {
      toast.error(error?.message || 'Não foi possível enviar a imagem.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleSend = async () => {
    const to = normalizePhone(destination);
    if (!to) {
      toast.error('Informe o número de destino.');
      return;
    }
    if (!selectedTemplate) {
      toast.error('Selecione um HSM atribuído ao serviço.');
      return;
    }

    setIsSending(true);
    try {
      const currentUserName = String(currentUser?.full_name || currentUser?.name || currentUser?.username || '').trim();
      await sendWhatsappTemplateMessage({
        to,
        templateName: selectedTemplate.name,
        language: selectedTemplate.language,
        parameters: bodyParameters,
        buttonParameters,
        headerParameters:
          headerMediaUrl && selectedTemplate.headerFormat && selectedTemplate.headerFormat !== 'TEXT'
            ? [headerMediaUrl]
            : [],
        headerFormat: selectedTemplate.headerFormat,
        headerType: selectedTemplate.headerType,
        headerMediaUrl,
        previewText: getBodyPreview(selectedTemplate, bodyParameters),
        agentName: currentUserName || null,
      });
      toast.success('Conversa iniciada com HSM.');
      onOpenChange(false);
      setDestination('');
    } catch (error) {
      toast.error(error?.message || 'Não foi possível iniciar a conversa.');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Iniciar Conversa</DialogTitle>
          <DialogDescription>Envie um HSM aprovado atribuído ao serviço selecionado.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Número de Destino</label>
              <Input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="5524999999999" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Serviço</label>
              <Select value={serviceId || 'none'} onValueChange={(value) => setServiceId(value === 'none' ? '' : value)}>
                <SelectTrigger><SelectValue placeholder="Serviço" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Selecione um serviço</SelectItem>
                  {services.map((service) => (
                    <SelectItem key={service.id} value={service.id}>{service.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">HSM</label>
            <Select value={templateId || 'none'} onValueChange={(value) => setTemplateId(value === 'none' ? '' : value)} disabled={isLoadingTemplates || !serviceId}>
              <SelectTrigger><SelectValue placeholder={isLoadingTemplates ? 'Carregando HSMs...' : 'Selecione um HSM'} /></SelectTrigger>
              <SelectContent>
                {filteredTemplates.map((template) => (
                  <SelectItem key={template.id || template.name} value={String(template.id || template.name)}>
                    {template.name} ({template.language})
                  </SelectItem>
                ))}
                {!filteredTemplates.length ? <SelectItem value="none">Nenhum HSM atribuído</SelectItem> : null}
              </SelectContent>
            </Select>
          </div>

          {selectedTemplate ? (
            <div className="grid gap-4 md:grid-cols-[1fr_280px]">
              <div className="space-y-3">
                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">Parâmetro do HSM</div>
                  {bodyParameters.length ? (
                    bodyParameters.map((value, index) => (
                      <Input
                        key={`body-param-${index}`}
                        value={value}
                        onChange={(event) =>
                          setBodyParameters((current) => current.map((item, currentIndex) => (currentIndex === index ? event.target.value : item)))
                        }
                        placeholder={`Parâmetro {{${index + 1}}}`}
                      />
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">Este HSM não possui parâmetros no corpo.</p>
                  )}
                </div>

                {selectedTemplate.headerType === 'image' || selectedTemplate.headerFormat === 'IMAGE' ? (
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Imagem padrão</label>
                    <Input value={headerMediaUrl} onChange={(event) => setHeaderMediaUrl(event.target.value)} placeholder="URL da imagem" />
                    <Button
                      type="button"
                      variant="outline"
                      className="gap-2"
                      disabled={isUploading}
                      onClick={() => document.getElementById('start-conversation-hsm-image')?.click()}
                    >
                      <Upload className="h-4 w-4" />
                      {isUploading ? 'Enviando...' : 'Upar imagem'}
                    </Button>
                    <input
                      id="start-conversation-hsm-image"
                      type="file"
                      className="hidden"
                      accept="image/png,image/jpeg,image/jpg,image/webp"
                      onChange={(event) => {
                        void handleUploadHeader(event.target.files?.[0]);
                        event.target.value = '';
                      }}
                    />
                  </div>
                ) : null}

                {buttonParameters.length ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-foreground">Parâmetros dos botões</div>
                    {buttonParameters.map((button, index) => (
                      <Input
                        key={`button-param-${index}`}
                        value={button.value || ''}
                        onChange={(event) =>
                          setButtonParameters((current) =>
                            current.map((item, currentIndex) => (currentIndex === index ? { ...item, value: event.target.value } : item)),
                          )
                        }
                        placeholder={(selectedTemplate.buttons?.[index]?.label || selectedTemplate.buttons?.[index]?.text || `Botão ${index + 1}`)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="rounded-2xl border border-border bg-muted/25 p-3">
                {headerMediaUrl && (selectedTemplate.headerType === 'image' || selectedTemplate.headerFormat === 'IMAGE') ? (
                  <img src={headerMediaUrl} alt="Preview" className="mb-3 h-32 w-full rounded-xl object-cover" />
                ) : null}
                <p className="whitespace-pre-wrap text-sm text-foreground">{getBodyPreview(selectedTemplate, bodyParameters)}</p>
                {selectedTemplate.buttons?.length ? (
                  <div className="mt-3 overflow-hidden rounded-xl border border-border bg-background">
                    {selectedTemplate.buttons.map((button, index) => (
                      <div key={button.id || index} className="border-b border-border px-3 py-2 text-center text-xs font-medium text-primary last:border-b-0">
                        {button.label || button.text || 'Botão'}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSending}>Cancelar</Button>
          <Button onClick={() => void handleSend()} disabled={isSending || isUploading || !selectedTemplate}>
            {isSending ? 'Enviando...' : 'Iniciar conversa'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
