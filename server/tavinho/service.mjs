import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKnowledgeBaseFromTavinhoSettings, normalizeTavinhoSettings } from './settings.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MODEL = 'gpt-4.1-mini';
const DEFAULT_HISTORY_LIMIT = 8;
const DEFAULT_CONTEXT_MESSAGE_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 45_000;

let cachedPrompt = null;
let cachedKnowledgeBase = null;

const readTextFile = async (filename) => fs.readFile(path.join(__dirname, filename), 'utf8');

const loadPrompt = async () => {
  if (!cachedPrompt || process.env.NODE_ENV !== 'production') {
    cachedPrompt = await readTextFile('tavinho.prompt.md');
  }
  return cachedPrompt;
};

const loadKnowledgeBase = async () => {
  if (!cachedKnowledgeBase || process.env.NODE_ENV !== 'production') {
    const raw = await readTextFile('knowledge-base.json');
    cachedKnowledgeBase = JSON.parse(raw);
  }
  return cachedKnowledgeBase;
};

const sanitizeText = (value, maxLength = 1600) => String(value || '').trim().slice(0, maxLength);

const sanitizeHistory = (history = [], limit = DEFAULT_HISTORY_LIMIT) => {
  if (!Array.isArray(history)) return [];

  return history
    .filter((message) => message && typeof message.content === 'string')
    .slice(-limit)
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: sanitizeText(message.content, 1600),
    }))
    .filter((message) => message.content);
};

const validateMessage = (message) => {
  if (typeof message !== 'string' || !message.trim()) {
    return { ok: false, error: 'Digite uma pergunta para o Tavinho.' };
  }

  if (message.length > 1200) {
    return { ok: false, error: 'Sua pergunta esta muito longa. Envie uma duvida mais objetiva.' };
  }

  return { ok: true, message: message.trim() };
};

const getMessageText = (message) => {
  const content = sanitizeText(message?.content, 420);
  if (content) return content;

  const type = String(message?.message_type || '').trim().toLowerCase();
  if (type === 'audio') return '[Audio]';
  if (type === 'image') return '[Imagem]';
  if (type === 'video') return '[Video]';
  if (type === 'document') return '[Documento]';
  return '';
};

const sanitizeConversationContext = (context = {}, settingsValue = {}) => {
  const settings = normalizeTavinhoSettings(settingsValue);
  const access = settings.dataAccess || {};
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const recentMessages = access.recentMessages
    ? messages.slice(-DEFAULT_CONTEXT_MESSAGE_LIMIT).map((message) => ({
        sender: sanitizeText(message?.sender_type || message?.sender || 'desconhecido', 40),
        text: getMessageText(message),
        at: sanitizeText(message?.created_date || message?.timestamp || message?.created_at, 60),
      })).filter((message) => message.text)
    : [];

  const conversation = context?.conversation && typeof context.conversation === 'object' ? context.conversation : {};
  const customer = conversation?.customer && typeof conversation.customer === 'object' ? conversation.customer : {};
  const customerProfile = access.customerProfile
    ? {
        customerName: sanitizeText(context?.customerName || conversation?.contact_name || customer?.name, 120),
        customerPhone: sanitizeText(context?.customerPhone || conversation?.contact_phone || customer?.phone, 60),
      }
    : {};
  const planAndDueDate = access.planAndDueDate
    ? {
        customerPlan: sanitizeText(customer?.plan || customer?.plano || customer?.planoAtual || customer?.packageName, 160),
        customerConnections: sanitizeText(customer?.connections ?? customer?.conexoes, 40),
        customerDueDate: sanitizeText(customer?.dueDate || customer?.vencimento || customer?.expirationDate || customer?.expiresAt, 80),
        customerStatus: sanitizeText(customer?.status || customer?.situacao, 80),
      }
    : {};
  const sensitiveFields = {
    ...(access.loginCredentials
      ? {
          customerUser: sanitizeText(customer?.username || customer?.usuario || customer?.user, 160),
          customerPassword: sanitizeText(customer?.password || customer?.senha, 160),
        }
      : {}),
    ...(access.playlistLinks
      ? {
          customerPlaylist: sanitizeText(customer?.playlist || customer?.Playlist || customer?.m3uUrl || customer?.m3u_url, 1000),
        }
      : {}),
    ...(access.internalNotes
      ? {
          customerNotes: sanitizeText(customer?.notes || customer?.notas || customer?.note || conversation?.notes, 1000),
        }
      : {}),
  };

  return {
    ...customerProfile,
    ...planAndDueDate,
    ...sensitiveFields,
    isWithin24hWindow: Boolean(context?.isWithin24hWindow),
    checkoutAlert: access.checkoutStatus ? sanitizeText(context?.checkoutAlert || context?.checkoutRenewalAlert?.message, 420) : '',
    labels: access.labelsAndService && Array.isArray(context?.labels)
      ? context.labels.map((label) => sanitizeText(label?.name || label?.label || label, 80)).filter(Boolean).slice(0, 10)
      : [],
    service: access.labelsAndService ? sanitizeText(conversation?.sector || conversation?.department || customer?.service, 120) : '',
    recentMessages,
  };
};

