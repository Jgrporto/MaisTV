import {
  Bell,
  BriefcaseBusiness,
  Headphones,
  Megaphone,
  Users,
} from 'lucide-react';

export const DEFAULT_SERVICE_PHONE_NUMBER = '+55 24 99966-3511';
export const DEFAULT_SERVICE_ICON_KEY = 'headphones';

export const SERVICE_ICON_OPTIONS = [
  {
    id: 'headphones',
    label: 'Atendimento',
    icon: Headphones,
    color: '#0F766E',
    badgeClassName: 'border-teal-500/25 bg-teal-500/10 text-teal-700',
  },
  {
    id: 'briefcase',
    label: 'Operacao',
    icon: BriefcaseBusiness,
    color: '#2563EB',
    badgeClassName: 'border-blue-500/25 bg-blue-500/10 text-blue-700',
  },
  {
    id: 'megaphone',
    label: 'Comercial',
    icon: Megaphone,
    color: '#DC2626',
    badgeClassName: 'border-red-500/25 bg-red-500/10 text-red-700',
  },
  {
    id: 'users',
    label: 'Equipe',
    icon: Users,
    color: '#7C3AED',
    badgeClassName: 'border-violet-500/25 bg-violet-500/10 text-violet-700',
  },
  {
    id: 'bell',
    label: 'Avisos',
    icon: Bell,
    color: '#D97706',
    badgeClassName: 'border-amber-500/25 bg-amber-500/10 text-amber-700',
  },
];

export const EMPTY_SERVICE = {
  id: '',
  name: '',
  description: '',
  phone_numbers: [],
  user_ids: [],
  user_emails: [],
  label_ids: [],
  icon_key: DEFAULT_SERVICE_ICON_KEY,
  created_date: '',
  updated_date: '',
};

const normalizeStringArray = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );

const LABEL_ID_ALIASES = Object.freeze({
  'label-lead': ['system-lead'],
  'system-lead': ['label-lead'],
  'label-sql': ['system-sql'],
  'system-sql': ['label-sql'],
  'label-customer': ['system-cliente'],
  'system-cliente': ['label-customer'],
  'label-churn': ['system-cancelados'],
  'system-cancelados': ['label-churn'],
});

const expandServiceLabelIds = (value) =>
  Array.from(
    new Set(
      normalizeStringArray(value).flatMap((labelId) => [labelId, ...(LABEL_ID_ALIASES[labelId] || [])]),
    ),
  );

const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');

export const normalizePhoneDisplay = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  if (raw.startsWith('+')) {
    return raw;
  }

  const digits = normalizePhoneDigits(raw);
  return digits ? `+${digits}` : raw;
};

export const getServiceIconMeta = (iconKey) =>
  SERVICE_ICON_OPTIONS.find((option) => option.id === iconKey) || SERVICE_ICON_OPTIONS[0];

const collectConversationPhoneNumbers = (conversation = {}) =>
  Array.from(
    new Set(
      [
        conversation?.display_phone_number,
        conversation?.displayPhoneNumber,
        conversation?.customer?.display_phone_number,
        conversation?.customer?.displayPhoneNumber,
      ]
        .map(normalizePhoneDisplay)
        .filter(Boolean)
    )
  );

export const normalizeService = (service = {}, index = 0) => {
  const now = new Date().toISOString();
  const name = String(service.name || '').trim();

  return {
    ...EMPTY_SERVICE,
    ...service,
    id: String(service.id || `service-${index + 1}`),
    name,
    description: String(service.description || '').trim(),
    phone_numbers: normalizeStringArray(service.phone_numbers || service.phoneNumbers),
    user_ids: normalizeStringArray(service.user_ids || service.userIds),
    user_emails: normalizeStringArray(service.user_emails || service.userEmails),
    label_ids: normalizeStringArray(service.label_ids || service.labelIds).map((labelId) =>
      ['system-cancelado-10', 'system-cancelado-20', 'system-cancelado-30'].includes(labelId)
        ? 'system-cancelados'
        : labelId
    ),
    icon_key: getServiceIconMeta(service.icon_key || service.iconKey || DEFAULT_SERVICE_ICON_KEY).id,
    created_date: String(service.created_date || service.createdAt || now),
    updated_date: String(service.updated_date || service.updatedAt || now),
  };
};

export const sortServices = (services = []) =>
  [...services].sort((left, right) =>
    String(left?.name || '').localeCompare(String(right?.name || ''), 'pt-BR', {
      sensitivity: 'base',
    }),
  );

export const resolveServiceUserMatch = (service, currentUser) => {
  const serviceUserIds = normalizeStringArray(service?.user_ids);
  const serviceUserEmails = normalizeStringArray(service?.user_emails).map((email) => email.toLowerCase());
  const currentUserId = String(currentUser?.id || '').trim();
  const currentUserEmail = String(currentUser?.email || '').trim().toLowerCase();

  if (currentUserId && serviceUserIds.includes(currentUserId)) {
    return true;
  }

  if (currentUserEmail && serviceUserEmails.includes(currentUserEmail)) {
    return true;
  }

  return false;
};

export const conversationMatchesService = (conversation, service) => {
  const serviceLabelIds = expandServiceLabelIds(service?.label_ids);
  if (serviceLabelIds.length === 0) {
    return false;
  }

  const conversationLabelIds = expandServiceLabelIds(conversation?.label_ids);
  return serviceLabelIds.some((labelId) => conversationLabelIds.includes(labelId));
};

export const decorateConversationsWithServices = (conversations = [], services = [], currentUser = null) => {
  const normalizedServices = sortServices(services.map((service, index) => normalizeService(service, index)));
  const accessibleServices = normalizedServices.filter((service) => resolveServiceUserMatch(service, currentUser));

  return conversations.map((conversation) => {
    const conversationPhoneNumbers = collectConversationPhoneNumbers(conversation);
    const matchingServices = normalizedServices.filter((service) => conversationMatchesService(conversation, service));
    const accessibleMatchingServices = accessibleServices.filter((service) =>
      matchingServices.some((matchingService) => matchingService.id === service.id),
    );

    return {
      ...conversation,
      matched_phone_numbers: conversationPhoneNumbers,
      has_explicit_phone_routing: false,
      matching_services: matchingServices,
      matching_service_ids: matchingServices.map((service) => service.id),
      accessible_services: accessibleMatchingServices,
      accessible_service_ids: accessibleMatchingServices.map((service) => service.id),
    };
  });
};

export const filterConversationsBySelectedService = (conversations = [], selectedServiceId = 'all') => {
  if (!selectedServiceId || selectedServiceId === 'all') {
    return conversations.filter((conversation) => (conversation.accessible_services || []).length > 0);
  }

  return conversations.filter((conversation) =>
    (conversation.accessible_service_ids || []).includes(selectedServiceId),
  );
};

export const resolveAvailableServicesForUser = (services = [], currentUser = null) =>
  sortServices(services.map((service, index) => normalizeService(service, index))).filter((service) =>
    resolveServiceUserMatch(service, currentUser),
  );

export const getServiceById = (services = [], serviceId = '') =>
  services.find((service) => String(service?.id || '') === String(serviceId || '')) || null;
