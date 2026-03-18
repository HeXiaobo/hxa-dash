// PM2 Service Management (#123, #124)
// POST /api/pm2/:service/restart — one-click restart (auth required)
// GET  /api/pm2/services         — all PM2 services with expected-service detection
const { Router } = require('express');
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const router = Router();

// Reuse same auth key as agent-health
const HEALTH_API_KEY = process.env.HEALTH_API_KEY || null;

function requireAuth(req, res, next) {
  if (!HEALTH_API_KEY) {
    return res.status(403).json({ error: 'HEALTH_API_KEY not configured' });
  }
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : apiKeyHeader || null;
  if (!token || token !== HEALTH_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Load expected services registry (#124)
const EXPECTED_SERVICES_PATH = path.join(__dirname, '..', '..', 'config', 'expected-services.json');

function loadExpectedServices() {
  try {
    if (fs.existsSync(EXPECTED_SERVICES_PATH)) {
      return JSON.parse(fs.readFileSync(EXPECTED_SERVICES_PATH, 'utf8'));
    }
  } catch { /* ignore parse errors */ }
  return { services: [] };
}

// Get current PM2 service list
function getPM2Services() {
  try {
    const out = execSync('pm2 jlist 2>/dev/null', { timeout: 10000 }).toString();
    const data = JSON.parse(out);
    return data.map(svc => ({
      name: svc.name,
      status: svc.pm2_env?.status || 'unknown',
      pid: svc.pid,
      uptime: svc.pm2_env?.pm_uptime ? Date.now() - svc.pm2_env.pm_uptime : null,
      restarts: svc.pm2_env?.restart_time || 0,
      memory: svc.monit?.memory || null,
      cpu: svc.monit?.cpu || null,
    }));
  } catch {
    return [];
  }
}

// GET /api/pm2/services — list services + expected-service check (#124)
router.get('/services', (req, res) => {
  const services = getPM2Services();
  const expected = loadExpectedServices();
  const serviceNames = new Set(services.map(s => s.name));

  // Detect missing expected services
  const missing = expected.services
    .filter(e => !serviceNames.has(e.name))
    .map(e => ({ name: e.name, description: e.description || '', critical: e.critical !== false }));

  // Detect unexpected stopped/errored services
  const alerts = services
    .filter(s => s.status !== 'online')
    .map(s => ({ name: s.name, status: s.status, type: 'down' }));

  // Add missing as alerts too
  missing.forEach(m => {
    alerts.push({ name: m.name, status: 'missing', type: 'missing', critical: m.critical });
  });

  const online = services.filter(s => s.status === 'online').length;
  const total = services.length;
  const status = missing.some(m => m.critical) ? 'critical'
    : alerts.length > 0 ? 'warning'
    : online === total && total > 0 ? 'ok' : 'warning';

  res.json({
    status,
    online,
    total,
    services,
    missing,
    alerts,
    timestamp: Date.now(),
  });
});

// POST /api/pm2/:service/restart — restart a PM2 service (auth required)
router.post('/:service/restart', requireAuth, (req, res) => {
  const { service } = req.params;

  // Validate service name (alphanumeric, hyphens, underscores only)
  if (!/^[a-zA-Z0-9_-]+$/.test(service)) {
    return res.status(400).json({ error: 'Invalid service name' });
  }

  // Verify service exists
  const services = getPM2Services();
  const exists = services.find(s => s.name === service);
  if (!exists) {
    return res.status(404).json({ error: `Service "${service}" not found in PM2` });
  }

  // Execute restart
  try {
    execSync(`pm2 restart ${service} 2>&1`, { timeout: 15000 });
    const updated = getPM2Services().find(s => s.name === service);
    console.log(`[PM2] Service "${service}" restarted via API`);
    res.json({ ok: true, service: updated || { name: service, status: 'restarting' } });
  } catch (err) {
    console.error(`[PM2] Failed to restart "${service}":`, err.message);
    res.status(500).json({ error: `Restart failed: ${err.message}` });
  }
});

module.exports = router;
module.exports.getPM2Services = getPM2Services;
