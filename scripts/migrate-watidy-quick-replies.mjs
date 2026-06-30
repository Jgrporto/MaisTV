import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CryptoJS from 'crypto-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORE_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'store.json');
const DEFAULT_CATEGORY_COLOR = '#38bdf8';
const FALLBACK_CATEGORY_NAME = 'Importadas';
const IMPORT_SOURCE = 'watidy_backup';
const MEDIA_SIZE_WARNING_BYTES = 15 * 1024 * 1024;

const fieldsToDecrypt = ['respostasRapidas', 'categoria', 'respostasRapidasAcao', 'guardaMsg', 'medias'];
const knownVariables = ['nome', 'telefone', 'periodo-dia', 'protocolo', 'atendente', 'saudacao', 'data', 'hora'];

const actionCounters = {
  text: 0,
  image: 0,
  video: 0,
  audio: 0,
  document: 0,
  ura: 0,
  wait: 0,
  utility: 0,
  unsupported: 0,
};

const parseArgs = (argv) => {
  const args = {
    backupPath: '',
    dryRun: false,
    inspect: false,
    writeDecrypted: false,
    update: false,
    onlyText: false,
    limit: 0,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--inspect') args.inspect = true;
    else if (arg === '--write-decrypted') args.writeDecrypted = true;
    else if (arg === '--update') args.update = true;
    else if (arg === '--only-text') args.onlyText = true;
    else if (arg.startsWith('--limit=')) args.limit = Math.max(0, Number.parseInt(arg.slice('--limit='.length), 10) || 0);
    else if (!args.backupPath) args.backupPath = arg;
  }

  if (!args.backupPath) {
    throw new Error('Informe o caminho do backup JSON.');
  }

  return args;
};

const nowIso = () => new Date().toISOString();
const createId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const clampDelay = (value) => Math.max(0, Math.min(300, Number.isFinite(Number(value)) ? Number(value) : 0));
const normalizeSpaces = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const stripSimpleMarkdown = (value) => normalizeSpaces(value).replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1');
const asArray = (value) => (Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []);
const getString = (value) => (value == null ? '' : String(value).trim());

