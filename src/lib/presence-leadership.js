const PRESENCE_LEADER_TTL_MS = 45_000;

const createTabId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `presence-tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const tabId = createTabId();

const readRecord = (key) => {
  try {
    return JSON.parse(window.localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
};

export const createPresenceLeadership = (userId) => {
  const safeUserId = String(userId || '').trim();
  const key = `maistv:attendance-presence-leader:${safeUserId}`;

  const claim = () => {
    if (!safeUserId || typeof window === 'undefined' || !window.localStorage) {
      return true;
    }

    const now = Date.now();
    const current = readRecord(key);
    const currentOwner = String(current?.tabId || '').trim();
    const currentExpiresAt = Number(current?.expiresAt || 0);
    if (currentOwner && currentOwner !== tabId && currentExpiresAt > now) {
      return false;
    }

    try {
      window.localStorage.setItem(key, JSON.stringify({
        tabId,
        userId: safeUserId,
        expiresAt: now + PRESENCE_LEADER_TTL_MS,
        updatedAt: now,
      }));
      return true;
    } catch {
      return true;
    }
  };

  const release = () => {
    if (!safeUserId || typeof window === 'undefined' || !window.localStorage) {
      return;
    }
    const current = readRecord(key);
    if (String(current?.tabId || '') === tabId) {
      window.localStorage.removeItem(key);
    }
  };

  return { claim, release, sessionId: tabId };
};
