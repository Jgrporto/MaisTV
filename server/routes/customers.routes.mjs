import { getOptionalPaginationFromSearchParams, paginateItems } from '../middlewares/pagination.mjs';

let customersResponseCache = null;

const buildCustomersResponseJson = (store = {}, pagination = null, getPublicCustomerSyncState) => {
  const sync = getPublicCustomerSyncState(store.customerSync);
  const allRows = Array.isArray(store.customers) ? store.customers : [];
  const paginatedRows = paginateItems(allRows, pagination);
  const cacheKey = JSON.stringify({
    rowsLength: allRows.length,
    lastSyncAt: sync.lastSyncAt || null,
    lastSuccessfulSyncAt: sync.lastSuccessfulSyncAt || null,
    status: sync.status || null,
    currentRunStartedAt: sync.currentRunStartedAt || null,
    nextScheduledAt: sync.nextScheduledAt || null,
    totalRows: sync.totalRows || 0,
    lastErrorCode: sync.lastErrorCode || null,
    page: paginatedRows.paginated ? paginatedRows.page : null,
    limit: paginatedRows.paginated ? paginatedRows.limit : null,
  });

  if (customersResponseCache?.key === cacheKey) {
    return customersResponseCache.json;
  }

  const json = JSON.stringify({
    rows: paginatedRows.items,
    sync,
    ...(paginatedRows.paginated
      ? {
          page: paginatedRows.page,
          limit: paginatedRows.limit,
          total: paginatedRows.total,
          hasMore: paginatedRows.hasMore,
        }
      : {}),
  });
  customersResponseCache = { key: cacheKey, json };
  return json;
};

export const handleCustomerReadRoutes = async (req, res, url, deps = {}) => {
  if (!req || !res || !url) return false;

  const {
    getPublicCustomerSyncState,
    readStore,
    sendJson,
    sendJsonText,
  } = deps;

  if (
    typeof getPublicCustomerSyncState !== 'function' ||
    typeof readStore !== 'function' ||
    typeof sendJson !== 'function' ||
    typeof sendJsonText !== 'function'
  ) {
    throw new Error('Customer read route dependencies are incomplete.');
  }

  if (req.method === 'GET' && url.pathname === '/api/local/customers') {
    const store = await readStore();
    sendJsonText(res, 200, buildCustomersResponseJson(
      store,
      getOptionalPaginationFromSearchParams(url.searchParams, { defaultLimit: 50, maxLimit: 200 }),
      getPublicCustomerSyncState,
    ), {
      'Cache-Control': 'private, max-age=30',
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/local/customers/sync') {
    const store = await readStore();
    sendJson(res, 200, getPublicCustomerSyncState(store.customerSync));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/local/customers/logs') {
    const store = await readStore();
    const limit = Number.parseInt(url.searchParams.get('limit') || '', 10);
    const logs = Number.isFinite(limit) && limit > 0 ? store.customerSyncLogs.slice(0, limit) : store.customerSyncLogs;
    sendJson(res, 200, {
      logs,
      sync: getPublicCustomerSyncState(store.customerSync),
    });
    return true;
  }

  return false;
};
