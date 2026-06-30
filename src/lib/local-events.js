import { buildLocalApiUrl } from '@/lib/local-api';

export const LOCAL_EVENT_NAMES = [
  'ready',
  'conversation:preference-updated',
  'conversation:assignment-updated',
  'conversation:message-upserted',
  'conversation:message-status-updated',
  'conversation:message-reaction-updated',
  'presence:started',
  'presence:stopped',
  'presence:distribution-paused',
  'presence:distribution-resumed',
];

const parseEventPayload = (event) => {
  try {
    return JSON.parse(event?.data || '{}');
  } catch {
    return { raw: event?.data || '' };
  }
};

export function subscribeToLocalEvents(onEvent, eventNames = LOCAL_EVENT_NAMES) {
  if (typeof EventSource === 'undefined' || typeof onEvent !== 'function') {
    return () => {};
  }

  const source = new EventSource(buildLocalApiUrl('/events/stream'), {
    withCredentials: true,
  });
  const listeners = [];

  eventNames.forEach((eventName) => {
    const listener = (event) => onEvent({ type: eventName, payload: parseEventPayload(event) });
    source.addEventListener(eventName, listener);
    listeners.push([eventName, listener]);
  });

  source.onmessage = (event) => onEvent({ type: 'message', payload: parseEventPayload(event) });
  source.onerror = () => {};

  return () => {
    listeners.forEach(([eventName, listener]) => source.removeEventListener(eventName, listener));
    source.close();
  };
}
