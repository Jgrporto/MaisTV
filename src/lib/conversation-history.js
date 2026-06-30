const normalizeString = (value) => String(value || '').trim();

const createStableHash = (value) => {
  const source = normalizeString(value);
  let hash = 0;

  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
};

export const buildConversationResolutionSystemMessage = ({ conversationId, type, agentName }) => {
  const createdAt = new Date().toISOString();
  const typeLabel = type === 'lack_of_interaction' ? 'Falta de interação' : 'Resolvido';

  return {
    id: `conversation-resolution-${createStableHash(`${conversationId}|${type}|${createdAt}`)}`,
    message_key: `conversation-resolution-${conversationId}-${createdAt}`,
    server_message_id: '',
    conversation_id: conversationId,
    sender_type: 'system',
    sender_name: 'Sistema',
    message_type: 'system',
    status: 'sent',
    content: `Atendimento encerrado como ${typeLabel}${agentName ? ` por ${agentName}` : ''}.`,
    attachments: [],
    reactions: [],
    created_date: createdAt,
    timestamp: createdAt,
    client_sort_at: createdAt,
    client_order: null,
  };
};
