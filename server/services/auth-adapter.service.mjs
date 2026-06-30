const authError = (message, statusCode = 401) => Object.assign(new Error(message), { statusCode });

export const createLegacyAuthResolver = ({ authMeUrl = process.env.LEGACY_AUTH_ME_URL || 'http://127.0.0.1:5053/api/local/auth/me' } = {}) => async (req) => {
  const cookie = String(req.headers.cookie || '');
  if (!cookie.includes('saastv_session=')) throw authError('Authentication required.');
  let response;
  try {
    response = await fetch(authMeUrl, { headers: { cookie, accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw authError(`Legacy authentication service unavailable: ${error.message}`, 503);
  }
  if (response.status === 401 || response.status === 403) throw authError('Invalid or expired session.');
  if (!response.ok) throw authError(`Legacy authentication failed with HTTP ${response.status}.`, 503);
  const payload = await response.json();
  const user = payload.user || payload.session?.user || payload;
  if (!user?.id && !user?.email) throw authError('Legacy authentication returned no user identity.', 503);
  return {
    userId: String(user.id || user.email),
    tenantId: String(user.tenant_id || user.tenantId || process.env.CHAT_DEFAULT_TENANT_ID || ''),
    queueIds: Array.isArray(user.queue_ids || user.queueIds) ? (user.queue_ids || user.queueIds).map(String) : [],
    roles: Array.isArray(user.roles)
      ? user.roles.map(String)
      : [user.role,user.role_name,user.roleName].map((value)=>String(value||'').trim()).filter(Boolean),
    raw: user,
  };
};

export const createAuthMiddleware = ({ resolveSession = createLegacyAuthResolver() } = {}) => async (req, res, next) => {
  try {
    const auth = await resolveSession(req);
    if (!auth?.tenantId) throw authError('Authenticated session has no tenant. Configure CHAT_DEFAULT_TENANT_ID.', 503);
    req.chatAuth = auth;
    req.reauthorizeChatSession = () => resolveSession(req);
    next();
  } catch (error) {
    res.status(error.statusCode || 401).json({ error: 'chat_auth_failed', message: error.message });
  }
};
