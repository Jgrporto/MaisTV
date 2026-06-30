export function normalizeEntityCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const candidates = [
    payload.items,
    payload.rows,
    payload.data,
    payload.results,
    payload.list,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  if (payload.data && typeof payload.data === 'object') {
    const nestedCandidates = [
      payload.data.items,
      payload.data.rows,
      payload.data.results,
      payload.data.list,
    ];

    for (const candidate of nestedCandidates) {
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
  }

  return [];
}