const buildInstructions = ({ prompt, knowledgeBase, context }) => {
  const contextBlock = {
    observacao:
      'Este contexto ajuda o atendente, mas nao autoriza inventar dados fora da base. Use mensagens recentes apenas para entender o caso.',
    ...context,
  };

  return `${prompt}

---

BASE DE CONHECIMENTO ATUAL DO TAVINHO:
${JSON.stringify(knowledgeBase, null, 2)}

---

CONTEXTO DO ATENDIMENTO ATUAL:
${JSON.stringify(contextBlock, null, 2)}

---

Lembre-se: use somente a base acima para valores, regras e procedimentos. Se nao estiver nela, diga que nao encontrou na base.`;
};

const buildResponseInput = ({ history, message }) => {
  const messages = history.map((item) => ({
    role: item.role,
    content: item.content,
  }));

  messages.push({ role: 'user', content: message });
  return messages;
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const extractResponseText = (data = {}) => {
  const outputText = sanitizeText(data?.output_text, 4000);
  if (outputText) return outputText;

  const chunks = [];

  const visit = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      const text = sanitizeText(value, 4000);
      if (text) chunks.push(text);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;

    if (value.type === 'output_text' || value.type === 'text') {
      visit(value.text || value.value || value.content);
      return;
    }

    visit(value.content);
    visit(value.text);
    visit(value.value);
  };

  visit(data?.output);
  return sanitizeText(chunks.join('\n').trim(), 4000);
};

export const getTavinhoKnowledgeSummary = async ({ settings } = {}) => {
  const fallbackKnowledgeBase = await loadKnowledgeBase();
  const normalizedSettings = normalizeTavinhoSettings(settings);
  const knowledgeBase = buildKnowledgeBaseFromTavinhoSettings(normalizedSettings, fallbackKnowledgeBase);
  return {
    ok: true,
    produto: knowledgeBase.produto,
    escopo_permitido: knowledgeBase.escopo_permitido,
    links: knowledgeBase.links,
    settings: {
      enabled: normalizedSettings.enabled,
      assistantName: normalizedSettings.assistantName,
      productName: normalizedSettings.productName,
      updatedAt: normalizedSettings.updatedAt,
    },
  };
};

export const askTavinho = async (payload = {}) => {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY nao configurada no backend.');
    error.status = 500;
    throw error;
  }

  const validation = validateMessage(payload?.message);
  if (!validation.ok) {
    const error = new Error(validation.error);
    error.status = 400;
    throw error;
  }

  const historyLimit = Number.parseInt(process.env.TAVINHO_HISTORY_LIMIT || `${DEFAULT_HISTORY_LIMIT}`, 10);
  const history = sanitizeHistory(payload?.history, Number.isFinite(historyLimit) ? historyLimit : DEFAULT_HISTORY_LIMIT);
  const settings = normalizeTavinhoSettings(payload?.tavinhoSettings);
  if (!settings.enabled) {
    const error = new Error('Tavinho esta desativado nas configuracoes.');
    error.status = 503;
    throw error;
  }
  const context = sanitizeConversationContext(payload?.context, settings);
  const [fallbackPrompt, fallbackKnowledgeBase] = await Promise.all([loadPrompt(), loadKnowledgeBase()]);
  const prompt = settings.basePrompt || fallbackPrompt;
  const knowledgeBase = buildKnowledgeBaseFromTavinhoSettings(settings, fallbackKnowledgeBase);
  const model = String(process.env.TAVINHO_OPENAI_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL).trim();
  const timeoutMs = Number.parseInt(process.env.TAVINHO_OPENAI_TIMEOUT_MS || `${DEFAULT_TIMEOUT_MS}`, 10);

  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions: buildInstructions({ prompt, knowledgeBase, context }),
        input: buildResponseInput({ history, message: validation.message }),
        max_output_tokens: 550,
      }),
    },
    Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.error ||
      'Tavinho indisponivel no momento. Verifique a API key, o modelo e os logs do backend.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const answer = extractResponseText(data);
  if (!answer) {
    console.warn('[Tavinho API] resposta sem texto', {
      response_id: data?.id || null,
      status: data?.status || null,
      model,
      outputTypes: Array.isArray(data?.output) ? data.output.map((item) => item?.type || null) : [],
    });
  }

  return {
    ok: true,
    answer: answer || 'Nao consegui gerar uma resposta agora. Tente reformular a pergunta.',
    response_id: data?.id || null,
    model,
  };
};