const parseMaybeJson = (value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!['{', '['].includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const decryptData = (value) => {
  if (typeof value !== 'string') return value;

  const key = process.env.WATIDY_CRIPT_KEY;
  if (!key) {
    throw new Error('Variável WATIDY_CRIPT_KEY não definida.');
  }

  const decrypted = CryptoJS.AES.decrypt(value, key).toString(CryptoJS.enc.Utf8);
  if (!decrypted) {
    throw new Error('Falha ao descriptografar campo. Verifique a chave ou o conteúdo.');
  }

  return JSON.parse(decrypted);
};

const decryptBackupFields = (backup) => {
  const decrypted = {};
  const fieldLogs = [];
  const errors = [];

  for (const field of fieldsToDecrypt) {
    if (!(field in backup)) {
      fieldLogs.push({ field, status: 'ausente' });
      decrypted[field] = [];
      continue;
    }

    const value = backup[field];
    if (typeof value !== 'string') {
      decrypted[field] = value;
      fieldLogs.push({ field, status: 'aberto' });
      continue;
    }

    try {
      decrypted[field] = decryptData(value);
      fieldLogs.push({ field, status: 'descriptografado' });
    } catch (error) {
      const parsed = parseMaybeJson(value);
      if (parsed !== value) {
        decrypted[field] = parsed;
        fieldLogs.push({ field, status: 'json_aberto' });
        continue;
      }
      decrypted[field] = [];
      errors.push({ field, reason: error.message });
      fieldLogs.push({ field, status: 'erro' });
    }
  }

  if (asArray(decrypted.respostasRapidas).length === 0 && asArray(decrypted.guardaMsg).length === 0) {
    throw new Error('Backup sem respostasRapidas e guardaMsg utilizáveis após descriptografia.');
  }

  return { decrypted, fieldLogs, errors };
};

const getRecordId = (record) =>
  getString(record?.id || record?._id || record?.uuid || record?.key || record?.codigo || record?.code || record?.externalId);

const pickFirstString = (record, fields) => {
  for (const field of fields) {
    const value = getString(record?.[field]);
    if (value) return value;
  }
  return '';
};

const normalizeImportedVariables = (text) => {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(/(^|[^\w{])#([a-zA-Z0-9-]+)/g, (match, prefix, variable) => {
    const safeVariable = String(variable || '').toLowerCase();
    if (!knownVariables.includes(safeVariable)) return match;
    return `${prefix}{#${safeVariable}}`;
  });
};

const normalizeTitle = (candidate, fallbackIndex) => {
  let title = stripSimpleMarkdown(candidate);
  const installMatch = title.match(/vamos baixar o aplicativo chamado\s+(.+)$/i);
  if (installMatch?.[1]) {
    title = `Instalar - ${stripSimpleMarkdown(installMatch[1])}`;
  }
  title = title.replace(/^["']|["']$/g, '').trim();
  if (!title) title = `Resposta importada ${String(fallbackIndex + 1).padStart(2, '0')}`;
  return title.slice(0, 60).trim();
};

const uniqueTitle = (title, usedTitles) => {
  const base = title || 'Resposta importada';
  let nextTitle = base;
  let copyIndex = 1;

  while (usedTitles.has(nextTitle.toLowerCase())) {
    nextTitle = `${base} (${copyIndex === 1 ? 'cópia' : `cópia ${copyIndex}`})`;
    copyIndex += 1;
  }

  usedTitles.add(nextTitle.toLowerCase());
  return nextTitle;
};

const safeHexColor = (value) => {
  const color = getString(value);
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '';
};

const buildCategorySources = (categoriasRaw, respostasRaw) => {
  const categorySources = [];
  const knownCategoryIds = new Set();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  asArray(categoriasRaw).forEach((category, index) => {
    const name = pickFirstString(category, ['name', 'nome', 'title', 'titulo', 'label', 'categoria']);
    if (!name) return;
    const sourceId = getRecordId(category) || `watidy-category-${index + 1}`;
    knownCategoryIds.add(sourceId.toLowerCase());
    categorySources.push({
      id: sourceId,
      name,
      color: safeHexColor(category?.hexColor || category?.color || category?.cor),
      icon: getString(category?.icon || category?.icone) || 'folder',
      sortOrder: Number.isFinite(Number(category?.sortOrder || category?.ordem)) ? Number(category?.sortOrder || category?.ordem) : index,
    });
  });

  asArray(respostasRaw).forEach((reply) => {
    const name = getString(reply?.category || reply?.categoria || reply?.categoriaNome || reply?.nomeCategoria);
    if (!name) return;
    const normalizedName = name.toLowerCase();
    if (knownCategoryIds.has(normalizedName) || uuidPattern.test(name)) return;
    categorySources.push({
      id: getString(reply?.categoryId || reply?.categoriaId || reply?.idCategoria) || name,
      name,
      color: '',
      icon: 'folder',
      sortOrder: 500,
    });
  });

  categorySources.push({
    id: 'watidy-importadas',
    name: FALLBACK_CATEGORY_NAME,
    color: DEFAULT_CATEGORY_COLOR,
    icon: 'layer-group',
    sortOrder: 900,
  });

  return categorySources;
};

const normalizeMimeFromDataUrl = (dataUrl, fallback = 'application/octet-stream') => {
  const match = String(dataUrl || '').match(/^data:([^;,]+)[;,]/i);
  return match?.[1] || fallback;
};

const extensionFromMime = (mimeType, fallback = 'bin') => {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('pdf')) return 'pdf';
  return fallback;
};

const ensureDataUrl = (value, fallbackMime = 'application/octet-stream') => {
  const raw = getString(value);
  if (!raw) return '';
  if (raw.startsWith('data:')) return raw;
  if (raw.length > 200 && /^[a-zA-Z0-9+/=\r\n]+$/.test(raw)) {
    return `data:${fallbackMime};base64,${raw.replace(/\s/g, '')}`;
  }
  return raw;
};

const getApproxDataUrlSize = (dataUrl) => {
  const raw = String(dataUrl || '');
  const base64 = raw.includes(',') ? raw.split(',').pop() : raw;
  return Math.round((base64.length * 3) / 4);
};

const findMediaPayload = (record) => {
  const props = record?.propriedades && typeof record.propriedades === 'object' ? record.propriedades : {};
  return (
    record?.base64 ||
    record?.dataUrl ||
    record?.midia ||
    record?.media ||
    record?.file ||
    record?.arquivo ||
    props.base64 ||
    props.dataUrl ||
    props.midia ||
    props.media ||
    props.file ||
    props.arquivo ||
    ''
  );
};

const resolveMediaForAction = (action, medias, actionIndex, kind) => {
  const props = action?.propriedades && typeof action.propriedades === 'object' ? action.propriedades : {};
  const directPayload = findMediaPayload(action);
  const identifiers = [
    getRecordId(action),
    getString(action?.mediaId || action?.midiaId || action?.idMedia || action?.fileId),
    getString(props.mediaId || props.midiaId || props.idMedia || props.fileId || props.id),
  ].filter(Boolean);

  let mediaRecord = null;
  if (!directPayload && identifiers.length > 0) {
    mediaRecord = asArray(medias).find((media) => {
      const mediaIds = [
        getRecordId(media),
        getString(media?.mediaId || media?.midiaId || media?.idMedia || media?.fileId),
        getString(media?.actionId || media?.acaoId || media?.idAcao),
      ].filter(Boolean);
      return mediaIds.some((id) => identifiers.includes(id));
    });
  }

  if (!directPayload && !mediaRecord && asArray(medias).length === 1) {
    mediaRecord = asArray(medias)[0];
  }

  const payload = directPayload || findMediaPayload(mediaRecord);
  if (!payload) return null;

  const fallbackMime =
    kind === 'image'
      ? 'image/png'
      : kind === 'video'
        ? 'video/mp4'
        : kind === 'audio'
          ? 'audio/ogg'
          : 'application/octet-stream';
  const dataUrl = ensureDataUrl(payload, getString(action?.mimeType || props.mimeType || mediaRecord?.mimeType) || fallbackMime);
  const mimeType = normalizeMimeFromDataUrl(dataUrl, getString(action?.mimeType || props.mimeType || mediaRecord?.mimeType) || fallbackMime);
  const extension = extensionFromMime(mimeType, kind === 'document' ? 'bin' : kind);
  const fileName =
    getString(action?.fileName || action?.filename || props.fileName || props.filename || mediaRecord?.fileName || mediaRecord?.filename) ||
    `${kind}-importado-${actionIndex + 1}.${extension}`;
  const sizeBytes = getApproxDataUrlSize(dataUrl);

  return {
    media: { dataUrl, fileName, mimeType, kind },
    sizeBytes,
    oversized: sizeBytes > MEDIA_SIZE_WARNING_BYTES,
  };
};

const extractActionArray = (group) => {
  if (Array.isArray(group)) return group;
  if (!group || typeof group !== 'object') return [];
  for (const field of ['acao', 'acoes', 'actions', 'action', 'itens', 'items', 'mensagens', 'messages']) {
    if (Array.isArray(group[field])) return group[field];
  }
  if (group.type || group.tipo) return [group];
  return [];
};

const flattenUraOptions = (props = {}) => {
  const options = [];
  const sections = Array.isArray(props.sections) ? props.sections : [];
  const rows = Array.isArray(props.rows) ? props.rows : [];

  sections.forEach((section) => {
    asArray(section?.rows || section?.options).forEach((row, index) => {
      const label = pickFirstString(row, ['title', 'label', 'name', 'nome', 'text']);
      if (!label) return;
      options.push({
        id: getRecordId(row) || `ura-option-${options.length + 1}`,
        label,
        value: getString(row?.value || row?.id || row?.rowId) || label,
        description: getString(row?.description || row?.descricao),
      });
    });
  });

  rows.forEach((row) => {
    const label = pickFirstString(row, ['title', 'label', 'name', 'nome', 'text']);
    if (!label) return;
    options.push({
      id: getRecordId(row) || `ura-option-${options.length + 1}`,
      label,
      value: getString(row?.value || row?.id || row?.rowId) || label,
      description: getString(row?.description || row?.descricao),
    });
  });

  return options.slice(0, 10);
};

const buildAction = (rawAction, actionIndex, medias) => {
  const props = rawAction?.propriedades && typeof rawAction.propriedades === 'object' ? rawAction.propriedades : {};
  const originalType = getString(rawAction?.type || rawAction?.tipo || rawAction?.actionType || rawAction?.acao).toLowerCase();
  const actionId = getRecordId(rawAction) || `watidy-action-${actionIndex + 1}`;
  const composing = clampDelay(props.composing ?? props.typingDelaySeconds ?? rawAction?.composing);
  const aguarde = clampDelay(props.aguarde ?? props.delay ?? props.nextActionDelaySeconds ?? rawAction?.aguarde);
  const mensagem = normalizeImportedVariables(getString(props.mensagem || props.message || rawAction?.mensagem || rawAction?.message || rawAction?.content));
  const caption = normalizeImportedVariables(getString(props.caption || props.legenda || rawAction?.caption || rawAction?.legenda || mensagem));

  const metadata = {
    originalType,
    originalActionId: actionId,
  };

  const textTypes = ['txt', 'text', 'message', 'mensagem'];
  const imageTypes = ['image', 'img', 'imagem'];
  const videoTypes = ['video', 'vídeo'];
  const audioTypes = ['audio', 'áudio', 'voice'];
  const documentTypes = ['document', 'file', 'arquivo', 'documento'];
  const waitTypes = ['timer', 'delay', 'wait', 'aguarde', 'espera'];

  if (textTypes.includes(originalType)) {
    actionCounters.text += 1;
    return {
      id: createId('action'),
      type: 'text',
      title: 'Criar Mensagem de Texto',
      content: mensagem,
      caption: '',
      media: null,
      typingDelaySeconds: composing,
      nextActionDelaySeconds: aguarde,
      metadata,
    };
  }

  if ([...imageTypes, ...videoTypes, ...audioTypes, ...documentTypes].includes(originalType)) {
    const kind = imageTypes.includes(originalType)
      ? 'image'
      : videoTypes.includes(originalType)
        ? 'video'
        : audioTypes.includes(originalType)
          ? 'audio'
          : 'document';
    const resolvedMedia = resolveMediaForAction(rawAction, medias, actionIndex, kind);
    actionCounters[kind] += 1;
    return {
      id: createId('action'),
      type: kind,
      title:
        kind === 'image'
          ? 'Criar Mensagem de Imagem'
          : kind === 'video'
            ? 'Criar Mensagem de Vídeo'
            : kind === 'audio'
              ? 'Criar Mensagem de Áudio'
              : 'Criar Mensagem de Documento',
      content: '',
      caption,
      media: resolvedMedia?.media || { dataUrl: '', fileName: '', mimeType: '', kind },
      displayOnce: false,
      typingDelaySeconds: composing,
      nextActionDelaySeconds: aguarde,
      metadata: {
        ...metadata,
        mediaImportWarning: resolvedMedia?.oversized ? `Mídia acima de ${MEDIA_SIZE_WARNING_BYTES} bytes.` : '',
      },
    };
  }

  if (originalType === 'list' || originalType === 'lista' || originalType === 'ura') {
    const options = flattenUraOptions(props);
    actionCounters.ura += 1;
    return {
      id: createId('action'),
      type: 'ura',
      title: 'Criar URA',
      content: normalizeImportedVariables(getString(props.description || props.descricao || mensagem)),
      caption: '',
      typingDelaySeconds: composing,
      nextActionDelaySeconds: aguarde,
      metadata: {
        ...metadata,
        originalPayload: sanitizeForPrint(rawAction),
        listTitle: normalizeImportedVariables(getString(props.title || props.titulo || props.buttonText)) || 'Escolha uma opção',
        description: normalizeImportedVariables(getString(props.description || props.descricao)),
        buttonText: normalizeImportedVariables(getString(props.buttonText)) || 'Selecionar',
        footer: normalizeImportedVariables(getString(props.footer || props.rodape)),
        uraOptions: options.map((option) => ({
          id: option.id,
          label: normalizeImportedVariables(option.label),
          value: normalizeImportedVariables(option.value || option.label),
          description: normalizeImportedVariables(option.description || ''),
        })),
      },
      ura: {
        title: normalizeImportedVariables(getString(props.title || props.titulo || props.buttonText)) || 'Escolha uma opção',
        description: normalizeImportedVariables(getString(props.description || props.descricao)),
        buttonText: normalizeImportedVariables(getString(props.buttonText)) || 'Selecionar',
        footer: normalizeImportedVariables(getString(props.footer || props.rodape)),
        options,
      },
    };
  }

  if (waitTypes.includes(originalType)) {
    const waitSeconds = clampDelay(props.segundos ?? props.seconds ?? props.aguarde ?? rawAction?.seconds ?? aguarde);
    actionCounters.wait += 1;
    return {
      id: createId('action'),
      type: 'wait',
      title: 'Espera',
      waitSeconds,
      typingDelaySeconds: 0,
      nextActionDelaySeconds: waitSeconds,
      metadata,
    };
  }

  if (['addlabel', 'add_label', 'addLabel'.toLowerCase(), 'removealllabel', 'remove_all_label', 'removeAllLabel'.toLowerCase()].includes(originalType)) {
    actionCounters.utility += 1;
    return {
      id: createId('action'),
      type: 'utility',
      title: originalType.includes('remove') ? 'Remover etiquetas' : 'Adicionar etiqueta',
      content: '',
      caption: '',
      typingDelaySeconds: 0,
      nextActionDelaySeconds: aguarde,
      metadata: {
        ...metadata,
        labelID: getString(props.labelID || props.labelId || rawAction?.labelID || rawAction?.labelId),
        executable: false,
      },
    };
  }

  actionCounters.unsupported += 1;
  return {
    id: createId('action'),
    type: 'unsupported',
    title: 'Ação importada não suportada',
    content: mensagem,
    caption,
    typingDelaySeconds: composing,
    nextActionDelaySeconds: aguarde,
    metadata: {
      ...metadata,
      originalPayload: sanitizeForPrint(rawAction),
    },
  };
};

const getActionGroupId = (group) =>
  getString(
    group?.quickReplyId ||
      group?.respostaRapidaId ||
      group?.idRespostaRapida ||
      group?.resposta_rapida_id ||
      group?.quick_reply_id ||
      group?.id
  );

const findActionGroup = (reply, actionGroups, index) => {
  const replyIds = [
    getRecordId(reply),
    getString(reply?.quickReplyId || reply?.respostaRapidaId || reply?.idRespostaRapida),
  ].filter(Boolean);

  for (const group of actionGroups) {
    const groupIds = [
      getRecordId(group),
      getString(group?.quickReplyId || group?.respostaRapidaId || group?.idRespostaRapida || group?.resposta_rapida_id || group?.quick_reply_id),
    ].filter(Boolean);
    if (replyIds.some((id) => groupIds.includes(id))) {
      const byField = group?.quickReplyId || group?.respostaRapidaId || group?.idRespostaRapida || group?.resposta_rapida_id || group?.quick_reply_id;
      return { group, strategy: byField ? 'matched_by_quickReplyId' : 'matched_by_id' };
    }
  }

  if (actionGroups[index]) {
    return { group: actionGroups[index], strategy: 'matched_by_position' };
  }

  return { group: null, strategy: 'none' };
};

const firstUsefulText = (actions) => {
  const action = actions.find((item) => item?.content || item?.caption || item?.metadata?.description || item?.metadata?.listTitle);
  return getString(action?.content || action?.caption || action?.metadata?.description || action?.metadata?.listTitle);
};

const chooseTitle = (reply, guardaRecord, actions, index) => {
  const fromReply = pickFirstString(reply, ['nome', 'title', 'titulo', 'name', 'label', 'resposta', 'shortcut', 'atalho']);
  const fromGuarda = pickFirstString(guardaRecord, ['nome', 'title', 'titulo', 'name', 'label', 'resposta', 'shortcut', 'atalho']);
  const fromAction = firstUsefulText(actions);
  return normalizeTitle(fromReply || fromGuarda || fromAction, index);
};

const getReplyCategoryRef = (reply) =>
  getString(reply?.categoryId || reply?.categoriaId || reply?.idCategoria || reply?.category || reply?.categoria || reply?.categoriaNome);

const buildImportedQuickReplies = ({ respostasRapidas, respostasRapidasAcao, guardaMsg, medias, categorias, existingCategoryMap }) => {
  const replies = asArray(respostasRapidas);
  const guarda = asArray(guardaMsg);
  const actionGroups = asArray(respostasRapidasAcao);
  const usedActionGroups = new Set();
  const usedTitles = new Set();
  const imported = [];
  const logs = [];
  const categoryByRef = new Map();

  categorias.forEach((category) => {
    categoryByRef.set(String(category.sourceId || category.id).toLowerCase(), category);
    categoryByRef.set(String(category.name).toLowerCase(), category);
  });

  const findCategory = (reply) => {
    const ref = getReplyCategoryRef(reply).toLowerCase();
    return categoryByRef.get(ref) || existingCategoryMap.get(ref) || existingCategoryMap.get(FALLBACK_CATEGORY_NAME.toLowerCase());
  };

  replies.forEach((reply, index) => {
    const { group, strategy } = findActionGroup(reply, actionGroups, index);
    if (group) usedActionGroups.add(group);

    const rawActions = extractActionArray(group).length > 0 ? extractActionArray(group) : extractActionArray(reply);
    const actions = rawActions.map((action, actionIndex) => buildAction(action, actionIndex, medias)).filter(Boolean);
    const guardaRecord = guarda.find((item) => getRecordId(item) && getRecordId(item) === getRecordId(reply)) || guarda[index] || null;
    const category = findCategory(reply);
    const title = uniqueTitle(chooseTitle(reply, guardaRecord, actions, index), usedTitles);
    const content = normalizeImportedVariables(getString(reply?.content || reply?.mensagem || reply?.resposta || firstUsefulText(actions)));
    const externalId = getRecordId(reply) || getActionGroupId(group) || `watidy-position-${index + 1}`;

    imported.push({
      id: createId('quickreply'),
      title,
      content,
      shortcut: getString(reply?.shortcut || reply?.atalho) || `/${title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)}`,
      category: category?.name || FALLBACK_CATEGORY_NAME,
      categoryId: category?.id || '',
      type: actions[0]?.type || 'text',
      usageCount: 0,
      importedFrom: IMPORT_SOURCE,
      externalId,
      importStrategy: strategy,
      actions,
      created_date: nowIso(),
      updated_date: nowIso(),
    });
    logs.push({ externalId, title, strategy, actions: actions.length });
  });

  actionGroups.forEach((group, index) => {
    if (usedActionGroups.has(group)) return;
    const rawActions = extractActionArray(group);
    if (rawActions.length === 0) return;
    const actions = rawActions.map((action, actionIndex) => buildAction(action, actionIndex, medias)).filter(Boolean);
    const category = existingCategoryMap.get(FALLBACK_CATEGORY_NAME.toLowerCase());
    const title = uniqueTitle(normalizeTitle(firstUsefulText(actions), imported.length), usedTitles);
    const externalId = getActionGroupId(group) || `watidy-actions-${index + 1}`;

    imported.push({
      id: createId('quickreply'),
      title,
      content: normalizeImportedVariables(firstUsefulText(actions)),
      shortcut: `/${title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)}`,
      category: category?.name || FALLBACK_CATEGORY_NAME,
      categoryId: category?.id || '',
      type: actions[0]?.type || 'text',
      usageCount: 0,
      importedFrom: IMPORT_SOURCE,
      externalId,
      importStrategy: 'actions_only',
      actions,
      created_date: nowIso(),
      updated_date: nowIso(),
    });
    logs.push({ externalId, title, strategy: 'actions_only', actions: actions.length });
  });

  return { imported, logs };
};

const sanitizeForPrint = (value, depth = 0) => {
  if (depth > 4) return '[objeto omitido]';
  if (typeof value === 'string') {
    if (value.startsWith('data:') || (value.length > 500 && /^[a-zA-Z0-9+/=\r\n]+$/.test(value))) {
      const mime = normalizeMimeFromDataUrl(value, 'base64');
      const size = Math.round(getApproxDataUrlSize(value) / 1024);
      return `[base64 omitido - ${mime} - ${size}kb]`;
    }
    return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => sanitizeForPrint(item, depth + 1));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 20)
      .map(([key, item]) => [key, sanitizeForPrint(item, depth + 1)])
  );
};

