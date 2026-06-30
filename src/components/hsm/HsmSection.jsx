import React, { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Copy,
  Eye,
  FileText,
  Globe,
  Image as ImageIcon,
  MapPin,
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
  Trash2,
  Upload,
  Video,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { fetchServices } from '@/lib/services-api';
import {
  createMetaHsm,
  deleteLocalHsm,
  fetchLocalHsms,
  fetchMetaHsms,
  hsmSyncKey,
  readHsmUiState,
  removeHsmUiState,
  replaceLocalHsms,
  saveLocalHsm,
  uploadHsmMedia,
  writeHsmUiState,
} from '@/lib/hsm-api';

const categoryLabels = {
  utility: 'Utility',
  marketing: 'Marketing',
  authentication: 'Authentication',
  internal: 'Interno',
};

const statusConfig = {
  approved: {
    label: 'Aprovado',
    icon: CheckCircle2,
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
  },
  pending: {
    label: 'Pendente',
    icon: Clock3,
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  },
  rejected: {
    label: 'Rejeitado',
    icon: AlertCircle,
    className: 'border-destructive/30 bg-destructive/10 text-destructive',
  },
};

const languageOptions = [
  { value: 'pt_BR', label: 'Português Brasileiro (pt_BR)' },
  { value: 'en_US', label: 'Inglês (en_US)' },
];

const headerTypeOptions = [
  { value: 'none', label: 'Nenhum' },
  { value: 'image', label: 'Imagem' },
  { value: 'document', label: 'Documento' },
  { value: 'video', label: 'Vídeo' },
  { value: 'location', label: 'Localização' },
  { value: 'text', label: 'Texto' },
];

const marketingTypeOptions = [
  { value: 'custom', label: 'Personalizado' },
  { value: 'product_messages', label: 'Mensagens do Produto' },
];

const utilityTypeOptions = [{ value: 'custom', label: 'Personalizado' }];

const productFormatOptions = [{ value: 'catalog_message', label: 'Mensagem do catálogo' }];

const buttonTypeOptions = [
  { value: 'quick_reply', label: 'Personalizado' },
  { value: 'url', label: 'Acessar site' },
  { value: 'phone', label: 'Ligar' },
  { value: 'copy_code', label: 'Copiar código de oferta' },
  { value: 'flow', label: 'Fluxo WhatsApp' },
  { value: 'order', label: 'Pedido' },
];

const createDefaultButton = (type = 'quick_reply') => ({
  id: `btn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  type,
  label: '',
  url: '',
  phoneNumber: '',
  offerCode: '',
  flowId: '',
  orderReference: '',
});

const createEmptyForm = () => ({
  id: '',
  code: '',
  identifier: '',
  category: 'marketing',
  language: 'pt_BR',
  marketingType: 'custom',
  utilityType: 'custom',
  productFormat: 'catalog_message',
  description: '',
  headerType: 'none',
  headerValue: '',
  body: '',
  footer: '',
  buttons: [],
  serviceId: '',
  serviceIds: [],
  active: false,
  status: 'pending',
  createdAt: new Date().toISOString(),
});

const normalizeServiceIds = (value, fallback = '') => {
  const items = Array.isArray(value) ? value : [];
  return Array.from(
    new Set(
      [
        ...items,
        fallback,
      ]
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
};

const normalizeStatus = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'approved' || normalized === 'pending' || normalized === 'rejected') {
    return normalized;
  }
  return 'pending';
};

const normalizeCategory = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'marketing' || normalized === 'utility' || normalized === 'authentication' || normalized === 'internal') {
    return normalized;
  }
  return 'marketing';
};

const normalizeHeaderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['none', 'image', 'document', 'video', 'location', 'text'].includes(normalized)) {
    return normalized;
  }
  return 'none';
};

const normalizeButtonType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['quick_reply', 'url', 'phone', 'copy_code', 'flow', 'order'].includes(normalized)) {
    return normalized;
  }
  if (normalized === 'personalizado' || normalized === 'custom') return 'quick_reply';
  if (normalized === 'acessar_site' || normalized === 'website') return 'url';
  if (normalized === 'ligar') return 'phone';
  if (normalized === 'fluxo_whatsapp') return 'flow';
  if (normalized === 'pedido') return 'order';
  return 'quick_reply';
};

const extractBodyText = (components = []) => {
  const body = components.find((component) => String(component?.type || '').toUpperCase() === 'BODY');
  return String(body?.text || '').trim();
};

const extractHeaderComponent = (components = []) =>
  components.find((component) => String(component?.type || '').toUpperCase() === 'HEADER') || null;

const extractButtonComponent = (components = []) =>
  components.find((component) => String(component?.type || '').toUpperCase() === 'BUTTONS') || null;

const extractButtonsFromComponent = (component) => {
  const buttons = Array.isArray(component?.buttons) ? component.buttons : [];
  return buttons
    .map((button, index) => {
      const type = String(button?.type || '').toUpperCase();
      if (type === 'URL') {
        return {
          id: `btn-meta-${Date.now()}-${index}`,
          type: 'url',
          label: String(button?.text || '').trim(),
          url: String(button?.url || '').trim(),
          phoneNumber: '',
          offerCode: '',
          flowId: '',
          orderReference: '',
        };
      }

      if (type === 'QUICK_REPLY') {
        return {
          id: `btn-meta-${Date.now()}-${index}`,
          type: 'quick_reply',
          label: String(button?.text || '').trim(),
          url: '',
          phoneNumber: '',
          offerCode: '',
          flowId: '',
          orderReference: '',
        };
      }

      return null;
    })
    .filter(Boolean);
};

const inferHeaderFromPayload = (item) => {
  const headerType = normalizeHeaderType(item?.headerType || item?.header_type);
  if (headerType !== 'none') {
    if (headerType === 'text') {
      return {
        headerType,
        headerValue: String(item?.headerText || '').trim(),
      };
    }

    return {
      headerType,
      headerValue: String(item?.headerMediaUrl || item?.headerExample || '').trim(),
    };
  }

  const format = String(item?.headerFormat || '').trim().toUpperCase();
  if (format === 'TEXT') {
    return {
      headerType: 'text',
      headerValue: String(item?.headerText || '').trim(),
    };
  }

  if (format === 'IMAGE' || format === 'DOCUMENT' || format === 'VIDEO') {
    return {
      headerType: format.toLowerCase(),
      headerValue: String(item?.headerMediaUrl || item?.headerExample || '').trim(),
    };
  }

  return {
    headerType: 'none',
    headerValue: '',
  };
};

const buildButtonsFromLocalPayload = (item, uiState) => {
  if (Array.isArray(uiState?.buttons) && uiState.buttons.length > 0) {
    return uiState.buttons.map((button) => ({
      ...createDefaultButton(normalizeButtonType(button?.type)),
      ...button,
      type: normalizeButtonType(button?.type),
    }));
  }

  const buttonConfig = Array.isArray(item?.buttonConfig) ? item.buttonConfig : [];
  if (buttonConfig.length > 0) {
    return buttonConfig.map((button, index) => ({
      id: String(button?.id || `btn-local-${Date.now()}-${index}`),
      type: normalizeButtonType(button?.type),
      label: String(button?.text || '').trim(),
      url: String(button?.url || '').trim(),
      phoneNumber: String(button?.phoneNumber || button?.phone_number || '').trim(),
      offerCode: String(button?.offerCode || button?.offer_code || '').trim(),
      flowId: String(button?.flowId || '').trim(),
      orderReference: String(button?.orderReference || '').trim(),
    }));
  }

  if (item?.hasButton && (item?.buttonText || item?.buttonUrl)) {
    return [
      {
        id: `btn-local-${Date.now()}`,
        type: 'url',
        label: String(item?.buttonText || '').trim(),
        url: String(item?.buttonUrl || '').trim(),
        phoneNumber: '',
        offerCode: '',
        flowId: '',
        orderReference: '',
      },
    ];
  }

  return [];
};

const mergeUiStateIntoTemplate = (baseTemplate, uiState) => ({
  ...baseTemplate,
  description: String(uiState?.description || baseTemplate.description || '').trim(),
  marketingType: String(uiState?.marketingType || baseTemplate.marketingType || 'custom'),
  utilityType: String(uiState?.utilityType || baseTemplate.utilityType || 'custom'),
  productFormat: String(uiState?.productFormat || baseTemplate.productFormat || 'catalog_message'),
  serviceIds: normalizeServiceIds(uiState?.serviceIds || baseTemplate.serviceIds, uiState?.serviceId || baseTemplate.serviceId),
  serviceId: normalizeServiceIds(uiState?.serviceIds || baseTemplate.serviceIds, uiState?.serviceId || baseTemplate.serviceId)[0] || '',
  active: typeof uiState?.active === 'boolean' ? uiState.active : Boolean(baseTemplate.active),
  createdAt: String(uiState?.createdAt || baseTemplate.createdAt || new Date().toISOString()),
  buttons: buildButtonsFromLocalPayload(baseTemplate, uiState),
});

const mapLocalItemToTemplate = (item, uiStateMap) => {
  const syncKey = hsmSyncKey(item?.name, item?.language);
  const uiState = uiStateMap[syncKey] || {};
  const { headerType, headerValue } = inferHeaderFromPayload(item);

  return mergeUiStateIntoTemplate(
    {
      id: String(item?.id || syncKey),
      code: String(item?.id || syncKey),
      identifier: String(item?.name || ''),
      category: normalizeCategory(item?.category),
      language: String(item?.language || 'pt_BR'),
      marketingType: String(item?.marketingType || 'custom'),
      utilityType: String(item?.utilityType || 'custom'),
      productFormat: String(item?.productFormat || 'catalog_message'),
      description: String(item?.description || ''),
      headerType,
      headerValue,
      body: String(item?.content || ''),
      footer: String(item?.footer || ''),
      serviceIds: normalizeServiceIds(item?.serviceIds || item?.service_ids, item?.serviceId || item?.service_id),
      serviceId: String(item?.serviceId || item?.service_id || ''),
      buttons: Array.isArray(item?.buttons) ? item.buttons : [],
      active: typeof item?.active === 'boolean' ? item.active : false,
      status: normalizeStatus(item?.status),
      createdAt: String(item?.createdAt || new Date().toISOString()),
      source: 'local',
      syncKey,
    },
    uiState,
  );
};

const mapRemoteItemToTemplate = (item, uiStateMap, existingLocal) => {
  const syncKey = hsmSyncKey(item?.name, item?.language);
  const uiState = uiStateMap[syncKey] || {};
  const headerComponent = extractHeaderComponent(item?.components || []);
  const buttonsComponent = extractButtonComponent(item?.components || []);
  const localFallback = existingLocal || null;

  let headerType = 'none';
  let headerValue = '';
  const headerFormat = String(headerComponent?.format || '').trim().toUpperCase();

  if (headerFormat === 'TEXT') {
    headerType = 'text';
    headerValue = String(headerComponent?.text || '').trim();
  } else if (headerFormat === 'IMAGE' || headerFormat === 'DOCUMENT' || headerFormat === 'VIDEO') {
    headerType = headerFormat.toLowerCase();
    const example = headerComponent?.example || {};
    headerValue = String(
      (Array.isArray(example?.header_handle) && example.header_handle[0]) ||
        (Array.isArray(example?.header_text) && example.header_text[0]) ||
        localFallback?.headerValue ||
        '',
    ).trim();
  }

  return mergeUiStateIntoTemplate(
    {
      id: String(item?.id || syncKey),
      code: String(item?.id || syncKey),
      identifier: String(item?.name || ''),
      category: normalizeCategory(item?.category),
      language: String(item?.language || 'pt_BR'),
      marketingType: localFallback?.marketingType || 'custom',
      utilityType: localFallback?.utilityType || 'custom',
      productFormat: localFallback?.productFormat || 'catalog_message',
      description: '',
      headerType,
      headerValue,
      body: extractBodyText(item?.components || []),
      footer: localFallback?.footer || '',
      serviceIds: normalizeServiceIds(localFallback?.serviceIds || localFallback?.service_ids, localFallback?.serviceId),
      serviceId: localFallback?.serviceId || '',
      buttons:
        Array.isArray(uiState?.buttons) && uiState.buttons.length > 0
          ? []
          : extractButtonsFromComponent(buttonsComponent),
      active: localFallback ? localFallback.active : false,
      status: normalizeStatus(item?.status),
      createdAt: String(localFallback?.createdAt || uiState?.createdAt || new Date().toISOString()),
      source: 'meta',
      syncKey,
    },
    uiState,
  );
};

const toLocalPayload = (template) => {
  const normalizedButtons = Array.isArray(template?.buttons)
    ? template.buttons.filter((button) => button?.label || button?.text)
    : [];
  const firstWebsiteButton = normalizedButtons.find((button) => normalizeButtonType(button?.type) === 'url') || null;

  return {
    id: template.id,
    name: template.identifier,
    language: template.language,
    category: template.category,
    description: template.description,
    marketingType: template.marketingType,
    productFormat: template.productFormat,
    content: template.body,
    status: normalizeStatus(template.status),
    active: Boolean(template.active),
    utilityType: template.utilityType === 'custom' ? 'personalizado' : template.utilityType,
    headerType: template.headerType,
    headerFormat:
      template.headerType === 'image'
        ? 'IMAGE'
        : template.headerType === 'document'
          ? 'DOCUMENT'
          : template.headerType === 'video'
            ? 'VIDEO'
            : template.headerType === 'text'
              ? 'TEXT'
              : undefined,
    headerText: template.headerType === 'text' ? template.headerValue : undefined,
    headerMediaUrl: ['image', 'document', 'video'].includes(template.headerType) ? template.headerValue : undefined,
    footer: template.footer,
    serviceIds: normalizeServiceIds(template.serviceIds, template.serviceId),
    serviceId: normalizeServiceIds(template.serviceIds, template.serviceId)[0] || '',
    bodyVariables: template.bodyVariables || [],
    headerVariables: template.headerVariables || [],
    buttonVariables: template.buttonVariables || [],
    buttons: normalizedButtons,
    hasButton: Boolean(firstWebsiteButton),
    buttonText: firstWebsiteButton?.label || undefined,
    buttonUrl: firstWebsiteButton?.url || undefined,
    buttonConfig: normalizedButtons.map((button) => ({
      id: button.id,
      type:
        normalizeButtonType(button.type) === 'url'
          ? 'acessar_site'
          : normalizeButtonType(button.type) === 'flow'
            ? 'fluxo_whatsapp'
            : normalizeButtonType(button.type) === 'phone'
              ? 'ligar'
              : normalizeButtonType(button.type) === 'copy_code'
                ? 'copiar_codigo'
                : normalizeButtonType(button.type) === 'order'
                  ? 'pedido'
            : 'personalizado',
      text: button.label,
      url: normalizeButtonType(button.type) === 'url' ? button.url : undefined,
      phoneNumber: normalizeButtonType(button.type) === 'phone' ? button.phoneNumber : undefined,
      offerCode: normalizeButtonType(button.type) === 'copy_code' ? button.offerCode : undefined,
      flowId: normalizeButtonType(button.type) === 'flow' ? button.flowId : undefined,
      orderReference: normalizeButtonType(button.type) === 'order' ? button.orderReference : undefined,
    })),
    createdAt: template.createdAt,
  };
};

const buildUiStatePayload = (template) => ({
  description: template.description,
  marketingType: template.marketingType,
  utilityType: template.utilityType,
  productFormat: template.productFormat,
  serviceIds: normalizeServiceIds(template.serviceIds, template.serviceId),
  serviceId: normalizeServiceIds(template.serviceIds, template.serviceId)[0] || '',
  buttons: template.buttons,
  active: template.active,
  createdAt: template.createdAt,
});

const getButtonCount = (buttons, type) =>
  buttons.filter((button) => normalizeButtonType(button?.type) === type).length;

const buttonLimitByType = {
  quick_reply: null,
  url: 2,
  phone: 1,
  copy_code: 1,
  flow: 1,
  order: 1,
};

const getButtonLimitMessage = (type) => {
  if (type === 'url') return 'Você pode adicionar no máximo 2 botões de acessar site.';
  if (type === 'phone') return 'Você pode adicionar no máximo 1 botão de ligar.';
  if (type === 'copy_code') return 'Você pode adicionar no máximo 1 botão de copiar código de oferta.';
  if (type === 'flow') return 'Você pode adicionar no máximo 1 botão de Fluxo WhatsApp.';
  if (type === 'order') return 'Você pode adicionar no máximo 1 botão de pedido.';
  return 'Não foi possível adicionar esse botão.';
};

const buildPreviewText = (body) =>
  String(body || '')
    .replace(/\{\{\s*1\s*\}\}/g, 'João')
    .replace(/\{\{\s*2\s*\}\}/g, '300MB')
    .replace(/\{\{\s*3\s*\}\}/g, 'R$ 99,90');

const canAutoCreateOnMeta = (template) => {
  const onlyUrlButtons = template.buttons.every((button) => normalizeButtonType(button?.type) === 'url');
  return (
    ['marketing', 'utility'].includes(normalizeCategory(template.category)) &&
    (template.headerType === 'none' || !template.headerValue) &&
    !template.footer.trim() &&
    onlyUrlButtons &&
    template.buttons.length <= 1
  );
};

const getMetaSaveNote = (template) => {
  if (canAutoCreateOnMeta(template)) {
    return null;
  }

  return 'A API atual da Meta conectada a este projeto cria automaticamente apenas body + 1 botão URL. Os demais campos ficam salvos localmente nesta interface.';
};

const getPreviewButtonMeta = (buttonType) => {
  const type = normalizeButtonType(buttonType);

  if (type === 'url') return { icon: Globe, hint: 'Acessar site' };
  if (type === 'phone') return { icon: Phone, hint: 'Ligar' };
  if (type === 'copy_code') return { icon: Copy, hint: 'Copiar código' };
  if (type === 'flow') return { icon: RefreshCw, hint: 'Fluxo WhatsApp' };
  if (type === 'order') return { icon: ShoppingCart, hint: 'Pedido' };

  return { icon: MessageSquare, hint: 'Resposta rápida' };
};

export default function HsmSection() {
  const [search, setSearch] = useState('');
  const [templates, setTemplates] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState('create');
  const [form, setForm] = useState(createEmptyForm());
  const [feedback, setFeedback] = useState({ type: '', title: '', message: '' });
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [buttonTypeToAdd, setButtonTypeToAdd] = useState('quick_reply');
  const [services, setServices] = useState([]);

  const filteredTemplates = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    if (!normalizedSearch) return templates;
    return templates.filter((template) => template.identifier.toLowerCase().includes(normalizedSearch));
  }, [search, templates]);

  const totalPages = Math.max(1, Math.ceil(filteredTemplates.length / itemsPerPage));

  const paginatedTemplates = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredTemplates.slice(startIndex, startIndex + itemsPerPage);
  }, [currentPage, filteredTemplates, itemsPerPage]);

  const metaSaveNote = useMemo(() => getMetaSaveNote(form), [form]);

  useEffect(() => {
    setCurrentPage(1);
  }, [search, itemsPerPage]);

  useEffect(() => {
    setCurrentPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const loadTemplates = async () => {
    setIsLoading(true);
    try {
      const uiStateMap = readHsmUiState();
      const payload = await fetchLocalHsms();
      const items = Array.isArray(payload.items) ? payload.items : [];
      setTemplates(items.map((item) => mapLocalItemToTemplate(item, uiStateMap)));
      setFeedback({ type: '', title: '', message: '' });
    } catch (error) {
      setTemplates([]);
      setFeedback({
        type: 'error',
        title: 'Falha ao carregar HSMs',
        message: error instanceof Error ? error.message : 'Não foi possível carregar os HSMs.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadTemplates();
  }, []);

  useEffect(() => {
    let active = true;
    fetchServices()
      .then((items) => {
        if (active) setServices(Array.isArray(items) ? items : []);
      })
      .catch(() => {
        if (active) setServices([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const getServiceName = (serviceId) =>
    services.find((service) => String(service.id) === String(serviceId))?.name || '';

  const getServiceNames = (serviceIds = [], fallbackServiceId = '') => {
    const ids = normalizeServiceIds(serviceIds, fallbackServiceId);
    const names = ids.map((id) => getServiceName(id)).filter(Boolean);
    return names.length ? names.join(', ') : '';
  };

  const updateForm = (field, value) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const toggleFormService = (serviceId) => {
    const safeServiceId = String(serviceId || '').trim();
    if (!safeServiceId) return;
    setForm((current) => {
      const currentIds = normalizeServiceIds(current.serviceIds, current.serviceId);
      const nextIds = currentIds.includes(safeServiceId)
        ? currentIds.filter((id) => id !== safeServiceId)
        : [...currentIds, safeServiceId];
      return {
        ...current,
        serviceIds: nextIds,
        serviceId: nextIds[0] || '',
      };
    });
  };

  const updateButton = (buttonId, patch) => {
    setForm((current) => ({
      ...current,
      buttons: current.buttons.map((button) => (button.id === buttonId ? { ...button, ...patch } : button)),
    }));
  };

  const removeButton = (buttonId) => {
    setForm((current) => ({
      ...current,
      buttons: current.buttons.filter((button) => button.id !== buttonId),
    }));
  };

  const openCreate = () => {
    setDialogMode('create');
    setForm(createEmptyForm());
    setSubmitError('');
    setDialogOpen(true);
  };

  const openView = (template) => {
    setDialogMode('view');
    setForm({
      ...createEmptyForm(),
      ...template,
      buttons: Array.isArray(template.buttons) ? template.buttons : [],
    });
    setSubmitError('');
    setDialogOpen(true);
  };

  const openEdit = (template) => {
    setDialogMode('edit');
    setForm({
      ...createEmptyForm(),
      ...template,
      buttons: Array.isArray(template.buttons) ? template.buttons : [],
    });
    setSubmitError('');
    setDialogOpen(true);
  };

  const handleAddButton = () => {
    const type = normalizeButtonType(buttonTypeToAdd);
    const limit = buttonLimitByType[type];
    if (Number.isFinite(limit) && getButtonCount(form.buttons, type) >= limit) {
      setSubmitError(getButtonLimitMessage(type));
      return;
    }

    setSubmitError('');
    setForm((current) => ({
      ...current,
      buttons: [...current.buttons, createDefaultButton(type)],
    }));
  };

  const handleUploadHeader = async (file) => {
    if (!file) return;

    setSubmitError('');
    setIsUploading(true);
    try {
      const uploaded = await uploadHsmMedia(file);
      updateForm('headerValue', String(uploaded?.url || ''));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Falha ao enviar a mídia do header.');
    } finally {
      setIsUploading(false);
    }
  };

  const validateForm = () => {
    if (!form.identifier.trim()) return 'Preencha o Identificador.';
    if (!/^[a-z0-9_]+$/.test(form.identifier.trim())) {
      return 'O identificador deve usar apenas letras minúsculas, números e underscore.';
    }
    if (!form.body.trim()) return 'Preencha a Mensagem HSM.';
    if (form.headerType !== 'none' && !form.headerValue.trim()) {
      return 'Preencha o valor do header.';
    }

    for (const button of form.buttons) {
      if (!button.label.trim()) return 'Preencha o texto de todos os botões.';
      const type = normalizeButtonType(button.type);
      if (type === 'url' && !button.url.trim()) return 'Preencha a URL do botão de acessar site.';
      if (type === 'phone' && !button.phoneNumber.trim()) return 'Preencha o telefone do botão ligar.';
      if (type === 'copy_code' && !button.offerCode.trim()) return 'Preencha o código do botão copiar código.';
      if (type === 'flow' && !button.flowId.trim()) return 'Preencha o identificador do Fluxo WhatsApp.';
      if (type === 'order' && !button.orderReference.trim()) return 'Preencha a referência do pedido.';
    }

    return '';
  };

  const handleSave = async () => {
    const validationMessage = validateForm();
    if (validationMessage) {
      setSubmitError(validationMessage);
      return;
    }

    setIsSubmitting(true);
    setSubmitError('');

    const syncKey = hsmSyncKey(form.identifier, form.language);
    const nextTemplate = {
      ...form,
      id: form.id || syncKey,
      code: form.code || form.id || syncKey,
      status: normalizeStatus(form.status),
      createdAt: form.createdAt || new Date().toISOString(),
      syncKey,
    };

    try {
      const savedLocalItem = await saveLocalHsm(toLocalPayload(nextTemplate));
      const savedTemplate = mapLocalItemToTemplate(savedLocalItem || toLocalPayload(nextTemplate), {
        [syncKey]: buildUiStatePayload(nextTemplate),
      });

      writeHsmUiState(syncKey, buildUiStatePayload(nextTemplate));

      if (dialogMode === 'create' && canAutoCreateOnMeta(nextTemplate)) {
        try {
          const firstWebsiteButton = nextTemplate.buttons.find((button) => normalizeButtonType(button.type) === 'url') || null;
          const metaResult = await createMetaHsm({
            name: nextTemplate.identifier,
            language: nextTemplate.language,
            category: nextTemplate.category,
            content: nextTemplate.body,
            hasButton: Boolean(firstWebsiteButton),
            buttonText: firstWebsiteButton?.label || undefined,
            buttonUrl: firstWebsiteButton?.url || undefined,
          });
          savedTemplate.status = normalizeStatus(metaResult?.status || savedTemplate.status);
          savedTemplate.code = String(metaResult?.id || savedTemplate.code);
          setFeedback({
            type: 'success',
            title: 'HSM criado',
            message: 'O HSM foi salvo localmente e enviado para a Meta.',
          });
        } catch (error) {
          setFeedback({
            type: 'warning',
            title: 'HSM salvo localmente',
            message:
              error instanceof Error
                ? error.message
                : 'Não foi possível criar o template diretamente na Meta com a configuração atual.',
          });
        }
      } else if (dialogMode === 'create' && metaSaveNote) {
        setFeedback({
          type: 'warning',
          title: 'HSM salvo localmente',
          message: metaSaveNote,
        });
      } else {
        setFeedback({
          type: 'success',
          title: dialogMode === 'edit' ? 'HSM atualizado' : 'HSM criado',
          message: 'Os dados do HSM foram salvos com sucesso.',
        });
      }

      setTemplates((current) => {
        const next = current.filter((item) => item.syncKey !== syncKey);
        return [savedTemplate, ...next].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      });
      setDialogOpen(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Não foi possível salvar o HSM.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (template) => {
    const confirmed = window.confirm(`Deseja apagar o HSM "${template.identifier}"?`);
    if (!confirmed) return;

    try {
      await deleteLocalHsm(template.id);
      removeHsmUiState(template.syncKey);
      setTemplates((current) => current.filter((item) => item.syncKey !== template.syncKey));
      setFeedback({
        type: 'success',
        title: 'HSM removido',
        message: 'O HSM foi removido desta interface.',
      });
    } catch (error) {
      setFeedback({
        type: 'error',
        title: 'Falha ao apagar HSM',
        message: error instanceof Error ? error.message : 'Não foi possível apagar o HSM.',
      });
    }
  };

  const handleToggleActive = async (template, active) => {
    const nextTemplate = {
      ...template,
      active,
    };
    const nextSyncKey = nextTemplate.syncKey;

    try {
      await saveLocalHsm(toLocalPayload(nextTemplate));
      writeHsmUiState(nextSyncKey, buildUiStatePayload(nextTemplate));
      setTemplates((current) =>
        current.map((item) => (item.syncKey === nextSyncKey ? { ...item, active } : item)),
      );
    } catch (error) {
      setFeedback({
        type: 'error',
        title: 'Falha ao atualizar ativo',
        message: error instanceof Error ? error.message : 'Não foi possível atualizar o status ativo.',
      });
    }
  };

  const handleSyncMeta = async () => {
    setIsSyncing(true);
    try {
      const uiStateMap = readHsmUiState();
      const [localPayload, remoteItems] = await Promise.all([fetchLocalHsms(), fetchMetaHsms()]);
      const localTemplates = (Array.isArray(localPayload.items) ? localPayload.items : []).map((item) =>
        mapLocalItemToTemplate(item, uiStateMap),
      );
      const localMap = new Map(localTemplates.map((template) => [template.syncKey, template]));
      const mergedMap = new Map(localMap);

      remoteItems.forEach((item) => {
        const syncKey = hsmSyncKey(item?.name, item?.language);
        const existingTemplate = localMap.get(syncKey);
        const remoteTemplate = mapRemoteItemToTemplate(item, uiStateMap, existingTemplate);
        mergedMap.set(
          remoteTemplate.syncKey,
          existingTemplate
            ? {
                ...existingTemplate,
                code: remoteTemplate.code || existingTemplate.code,
                category: remoteTemplate.category || existingTemplate.category,
                source: 'meta',
              }
            : remoteTemplate,
        );
      });

      const mergedTemplates = Array.from(mergedMap.values()).sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      );

      await replaceLocalHsms(mergedTemplates.map(toLocalPayload));
      setTemplates(mergedTemplates);
      setFeedback({
        type: 'success',
        title: 'Sincronização concluída',
        message: `${remoteItems.length} template(s) da Meta processado(s).`,
      });
    } catch (error) {
      setFeedback({
        type: 'error',
        title: 'Falha ao sincronizar Meta',
        message: error instanceof Error ? error.message : 'Não foi possível sincronizar os templates da Meta.',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const isViewMode = dialogMode === 'view';

  return (
    <div className="flex h-[calc(100vh-9.5rem)] min-h-[calc(100vh-9.5rem)] flex-col rounded-lg border border-border bg-card p-5 shadow-[0_2px_4px_rgba(0,0,0,0.05)]">
      <div className="flex min-h-0 flex-1 flex-col gap-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-[28px] font-bold tracking-[-0.02em] text-foreground">HSMs</h2>
              <Button variant="outline" onClick={handleSyncMeta} disabled={isSyncing} className="gap-2">
                <RefreshCw className={cn('size-4', isSyncing && 'animate-spin')} />
                Sincronizar Meta
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Gerencie templates HSM e sincronize os aprovados com a Meta.
            </p>
          </div>
        </div>

        {feedback.message ? (
          <Alert
            className={cn(
              feedback.type === 'error' && 'border-destructive/30 bg-destructive/5',
              feedback.type === 'warning' && 'border-amber-500/30 bg-amber-500/5',
              feedback.type === 'success' && 'border-emerald-500/30 bg-emerald-500/5',
            )}
          >
            <AlertTitle>{feedback.title}</AlertTitle>
            <AlertDescription>{feedback.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="relative w-full md:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Pesquisar por nome do HSM"
              className="pl-9"
            />
          </div>
          <Button onClick={openCreate} className="gap-2">
            <Plus className="size-4" />
            Criar HSM
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Table className="w-full table-fixed">
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="border-border bg-secondary/70">
                <TableHead className="w-[96px] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">Ações</TableHead>
                <TableHead className="w-[92px] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">Cod</TableHead>
                <TableHead className="w-[150px] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">Nome HSM</TableHead>
                <TableHead className="w-[96px] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">Categoria</TableHead>
                <TableHead className="w-[140px] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">Serviço</TableHead>
                <TableHead className="w-[150px] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">Descrição</TableHead>
                <TableHead className="w-[190px] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">Preview</TableHead>
                <TableHead className="w-[112px] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">Ativo</TableHead>
                <TableHead className="w-[112px] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">Status</TableHead>
                <TableHead className="w-[128px] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">Data Cadastro</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                    Carregando HSMs...
                  </TableCell>
                </TableRow>
              ) : filteredTemplates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                    Nenhum HSM encontrado.
                  </TableCell>
                </TableRow>
              ) : (
                paginatedTemplates.map((template) => {
                  const status = statusConfig[normalizeStatus(template.status)] || statusConfig.pending;
                  const StatusIcon = status.icon;

                  return (
                    <TableRow key={template.syncKey} className="align-middle">
                      <TableCell className="px-2 py-3">
                        <div className="flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-full bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                            onClick={() => openView(template)}
                            title="Visualizar"
                          >
                            <Eye className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-full bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                            onClick={() => openEdit(template)}
                            title="Editar"
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-full bg-destructive/10 text-destructive hover:bg-destructive/15"
                            onClick={() => void handleDelete(template)}
                            title="Apagar"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="px-2 py-3">
                        <span className="inline-flex max-w-full truncate rounded-full bg-[#E6F7ED] px-2 py-1 font-mono text-[11px] font-medium text-primary">
                          {template.code || '-'}
                        </span>
                      </TableCell>
                      <TableCell className="px-2 py-3">
                        <div className="flex flex-col gap-1">
                          <span className="line-clamp-2 text-sm font-medium leading-5 text-foreground">{template.identifier}</span>
                          <span className="truncate text-[11px] text-muted-foreground">{template.language}</span>
                        </div>
                      </TableCell>
                      <TableCell className="px-2 py-3 text-[13px] leading-5">{categoryLabels[template.category] || 'Marketing'}</TableCell>
                      <TableCell className="px-2 py-3 text-[13px] leading-5">
                        <span className="line-clamp-2 break-words">{getServiceNames(template.serviceIds, template.serviceId) || '-'}</span>
                      </TableCell>
                      <TableCell className="px-2 py-3 text-[13px] leading-5">
                        <span className="line-clamp-2 break-words">{template.description || '-'}</span>
                      </TableCell>
                      <TableCell className="px-2 py-3 text-[13px] leading-5">
                        <span className="line-clamp-2 break-words">
                          {template.body || '-'}
                          {template.buttons?.length ? ` | Botões: ${template.buttons.map((button) => button.label || 'Botão').join(', ')}` : ''}
                        </span>
                      </TableCell>
                      <TableCell className="px-2 py-3">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={Boolean(template.active)}
                            onCheckedChange={(checked) => void handleToggleActive(template, checked)}
                            className="h-6 w-11 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted"
                          />
                          <span
                            className={cn(
                              'text-[11px] font-semibold uppercase tracking-[0.08em]',
                              template.active ? 'text-primary' : 'text-muted-foreground',
                            )}
                          >
                            {template.active ? 'Sim' : 'Não'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="px-2 py-3">
                        <Badge variant="outline" className={cn('gap-1 px-2 py-1 text-[11px]', status.className)}>
                          <StatusIcon className="size-3" />
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="px-2 py-3 text-[12px] leading-5 text-muted-foreground">
                        {format(new Date(template.createdAt), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          </div>

          {filteredTemplates.length > 0 ? (
            <div className="sticky bottom-0 mt-auto flex flex-col gap-3 border-t border-border bg-card px-4 py-3 md:flex-row md:items-center md:justify-between">
              <div className="text-sm text-muted-foreground">
                Exibindo{' '}
                <span className="font-medium text-foreground">
                  {Math.min((currentPage - 1) * itemsPerPage + 1, filteredTemplates.length)}
                </span>{' '}
                a{' '}
                <span className="font-medium text-foreground">
                  {Math.min(currentPage * itemsPerPage, filteredTemplates.length)}
                </span>{' '}
                de <span className="font-medium text-foreground">{filteredTemplates.length}</span> HSMs
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setItemsPerPage((current) => current + 10)}
                >
                  Mostrar +10 por página
                </Button>

                <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-background p-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setCurrentPage((current) => Math.max(1, current - 1))}
                    disabled={currentPage === 1}
                  >
                    Anterior
                  </Button>
                  <span className="min-w-[112px] text-center text-sm text-muted-foreground">
                    Página {currentPage} de {totalPages}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setCurrentPage((current) => Math.min(totalPages, current + 1))}
                    disabled={currentPage === totalPages}
                  >
                    Próxima
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialogMode === 'create' ? 'Criar HSM' : dialogMode === 'edit' ? 'Editar HSM' : 'Visualizar HSM'}
            </DialogTitle>
            <DialogDescription>
              Configure identificador, categoria, idioma, header, conteúdo, botões e status do HSM.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-6 lg:grid-cols-[1.45fr_0.95fr]">
            <div className="flex flex-col gap-5">
              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <div className="mb-4">
                  <h3 className="font-medium text-foreground">Informações Gerais</h3>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-foreground">Identificador</label>
                    <Input
                      value={form.identifier}
                      onChange={(event) => updateForm('identifier', event.target.value)}
                      placeholder="exemplo_hsm_marketing"
                      disabled={isViewMode}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-foreground">Categoria</label>
                    <Select
                      value={form.category}
                      onValueChange={(value) => updateForm('category', value)}
                      disabled={isViewMode}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="marketing">Marketing</SelectItem>
                        <SelectItem value="utility">Utilidades</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-foreground">Idioma</label>
                    <Select
                      value={form.language}
                      onValueChange={(value) => updateForm('language', value)}
                      disabled={isViewMode}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {languageOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-foreground">Serviços</label>
                    <div className="max-h-36 overflow-y-auto rounded-md border border-border bg-background p-2">
                      {services.length ? (
                        services.map((service) => {
                          const checked = normalizeServiceIds(form.serviceIds, form.serviceId).includes(String(service.id));
                          return (
                            <label key={service.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60">
                              <Checkbox
                                checked={checked}
                                disabled={isViewMode}
                                onCheckedChange={() => toggleFormService(service.id)}
                              />
                              <span className="truncate">{service.name}</span>
                            </label>
                          );
                        })
                      ) : (
                        <p className="px-2 py-3 text-sm text-muted-foreground">Nenhum serviço cadastrado.</p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-foreground">Descrição</label>
                    <Input
                      value={form.description}
                      onChange={(event) => updateForm('description', event.target.value)}
                      placeholder="Descrição personalizada"
                      disabled={isViewMode}
                    />
                  </div>
                </div>
              </div>

              {form.category === 'marketing' ? (
                <div className="rounded-xl border border-border bg-muted/20 p-4">
                  <div className="mb-4">
                    <h3 className="font-medium text-foreground">Marketing</h3>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium text-foreground">Tipo de HSM marketing</label>
                      <Select
                        value={form.marketingType}
                        onValueChange={(value) => updateForm('marketingType', value)}
                        disabled={isViewMode}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {marketingTypeOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {form.marketingType === 'product_messages' ? (
                      <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium text-foreground">Formato do modelo</label>
                        <Select
                          value={form.productFormat}
                          onValueChange={(value) => updateForm('productFormat', value)}
                          disabled={isViewMode}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {productFormatOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                  </div>
                  {form.marketingType === 'product_messages' ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Para usar modelos de catálogo você precisa ter um catálogo de e-commerce conectado à conta do WhatsApp Business.
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-muted/20 p-4">
                  <div className="mb-4">
                    <h3 className="font-medium text-foreground">Utilidades</h3>
                  </div>
                  <div className="flex flex-col gap-2 md:max-w-sm">
                    <label className="text-sm font-medium text-foreground">Tipo de HSM utilidades</label>
                    <Select
                      value={form.utilityType}
                      onValueChange={(value) => updateForm('utilityType', value)}
                      disabled={isViewMode}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {utilityTypeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <div className="mb-4">
                  <h3 className="font-medium text-foreground">Campos Comuns</h3>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-foreground">Tipo de header</label>
                    <Select
                      value={form.headerType}
                      onValueChange={(value) => updateForm('headerType', value)}
                      disabled={isViewMode}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {headerTypeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {form.headerType !== 'none' ? (
                    <div className="flex flex-col gap-2 md:col-span-1">
                      <label className="text-sm font-medium text-foreground">
                        {form.headerType === 'text'
                          ? 'Texto do header'
                          : form.headerType === 'location'
                            ? 'Localização do header'
                            : 'Valor do header'}
                      </label>
                      <Input
                        value={form.headerValue}
                        onChange={(event) => updateForm('headerValue', event.target.value)}
                        placeholder={
                          form.headerType === 'text'
                            ? 'Digite o texto do header'
                            : form.headerType === 'location'
                              ? 'Latitude, longitude ou descrição'
                              : 'https://...'
                        }
                        disabled={isViewMode}
                      />
                    </div>
                  ) : null}
                </div>

                {['image', 'document', 'video'].includes(form.headerType) && !isViewMode ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="gap-2"
                      onClick={() => {
                        const input = document.getElementById('hsm-header-upload');
                        input?.click();
                      }}
                      disabled={isUploading}
                    >
                      <Upload className="size-4" />
                      {isUploading ? 'Enviando...' : 'Anexar mídia'}
                    </Button>
                    <input
                      id="hsm-header-upload"
                      type="file"
                      className="hidden"
                      accept={
                        form.headerType === 'image'
                          ? 'image/png,image/jpeg,image/jpg,image/webp,image/gif'
                          : form.headerType === 'video'
                            ? 'video/mp4'
                            : '.pdf,.doc,.docx,text/plain,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                      }
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        void handleUploadHeader(file);
                        event.target.value = '';
                      }}
                    />
                  </div>
                ) : null}

                <div className="mt-4 flex flex-col gap-2">
                  <label className="text-sm font-medium text-foreground">Mensagem HSM</label>
                  <Textarea
                    value={form.body}
                    onChange={(event) => updateForm('body', event.target.value)}
                    placeholder="Digite o conteúdo do HSM"
                    className="min-h-[140px]"
                    disabled={isViewMode}
                  />
                  {form.buttons.length > 0 ? (
                    <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Botões do template: </span>
                      {form.buttons.map((button) => button.label || 'Botão').join(', ')}
                    </div>
                  ) : null}
                </div>

                <div className="mt-4 flex flex-col gap-2">
                  <label className="text-sm font-medium text-foreground">Footer</label>
                  <Textarea
                    value={form.footer}
                    onChange={(event) => updateForm('footer', event.target.value)}
                    placeholder="Mensagem do footer"
                    className="min-h-[90px]"
                    disabled={isViewMode}
                  />
                </div>
              </div>

              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <h3 className="font-medium text-foreground">Botões</h3>
                  {!isViewMode ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Select value={buttonTypeToAdd} onValueChange={setButtonTypeToAdd}>
                        <SelectTrigger className="w-full sm:w-[220px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {buttonTypeOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button type="button" variant="outline" onClick={handleAddButton}>
                        + Adicione um botão
                      </Button>
                    </div>
                  ) : null}
                </div>

                {form.buttons.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                    Nenhum botão adicionado.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {form.buttons.map((button, index) => {
                      const type = normalizeButtonType(button.type);
                      const typeLabel =
                        buttonTypeOptions.find((option) => option.value === type)?.label || 'Botão';

                      return (
                        <div key={button.id} className="rounded-xl border border-border bg-background p-3">
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <div className="text-sm font-medium text-foreground">
                              Botão {index + 1} · {typeLabel}
                            </div>
                            {!isViewMode ? (
                              <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => removeButton(button.id)}>
                                <Trash2 className="size-4" />
                              </Button>
                            ) : null}
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="flex flex-col gap-2">
                              <label className="text-sm font-medium text-foreground">Texto do botão</label>
                              <Input
                                value={button.label}
                                onChange={(event) => updateButton(button.id, { label: event.target.value })}
                                disabled={isViewMode}
                              />
                            </div>

                            {type === 'url' ? (
                              <div className="flex flex-col gap-2 md:col-span-2">
                                <label className="text-sm font-medium text-foreground">Website URL</label>
                                <Input
                                  value={button.url}
                                  onChange={(event) => updateButton(button.id, { url: event.target.value })}
                                  placeholder="https://..."
                                  disabled={isViewMode}
                                />
                              </div>
                            ) : null}

                            {type === 'phone' ? (
                              <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium text-foreground">Telefone</label>
                                <Input
                                  value={button.phoneNumber}
                                  onChange={(event) => updateButton(button.id, { phoneNumber: event.target.value })}
                                  placeholder="+5511999999999"
                                  disabled={isViewMode}
                                />
                              </div>
                            ) : null}

                            {type === 'copy_code' ? (
                              <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium text-foreground">Código de oferta</label>
                                <Input
                                  value={button.offerCode}
                                  onChange={(event) => updateButton(button.id, { offerCode: event.target.value })}
                                  placeholder="OFERTA10"
                                  disabled={isViewMode}
                                />
                              </div>
                            ) : null}

                            {type === 'flow' ? (
                              <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium text-foreground">Identificador do fluxo</label>
                                <Input
                                  value={button.flowId}
                                  onChange={(event) => updateButton(button.id, { flowId: event.target.value })}
                                  placeholder="flow_checkout"
                                  disabled={isViewMode}
                                />
                              </div>
                            ) : null}

                            {type === 'order' ? (
                              <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium text-foreground">Referência do pedido</label>
                                <Input
                                  value={button.orderReference}
                                  onChange={(event) => updateButton(button.id, { orderReference: event.target.value })}
                                  placeholder="PED-0001"
                                  disabled={isViewMode}
                                />
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <div className="mb-4">
                  <h3 className="font-medium text-foreground">Configurações</h3>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-foreground">Ativo?</span>
                  <div className="flex items-center gap-3 rounded-full border border-border bg-background px-3 py-2">
                    <Switch
                      checked={Boolean(form.active)}
                      onCheckedChange={(checked) => !isViewMode && updateForm('active', checked)}
                      disabled={isViewMode}
                      className="h-6 w-11 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted"
                    />
                    <span className={cn('text-sm font-medium', form.active ? 'text-primary' : 'text-muted-foreground')}>
                      {form.active ? 'Sim, este HSM está ativo' : 'Não, este HSM está inativo'}
                    </span>
                  </div>
                </div>
              </div>

              {submitError ? (
                <Alert className="border-destructive/30 bg-destructive/5">
                  <AlertTitle>Falha ao salvar</AlertTitle>
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              ) : null}

              {metaSaveNote && !isViewMode ? (
                <Alert className="border-amber-500/30 bg-amber-500/5">
                  <AlertTitle>Integração Meta</AlertTitle>
                  <AlertDescription>{metaSaveNote}</AlertDescription>
                </Alert>
              ) : null}
            </div>

            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <h3 className="mb-4 font-medium text-foreground">Preview</h3>
                <div className="rounded-2xl bg-[#0B141A] p-4">
                  <div className="ml-auto max-w-[340px] rounded-2xl bg-[#005C4B] p-4 text-white shadow-lg">
                    {form.headerType === 'text' && form.headerValue ? (
                      <p className="mb-2 text-sm font-semibold">{form.headerValue}</p>
                    ) : null}
                    {form.headerType === 'image' && form.headerValue ? (
                      <img src={form.headerValue} alt="Header HSM" className="mb-3 h-32 w-full rounded-xl object-cover" />
                    ) : null}
                    {form.headerType === 'video' && form.headerValue ? (
                      <video controls preload="metadata" className="mb-3 h-32 w-full rounded-xl object-cover">
                        <source src={form.headerValue} type="video/mp4" />
                      </video>
                    ) : null}
                    {form.headerType === 'document' && form.headerValue ? (
                      <div className="mb-3 rounded-xl bg-black/20 p-3 text-xs">
                        Documento: {form.headerValue}
                      </div>
                    ) : null}
                    {form.headerType === 'location' && form.headerValue ? (
                      <div className="mb-3 rounded-xl bg-black/20 p-3 text-xs">
                        Localização: {form.headerValue}
                      </div>
                    ) : null}

                    <p className="whitespace-pre-wrap text-sm">{buildPreviewText(form.body) || 'A mensagem do HSM aparecerá aqui.'}</p>

                    {form.footer ? <p className="mt-3 text-xs text-white/70">{form.footer}</p> : null}

                    {form.buttons.length > 0 ? (
                      <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-white/5">
                        {form.buttons.map((button, index) => {
                          const { icon: Icon, hint } = getPreviewButtonMeta(button.type);

                          return (
                            <div
                              key={`preview-${button.id}`}
                              className={cn(
                                'flex items-center justify-between gap-3 px-3 py-2.5 text-xs',
                                index !== form.buttons.length - 1 && 'border-b border-white/10',
                              )}
                            >
                              <div className="flex items-center gap-2">
                                <Icon className="size-3.5 text-white/80" />
                                <span className="font-medium text-white">{button.label || 'Botão'}</span>
                              </div>
                              <span className="text-[11px] uppercase tracking-[0.08em] text-white/60">{hint}</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    <div className="mt-2 text-right text-[11px] text-white/60">12:00</div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <h3 className="mb-4 font-medium text-foreground">Resumo</h3>
                <div className="flex flex-col gap-3 text-sm text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <FileText className="mt-0.5 size-4" />
                    <span>
                      <strong className="text-foreground">Identificador:</strong> {form.identifier || '-'}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <Clock3 className="mt-0.5 size-4" />
                    <span>
                      <strong className="text-foreground">Status:</strong> {statusConfig[normalizeStatus(form.status)]?.label || 'Pendente'}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <MapPin className="mt-0.5 size-4" />
                    <span>
                      <strong className="text-foreground">Header:</strong>{' '}
                      {headerTypeOptions.find((option) => option.value === form.headerType)?.label || 'Nenhum'}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    {form.headerType === 'image' ? (
                      <ImageIcon className="mt-0.5 size-4" />
                    ) : form.headerType === 'video' ? (
                      <Video className="mt-0.5 size-4" />
                    ) : (
                      <Globe className="mt-0.5 size-4" />
                    )}
                    <span>
                      <strong className="text-foreground">Categoria:</strong> {categoryLabels[form.category] || 'Marketing'}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <MessageSquare className="mt-0.5 size-4" />
                    <span>
                      <strong className="text-foreground">Botões:</strong>{' '}
                      {form.buttons.length > 0
                        ? form.buttons.map((button) => button.label || 'Botão').join(', ')
                        : 'Nenhum botão configurado'}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <Globe className="mt-0.5 size-4" />
                    <span>
                      <strong className="text-foreground">Serviços:</strong> {getServiceNames(form.serviceIds, form.serviceId) || 'Sem serviço'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Voltar
            </Button>
            {!isViewMode ? (
              <Button onClick={() => void handleSave()} disabled={isSubmitting || isUploading}>
                {isSubmitting ? 'Salvando...' : 'Salvar'}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


