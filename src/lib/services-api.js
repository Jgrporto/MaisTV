import { normalizeService, sortServices } from './services';
import { requestChatJson } from '@/features/chat/api/chat-api';

export const fetchServices = async () => {
  const data = await requestChatJson('/api/queues', { method: 'GET' });
  return sortServices((Array.isArray(data) ? data : []).map((service, index) => normalizeService(service, index)));
};

export const saveService = async (serviceId, payload) => {
  if (serviceId) {
    return normalizeService(
      await requestChatJson(`/api/queues/${encodeURIComponent(serviceId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload || {}),
      }),
    );
  }

  return normalizeService(
    await requestChatJson('/api/queues', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    }),
  );
};

export const deleteService = async (serviceId) => {
  const safeServiceId = String(serviceId || '').trim();
  if (!safeServiceId) {
    return { ok: true };
  }

  return await requestChatJson(`/api/queues/${encodeURIComponent(safeServiceId)}`, {
    method: 'DELETE',
  });
};
