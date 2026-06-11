const { authCookieOptions, getMissingAuthConfig, isAuthEnabled } = require('./config');
const { getCookie } = require('./cookies');
const { isApiRequest, isPublicRequest, requestPath } = require('./policy');
const { verifyToken } = require('./token');

function sanitizeReturnTo(req) {
  const raw = req.originalUrl || req.url || requestPath(req) || '/';
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

function authenticateRequest(req) {
  if (!isAuthEnabled()) return { ok: true, disabled: true };

  const missing = getMissingAuthConfig();
  if (missing.length > 0) {
    return { ok: false, status: 503, code: 'auth_misconfigured', missing };
  }

  const token = getCookie(req, 'hxa_token');
  if (!token) return { ok: false, status: 401, code: 'auth_required' };

  const payload = verifyToken(token);
  if (!payload) return { ok: false, status: 401, code: 'invalid_token', clearCookie: true };

  const expectedTenant = process.env.FEISHU_TENANT_KEY;
  if (expectedTenant && payload.tenant_key !== expectedTenant) {
    return { ok: false, status: 403, code: 'tenant_mismatch', clearCookie: true, payload };
  }

  return { ok: true, user: payload };
}

function clearAuthCookie(res) {
  res.clearCookie('hxa_token', {
    ...authCookieOptions(),
    maxAge: undefined,
  });
}

function authMiddleware(req, res, next) {
  if (!isAuthEnabled() || isPublicRequest(req)) return next();

  const result = authenticateRequest(req);
  if (result.ok) {
    if (result.user) req.user = result.user;
    return next();
  }

  if (result.clearCookie) clearAuthCookie(res);

  if (isApiRequest(req)) {
    return res.status(result.status || 401).json({
      error: result.code || 'unauthorized',
      ...(result.missing ? { missing: result.missing } : {}),
    });
  }

  if (result.code === 'auth_misconfigured') {
    return res.status(503).send('Authentication is not configured.');
  }

  if (result.code === 'tenant_mismatch') {
    const name = encodeURIComponent(result.payload?.name || '');
    return res.redirect(`/auth/denied?reason=tenant_mismatch&name=${name}`);
  }

  return res.redirect(`/auth/login?return_to=${encodeURIComponent(sanitizeReturnTo(req))}`);
}

module.exports = authMiddleware;
module.exports.authenticateRequest = authenticateRequest;
module.exports.clearAuthCookie = clearAuthCookie;
