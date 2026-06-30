import { requestLocalApiJson } from './local-api';

const jsonHeaders = { 'Content-Type': 'application/json' };

export const fetchRoutines = async () =>
  requestLocalApiJson('/routines', { method: 'GET', timeoutMs: 10000 }, 'Falha ao carregar rotinas.');

export const createRoutine = async (payload) =>
  requestLocalApiJson(
    '/routines',
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload || {}),
      timeoutMs: 12000,
    },
    'Falha ao criar rotina.',
  );

export const updateRoutine = async (routineId, payload) =>
  requestLocalApiJson(
    `/routines/${encodeURIComponent(routineId)}`,
    {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(payload || {}),
      timeoutMs: 12000,
    },
    'Falha ao salvar rotina.',
  );

export const deleteRoutine = async (routineId) =>
  requestLocalApiJson(
    `/routines/${encodeURIComponent(routineId)}`,
    { method: 'DELETE', timeoutMs: 10000 },
    'Falha ao excluir rotina.',
  );

export const previewRoutine = async (routineId, routine) =>
  requestLocalApiJson(
    `/routines/${encodeURIComponent(routineId)}/preview`,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ routine, limit: 1000 }),
      timeoutMs: 12000,
    },
    'Falha ao gerar preview da rotina.',
  );

export const previewRoutineDraft = async (routine) =>
  requestLocalApiJson(
    '/routines/preview',
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ routine }),
      timeoutMs: 12000,
    },
    'Falha ao gerar previsao da rotina.',
  );

export const runRoutineNow = async (routineId) =>
  requestLocalApiJson(
    `/routines/${encodeURIComponent(routineId)}/run-now`,
    { method: 'POST', timeoutMs: 10000 },
    'Falha ao executar rotina.',
  );

export const runRoutineManually = async (routineId, payload = {}) =>
  requestLocalApiJson(
    `/routines/${encodeURIComponent(routineId)}/manual-run`,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload || {}),
      timeoutMs: 5 * 60 * 1000,
    },
    'Falha ao executar envio manual.',
  );

export const retryRoutineFailedRun = async (routineId, runId) =>
  requestLocalApiJson(
    `/routines/${encodeURIComponent(routineId)}/retry-failed-run`,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ runId }),
      timeoutMs: 10000,
    },
    'Falha ao reenviar clientes com erro desta execucao.',
  );

export const fetchRoutineLogs = async ({ routineId = '', limit = 120 } = {}) => {
  const params = new URLSearchParams();
  if (routineId) params.set('routineId', routineId);
  if (limit) params.set('limit', String(limit));
  const suffix = params.toString() ? `?${params}` : '';
  return requestLocalApiJson(`/routines/logs${suffix}`, { method: 'GET', timeoutMs: 10000 }, 'Falha ao carregar logs.');
};

export const clearRoutineLogs = async () =>
  requestLocalApiJson(
    '/routines/logs',
    { method: 'DELETE', timeoutMs: 10000 },
    'Falha ao limpar logs.',
  );

export const fetchActiveDispatches = async () =>
  requestLocalApiJson(
    '/dispatches/active',
    { method: 'GET', timeoutMs: 10000 },
    'Falha ao carregar disparos em andamento.',
  );

export const cancelActiveDispatch = async ({ type, id }) =>
  requestLocalApiJson(
    '/dispatches/cancel',
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ type, id }),
      timeoutMs: 10000,
    },
    'Falha ao encerrar disparo.',
  );
