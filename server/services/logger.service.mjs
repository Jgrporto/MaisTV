let loggerPromise;
const fallback = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, (data, message) => console[level === 'debug' ? 'log' : level](message || '', data || '')]));
export const getLogger = async () => {
  if (!loggerPromise) loggerPromise = import('pino').then(({ default: pino }) => pino({ name: 'maistv-chat-stack', level: process.env.LOG_LEVEL || 'info' })).catch(() => fallback);
  return loggerPromise;
};
