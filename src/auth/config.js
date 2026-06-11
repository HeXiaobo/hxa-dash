function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function isAuthEnabled() {
  return envFlag('HXA_AUTH_ENABLED', false);
}

function getAuthSecret() {
  return process.env.HXA_AUTH_SECRET || process.env.JWT_SECRET || '';
}

function getMissingAuthConfig() {
  if (!isAuthEnabled()) return [];
  const required = {
    FEISHU_APP_ID: process.env.FEISHU_APP_ID,
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    FEISHU_TENANT_KEY: process.env.FEISHU_TENANT_KEY,
    HXA_AUTH_SECRET: getAuthSecret(),
  };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: envFlag('HXA_COOKIE_SECURE', process.env.NODE_ENV === 'production'),
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

function getPublicBaseUrl(req) {
  const configured = process.env.HXA_PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, '');
  const host = req.get ? req.get('host') : req.headers?.host;
  const protocol = req.protocol || (req.headers?.['x-forwarded-proto'] || 'http').split(',')[0];
  return `${protocol}://${host}`;
}

module.exports = {
  authCookieOptions,
  envFlag,
  getAuthSecret,
  getMissingAuthConfig,
  getPublicBaseUrl,
  isAuthEnabled,
};
