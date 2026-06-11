// Use jsonwebtoken for CommonJS compatibility (jose is ESM-only)
const jwt = require('jsonwebtoken');

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  return secret;
}

/**
 * Sign a JWT token for hxa-dash
 */
function signToken(payload) {
  return jwt.sign(
    {
      open_id: payload.openId,
      union_id: payload.unionId,
      name: payload.name,
      avatar_url: payload.avatarUrl,
      tenant_key: payload.tenantKey,
    },
    getSecret(),
    {
      algorithm: 'HS256',
      issuer: 'hxa-dash',
      expiresIn: '30d',
    }
  );
}

/**
 * Verify and decode a JWT token
 */
function verifyToken(token) {
  try {
    const payload = jwt.verify(token, getSecret(), {
      issuer: 'hxa-dash',
    });
    return payload;
  } catch (err) {
    return null;
  }
}

module.exports = {
  signToken,
  verifyToken,
};
