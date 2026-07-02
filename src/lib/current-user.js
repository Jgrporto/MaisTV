export const DEFAULT_LOCAL_ADMIN_USER = {
  id: 'user-admin',
  full_name: 'Administrador SaaSTV',
  email: 'admin@saastv.local',
  username: 'admin',
  role: 'admin',
  role_name: 'Administrador',
};

export const resolveEffectiveUser = (user) => {
  if (user && (user.id || user.email || user.full_name)) {
    return { ...user };
  }

  return null;
};
