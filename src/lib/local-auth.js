import { requestLocalApiJson } from '@/lib/local-api';

const sanitizeRedirectPath = (value) => {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/')) {
    return '/';
  }

  if (raw.startsWith('//')) {
    return '/';
  }

  return raw;
};

export const buildLoginUrl = (redirectTo = '/') => {
  const safeRedirect = sanitizeRedirectPath(redirectTo);
  const params = new URLSearchParams();
  if (safeRedirect && safeRedirect !== '/') {
    params.set('redirect', safeRedirect);
  }
  const query = params.toString();
  return `/login${query ? `?${query}` : ''}`;
};

export const resolvePostLoginRedirect = (fallback = '/') => {
  if (typeof window === 'undefined') {
    return fallback;
  }

  const redirect = new URLSearchParams(window.location.search).get('redirect');
  return sanitizeRedirectPath(redirect || fallback);
};

export const fetchLocalAuthMe = async () => {
  return await requestLocalApiJson('/auth/me', { method: 'GET' }, 'Sessão inválida.');
};

export const loginLocalUser = async ({ username, password, remember = false } = {}) => {
  const payload = {
    username: String(username || '').trim(),
    password: String(password || ''),
    remember: Boolean(remember),
  };

  return await requestLocalApiJson(
    '/auth/login',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    'Não foi possível concluir o login.',
  );
};

export const logoutLocalUser = async () => {
  return await requestLocalApiJson('/auth/logout', { method: 'POST' }, 'Não foi possível encerrar a sessão.');
};

export const disconnectLocalUserSessions = async (userId) => {
  return await requestLocalApiJson(
    '/auth/logout-user',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId }),
    },
    'Não foi possível desconectar o usuário selecionado.',
  );
};
