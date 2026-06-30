const DEFAULT_THRESHOLD_MS = 750;

export const parsePositiveInt = (value, fallback = DEFAULT_THRESHOLD_MS) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

export const startPerfMeasure = () => ({
  at: nowMs(),
  cpu: process.cpuUsage(),
});

export const finishPerfMeasure = (measure = startPerfMeasure()) => {
  const durationMs = Math.max(0, nowMs() - Number(measure.at || 0));
  const cpu = process.cpuUsage(measure.cpu);
  const memory = process.memoryUsage();

  return {
    durationMs,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
  };
};

export const shouldLogDuration = (durationMs, thresholdRaw, fallback = DEFAULT_THRESHOLD_MS) =>
  Number(durationMs || 0) >= parsePositiveInt(thresholdRaw, fallback);

const normalizeLogPart = (value) =>
  String(value ?? '')
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 160);

export const formatPerfFields = (fields = {}) =>
  Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${normalizeLogPart(value)}`)
    .join(' ');

export const logPerf = (tag, fields = {}, { level = 'warn' } = {}) => {
  const safeTag = normalizeLogPart(tag || 'perf') || 'perf';
  const line = `[${safeTag}] ${formatPerfFields(fields)}`.trim();
  const logger = typeof console[level] === 'function' ? console[level] : console.log;
  logger(line);
};
