const DEFAULT_INVALIDATION_DELAY_MS = 750;

const pendingInvalidations = new Map();

const buildInvalidationKey = (options = {}) =>
  JSON.stringify({
    queryKey: Array.isArray(options.queryKey) ? options.queryKey : [],
    exact: Boolean(options.exact),
  });

export const scheduleQueryInvalidation = (
  queryClient,
  options = {},
  delayMs = DEFAULT_INVALIDATION_DELAY_MS,
) => {
  if (!queryClient || typeof queryClient.invalidateQueries !== 'function') {
    return;
  }

  const key = buildInvalidationKey(options);
  const existing = pendingInvalidations.get(key);
  if (existing) {
    existing.options = options;
    return;
  }

  const timeoutId = setTimeout(() => {
    const pending = pendingInvalidations.get(key);
    pendingInvalidations.delete(key);
    void queryClient.invalidateQueries(pending?.options || options);
  }, Math.max(0, Number(delayMs) || 0));

  pendingInvalidations.set(key, { options, timeoutId });
};
