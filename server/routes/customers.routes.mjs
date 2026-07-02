import { getOptionalPaginationFromSearchParams, paginateItems } from '../middlewares/pagination.mjs';
import { shapeCustomerDetail, shapeCustomerListItem } from '../services/customer-summary.service.mjs';

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

  if (customersResponseCache?.customers !== allRows) {
    customersResponseCache = { customers: allRows, responses: new Map() };
  }
  if (customersResponseCache.responses.has(cacheKey)) {
    return customersResponseCache.responses.get(cacheKey);
  }

  const json = JSON.stringify({
    rows: paginatedRows.items.map(shapeCustomerListItem),
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
  customersResponseCache.responses.set(cacheKey, json);
  while (customersResponseCache.responses.size > 50) {
    customersResponseCache.responses.delete(customersResponseCache.responses.keys().next().value);
  }
  return json;
};

export const handleCustomerReadRoutes = async (req, res, url, deps = {}) => {
  if (!req || !res || !url) return false;

  const {
    getPublicCustomerSyncState,
    readStore,
    sendJson,
    sendJsonText,
    warnLargeResponse,
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
    const pagination = getOptionalPaginationFromSearchParams(url.searchParams, { defaultLimit: 50, maxLimit: 200 }) || {
      page: 1,
      limit: 50,
      offset: 0,
    };
    const json = buildCustomersResponseJson(
      store,
      pagination,
      getPublicCustomerSyncState,
    );
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > 1024 * 1024 && typeof warnLargeResponse === 'function') {
      warnLargeResponse({ method: req.method, path: url.pathname, bytes });
    }
    sendJsonText(res, 200, json, {
      'Cache-Control': 'private, max-age=30',
    });
    return true;
  }

  const customerDetailMatch = url.pathname.match(/^\/api\/local\/customers\/([^/]+)$/);
  if (req.method === 'GET' && customerDetailMatch && !['sync', 'logs'].includes(customerDetailMatch[1])) {
    const store = await readStore();
    const customerId = decodeURIComponent(customerDetailMatch[1] || '');
    const customer = (Array.isArray(store.customers) ? store.customers : [])
      .find((item) => String(item?.id || '') === customerId);
    if (!customer) {
      sendJson(res, 404, { error: 'customer_not_found' });
      return true;
    }
    sendJson(res, 200, shapeCustomerDetail(customer), { 'Cache-Control': 'private, no-store' });
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
