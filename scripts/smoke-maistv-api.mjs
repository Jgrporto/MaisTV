const args = process.argv.slice(2);
const baseArg = args.find((arg) => arg.startsWith('--base='));
const baseUrl = (baseArg ? baseArg.slice('--base='.length) : 'http://127.0.0.1:5053').replace(/\/+$/, '');

const endpoints = [
  { path: '/api/local/health', requiredStatuses: [200] },
  { path: '/api/local/auth/me', allowedStatuses: [200, 401, 403] },
  { path: '/api/local/events/stream', allowedStatuses: [200, 401, 403], timeoutMs: 3000 },
  { path: '/api/local/settings/notifications', allowedStatuses: [200, 401, 403] },
  { path: '/api/local/customers', allowedStatuses: [200, 401, 403] },
  { path: '/api/local/labels', allowedStatuses: [200, 401, 403] },
];

const checkEndpoint = async (endpoint) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), endpoint.timeoutMs || 8000);
  try {
    const response = await fetch(`${baseUrl}${endpoint.path}`, {
      method: 'GET',
      credentials: 'include',
      signal: controller.signal,
    });
    const allowed = endpoint.requiredStatuses || endpoint.allowedStatuses || [200];
    return {
      path: endpoint.path,
      status: response.status,
      ok: allowed.includes(response.status) && response.status < 500,
    };
  } catch (error) {
    return {
      path: endpoint.path,
      status: 0,
      ok: false,
      error: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const main = async () => {
  const results = [];
  for (const endpoint of endpoints) {
    results.push(await checkEndpoint(endpoint));
  }

  console.log(JSON.stringify({ baseUrl, results }, null, 2));
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

await main();
