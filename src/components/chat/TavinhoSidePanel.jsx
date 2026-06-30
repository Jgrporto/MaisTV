import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  PanelRightClose,
  Plus,
  Send,
  X,
} from 'lucide-react';
import { requestLocalApiJson } from '@/lib/local-api';
import './TavinhoSidePanel.css';

const HISTORY_STORAGE_KEY = 'saastv:tavinho:conversation-history:v1';


const initialMessages = [];

function TavinhoLogo({ size = 'md' }) {
  return (
    <span className={`tavinho-logo tavinho-logo--${size}`} aria-label="+TV">
      <span className="tavinho-logo__plus">+</span>
      <span className="tavinho-logo__text">TV</span>
    </span>
  );
}

function createConversationId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `tavinho-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cloneInitialMessages() {
  return initialMessages.map((message) => ({ ...message }));
}

function loadStoredHistory() {
  if (typeof window === 'undefined') return [];

  try {
    const stored = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!stored) return [];

    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getConversationTitle(messages) {
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content;
  if (!firstUserMessage) return 'Nova conversa';

  return firstUserMessage.length > 44 ? `${firstUserMessage.slice(0, 44)}...` : firstUserMessage;
}

function formatHistoryDate(dateLike) {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(dateLike));
  } catch {
    return '';
  }
}

function getMessageText(message) {
  const content = String(message?.content || '').trim();
  if (content) return content;
  const type = String(message?.message_type || '').toLowerCase();
  if (type === 'audio') return '[Áudio]';
  if (type === 'image') return '[Imagem]';
  if (type === 'video') return '[Vídeo]';
  if (type === 'document') return '[Documento]';
  return '';
}

function MessageBubble({ message, onUseSuggestion }) {
  const isUser = message.role === 'user';

  return (
    <div className={`tv-message ${isUser ? 'tv-message--user' : 'tv-message--assistant'}`}>
      {!isUser && <div className="tv-message__avatar">+</div>}
      <div className="tv-message__content">
        {message.content}
        {!isUser && message.canUseSuggestion ? (
          <button className="tv-use-suggestion" type="button" onClick={() => onUseSuggestion?.(message.content)}>
            Usar no campo de mensagem
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function TavinhoSidePanel({
  open,
  onClose,
  conversation,
  messages: conversationMessages = [],
  isWithin24hWindow = false,
  checkoutRenewalAlert = null,
  onUseSuggestion,
}) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState(() => cloneInitialMessages());
  const [conversationId, setConversationId] = useState(() => createConversationId());
  const [conversationHistory, setConversationHistory] = useState(() => loadStoredHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const bodyRef = useRef(null);
  const messagesEndRef = useRef(null);

  const hasConversation = messages.length > 0;
  const panelClassName = useMemo(
    () => `tv-copilot ${open ? 'tv-copilot--open' : ''}`,
    [open],
  );

  const requestContext = useMemo(
    () => ({
      conversation,
      customerName: conversation?.contact_name || '',
      customerPhone: conversation?.contact_phone || conversation?.phone || '',
      labels: Array.isArray(conversation?.visible_labels) ? conversation.visible_labels : [],
      isWithin24hWindow,
      checkoutAlert: checkoutRenewalAlert?.message || '',
      messages: conversationMessages.slice(-12).map((message) => ({
        sender_type: message?.sender_type || '',
        content: getMessageText(message),
        message_type: message?.message_type || '',
        created_date: message?.created_date || message?.timestamp || '',
      })),
    }),
    [checkoutRenewalAlert?.message, conversation, conversationMessages, isWithin24hWindow],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(conversationHistory));
    } catch {
      // Histórico local opcional. Se o navegador bloquear storage, o chat continua funcionando.
    }
  }, [conversationHistory]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!hasConversation) return;
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      if (bodyRef.current) {
        bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
      }
    });
  }, [hasConversation, loading, messages]);

  function saveConversation(nextMessages, nextConversationId = conversationId) {
    const hasUserMessage = nextMessages.some((message) => message.role === 'user');
    if (!hasUserMessage) return;

    const now = new Date().toISOString();
    const nextItem = {
      id: nextConversationId,
      title: getConversationTitle(nextMessages),
      updatedAt: now,
      messages: nextMessages,
    };

    setConversationHistory((currentHistory) => {
      const filteredHistory = currentHistory.filter((item) => item.id !== nextConversationId);
      return [nextItem, ...filteredHistory].slice(0, 30);
    });
  }

  async function submitQuestion(value = input) {
    const message = value.trim();
    if (!message || loading) return;

    const nextMessages = [...messages, { role: 'user', content: message }];
    setMessages(nextMessages);
    saveConversation(nextMessages);
    setInput('');
    setError('');
    setLoading(true);

    try {
      const data = await requestLocalApiJson(
        '/tavinho/message',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            history: messages.map(({ role, content }) => ({ role, content })),
            context: requestContext,
          }),
          timeoutMs: 60_000,
        },
        'Não foi possível falar com o Tavinho.',
      );

      const answeredMessages = [
        ...nextMessages,
        {
          role: 'assistant',
          content: data?.answer || 'Não consegui gerar uma resposta agora. Tente reformular a pergunta.',
          canUseSuggestion: true,
        },
      ];
      setMessages(answeredMessages);
      saveConversation(answeredMessages);
    } catch (requestError) {
      setError(requestError.message);
      const failedMessages = [
        ...nextMessages,
        {
          role: 'assistant',
          content:
            requestError?.message?.includes('OPENAI_API_KEY')
              ? 'A chave da OpenAI ainda não foi configurada no backend. Configure OPENAI_API_KEY para ativar o Tavinho.'
              : 'Não consegui acessar minha base agora. Verifique a API do Tavinho e tente novamente.',
        },
      ];
      setMessages(failedMessages);
      saveConversation(failedMessages);
    } finally {
      setLoading(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function resetChat() {
    setMessages(cloneInitialMessages());
    setConversationId(createConversationId());
    setInput('');
    setError('');
    setHistoryOpen(false);
  }

  function openHistoryConversation(item) {
    setMessages(item.messages?.length ? item.messages : cloneInitialMessages());
    setConversationId(item.id);
    setInput('');
    setError('');
    setHistoryOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitQuestion();
    }
  }

  return (
    <aside className={panelClassName} aria-hidden={!open}>
      <div className="tv-copilot__header">
        <button
          className="tv-icon-button"
          type="button"
          aria-label="Abrir histórico de conversas"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((current) => !current)}
        >
          <PanelRightClose size={22} />
        </button>

        <TavinhoLogo size="lg" />

        <button className="tv-icon-button" type="button" aria-label="Fechar Tavinho" onClick={onClose}>
          <X size={28} />
        </button>
      </div>

      <div
        className={`tv-history-backdrop ${historyOpen ? 'tv-history-backdrop--open' : ''}`}
        aria-hidden="true"
        onClick={() => setHistoryOpen(false)}
      />

      <aside className={`tv-history ${historyOpen ? 'tv-history--open' : ''}`} aria-hidden={!historyOpen}>
        <div className="tv-history__header">
          <div>
            <strong>Histórico</strong>
            <small>Conversas recentes com o Tavinho</small>
          </div>
          <button className="tv-icon-button tv-icon-button--compact" type="button" aria-label="Fechar histórico" onClick={() => setHistoryOpen(false)}>
            <X size={20} />
          </button>
        </div>

        <button className="tv-history__new" type="button" onClick={resetChat}>
          <Plus size={17} />
          Novo chat
        </button>

        <div className="tv-history__list">
          {conversationHistory.length === 0 ? (
            <div className="tv-history__empty">Suas conversas com o Tavinho aparecerão aqui.</div>
          ) : (
            conversationHistory.map((item) => (
              <button
                type="button"
                className={`tv-history__item ${item.id === conversationId ? 'tv-history__item--active' : ''}`}
                key={item.id}
                onClick={() => openHistoryConversation(item)}
              >
                <strong>{item.title}</strong>
                <small>{formatHistoryDate(item.updatedAt)}</small>
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="tv-copilot__body" ref={bodyRef}>
        <div className="tv-ambient" aria-hidden="true" />

        {!hasConversation ? (
          <section className="tv-home">
            <h1>Como posso lhe ajudar?</h1>

            <form className="tv-prompt-box" onSubmit={(event) => { event.preventDefault(); submitQuestion(); }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Pergunte sobre o sistema, planos, suporte ou atendimento..."
                rows={3}
              />
              <div className="tv-prompt-box__actions">
                <button className="tv-send-button" type="submit" aria-label="Enviar pergunta" disabled={loading}>
                  {loading ? <Loader2 className="tv-spin" size={24} /> : <Send size={24} />}
                </button>
              </div>
            </form>

          </section>
        ) : (
          <section className="tv-chat-mode">
            <div className="tv-messages">
              {messages.map((message, index) => (
                <MessageBubble
                  key={`${message.role}-${index}-${message.content.slice(0, 8)}`}
                  message={message}
                  onUseSuggestion={onUseSuggestion}
                />
              ))}
              {loading && (
                <div className="tv-message tv-message--assistant">
                  <div className="tv-message__avatar">+</div>
                  <div className="tv-message__content tv-message__content--loading">
                    <Loader2 className="tv-spin" size={18} /> Consultando a base do Tavinho...
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {error && <div className="tv-error">{error}</div>}

            <form className="tv-chat-input" onSubmit={(event) => { event.preventDefault(); submitQuestion(); }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Pergunte ao Tavinho..."
                rows={1}
              />
              <button className="tv-send-button" type="submit" disabled={loading} aria-label="Enviar">
                {loading ? <Loader2 className="tv-spin" size={20} /> : <Send size={20} />}
              </button>
            </form>
          </section>
        )}
      </div>

      <footer className="tv-copilot__footer">
        <span>✦</span>
        <span>Tavinho · Copiloto da <TavinhoLogo size="sm" /></span>
        <span>✦</span>
      </footer>
    </aside>
  );
}
