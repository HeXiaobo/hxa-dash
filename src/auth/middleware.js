const { verifyToken } = require('./jwt');

/**
 * Auth middleware for hxa-dash
 * - Skips /api/* routes (bot APIs must work without auth)
 * - Skips /auth/* routes (login, callback, denied)
 * - Protects all other routes (HTML pages, static assets)
 * - Checks hxa_token cookie and verifies tenant_key matches Zhiwai
 */
function authMiddleware(req, res, next) {
  const pathname = req.path;

  // Skip API routes (health-reporter bots, webhooks, etc.)
  if (pathname.startsWith('/api/')) {
    return next();
  }

  // Skip auth routes (login, callback, denied)
  if (pathname.startsWith('/auth/')) {
    return next();
  }

  // For all other routes, require valid auth token
  const token = req.cookies?.hxa_token;

  if (!token) {
    // No token, redirect to login with return_to
    return res.redirect(`/auth/login?return_to=${encodeURIComponent(pathname)}`);
  }

  // Verify token
  const payload = verifyToken(token);
  if (!payload) {
    // Invalid token, redirect to login
    return res.redirect(`/auth/login?return_to=${encodeURIComponent(pathname)}`);
  }

  // Check tenant_key matches Zhiwai's tenant (skip if not configured yet)
  const expectedTenant = process.env.FEISHU_TENANT_KEY;
  if (expectedTenant && payload.tenant_key !== expectedTenant) {
    // User is not from Zhiwai tenant, deny access and clear cookie
    res.clearCookie('hxa_token');
    return res.redirect(`/auth/denied?reason=tenant_mismatch&name=${encodeURIComponent(payload.name || '')}`);
  }

  // Token is valid and user is authorized. Store payload in request for later use.
  req.user = payload;
  next();
}

module.exports = authMiddleware;
