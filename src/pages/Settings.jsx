import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Bot,
  BriefcaseBusiness,
  CalendarClock,
  Eye,
  History,
  LogOut,
  Megaphone,
  MoonStar,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Sun,
  Trash2,
  Upload,
  User,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';

import PageHeader from '@/components/layout/PageHeader';
import PageSectionCard from '@/components/layout/PageSectionCard';
import PageShell from '@/components/layout/PageShell';
import ServiceFormDialog from '@/components/settings/ServiceFormDialog';
import ServiceIconBadge from '@/components/services/ServiceIconBadge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { SYSTEM_LABELS, useLabelCatalog } from '@/lib/labels';
import { useAuth } from '@/lib/AuthContext';
import { resolveEffectiveUser } from '@/lib/current-user';
import { disconnectLocalUserSessions } from '@/lib/local-auth';
import { requestLocalApiJson } from '@/lib/local-api';
import { fetchLocalHsms, uploadHsmMedia } from '@/lib/hsm-api';
import {
  DEFAULT_NAVIGATION_PERMISSIONS,
  NAVIGATION_PERMISSION_OPTIONS,
  normalizeNavigationPermissions,
} from '@/lib/navigation-permissions';
import { deleteService, fetchAvailableWhatsappNumbers, fetchServices, saveService } from '@/lib/services-api';
import { normalizeService } from '@/lib/services';
import { cn } from '@/lib/utils';
import {
  CUSTOMER_SYNC_INTERVAL_OPTIONS,
  DEFAULT_CUSTOMER_SYNC_SETTINGS,
  fetchCustomerSyncSettings,
  formatCustomerSyncIntervalLabel,
  readCustomerSyncSettings,
  saveCustomerSyncSettings,
} from '@/lib/customer-sync-settings';
import {
  DEFAULT_DASHBOARD_SETTINGS,
  fetchDashboardSettings,
  normalizeDashboardSettings,
  saveDashboardSettings,
} from '@/lib/dashboard-settings';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  fetchNotificationSettings,
  MAX_NOTIFICATION_AUDIO_SIZE_BYTES,
  playNotificationSound,
  readNotificationSettings,
  saveNotificationSettings,
} from '@/lib/notification-settings';
import {
  DEFAULT_SCHEDULE_SETTINGS,
  fetchScheduleSettings,
  normalizeScheduleSettings,
  saveScheduleSettings,
} from '@/lib/schedule-settings';
import {
  DEFAULT_TAVINHO_SETTINGS,
  fetchTavinhoSettings,
  normalizeTavinhoSettings,
  saveTavinhoSettings,
} from '@/lib/tavinho-settings';
import {
  canEditSettingsSection,
  canViewSettingsSection,
  DEFAULT_ROLE_SETTINGS_ACCESS,
  HIDDEN_ROLE_SETTINGS_ACCESS,
  normalizeRoleSettingsAccess,
  SETTINGS_ACCESS_LEVELS,
  SETTINGS_SECTION_OPTIONS,
} from '@/lib/role-settings-access';

const SETTINGS_AUDIT_STORAGE_KEY = 'saastv:settings:audit:v1';

const DEFAULT_ROLE_PERMISSIONS = { ...DEFAULT_NAVIGATION_PERMISSIONS };
const ROLE_PERMISSION_OPTIONS = NAVIGATION_PERMISSION_OPTIONS;

const createEmptyUserForm = (roleId = '') => ({
  id: '',
  full_name: '',
  username: '',
  password: '',
  description: '',
  role_id: roleId,
});

const createEmptyRoleForm = () => ({
  id: '',
  name: '',
  description: '',
  department_key: '',
  permissions: { ...DEFAULT_ROLE_PERMISSIONS },
  settings_access: { ...DEFAULT_ROLE_SETTINGS_ACCESS },
});

const readJsonStorage = (key, fallback) => {
  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const writeJsonStorage = (key, value) => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(value));
};

const toSlug = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const buildInitials = (value) =>
  String(value || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';

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

const isMediaHeaderKind = (template = {}) => ['image', 'video', 'document'].includes(getHeaderKind(template));

const getTemplateHeaderMediaValue = (template = {}) =>
  String(template?.headerMediaUrl || template?.headerExample || template?.headerValue || '').trim();

const getConfiguredVariableValue = (items = [], index) => {
  const item = Array.isArray(items) ? items[index - 1] : null;
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  return String(item.value || item.example || item.defaultValue || item.text || item.key || '').trim();
};

const buildConfiguredHsmVariables = (template, bodyIndexes = [], headerIndexes = [], buttonIndexes = []) => ({
  body: Object.fromEntries(bodyIndexes.map((index) => [index, getConfiguredVariableValue(template?.bodyVariables, index)])),
  header: Object.fromEntries(headerIndexes.map((index) => [index, getConfiguredVariableValue(template?.headerVariables, index)])),
  buttons: Object.fromEntries(buttonIndexes.map((index) => [index, getConfiguredVariableValue(template?.buttonVariables, index)])),
});

const getHeaderMediaAccept = (template = {}) => {
  const kind = getHeaderKind(template);
  if (kind === 'image') return 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
  if (kind === 'video') return 'video/mp4,video/3gpp,.mp4,.3gp';
  if (kind === 'document') return '.pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';
  return '*/*';
};

const normalizeTemplateButtonType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'url' || normalized === 'acessar_site' || normalized === 'website') return 'Site';
  if (normalized === 'phone' || normalized === 'ligar') return 'Telefone';
  if (normalized === 'copy_code' || normalized === 'copiar_codigo') return 'Copiar codigo';
  if (normalized === 'flow' || normalized === 'fluxo_whatsapp') return 'Fluxo';
  if (normalized === 'order' || normalized === 'pedido') return 'Pedido';
  return 'Resposta rapida';
};

const getTemplateButtons = (template = {}) => {
  if (Array.isArray(template.buttons) && template.buttons.length > 0) {
    return template.buttons.map((button, index) => ({
      id: String(button?.id || `button-${index}`),
      label: String(button?.label || button?.text || `Botao ${index + 1}`).trim(),
      type: normalizeTemplateButtonType(button?.type),
      value: String(button?.url || button?.phoneNumber || button?.offerCode || button?.flowId || button?.orderReference || '').trim(),
    }));
  }

  if (Array.isArray(template.buttonConfig) && template.buttonConfig.length > 0) {
    return template.buttonConfig.map((button, index) => ({
      id: String(button?.id || `button-config-${index}`),
      label: String(button?.text || button?.label || `Botao ${index + 1}`).trim(),
      type: normalizeTemplateButtonType(button?.type),
      value: String(button?.url || button?.phoneNumber || button?.phone_number || button?.offerCode || button?.offer_code || button?.flowId || button?.orderReference || '').trim(),
    }));
  }

  if (template?.hasButton && (template?.buttonText || template?.buttonUrl)) {
    return [
      {
        id: 'legacy-button',
        label: String(template.buttonText || 'Botao').trim(),
        type: 'Site',
        value: String(template.buttonUrl || '').trim(),
      },
    ];
  }

  return [];
};

