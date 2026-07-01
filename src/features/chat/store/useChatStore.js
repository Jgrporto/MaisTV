import { create } from 'zustand';

const resolveUpdate = (update, current) => (typeof update === 'function' ? update(current) : update);

export const useChatStore = create((set) => ({
  selectedConversation: null,
  filters: {
    searchTerm: '',
    primary: 'all',
    service: 'all',
    label: 'all',
  },
  isAtBottom: true,
  newMessageCount: 0,
  sseStatus: 'idle',
  sidePanel: null,
  preferences: {},
  recentConversationIds: [],

  setSelectedConversation: (update) => set((state) => {
    const selectedConversation = resolveUpdate(update, state.selectedConversation) || null;
    const selectedId = String(selectedConversation?.id || '').trim();
    const recentConversationIds = selectedId
      ? [selectedId, ...state.recentConversationIds.filter((id) => id !== selectedId)].slice(0, 10)
      : state.recentConversationIds;
    return { selectedConversation, recentConversationIds, newMessageCount: 0, isAtBottom: true };
  }),
  setFilter: (name, value) => set((state) => ({
    filters: { ...state.filters, [name]: resolveUpdate(value, state.filters[name]) },
  })),
  setIsAtBottom: (isAtBottom) => set((state) => {
    const nextIsAtBottom = Boolean(isAtBottom);
    const nextMessageCount = nextIsAtBottom ? 0 : state.newMessageCount;
    if (state.isAtBottom === nextIsAtBottom && state.newMessageCount === nextMessageCount) return state;
    return { isAtBottom: nextIsAtBottom, newMessageCount: nextMessageCount };
  }),
  incrementNewMessageCount: () => set((state) => ({ newMessageCount: state.newMessageCount + 1 })),
  clearNewMessageCount: () => set({ newMessageCount: 0 }),
  setSseStatus: (sseStatus) => set((state) => state.sseStatus === sseStatus ? state : { sseStatus }),
  setSidePanel: (update) => set((state) => ({ sidePanel: resolveUpdate(update, state.sidePanel) || null })),
  setPreference: (name, value) => set((state) => ({
    preferences: { ...state.preferences, [name]: resolveUpdate(value, state.preferences[name]) },
  })),
}));
