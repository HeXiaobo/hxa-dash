// System Health Diagnostics (#94, #104)
// Multi-component health: local system + agent status + service endpoints
const express = require('express');
const router = express.Router();
const { execSync } = require('child_process');
const os = require('os');
const http = require('http');
const https = require('https');
const db = require('../db');

function getLocalSystem() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = Math.round((usedMem / totalMem) * 100);
  const cpus = os.cpus();
  const loadAvg = os.loadavg();

  let diskPct = null;
  let diskUsed = null;
  let diskTotal = null;
  try {
    const dfOut = execSync('df -h / 2>/dev/null', { timeout: 5000 }).toString();
    const lines = dfOut.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      diskTotal = parts[1];
      diskUsed = parts[2];
      diskPct = parseInt(parts[4], 10) || null;
    }
  } catch { /* ignore */ }

  let pm2Services = [];
  try {
    const pm2Out = execSync('pm2 jlist 2>/dev/null', { timeout: 10000 }).toString();
    const pm2Data = JSON.parse(pm2Out);
    pm2Services = pm2Data.map(svc => ({
      name: svc.name,
      status: svc.pm2_env?.status || 'unknown',
      pid: svc.pid,
      uptime: svc.pm2_env?.pm_uptime ? Date.now() - svc.pm2_env.pm_uptime : null,
      restarts: svc.pm2_env?.restart_time || 0,
      memory: svc.monit?.memory || null,
      cpu: svc.monit?.cpu || null,
    }));
  } catch { /* PM2 not available */ }

  const pm2Online = pm2Services.filter(s => s.status === 'online').length;
  const pm2Total = pm2Services.length;

  const cpuPct = cpus.length > 0 ? Math.min(100, Math.round((loadAvg[0] / cpus.length) * 100)) : null;

  const cpuStatus = cpuPct > 90 ? 'critical' : cpuPct > 80 ? 'warning' : 'ok';
  const memStatus = memPct > 90 ? 'critical' : memPct > 80 ? 'warning' : 'ok';
  const diskStatus = diskPct > 90 ? 'critical' : diskPct > 80 ? 'warning' : 'ok';
  const pm2Status = pm2Online === pm2Total && pm2Total > 0 ? 'ok' : pm2Online === 0 ? 'critical' : 'warning';

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpu_count: cpus.length,
    cpu_model: cpus[0]?.model || 'unknown',
    load_avg: loadAvg.map(v => Math.round(v * 100) / 100),
    cpu: { status: cpuStatus, pct: cpuPct, cores: cpus.length },
    memory: { status: memStatus, total_gb: Math.round(totalMem / 1073741824 * 10) / 10, used_gb: Math.round(usedMem / 1073741824 * 10) / 10, free_gb: Math.round(freeMem / 1073741824 * 10) / 10, pct: memPct },
    disk: { status: diskStatus, total: diskTotal, used: diskUsed, pct: diskPct },
    pm2: { status: pm2Status, online: pm2Online, total: pm2Total, services: pm2Services },
  };
}

// Probe a URL and return status
function probeEndpoint(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const start = Date.now();
    try {
      const req = mod.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
        const latencyMs = Date.now() - start;
        res.resume();
        resolve({
          status: res.statusCode < 500 ? 'ok' : 'error',
          http_status: res.statusCode,
          latency_ms: latencyMs,
        });
      });
      req.on('error', () => {
        resolve({ status: 'error', http_status: null, latency_ms: Date.now() - start });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 'error', http_status: null, latency_ms: timeoutMs });
      });
    } catch {
      resolve({ status: 'error', http_status: null, latency_ms: 0 });
    }
  });
}

// Service endpoints to check
const SERVICE_ENDPOINTS = [
  { name: 'HxA Dash', url: 'http://localhost:3479/api/health', category: 'internal' },
  { name: 'GitLab', url: 'https://git.coco.xyz/api/v4/version', category: 'platform' },
  { name: 'HxA Hub', url: 'https://jessie.coco.site/hub/api/health', category: 'platform' },
  { name: 'HxA Link', url: 'https://jessie.coco.site/api/health', category: 'platform' },
];