const describeField = (name, value) => {
  if (Array.isArray(value)) return `${name}: array com ${value.length} itens`;
  if (value && typeof value === 'object') return `${name}: objeto com ${Object.keys(value).length} chaves`;
  if (value == null || value === '') return `${name}: vazio`;
  return `${name}: ${typeof value}`;
};

const readJsonFile = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

const readStore = async () => {
  try {
    const store = await readJsonFile(STORE_PATH);
    return {
      ...store,
      quickReplies: Array.isArray(store.quickReplies) ? store.quickReplies : [],
      quickReplyCategories: Array.isArray(store.quickReplyCategories) ? store.quickReplyCategories : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { quickReplies: [], quickReplyCategories: [] };
    }
    throw error;
  }
};

const writeStore = async (store) => {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tempPath = `${STORE_PATH}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tempPath, STORE_PATH);
};

const prepareCategories = (store, categorySources) => {
  const categoryMap = new Map();
  const created = [];
  const now = nowIso();

  store.quickReplyCategories.forEach((category) => {
    if (!category?.name) return;
    categoryMap.set(String(category.name).toLowerCase(), category);
    if (category.id) categoryMap.set(String(category.id).toLowerCase(), category);
    if (category.sourceId) categoryMap.set(String(category.sourceId).toLowerCase(), category);
  });

  categorySources.forEach((source, index) => {
    const name = normalizeSpaces(source.name);
    if (!name) return;
    const key = name.toLowerCase();
    if (categoryMap.has(key)) {
      const existing = categoryMap.get(key);
      if (source.id) categoryMap.set(String(source.id).toLowerCase(), existing);
      return;
    }

    const category = {
      id: `quick-reply-category-${name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || index}-${Date.now().toString(36)}`,
      name,
      color: source.color || DEFAULT_CATEGORY_COLOR,
      icon: source.icon || 'folder',
      sortOrder: Number.isFinite(Number(source.sortOrder)) ? Number(source.sortOrder) : 500 + index,
      sourceId: source.id,
      importedFrom: IMPORT_SOURCE,
      created_date: now,
      updated_date: now,
    };
    categoryMap.set(key, category);
    categoryMap.set(String(category.id).toLowerCase(), category);
    if (source.id) categoryMap.set(String(source.id).toLowerCase(), category);
    created.push(category);
  });

  return { categoryMap, created };
};

const findDuplicate = (existingReplies, reply) =>
  existingReplies.find(
    (item) =>
      String(item?.importedFrom || '') === IMPORT_SOURCE &&
      String(item?.externalId || '') &&
      String(item.externalId) === String(reply.externalId)
  ) ||
  existingReplies.find(
    (item) =>
      String(item?.title || '').trim().toLowerCase() === reply.title.toLowerCase() &&
      String(item?.content || '').trim() === String(reply.content || '').trim() &&
      asArray(item?.actions).length === asArray(reply.actions).length
  );

const writeDecryptedBackup = async (decrypted) => {
  const tmpDir = path.join(PROJECT_ROOT, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, 'backup-watidy-decrypted.json');
  await fs.writeFile(target, JSON.stringify(decrypted, null, 2), 'utf8');
  return target;
};

const printInspect = (decrypted, fieldLogs, decryptErrors) => {
  console.log('\n[INSPEÇÃO DO BACKUP]');
  fieldLogs.forEach((log) => console.log(`${log.field}: ${log.status}`));
  if (decryptErrors.length > 0) {
    console.log('\nCampos com erro de descriptografia:');
    decryptErrors.forEach((error) => console.log(`- ${error.field}: ${error.reason}`));
  }
  console.log('');
  fieldsToDecrypt.forEach((field) => console.log(describeField(field, decrypted[field])));

  fieldsToDecrypt.forEach((field) => {
    const sample = Array.isArray(decrypted[field]) ? decrypted[field][0] : decrypted[field];
    if (!sample) return;
    console.log(`\nAmostra ${field}${Array.isArray(decrypted[field]) ? '[0]' : ''}:`);
    console.log(JSON.stringify(sanitizeForPrint(sample), null, 2));
  });
};

const printReport = ({ args, backupPath, decrypted, imported, createdCategories, importedCount, updatedCount, skippedCount, errors }) => {
  const mode = args.dryRun ? 'dry-run' : args.update ? 'update' : 'import';
  console.log('\n[MIGRAÇÃO WATIDY/WASCRIPT - RESPOSTAS RÁPIDAS]\n');
  console.log(`Arquivo: ${backupPath}`);
  console.log(`Modo: ${mode}`);
  console.log(`Respostas encontradas: ${asArray(decrypted.respostasRapidas).length}`);
  console.log(`Categorias encontradas: ${asArray(decrypted.categoria).length}`);
  console.log(`Ações encontradas: ${asArray(decrypted.respostasRapidasAcao).length}`);
  console.log(`Mídias encontradas: ${asArray(decrypted.medias).length}`);
  console.log('\nConvertidas:');
  Object.entries(actionCounters).forEach(([type, count]) => console.log(`- ${type}: ${count}`));
  console.log(`\nImportadas: ${importedCount}`);
  console.log(`Atualizadas: ${updatedCount}`);
  console.log(`Ignoradas por duplicidade: ${skippedCount}`);
  console.log(`Com erro: ${errors.length}`);
  console.log('\nCategorias criadas:');
  if (createdCategories.length === 0) console.log('- nenhuma');
  createdCategories.forEach((category) => console.log(`- ${category.name}`));
  if (errors.length > 0) {
    console.log('\nErros:');
    errors.forEach((error) => console.log(`- ${error.externalId || 'sem-id'}: ${error.reason}`));
  }
  console.log(`\nRespostas convertidas no lote: ${imported.length}`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const backupPath = path.resolve(process.cwd(), args.backupPath);
  const backup = await readJsonFile(backupPath);
  const { decrypted, fieldLogs, errors: decryptErrors } = decryptBackupFields(backup);

  if (args.writeDecrypted) {
    const target = await writeDecryptedBackup(decrypted);
    console.log(`Backup descriptografado gravado em: ${path.relative(PROJECT_ROOT, target)}`);
  }

  if (args.inspect) {
    printInspect(decrypted, fieldLogs, decryptErrors);
    return;
  }

  const store = await readStore();
  const categorySources = buildCategorySources(decrypted.categoria, decrypted.respostasRapidas);
  const { categoryMap, created: createdCategories } = prepareCategories(store, categorySources);
  const categorias = Array.from(categoryMap.values());
  const { imported: converted, logs } = buildImportedQuickReplies({
    respostasRapidas: decrypted.respostasRapidas,
    respostasRapidasAcao: decrypted.respostasRapidasAcao,
    guardaMsg: decrypted.guardaMsg,
    medias: decrypted.medias,
    categorias,
    existingCategoryMap: categoryMap,
  });

  let imported = converted;
  if (args.onlyText) {
    imported = imported.filter((reply) => reply.actions.length > 0 && reply.actions.every((action) => action.type === 'text'));
  }
  if (args.limit > 0) {
    imported = imported.slice(0, args.limit);
  }

  const errors = [...decryptErrors.map((error) => ({ externalId: error.field, reason: error.reason }))];
  let importedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const reply of imported) {
    try {
      const duplicate = findDuplicate(store.quickReplies, reply);
      if (duplicate) {
        if (args.update && duplicate.importedFrom === IMPORT_SOURCE && duplicate.externalId === reply.externalId) {
          Object.assign(duplicate, {
            ...duplicate,
            ...reply,
            id: duplicate.id,
            created_date: duplicate.created_date || reply.created_date,
            updated_date: nowIso(),
          });
          updatedCount += 1;
        } else {
          skippedCount += 1;
        }
        continue;
      }

      store.quickReplies.push(reply);
      importedCount += 1;
    } catch (error) {
      errors.push({ externalId: reply.externalId, reason: error.message });
    }
  }

  if (!args.dryRun) {
    store.quickReplyCategories = [...store.quickReplyCategories, ...createdCategories];
    await writeStore(store);
  }

  if (logs.length > 0) {
    console.log('\nEstratégias de relacionamento:');
    logs.slice(0, 20).forEach((log) => console.log(`- ${log.externalId}: ${log.strategy} (${log.actions} ações)`));
    if (logs.length > 20) console.log(`- ... ${logs.length - 20} itens adicionais omitidos`);
  }

  printReport({
    args,
    backupPath: args.backupPath,
    decrypted,
    imported,
    createdCategories: args.dryRun ? createdCategories : createdCategories,
    importedCount,
    updatedCount,
    skippedCount,
    errors,
  });
};

main().catch((error) => {
  console.error(`\nErro na migração: ${error.message}`);
  process.exitCode = 1;
});
