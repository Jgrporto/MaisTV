const timers = new Map();

export const startRegisteredInterval = (name, callback, intervalMs, options = {}) => {
  const safeName = String(name || '').trim();
  if (!safeName) {
    throw new Error('Scheduler name is required.');
  }
  if (timers.has(safeName) && !options.replace) {
    return timers.get(safeName);
  }
  if (timers.has(safeName)) {
    stopRegisteredInterval(safeName);
  }

  const timer = setInterval(callback, intervalMs);
  if (options.unref !== false && typeof timer.unref === 'function') {
    timer.unref();
  }
  timers.set(safeName, timer);
  return timer;
};

export const stopRegisteredInterval = (name) => {
  const safeName = String(name || '').trim();
  const timer = timers.get(safeName);
  if (!timer) return false;
  clearInterval(timer);
  timers.delete(safeName);
  return true;
};

export const stopAllSchedulers = () => {
  for (const name of Array.from(timers.keys())) {
    stopRegisteredInterval(name);
  }
};
