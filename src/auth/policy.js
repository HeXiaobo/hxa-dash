function requestPath(req) {
  if (req.path) return req.path;
  try {
    return new URL(req.url || '/', 'http://hxa.local').pathname;
  } catch {
    return '/';
  }
}

function isApiRequest(req) {
  return requestPath(req).startsWith('/api/');
}

function isMachineIngestRequest(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = requestPath(req);
  if (method !== 'POST') return false;
  return path === '/api/report'
    || path === '/api/report/activity'
    || path === '/api/webhook/connect'
    || path === '/api/webhook/gitlab'
    || /^\/api\/agent-health\/[^/]+$/.test(path);
}

function isPublicRequest(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = requestPath(req);
  if (path.startsWith('/auth/')) return true;
  if (method === 'GET' && (path === '/api/about' || path === '/api/health')) return true;
  return isMachineIngestRequest(req);
}

module.exports = {
  isApiRequest,
  isMachineIngestRequest,
  isPublicRequest,
  requestPath,
};
