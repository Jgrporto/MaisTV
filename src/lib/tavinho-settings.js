import { requestLocalApiJson } from '@/lib/local-api';

export const DEFAULT_TAVINHO_DATA_ACCESS = {
  customerProfile: true,
  planAndDueDate: true,
  labelsAndService: true,
  recentMessages: true,
  checkoutStatus: true,
  loginCredentials: false,
  playlistLinks: false,
  internalNotes: false,
};

export const DEFAULT_TAVINHO_SETTINGS = {
  enabled: true,
  assistantName: 'Tavinho',
  productName: '+TV',
  versionLabel: 'Tabela 2026',
  basePrompt: '',
  outOfScopeResponse:
    'Eu consigo te ajudar apenas com informacoes da +TV que estao na minha base. Nao encontrei essa informacao por aqui.',
  allowedScopes: [
    'planos e valores da tabela 2026 da +TV',
    'quantidade de telas e meses',
    'calculo de mes adicional',
    'calculo de tela adicional',
    'calculo de planos parciais por quantidade de dias',
    'aplicativos recomendados por dispositivo',
    'renovacao e checkout',
    'suporte basico de acesso',
    'procedimentos de atendimento',
    'duvidas sobre a propria plataforma +TV',
  ],
  planTable: [
    { screens: 1, months: { 1: 22, 2: 32, 3: 42 } },
    { screens: 2, months: { 1: 32, 2: 52, 3: 72 } },
    { screens: 3, months: { 1: 42, 2: 72, 3: 102 } },
  ],
  partialPrices: [
    { screens: 1, pricePerDay: 0.73, officialGross29Days: 21.27 },
    { screens: 2, pricePerDay: 1.07, officialGross29Days: 30.93 },
    { screens: 3, pricePerDay: 1.4, officialGross29Days: 40.6 },
  ],
  appsText:
    'Android: FACILITA24 e IBOREVENDA.\niPhone/iOS: BLESSED PLAYER.\nTV Android/TV Box: IBOREVENDA.\nSmart TVs em geral: FUN PLAY, PLAYSIM, ASSIST PLUS e LAZER PLAY.',
  supportText:
    'Cliente sem acesso: confirmar se o plano esta ativo, validar usuario/telefone/codigo, pedir para fechar e abrir o app, testar outra internet e encaminhar ao suporte tecnico se persistir.\nTravamentos: verificar se ocorre em todos os canais, reiniciar modem/app/equipamento, validar internet e registrar canal/horario.\nLogin invalido: conferir usuario e senha, remover espacos, confirmar plano ativo e solicitar conferencia interna se continuar.',
  proceduresText:
    'Seja direto, cordial e operacional. Nunca invente valor, prazo, desconto ou politica. Quando nao houver informacao cadastrada, oriente consultar a Wiki ou supervisor.',
  links: [
    { name: 'Wiki +TV', url: 'CONFIGURAR_URL_WIKI', description: 'Documentacao interna da operacao.' },
    { name: 'Novidades da versao 1.19', url: 'CONFIGURAR_URL_CHANGELOG', description: 'Pagina ou modal com novidades da versao.' },
  ],
  dataAccess: DEFAULT_TAVINHO_DATA_ACCESS,
  updatedAt: null,
};

const cleanMoney = (value, fallback = 0) => {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) && number >= 0 ? Number(number.toFixed(2)) : fallback;
};

export const normalizeTavinhoSettings = (value = {}) => {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_TAVINHO_SETTINGS,
    ...source,
    assistantName: String(source.assistantName || DEFAULT_TAVINHO_SETTINGS.assistantName).trim(),
    productName: String(source.productName || DEFAULT_TAVINHO_SETTINGS.productName).trim(),
    versionLabel: String(source.versionLabel || DEFAULT_TAVINHO_SETTINGS.versionLabel).trim(),
    basePrompt: String(source.basePrompt || '').trim(),
    outOfScopeResponse: String(source.outOfScopeResponse || DEFAULT_TAVINHO_SETTINGS.outOfScopeResponse).trim(),
    allowedScopes: Array.isArray(source.allowedScopes)
      ? source.allowedScopes.map((item) => String(item || '').trim()).filter(Boolean)
      : DEFAULT_TAVINHO_SETTINGS.allowedScopes,
    planTable: (Array.isArray(source.planTable) && source.planTable.length ? source.planTable : DEFAULT_TAVINHO_SETTINGS.planTable).map((plan, index) => ({
      screens: Math.max(1, Number.parseInt(String(plan?.screens ?? index + 1), 10) || index + 1),
      months: {
        1: cleanMoney(plan?.months?.[1] ?? plan?.months?.['1'], DEFAULT_TAVINHO_SETTINGS.planTable[index]?.months?.[1] || 0),
        2: cleanMoney(plan?.months?.[2] ?? plan?.months?.['2'], DEFAULT_TAVINHO_SETTINGS.planTable[index]?.months?.[2] || 0),
        3: cleanMoney(plan?.months?.[3] ?? plan?.months?.['3'], DEFAULT_TAVINHO_SETTINGS.planTable[index]?.months?.[3] || 0),
      },
    })),
    partialPrices: (Array.isArray(source.partialPrices) && source.partialPrices.length
      ? source.partialPrices
      : DEFAULT_TAVINHO_SETTINGS.partialPrices
    ).map((price, index) => ({
      screens: Math.max(1, Number.parseInt(String(price?.screens ?? index + 1), 10) || index + 1),
      pricePerDay: cleanMoney(price?.pricePerDay, DEFAULT_TAVINHO_SETTINGS.partialPrices[index]?.pricePerDay || 0),
      officialGross29Days: cleanMoney(
        price?.officialGross29Days,
        DEFAULT_TAVINHO_SETTINGS.partialPrices[index]?.officialGross29Days || 0,
      ),
    })),
    links: (Array.isArray(source.links) ? source.links : DEFAULT_TAVINHO_SETTINGS.links).map((link) => ({
      name: String(link?.name || '').trim(),
      url: String(link?.url || '').trim(),
      description: String(link?.description || '').trim(),
    })),
    dataAccess: {
      ...DEFAULT_TAVINHO_DATA_ACCESS,
      ...(source.dataAccess && typeof source.dataAccess === 'object' ? source.dataAccess : {}),
    },
    updatedAt: source.updatedAt ? String(source.updatedAt) : null,
  };
};

export const fetchTavinhoSettings = async () =>
  normalizeTavinhoSettings(await requestLocalApiJson('/settings/tavinho', { method: 'GET' }));

export const saveTavinhoSettings = async (value) =>
  normalizeTavinhoSettings(await requestLocalApiJson('/settings/tavinho', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizeTavinhoSettings(value)),
  }));
