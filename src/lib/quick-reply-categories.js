import { requestLocalApi } from '@/lib/local-api';

export const DEFAULT_QUICK_REPLY_CATEGORIES = [
  { id: 'cat-apps', name: 'Aplicativos', color: '#38bdf8', icon: 'app', sortOrder: 10, visibleInQuickReplies: true },
  { id: 'cat-tests', name: 'Testes', color: '#a78bfa', icon: 'test', sortOrder: 20, visibleInQuickReplies: true },
  { id: 'cat-payment', name: 'Pagamento', color: '#22c55e', icon: 'payment', sortOrder: 30, visibleInQuickReplies: true },
  { id: 'cat-none', name: 'Sem Categoria', color: '#94a3b8', icon: 'folder', sortOrder: 999, visibleInQuickReplies: true },
];

const requestLocalEntity = async (entityName, { method = 'GET', id = '', body, searchParams } = {}) => {
  const params = new URLSearchParams(searchParams || {});
  const query = params.toString();
  const target = `/entities/${entityName}${id ? `/${id}` : ''}${query ? `?${query}` : ''}`;
  const response = await requestLocalApi(target, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Falha ao acessar ${entityName}.`);
  }

  return payload;
};

export const normalizeQuickReplyCategory = (category = {}, index = 0) => ({
  id: String(category.id || `quick-reply-category-${index}-${Date.now()}`),
  name: String(category.name || '').trim(),
  color: String(category.color || '#38bdf8').trim(),
  icon: String(category.icon || 'folder').trim(),
  sortOrder: Number.isFinite(Number(category.sortOrder)) ? Number(category.sortOrder) : index,
  visibleInQuickReplies: category.visibleInQuickReplies !== false,
  created_date: String(category.created_date || category.createdAt || new Date().toISOString()),
  updated_date: String(category.updated_date || category.updatedAt || ''),
});

export const listQuickReplyCategories = async () => {
  const data = await requestLocalEntity('QuickReplyCategory', {
    method: 'GET',
    searchParams: { sortBy: 'sortOrder' },
  });
  const items = Array.isArray(data) ? data : [];

  return items
    .map((item, index) => normalizeQuickReplyCategory(item, index))
    .filter((item) => item.name)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'pt-BR'));
};

export const saveQuickReplyCategory = async (payload, existingId = null) => {
  const currentCategories = existingId ? [] : await listQuickReplyCategories().catch(() => []);
  const nextSortOrder =
    payload?.sortOrder != null
      ? payload.sortOrder
      : currentCategories.length > 0
        ? Math.max(...currentCategories.map((category) => Number(category.sortOrder) || 0)) + 10
        : 10;
  const category = normalizeQuickReplyCategory(
    {
      ...payload,
      id: existingId || payload?.id || `quick-reply-category-${Date.now()}`,
      sortOrder: nextSortOrder,
    },
    0
  );

  const response = await requestLocalEntity('QuickReplyCategory', {
    method: existingId ? 'PUT' : 'POST',
    id: existingId || '',
    body: category,
  });

  return normalizeQuickReplyCategory(response, 0);
};

export const deleteQuickReplyCategory = async (id) => {
  await requestLocalEntity('QuickReplyCategory', {
    method: 'DELETE',
    id,
  });
  return true;
};

export const saveQuickReplyCategoriesOrder = async (categories = []) => {
  const safeCategories = Array.isArray(categories) ? categories : [];
  const ordered = safeCategories.map((category, index) =>
    normalizeQuickReplyCategory(
      {
        ...category,
        sortOrder: (index + 1) * 10,
      },
      index
    )
  );

  await Promise.all(
    ordered
      .filter((category) => category.id && category.id !== 'cat-none')
      .map(async (category) => {
        try {
          return await requestLocalEntity('QuickReplyCategory', {
            method: 'PUT',
            id: category.id,
            body: category,
          });
        } catch {
          return await requestLocalEntity('QuickReplyCategory', {
            method: 'POST',
            body: category,
          });
        }
      })
  );

  return ordered;
};
