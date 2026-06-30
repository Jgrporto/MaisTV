const parseBoolean = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const baseContext = {
  service: process.env.OTEL_SERVICE_NAME || process.env.MAISTV_RUNTIME_ROLE || 'maistv-chat',
  environment: process.env.NODE_ENV || 'development',
};

let sentry;

export async function initSentry(overrides = {}) {
  if (sentry) return sentry;
  const dsn = String(process.env.SENTRY_DSN || '').trim();
  if (!dsn || !parseBoolean(process.env.SENTRY_ENABLED, true)) return null;

  try {
    sentry = await import('@sentry/node');
    sentry.init({
      dsn,
      environment: baseContext.environment,
      release: process.env.SENTRY_RELEASE || undefined,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      sendDefaultPii: false,
      ...overrides,
    });
    return sentry;
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      ...baseContext,
      event: 'sentry_init_skipped',
      reason: error?.message || String(error),
    }));
    return null;
  }
}

export function captureException(error, context = {}) {
  if (!sentry) return;
  sentry.withScope((scope) => {
    scope.setTags({ service: baseContext.service, ...context.tags });
    if (context.extra) scope.setExtras(context.extra);
    sentry.captureException(error);
  });
}

export async function flushObservability(timeoutMs = 2000) {
  if (sentry) await sentry.flush(timeoutMs);
}

export function installProcessErrorHandlers(logger = console) {
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error?.({ err: error, ...baseContext }, 'unhandled rejection');
    captureException(error, { tags: { error_kind: 'unhandled_rejection' } });
  });

  process.on('uncaughtExceptionMonitor', (error) => {
    logger.error?.({ err: error, ...baseContext }, 'uncaught exception');
    captureException(error, { tags: { error_kind: 'uncaught_exception' } });
  });
}
