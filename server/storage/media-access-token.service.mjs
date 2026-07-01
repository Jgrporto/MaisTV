import crypto from 'node:crypto';

const base64url = (value) => Buffer.from(value).toString('base64url');

const getSecret = () => {
  const secret = process.env.MEDIA_ACCESS_TOKEN_SECRET || process.env.AUTH_SESSION_SECRET || process.env.WHATSAPP_APP_SECRET;
  if (!secret || String(secret).length < 16) {
    throw new Error('MEDIA_ACCESS_TOKEN_SECRET must be configured for local media URLs.');
  }
  return String(secret);
};

const sign = (payload) => crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');

export const createLocalStorageToken = ({ tenantId, mediaId, userId, sessionId, key, type = 'original', expiresIn = 300 }) => {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    tenantId: tenantId || '',
    mediaId: mediaId || '',
    userId: userId || '',
    sessionId: sessionId || '',
    key: key || '',
    type,
    exp: now + Math.max(1, Number(expiresIn) || 300),
    iat: now,
  }));
  return `${payload}.${sign(payload)}`;
};

export const verifyLocalStorageToken = (token) => {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) throw Object.assign(new Error('Invalid media token.'), { statusCode: 401 });
  const expected = sign(payload);
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) {
    throw Object.assign(new Error('Invalid media token signature.'), { statusCode: 401 });
  }
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw Object.assign(new Error('Invalid media token signature.'), { statusCode: 401 });
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid media token payload.'), { statusCode: 401 });
  }
  if (!data.exp || Number(data.exp) < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error('Expired media token.'), { statusCode: 401 });
  }
  return data;
};