// Get agent health from db (activity + system metrics #115)
function getAgentHealth() {
  const agents = db.getAllAgents();
  const allSystemHealth = db.getAllAgentHealth();
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;
  const thirtyMinAgo = now - 30 * 60 * 1000;
  const STALE_MS = 10 * 60 * 1000;

  return agents.map(agent => {
    const events = db.getEventsForAgent(agent.name, 1);
    const lastEvent = events[0] || null;
    const lastActive = lastEvent?.timestamp || agent.last_seen_at || null;

    let activityStatus = 'unknown';
    if (agent.online) {
      activityStatus = lastActive && lastActive > fiveMinAgo ? 'active' : 'idle';
    } else {
      activityStatus = lastActive && lastActive > thirtyMinAgo ? 'recently_seen' : 'offline';
    }

    const tasks = db.getTasksForAgent(agent.name, { assigneeOnly: true });
    const openTasks = tasks.filter(t => t.state === 'opened').length;

    // System health (#115)
    const sysHealth = allSystemHealth[agent.name] || null;
    const sysStale = sysHealth ? (now - sysHealth.reported_at > STALE_MS) : true;

    return {
      name: agent.name,
      online: agent.online,
      status: activityStatus,
      last_seen_at: agent.last_seen_at || null,
      last_active: lastActive,
      open_tasks: openTasks,
      system_health: sysHealth && !sysStale ? sysHealth : null,
      system_health_stale: sysStale,
    };
  });
}

router.get('/', async (req, res) => {
  try {
    const now = Date.now();
    const localSystem = getLocalSystem();
    const agentHealth = getAgentHealth();

    // Probe service endpoints in parallel
    const probeResults = await Promise.all(
      SERVICE_ENDPOINTS.map(async (ep) => {
        const result = await probeEndpoint(ep.url);
        return { name: ep.name, url: ep.url, category: ep.category, ...result };
      })
    );

    const systemStatuses = [localSystem.cpu.status, localSystem.memory.status, localSystem.disk.status, localSystem.pm2.status];
    const serviceStatuses = probeResults.map(r => r.status);
    const agentOnline = agentHealth.filter(a => a.online).length;
    const agentTotal = agentHealth.length;
    const agentStatus = agentTotal === 0 ? 'warning' : agentOnline === agentTotal ? 'ok' : agentOnline === 0 ? 'critical' : 'warning';

    const allStatuses = [...systemStatuses, ...serviceStatuses, agentStatus];
    const overallStatus = allStatuses.includes('critical') ? 'critical'
      : allStatuses.includes('error') ? 'warning'
      : allStatuses.includes('warning') ? 'warning' : 'ok';

    res.json({
      timestamp: now,
      overall: overallStatus,
      uptime_seconds: Math.floor(process.uptime()),
      system: {
        hostname: localSystem.hostname,
        platform: localSystem.platform,
        arch: localSystem.arch,
        cpu_count: localSystem.cpu_count,
        cpu_model: localSystem.cpu_model,
        load_avg: localSystem.load_avg,
      },
      memory: localSystem.memory,
      disk: localSystem.disk,
      pm2: localSystem.pm2,
      services: probeResults,
      agents: {
        status: agentStatus,
        online: agentOnline,
        total: agentTotal,
        list: agentHealth,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.getSystemHealth = () => {
  const local = getLocalSystem();
  const systemStatuses = [local.memory.status, local.disk.status, local.pm2.status];
  const overallStatus = systemStatuses.includes('critical') ? 'critical'
    : systemStatuses.includes('warning') ? 'warning' : 'ok';
  return {
    timestamp: Date.now(),
    overall: overallStatus,
    uptime_seconds: Math.floor(process.uptime()),
    system: { hostname: local.hostname, platform: local.platform, arch: local.arch, cpu_count: local.cpu_count, cpu_model: local.cpu_model, load_avg: local.load_avg },
    memory: local.memory,
    disk: local.disk,
    pm2: local.pm2,
    endpoints: [],
  };
};
