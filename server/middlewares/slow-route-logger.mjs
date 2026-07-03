import { randomUUID } from 'node:crypto';
import {
  finishPerfMeasure,
  parsePositiveInt,
  startPerfMeasure,
} from '../utils/perf-log.mjs';

const DEFAULT_THRESHOLD_MS = 750;
const DEFAULT_LARGE_RESPONSE_BYTES = 1024 * 1024;

const SENSITIVE_QUERY_KEY_PATTERN = /(token|senha|password|pass|authorization|auth|secret|checkout)/i;

const normalizePathForLog = (req) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const safeParams = new URLSearchParams();

    for (const [key, value] of url.searchParams.entries()) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
        safeParams.set(key, '[redacted]');
        continue;
      }
      if (String(value || '').length <= 64) {
        safeParams.set(key, value);
      }
    }

    const query = safeParams.toString();
    return query ? `${url.pathname}?${query}` : url.pathname;
  } catch {
    return String(req.url || '/').split('?')[0] || '/';
  }
};

const byteLengthOf = (chunk, encoding) => {
  if (!chunk) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  }
  return 0;
};

const normalizeLogPart = (value) =>
  String(value || '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 120);

const normalizeRequestId = (value) => {
  const normalized = String(value || '').trim();
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(normalized) ? normalized : '';
};

const readTiming = (req, res, camelName, snakeName) => {
  const timingSources = [res.locals?.perfTimings, req.perfTimings, res.perfTimings];
  for (const source of timingSources) {
    const raw = source?.[camelName] ?? source?.[snakeName];
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed * 100) / 100;
  }
  return undefined;
};

const formatOptionalTiming = (name, value) =>
  value === undefined ? '' : ` ${name}=${value}`;

export const attachSlowRouteLogger = (req, res, options = {}) => {
  if (!req || !res || res.__slowRouteLoggerAttached) {
    return;
  }

  res.__slowRouteLoggerAttached = true;

  const thresholdMs = parsePositiveInt(
    options.thresholdMs || process.env.SLOW_ROUTE_THRESHOLD_MS,
    DEFAULT_THRESHOLD_MS,
  );
  const largeResponseBytes = parsePositiveInt(
    options.largeResponseBytes || process.env.LARGE_RESPONSE_THRESHOLD_BYTES,
    DEFAULT_LARGE_RESPONSE_BYTES,
  );
  const source = normalizeLogPart(options.source);
  const incomingRequestId = normalizeRequestId(req.headers?.['x-request-id']);
  const requestId = incomingRequestId || randomUUID();
  req.requestId = requestId;
  res.setHeader?.('X-Request-Id', requestId);
  const measure = startPerfMeasure();
  let responseBytes = 0;

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = (...args) => {
    responseBytes += byteLengthOf(args[0], args[1]);
    return originalWrite(...args);
  };

  res.end = (...args) => {
    responseBytes += byteLengthOf(args[0], args[1]);
    return originalEnd(...args);
  };

  res.on('finish', () => {
    const perf = finishPerfMeasure(measure);
    const durationMs = perf.durationMs;
    const contentType = String(res.getHeader?.('Content-Type') || '').toLowerCase();
    const urlPath = normalizePathForLog(req);
    if (contentType.includes('text/event-stream') || urlPath.endsWith('/stream')) {
      return;
    }

    const contentLength = Number.parseInt(String(res.getHeader?.('Content-Length') || ''), 10);
    const measuredBytes = responseBytes || (Number.isFinite(contentLength) ? contentLength : 0);
    const role = normalizeLogPart(req.authContext?.user?.role || req.authContext?.user?.role_name);
    const sourcePart = source ? `${source} ` : '';
    const rolePart = role ? ` role=${role}` : '';
    const bytesPart = measuredBytes > 0
      ? ` bytes=${measuredBytes} response_bytes=${measuredBytes}`
      : '';
    const perfPart = ` cpuUserMs=${perf.cpuUserMs} cpuSystemMs=${perf.cpuSystemMs} rssMb=${perf.rssMb} heapUsedMb=${perf.heapUsedMb} eventLoopDelayMs=${perf.eventLoopDelayMs}`;
    const timingPart = [
      ['postgresMs', 'postgres_ms', 'postgres_ms'],
      ['storeMs', 'store_ms', 'store_ms'],
      ['transformMs', 'transform_ms', 'transform_ms'],
      ['serializeMs', 'serialize_ms', 'serialize_ms'],
    ].map(([camelName, snakeName, logName]) =>
      formatOptionalTiming(logName, readTiming(req, res, camelName, snakeName)),
    ).join('');
    const common = `${sourcePart}${normalizeLogPart(req.method)} ${urlPath} ${durationMs}ms duration_ms=${durationMs} status=${res.statusCode}${bytesPart}${rolePart} request_id=${requestId}${perfPart} event_loop_delay_ms=${perf.eventLoopDelayMs}${timingPart}`;

    if (durationMs >= thresholdMs) {
      console.warn(`[SLOW_ROUTE] ${common}`);
    }
    if (measuredBytes > largeResponseBytes) {
      console.warn(`[LARGE_RESPONSE] ${common} thresholdBytes=${largeResponseBytes}`);
    }
  });
};
