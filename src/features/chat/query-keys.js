export const chatQueryKeys = {
  all: ['chat'],
  conversations: () => ['chat', 'conversations'],
  conversationPages: (filters = {}) => ['chat', 'conversations', filters],
  messages: (conversationId) => ['chat', 'messages', String(conversationId || '')],
};
