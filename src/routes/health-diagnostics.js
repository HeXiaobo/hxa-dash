// System Health Diagnostics (#94)
const express = require('express');
const router = express.Router();
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');

function getSystemHealth() {
  const now = Date.now();

  // --- OS metrics ---
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = Math.round((usedMem / totalMem) * 100);
  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  const cpuCount = cpus.length;

  // Disk usage (macOS/Linux)
  let diskPct = null;
  let diskUsed = null;
  let diskTotal = null;
  try {
    const dfOut = execSync('df -h / 2>/dev/null', { timeout: 5000 }).toString();
    const lines = dfOut.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      // macOS: Filesystem Size Used Avail Capacity ...
      diskTotal = parts[1];
      diskUsed = parts[2];
      diskPct = parseInt(parts[4], 10) || null;
    }
  } catch { /* ignore */ }

  // --- PM2 services ---
  let pm2Services = [];
  try {
    const pm2Out = execSync('pm2 jlist 2>/dev/null', { timeout: 10000 }).toString();
    const pm2Data = JSON.parse(pm2Out);
    pm2Services = pm2Data.map(svc => ({
      name: svc.name,
      status: svc.pm2_env?.status || 'unknown',
      pid: svc.pid,
      uptime: svc.pm2_env?.pm_uptime ? now - svc.pm2_env.pm_uptime : null,
      restarts: svc.pm2_env?.restart_time || 0,
      memory: svc.monit?.memory || null,
      cpu: svc.monit?.cpu || null,
    }));
  } catch { /* PM2 not available */ }

  const pm2Online = pm2Services.filter(s => s.status === 'online').length;
  const pm2Total = pm2Services.length;

  // --- Health endpoints ---
  // These are checked client-side (CORS) — provide endpoint list for frontend to probe
  const endpoints = [
    { name: 'HxA Dash API', url: '/api/health', internal: true },
    { name: 'GitLab API', url: 'https://git.coco.xyz/api/v4/version', external: true },
  ];

  // --- Dashboard uptime ---
  const uptimeSec = Math.floor(process.uptime());

  // --- Thresholds ---
  const memStatus = memPct > 90 ? 'critical' : memPct > 80 ? 'warning' : 'ok';
  const diskStatus = diskPct > 90 ? 'critical' : diskPct > 80 ? 'warning' : 'ok';
  const pm2Status = pm2Online === pm2Total && pm2Total > 0 ? 'ok' : pm2Online === 0 ? 'critical' : 'warning';
  const overallStatus = [memStatus, diskStatus, pm2Status].includes('critical') ? 'critical'
    : [memStatus, diskStatus, pm2Status].includes('warning') ? 'warning' : 'ok';

  return {
    timestamp: now,
    overall: overallStatus,
    uptime_seconds: uptimeSec,
    system: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpu_count: cpuCount,
      cpu_model: cpus[0]?.model || 'unknown',
      load_avg: loadAvg.map(v => Math.round(v * 100) / 100),
    },
    memory: {
      status: memStatus,
      total_gb: Math.round(totalMem / 1073741824 * 10) / 10,
      used_gb: Math.round(usedMem / 1073741824 * 10) / 10,
      free_gb: Math.round(freeMem / 1073741824 * 10) / 10,
      pct: memPct,
    },
    disk: {
      status: diskStatus,
      total: diskTotal,
      used: diskUsed,
      pct: diskPct,
    },
    pm2: {
      status: pm2Status,
      online: pm2Online,
      total: pm2Total,
      services: pm2Services,
    },
    endpoints,
  };
}

router.get('/', (req, res) => {
  try {
    res.json(getSystemHealth());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.getSystemHealth = getSystemHealth;
