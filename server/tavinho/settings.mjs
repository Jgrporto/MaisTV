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

export const DEFAULT_TAVINHO_PLAN_TABLE = [
  { screens: 1, months: { 1: 22, 2: 32, 3: 42 } },
  { screens: 2, months: { 1: 32, 2: 52, 3: 72 } },
  { screens: 3, months: { 1: 42, 2: 72, 3: 102 } },
];

export const DEFAULT_TAVINHO_PARTIAL_PRICES = [
  { screens: 1, pricePerDay: 0.73, officialGross29Days: 21.27 },
  { screens: 2, pricePerDay: 1.07, officialGross29Days: 30.93 },
  { screens: 3, pricePerDay: 1.4, officialGross29Days: 40.6 },
];

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
  planTable: DEFAULT_TAVINHO_PLAN_TABLE,
  partialPrices: DEFAULT_TAVINHO_PARTIAL_PRICES,
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

const cleanText = (value, fallback = '', maxLength = 12000) => {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maxLength);
};

const cleanTextArray = (value, fallback = []) => {
  if (Array.isArray(value)) {
    const items = value.map((item) => cleanText(item, '', 240)).filter(Boolean);
    return items.length ? items : fallback;
  }

  const text = cleanText(value, '', 2400);
  if (!text) return fallback;
  return text.split(/\r?\n/).map((item) => cleanText(item, '', 240)).filter(Boolean);
};

const cleanMoney = (value, fallback = 0) => {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) && number >= 0 ? Number(number.toFixed(2)) : fallback;
};

const normalizePlanTable = (value) => {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_TAVINHO_PLAN_TABLE;
  const normalized = source
    .map((item, index) => {
      const screens = Math.max(1, Number.parseInt(String(item?.screens ?? index + 1), 10) || index + 1);
      const months = item?.months && typeof item.months === 'object' ? item.months : {};
      const fallback = DEFAULT_TAVINHO_PLAN_TABLE.find((plan) => plan.screens === screens)?.months || {};
      return {
        screens,
        months: {
          1: cleanMoney(months[1] ?? months['1'] ?? months['1_mes'], fallback[1] ?? 0),
          2: cleanMoney(months[2] ?? months['2'] ?? months['2_meses'], fallback[2] ?? 0),
          3: cleanMoney(months[3] ?? months['3'] ?? months['3_meses'], fallback[3] ?? 0),
        },
      };
    })
    .filter((item) => item.screens > 0)
    .sort((left, right) => left.screens - right.screens);

  return normalized.length ? normalized : DEFAULT_TAVINHO_PLAN_TABLE;
};

const normalizePartialPrices = (value) => {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_TAVINHO_PARTIAL_PRICES;
  const normalized = source
    .map((item, index) => {
      const screens = Math.max(1, Number.parseInt(String(item?.screens ?? index + 1), 10) || index + 1);
      const fallback = DEFAULT_TAVINHO_PARTIAL_PRICES.find((price) => price.screens === screens) || {};
      return {
        screens,
        pricePerDay: cleanMoney(item?.pricePerDay ?? item?.preco_por_dia, fallback.pricePerDay ?? 0),
        officialGross29Days: cleanMoney(
          item?.officialGross29Days ?? item?.valor_bruto_29_dias,
          fallback.officialGross29Days ?? 0,
        ),
      };
    })
    .filter((item) => item.screens > 0 && item.pricePerDay > 0)
    .sort((left, right) => left.screens - right.screens);

  return normalized.length ? normalized : DEFAULT_TAVINHO_PARTIAL_PRICES;
};

const normalizeLinks = (value) => {
  const source = Array.isArray(value) ? value : DEFAULT_TAVINHO_SETTINGS.links;
  return source
    .map((item) => ({
      name: cleanText(item?.name || item?.nome, '', 80),
      url: cleanText(item?.url, '', 400),
      description: cleanText(item?.description || item?.descricao, '', 240),
    }))
    .filter((item) => item.name || item.url || item.description)
    .slice(0, 12);
};

export const normalizeTavinhoSettings = (value = {}) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallback = DEFAULT_TAVINHO_SETTINGS;
  return {
    ...fallback,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    assistantName: cleanText(source.assistantName, fallback.assistantName, 80),
    productName: cleanText(source.productName, fallback.productName, 80),
    versionLabel: cleanText(source.versionLabel, fallback.versionLabel, 80),
    basePrompt: cleanText(source.basePrompt, fallback.basePrompt, 16000),
    outOfScopeResponse: cleanText(source.outOfScopeResponse, fallback.outOfScopeResponse, 800),
    allowedScopes: cleanTextArray(source.allowedScopes, fallback.allowedScopes),
    planTable: normalizePlanTable(source.planTable),
    partialPrices: normalizePartialPrices(source.partialPrices),
    appsText: cleanText(source.appsText, fallback.appsText, 6000),
    supportText: cleanText(source.supportText, fallback.supportText, 6000),
    proceduresText: cleanText(source.proceduresText, fallback.proceduresText, 6000),
    links: normalizeLinks(source.links),
    dataAccess: {
      ...DEFAULT_TAVINHO_DATA_ACCESS,
      ...(source.dataAccess && typeof source.dataAccess === 'object' ? source.dataAccess : {}),
    },
    updatedAt: cleanText(source.updatedAt, '', 80) || null,
  };
};

