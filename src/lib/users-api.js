import { parseJsonResponse, requestLocalApi } from '@/lib/local-api';

export const fetchLocalUsers = async () => {
  const response = await requestLocalApi('/entities/User?sort=full_name', { method: 'GET' });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Nao foi possivel carregar usuarios.');
  }

  return Array.isArray(data) ? data : [];
};

