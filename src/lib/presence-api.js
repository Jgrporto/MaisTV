import { parseJsonResponse, requestLocalApi } from '@/lib/local-api';

export const fetchActiveAttendanceUsers = async () => {
  const response = await requestLocalApi('/presence/attending-users', { method: 'GET' });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Nao foi possivel carregar usuarios ativos.');
  }

  return Array.isArray(data) ? data : [];
};

export const fetchAttendancePresenceStatus = async () => {
  const response = await requestLocalApi('/presence/status', { method: 'GET' });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Nao foi possivel carregar o status da pausa.');
  }

  return data || {};
};

export const startAttendancePresence = async () => {
  const response = await requestLocalApi('/presence/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Nao foi possivel entrar no atendimento.');
  }

  return data;
};

export const stopAttendancePresence = async ({ recoverAssignments = true, reason = 'attendance_stop' } = {}) => {
  const response = await requestLocalApi('/presence/stop', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ recoverAssignments, reason }),
  });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Nao foi possivel sair do atendimento.');
  }

  return data;
};

export const pauseAttendanceDistribution = async (reason = 'lunch') => {
  const response = await requestLocalApi('/presence/pause-distribution', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ durationMinutes: 10, reason }),
  });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Nao foi possivel pausar a distribuicao da fila.');
  }

  return data;
};


export const resumeAttendanceDistribution = async () => {
  const response = await requestLocalApi('/presence/resume-distribution', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Nao foi possivel sair da pausa da fila.');
  }

  return data;
};
