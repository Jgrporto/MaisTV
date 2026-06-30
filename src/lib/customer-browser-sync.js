import { useSyncExternalStore } from 'react';

import {
  DEFAULT_NEWBR_BROWSER_BASE_URL,
  DEFAULT_NEWBR_BROWSER_PASSWORD,
  DEFAULT_NEWBR_BROWSER_USERNAME,
  collectNewbrCustomersInBrowser,
  importCollectedCustomers,
  markCustomerBrowserSyncStarted,
  reportCustomerBrowserSyncFailure,
} from '@/lib/customer-sync-api';
import { queryClientInstance } from '@/lib/query-client';

export const NEWBR_BROWSER_SYNC_STORAGE_KEY = 'saastv:newbr-browser-sync';

const listeners = new Set();

let syncState = {
  status: 'idle',
  mode: '',
  progress: '',
  startedAt: '',
  finishedAt: '',
  error: '',
  totalRows: 0,
  pagesLoaded: 0,
  lastPage: null,
};

const emit = () => {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {}
  });
};

const setSyncState = (patch) => {
  syncState = {
    ...syncState,
    ...patch,
  };
  emit();
};

const classifyBrowserSyncError = (error) => {
  const message = String(error?.message || 'Nao foi possivel sincronizar clientes pelo navegador.');
  const normalized = message.toLowerCase();

  if (normalized.includes('cloudflare')) {
    return {
      code: 'cloudflare',
      message,
      authErrorMessage: 'Cloudflare bloqueou a autenticacao do NewBr neste navegador.',
    };
  }

  if (
    normalized.includes('login') ||
    normalized.includes('autentic') ||
    normalized.includes('token') ||
    normalized.includes('credencia') ||
    normalized.includes('usuario e senha')
  ) {
    return {
      code: 'auth',
      message,
      authErrorMessage: 'Falha de autorizacao no navegador. Revise as credenciais salvas e refaca a autenticacao.',
    };
  }

  return {
    code: 'browser',
    message,
    authErrorMessage: null,
  };
};

export const readStoredBrowserSyncConfig = () => {
  if (typeof window === 'undefined') {
    return {
      baseUrl: DEFAULT_NEWBR_BROWSER_BASE_URL,
      username: DEFAULT_NEWBR_BROWSER_USERNAME,
      password: DEFAULT_NEWBR_BROWSER_PASSWORD,
    };
  }

  try {
    const raw = window.localStorage.getItem(NEWBR_BROWSER_SYNC_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      baseUrl: String(parsed?.baseUrl || DEFAULT_NEWBR_BROWSER_BASE_URL).trim() || DEFAULT_NEWBR_BROWSER_BASE_URL,
      username: String(parsed?.username || DEFAULT_NEWBR_BROWSER_USERNAME).trim() || DEFAULT_NEWBR_BROWSER_USERNAME,
      password: String(parsed?.password || DEFAULT_NEWBR_BROWSER_PASSWORD),
    };
  } catch {
    return {
      baseUrl: DEFAULT_NEWBR_BROWSER_BASE_URL,
      username: DEFAULT_NEWBR_BROWSER_USERNAME,
      password: DEFAULT_NEWBR_BROWSER_PASSWORD,
    };
  }
};

export const persistBrowserSyncConfig = (config) => {
  if (typeof window === 'undefined') return;

  window.localStorage.setItem(
    NEWBR_BROWSER_SYNC_STORAGE_KEY,
    JSON.stringify({
      baseUrl: String(config?.baseUrl || DEFAULT_NEWBR_BROWSER_BASE_URL).trim(),
      username: String(config?.username || DEFAULT_NEWBR_BROWSER_USERNAME).trim(),
      password: String(config?.password || DEFAULT_NEWBR_BROWSER_PASSWORD),
    }),
  );
};

export const hasStoredBrowserSyncConfig = () => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const raw = window.localStorage.getItem(NEWBR_BROWSER_SYNC_STORAGE_KEY);
    if (!raw) {
      return false;
    }

    const parsed = JSON.parse(raw);
    return Boolean(
      String(parsed?.baseUrl || '').trim() &&
      String(parsed?.username || '').trim() &&
      String(parsed?.password || '').trim(),
    );
  } catch {
    return false;
  }
};

export const getCustomerBrowserSyncState = () => syncState;

export const subscribeToCustomerBrowserSync = (listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useCustomerBrowserSync = () =>
  useSyncExternalStore(subscribeToCustomerBrowserSync, getCustomerBrowserSyncState, getCustomerBrowserSyncState);

export const startCustomerBrowserSync = ({
  baseUrl,
  username,
  password,
  mode = 'browser_manual',
} = {}) => {
  if (syncState.status === 'running') {
    throw new Error('Ja existe uma sincronizacao em andamento neste navegador.');
  }

  const startedAt = new Date().toISOString();
  setSyncState({
    status: 'running',
    mode,
    progress: 'Iniciando autenticacao no navegador...',
    startedAt,
    finishedAt: '',
    error: '',
    totalRows: 0,
    pagesLoaded: 0,
    lastPage: null,
  });

  void (async () => {
    try {
      await markCustomerBrowserSyncStarted({
        mode,
        startedAt,
        source: 'browser-newbr',
      });

      const collected = await collectNewbrCustomersInBrowser({
        baseUrl,
        username,
        password,
        onProgress: (progress) => {
          setSyncState({
            progress: String(progress || 'Sincronizando clientes...'),
          });
        },
      });

      setSyncState({
        progress: 'Persistindo clientes coletados na VPS...',
      });

      await importCollectedCustomers({
        ...collected,
        startedAt,
        mode,
      });

      await Promise.all([
        queryClientInstance.invalidateQueries({ queryKey: ['persisted-customers'] }),
        queryClientInstance.invalidateQueries({ queryKey: ['customer-sync-state'] }),
        queryClientInstance.invalidateQueries({ queryKey: ['customer-sync-logs'] }),
      ]);

      setSyncState({
        status: 'success',
        mode,
        progress: 'Sincronizacao realizada com sucesso.',
        finishedAt: new Date().toISOString(),
        error: '',
        totalRows: Number(collected?.totalRows || 0),
        pagesLoaded: Number(collected?.pagesLoaded || 0),
        lastPage: Number.isFinite(Number(collected?.lastPage)) ? Number(collected.lastPage) : null,
      });
    } catch (error) {
      const syncError = classifyBrowserSyncError(error);

      try {
        await reportCustomerBrowserSyncFailure({
          mode,
          startedAt,
          error: syncError.message,
          errorCode: syncError.code,
          authErrorMessage: syncError.authErrorMessage,
          source: 'browser-newbr',
        });
      } catch {}

      await Promise.all([
        queryClientInstance.invalidateQueries({ queryKey: ['customer-sync-state'] }),
        queryClientInstance.invalidateQueries({ queryKey: ['customer-sync-logs'] }),
      ]);

      setSyncState({
        status: 'error',
        mode,
        progress: '',
        finishedAt: new Date().toISOString(),
        error: syncError.message,
      });
    }
  })();
};
