export const getOptionalPaginationFromSearchParams = (searchParams, defaults = {}) => {
  const rawLimit = searchParams?.get?.('limit');
  if (rawLimit == null || rawLimit === '') return null;

  const defaultLimit = Number.parseInt(String(defaults.defaultLimit || '50'), 10);
  const maxLimit = Number.parseInt(String(defaults.maxLimit || '200'), 10);
  const parsedPage = Number.parseInt(String(searchParams.get('page') || '1'), 10);
  const parsedLimit = Number.parseInt(String(rawLimit), 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const limitBase = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : defaultLimit;
  const normalizedMaxLimit = Number.isFinite(maxLimit) && maxLimit > 0 ? maxLimit : 200;
  const limit = Math.min(Math.max(limitBase, 1), normalizedMaxLimit);

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
};

export const paginateItems = (items = [], pagination = null) => {
  const rows = Array.isArray(items) ? items : [];
  if (!pagination) {
    return {
      items: rows,
      page: 1,
      limit: rows.length,
      total: rows.length,
      hasMore: false,
      paginated: false,
    };
  }

  return {
    items: rows.slice(pagination.offset, pagination.offset + pagination.limit),
    page: pagination.page,
    limit: pagination.limit,
    total: rows.length,
    hasMore: pagination.offset + pagination.limit < rows.length,
    paginated: true,
  };
};
