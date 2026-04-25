// System Health Diagnostics (#94, #104)
// Multi-component health: local system + agent status + service endpoints
const express = require('express');
const router = express.Router();
const { execSync } = require('child_process');
const os = require('os');
const http = require('http');
const https = require('https');
const { buildAgents } = require('./team');

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

// Service endpoints to check — loaded from config or fallback to localhost only
let SERVICE_ENDPOINTS = [
  { name: 'HxA Dash', url: `http://localhost:${process.env.PORT || 3479}/api/health`, category: 'internal' },
];

function loadEndpoints(config) {
  if (config && config.health_endpoints) {
    SERVICE_ENDPOINTS = config.health_endpoints;
  }
}

function summarizeQuota(quota) {
  if (!quota || !quota.supported) {
    return { supported: false, reason: quota?.reason || 'not_supported' };
  }
  return {
    supported: true,
    primary: quota.primary || null,
    secondary: quota.secondary || null,
    source: quota.source || null,
  };
}

function summarizeUsage(usage) {
  if (!usage || !usage.supported) {
    return { supported: false, reason: usage?.reason || 'not_supported' };
  }
  return {
    supported: true,
    source: usage.source || null,
    sampled_at: usage.sampled_at || null,
    session_tokens: usage.session_tokens || null,
    last_turn_tokens: usage.last_turn_tokens || null,
    session_cost_usd: usage.session_cost_usd || null,
    estimated_cost: !!usage.estimated_cost,
    model: usage.model || null,
    plan_type: usage.plan_type || null,
  };
}

// Get agent health from db (activity + system metrics #115)
function getAgentHealth() {
  return buildAgents().map(agent => {
    return {
      name: agent.name,
      online: agent.online,
      status: agent.work_state,
      runtime_status: agent.runtime_status,
      runtime: agent.runtime || null,
      last_seen_at: agent.last_seen_at || null,
      last_active: agent.last_active_at || null,
      last_heartbeat_at: agent.last_heartbeat_at || null,
      open_tasks: agent.stats?.open_tasks || 0,
      active_projects: agent.active_projects || [],
      quota: summarizeQuota(agent.quota),
      usage: summarizeUsage(agent.usage),
      system_health: agent.hardware || null,
      system_health_stale: agent.hardware?.stale ?? true,
      health_score: agent.health_score ?? null,
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
    const agentOnline = agentHealth.filter(a => a.runtime_status !== 'offline').length;
    const agentTotal = agentHealth.length;
    const agentStatus = agentTotal === 0 ? 'warning' : agentOnline === agentTotal ? 'ok' : agentOnline === 0 ? 'critical' : 'warning';
    const runtimeDistribution = agentHealth.reduce((acc, agent) => {
      const type = agent.runtime?.type || 'unknown';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
    const degradedAgents = agentHealth.filter(a => a.runtime_status === 'degraded').length;

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
        degraded: degradedAgents,
        runtime_distribution: runtimeDistribution,
        list: agentHealth,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.loadEndpoints = loadEndpoints;
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
