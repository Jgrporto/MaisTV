import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { resolveEffectiveUser } from '@/lib/current-user';
import { buildLoginUrl, fetchLocalAuthMe, loginLocalUser, logoutLocalUser } from '@/lib/local-auth';
import { subscribeToLocalAuthUnauthorized } from '@/lib/local-api';
import { AUTH_REFRESH_INTERVAL_MS } from '@/lib/performance-config';
import { stopAttendancePresence } from '@/lib/presence-api';

const AuthContext = createContext();

const getCurrentRelativeLocation = () => {
  if (typeof window === 'undefined') {
    return '/';
  }

  return `${window.location.pathname}${window.location.search}${window.location.hash}` || '/';
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const clearAuthState = useCallback((nextError = null) => {
    setUser(null);
    setIsAuthenticated(false);
    setAuthChecked(true);
    setAuthError(nextError);
    setIsLoadingAuth(false);
  }, []);

  const applyAuthenticatedUser = useCallback((currentUser) => {
    const nextUser = resolveEffectiveUser(currentUser);
    if (!nextUser) {
      clearAuthState({
        type: 'auth_required',
        message: 'Sessão inválida.',
      });
      return;
    }

    setUser(nextUser);
    setIsAuthenticated(true);
    setAuthChecked(true);
    setAuthError(null);
    setIsLoadingAuth(false);
  }, [clearAuthState]);

  const checkUserAuth = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) {
        setIsLoadingAuth(true);
      }

      const currentUser = await fetchLocalAuthMe();
      applyAuthenticatedUser(currentUser);
    } catch (error) {
      clearAuthState({
        type: 'auth_required',
        message: error?.message || 'Sessão inválida.',
      });
    }
  }, [applyAuthenticatedUser, clearAuthState]);

  const checkAppState = useCallback(async () => {
    await checkUserAuth();
  }, [checkUserAuth]);

  useEffect(() => {
    void checkAppState();
  }, [checkAppState]);

  useEffect(() => {
    const unsubscribe = subscribeToLocalAuthUnauthorized(() => {
      clearAuthState({
        type: 'auth_required',
        message: 'Sessão expirada.',
      });
    });

    return unsubscribe;
  }, [clearAuthState]);

  useEffect(() => {
    if (!isAuthenticated) {
      return () => {};
    }

    const intervalId = window.setInterval(() => {
      void checkUserAuth({ silent: true });
    }, AUTH_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [checkUserAuth, isAuthenticated]);

  const navigateToLogin = useCallback((redirectTo = getCurrentRelativeLocation()) => {
    if (typeof window !== 'undefined') {
      window.location.assign(buildLoginUrl(redirectTo));
    }
  }, []);

  const logout = useCallback(
    async (shouldRedirect = true) => {
      try {
        await stopAttendancePresence({ recoverAssignments: false, reason: 'logout' });
      } catch {
        // logout local continua mesmo se a presenca PostgreSQL estiver indisponivel
      }
      try {
        await logoutLocalUser();
      } catch {
        // ignore API errors and clear local state anyway
      }

      clearAuthState({
        type: 'auth_required',
        message: 'Sessão encerrada.',
      });

      if (shouldRedirect && typeof window !== 'undefined') {
        window.location.assign(buildLoginUrl(getCurrentRelativeLocation()));
      }
    },
    [clearAuthState],
  );

  const login = useCallback(async ({ username, password, remember = false } = {}) => {
    setIsLoadingAuth(true);
    setAuthError(null);

    try {
      const result = await loginLocalUser({ username, password, remember });
      applyAuthenticatedUser(result?.user || null);
      return result;
    } catch (error) {
      clearAuthState({
        type: 'auth_required',
        message: error?.message || 'Não foi possível concluir o login.',
      });
      throw error;
    }
  }, [applyAuthenticatedUser, clearAuthState]);

  const value = useMemo(
    () => ({
      user,
      effectiveUser: user ? resolveEffectiveUser(user) : null,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings: null,
      authChecked,
      authMode: 'local',
      usesLocalAuth: true,
      logout,
      login,
      navigateToLogin,
      checkUserAuth,
      checkAppState,
    }),
    [
      authChecked,
      authError,
      checkAppState,
      checkUserAuth,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings,
      login,
      logout,
      navigateToLogin,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
