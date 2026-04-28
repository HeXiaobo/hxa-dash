// Agent Health Reporting (#115)
// POST /api/agent-health/:name — agents push their system metrics (auth required)
// GET  /api/agent-health        — retrieve all agent health data
// GET  /api/agent-health/:name  — retrieve single agent health
const { Router } = require('express');
const db = require('../db');

const router = Router();

// Max age before health data is considered stale (10 minutes)
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

// Shared secret for POST auth — set via HEALTH_API_KEY env var
const HEALTH_API_KEY = process.env.HEALTH_API_KEY || null;

// Auth middleware for POST — requires Bearer token or X-API-Key header
function requireHealthAuth(req, res, next) {
  if (!HEALTH_API_KEY) {
    // No key configured = reject all writes (fail-closed)
    return res.status(403).json({ error: 'HEALTH_API_KEY not configured on server' });
  }

  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];

  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : apiKeyHeader || null;

  if (!token || token !== HEALTH_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Sanitize string: strip HTML tags, clamp length
function sanitizeStr(val, maxLen = 64) {
  if (typeof val !== 'string') return null;
  return val.replace(/<[^>]*>/g, '').slice(0, maxLen);
}

// Clamp a number to [min, max], return null if not a number
function clampNum(val, min = 0, max = 100) {
  if (typeof val !== 'number' || isNaN(val)) return null;
  return Math.max(min, Math.min(max, Math.round(val * 10) / 10));
}

function clampInt(val, min = 0, max = 1e12) {
  if (typeof val !== 'number' || isNaN(val)) return null;
  return Math.max(min, Math.min(max, Math.round(val)));
}

function normalizeTimestamp(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sanitizeEnum(val, allowed, fallback = null) {
  const normalized = sanitizeStr(val, 64)?.toLowerCase() || null;
  return normalized && allowed.includes(normalized) ? normalized : fallback;
}

function sanitizeQuotaWindow(window, fallbackLabel = null) {
  if (!window || typeof window !== 'object') return null;
  const usedPercent = typeof window.used_percent === 'number'
    ? clampNum(window.used_percent, 0, 100)
    : typeof window.used_percentage === 'number'
      ? clampNum(window.used_percentage, 0, 100)
      : null;
  const resetsAt = normalizeTimestamp(window.resets_at);
  const windowMinutes = clampNum(window.window_minutes, 0, 60 * 24 * 365);
  if (usedPercent == null && resetsAt == null && windowMinutes == null) return null;
  return {
    label: sanitizeStr(window.label, 16) || fallbackLabel,
    used_percent: usedPercent,
    resets_at: resetsAt,
    window_minutes: windowMinutes,
  };
}

function sanitizeQuotaShape(quota) {
  if (!quota || typeof quota !== 'object') return null;
  const primary = sanitizeQuotaWindow(quota.primary || quota['5h'], '5h');
  const secondary = sanitizeQuotaWindow(quota.secondary || quota['7d'], '7d');
  const hasUsedQuotaWindow = [primary, secondary].some(window => typeof window?.used_percent === 'number');
  const requestedSupported = typeof quota.supported === 'boolean'
    ? quota.supported
    : !!(quota.primary || quota.secondary || quota['5h'] || quota['7d']);
  const supported = requestedSupported && hasUsedQuotaWindow;
  return {
    supported,
    source: sanitizeStr(quota.source, 64),
    reason: sanitizeStr(quota.reason || (requestedSupported && !hasUsedQuotaWindow ? 'no_used_quota_window' : null), 128),
    sampled_at: normalizeTimestamp(quota.sampled_at),
    primary,
    secondary,
    credits: quota.credits && typeof quota.credits === 'object'
      ? {
          total: clampNum(quota.credits.total, 0, 999999999),
          remaining: clampNum(quota.credits.remaining, 0, 999999999),
        }
      : null,
  };
}

function sanitizeUsageTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const cleaned = {
    input: clampInt(tokens.input ?? tokens.input_tokens),
    output: clampInt(tokens.output ?? tokens.output_tokens),
    cache_creation: clampInt(tokens.cache_creation ?? tokens.cache_creation_input_tokens),
    cache_read: clampInt(tokens.cache_read ?? tokens.cache_read_input_tokens),
    cached_input: clampInt(tokens.cached_input ?? tokens.cached_input_tokens),
    reasoning: clampInt(tokens.reasoning ?? tokens.reasoning_output_tokens),
    total: clampInt(tokens.total ?? tokens.total_tokens),
  };
  return Object.values(cleaned).some(v => v != null) ? cleaned : null;
}

function sanitizeUsageShape(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    supported: typeof usage.supported === 'boolean'
      ? usage.supported
      : !!(usage.session_tokens || usage.last_turn_tokens),
    source: sanitizeStr(usage.source, 64),
    reason: sanitizeStr(usage.reason, 128),
    sampled_at: normalizeTimestamp(usage.sampled_at),
    session_id: sanitizeStr(usage.session_id, 128),
    thread_id: sanitizeStr(usage.thread_id, 128),
    model: sanitizeStr(usage.model, 128),
    plan_type: sanitizeStr(usage.plan_type, 32),
    session_tokens: sanitizeUsageTokens(usage.session_tokens),
    last_turn_tokens: sanitizeUsageTokens(usage.last_turn_tokens),
    session_cost_usd: clampNum(usage.session_cost_usd, 0, 999999999),
    estimated_cost: typeof usage.estimated_cost === 'boolean' ? usage.estimated_cost : false,
    turns: clampInt(usage.turns, 0, 1000000),
    partial: typeof usage.partial === 'boolean' ? usage.partial : false,
  };
}

function sanitizeRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') return null;
  return {
    type: sanitizeEnum(runtime.type, ['claude_code', 'codex', 'openclaw', 'unknown'], 'unknown'),
    version: sanitizeStr(runtime.version, 64),
    status: sanitizeEnum(runtime.status, ['running', 'degraded', 'offline'], 'offline'),
    source: sanitizeStr(runtime.source, 64),
    detection_source: sanitizeStr(runtime.detection_source, 32),
    checked_at: normalizeTimestamp(runtime.checked_at) || Date.now(),
  };
}

// GET /api/agent-health/roster — roster data for all agents (花名册采集)
router.get('/roster', (req, res) => {
  const allHealth = db.getAllAgentHealth();
  const now = Date.now();
  const TEST_AGENTS = new Set(['healthy-bot', 'stall-bot', 'crit-bot', 'agent-a', 'agent-b', 'test-agent']);
  const roster = Object.entries(allHealth)
    .filter(([name]) => !TEST_AGENTS.has(name))
    .map(([name, health]) => ({
      name,
      reported_at: health.reported_at,
      stale: (now - health.reported_at) > STALE_THRESHOLD_MS,
      runtime_type: health.runtime?.type || null,
      runtime_version: health.runtime?.version || null,
      runtime_status: health.runtime?.status || null,
      roster: health.roster || null,
    }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({ count: roster.length, timestamp: now, agents: roster });
});

// POST /api/agent-health/:name — agent reports its system health (auth required)
router.post('/:name', requireHealthAuth, (req, res) => {
  const { name } = req.params;
  const agent = db.getAgent(name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { disk, memory, cpu, pm2, hostname, runtime, quota, usage, roster } = req.body;

  // Validate required fields
  if (!disk || !memory) {
    return res.status(400).json({ error: 'disk and memory are required' });
  }

  const diskPct = clampNum(disk.pct, 0, 100);
  const memPct = clampNum(memory.pct, 0, 100);

  const health = {
    hostname: sanitizeStr(hostname, 128),
    disk: {
      pct: diskPct,
      used: sanitizeStr(disk.used),
      total: sanitizeStr(disk.total),
      status: diskPct > 90 ? 'critical' : diskPct > 80 ? 'warning' : 'ok',
    },
    memory: {
      pct: memPct,
      used_gb: clampNum(memory.used_gb, 0, 99999),
      total_gb: clampNum(memory.total_gb, 0, 99999),
      status: memPct > 90 ? 'critical' : memPct > 80 ? 'warning' : 'ok',
    },
    cpu: cpu ? {
      pct: clampNum(cpu.pct, 0, 100),
      load_avg: Array.isArray(cpu.load_avg) ? cpu.load_avg.slice(0, 3).map(v => clampNum(v, 0, 9999)) : null,
      cores: clampNum(cpu.cores, 1, 1024),
    } : null,
    pm2: pm2 ? {
      online: clampNum(pm2.online, 0, 999),
      total: clampNum(pm2.total, 0, 999),
      services: (pm2.services || []).slice(0, 20).map(s => ({
        name: sanitizeStr(s.name, 64),
        status: sanitizeStr(s.status, 16),
        memory: clampNum(s.memory, 0, 999999999999),
        cpu: clampNum(s.cpu, 0, 100),
      })),
    } : null,
    runtime: sanitizeRuntime(runtime),
    quota: quota && typeof quota === 'object'
      ? Object.fromEntries(
          Object.entries(quota)
            .map(([key, value]) => [sanitizeStr(key, 64), sanitizeQuotaShape(value)])
            .filter(([key, value]) => key && value)
        )
      : null,
    usage: usage && typeof usage === 'object'
      ? Object.fromEntries(
          Object.entries(usage)
            .map(([key, value]) => [sanitizeStr(key, 64), sanitizeUsageShape(value)])
            .filter(([key, value]) => key && value)
        )
      : null,
    roster: roster && typeof roster === 'object' ? roster : null,
  };

  db.upsertAgentHealth(name, health);
  if (Math.random() < 0.01) db.pruneHealthHistory(Date.now() - 30 * 86400000);
  res.json({ ok: true });
});

// GET /api/agent-health — all agents' health
router.get('/', (req, res) => {
  const allHealth = db.getAllAgentHealth();
  const now = Date.now();
  const agents = db.getAllAgents();

  const result = agents.map(agent => {
    const health = allHealth[agent.name] || null;
    const stale = health ? (now - health.reported_at > STALE_THRESHOLD_MS) : true;

    // Determine overall status
    let overall = 'unknown';
    if (health && !stale) {
      const statuses = [health.disk.status, health.memory.status];
      if (health.pm2) {
        statuses.push(health.pm2.online === health.pm2.total && health.pm2.total > 0 ? 'ok' : health.pm2.online === 0 ? 'critical' : 'warning');
      }
      if (health.runtime?.status === 'degraded') statuses.push('warning');
      if (health.runtime?.status === 'offline' && agent.online) statuses.push('critical');
      overall = statuses.includes('critical') ? 'critical'
        : statuses.includes('warning') ? 'warning' : 'ok';
    }

    return {
      name: agent.name,
      online: !!agent.online,
      overall,
      stale,
      runtime: health?.runtime || null,
      quota: health?.quota || null,
      usage: health?.usage || null,
      health,
    };
  });

  res.json({ agents: result, timestamp: now });
});

// GET /api/agent-health/:name — single agent health
router.get('/:name', (req, res) => {
  const agent = db.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const health = db.getAgentHealth(req.params.name);
  const now = Date.now();
  const stale = health ? (now - health.reported_at > STALE_THRESHOLD_MS) : true;

  res.json({
    name: agent.name,
    online: !!agent.online,
    stale,
    health,
    timestamp: now,
  });
});

module.exports = router;
