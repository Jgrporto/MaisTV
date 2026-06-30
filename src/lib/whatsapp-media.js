const KB = 1024;
const MB = 1024 * KB;

const DOCUMENT_MIME_TYPES = [
  'text/plain',
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const AUDIO_MIME_TYPES = [
  'audio/aac',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/amr',
  'audio/ogg',
];

const VIDEO_MIME_TYPES = ['video/mp4', 'video/3gpp', 'video/3gp'];
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const STICKER_MIME_TYPES = ['image/webp'];

export const WHATSAPP_MEDIA_SPECS = {
  image: {
    kind: 'image',
    label: 'Imagem',
    mimeTypes: IMAGE_MIME_TYPES,
    extensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
    maxBytes: 5 * MB,
    previewMode: 'image',
  },
  audio: {
    kind: 'audio',
    label: 'Audio',
    mimeTypes: AUDIO_MIME_TYPES,
    extensions: ['.aac', '.amr', '.mp3', '.m4a', '.ogg'],
    maxBytes: 16 * MB,
    previewMode: 'audio',
  },
  sticker: {
    kind: 'sticker',
    label: 'Figurinha',
    mimeTypes: STICKER_MIME_TYPES,
    extensions: ['.webp'],
    maxBytes: 500 * KB,
    staticMaxBytes: 100 * KB,
    previewMode: 'image',
  },
  document: {
    kind: 'document',
    label: 'Documento',
    mimeTypes: DOCUMENT_MIME_TYPES,
    extensions: ['.txt', '.xls', '.xlsx', '.doc', '.docx', '.ppt', '.pptx', '.pdf'],
    maxBytes: 100 * MB,
    previewMode: 'document',
  },
  video: {
    kind: 'video',
    label: 'Video',
    mimeTypes: VIDEO_MIME_TYPES,
    extensions: ['.mp4', '.3gp'],
    maxBytes: 16 * MB,
    previewMode: 'video',
  },
};

const buildPreferredKindMap = (readValues) => {
  const map = new Map();

  Object.values(WHATSAPP_MEDIA_SPECS).forEach((spec) => {
    readValues(spec).forEach((value) => {
      if (!map.has(value)) {
        map.set(value, spec.kind);
      }
    });
  });

  return map;
};

const MIME_TYPE_TO_KIND = buildPreferredKindMap((spec) => spec.mimeTypes);
const EXTENSION_TO_KIND = buildPreferredKindMap((spec) => spec.extensions);

const getFileExtension = (fileName) => {
  const safeName = String(fileName || '').trim().toLowerCase();
  const dotIndex = safeName.lastIndexOf('.');
  return dotIndex >= 0 ? safeName.slice(dotIndex) : '';
};

const fileSignatureIncludes = async (file, token) => {
  if (!file || typeof file.arrayBuffer !== 'function') return false;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const signature = Array.from(token).map((char) => char.charCodeAt(0));

    for (let index = 0; index <= bytes.length - signature.length; index += 1) {
      const matches = signature.every((value, offset) => bytes[index + offset] === value);
      if (matches) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
};

export const isAnimatedWebpFile = async (file) => await fileSignatureIncludes(file, 'ANIM');

export const inferWhatsappMediaKind = (fileLike) => {
  const mimeType = String(fileLike?.type || fileLike?.mimeType || '').trim().toLowerCase();
  const extension = getFileExtension(fileLike?.name);

  if (mimeType && MIME_TYPE_TO_KIND.has(mimeType)) {
    return MIME_TYPE_TO_KIND.get(mimeType);
  }

  if (extension && EXTENSION_TO_KIND.has(extension)) {
    return EXTENSION_TO_KIND.get(extension);
  }

  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return null;
};

export const formatMediaBytes = (value) => {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} B`;
};

export const getWhatsappMediaAccept = () =>
  [
    ...IMAGE_MIME_TYPES,
    ...STICKER_MIME_TYPES,
    ...VIDEO_MIME_TYPES,
    ...AUDIO_MIME_TYPES,
    ...DOCUMENT_MIME_TYPES,
    '.txt',
    '.xls',
    '.xlsx',
    '.doc',
    '.docx',
    '.ppt',
    '.pptx',
    '.pdf',
    '.3gp',
  ].join(',');

export const getWhatsappMediaSpec = (kind) => WHATSAPP_MEDIA_SPECS[String(kind || '').trim()] || null;

export const validateWhatsappMediaFile = async (fileLike) => {
  if (!fileLike) {
    return {
      ok: false,
      reason: 'Arquivo invalido.',
      kind: null,
      spec: null,
    };
  }

  const kind = inferWhatsappMediaKind(fileLike);
  const spec = getWhatsappMediaSpec(kind);

  if (!kind || !spec) {
    return {
      ok: false,
      reason: 'Tipo de arquivo nao suportado pela WhatsApp Cloud API.',
      kind: null,
      spec: null,
    };
  }

  const mimeType = String(fileLike.type || '').trim().toLowerCase();
  const extension = getFileExtension(fileLike.name);

  if (
    mimeType &&
    !spec.mimeTypes.includes(mimeType) &&
    !(kind === 'video' && mimeType === 'video/quicktime')
  ) {
    return {
      ok: false,
      reason: `${spec.label} em formato nao suportado pela WhatsApp Cloud API.`,
      kind,
      spec,
    };
  }

  if (!mimeType && extension && !spec.extensions.includes(extension)) {
    return {
      ok: false,
      reason: `${spec.label} em formato nao suportado pela WhatsApp Cloud API.`,
      kind,
      spec,
    };
  }

  if (Number(fileLike.size || 0) > spec.maxBytes) {
    return {
      ok: false,
      reason: `${spec.label} excede o limite de ${formatMediaBytes(spec.maxBytes)} do WhatsApp.`,
      kind,
      spec,
    };
  }

  if (kind === 'sticker') {
    const isAnimated = await isAnimatedWebpFile(fileLike);
    if (!isAnimated && Number(fileLike.size || 0) > spec.staticMaxBytes) {
      return {
        ok: false,
        reason: `Figurinha estatica excede o limite de ${formatMediaBytes(spec.staticMaxBytes)} do WhatsApp.`,
        kind,
        spec,
        isAnimatedSticker: false,
      };
    }

    return {
      ok: true,
      reason: '',
      kind,
      spec,
      isAnimatedSticker: isAnimated,
    };
  }

  return {
    ok: true,
    reason: '',
    kind,
    spec,
  };
};

export const buildComposerMediaItem = async (file, source = 'picker') => {
  const validation = await validateWhatsappMediaFile(file);
  const kind = validation.kind;
  const spec = validation.spec;

  if (!validation.ok || !kind || !spec) {
    return {
      id: `composer-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      source,
      kind: kind || 'unknown',
      mimeType: String(file?.type || '').trim().toLowerCase(),
      name: String(file?.name || 'arquivo'),
      size: Number(file?.size || 0),
      objectUrl: '',
      canSend: false,
      validation,
      caption: '',
      hd: false,
      viewOnce: false,
      editor: null,
    };
  }

  return {
    id: `composer-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    source,
    kind,
    mimeType: String(file?.type || '').trim().toLowerCase(),
    name: String(file?.name || 'arquivo'),
    size: Number(file?.size || 0),
    objectUrl: URL.createObjectURL(file),
    canSend: true,
    validation,
    caption: '',
    hd: false,
    viewOnce: false,
    editor:
      kind === 'image'
        ? {
            rotation: 0,
            filter: 'none',
            aspectRatio: 'original',
            zoom: 1,
            offsetX: 0,
            offsetY: 0,
            drawPaths: [],
            drawColor: '#ffffff',
            drawWidth: 4,
            text: '',
            textColor: '#ffffff',
            textSize: 36,
            textX: 0.5,
            textY: 0.86,
          }
        : null,
  };
};

export const revokeComposerMediaItems = (items = []) => {
  items.forEach((item) => {
    if (item?.objectUrl) {
      URL.revokeObjectURL(item.objectUrl);
    }
  });
};

export const resolveAttachmentKind = (attachment) => {
  const explicitType = String(attachment?.type || '').trim().toLowerCase();
  const mimeType = String(attachment?.mimeType || '').trim().toLowerCase();
  const fileName = String(attachment?.name || '').trim().toLowerCase();

  if (explicitType === 'sticker') return 'sticker';
  if (explicitType && WHATSAPP_MEDIA_SPECS[explicitType]) return explicitType;
  return inferWhatsappMediaKind({
    type: mimeType,
    name: fileName,
  });
};

export const isLightboxAttachment = (attachment) => {
  const kind = resolveAttachmentKind(attachment);
  return kind === 'image' || kind === 'video' || kind === 'sticker';
};

export const getAttachmentDisplayLabel = (attachment) => {
  const kind = resolveAttachmentKind(attachment);
  return getWhatsappMediaSpec(kind)?.label || 'Arquivo';
};
