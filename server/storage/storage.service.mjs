const parseBoolean = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const stripTrailingSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

export const getStorageConfig = () => {
  const provider = String(process.env.STORAGE_PROVIDER || 's3').trim().toLowerCase();
  if (!['s3', 'r2'].includes(provider)) {
    throw new Error(`Unsupported STORAGE_PROVIDER: ${provider || '(empty)'}. Use s3 or r2.`);
  }

  const endpoint = stripTrailingSlash(process.env.S3_ENDPOINT || process.env.R2_ENDPOINT);
  const config = {
    provider,
    bucket: String(process.env.S3_BUCKET || process.env.R2_BUCKET || '').trim(),
    region: String(process.env.S3_REGION || (provider === 'r2' ? 'auto' : 'us-east-1')).trim(),
    endpoint: endpoint || undefined,
    accessKeyId: String(process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '').trim(),
    publicBaseUrl: stripTrailingSlash(process.env.S3_PUBLIC_BASE_URL),
    forcePathStyle: parseBoolean(process.env.S3_FORCE_PATH_STYLE, false),
    signedUrlTtlSeconds: parsePositiveInteger(process.env.MEDIA_SIGNED_URL_TTL_SECONDS, 300),
  };

  const missing = ['bucket', 'accessKeyId', 'secretAccessKey'].filter((key) => !config[key]);
  if (provider === 'r2' && !config.endpoint) missing.push('endpoint');
  if (missing.length) {
    throw new Error(`Object storage is not configured. Missing: ${missing.join(', ')}.`);
  }
  return config;
};

let clientPromise;
const getClient = async () => {
  const config = getStorageConfig();
  if (!clientPromise) {
    clientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) => new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })).catch((error) => {
      clientPromise = undefined;
      throw new Error(`S3 storage unavailable. Install @aws-sdk/client-s3: ${error.message}`, { cause: error });
    });
  }
  return { client: await clientPromise, config };
};

const requireKey = (key) => {
  const normalized = String(key || '').trim().replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) throw new Error('A safe storage object key is required.');
  return normalized;
};

export const createSignedDownloadUrl = async (key, expiresIn) => {
  const safeKey = requireKey(key);
  const [{ client, config }, { GetObjectCommand }, { getSignedUrl }] = await Promise.all([
    getClient(),
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/s3-request-presigner').catch((error) => {
      throw new Error(`Signed URLs unavailable. Install @aws-sdk/s3-request-presigner: ${error.message}`, { cause: error });
    }),
  ]);
  const ttl = parsePositiveInteger(expiresIn, config.signedUrlTtlSeconds);
  return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: safeKey }), { expiresIn: ttl });
};

export const putObject = async ({ key, body, contentType, contentDisposition, metadata }) => {
  const safeKey = requireKey(key);
  if (body == null) throw new Error('Storage upload body is required.');
  const [{ client, config }, { PutObjectCommand }] = await Promise.all([getClient(), import('@aws-sdk/client-s3')]);
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: safeKey,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    ContentDisposition: contentDisposition || undefined,
    Metadata: metadata || undefined,
  }));
  return {
    key: safeKey,
    publicUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/${safeKey.split('/').map(encodeURIComponent).join('/')}` : null,
  };
};

export const getObject = async (key) => {
  const safeKey = requireKey(key);
  const [{ client, config }, { GetObjectCommand }] = await Promise.all([getClient(), import('@aws-sdk/client-s3')]);
  return client.send(new GetObjectCommand({ Bucket: config.bucket, Key: safeKey }));
};

export const headObject = async (key) => {
  const safeKey = requireKey(key);
  const [{ client, config }, { HeadObjectCommand }] = await Promise.all([getClient(), import('@aws-sdk/client-s3')]);
  return client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: safeKey }));
};

export const deleteObject = async (key) => {
  const safeKey = requireKey(key);
  const [{ client, config }, { DeleteObjectCommand }] = await Promise.all([getClient(), import('@aws-sdk/client-s3')]);
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: safeKey }));
  return { key: safeKey };
};

export const resetStorageClientForTests = () => {
  clientPromise = undefined;
};
