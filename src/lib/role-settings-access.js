export const SETTINGS_SECTION_OPTIONS = [
  ['profile', 'Perfil', 'Dados do usuario autenticado.'],
  ['notifications', 'Notificacoes', 'Audios, alertas e comportamento operacional.'],
  ['appearance', 'Aparencia', 'Tema claro/escuro e preferencias visuais locais.'],
  ['dashboard', 'Dashboard', 'Palavras-chave e janelas usadas nos indicadores.'],
  ['customerSync', 'Sincronizacao', 'Intervalo e agendamento da base de clientes.'],
  ['schedules', 'Agendamentos', 'HSM padrao usado na criacao de agendamentos.'],
  ['tavinho', 'Tavinho', 'Base, textos e dados liberados para o copiloto.'],
  ['team', 'Equipe', 'Usuarios, sessoes e permissoes operacionais.'],
  ['roles', 'Funcoes', 'Perfis, departamentos e acessos da plataforma.'],
  ['services', 'Servicos', 'Filas, numeros e etiquetas por servico.'],
  ['audit', 'Auditoria', 'Registro local das acoes administrativas.'],
];

export const SETTINGS_ACCESS_LEVELS = [
  ['hidden', 'Oculto'],
  ['view', 'Somente visualizacao'],
  ['edit', 'Visualizacao e edicao'],
];

export const DEFAULT_ROLE_SETTINGS_ACCESS = {
  profile: 'edit',
  notifications: 'edit',
  appearance: 'edit',
  dashboard: 'edit',
  customerSync: 'edit',
  schedules: 'edit',
  tavinho: 'edit',
  team: 'edit',
  roles: 'edit',
  services: 'edit',
  audit: 'edit',
};

export const HIDDEN_ROLE_SETTINGS_ACCESS = {
  profile: 'hidden',
  notifications: 'hidden',
  appearance: 'hidden',
  dashboard: 'hidden',
  customerSync: 'hidden',
  schedules: 'hidden',
  tavinho: 'hidden',
  team: 'hidden',
  roles: 'hidden',
  services: 'hidden',
  audit: 'hidden',
};

export const normalizeRoleSettingsAccess = (value, fallback = DEFAULT_ROLE_SETTINGS_ACCESS) =>
  SETTINGS_SECTION_OPTIONS.reduce((accumulator, [key]) => {
    const candidate = String(value?.[key] || fallback?.[key] || 'hidden').trim().toLowerCase();
    accumulator[key] = ['hidden', 'view', 'edit'].includes(candidate) ? candidate : 'hidden';
    return accumulator;
  }, {});

export const getSettingsSectionAccessLevel = (settingsAccess, sectionKey) =>
  normalizeRoleSettingsAccess(settingsAccess)[sectionKey] || 'hidden';

export const canViewSettingsSection = (settingsAccess, sectionKey) =>
  getSettingsSectionAccessLevel(settingsAccess, sectionKey) !== 'hidden';

export const canEditSettingsSection = (settingsAccess, sectionKey) =>
  getSettingsSectionAccessLevel(settingsAccess, sectionKey) === 'edit';
