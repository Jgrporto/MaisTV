import { parseJsonResponse, requestLocalApi } from '@/lib/local-api';

const LABELS_DEFAULT_STATE = {
  customLabels: [],
  assignments: {},
  stageAssignments: {},
  updatedAt: null,
};

const requestLabelsJson = async (path = '', options = {}) => {
  const response = await requestLocalApi(`/labels${path}`, options);
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Falha ao sincronizar etiquetas.');
  }

  return data;
};

const normalizeCatalogObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export const normalizeLabelCatalog = (value) => {
  const source = normalizeCatalogObject(value);
  const customLabels = Array.isArray(source.customLabels) ? source.customLabels : [];
  const assignments = normalizeCatalogObject(source.assignments);
  const stageAssignments = normalizeCatalogObject(source.stageAssignments);

  return {
    ...LABELS_DEFAULT_STATE,
    ...source,
    customLabels,
    assignments,
    stageAssignments,
  };
};

export const fetchLabelCatalog = async () => {
  const data = await requestLabelsJson('', { method: 'GET' });
  return normalizeLabelCatalog(data);
};

export const createCustomLabelRecord = async (payload) => {
  return await requestLabelsJson('', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });
};

export const updateCustomLabelRecord = async (labelId, payload) => {
  return await requestLabelsJson(`/${encodeURIComponent(labelId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });
};

export const deleteCustomLabelRecord = async (labelId) => {
  return await requestLabelsJson(`/${encodeURIComponent(labelId)}`, {
    method: 'DELETE',
  });
};

export const saveConversationLabelAssignments = async (conversationId, labelIds) => {
  return await requestLabelsJson(`/assignments/${encodeURIComponent(conversationId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      labelIds: Array.isArray(labelIds) ? labelIds : [],
    }),
  });
};

export const saveConversationLabelStage = async (conversationId, labelId) => {
  return await requestLabelsJson(`/stages/${encodeURIComponent(conversationId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      labelId: labelId || '',
    }),
  });
};

export const importLegacyLabelCatalog = async (payload) => {
  const normalized = normalizeLabelCatalog(payload);
  return await requestLabelsJson('/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(normalized),
  });
};
