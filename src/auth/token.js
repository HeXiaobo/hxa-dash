const crypto = require('crypto');
const { getAuthSecret } = require('./config');

const TOKEN_ISSUER = 'hxa-dash';
const STATE_ISSUER = 'hxa-dash-oauth-state';
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodeBase64url(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function sign(data) {
  const secret = getAuthSecret();
  if (!secret) throw new Error('HXA_AUTH_SECRET not configured');
  return base64url(crypto.createHmac('sha256', secret).update(data).digest());
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signPayload(payload, { issuer, ttlSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = {
    ...payload,
    iss: issuer,
    iat: now,
    exp: now + ttlSeconds,
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(body));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  return `${signingInput}.${sign(signingInput)}`;
}

function verifyPayload(token, { issuer }) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, signature] = parts;
    const header = JSON.parse(decodeBase64url(encodedHeader));
    if (header.alg !== 'HS256') return null;
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    if (!safeEqual(signature, sign(signingInput))) return null;
    const payload = JSON.parse(decodeBase64url(encodedPayload));
    if (payload.iss !== issuer) return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function signToken(user) {
  return signPayload({
    open_id: user.openId,
    union_id: user.unionId,
    name: user.name,
    avatar_url: user.avatarUrl,
    tenant_key: user.tenantKey,
  }, { issuer: TOKEN_ISSUER, ttlSeconds: TOKEN_TTL_SECONDS });
}

function verifyToken(token) {
  return verifyPayload(token, { issuer: TOKEN_ISSUER });
}

function signState(state) {
  return signPayload({
    type: 'oauth_state',
    return_to: state.returnTo || '/',
    nonce: crypto.randomBytes(12).toString('hex'),
  }, { issuer: STATE_ISSUER, ttlSeconds: STATE_TTL_SECONDS });
}

function verifyState(token) {
  const payload = verifyPayload(token, { issuer: STATE_ISSUER });
  if (!payload || payload.type !== 'oauth_state') return null;
  return payload;
}

module.exports = {
  signState,
  signToken,
  verifyState,
  verifyToken,
};
