import { requestChatJson } from '@/features/chat/api/chat-api';

export const fetchActiveAttendanceUsers = async () => {
  const data = await requestChatJson('/api/presence/attending-users', { method: 'GET' });
  return Array.isArray(data) ? data : [];
};

export const fetchAttendancePresenceStatus = async () => {
  return (await requestChatJson('/api/presence/status', { method: 'GET' })) || {};
};

export const startAttendancePresence = async () => {
  return requestChatJson('/api/presence/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });
};

export const heartbeatAttendancePresence = async () => {
  return requestChatJson('/api/presence/heartbeat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });
};

export const stopAttendancePresence = async ({ recoverAssignments = true, reason = 'attendance_stop' } = {}) => {
  return requestChatJson('/api/presence/stop', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ recoverAssignments, reason }),
  });
};

export const pauseAttendanceDistribution = async (reason = 'lunch') => {
  return requestChatJson('/api/presence/pause-distribution', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ durationMinutes: 10, reason }),
  });
};


export const resumeAttendanceDistribution = async () => {
  return requestChatJson('/api/presence/resume-distribution', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });
};
