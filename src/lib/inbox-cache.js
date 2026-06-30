const DB_NAME = 'saastv-inbox-cache';
const DB_VERSION = 2;
const CONVERSATIONS_STORE = 'conversations';
const MESSAGE_LISTS_STORE = 'messageLists';
const DRAFTS_STORE = 'drafts';
const DRAFTS_CHANGE_EVENT = 'saastv:inbox-cache:drafts:change';

let dbPromise = null;

const canUseIndexedDb = () =>
  typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

const openDatabase = () => {
  if (!canUseIndexedDb()) {
    return Promise.resolve(null);
  }

  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
        db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains(MESSAGE_LISTS_STORE)) {
        db.createObjectStore(MESSAGE_LISTS_STORE, { keyPath: 'conversationId' });
      }

      if (!db.objectStoreNames.contains(DRAFTS_STORE)) {
        db.createObjectStore(DRAFTS_STORE, { keyPath: 'conversationId' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });

  return dbPromise;
};

const runTransaction = async (storeName, mode, executor) => {
  const db = await openDatabase();
  if (!db) return null;

  return await new Promise((resolve) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);

    transaction.onerror = () => resolve(null);
    transaction.onabort = () => resolve(null);

    executor(store, resolve);
  });
};

const emitDraftsChange = (detail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DRAFTS_CHANGE_EVENT, { detail }));
};

const normalizeDraftEntry = (payload) => {
  const conversationId = String(payload?.conversationId || '').trim();
  const value = String(payload?.value || '');

  if (!conversationId || value.trim().length === 0) {
    return null;
  }

  return {
    conversationId,
    value,
    updatedAt: String(payload?.updatedAt || ''),
    sortAt: String(payload?.sortAt || payload?.activatedAt || ''),
  };
};

const readDraftRecord = async (conversationId) => {
  if (!conversationId) return null;

  return await runTransaction(DRAFTS_STORE, 'readonly', (store, resolve) => {
    const request = store.get(conversationId);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result || null);
  });
};

export const readCachedConversations = async () => {
  const payload = await runTransaction(CONVERSATIONS_STORE, 'readonly', (store, resolve) => {
    const request = store.get('latest');
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result || null);
  });

  return Array.isArray(payload?.items) ? payload.items : [];
};

export const writeCachedConversations = async (items) => {
  const safeItems = Array.isArray(items) ? items : [];

  await runTransaction(CONVERSATIONS_STORE, 'readwrite', (store, resolve) => {
    const request = store.put({
      key: 'latest',
      items: safeItems,
      updatedAt: new Date().toISOString(),
    });

    request.onerror = () => resolve(false);
    request.onsuccess = () => resolve(true);
  });
};

export const readCachedMessages = async (conversationId) => {
  if (!conversationId) return [];

  const payload = await runTransaction(MESSAGE_LISTS_STORE, 'readonly', (store, resolve) => {
    const request = store.get(conversationId);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result || null);
  });

  return Array.isArray(payload?.items) ? payload.items : [];
};

export const writeCachedMessages = async (conversationId, items) => {
  if (!conversationId) return;
  const safeItems = Array.isArray(items) ? items : [];

  await runTransaction(MESSAGE_LISTS_STORE, 'readwrite', (store, resolve) => {
    const request = store.put({
      conversationId,
      items: safeItems,
      updatedAt: new Date().toISOString(),
    });

    request.onerror = () => resolve(false);
    request.onsuccess = () => resolve(true);
  });
};

export const readCachedDraft = async (conversationId) => {
  if (!conversationId) return '';

  const payload = await readDraftRecord(conversationId);

  return String(payload?.value || '');
};

export const readCachedDraftEntries = async () => {
  const payload = await runTransaction(DRAFTS_STORE, 'readonly', (store, resolve) => {
    const request = store.getAll();
    request.onerror = () => resolve([]);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
  });

  return Array.isArray(payload) ? payload.map(normalizeDraftEntry).filter(Boolean) : [];
};

export const subscribeToCachedDrafts = (callback) => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleChange = () => callback();
  window.addEventListener(DRAFTS_CHANGE_EVENT, handleChange);

  return () => {
    window.removeEventListener(DRAFTS_CHANGE_EVENT, handleChange);
  };
};

export const writeCachedDraft = async (conversationId, value) => {
  if (!conversationId) return;
  const safeValue = String(value || '');

  if (safeValue.trim().length === 0) {
    await deleteCachedDraft(conversationId);
    return;
  }

  const currentDraft = await readDraftRecord(conversationId);
  const timestamp = new Date().toISOString();
  const nextPayload = {
    conversationId,
    value: safeValue,
    updatedAt: timestamp,
    sortAt: String(currentDraft?.sortAt || currentDraft?.activatedAt || ''),
  };

  await runTransaction(DRAFTS_STORE, 'readwrite', (store, resolve) => {
    const request = store.put(nextPayload);

    request.onerror = () => resolve(false);
    request.onsuccess = () => resolve(true);
  });

  emitDraftsChange(nextPayload);
};

export const promoteCachedDraft = async (conversationId) => {
  if (!conversationId) return;

  const currentDraft = await readDraftRecord(conversationId);
  const safeValue = String(currentDraft?.value || '');
  if (safeValue.trim().length === 0) return;

  const nextPayload = {
    ...currentDraft,
    conversationId: String(conversationId),
    value: safeValue,
    updatedAt: String(currentDraft?.updatedAt || new Date().toISOString()),
    sortAt: new Date().toISOString(),
  };

  await runTransaction(DRAFTS_STORE, 'readwrite', (store, resolve) => {
    const request = store.put(nextPayload);

    request.onerror = () => resolve(false);
    request.onsuccess = () => resolve(true);
  });

  emitDraftsChange(nextPayload);
};

export const deleteCachedDraft = async (conversationId) => {
  if (!conversationId) return;

  await runTransaction(DRAFTS_STORE, 'readwrite', (store, resolve) => {
    const request = store.delete(conversationId);
    request.onerror = () => resolve(false);
    request.onsuccess = () => resolve(true);
  });

  emitDraftsChange({
    conversationId: String(conversationId),
    value: '',
    updatedAt: new Date().toISOString(),
    sortAt: '',
  });
};
