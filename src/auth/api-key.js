const { isAuthEnabled } = require('./config');

function extractApiKey(req) {
  const authHeader = req.headers?.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return req.headers?.['x-api-key'] || null;
}

function acceptedIngestKeys() {
  return [
    process.env.HXA_INGEST_API_KEY,
    process.env.HEALTH_API_KEY,
  ].filter(Boolean);
}

function hasApiKey(req, keys = acceptedIngestKeys()) {
  const token = extractApiKey(req);
  return !!token && keys.includes(token);
}

function requireIngestAuth(req, res, next) {
  if (!isAuthEnabled()) return next();
  const keys = acceptedIngestKeys();
  if (keys.length === 0) {
    return res.status(403).json({ error: 'HXA_INGEST_API_KEY not configured' });
  }
  if (!hasApiKey(req, keys)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

module.exports = {
  acceptedIngestKeys,
  extractApiKey,
  hasApiKey,
  requireIngestAuth,
};
