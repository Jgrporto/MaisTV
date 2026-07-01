import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const DEFAULT_ROOT = '/var/lib/maistv-next/media';
const DEFAULT_INTERNAL_PREFIX = '/protected-media';

const stripTrailingSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

export const getLocalStorageConfig = () => ({
  root: path.resolve(process.env.LOCAL_STORAGE_ROOT || DEFAULT_ROOT),
  internalPrefix: `/${stripTrailingSlash(process.env.LOCAL_STORAGE_INTERNAL_PREFIX || DEFAULT_INTERNAL_PREFIX).replace(/^\/+/, '')}`,
});

export const requireLocalKey = (key) => {
  const normalized = path.posix.normalize(String(key || '').replace(/\\/g, '/').trim().replace(/^\/+/, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('A safe local storage key is required.');
  }
  return normalized;
};

export const getLocalObjectPath = (key, config = getLocalStorageConfig()) => {
  const safeKey = requireLocalKey(key);
  const absolutePath = path.resolve(config.root, ...safeKey.split('/'));
  const rootWithSep = config.root.endsWith(path.sep) ? config.root : `${config.root}${path.sep}`;
  if (!absolutePath.startsWith(rootWithSep)) throw new Error('Local storage path traversal blocked.');
  return { key: safeKey, absolutePath };
};

const metadataPathFor = (absolutePath) => `${absolutePath}.meta.json`;

const readMetadata = async (absolutePath) => {
  try {
    return JSON.parse(await fs.readFile(metadataPathFor(absolutePath), 'utf8'));
  } catch {
    return {};
  }
};

const writeBody = async (absolutePath, body) => {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') {
    await fs.writeFile(absolutePath, body);
    return;
  }
  if (body && typeof body.pipe === 'function') {
    await pipeline(body, await fs.open(absolutePath, 'w').then((handle) => handle.createWriteStream()));
    return;
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    await pipeline(Readable.from(body), await fs.open(absolutePath, 'w').then((handle) => handle.createWriteStream()));
    return;
  }
  throw new Error('Unsupported local storage upload body.');
};

export const putLocalObject = async ({ key, body, contentType, contentDisposition, metadata }) => {
  const { key: safeKey, absolutePath } = getLocalObjectPath(key);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o750 });
  await writeBody(absolutePath, body);
  await fs.writeFile(metadataPathFor(absolutePath), JSON.stringify({
    contentType: contentType || 'application/octet-stream',
    contentDisposition: contentDisposition || '',
    metadata: metadata || {},
    sha256: crypto.createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex'),
    updatedAt: new Date().toISOString(),
  }, null, 2));
  return { key: safeKey, publicUrl: null };
};

export const getLocalObject = async (key) => {
  const { key: safeKey, absolutePath } = getLocalObjectPath(key);
  const [stat, meta] = await Promise.all([fs.stat(absolutePath), readMetadata(absolutePath)]);
  return {
    Key: safeKey,
    Body: createReadStream(absolutePath),
    ContentLength: stat.size,
    ContentType: meta.contentType || 'application/octet-stream',
    ContentDisposition: meta.contentDisposition || undefined,
    Metadata: meta.metadata || {},
  };
};

export const headLocalObject = async (key) => {
  const { key: safeKey, absolutePath } = getLocalObjectPath(key);
  const [stat, meta] = await Promise.all([fs.stat(absolutePath), readMetadata(absolutePath)]);
  return {
    Key: safeKey,
    ContentLength: stat.size,
    ContentType: meta.contentType || 'application/octet-stream',
    ContentDisposition: meta.contentDisposition || undefined,
    Metadata: meta.metadata || {},
    LastModified: stat.mtime,
  };
};

export const deleteLocalObject = async (key) => {
  const { key: safeKey, absolutePath } = getLocalObjectPath(key);
  await fs.rm(absolutePath, { force: true });
  await fs.rm(metadataPathFor(absolutePath), { force: true });
  return { key: safeKey };
};

export const createLocalInternalRedirect = (key) => {
  const { internalPrefix } = getLocalStorageConfig();
  const safeKey = requireLocalKey(key);
  return `${internalPrefix}/${safeKey.split('/').map(encodeURIComponent).join('/')}`;
};
