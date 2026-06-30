import { requestWhatsappJson } from './whatsapp-http';

const HSM_UI_STATE_STORAGE_KEY = 'plustv:hsm-ui-state:v1';

export const hsmSyncKey = (name, language = 'pt_BR') =>
  `${String(name || '').trim().toLowerCase()}::${String(language || 'pt_BR')
    .trim()
    .toUpperCase()}`;

export const fetchMetaHsms = async () => {
  const data = await requestWhatsappJson('/api/whatsapp/templates', {
    method: 'GET',
  });

  return Array.isArray(data) ? data : [];
};

export const fetchLocalHsms = async () => {
  const data = await requestWhatsappJson('/api/whatsapp/templates/local', {
    method: 'GET',
  });

  return {
    updatedAt: data?.updatedAt || null,
    items: Array.isArray(data?.items) ? data.items : [],
  };
};

export const saveLocalHsm = async (payload) => {
  const data = await requestWhatsappJson('/api/whatsapp/templates/local', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return data?.item || null;
};

export const replaceLocalHsms = async (items) => {
  const data = await requestWhatsappJson('/api/whatsapp/templates/local', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ items }),
  });

  return Array.isArray(data?.items) ? data.items : [];
};

export const deleteLocalHsm = async (id) => {
  const data = await requestWhatsappJson('/api/whatsapp/templates/local/delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id }),
  });

  return Boolean(data?.ok || data?.status === 'ok');
};

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Falha ao ler arquivo'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });

export const uploadHsmMedia = async (file) => {
  const dataUrl = await fileToDataUrl(file);
  return await requestWhatsappJson('/api/whatsapp/templates/local/media/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type,
      dataUrl,
    }),
  });
};

export const createMetaHsm = async (payload) => {
  return await requestWhatsappJson('/api/whatsapp/templates', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
};

const readUiStateRaw = () => {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(HSM_UI_STATE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const writeUiStateRaw = (value) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(HSM_UI_STATE_STORAGE_KEY, JSON.stringify(value || {}));
};

export const readHsmUiState = () => readUiStateRaw();

export const writeHsmUiState = (key, value) => {
  if (!key) return;
  const current = readUiStateRaw();
  current[key] = value;
  writeUiStateRaw(current);
};

export const removeHsmUiState = (key) => {
  if (!key) return;
  const current = readUiStateRaw();
  delete current[key];
  writeUiStateRaw(current);
};
