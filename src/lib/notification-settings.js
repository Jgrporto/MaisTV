import { parseJsonResponse, requestLocalApi } from '@/lib/local-api';

export const NOTIFICATION_SETTINGS_CHANGE_EVENT = 'saastv:settings:notifications:change';
export const MAX_NOTIFICATION_AUDIO_SIZE_BYTES = 2 * 1024 * 1024;

export const DEFAULT_NOTIFICATION_SETTINGS = {
  alertNewConversations: true,
  enableBrowserSound: true,
  defaultAudioName: '',
  defaultAudioDataUrl: '',
  customAudioLabelId: '',
  customAudioName: '',
  customAudioDataUrl: '',
};

let sharedAudioContext = null;
const decodedAudioBufferCache = new Map();

const canUseBrowser = () => typeof window !== 'undefined';

const normalizeSettings = (value) => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  ...(value && typeof value === 'object' ? value : {}),
  defaultAudioName:
    value?.defaultAudioName ||
    (!value?.defaultAudioDataUrl && value?.customAudioDataUrl ? value?.customAudioName || '' : ''),
  defaultAudioDataUrl:
    value?.defaultAudioDataUrl ||
    (!value?.defaultAudioDataUrl && value?.customAudioDataUrl ? value?.customAudioDataUrl || '' : ''),
});

const emitNotificationSettingsChange = (value) => {
  if (!canUseBrowser()) {
    return;
  }

  window.dispatchEvent(new CustomEvent(NOTIFICATION_SETTINGS_CHANGE_EVENT, { detail: normalizeSettings(value) }));
};

const requestNotificationSettingsJson = async (path = '', options = {}) => {
  const response = await requestLocalApi(`/settings/notifications${path}`, options);
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Falha ao salvar configuracoes de notificacao.');
  }

  return normalizeSettings(data);
};

export const fetchNotificationSettings = async () => {
  return await requestNotificationSettingsJson('', { method: 'GET' });
};

export const saveNotificationSettings = async (value) => {
  const normalized = normalizeSettings(value);
  const saved = await requestNotificationSettingsJson('', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(normalized),
  });
  emitNotificationSettingsChange(saved);
  return saved;
};

export const readNotificationSettings = (value) => normalizeSettings(value);

export const subscribeToNotificationSettings = (callback) => {
  if (!canUseBrowser()) {
    return () => {};
  }

  const handleCustomChange = (event) => {
    callback(normalizeSettings(event?.detail));
  };

  window.addEventListener(NOTIFICATION_SETTINGS_CHANGE_EVENT, handleCustomChange);

  return () => {
    window.removeEventListener(NOTIFICATION_SETTINGS_CHANGE_EVENT, handleCustomChange);
  };
};

export const warmNotificationAudio = async () => {
  if (!canUseBrowser()) {
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }

  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContextClass();
  }

  if (sharedAudioContext.state === 'suspended') {
    await sharedAudioContext.resume();
  }
};

const playAudioDataUrlWithContext = async (dataUrl) => {
  if (!canUseBrowser() || !dataUrl) {
    return false;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return false;
  }

  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContextClass();
  }

  if (sharedAudioContext.state === 'suspended') {
    await sharedAudioContext.resume();
  }

  let audioBuffer = decodedAudioBufferCache.get(dataUrl) || null;
  if (!audioBuffer) {
    const response = await fetch(dataUrl);
    const arrayBuffer = await response.arrayBuffer();
    audioBuffer = await sharedAudioContext.decodeAudioData(arrayBuffer.slice(0));
    decodedAudioBufferCache.set(dataUrl, audioBuffer);
  }

  const sourceNode = sharedAudioContext.createBufferSource();
  const gainNode = sharedAudioContext.createGain();
  gainNode.gain.value = 0.9;
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(gainNode);
  gainNode.connect(sharedAudioContext.destination);
  sourceNode.start();
  return true;
};

const playAudioDataUrlWithElement = async (dataUrl) => {
  if (!canUseBrowser() || !dataUrl) {
    return false;
  }

  const audio = new Audio(dataUrl);
  audio.preload = 'auto';
  audio.volume = 0.9;
  await audio.play();
  return true;
};

const playStoredNotificationAudio = async (dataUrl) => {
  if (!dataUrl) {
    return false;
  }

  try {
    return await playAudioDataUrlWithContext(dataUrl);
  } catch {
    return await playAudioDataUrlWithElement(dataUrl);
  }
};

const playFallbackBeep = async () => {
  if (!canUseBrowser()) {
    return false;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return false;
  }

  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContextClass();
  }

  if (sharedAudioContext.state === 'suspended') {
    await sharedAudioContext.resume();
  }

  const oscillator = sharedAudioContext.createOscillator();
  const gainNode = sharedAudioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(880, sharedAudioContext.currentTime);
  gainNode.gain.setValueAtTime(0.0001, sharedAudioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.18, sharedAudioContext.currentTime + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, sharedAudioContext.currentTime + 0.22);
  oscillator.connect(gainNode);
  gainNode.connect(sharedAudioContext.destination);
  oscillator.start(sharedAudioContext.currentTime);
  oscillator.stop(sharedAudioContext.currentTime + 0.24);
  return true;
};

export const playNotificationSound = async (settings = DEFAULT_NOTIFICATION_SETTINGS, context = {}) => {
  const safeSettings = normalizeSettings(settings);
  const contextLabelIds = Array.isArray(context.labelIds) ? context.labelIds : [];

  if (!safeSettings.enableBrowserSound || !canUseBrowser()) {
    return false;
  }

  if (
    safeSettings.customAudioDataUrl &&
    safeSettings.customAudioLabelId &&
    contextLabelIds.includes(safeSettings.customAudioLabelId)
  ) {
    return await playStoredNotificationAudio(safeSettings.customAudioDataUrl);
  }

  if (safeSettings.defaultAudioDataUrl) {
    return await playStoredNotificationAudio(safeSettings.defaultAudioDataUrl);
  }

  return await playFallbackBeep();
};
