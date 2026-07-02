const truncate = (value, max) => String(value || '').trim().slice(0, max);

export const buildInteractivePayload = (message = {}) => {
  const raw = message.raw_json && typeof message.raw_json === 'object' ? message.raw_json : {};
  const output = raw.interactivePayload && typeof raw.interactivePayload === 'object'
    ? raw.interactivePayload
    : raw.chatbotOutput && typeof raw.chatbotOutput === 'object' ? raw.chatbotOutput : raw;
  const text = truncate(output.text || message.body || 'Selecione uma opcao:', 1024);
  const options = Array.isArray(output.options) ? output.options : [];
  const displayAs = String(output.displayAs || '').trim().toLowerCase();
  const footer = truncate(output.footer || '', 60);

  if (displayAs !== 'list' && options.length <= 3) {
    const interactive = {
      type: 'button',
      body: { text },
      action: {
        buttons: options.slice(0, 3).map((option, index) => ({
          type: 'reply',
          reply: {
            id: truncate(option.id || option.targetNodeId || `option-${index + 1}`, 256),
            title: truncate(option.title || `Opcao ${index + 1}`, 20),
          },
        })),
      },
    };
    if (footer) interactive.footer = { text: footer };
    return { type: 'interactive', interactive };
  }

  const interactive = {
    type: 'list',
    body: { text },
    action: {
      button: truncate(output.buttonText || 'MENU', 20),
      sections: [{
        title: truncate(output.sectionTitle || 'Opcoes', 24),
        rows: options.slice(0, 10).map((option, index) => ({
          id: truncate(option.id || option.targetNodeId || `option-${index + 1}`, 200),
          title: truncate(option.title || `Opcao ${index + 1}`, 24),
          description: truncate(option.description || '', 72) || undefined,
        })),
      }],
    },
  };
  if (footer) interactive.footer = { text: footer };
  return { type: 'interactive', interactive };
};