const formatDateTime = (value) => {
  if (!value) {
    return 'Agora';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Sem data';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(parsed);
};

const getAuditActionLabel = (action) =>
  (
    {
      created: 'Criado',
      updated: 'Atualizado',
      deleted: 'Apagado',
    }[action] || action
  );

const getPermissionLabel = (permissionKey) =>
  ROLE_PERMISSION_OPTIONS.find(([key]) => key === permissionKey)?.[1] || permissionKey;

const requestLocalEntity = async (entityName, { method = 'GET', id = '', body } = {}) => {
  return await requestLocalApiJson(
    `/entities/${entityName}${id ? `/${id}` : ''}`,
    {
      method,
      headers: body
        ? {
            'Content-Type': 'application/json',
          }
        : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
    'Não foi possível concluir a operação.',
  );
};

const resolveRoleForUser = (teamUser, roles) =>
  roles.find((role) => role.id === teamUser?.role_id) ||
  roles.find((role) => role.name === teamUser?.role_name) ||
  roles.find((role) => role.name === teamUser?.role) ||
  null;

const buildAccessSummary = (permissions = {}) =>
  Object.entries(permissions)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([key]) => getPermissionLabel(key));

function SectionHeading({ icon: Icon, title, description, action }) {
  return (
    <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const { effectiveUser } = useAuth();
  const queryClient = useQueryClient();
  const [user, setUser] = useState(effectiveUser);
  const [teamFilter, setTeamFilter] = useState('all');
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [userDialogMode, setUserDialogMode] = useState('create');
  const [userForm, setUserForm] = useState(createEmptyUserForm());
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [roleDialogMode, setRoleDialogMode] = useState('create');
  const [roleForm, setRoleForm] = useState(createEmptyRoleForm());
  const [serviceDialogOpen, setServiceDialogOpen] = useState(false);
  const [serviceDialogMode, setServiceDialogMode] = useState('create');
  const [selectedService, setSelectedService] = useState(null);
  const [historyDialog, setHistoryDialog] = useState({ open: false, entityType: 'user', entityId: '', label: '' });
  const [notificationSettings, setNotificationSettings] = useState(DEFAULT_NOTIFICATION_SETTINGS);
  const [dashboardSettings, setDashboardSettings] = useState(DEFAULT_DASHBOARD_SETTINGS);
  const [dashboardKeywordInput, setDashboardKeywordInput] = useState('');
  const [customerSyncSettings, setCustomerSyncSettings] = useState(DEFAULT_CUSTOMER_SYNC_SETTINGS);
  const [scheduleSettings, setScheduleSettings] = useState(DEFAULT_SCHEDULE_SETTINGS);
  const [tavinhoSettings, setTavinhoSettings] = useState(DEFAULT_TAVINHO_SETTINGS);
  const [settingsAudit, setSettingsAudit] = useState(() => readJsonStorage(SETTINGS_AUDIT_STORAGE_KEY, []));
  const [activeSettingsTab, setActiveSettingsTab] = useState('profile');
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    description: '',
    confirmLabel: 'Confirmar',
    destructive: false,
    isRunning: false,
    onConfirm: null,
  });
  const [disconnectingUserId, setDisconnectingUserId] = useState('');
  const [isSavingUser, setIsSavingUser] = useState(false);
  const [isSavingRole, setIsSavingRole] = useState(false);
  const [isSavingScheduleSettings, setIsSavingScheduleSettings] = useState(false);
  const [isSavingTavinhoSettings, setIsSavingTavinhoSettings] = useState(false);
  const [scheduleMediaUpload, setScheduleMediaUpload] = useState({ loading: false, error: '' });
  const { customLabels } = useLabelCatalog();
  const notificationSettingsHydratedRef = useRef(false);
  const lastSavedNotificationSettingsRef = useRef(JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS));
  const dashboardSettingsHydratedRef = useRef(false);
  const lastSavedDashboardSettingsRef = useRef(JSON.stringify(DEFAULT_DASHBOARD_SETTINGS));
  const customerSyncSettingsHydratedRef = useRef(false);
  const lastSavedCustomerSyncSettingsRef = useRef(JSON.stringify(DEFAULT_CUSTOMER_SYNC_SETTINGS));
  const scheduleSettingsHydratedRef = useRef(false);
  const lastSavedScheduleSettingsRef = useRef(JSON.stringify(DEFAULT_SCHEDULE_SETTINGS));
  const tavinhoSettingsHydratedRef = useRef(false);
  const lastSavedTavinhoSettingsRef = useRef(JSON.stringify(DEFAULT_TAVINHO_SETTINGS));
  const scheduleMediaInputRef = useRef(null);
  const labelOptions = useMemo(() => [...SYSTEM_LABELS, ...customLabels], [customLabels]);

  useEffect(() => {
    setUser(resolveEffectiveUser(effectiveUser));
  }, [effectiveUser]);

  useEffect(() => {
    writeJsonStorage(SETTINGS_AUDIT_STORAGE_KEY, settingsAudit);
  }, [settingsAudit]);

  const { data: users = [], isLoading: usersLoading } = useQuery({
    queryKey: ['settings', 'users'],
    queryFn: () => requestLocalEntity('User'),
  });

  const { data: roles = [], isLoading: rolesLoading } = useQuery({
    queryKey: ['settings', 'roles'],
    queryFn: () => requestLocalEntity('Role'),
  });

  const { data: services = [], isLoading: servicesLoading } = useQuery({
    queryKey: ['settings', 'services'],
    queryFn: fetchServices,
  });

  const { data: availableNumbers = [] } = useQuery({
    queryKey: ['settings', 'service-numbers', services.map((service) => service.id).join('|')],
    queryFn: () => fetchAvailableWhatsappNumbers(services),
    staleTime: 10000,
  });

  const { data: notificationSettingsData } = useQuery({
    queryKey: ['settings', 'notification-settings'],
    queryFn: fetchNotificationSettings,
    staleTime: 10000,
    refetchInterval: 15000,
  });

  const { data: dashboardSettingsData } = useQuery({
    queryKey: ['settings', 'dashboard-settings'],
    queryFn: fetchDashboardSettings,
    staleTime: 10000,
    refetchInterval: 15000,
  });

  const { data: customerSyncSettingsData } = useQuery({
    queryKey: ['settings', 'customer-sync-settings'],
    queryFn: fetchCustomerSyncSettings,
    staleTime: 10000,
    refetchInterval: 15000,
  });

  const { data: scheduleSettingsData } = useQuery({
    queryKey: ['settings', 'schedule-settings'],
    queryFn: fetchScheduleSettings,
    staleTime: 10000,
    refetchInterval: 15000,
  });

  const { data: tavinhoSettingsData } = useQuery({
    queryKey: ['settings', 'tavinho-settings'],
    queryFn: fetchTavinhoSettings,
    staleTime: 10000,
    refetchInterval: 15000,
  });

  const { data: hsmSnapshot } = useQuery({
    queryKey: ['settings', 'local-hsms'],
    queryFn: fetchLocalHsms,
    staleTime: 30000,
  });

  const hsmTemplates = useMemo(
    () => (Array.isArray(hsmSnapshot?.items) ? hsmSnapshot.items : []),
    [hsmSnapshot]
  );

  useEffect(() => {
    if (!notificationSettingsData) {
      return;
    }

    const normalized = readNotificationSettings(notificationSettingsData);
    const normalizedSerialized = JSON.stringify(normalized);
    lastSavedNotificationSettingsRef.current = normalizedSerialized;
    notificationSettingsHydratedRef.current = true;
    setNotificationSettings((current) => (JSON.stringify(current) === normalizedSerialized ? current : normalized));
  }, [notificationSettingsData]);

  useEffect(() => {
    if (!dashboardSettingsData) {
      return;
    }

    const normalized = normalizeDashboardSettings(dashboardSettingsData);
    const normalizedSerialized = JSON.stringify(normalized);
    lastSavedDashboardSettingsRef.current = normalizedSerialized;
    dashboardSettingsHydratedRef.current = true;
    setDashboardSettings((current) => (JSON.stringify(current) === normalizedSerialized ? current : normalized));
  }, [dashboardSettingsData]);

  useEffect(() => {
    if (!customerSyncSettingsData) {
      return;
    }

    const normalized = readCustomerSyncSettings(customerSyncSettingsData);
    const normalizedSerialized = JSON.stringify(normalized);
    lastSavedCustomerSyncSettingsRef.current = normalizedSerialized;
    customerSyncSettingsHydratedRef.current = true;
    setCustomerSyncSettings((current) => (JSON.stringify(current) === normalizedSerialized ? current : normalized));
  }, [customerSyncSettingsData]);

  useEffect(() => {
    if (!scheduleSettingsData) {
      return;
    }

    const normalized = normalizeScheduleSettings(scheduleSettingsData);
    const currentSerialized = JSON.stringify(scheduleSettings);
    const normalizedSerialized = JSON.stringify(normalized);
    if (scheduleSettingsHydratedRef.current && currentSerialized !== lastSavedScheduleSettingsRef.current) {
      return;
    }

    lastSavedScheduleSettingsRef.current = normalizedSerialized;
    scheduleSettingsHydratedRef.current = true;
    if (currentSerialized !== normalizedSerialized) {
      setScheduleSettings(normalized);
    }
  }, [scheduleSettings, scheduleSettingsData]);

  useEffect(() => {
    if (!tavinhoSettingsData) {
      return;
    }

    const normalized = normalizeTavinhoSettings(tavinhoSettingsData);
    const currentSerialized = JSON.stringify(tavinhoSettings);
    const normalizedSerialized = JSON.stringify(normalized);
    if (tavinhoSettingsHydratedRef.current && currentSerialized !== lastSavedTavinhoSettingsRef.current) {
      return;
    }

    lastSavedTavinhoSettingsRef.current = normalizedSerialized;
    tavinhoSettingsHydratedRef.current = true;
    if (currentSerialized !== normalizedSerialized) {
      setTavinhoSettings(normalized);
    }
  }, [tavinhoSettings, tavinhoSettingsData]);

  useEffect(() => {
    if (!notificationSettingsHydratedRef.current) {
      return;
    }

    const serializedSettings = JSON.stringify(notificationSettings);
    if (serializedSettings === lastSavedNotificationSettingsRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void saveNotificationSettings(notificationSettings)
        .then((savedSettings) => {
          const normalized = readNotificationSettings(savedSettings);
          lastSavedNotificationSettingsRef.current = JSON.stringify(normalized);
          queryClient.setQueryData(['settings', 'notification-settings'], normalized);
          setNotificationSettings(normalized);
        })
        .catch((error) => {
          toast.error(error?.message || 'Não foi possível salvar as configuracoes de notificacao.');
        });
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [notificationSettings, queryClient]);

  useEffect(() => {
    if (!dashboardSettingsHydratedRef.current) {
      return;
    }

    const serializedSettings = JSON.stringify(dashboardSettings);
    if (serializedSettings === lastSavedDashboardSettingsRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void saveDashboardSettings(dashboardSettings)
        .then((savedSettings) => {
          const normalized = normalizeDashboardSettings(savedSettings);
          lastSavedDashboardSettingsRef.current = JSON.stringify(normalized);
          queryClient.setQueryData(['settings', 'dashboard-settings'], normalized);
          setDashboardSettings(normalized);
        })
        .catch((error) => {
          toast.error(error?.message || 'Não foi possível salvar as configurações da Dashboard.');
        });
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [dashboardSettings, queryClient]);

  useEffect(() => {
    if (!customerSyncSettingsHydratedRef.current) {
      return;
    }

    const serializedSettings = JSON.stringify(customerSyncSettings);
    if (serializedSettings === lastSavedCustomerSyncSettingsRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void saveCustomerSyncSettings(customerSyncSettings)
        .then((savedSettings) => {
          const normalized = readCustomerSyncSettings(savedSettings);
          lastSavedCustomerSyncSettingsRef.current = JSON.stringify(normalized);
          queryClient.setQueryData(['settings', 'customer-sync-settings'], normalized);
          setCustomerSyncSettings(normalized);
          void queryClient.invalidateQueries({ queryKey: ['customer-sync-state'] });
        })
        .catch((error) => {
          toast.error(error?.message || 'Não foi possível salvar o intervalo da sincronizacao automatica.');
        });
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [customerSyncSettings, queryClient]);

  const roleMembersCount = useMemo(() => {
    const counts = {};

    users.forEach((teamUser) => {
      const matchedRole = resolveRoleForUser(teamUser, roles);
      const roleId = matchedRole?.id || 'without-role';
      counts[roleId] = (counts[roleId] || 0) + 1;
    });

    return counts;
  }, [roles, users]);

  const filteredUsers = useMemo(() => {
    if (teamFilter === 'all') {
      return users;
    }

    return users.filter((teamUser) => resolveRoleForUser(teamUser, roles)?.id === teamFilter);
  }, [roles, teamFilter, users]);

  const usersById = useMemo(
    () => new Map(users.map((teamUser) => [String(teamUser.id || ''), teamUser])),
    [users],
  );

  const usersByEmail = useMemo(
    () =>
      new Map(
        users
          .filter((teamUser) => teamUser?.email)
          .map((teamUser) => [String(teamUser.email || '').trim().toLowerCase(), teamUser]),
      ),
    [users],
  );

  const labelsById = useMemo(
    () => new Map(labelOptions.map((label) => [String(label.id || ''), label])),
    [labelOptions],
  );

  const historyEntries = useMemo(
    () =>
      settingsAudit.filter(
        (entry) => entry.entityType === historyDialog.entityType && String(entry.entityId) === String(historyDialog.entityId),
      ),
    [historyDialog.entityId, historyDialog.entityType, settingsAudit],
  );

  const isUserReadOnly = userDialogMode === 'view';
  const isRoleReadOnly = roleDialogMode === 'view';
  const currentUserRole = useMemo(() => resolveRoleForUser(user, roles), [roles, user]);
  const canOpenSettingsRoute =
    String(user?.role || '').trim().toLowerCase() === 'admin' ||
    String(user?.role_name || '').trim().toLowerCase() === 'administrador' ||
    Boolean(currentUserRole?.permissions?.settings || user?.role_permissions?.settings || user?.permissions?.settings);
  const currentSettingsAccess = useMemo(() => {
    if (!canOpenSettingsRoute) {
      return HIDDEN_ROLE_SETTINGS_ACCESS;
    }

    return normalizeRoleSettingsAccess(
      currentUserRole?.settings_access || currentUserRole?.settingsAccess || user?.settings_access || user?.settingsAccess,
    );
  }, [canOpenSettingsRoute, currentUserRole?.settings_access, currentUserRole?.settingsAccess, user?.settings_access, user?.settingsAccess]);
  const canEditTeamSection = canEditSettingsSection(currentSettingsAccess, 'team');
  const canEditRolesSection = canEditSettingsSection(currentSettingsAccess, 'roles');
  const canEditServicesSection = canEditSettingsSection(currentSettingsAccess, 'services');
  const visibleSettingsTabs = useMemo(
    () => SETTINGS_SECTION_OPTIONS.filter(([sectionKey]) => canViewSettingsSection(currentSettingsAccess, sectionKey)),
    [currentSettingsAccess],
  );


  useEffect(() => {
    if (!visibleSettingsTabs.length) {
      return;
    }

    if (!visibleSettingsTabs.some(([sectionKey]) => sectionKey === activeSettingsTab)) {
      setActiveSettingsTab(visibleSettingsTabs[0][0]);
    }
  }, [activeSettingsTab, visibleSettingsTabs]);

  const openConfirmDialog = ({ title, description, confirmLabel = 'Confirmar', destructive = false, onConfirm }) => {
    setConfirmDialog({
      open: true,
      title,
      description,
      confirmLabel,
      destructive,
      isRunning: false,
      onConfirm,
    });
  };

  const handleConfirmDialogOpenChange = (open) => {
    if (!open && !confirmDialog.isRunning) {
      setConfirmDialog((current) => ({ ...current, open: false, onConfirm: null }));
    }
  };

  const handleConfirmDialogAction = async (event) => {
    event?.preventDefault?.();

    if (typeof confirmDialog.onConfirm !== 'function') {
      setConfirmDialog((current) => ({ ...current, open: false, onConfirm: null }));
      return;
    }

    setConfirmDialog((current) => ({ ...current, isRunning: true }));

    try {
      await confirmDialog.onConfirm();
      setConfirmDialog((current) => ({ ...current, open: false, isRunning: false, onConfirm: null }));
    } catch {
      setConfirmDialog((current) => ({ ...current, isRunning: false }));
    }
  };

  const appendAuditEntry = ({ entityType, entityId, label, action, detail }) => {
    setSettingsAudit((current) => [
      {
        id: `${entityType}-${action}-${Date.now().toString(36)}`,
        entityType,
        entityId,
        label,
        action,
        detail,
        actor: user?.full_name || 'Operador local',
        createdAt: new Date().toISOString(),
      },
      ...current,
    ].slice(0, 180));
  };

  const invalidateSettingsQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['settings', 'users'] }),
      queryClient.invalidateQueries({ queryKey: ['settings', 'roles'] }),
      queryClient.invalidateQueries({ queryKey: ['settings', 'services'] }),
      queryClient.invalidateQueries({ queryKey: ['settings', 'service-numbers'] }),
    ]);
  };

  const openCreateUserDialog = () => {
    if (!canEditTeamSection) {
      return;
    }
    setUserDialogMode('create');
    setUserForm(createEmptyUserForm(roles[0]?.id || ''));
    setUserDialogOpen(true);
  };

  const openUserDialog = (mode, teamUser) => {
    const matchedRole = resolveRoleForUser(teamUser, roles);
    const effectiveMode = mode === 'edit' && !canEditTeamSection ? 'view' : mode;

    setUserDialogMode(effectiveMode);
    setUserForm({
      id: teamUser.id,
      full_name: teamUser.full_name || '',
      username: teamUser.username || '',
      password: '',
      description: teamUser.description || '',
      role_id: matchedRole?.id || '',
    });
    setUserDialogOpen(true);
  };

  const openCreateRoleDialog = () => {
    if (!canEditRolesSection) {
      return;
    }
    setRoleDialogMode('create');
    setRoleForm(createEmptyRoleForm());
    setRoleDialogOpen(true);
  };

  const openRoleDialog = (mode, role) => {
    const effectiveMode = mode === 'edit' && !canEditRolesSection ? 'view' : mode;
    setRoleDialogMode(effectiveMode);
    setRoleForm({
      id: role.id,
      name: role.name || '',
      description: role.description || '',
      department_key: role.department_key || '',
      permissions: normalizeNavigationPermissions(role.permissions, DEFAULT_ROLE_PERMISSIONS),
      settings_access: normalizeRoleSettingsAccess(role.settings_access || role.settingsAccess),
    });
    setRoleDialogOpen(true);
  };

  const openCreateServiceDialog = () => {
    if (!canEditServicesSection) {
      return;
    }
    setServiceDialogMode('create');
    setSelectedService(null);
    setServiceDialogOpen(true);
  };

  const openServiceDialog = (mode, service) => {
    setServiceDialogMode(mode === 'edit' && !canEditServicesSection ? 'view' : mode);
    setSelectedService(normalizeService(service));
    setServiceDialogOpen(true);
  };

  const handleUserFieldChange = (field, value) => {
    setUserForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleRoleFieldChange = (field, value) => {
    setRoleForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleRolePermissionChange = (permissionKey, checked) => {
    setRoleForm((current) => {
      const nextPermissions = {
        ...normalizeNavigationPermissions(current.permissions, DEFAULT_ROLE_PERMISSIONS),
        [permissionKey]: Boolean(checked),
      };

      return {
        ...current,
        permissions: nextPermissions,
        settings_access: nextPermissions.settings ? current.settings_access : HIDDEN_ROLE_SETTINGS_ACCESS,
      };
    });
  };

  const handleRoleSettingsAccessChange = (sectionKey, value) => {
    setRoleForm((current) => ({
      ...current,
      settings_access: {
        ...normalizeRoleSettingsAccess(current.settings_access),
        [sectionKey]: value,
      },
    }));
  };

  const handleNotificationToggle = (field, checked) => {
    setNotificationSettings((current) => ({
      ...current,
      [field]: Boolean(checked),
    }));
  };

  const handleNotificationValueChange = (field, value) => {
    setNotificationSettings((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleCustomerSyncIntervalChange = (value) => {
    const nextValue = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(nextValue) || nextValue <= 0) {
      return;
    }

    setCustomerSyncSettings((current) => ({
      ...current,
      autoSyncIntervalMinutes: nextValue,
    }));
  };

  const handleDashboardNumberChange = (field, value) => {
    const nextValue = Number.parseInt(String(value || ''), 10);
    setDashboardSettings((current) => ({
      ...current,
      [field]: Number.isFinite(nextValue) && nextValue > 0 ? nextValue : 1,
    }));
  };

  const addDashboardKeyword = () => {
    const keyword = dashboardKeywordInput.trim();
    if (!keyword) return;
    setDashboardSettings((current) => ({
      ...current,
      adKeywords: Array.from(new Set([...(current.adKeywords || []), keyword])),
    }));
    setDashboardKeywordInput('');
  };

  const removeDashboardKeyword = (keyword) => {
    setDashboardSettings((current) => ({
      ...current,
      adKeywords: (current.adKeywords || []).filter((item) => item !== keyword),
    }));
  };

  const handleDashboardSalesGoalChange = (teamUser, value) => {
    const key = String(teamUser?.id || teamUser?.email || teamUser?.username || '').trim();
    if (!key) return;
    const parsed = Number.parseInt(String(value || ''), 10);
    setDashboardSettings((current) => ({
      ...current,
      salesGoalsByUserId: {
        ...(current.salesGoalsByUserId || {}),
        [key]: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
      },
    }));
  };

  const handleAudioUpload = (fieldPrefix, successLabel) => (event) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!file.type.startsWith('audio/')) {
      toast.error('Selecione um arquivo de audio valido.');
      event.target.value = '';
      return;
    }

    if (file.size > MAX_NOTIFICATION_AUDIO_SIZE_BYTES) {
      toast.error('Use um audio de ate 2 MB para manter a configuracao leve.');
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setNotificationSettings((current) => ({
        ...current,
        [`${fieldPrefix}Name`]: file.name,
        [`${fieldPrefix}DataUrl`]: String(reader.result || ''),
      }));
      toast.success(`${successLabel} salvo no navegador.`);
      event.target.value = '';
    };
    reader.onerror = () => {
      toast.error('Não foi possível carregar o audio selecionado.');
      event.target.value = '';
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveAudio = (fieldPrefix) => {
    setNotificationSettings((current) => ({
      ...current,
      [`${fieldPrefix}Name`]: '',
      [`${fieldPrefix}DataUrl`]: '',
    }));
  };

  const handlePlayStoredAudio = async (dataUrl) => {
    if (!dataUrl) {
      return;
    }

    try {
      const audio = new Audio(dataUrl);
      audio.preload = 'auto';
      audio.volume = 0.9;
      await audio.play();
    } catch {
      toast.error('O navegador bloqueou a reproducao automatica do audio.');
    }
  };

  const handlePlayDefaultAudioPreview = async () => {
    try {
      await playNotificationSound({
        ...notificationSettings,
        enableBrowserSound: true,
      });
    } catch {
      toast.error('O navegador bloqueou a reproducao automatica do audio.');
    }
  };

  const handleSaveUser = async () => {
    const selectedRole = roles.find((role) => role.id === userForm.role_id);

    if (!userForm.full_name.trim() || !userForm.username.trim()) {
      toast.error('Preencha nome e usuario para salvar a equipe.');
      return;
    }

    if (!selectedRole) {
      toast.error('Selecione uma função válida para este usuário.');
      return;
    }

    if (userDialogMode === 'create' && !userForm.password.trim()) {
      toast.error('Informe uma senha inicial para o novo usuario.');
      return;
    }

    const existingUser = users.find((teamUser) => teamUser.id === userForm.id) || null;
    const emailFallback = `${toSlug(userForm.username)}@saastv.local`;
    const payload = {
      full_name: userForm.full_name.trim(),
      username: userForm.username.trim(),
      password: userForm.password.trim(),
      description: userForm.description.trim(),
      role_id: selectedRole.id,
      role_name: selectedRole.name,
      role: selectedRole.name,
      email: existingUser?.email || emailFallback,
    };

    try {
      setIsSavingUser(true);
      const savedUser =
        userDialogMode === 'create'
          ? await requestLocalEntity('User', { method: 'POST', body: payload })
          : await requestLocalEntity('User', { method: 'PUT', id: userForm.id, body: payload });

      appendAuditEntry({
        entityType: 'user',
        entityId: savedUser.id,
        label: savedUser.full_name,
        action: userDialogMode === 'create' ? 'created' : 'updated',
        detail:
          userDialogMode === 'create'
            ? `Usuario ${savedUser.username} criado na funcao ${selectedRole.name}.`
            : `Cadastro ajustado para a funcao ${selectedRole.name}.`,
      });

      await invalidateSettingsQueries();
      setUserDialogOpen(false);
      toast.success(userDialogMode === 'create' ? 'Usuario criado com sucesso.' : 'Usuario atualizado com sucesso.');
    } catch (error) {
      toast.error(error?.message || 'Não foi possível salvar o usuario.');
    } finally {
      setIsSavingUser(false);
    }
  };

  const handleDeleteUser = (teamUser) => {
    if (!canEditTeamSection) {
      return;
    }

    openConfirmDialog({
      title: 'Apagar usuário',
      description: `Deseja apagar ${teamUser.full_name || 'este usuário'}? Esta ação remove o cadastro local e encerra sessões ativas desse usuário.`,
      confirmLabel: 'Apagar usuário',
      destructive: true,
      onConfirm: async () => {
        try {
          await requestLocalEntity('User', { method: 'DELETE', id: teamUser.id });
          appendAuditEntry({
            entityType: 'user',
            entityId: teamUser.id,
            label: teamUser.full_name,
            action: 'deleted',
            detail: 'Usuario removido da equipe local.',
          });
          await invalidateSettingsQueries();
          toast.success('Usuario removido da equipe.');
        } catch (error) {
          toast.error(error?.message || 'Não foi possível apagar o usuario.');
        }
      },
    });
  };

  const handleAdminLogoutUser = (teamUser) => {
    if (!canEditTeamSection) {
      return;
    }

    openConfirmDialog({
      title: 'Desconectar usuário',
      description: `Deseja desconectar ${teamUser.full_name || 'este usuário'} agora? As sessões abertas serão invalidadas e ele precisará entrar novamente.`,
      confirmLabel: 'Desconectar',
      onConfirm: async () => {
        try {
          setDisconnectingUserId(teamUser.id);
          const result = await disconnectLocalUserSessions(teamUser.id);
          appendAuditEntry({
            entityType: 'user',
            entityId: teamUser.id,
            label: teamUser.full_name,
            action: 'updated',
            detail: `Sessões administrativas encerradas (${result?.removedSessions || 0} sessão(ões) invalidadas).`,
          });
          toast.success('Usuário desconectado com sucesso.');
        } catch (error) {
          toast.error(error?.message || 'Não foi possível desconectar o usuário.');
        } finally {
          setDisconnectingUserId('');
        }
      },
    });
  };

  const handleSaveRole = async () => {
    const normalizedName = roleForm.name.trim();
    const departmentKey = toSlug(roleForm.department_key || roleForm.name);

    if (!normalizedName) {
      toast.error('Informe o nome da função antes de salvar.');
      return;
    }

    const payload = {
      name: normalizedName,
      description: roleForm.description.trim(),
      department_key: departmentKey,
      permissions: normalizeNavigationPermissions(roleForm.permissions, DEFAULT_ROLE_PERMISSIONS),
      settings_access: roleForm.permissions.settings
        ? normalizeRoleSettingsAccess(roleForm.settings_access)
        : HIDDEN_ROLE_SETTINGS_ACCESS,
    };

    try {
      setIsSavingRole(true);
      const savedRole =
        roleDialogMode === 'create'
          ? await requestLocalEntity('Role', { method: 'POST', body: payload })
          : await requestLocalEntity('Role', { method: 'PUT', id: roleForm.id, body: payload });

      appendAuditEntry({
        entityType: 'role',
        entityId: savedRole.id,
        label: savedRole.name,
        action: roleDialogMode === 'create' ? 'created' : 'updated',
        detail:
          roleDialogMode === 'create'
            ? `Função criada para o departamento ${savedRole.department_key}.`
            : 'Permissões e descrição ajustadas.',
      });

      await invalidateSettingsQueries();
      setRoleDialogOpen(false);
      toast.success(roleDialogMode === 'create' ? 'Função criada com sucesso.' : 'Função atualizada com sucesso.');
    } catch (error) {
      toast.error(error?.message || 'Não foi possível salvar a funcao.');
    } finally {
      setIsSavingRole(false);
    }
  };

  const handleDeleteRole = (role) => {
    if (!canEditRolesSection) {
      return;
    }

    const members = roleMembersCount[role.id] || 0;
    if (members > 0) {
      toast.error('Remaneje os usuários desta função antes de apagar o departamento.');
      return;
    }

    openConfirmDialog({
      title: 'Apagar função',
      description: `Deseja apagar a função ${role.name}? Esta ação remove o perfil de acesso da configuração local.`,
      confirmLabel: 'Apagar função',
      destructive: true,
      onConfirm: async () => {
        try {
          await requestLocalEntity('Role', { method: 'DELETE', id: role.id });
          appendAuditEntry({
            entityType: 'role',
            entityId: role.id,
            label: role.name,
            action: 'deleted',
            detail: 'Função removida da configuração local.',
          });
          await invalidateSettingsQueries();
          toast.success('Função removida com sucesso.');
        } catch (error) {
          toast.error(error?.message || 'Não foi possível apagar a funcao.');
        }
      },
    });
  };

  const handleSaveService = async (payload) => {
    const serviceId = serviceDialogMode === 'edit' ? selectedService?.id || '' : '';

    try {
      const savedService = await saveService(serviceId, payload);
      appendAuditEntry({
        entityType: 'service',
        entityId: savedService.id,
        label: savedService.name,
        action: serviceDialogMode === 'create' ? 'created' : 'updated',
        detail:
          serviceDialogMode === 'create'
            ? `Serviço criado com ${savedService.phone_numbers.length} numero(s), ${savedService.user_ids.length} usuario(s) e ${savedService.label_ids.length} etiqueta(s).`
            : 'Serviço atualizado com nova configuração operacional.',
      });
      await invalidateSettingsQueries();
      setSelectedService(savedService);
      setServiceDialogOpen(false);
      toast.success(serviceDialogMode === 'create' ? 'Serviço criado com sucesso.' : 'Serviço atualizado com sucesso.');
    } catch (error) {
      toast.error(error?.message || 'Não foi possível salvar o servico.');
      throw error;
    }
  };

  const handleDeleteService = (service) => {
    if (!canEditServicesSection) {
      return;
    }

    const normalized = normalizeService(service);
    openConfirmDialog({
      title: 'Apagar serviço',
      description: `Deseja apagar o serviço ${normalized.name || 'selecionado'}? As filas e vínculos desta configuração serão removidos.`,
      confirmLabel: 'Apagar serviço',
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteService(normalized.id);
          appendAuditEntry({
            entityType: 'service',
            entityId: normalized.id,
            label: normalized.name,
            action: 'deleted',
            detail: 'Serviço removido da configuracao local.',
          });
          await invalidateSettingsQueries();
          if (selectedService?.id === normalized.id) {
            setSelectedService(null);
            setServiceDialogOpen(false);
          }
          toast.success('Serviço removido com sucesso.');
        } catch (error) {
          toast.error(error?.message || 'Não foi possível apagar o servico.');
        }
      },
    });
  };

  const renderServiceUsers = (service) => {
    const matchedUsers = (Array.isArray(service?.user_ids) ? service.user_ids : [])
      .map((userId) => usersById.get(String(userId || '')))
      .filter(Boolean);

    const matchedByEmail = (Array.isArray(service?.user_emails) ? service.user_emails : [])
      .map((email) => usersByEmail.get(String(email || '').trim().toLowerCase()))
      .filter((teamUser) => teamUser && !matchedUsers.some((item) => item.id === teamUser.id));

    return [...matchedUsers, ...matchedByEmail];
  };

  const renderServiceLabels = (service) =>
    (Array.isArray(service?.label_ids) ? service.label_ids : [])
      .map((labelId) => labelsById.get(String(labelId || '')))
      .filter(Boolean);

  const roleBadgeLabel = user?.role_name || user?.role || 'Operador';
  const activeTheme = theme === 'dark' ? 'dark' : 'light';
  const customerSyncIntervalLabel = formatCustomerSyncIntervalLabel(customerSyncSettings.autoSyncIntervalMinutes);
  const customerSyncNextScheduleLabel = customerSyncSettings.nextScheduledAt
    ? formatDateTime(customerSyncSettings.nextScheduledAt)
    : 'Não agendada';

  const scheduleTemplate = useMemo(
    () =>
      hsmTemplates.find((template) => getTemplateId(template) === scheduleSettings.hsmTemplateId) ||
      hsmTemplates.find(
        (template) =>
          getTemplateName(template) === scheduleSettings.hsmTemplateName &&
          getTemplateLanguage(template) === scheduleSettings.hsmLanguage
      ) ||
      null,
    [hsmTemplates, scheduleSettings.hsmLanguage, scheduleSettings.hsmTemplateId, scheduleSettings.hsmTemplateName]
  );
  const scheduleBodyIndexes = useMemo(
    () => extractVariableIndexes(scheduleTemplate?.content || scheduleTemplate?.body, scheduleTemplate?.bodyVariables),
    [scheduleTemplate]
  );
  const scheduleHeaderIndexes = useMemo(
    () => extractVariableIndexes(scheduleTemplate?.headerText, scheduleTemplate?.headerVariables),
    [scheduleTemplate]
  );
  const scheduleButtonIndexes = useMemo(
    () => extractVariableIndexes(
      [
        ...(scheduleTemplate?.buttons || []).map((button) => button.url || ''),
        ...(scheduleTemplate?.buttonConfig || []).map((button) => button.url || ''),
        scheduleTemplate?.buttonUrl || '',
      ].join('\n'),
      scheduleTemplate?.buttonVariables
    ),
    [scheduleTemplate]
  );
  const scheduleTemplateButtons = useMemo(() => getTemplateButtons(scheduleTemplate || {}), [scheduleTemplate]);
  const canEditSchedulesSection = canEditSettingsSection(currentSettingsAccess, 'schedules');
  const hasUnsavedScheduleSettings = JSON.stringify(scheduleSettings) !== lastSavedScheduleSettingsRef.current;
  const canEditTavinhoSection = canEditSettingsSection(currentSettingsAccess, 'tavinho');
  const hasUnsavedTavinhoSettings = JSON.stringify(tavinhoSettings) !== lastSavedTavinhoSettingsRef.current;

  const patchTavinhoSettings = (patch) => {
    setTavinhoSettings((current) => ({
      ...current,
      ...(typeof patch === 'function' ? patch(current) : patch),
    }));
  };

  const patchTavinhoPlanValue = (planIndex, month, value) => {
    const numericValue = Number(String(value || '').replace(',', '.'));
    patchTavinhoSettings((current) => ({
      planTable: current.planTable.map((plan, index) =>
        index === planIndex
          ? {
              ...plan,
              months: {
                ...plan.months,
                [month]: Number.isFinite(numericValue) ? numericValue : 0,
              },
            }
          : plan
      ),
    }));
  };

  const patchTavinhoPartialPrice = (priceIndex, field, value) => {
    const numericValue = Number(String(value || '').replace(',', '.'));
    patchTavinhoSettings((current) => ({
      partialPrices: current.partialPrices.map((price, index) =>
        index === priceIndex
          ? {
              ...price,
              [field]: Number.isFinite(numericValue) ? numericValue : 0,
            }
          : price
      ),
    }));
  };

  const patchTavinhoLink = (linkIndex, field, value) => {
    patchTavinhoSettings((current) => ({
      links: current.links.map((link, index) => (index === linkIndex ? { ...link, [field]: value } : link)),
    }));
  };

  const handleSaveTavinhoSettings = async () => {
    if (!canEditTavinhoSection || isSavingTavinhoSettings) return;

    setIsSavingTavinhoSettings(true);
    try {
      const savedSettings = await saveTavinhoSettings(tavinhoSettings);
      const normalized = normalizeTavinhoSettings(savedSettings);
      lastSavedTavinhoSettingsRef.current = JSON.stringify(normalized);
      tavinhoSettingsHydratedRef.current = true;
      queryClient.setQueryData(['settings', 'tavinho-settings'], normalized);
      setTavinhoSettings(normalized);
      toast.success('Configuracoes do Tavinho salvas.');
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel salvar as configuracoes do Tavinho.');
    } finally {
      setIsSavingTavinhoSettings(false);
    }
  };

  const handleScheduleTemplateChange = (templateId) => {
    const template = hsmTemplates.find((item) => getTemplateId(item) === templateId) || null;
    const nextBodyIndexes = extractVariableIndexes(template?.content || template?.body, template?.bodyVariables);
    const nextHeaderIndexes = extractVariableIndexes(template?.headerText, template?.headerVariables);
    const nextButtonIndexes = extractVariableIndexes(
      [
        ...(template?.buttons || []).map((button) => button.url || ''),
        ...(template?.buttonConfig || []).map((button) => button.url || ''),
        template?.buttonUrl || '',
      ].join('\n'),
      template?.buttonVariables
    );
    const nextHeaderMedia = template && isMediaHeaderKind(template) ? getTemplateHeaderMediaValue(template) : '';

    setScheduleSettings((current) => ({
      ...current,
      hsmTemplateId: template ? getTemplateId(template) : '',
      hsmTemplateName: template ? getTemplateName(template) : '',
      hsmLanguage: template ? getTemplateLanguage(template) : 'pt_BR',
      hsmVariables: template ? buildConfiguredHsmVariables(template, nextBodyIndexes, nextHeaderIndexes, nextButtonIndexes) : { body: {}, header: {}, buttons: {} },
      hsmMedia: nextHeaderMedia
        ? {
            url: nextHeaderMedia,
            kind: getHeaderKind(template),
            source: 'template',
          }
        : {},
    }));
    setScheduleMediaUpload({ loading: false, error: '' });
  };

  const patchScheduleHsmVariable = (group, index, value) => {
    setScheduleSettings((current) => ({
      ...current,
      hsmVariables: {
        ...(current.hsmVariables || {}),
        [group]: {
          ...(current.hsmVariables?.[group] || {}),
          [index]: value,
        },
      },
    }));
  };

  const renderScheduleVariableFields = (group, indexes, labelPrefix) =>
    indexes.map((index) => (
      <div key={`schedule-${group}-${index}`} className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{labelPrefix} {index}</label>
        <Input
          value={scheduleSettings.hsmVariables?.[group]?.[index] || ''}
          onChange={(event) => patchScheduleHsmVariable(group, index, event.target.value)}
          placeholder={`Valor de {{${index}}}`}
          disabled={!canEditSchedulesSection}
        />
      </div>
    ));

  const handleSaveScheduleSettings = async () => {
    if (!canEditSchedulesSection || isSavingScheduleSettings) return;

    setIsSavingScheduleSettings(true);
    try {
      const savedSettings = await saveScheduleSettings(scheduleSettings);
      const normalized = normalizeScheduleSettings(savedSettings);
      lastSavedScheduleSettingsRef.current = JSON.stringify(normalized);
      scheduleSettingsHydratedRef.current = true;
      queryClient.setQueryData(['settings', 'schedule-settings'], normalized);
      setScheduleSettings(normalized);
      toast.success('Configuracoes de agendamento salvas para todos os usuarios.');
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel salvar as configuracoes de agendamento.');
    } finally {
      setIsSavingScheduleSettings(false);
    }
  };

  const handleScheduleMediaUpload = async (file) => {
    if (!file || !scheduleTemplate) return;

    setScheduleMediaUpload({ loading: true, error: '' });
    try {
      const uploaded = await uploadHsmMedia(file);
      const url = String(uploaded?.url || uploaded?.mediaUrl || uploaded?.fileUrl || uploaded?.path || '').trim();
      if (!url) throw new Error('Upload concluido sem URL de midia.');

      setScheduleSettings((current) => ({
        ...current,
        hsmMedia: {
          ...(current.hsmMedia || {}),
          url,
          fileName: file.name,
          mimeType: file.type || '',
          kind: getHeaderKind(scheduleTemplate),
          source: 'upload',
        },
      }));
      setScheduleMediaUpload({ loading: false, error: '' });
      toast.success('Midia padrao do agendamento enviada.');
    } catch (error) {
      const message = error?.message || 'Falha ao enviar a midia do HSM.';
      setScheduleMediaUpload({ loading: false, error: message });
      toast.error(message);
    }
  };

  const restoreScheduleTemplateMedia = () => {
    if (!scheduleTemplate || !isMediaHeaderKind(scheduleTemplate)) return;
    const url = getTemplateHeaderMediaValue(scheduleTemplate);
    setScheduleSettings((current) => ({
      ...current,
      hsmMedia: url
        ? {
            url,
            kind: getHeaderKind(scheduleTemplate),
            source: 'template',
          }
        : {},
    }));
    setScheduleMediaUpload({ loading: false, error: '' });
  };

  if (!canOpenSettingsRoute) {
    return (
      <PageShell className="max-w-[1280px]">
        <PageHeader
          title="Configurações"
          description="Seu perfil não possui permissão para acessar os blocos de configuração desta plataforma."
        />
        <PageSectionCard className="p-6">
          <p className="text-sm text-muted-foreground">
            Solicite a liberação de acesso a um administrador para visualizar ou editar esta área.
          </p>
        </PageSectionCard>
      </PageShell>
    );
  }

  return (
    <PageShell className="max-w-[1280px]">
      <PageHeader
        title="Configurações"
        description="Gerencie perfil, equipe, departamentos e alertas operacionais da plataforma."
      />

      {visibleSettingsTabs.length === 0 ? (
        <PageSectionCard className="p-6">
          <p className="text-sm text-muted-foreground">
            Sua função pode acessar a página de configurações, mas nenhum bloco foi liberado para visualização.
          </p>
        </PageSectionCard>
      ) : (
        <>
          <div className="flex h-auto w-full flex-wrap justify-start gap-2 rounded-lg bg-secondary/60 p-2">
            {visibleSettingsTabs.map(([sectionKey, title]) => (
              <button
                key={sectionKey}
                type="button"
                onClick={() => setActiveSettingsTab(sectionKey)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-all',
                  activeSettingsTab === sectionKey
                    ? 'bg-background text-foreground shadow'
                    : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'
                )}
              >
                {title}
              </button>
            ))}
          </div>

          <div className="space-y-4">
        {canViewSettingsSection(currentSettingsAccess, 'profile') && activeSettingsTab === 'profile' ? (
        <PageSectionCard className="p-5">
          <SectionHeading
            icon={User}
            title="Perfil"
            description="Dados basicos do usuario autenticado e perfil operacional atual."
          />

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Nome</label>
              <Input value={user?.full_name || ''} disabled />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Email</label>
              <Input value={user?.email || ''} disabled />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <label className="text-sm font-medium text-foreground">Função</label>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="rounded-full bg-primary/10 text-primary">
                  {roleBadgeLabel}
                </Badge>
                <Badge variant="outline" className="rounded-full bg-secondary text-muted-foreground">
                  {user?.id || 'usuario-local'}
                </Badge>
              </div>
            </div>
          </div>
        </PageSectionCard>
        ) : null}

        {canViewSettingsSection(currentSettingsAccess, 'notifications') && activeSettingsTab === 'notifications' ? (
        <PageSectionCard className="p-5">
          <SectionHeading
            icon={Bell}
            title="Notificacoes"
            description="Defina os audios das notificacoes e o comportamento dos alertas."
          />

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/30 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">Novas conversas</p>
                <p className="text-xs text-muted-foreground">Mostra alerta quando uma nova conversa entra na operacao.</p>
              </div>
              <Switch
                checked={notificationSettings.alertNewConversations}
                onCheckedChange={(checked) => handleNotificationToggle('alertNewConversations', checked)}
                disabled={!canEditSettingsSection(currentSettingsAccess, 'notifications')}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/30 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">Som no navegador</p>
                <p className="text-xs text-muted-foreground">Toca o audio padrao do site quando chegam novas conversas ou novas nao lidas.</p>
              </div>
              <Switch
                checked={notificationSettings.enableBrowserSound}
                onCheckedChange={(checked) => handleNotificationToggle('enableBrowserSound', checked)}
                disabled={!canEditSettingsSection(currentSettingsAccess, 'notifications')}
              />
            </div>

            <div className="rounded-lg border border-border bg-secondary/20 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Audio padrao do site</label>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10">
                      <Upload className="h-4 w-4" />
                      Enviar audio
                      <input
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        onChange={handleAudioUpload('defaultAudio', 'Audio padrao')}
                        disabled={!canEditSettingsSection(currentSettingsAccess, 'notifications')}
                      />
                    </label>
                    {notificationSettings.defaultAudioDataUrl ? (
                      <>
                        <Button variant="outline" size="sm" onClick={handlePlayDefaultAudioPreview}>
                          <Volume2 className="h-4 w-4" />
                          Testar
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveAudio('defaultAudio')}
                          disabled={!canEditSettingsSection(currentSettingsAccess, 'notifications')}
                        >
                          <X className="h-4 w-4" />
                          Remover
                        </Button>
                      </>
                    ) : null}
                  </div>

                  {notificationSettings.defaultAudioDataUrl ? (
                    <div className="rounded-lg border border-border bg-background px-3 py-3">
                      <p className="mb-2 text-sm font-medium text-foreground">{notificationSettings.defaultAudioName}</p>
                      <audio controls preload="none" className="w-full">
                        <source src={notificationSettings.defaultAudioDataUrl} />
                      </audio>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Se nenhum arquivo for enviado, o sistema usa um beep leve como som padrao das notificacoes.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Audio personalizado</label>
                  <Select
                    value={notificationSettings.customAudioLabelId || 'none'}
                    onValueChange={(value) => handleNotificationValueChange('customAudioLabelId', value === 'none' ? '' : value)}
                    disabled={!canEditSettingsSection(currentSettingsAccess, 'notifications')}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione a etiqueta" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sem etiqueta vinculada</SelectItem>
                      {labelOptions.map((label) => (
                        <SelectItem key={label.id} value={label.id}>
                          {label.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10">
                      <Upload className="h-4 w-4" />
                      Enviar audio
                      <input
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        onChange={handleAudioUpload('customAudio', 'Audio personalizado')}
                        disabled={!canEditSettingsSection(currentSettingsAccess, 'notifications')}
                      />
                    </label>
                    {notificationSettings.customAudioDataUrl ? (
                      <>
                        <Button variant="outline" size="sm" onClick={() => handlePlayStoredAudio(notificationSettings.customAudioDataUrl)}>
                          <Volume2 className="h-4 w-4" />
                          Testar
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveAudio('customAudio')}
                          disabled={!canEditSettingsSection(currentSettingsAccess, 'notifications')}
                        >
                          <X className="h-4 w-4" />
                          Remover
                        </Button>
                      </>
                    ) : null}
                  </div>

                  {notificationSettings.customAudioDataUrl ? (
                    <div className="rounded-lg border border-border bg-background px-3 py-3">
                      <p className="mb-2 text-sm font-medium text-foreground">{notificationSettings.customAudioName}</p>
                      <audio controls preload="none" className="w-full">
                        <source src={notificationSettings.customAudioDataUrl} />
                      </audio>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {labelOptions.length === 0
                        ? 'Nenhuma etiqueta disponivel para vinculo.'
                        : 'Nenhum audio personalizado cadastrado.'}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </PageSectionCard>
        ) : null}

        {canViewSettingsSection(currentSettingsAccess, 'appearance') && activeSettingsTab === 'appearance' ? (
        <PageSectionCard className="p-5">
          <SectionHeading
            icon={Palette}
            title="Aparencia"
            description="Alterne a interface entre modo claro e escuro em toda a aplicacao."
          />

          <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Tema da interface</label>
              <Select
                value={activeTheme}
                onValueChange={setTheme}
                disabled={!canEditSettingsSection(currentSettingsAccess, 'appearance')}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o tema" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Modo claro</SelectItem>
                  <SelectItem value="dark">Modo escuro</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                O tema escolhido fica salvo neste navegador e e aplicado imediatamente.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div
                className={cn(
                  'rounded-xl border border-border p-4 transition-colors',
                  activeTheme === 'light' ? 'bg-primary/5 ring-1 ring-primary/30' : 'bg-secondary/25'
                )}
              >
                <div className="mb-3 flex items-center gap-2">
                  <Sun className="h-4 w-4 text-amber-500" />
                  <span className="text-sm font-medium text-foreground">Modo claro</span>
                </div>
                <div className="rounded-2xl border border-border bg-background p-3 shadow-sm">
                  <div className="mb-2 h-8 rounded-xl bg-card" />
                  <div className="flex gap-2">
                    <div className="h-14 w-14 rounded-2xl bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 w-24 rounded-full bg-foreground/10" />
                      <div className="h-10 rounded-2xl bg-primary/15" />
                    </div>
                  </div>
                </div>
              </div>

              <div
                className={cn(
                  'rounded-xl border border-border p-4 transition-colors',
                  activeTheme === 'dark' ? 'bg-primary/10 ring-1 ring-primary/30' : 'bg-secondary/25'
                )}
              >
                <div className="mb-3 flex items-center gap-2">
                  <MoonStar className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium text-foreground">Modo escuro</span>
                </div>
                <div className="rounded-2xl border border-border bg-[#111b21] p-3 shadow-sm">
                  <div className="mb-2 h-8 rounded-xl bg-[#202c33]" />
                  <div className="flex gap-2">
                    <div className="h-14 w-14 rounded-2xl bg-[#202c33]" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 w-24 rounded-full bg-white/15" />
                      <div className="h-10 rounded-2xl bg-[#005c4b]" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </PageSectionCard>
        ) : null}

        {canViewSettingsSection(currentSettingsAccess, 'dashboard') && activeSettingsTab === 'dashboard' ? (
        <PageSectionCard className="p-5">
          <SectionHeading
            icon={Megaphone}
            title="Dashboard"
            description="Configure palavras-chave e janelas usadas nos indicadores de anúncio e recuperação."
          />

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Palavras-chave de anúncio</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={dashboardKeywordInput}
                  onChange={(event) => setDashboardKeywordInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addDashboardKeyword();
                    }
                  }}
                  placeholder="Ex.: anúncio, campanha meta, instagram"
                  disabled={!canEditSettingsSection(currentSettingsAccess, 'dashboard')}
                />
                <Button
                  type="button"
                  onClick={addDashboardKeyword}
                  disabled={!canEditSettingsSection(currentSettingsAccess, 'dashboard') || !dashboardKeywordInput.trim()}
                >
                  Adicionar
                </Button>
              </div>
              <div className="flex min-h-11 flex-wrap gap-2 rounded-lg border border-border bg-secondary/20 p-3">
                {(dashboardSettings.adKeywords || []).length ? (
                  dashboardSettings.adKeywords.map((keyword) => (
                    <Badge key={keyword} variant="outline" className="gap-2 rounded-full bg-primary/10 text-primary">
                      {keyword}
                      {canEditSettingsSection(currentSettingsAccess, 'dashboard') ? (
                        <button
                          type="button"
                          className="rounded-full text-primary/70 hover:text-primary"
                          onClick={() => removeDashboardKeyword(keyword)}
                          aria-label={`Remover ${keyword}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      ) : null}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">Nenhuma palavra-chave cadastrada.</span>
                )}
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
              <p className="text-sm font-semibold text-foreground">Janelas de atribuição</p>
              {[
                ['appointmentAttributionWindowDays', 'Anúncio até agendamento'],
                ['newCustomerWindowDays', 'Novo cliente'],
                ['templateResponseWindowDays', 'Resposta de template'],
                ['templateRecoveryWindowDays', 'Recuperação por template'],
              ].map(([field, label]) => (
                <label key={field} className="grid grid-cols-[minmax(0,1fr)_90px] items-center gap-3">
                  <span className="text-sm text-muted-foreground">{label}</span>
                  <Input
                    type="number"
                    min="1"
                    value={dashboardSettings[field]}
                    onChange={(event) => handleDashboardNumberChange(field, event.target.value)}
                    disabled={!canEditSettingsSection(currentSettingsAccess, 'dashboard')}
                  />
                </label>
              ))}
              <p className="text-xs text-muted-foreground">
                As alterações são salvas automaticamente e serão usadas pelas próximas métricas da Dashboard.
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Metas mensais de venda</p>
                <p className="mt-1 text-xs text-muted-foreground">Usadas no DASH Venda para meta do mês, total realizado e projeção necessária por atendente.</p>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {(users || []).map((teamUser) => {
                  const key = String(teamUser?.id || teamUser?.email || teamUser?.username || '').trim();
                  return (
                    <label key={key || teamUser.username} className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3 rounded-lg border border-border bg-background p-3">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">{teamUser.full_name || teamUser.username || teamUser.email}</span>
                        <span className="block truncate text-xs text-muted-foreground">@{teamUser.username || teamUser.email || key}</span>
                      </span>
                      <Input
                        type="number"
                        min="0"
                        value={(dashboardSettings.salesGoalsByUserId || {})[key] || ''}
                        onChange={(event) => handleDashboardSalesGoalChange(teamUser, event.target.value)}
                        disabled={!canEditSettingsSection(currentSettingsAccess, 'dashboard')}
                        placeholder="0"
                      />
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
              <p className="text-sm font-semibold text-foreground">Entrada de dados reais</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                A Dashboard lê eventos persistidos em <span className="font-mono">/api/local/dashboard/events</span>. Para importar dados da Meta ou de recuperação, envie um lote para <span className="font-mono">/api/local/dashboard/events/import</span>.
              </p>
              <div className="rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
                Tipos aceitos: ad_lead, trial_generated, contracted, followup_sent, followup_response, appointment_created, recovered, sale_started, sale_finished, support_started e support_finished.
              </div>
            </div>
          </div>
        </PageSectionCard>
        ) : null}

        {canViewSettingsSection(currentSettingsAccess, 'customerSync') && activeSettingsTab === 'customerSync' ? (
        <PageSectionCard className="p-5">
          <SectionHeading
            icon={RefreshCw}
            title="Sincronizacao automatica"
            description="Controle o intervalo usado na coleta automatica da base de clientes do NewBr."
          />

          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Intervalo da sincronizacao</label>
                <Select
                  value={String(customerSyncSettings.autoSyncIntervalMinutes)}
                  onValueChange={handleCustomerSyncIntervalChange}
                  disabled={!canEditSettingsSection(currentSettingsAccess, 'customerSync')}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione o intervalo" />
                  </SelectTrigger>
                  <SelectContent>
                    {CUSTOMER_SYNC_INTERVAL_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={String(option.value)}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="rounded-lg border border-border bg-secondary/20 p-4">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">Regra atual</p>
                  <p className="text-sm text-muted-foreground">
                    A base sera sincronizada automaticamente a cada <span className="font-medium text-foreground">{customerSyncIntervalLabel}</span>.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Proxima sincronizacao programada: {customerSyncNextScheduleLabel}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    A alteracao e salva automaticamente e passa a valer para os proximos agendamentos da VPS.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </PageSectionCard>
        ) : null}

        {canViewSettingsSection(currentSettingsAccess, 'schedules') && activeSettingsTab === 'schedules' ? (
        <PageSectionCard className="p-5">
          <SectionHeading
            icon={CalendarClock}
            title="Agendamentos"
            description="Configure o HSM padrao usado quando um agendamento sair fora da janela de 24h."
            action={
              <Button
                type="button"
                onClick={handleSaveScheduleSettings}
                disabled={!canEditSchedulesSection || !hasUnsavedScheduleSettings || isSavingScheduleSettings}
              >
                {isSavingScheduleSettings ? 'Salvando...' : 'Salvar agendamentos'}
              </Button>
            }
          />

          <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">HSM padrao</label>
              <Select
                value={scheduleSettings.hsmTemplateId || 'none'}
                onValueChange={(value) => handleScheduleTemplateChange(value === 'none' ? '' : value)}
                disabled={!canEditSchedulesSection}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione um HSM aprovado" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum HSM configurado</SelectItem>
                  {hsmTemplates.map((template) => (
                    <SelectItem key={getTemplateId(template)} value={getTemplateId(template)}>
                      {getTemplateName(template)} ({getTemplateLanguage(template)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Esse HSM sera usado automaticamente no modal de Criar Agendamento apos salvar.
              </p>
              {hasUnsavedScheduleSettings ? (
                <p className="text-xs font-medium text-amber-600">
                  Existem alteracoes de agendamento ainda nao salvas.
                </p>
              ) : null}
            </div>

            <div className="rounded-lg border border-border bg-secondary/20 p-4">
              {scheduleTemplate ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{getTemplateName(scheduleTemplate)}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {scheduleTemplate.content || scheduleTemplate.body || 'Template sem previa configurada.'}
                    </p>
                  </div>

                  {scheduleTemplateButtons.length > 0 ? (
                    <div className="rounded-lg border border-border bg-background px-3 py-2">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Botoes configurados no HSM
                      </p>
                      <div className="flex flex-col gap-2">
                        {scheduleTemplateButtons.map((button) => (
                          <div key={button.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-secondary/40 px-3 py-2 text-sm">
                            <span className="font-medium text-foreground">{button.label || 'Botao'}</span>
                            <span className="text-xs text-muted-foreground">
                              {button.type}{button.value ? ` - ${button.value}` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {scheduleBodyIndexes.length || scheduleHeaderIndexes.length || scheduleButtonIndexes.length ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      {renderScheduleVariableFields('body', scheduleBodyIndexes, 'Variavel')}
                      {renderScheduleVariableFields('header', scheduleHeaderIndexes, 'Cabecalho')}
                      {renderScheduleVariableFields('buttons', scheduleButtonIndexes, 'Botao')}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
                      Este HSM nao possui variaveis configuraveis.
                    </div>
                  )}

                  {isMediaHeaderKind(scheduleTemplate) ? (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium text-foreground">Midia padrao do cabecalho</label>
                      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
                        <Input
                          value={scheduleSettings.hsmMedia?.url || ''}
                          onChange={(event) =>
                            setScheduleSettings((current) => ({
                              ...current,
                              hsmMedia: {
                                ...(current.hsmMedia || {}),
                                url: event.target.value,
                                kind: getHeaderKind(scheduleTemplate),
                                source: current.hsmMedia?.source || 'manual',
                              },
                            }))
                          }
                          placeholder="URL publica da midia"
                          disabled={!canEditSchedulesSection}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="gap-2"
                          disabled={!canEditSchedulesSection || scheduleMediaUpload.loading}
                          onClick={() => scheduleMediaInputRef.current?.click()}
                        >
                          <Upload className="h-4 w-4" />
                          {scheduleMediaUpload.loading ? 'Enviando' : 'Enviar midia'}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={!canEditSchedulesSection || scheduleMediaUpload.loading || !getTemplateHeaderMediaValue(scheduleTemplate)}
                          onClick={restoreScheduleTemplateMedia}
                        >
                          Usar padrao
                        </Button>
                        <input
                          ref={scheduleMediaInputRef}
                          type="file"
                          className="hidden"
                          accept={getHeaderMediaAccept(scheduleTemplate)}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            void handleScheduleMediaUpload(file);
                            event.target.value = '';
                          }}
                        />
                      </div>
                      {scheduleMediaUpload.error ? <p className="text-xs text-destructive">{scheduleMediaUpload.error}</p> : null}
                      <p className="text-xs text-muted-foreground">
                        Ao selecionar o HSM, a midia vem da aba HSMs. Use o envio acima apenas para sobrescrever a midia deste HSM padrao de agendamento.
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nenhum HSM padrao configurado para agendamentos.
                </p>
              )}
            </div>
          </div>
        </PageSectionCard>
        ) : null}

        {canViewSettingsSection(currentSettingsAccess, 'tavinho') && activeSettingsTab === 'tavinho' ? (
        <PageSectionCard className="p-5">
          <SectionHeading
            icon={Bot}
            title="Tavinho"
            description="Controle a base, o texto e os dados internos liberados para o copiloto."
            action={
              <Button
                type="button"
                onClick={handleSaveTavinhoSettings}
                disabled={!canEditTavinhoSection || !hasUnsavedTavinhoSettings || isSavingTavinhoSettings}
              >
                {isSavingTavinhoSettings ? 'Salvando...' : 'Salvar Tavinho'}
              </Button>
            }
          />

          <div className="space-y-5">
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/25 px-4 py-3 lg:col-span-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Copiloto ativo</p>
                  <p className="text-xs text-muted-foreground">Mantem o Tavinho disponivel na sidebar de atendimento.</p>
                </div>
                <Switch
                  checked={Boolean(tavinhoSettings.enabled)}
                  onCheckedChange={(checked) => patchTavinhoSettings({ enabled: Boolean(checked) })}
                  disabled={!canEditTavinhoSection}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Nome do copiloto</label>
                <Input
                  value={tavinhoSettings.assistantName}
                  onChange={(event) => patchTavinhoSettings({ assistantName: event.target.value })}
                  disabled={!canEditTavinhoSection}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Produto</label>
                <Input
                  value={tavinhoSettings.productName}
                  onChange={(event) => patchTavinhoSettings({ productName: event.target.value })}
                  disabled={!canEditTavinhoSection}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Versao da base</label>
                <Input
                  value={tavinhoSettings.versionLabel}
                  onChange={(event) => patchTavinhoSettings({ versionLabel: event.target.value })}
                  disabled={!canEditTavinhoSection}
                />
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Prompt base</label>
                <Textarea
                  value={tavinhoSettings.basePrompt}
                  onChange={(event) => patchTavinhoSettings({ basePrompt: event.target.value })}
                  placeholder="Deixe vazio para usar o prompt padrao do sistema."
                  className="min-h-[180px]"
                  disabled={!canEditTavinhoSection}
                />
                <p className="text-xs text-muted-foreground">Se este campo ficar vazio, o backend usa o prompt base atual do arquivo.</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Escopo permitido</label>
                <Textarea
                  value={(tavinhoSettings.allowedScopes || []).join('\n')}
                  onChange={(event) =>
                    patchTavinhoSettings({
                      allowedScopes: event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
                    })
                  }
                  className="min-h-[180px]"
                  disabled={!canEditTavinhoSection}
                />
                <p className="text-xs text-muted-foreground">Use uma linha por assunto que o Tavinho pode responder.</p>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Planos fechados</h3>
                <p className="text-xs text-muted-foreground">Esta tabela alimenta o formato de resposta com 1, 2 e 3 telas.</p>
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                {tavinhoSettings.planTable.map((plan, planIndex) => (
                  <div key={`tavinho-plan-${plan.screens}`} className="rounded-lg border border-border bg-background p-3">
                    <p className="mb-3 text-sm font-semibold text-foreground">
                      {'\u{1F4FA}'.repeat(plan.screens)} {plan.screens} {plan.screens === 1 ? 'TELA' : 'TELAS'}
                    </p>
                    {[1, 2, 3].map((month) => (
                      <div key={`tavinho-plan-${plan.screens}-${month}`} className="mb-2 grid grid-cols-[90px_minmax(0,1fr)] items-center gap-2">
                        <label className="text-xs font-medium text-muted-foreground">{month} {month === 1 ? 'm\u00eas' : 'meses'}</label>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          value={plan.months?.[month] ?? 0}
                          onChange={(event) => patchTavinhoPlanValue(planIndex, month, event.target.value)}
                          disabled={!canEditTavinhoSection}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Calculo parcial</h3>
                <p className="text-xs text-muted-foreground">O valor final continua sendo arredondado para cima pelo Tavinho.</p>
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                {tavinhoSettings.partialPrices.map((price, priceIndex) => (
                  <div key={`tavinho-partial-${price.screens}`} className="rounded-lg border border-border bg-background p-3">
                    <p className="mb-3 text-sm font-semibold text-foreground">{price.screens} {price.screens === 1 ? 'tela' : 'telas'}</p>
                    <div className="space-y-2">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">Preco por dia</label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={price.pricePerDay}
                          onChange={(event) => patchTavinhoPartialPrice(priceIndex, 'pricePerDay', event.target.value)}
                          disabled={!canEditTavinhoSection}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">Bruto oficial em 29 dias</label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={price.officialGross29Days}
                          onChange={(event) => patchTavinhoPartialPrice(priceIndex, 'officialGross29Days', event.target.value)}
                          disabled={!canEditTavinhoSection}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Apps por dispositivo</label>
                <Textarea
                  value={tavinhoSettings.appsText}
                  onChange={(event) => patchTavinhoSettings({ appsText: event.target.value })}
                  className="min-h-[150px]"
                  disabled={!canEditTavinhoSection}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Suporte basico</label>
                <Textarea
                  value={tavinhoSettings.supportText}
                  onChange={(event) => patchTavinhoSettings({ supportText: event.target.value })}
                  className="min-h-[150px]"
                  disabled={!canEditTavinhoSection}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Procedimentos e tom</label>
                <Textarea
                  value={tavinhoSettings.proceduresText}
                  onChange={(event) => patchTavinhoSettings({ proceduresText: event.target.value })}
                  className="min-h-[150px]"
                  disabled={!canEditTavinhoSection}
                />
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Dados do cliente liberados</h3>
                <p className="text-xs text-muted-foreground">Somente os itens ativos entram no contexto enviado ao Tavinho.</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {[
                  ['customerProfile', 'Nome e telefone'],
                  ['planAndDueDate', 'Plano, telas, vencimento e status'],
                  ['labelsAndService', 'Etiquetas e fila/servico'],
                  ['recentMessages', 'Ultimas mensagens do atendimento'],
                  ['checkoutStatus', 'Status de checkout/renovacao'],
                  ['loginCredentials', 'Usuario e senha do cliente'],
                  ['playlistLinks', 'Playlist ou links de acesso'],
                  ['internalNotes', 'Notas internas do cadastro'],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                    <span className="text-sm font-medium text-foreground">{label}</span>
                    <Switch
                      checked={Boolean(tavinhoSettings.dataAccess?.[key])}
                      onCheckedChange={(checked) =>
                        patchTavinhoSettings((current) => ({
                          dataAccess: {
                            ...(current.dataAccess || {}),
                            [key]: Boolean(checked),
                          },
                        }))
                      }
                      disabled={!canEditTavinhoSection}
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Links e resposta fora da base</h3>
                <p className="text-xs text-muted-foreground">Use para Wiki, changelog e mensagem padrao quando o Tavinho nao souber responder.</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Resposta fora da base</label>
                <Textarea
                  value={tavinhoSettings.outOfScopeResponse}
                  onChange={(event) => patchTavinhoSettings({ outOfScopeResponse: event.target.value })}
                  disabled={!canEditTavinhoSection}
                />
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {tavinhoSettings.links.map((link, linkIndex) => (
                  <div key={`tavinho-link-${linkIndex}`} className="space-y-2 rounded-lg border border-border bg-background p-3">
                    <Input
                      value={link.name}
                      onChange={(event) => patchTavinhoLink(linkIndex, 'name', event.target.value)}
                      placeholder="Nome do link"
                      disabled={!canEditTavinhoSection}
                    />
                    <Input
                      value={link.url}
                      onChange={(event) => patchTavinhoLink(linkIndex, 'url', event.target.value)}
                      placeholder="URL"
                      disabled={!canEditTavinhoSection}
                    />
                    <Input
                      value={link.description}
                      onChange={(event) => patchTavinhoLink(linkIndex, 'description', event.target.value)}
                      placeholder="Descricao"
                      disabled={!canEditTavinhoSection}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </PageSectionCard>
        ) : null}
      </div>

      {canViewSettingsSection(currentSettingsAccess, 'team') && activeSettingsTab === 'team' ? (
      <PageSectionCard className="p-5">
        <SectionHeading
          icon={Users}
          title="Equipe"
          description="Cadastre operadores com descrição, função e histórico básico de alterações."
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Select value={teamFilter} onValueChange={setTeamFilter}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Filtrar por função" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as funcoes</SelectItem>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={openCreateUserDialog} disabled={!canEditTeamSection}>
                <Plus className="h-4 w-4" />
                Criar usuario
              </Button>
            </div>
          }
        />

        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-secondary/60">
                <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Nome</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Descrição</TableHead>
                <TableHead className="w-[180px] text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Função</TableHead>
                <TableHead className="w-[260px] text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Acoes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!usersLoading && filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                    Nenhum usuario encontrado para o filtro atual.
                  </TableCell>
                </TableRow>
              ) : null}

              {filteredUsers.map((teamUser) => {
                const matchedRole = resolveRoleForUser(teamUser, roles);

                return (
                  <TableRow key={teamUser.id} className="hover:bg-secondary/20">
                    <TableCell className="py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                          {buildInitials(teamUser.full_name)}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{teamUser.full_name || 'Sem nome'}</p>
                          <p className="truncate text-xs text-muted-foreground">@{teamUser.username || 'sem-usuario'}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">
                      {teamUser.description || 'Sem descricao cadastrada.'}
                    </TableCell>
                    <TableCell className="py-3">
                      <Badge variant="outline" className="rounded-full bg-secondary text-muted-foreground">
                        {matchedRole?.name || teamUser.role_name || teamUser.role || 'Sem função'}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap gap-1">
                        <Button variant="ghost" size="icon" title="Visualizar" onClick={() => openUserDialog('view', teamUser)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Editar"
                          onClick={() => openUserDialog('edit', teamUser)}
                          disabled={!canEditTeamSection}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Historico" onClick={() => setHistoryDialog({ open: true, entityType: 'user', entityId: teamUser.id, label: teamUser.full_name || 'Usuario' })}>
                          <History className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Desconectar usuario"
                          disabled={disconnectingUserId === teamUser.id || !canEditTeamSection}
                          onClick={() => handleAdminLogoutUser(teamUser)}
                        >
                          <LogOut className="h-4 w-4 text-amber-600" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Apagar"
                          onClick={() => handleDeleteUser(teamUser)}
                          disabled={!canEditTeamSection}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </PageSectionCard>
      ) : null}

      {canViewSettingsSection(currentSettingsAccess, 'roles') && activeSettingsTab === 'roles' ? (
      <PageSectionCard className="p-5">
        <SectionHeading
          icon={BriefcaseBusiness}
          title="Funcoes"
          description="As funcoes tambem representam departamentos e determinam quais areas cada equipe pode acessar."
          action={
            <Button onClick={openCreateRoleDialog} disabled={!canEditRolesSection}>
              <Plus className="h-4 w-4" />
              Criar função
            </Button>
          }
        />

        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-secondary/60">
                <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Nome</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Descrição</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Acessos</TableHead>
                <TableHead className="w-[220px] text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Acoes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!rolesLoading && roles.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                    Nenhuma função cadastrada.
                  </TableCell>
                </TableRow>
              ) : null}

              {roles.map((role) => {
                const enabledPermissions = buildAccessSummary(role.permissions);

                return (
                  <TableRow key={role.id} className="hover:bg-secondary/20">
                    <TableCell className="py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{role.name}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="rounded-full bg-primary/10 text-primary">
                            {role.department_key || 'sem-departamento'}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{roleMembersCount[role.id] || 0} membro(s)</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">
                      {role.description || 'Sem descricao cadastrada.'}
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap gap-1">
                        {enabledPermissions.length ? (
                          enabledPermissions.map((permission) => (
                            <Badge key={permission} variant="outline" className="rounded-full bg-secondary text-muted-foreground">
                              {permission}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-sm text-muted-foreground">Sem acessos ativos</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap gap-1">
                        <Button variant="ghost" size="icon" title="Visualizar" onClick={() => openRoleDialog('view', role)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Editar"
                          onClick={() => openRoleDialog('edit', role)}
                          disabled={!canEditRolesSection}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Historico" onClick={() => setHistoryDialog({ open: true, entityType: 'role', entityId: role.id, label: role.name })}>
                          <History className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Apagar"
                          onClick={() => handleDeleteRole(role)}
                          disabled={!canEditRolesSection}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </PageSectionCard>
      ) : null}

      {canViewSettingsSection(currentSettingsAccess, 'services') && activeSettingsTab === 'services' ? (
      <PageSectionCard className="p-5">
        <SectionHeading
          icon={Megaphone}
          title="Serviços"
          description="Cadastre filas de atendimento, vincule numeros existentes, operadores responsaveis e etiquetas que controlam a visibilidade."
          action={
            <Button onClick={openCreateServiceDialog} disabled={!canEditServicesSection}>
              <Plus className="h-4 w-4" />
              Criar servico
            </Button>
          }
        />

        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-secondary/60">
                <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Nome</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Descrição</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Numero</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Usuarios atribuidos</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Etiquetas atribuidas</TableHead>
                <TableHead className="w-[180px] text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Acoes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!servicesLoading && services.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    Nenhum servico cadastrado.
                  </TableCell>
                </TableRow>
              ) : null}

              {services.map((service) => {
                const assignedUsers = renderServiceUsers(service);
                const assignedLabels = renderServiceLabels(service);

                return (
                  <TableRow key={service.id} className="hover:bg-secondary/20">
                    <TableCell className="py-3">
                      <div className="flex items-center gap-3">
                        <ServiceIconBadge service={service} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{service.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{service.id}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">
                      {service.description || 'Sem descricao cadastrada.'}
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap gap-1">
                        {(service.phone_numbers || []).length ? (
                          service.phone_numbers.map((phoneNumber) => (
                            <Badge key={`${service.id}-${phoneNumber}`} variant="outline" className="rounded-full bg-secondary text-muted-foreground">
                              {phoneNumber}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-sm text-muted-foreground">Sem numero vinculado</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap gap-1">
                        {assignedUsers.length ? (
                          assignedUsers.map((teamUser) => (
                            <Badge key={`${service.id}-${teamUser.id}`} variant="outline" className="rounded-full bg-primary/5 text-primary">
                              {teamUser.full_name || teamUser.username || teamUser.email}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-sm text-muted-foreground">Sem usuario vinculado</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap gap-1">
                        {assignedLabels.length ? (
                          assignedLabels.map((label) => (
                            <Badge key={`${service.id}-${label.id}`} variant="outline" className="rounded-full bg-secondary text-muted-foreground">
                              {label.name}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-sm text-muted-foreground">Sem etiqueta vinculada</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap gap-1">
                        <Button variant="ghost" size="icon" title="Visualizar" onClick={() => openServiceDialog('view', service)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Editar"
                          onClick={() => openServiceDialog('edit', service)}
                          disabled={!canEditServicesSection}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Historico"
                          onClick={() =>
                            setHistoryDialog({ open: true, entityType: 'service', entityId: service.id, label: service.name })
                          }
                        >
                          <History className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Apagar"
                          onClick={() => handleDeleteService(service)}
                          disabled={!canEditServicesSection}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </PageSectionCard>
      ) : null}

      {canViewSettingsSection(currentSettingsAccess, 'audit') && activeSettingsTab === 'audit' ? (
        <PageSectionCard className="p-5">
          <SectionHeading
            icon={History}
            title="Auditoria"
            description="Acompanhe as últimas ações administrativas registradas nesta instância local."
          />

          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="bg-secondary/60">
                  <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Data</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Usuário</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Área</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Ação</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Detalhe</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {settingsAudit.length ? (
                  settingsAudit.slice(0, 80).map((entry) => (
                    <TableRow key={entry.id} className="hover:bg-secondary/20">
                      <TableCell className="py-3 text-sm text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
                      <TableCell className="py-3 text-sm text-foreground">{entry.actor || 'Operador local'}</TableCell>
                      <TableCell className="py-3">
                        <Badge variant="outline" className="rounded-full bg-secondary text-muted-foreground">
                          {entry.entityType === 'user' ? 'Equipe' : entry.entityType === 'role' ? 'Funções' : entry.entityType === 'service' ? 'Serviços' : entry.entityType}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge variant="outline" className="rounded-full bg-primary/10 text-primary">
                          {getAuditActionLabel(entry.action)}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3 text-sm text-muted-foreground">{entry.detail || entry.label || 'Sem detalhe registrado.'}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                      Ainda não há eventos administrativos registrados nesta instância.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </PageSectionCard>
      ) : null}
        </>
      )}

      <Dialog open={userDialogOpen} onOpenChange={setUserDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {userDialogMode === 'create' ? 'Criar usuario' : userDialogMode === 'edit' ? 'Editar usuario' : 'Visualizar usuario'}
            </DialogTitle>
            <DialogDescription>
              Cadastre nome, usuário, senha, descrição operacional e a função vinculada ao operador.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Nome</label>
              <Input
                value={userForm.full_name}
                onChange={(event) => handleUserFieldChange('full_name', event.target.value)}
                disabled={isUserReadOnly || isSavingUser}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Usuario</label>
              <Input
                value={userForm.username}
                onChange={(event) => handleUserFieldChange('username', event.target.value)}
                disabled={isUserReadOnly || isSavingUser}
              />
            </div>
            <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Senha</label>
                <Input
                  type="password"
                  value={userForm.password}
                  onChange={(event) => handleUserFieldChange('password', event.target.value)}
                  disabled={isUserReadOnly || isSavingUser}
                  placeholder={userDialogMode === 'edit' ? 'Preencha apenas para trocar a senha' : ''}
                />
              </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Função</label>
              <Select
                value={userForm.role_id}
                onValueChange={(value) => handleUserFieldChange('role_id', value)}
                disabled={isUserReadOnly || isSavingUser}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a função" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-foreground">Descrição</label>
              <Textarea
                value={userForm.description}
                onChange={(event) => handleUserFieldChange('description', event.target.value)}
                disabled={isUserReadOnly || isSavingUser}
                rows={4}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUserDialogOpen(false)} disabled={isSavingUser}>
              Fechar
            </Button>
            {!isUserReadOnly ? <Button onClick={handleSaveUser} disabled={isSavingUser}>{isSavingUser ? 'Salvando...' : 'Salvar usuario'}</Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
  <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
  <DialogTitle>
    {roleDialogMode === 'create' ? 'Criar função' : roleDialogMode === 'edit' ? 'Editar função' : 'Visualizar função'}
  </DialogTitle>
  <DialogDescription>
    Defina a descrição do departamento, os menus visíveis na sidebar e os blocos de configuração liberados para essa função.
  </DialogDescription>
</DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
          <div className="grid gap-4 py-2 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Nome da função</label>
              <Input
                value={roleForm.name}
                onChange={(event) => handleRoleFieldChange('name', event.target.value)}
                disabled={isRoleReadOnly || isSavingRole}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Chave do departamento</label>
              <Input
                value={roleForm.department_key}
                onChange={(event) => handleRoleFieldChange('department_key', event.target.value)}
                disabled={isRoleReadOnly || isSavingRole}
                placeholder="Ex.: financeiro"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-foreground">Descrição</label>
              <Textarea
                value={roleForm.description}
                onChange={(event) => handleRoleFieldChange('description', event.target.value)}
                disabled={isRoleReadOnly || isSavingRole}
                rows={4}
              />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-secondary/20 p-4">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">Definição de acessos</h3>
              <p className="text-xs text-muted-foreground">Marque apenas os menus que esta função pode visualizar na sidebar e acessar por rota direta.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {ROLE_PERMISSION_OPTIONS.map(([key, title, description]) => (
                <label key={key} className="flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-3">
                  <Checkbox
                    checked={Boolean(roleForm.permissions?.[key])}
                    onCheckedChange={(checked) => handleRolePermissionChange(key, checked)}
                    disabled={isRoleReadOnly || isSavingRole}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium text-foreground">{title}</span>
                    <span className="block text-xs text-muted-foreground">{description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-secondary/20 p-4">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">Blocos de configurações</h3>
              <p className="text-xs text-muted-foreground">
                Defina se cada bloco da tela de configurações fica oculto, apenas visível ou editável para esta função.
              </p>
            </div>

            <div className="space-y-3">
              {SETTINGS_SECTION_OPTIONS.map(([key, title, description]) => (
                <div key={key} className="grid gap-3 rounded-lg border border-border bg-background px-3 py-3 md:grid-cols-[minmax(0,1fr)_220px] md:items-center">
                  <div>
                    <p className="text-sm font-medium text-foreground">{title}</p>
                    <p className="text-xs text-muted-foreground">{description}</p>
                  </div>

                  <Select
                    value={normalizeRoleSettingsAccess(roleForm.settings_access)[key]}
                    onValueChange={(value) => handleRoleSettingsAccessChange(key, value)}
                    disabled={isRoleReadOnly || isSavingRole || !Boolean(roleForm.permissions?.settings)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione o nivel" />
                    </SelectTrigger>
                    <SelectContent>
                      {SETTINGS_ACCESS_LEVELS.map(([value, label]) => (
                        <SelectItem key={`${key}-${value}`} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          </div>

         <DialogFooter className="shrink-0 border-t border-border pt-4">
  <Button variant="outline" onClick={() => setRoleDialogOpen(false)} disabled={isSavingRole}>
    Fechar
  </Button>
  {!isRoleReadOnly ? (
    <Button onClick={handleSaveRole} disabled={isSavingRole}>
      {isSavingRole ? 'Salvando...' : 'Salvar função'}
    </Button>
  ) : null}
</DialogFooter>
        </DialogContent>
      </Dialog>

      <ServiceFormDialog
        open={serviceDialogOpen}
        onOpenChange={setServiceDialogOpen}
        onSubmit={handleSaveService}
        mode={serviceDialogMode}
        initialValue={selectedService}
        users={users}
        labelOptions={labelOptions}
        availableNumbers={availableNumbers}
      />

      <AlertDialog open={confirmDialog.open} onOpenChange={handleConfirmDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmDialog.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDialog.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmDialog.isRunning}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDialogAction}
              disabled={confirmDialog.isRunning}
              className={cn(confirmDialog.destructive && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
            >
              {confirmDialog.isRunning ? 'Processando...' : confirmDialog.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={historyDialog.open}
        onOpenChange={(open) => setHistoryDialog((current) => ({ ...current, open }))}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Historico de {historyDialog.label || 'registro'}</DialogTitle>
            <DialogDescription>Alteracoes locais registradas para acompanhamento administrativo.</DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            {historyEntries.length ? (
              historyEntries.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border bg-secondary/20 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge variant="outline" className="rounded-full bg-primary/10 text-primary">
                      {getAuditActionLabel(entry.action)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-sm font-medium text-foreground">{entry.detail}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Por {entry.actor}</p>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                Ainda nao ha eventos registrados para este item.
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryDialog((current) => ({ ...current, open: false }))}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