export const formatTavinhoPlansForPrompt = (planTable = DEFAULT_TAVINHO_PLAN_TABLE) =>
  normalizePlanTable(planTable)
    .map((plan) => {
      const icon = '\u{1F4FA}'.repeat(plan.screens);
      const telaLabel = plan.screens === 1 ? 'TELA' : 'TELAS';
      return `${icon} ${plan.screens} ${telaLabel}

1 m\u00eas: R$ ${plan.months[1]}
2 meses: R$ ${plan.months[2]}
3 meses: R$ ${plan.months[3]}`;
    })
    .join('\n\n\n');

export const buildKnowledgeBaseFromTavinhoSettings = (settingsValue = {}, fallbackKnowledgeBase = {}) => {
  const settings = normalizeTavinhoSettings(settingsValue);
  const planTable = normalizePlanTable(settings.planTable);
  const partialPrices = normalizePartialPrices(settings.partialPrices);

  return {
    ...fallbackKnowledgeBase,
    produto: {
      ...(fallbackKnowledgeBase.produto && typeof fallbackKnowledgeBase.produto === 'object' ? fallbackKnowledgeBase.produto : {}),
      nome: settings.productName,
      copiloto: settings.assistantName,
      descricao: `Copiloto interno da ${settings.productName} para ajudar o time com informacoes cadastradas em Configuracoes.`,
      versao_base: settings.versionLabel,
      observacao: 'As informacoes desta base sao editaveis em Configuracoes > Tavinho.',
    },
    escopo_permitido: settings.allowedScopes,
    resposta_padrao_fora_do_escopo: settings.outOfScopeResponse,
    tabela_planos_2026: {
      moeda: 'BRL',
      formato_de_resposta_obrigatorio: formatTavinhoPlansForPrompt(planTable),
      observacao_importante:
        'Use a tabela cadastrada como fonte principal. Quando perguntarem pela tabela de planos, responda exatamente no formato_de_resposta_obrigatorio.',
      regras_gerais: {
        cada_mes_adicional: '+ R$ 10 por tela',
        cada_tela_adicional: '+ R$ 10 no valor do primeiro mes',
        formula_primeiro_mes: 'R$ 22 + R$ 10 x (quantidade_de_telas - 1)',
        formula_mes_adicional: 'R$ 10 x quantidade_de_telas',
        formula_meses_cheios: 'valor_primeiro_mes + (meses - 1) x valor_mes_adicional',
      },
      planos_fechados: planTable.map((plan) => ({
        telas: plan.screens,
        valores: {
          '1_mes': `R$ ${plan.months[1]}`,
          '2_meses': `R$ ${plan.months[2]}`,
          '3_meses': `R$ ${plan.months[3]}`,
        },
      })),
      valores_por_tela_e_meses: Object.fromEntries(
        planTable.map((plan) => [
          `${plan.screens}_${plan.screens === 1 ? 'tela' : 'telas'}`,
          {
            '1_mes': plan.months[1],
            '2_meses': plan.months[2],
            '3_meses': plan.months[3],
          },
        ]),
      ),
    },
    calculo_planos_parciais: {
      descricao:
        'Para planos parciais, calcular pelo preco por dia conforme a quantidade de telas. O valor bruto e preco_por_dia x quantidade_de_dias.',
      regra_de_resposta:
        'Sempre informe o valor bruto proporcional e o valor final cobrado arredondado para cima para o proximo real inteiro. Use teto/ceil. Nunca use centavos como valor final cobrado em plano parcial.',
      precos_por_dia: partialPrices.map((item) => ({
        telas: item.screens,
        preco_por_dia: item.pricePerDay,
        valor_bruto_29_dias: item.officialGross29Days,
      })),
      formula_para_outras_quantidades_de_dias:
        'valor_bruto = preco_por_dia x quantidade_de_dias; valor_final = teto(valor_bruto) para o proximo real inteiro',
    },
    aplicativos_por_dispositivo_texto: settings.appsText,
    suporte_basico_texto: settings.supportText,
    procedimentos_atendimento_texto: settings.proceduresText,
    links: settings.links.map((link) => ({
      nome: link.name,
      url: link.url,
      descricao: link.description,
    })),
  };
};
