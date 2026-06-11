const express = require('express');
const { authCookieOptions, getMissingAuthConfig, getPublicBaseUrl, isAuthEnabled } = require('../auth/config');
const { buildAuthorizeUrl, exchangeCodeForUser } = require('../auth/feishu');
const { signState, signToken, verifyState } = require('../auth/token');

const router = express.Router();

function sanitizeReturnTo(value) {
  const raw = typeof value === 'string' && value ? value : '/';
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function requireConfigured(res) {
  if (!isAuthEnabled()) return null;
  const missing = getMissingAuthConfig();
  if (missing.length === 0) return null;
  res.status(503).json({ error: 'auth_misconfigured', missing });
  return missing;
}

router.get('/login', (req, res) => {
  const returnTo = sanitizeReturnTo(req.query.return_to);
  if (!isAuthEnabled()) return res.redirect(returnTo);
  if (requireConfigured(res)) return;

  const redirectUri = `${getPublicBaseUrl(req)}/auth/callback`;
  const authorizeUrl = buildAuthorizeUrl(redirectUri, signState({ returnTo }));
  res.redirect(authorizeUrl);
});

router.get('/callback', async (req, res) => {
  if (!isAuthEnabled()) return res.redirect('/');
  if (requireConfigured(res)) return;

  const code = req.query.code;
  const state = verifyState(req.query.state);
  if (!code || !state) {
    return res.redirect('/auth/denied?reason=invalid_callback');
  }

  const returnTo = sanitizeReturnTo(state.return_to);

  try {
    const user = await exchangeCodeForUser(code);
    if (user.tenantKey !== process.env.FEISHU_TENANT_KEY) {
      return res.redirect(`/auth/denied?reason=not_authorized&name=${encodeURIComponent(user.name || '')}`);
    }

    const token = signToken(user);
    res.cookie('hxa_token', token, authCookieOptions());
    return res.redirect(returnTo);
  } catch (err) {
    console.error('[auth] callback failed:', err.message);
    return res.status(500).json({ error: 'auth_callback_failed' });
  }
});

router.get('/logout', (req, res) => {
  res.clearCookie('hxa_token', {
    ...authCookieOptions(),
    maxAge: undefined,
  });
  res.redirect('/auth/login');
});

router.get('/denied', (req, res) => {
  const reason = req.query.reason || 'unauthorized';
  const name = escapeHtml(req.query.name || 'User');

  let message = 'You do not have permission to access this application.';
  if (reason === 'not_authorized' || reason === 'tenant_mismatch') {
    message = `Only authorized Zhiwai tenant users can access this dashboard. Your account (${name}) is not authorized.`;
  } else if (reason === 'invalid_callback') {
    message = 'Login failed because the Feishu callback was invalid or expired.';
  }

  res.status(403).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Access Denied</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #111827; }
    main { width: min(420px, calc(100vw - 32px)); border: 1px solid #e5e7eb; border-radius: 8px; background: white; padding: 24px; box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 12px; font-size: 22px; }
    p { margin: 0 0 20px; color: #4b5563; line-height: 1.5; }
    a { color: #2563eb; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>Access denied</h1>
    <p>${message}</p>
    <a href="/auth/login">Try again</a>
  </main>
</body>
</html>`);
});

module.exports = router;
