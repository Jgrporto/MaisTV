export const LOCAL_REALTIME_EVENT = 'saastv:local-realtime-event';

const canUseBrowser = () => typeof window !== 'undefined';

export const dispatchLocalRealtimeEvent = (eventName, payload = {}) => {
  if (!canUseBrowser() || !eventName) return;
  window.dispatchEvent(
    new CustomEvent(LOCAL_REALTIME_EVENT, {
      detail: {
        eventName,
        payload,
      },
    }),
  );
};

export const subscribeLocalRealtimeEvent = (eventName, callback) => {
  if (!canUseBrowser() || !eventName || typeof callback !== 'function') {
    return () => {};
  }

  const handler = (event) => {
    const detail = event?.detail || {};
    if (detail.eventName !== eventName) return;
    callback(detail.payload || {});
  };

  window.addEventListener(LOCAL_REALTIME_EVENT, handler);
  return () => window.removeEventListener(LOCAL_REALTIME_EVENT, handler);
};
