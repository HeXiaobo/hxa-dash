const express = require('express');
const { buildAuthorizeUrl, exchangeCodeForUser } = require('../auth/feishu');
const { signToken } = require('../auth/jwt');

const router = express.Router();

/**
 * GET /auth/login
 * Redirect to Feishu OAuth authorize endpoint.
 * Accepts ?return_to=<path> to redirect back after login.
 */
router.get('/login', (req, res) => {
  const returnTo = req.query.return_to || '/';
  const origin = `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${origin}/auth/callback`;

  // Encode returnTo in state so callback can redirect back
  const state = Buffer.from(JSON.stringify({ returnTo })).toString('base64url');
  const authorizeUrl = buildAuthorizeUrl(redirectUri, state);

  res.redirect(authorizeUrl);
});

/**
 * GET /auth/callback
 * Handle OAuth callback from Feishu.
 * Exchange code for user info, verify tenant, sign JWT, set cookie.
 */
router.get('/callback', async (req, res) => {
  const code = req.query.code;
  const stateParam = req.query.state;

  if (!code) {
    return res.redirect('/auth/denied?reason=no_code');
  }

  let returnTo = '/';
  if (stateParam) {
    try {
      const decoded = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
      if (decoded.returnTo && decoded.returnTo.startsWith('/') && !decoded.returnTo.startsWith('//')) {
        returnTo = decoded.returnTo;
      }
    } catch {
      // Ignore decode errors, use default returnTo
    }
  }

  try {
    // Exchange code for user info
    const user = await exchangeCodeForUser(code);

    // Check tenant key matches Zhiwai's tenant
    const expectedTenant = process.env.FEISHU_TENANT_KEY;
    if (!expectedTenant) {
      console.warn(`[auth] FEISHU_TENANT_KEY not configured. User ${user.name} logged in with tenant_key: ${user.tenantKey}`);
    } else if (user.tenantKey !== expectedTenant) {
      return res.redirect(`/auth/denied?reason=not_authorized&name=${encodeURIComponent(user.name || '')}`);
    }

    // Sign JWT
    const token = signToken({
      openId: user.openId,
      unionId: user.unionId,
      name: user.name,
      avatarUrl: user.avatarUrl,
      tenantKey: user.tenantKey,
    });

    // Set secure cookie
    res.cookie('hxa_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
    });

    // Redirect back to original page or home
    res.redirect(returnTo);
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.status(500).json({
      error: 'auth_callback_failed',
      detail: err.message,
    });
  }
});

/**
 * GET /auth/logout
 * Clear auth cookie and redirect to login.
 */
router.get('/logout', (req, res) => {
  res.clearCookie('hxa_token');
  res.redirect('/auth/login');
});

/**
 * GET /auth/denied
 * Access denied page (shown when user is not authorized).
 */
router.get('/denied', (req, res) => {
  const reason = req.query.reason || 'unauthorized';
  const rawName = req.query.name ? decodeURIComponent(req.query.name) : 'User';
  const name = rawName.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let title = 'Access Denied';
  let message = 'You do not have permission to access this application.';

  if (reason === 'not_authorized' || reason === 'tenant_mismatch') {
    message = `Only Zhiwai employees can access this dashboard. Your account (${name}) is not authorized.`;
  } else if (reason === 'no_code') {
    message = 'Login failed: No authorization code received from Feishu.';
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${title}</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
        }
        .container {
          background: white;
          padding: 2rem;
          border-radius: 8px;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          text-align: center;
          max-width: 400px;
        }
        h1 {
          color: #ef4444;
          margin: 0 0 1rem 0;
        }
        p {
          color: #666;
          margin: 0 0 2rem 0;
          line-height: 1.5;
        }
        .buttons {
          display: flex;
          gap: 1rem;
          justify-content: center;
        }
        a {
          display: inline-block;
          padding: 0.75rem 1.5rem;
          border-radius: 4px;
          text-decoration: none;
          font-weight: 500;
          transition: background-color 0.2s;
        }
        .btn-login {
          background: #3b82f6;
          color: white;
        }
        .btn-login:hover {
          background: #2563eb;
        }
        .btn-home {
          background: #e5e7eb;
          color: #333;
        }
        .btn-home:hover {
          background: #d1d5db;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>${title}</h1>
        <p>${message}</p>
        <div class="buttons">
          <a href="/auth/login" class="btn-login">Try Again</a>
          <a href="/" class="btn-home">Home</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

module.exports = router;
