const DEFAULT_WHATSAPP_API_BASE_URL = 'https://api.89-117-32-226.nip.io';

const normalizeApiBaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

export const resolveWhatsappApiBaseUrl = () => {
  const configuredBaseUrl =
    import.meta.env.VITE_WHATSAPP_API_BASE_URL ||
    import.meta.env.VITE_API_BASE_URL ||
    DEFAULT_WHATSAPP_API_BASE_URL;

  return normalizeApiBaseUrl(configuredBaseUrl);
};

export const buildWhatsappApiUrl = (path, customBaseUrl = null) => {
  const baseUrl = normalizeApiBaseUrl(customBaseUrl || resolveWhatsappApiBaseUrl());
  return baseUrl ? `${baseUrl}${path}` : path;
};

const parseJsonResponse = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export const requestWhatsappJson = async (path, options = {}, customBaseUrl = null) => {
  const response = await fetch(buildWhatsappApiUrl(path, customBaseUrl), options);
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    const error = new Error(data?.error || `Falha na requisicao ${path}`);
    error.status = response.status;
    error.payload = data;
    error.path = path;
    throw error;
  }

  return data;
};
