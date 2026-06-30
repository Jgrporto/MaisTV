export const NAVIGATION_PERMISSION_OPTIONS = [
  ['attendance', 'Atendimento', 'Visualiza e atende conversas recebidas.'],
  ['bulkSend', 'Envio em Massa', 'Acessa disparos em lote, filtros e execuções de envio.'],
  ['queuesServices', 'Filas & Serviços', 'Acompanha filas, servicos e atribuicoes de atendimento.'],
  ['tickets', 'Tickets', 'Consulta e gerencia chamados internos vinculados ao atendimento.'],
  ['quickReplies', 'Respostas Rápidas', 'Consulta e gerencia respostas prontas usadas no atendimento.'],
  ['customerBase', 'Base de Clientes', 'Acessa a base de clientes, filtros e dados sincronizados.'],
  ['labels', 'Etiquetas', 'Gerencia etiquetas e organização das conversas.'],
  ['chatbot', 'Chatbot', 'Acessa fluxos, automações e editor do chatbot.'],
  ['routines', 'Rotinas', 'Consulta e gerencia rotinas, follow-ups e agendamentos.'],
  ['hsms', 'HSMs', 'Consulta modelos aprovados e configurações de templates.'],
  ['dashboard', 'Dashboard', 'Consulta indicadores gerais da operação.'],
  ['settings', 'Configurações', 'Acessa administração, equipe, funções e serviços.'],
];

export const DEFAULT_NAVIGATION_PERMISSIONS = NAVIGATION_PERMISSION_OPTIONS.reduce((accumulator, [key]) => {
  accumulator[key] = ['attendance', 'labels'].includes(key);
  return accumulator;
}, {});

export const ADMIN_NAVIGATION_PERMISSIONS = NAVIGATION_PERMISSION_OPTIONS.reduce((accumulator, [key]) => {
  accumulator[key] = true;
  return accumulator;
}, {});

export const NAVIGATION_PERMISSION_LABELS = NAVIGATION_PERMISSION_OPTIONS.reduce((accumulator, [key, label]) => {
  accumulator[key] = label;
  return accumulator;
}, {});

export const NAVIGATION_ROUTE_PERMISSIONS = [
  { path: '/', permission: 'attendance' },
  { path: '/dashboard', permission: 'dashboard' },
  { path: '/envio', permission: 'bulkSend' },
  { path: '/queues-services', permission: 'queuesServices' },
  { path: '/tickets', permission: 'tickets' },
  { path: '/quick-replies', permission: 'quickReplies' },
  { path: '/customers', permission: 'customerBase' },
  { path: '/labels', permission: 'labels' },
  { path: '/chatbot', permission: 'chatbot' },
  { path: '/chatbotv', permission: 'chatbot' },
  { path: '/chatbot/editar', permission: 'chatbot' },
  { path: '/rotinas', permission: 'routines' },
  { path: '/hsms', permission: 'hsms' },
  { path: '/settings', permission: 'settings' },
];

const normalizeRoleName = (value) =>
  String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export const isAdminLikeUser = (user) => {
  const role = normalizeRoleName(user?.role);
  const roleName = normalizeRoleName(user?.role_name || user?.roleName);
  const department = normalizeRoleName(user?.department_key || user?.departmentKey);

  return role === 'admin' || role === 'administrador' || roleName === 'admin' || roleName === 'administrador' || department === 'administracao';
};
export const normalizeNavigationPermissions = (permissions = {}, fallback = DEFAULT_NAVIGATION_PERMISSIONS) => {
  const source = permissions && typeof permissions === 'object' ? permissions : {};

  return NAVIGATION_PERMISSION_OPTIONS.reduce((accumulator, [key]) => {
    accumulator[key] = Boolean(source[key] ?? fallback?.[key] ?? false);
    return accumulator;
  }, {});
};

export const resolveUserNavigationPermissions = (user) => {
  if (isAdminLikeUser(user)) {
    return { ...ADMIN_NAVIGATION_PERMISSIONS };
  }

  return normalizeNavigationPermissions(
    user?.role_permissions || user?.rolePermissions || user?.permissions,
    DEFAULT_NAVIGATION_PERMISSIONS,
  );
};

export const canViewNavigationPermission = (user, permissionKey) => {
  if (isAdminLikeUser(user)) {
    return true;
  }

  return Boolean(resolveUserNavigationPermissions(user)[permissionKey]);
};

export const getRoutePermission = (pathname = '/') => {
  const safePathname = String(pathname || '/').trim() || '/';
  const matched = NAVIGATION_ROUTE_PERMISSIONS
    .slice()
    .sort((a, b) => b.path.length - a.path.length)
    .find((entry) => safePathname === entry.path || safePathname.startsWith(`${entry.path}/`));

  return matched?.permission || null;
};

export const canAccessPathname = (user, pathname = '/') => {
  const permission = getRoutePermission(pathname);
  if (!permission) {
    return true;
  }

  return canViewNavigationPermission(user, permission);
};

export const getFirstAllowedNavigationPath = (user) => {
  const orderedRoutes = ['/', '/envio', '/queues-services', '/tickets', '/quick-replies', '/customers', '/labels', '/chatbot', '/rotinas', '/hsms', '/dashboard', '/settings'];
  return orderedRoutes.find((path) => canAccessPathname(user, path)) || '/login';
};

