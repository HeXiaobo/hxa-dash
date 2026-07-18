// Agent Health Reporting (#115)
// POST /api/agent-health/:name — agents push their system metrics (auth required)
// GET  /api/agent-health        — retrieve all agent health data
// GET  /api/agent-health/:name  — retrieve single agent health
const { Router } = require('express');
const db = require('../db');
const { hasApiKey } = require('../auth/api-key');
const { quotaForRead, usageForRead } = require('../agent-observability');

const router = Router();

// Max age before health data is considered stale (10 minutes)
const STALE_THRESHOLD_MS = 10 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 1000;

// Auth middleware for POST — requires Bearer token or X-API-Key header
function requireHealthAuth(req, res, next) {
  const keys = [process.env.HEALTH_API_KEY, process.env.HXA_INGEST_API_KEY].filter(Boolean);
  if (keys.length === 0) {
    // No key configured = reject all writes (fail-closed)
    return res.status(403).json({ error: 'HEALTH_API_KEY not configured on server' });
  }

  if (!hasApiKey(req, keys)) {
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
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  return Math.max(min, Math.min(max, Math.round(val * 10) / 10));
}

function clampInt(val, min = 0, max = 1e12) {
  if (typeof val !== 'number' || isNaN(val)) return null;
  return Math.max(min, Math.min(max, Math.round(val)));
}

function strictInt(val, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(val) || val < min || val > max) return null;
  return val;
}

function strictNumber(val, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) return null;
  return val;
}

function roundedStrictNumber(val, min, max) {
  const strict = strictNumber(val, min, max);
  return strict == null ? null : Math.round(strict * 10) / 10;
}

function sanitizeMemoryCapacity(memory) {
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
    return { used_gb: null, total_gb: null, capacity_reason: null };
  }

  const hasUsed = memory.used_gb != null;
  const hasTotal = memory.total_gb != null;
  if (!hasUsed && !hasTotal) {
    return {
      used_gb: null,
      total_gb: null,
      capacity_reason: memory.capacity_reason === 'invalid_value' ? 'invalid_value' : null,
    };
  }

  const usedGb = roundedStrictNumber(memory.used_gb, 0, 99_999);
  const totalGb = roundedStrictNumber(memory.total_gb, 0, 99_999);
  if (usedGb == null || totalGb == null || totalGb <= 0 || usedGb > totalGb) {
    return { used_gb: null, total_gb: null, capacity_reason: 'invalid_value' };
  }

  return { used_gb: usedGb, total_gb: totalGb, capacity_reason: null };
}

function sanitizeCpu(cpu, unavailableReason = null) {
  if (cpu == null) return null;
  if (unavailableReason) {
    return { pct: null, load_avg: null, cores: null, reason: unavailableReason };
  }
  if (typeof cpu !== 'object' || Array.isArray(cpu)) {
    return { pct: null, load_avg: null, cores: null, reason: 'invalid_value' };
  }
  if (cpu.reason != null && cpu.reason !== 'invalid_value') {
    return {
      pct: null,
      load_avg: null,
      cores: null,
      reason: sanitizeStr(cpu.reason, 64) || 'invalid_value',
    };
  }

  const hasSample = cpu.pct != null || cpu.load_avg != null || cpu.cores != null;
  let invalid = cpu.reason === 'invalid_value' || !hasSample;
  const pct = cpu.pct == null ? null : roundedStrictNumber(cpu.pct, 0, 100);
  if (cpu.pct != null && pct == null) invalid = true;

  let loadAvg = null;
  if (cpu.load_avg != null) {
    if (!Array.isArray(cpu.load_avg) || cpu.load_avg.length !== 3) {
      invalid = true;
    } else {
      const normalized = cpu.load_avg.map(value => roundedStrictNumber(value, 0, 9_999));
      if (normalized.some(value => value == null)) invalid = true;
      else loadAvg = normalized;
    }
  }

  const cores = cpu.cores == null ? null : strictInt(cpu.cores, 1, 1_024);
  if (cpu.cores != null && cores == null) invalid = true;

  return {
    pct,
    load_avg: loadAvg,
    cores,
    reason: invalid ? 'invalid_value' : null,
  };
}

function sanitizePm2Service(service) {
  if (!service || typeof service !== 'object' || Array.isArray(service)) return null;
  let invalid = service.reason === 'invalid_value';
  const memory = service.memory == null
    ? null
    : strictInt(service.memory, 0, 999_999_999_999);
  if (service.memory != null && memory == null) invalid = true;
  const cpu = service.cpu == null ? null : roundedStrictNumber(service.cpu, 0, 100);
  if (service.cpu != null && cpu == null) invalid = true;

  return {
    name: sanitizeStr(service.name, 64),
    status: sanitizeStr(service.status, 16),
    memory,
    cpu,
    reason: invalid ? 'invalid_value' : null,
  };
}

function sanitizePm2(pm2, unavailableReason = null) {
  if (pm2 == null) return null;
  if (unavailableReason) {
    return { online: null, total: null, services: [], reason: unavailableReason };
  }
  if (typeof pm2 !== 'object' || Array.isArray(pm2)) {
    return { online: null, total: null, services: [], reason: 'invalid_value' };
  }
  if (pm2.reason != null && pm2.reason !== 'invalid_value') {
    return {
      online: null,
      total: null,
      services: [],
      reason: sanitizeStr(pm2.reason, 64) || 'invalid_value',
    };
  }

  const rawOnline = strictInt(pm2.online, 0, 999);
  const rawTotal = strictInt(pm2.total, 0, 999);
  const invalidCounts = rawOnline == null || rawTotal == null || rawOnline > rawTotal;
  let invalidServices = pm2.reason === 'invalid_value'
    || (pm2.services != null && !Array.isArray(pm2.services));
  const services = Array.isArray(pm2.services)
    ? pm2.services.slice(0, 20).map(sanitizePm2Service).filter(service => {
        if (!service) invalidServices = true;
        return service != null;
      })
    : [];
  if (services.some(service => service.reason != null)) invalidServices = true;

  return {
    online: invalidCounts ? null : rawOnline,
    total: invalidCounts ? null : rawTotal,
    services,
    reason: invalidCounts || invalidServices ? 'invalid_value' : null,
  };
}

function normalizeTimestamp(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timestampMs(val) {
  const normalized = normalizeTimestamp(val);
  return normalized != null && normalized < 1e12 ? normalized * 1000 : normalized;
}

function evidenceReadReason(val, now = Date.now()) {
  const observedAt = timestampMs(val);
  if (observedAt == null) return 'sample_time_unavailable';
  if (observedAt > now + FUTURE_SKEW_MS || now - observedAt > STALE_THRESHOLD_MS) return 'stale_sample';
  return null;
}

function unavailableBackupForRead(reason) {
  return {
    supported: false,
    status: 'unsupported',
    reason,
    sampled_at: null,
    cron: null,
    summary: {
      total: null,
      ok: null,
      warning: null,
      critical: null,
      unsupported: null,
      ahead: null,
      behind: null,
      dirty: null,
      untracked: null,
      counter_evidence_complete: false,
      github_remotes: null,
    },
    repos: [],
  };
}

function requiredMetricForRead(metric, kind = 'disk') {
  const pct = metric?.pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    return unavailableRequiredMetricForRead('invalid_value');
  }
  return {
    ...metric,
    ...(kind === 'memory' ? sanitizeMemoryCapacity(metric) : {}),
    pct,
    status: pct > 90 ? 'critical' : pct > 80 ? 'warning' : 'ok',
    reason: null,
  };
}

function unavailableRequiredMetricForRead(reason) {
  return {
    pct: null,
    status: 'unknown',
    used: null,
    total: null,
    used_gb: null,
    total_gb: null,
    reason,
  };
}

function unavailableRuntimeForRead(reason) {
  return {
    type: null,
    version: null,
    status: null,
    source: null,
    detection_source: null,
    checked_at: null,
    reason,
  };
}

function runtimeForRead(runtime, { now, reportedAt }) {
  if (!runtime || typeof runtime !== 'object') return runtime || null;
  const reason = evidenceReadReason(reportedAt, now)
    || evidenceReadReason(runtime.checked_at, now);
  return reason ? unavailableRuntimeForRead(reason) : { ...runtime, reason: null };
}

function unavailableRosterForRead(reason) {
  return {
    session_id: null,
    model: null,
    model_display: null,
    version: null,
    runtime_type: null,
    cost_usd: null,
    lines_added: null,
    lines_removed: null,
    context_used_pct: null,
    context_used_tokens: null,
    context_total_tokens: null,
    rate_limits: null,
    plan_type: null,
    sampled_at: null,
    reason,
  };
}

function rosterForRead(roster, { now, reportedAt }) {
  if (!roster || typeof roster !== 'object') return roster || null;
  const normalized = sanitizeRoster(roster);
  const reason = evidenceReadReason(reportedAt, now)
    || evidenceReadReason(normalized?.sampled_at, now);
  return reason ? unavailableRosterForRead(reason) : { ...normalized, reason: null };
}

function unavailableActivityForRead(reason) {
  return {
    state: null,
    health: null,
    observed_at: null,
    source: null,
    used_for_routing: false,
    reason,
  };
}

function activityForRead(activity, { now, reportedAt }) {
  if (!activity || typeof activity !== 'object') return activity || null;
  const reason = evidenceReadReason(reportedAt, now)
    || evidenceReadReason(activity.observed_at, now);
  return reason ? unavailableActivityForRead(reason) : { ...activity, reason: null };
}

function healthForRead(health, now = Date.now()) {
  if (!health || typeof health !== 'object') return health || null;
  const reportReason = evidenceReadReason(health.reported_at, now);
  const backupReason = health.backup
    ? reportReason || evidenceReadReason(health.backup.sampled_at, now)
    : null;
  const readableUsage = health.usage && typeof health.usage === 'object'
    ? Object.fromEntries(Object.entries(health.usage).map(([key, value]) => [
        key,
        usageForRead(value, { now, reportedAt: health.reported_at }),
      ]))
    : health.usage;
  const readableQuota = health.quota && typeof health.quota === 'object'
    ? Object.fromEntries(Object.entries(health.quota).map(([key, value]) => [
        key,
        quotaForRead(value, { now, reportedAt: health.reported_at }),
      ]))
    : health.quota;

  return {
    ...health,
    disk: reportReason
      ? unavailableRequiredMetricForRead(reportReason)
      : requiredMetricForRead(health.disk),
    memory: reportReason
      ? unavailableRequiredMetricForRead(reportReason)
      : requiredMetricForRead(health.memory, 'memory'),
    cpu: health.cpu == null ? null : sanitizeCpu(health.cpu, reportReason),
    pm2: health.pm2 == null ? null : sanitizePm2(health.pm2, reportReason),
    ...(health.backup ? {
      backup: backupReason ? unavailableBackupForRead(backupReason) : health.backup,
    } : {}),
    ...(health.usage ? { usage: readableUsage } : {}),
    ...(health.quota ? { quota: readableQuota } : {}),
    ...(health.runtime ? {
      runtime: runtimeForRead(health.runtime, { now, reportedAt: health.reported_at }),
    } : {}),
    ...(health.roster ? {
      roster: rosterForRead(health.roster, { now, reportedAt: health.reported_at }),
    } : {}),
    ...(health.activity_monitor ? {
      activity_monitor: activityForRead(health.activity_monitor, { now, reportedAt: health.reported_at }),
    } : {}),
  };
}

function sanitizeEnum(val, allowed, fallback = null) {
  const normalized = sanitizeStr(val, 64)?.toLowerCase() || null;
  return normalized && allowed.includes(normalized) ? normalized : fallback;
}

function sanitizeRemoteUrl(val) {
  const raw = sanitizeStr(val, 512);
  if (!raw) return null;

  const hasCredentialPath = value => {
    let decoded = String(value || '');
    let stable = false;
    for (let pass = 0; pass < 8; pass += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          stable = true;
          break;
        }
        decoded = next;
      } catch {
        return true;
      }
    }
    if (!stable) return true;
    return /(?:^|[^A-Za-z0-9_-])(?:x-access-token|oauth2|access[_-]?token|private[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|secret|token)(?:[^A-Za-z0-9_-]|$)/i.test(decoded)
      || /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{6,}/i.test(decoded);
  };

  const withoutSuffix = raw.replace(/[?#].*$/, '');
  if (!withoutSuffix.includes('://')) {
    const scp = withoutSuffix.match(/^(?:[^@\s/:]+@)?([A-Za-z0-9.-]+):([^\s]+)$/);
    if (!scp || scp[2].includes('@') || hasCredentialPath(scp[2])) return null;
    const [, host, repoPath] = scp;
    return (host.toLowerCase() === 'github.com'
      ? `git@${host}:${repoPath}`
      : `${host}:${repoPath}`).slice(0, 256);
  }

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
    if (hasCredentialPath(parsed.pathname)) return null;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '').slice(0, 256);
  } catch {
    return null;
  }
}

function sanitizeQuotaWindow(window, fallbackLabel = null) {
  if (!window || typeof window !== 'object') return null;
  const rawUsedPercent = typeof window.used_percent === 'number'
    ? window.used_percent
    : typeof window.used_percentage === 'number'
      ? window.used_percentage
      : null;
  const usedPercent = rawUsedPercent != null
    && Number.isFinite(rawUsedPercent)
    && rawUsedPercent >= 0
    && rawUsedPercent <= 100
    ? Math.round(rawUsedPercent * 10) / 10
    : null;
  const resetsAt = normalizeTimestamp(window.resets_at);
  const windowMinutes = typeof window.window_minutes === 'number'
    && Number.isFinite(window.window_minutes)
    && window.window_minutes > 0
    && window.window_minutes <= 60 * 24 * 365
    ? Math.round(window.window_minutes * 10) / 10
    : null;
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

function sanitizeUsageTokenEvidence(tokens) {
  if (!tokens || typeof tokens !== 'object') return { value: null, invalid: false };
  const raw = {
    input: tokens.input ?? tokens.input_tokens,
    output: tokens.output ?? tokens.output_tokens,
    cache_creation: tokens.cache_creation ?? tokens.cache_creation_input_tokens,
    cache_read: tokens.cache_read ?? tokens.cache_read_input_tokens,
    cached_input: tokens.cached_input ?? tokens.cached_input_tokens,
    reasoning: tokens.reasoning ?? tokens.reasoning_output_tokens,
    total: tokens.total ?? tokens.total_tokens,
  };
  const invalid = Object.values(raw)
    .some(value => value != null && strictInt(value) == null);
  if (invalid) return { value: null, invalid: true };
  const cleaned = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, strictInt(value)])
  );
  return {
    value: Object.values(cleaned).some(value => value != null) ? cleaned : null,
    invalid: false,
  };
}

function sanitizeUsageShape(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const sessionTokens = sanitizeUsageTokenEvidence(usage.session_tokens);
  const lastTurnTokens = sanitizeUsageTokenEvidence(usage.last_turn_tokens);
  const cost = strictNumber(usage.session_cost_usd, 0, 999999999);
  const costInvalid = usage.session_cost_usd != null && cost == null;
  const estimatedCostInvalid = usage.estimated_cost != null && typeof usage.estimated_cost !== 'boolean';
  const evidenceInvalid = sessionTokens.invalid || lastTurnTokens.invalid || costInvalid || estimatedCostInvalid;
  return {
    supported: typeof usage.supported === 'boolean'
      ? usage.supported
      : !!(usage.session_tokens || usage.last_turn_tokens),
    source: sanitizeStr(usage.source, 64),
    reason: sanitizeStr(usage.reason, 128) || (evidenceInvalid ? 'invalid_value' : null),
    sampled_at: normalizeTimestamp(usage.sampled_at),
    session_id: sanitizeStr(usage.session_id, 128),
    thread_id: sanitizeStr(usage.thread_id, 128),
    model: sanitizeStr(usage.model, 128),
    model_source: sanitizeStr(usage.model_source, 64),
    model_sampled_at: normalizeTimestamp(usage.model_sampled_at),
    plan_type: sanitizeStr(usage.plan_type, 32),
    session_tokens: sessionTokens.value,
    last_turn_tokens: lastTurnTokens.value,
    session_cost_usd: cost,
    cost_source: sanitizeStr(usage.cost_source, 64),
    cost_sampled_at: normalizeTimestamp(usage.cost_sampled_at),
    estimated_cost: typeof usage.estimated_cost === 'boolean' ? usage.estimated_cost : null,
    turns: strictInt(usage.turns, 0, 1000000),
    partial: typeof usage.partial === 'boolean' ? usage.partial : null,
  };
}

function sanitizeRosterRateLimit(window) {
  if (!window || typeof window !== 'object') return null;
  const rawUsedPct = window.used_pct ?? window.used_percentage;
  const usedPct = strictNumber(rawUsedPct, 0, 100);
  const resetsAt = normalizeTimestamp(window.resets_at);
  if (usedPct == null && resetsAt == null) return null;
  return {
    used_pct: usedPct == null ? null : Math.round(usedPct * 10) / 10,
    resets_at: resetsAt,
  };
}

function sanitizeRoster(roster) {
  if (!roster || typeof roster !== 'object') return null;
  const fiveHour = sanitizeRosterRateLimit(roster.rate_limits?.five_hour);
  const sevenDay = sanitizeRosterRateLimit(roster.rate_limits?.seven_day);
  return {
    session_id: sanitizeStr(roster.session_id, 128),
    model: sanitizeStr(roster.model, 128),
    model_display: sanitizeStr(roster.model_display, 128),
    version: sanitizeStr(roster.version, 64),
    runtime_type: sanitizeEnum(roster.runtime_type, ['claude_code', 'codex', 'openclaw', 'unknown']),
    cost_usd: strictNumber(roster.cost_usd, 0, 999999999),
    lines_added: strictInt(roster.lines_added),
    lines_removed: strictInt(roster.lines_removed),
    context_used_pct: strictNumber(roster.context_used_pct, 0, 100),
    context_used_tokens: strictInt(roster.context_used_tokens),
    context_total_tokens: strictInt(roster.context_total_tokens),
    rate_limits: fiveHour || sevenDay
      ? { five_hour: fiveHour, seven_day: sevenDay }
      : null,
    plan_type: sanitizeStr(roster.plan_type, 32),
    sampled_at: normalizeTimestamp(roster.sampled_at),
  };
}

function sanitizeActivityMonitor(activity) {
  if (!activity || typeof activity !== 'object') return null;
  if (activity.source !== 'activity_monitor_fallback' || activity.used_for_routing !== false) return null;
  const state = sanitizeEnum(activity.state, ['busy', 'idle', 'waiting', 'offline', 'unknown']);
  const health = sanitizeEnum(activity.health, ['ok', 'unavailable']);
  const observedAt = normalizeTimestamp(activity.observed_at ?? activity.sampled_at);
  if (!state || !health || observedAt == null) return null;
  return {
    state,
    health,
    observed_at: observedAt,
    source: 'activity_monitor_fallback',
    used_for_routing: false,
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
    checked_at: normalizeTimestamp(runtime.checked_at),
  };
}

function sanitizeBackupRepo(repo) {
  if (!repo || typeof repo !== 'object') return null;
  return {
    path: sanitizeStr(repo.path, 512),
    remote: sanitizeRemoteUrl(repo.remote),
    branch: sanitizeStr(repo.branch, 128),
    head: sanitizeStr(repo.head, 64),
    upstream: sanitizeStr(repo.upstream, 128),
    ahead: strictInt(repo.ahead, 0, 1000000),
    behind: strictInt(repo.behind, 0, 1000000),
    dirty: strictInt(repo.dirty, 0, 1000000),
    untracked: strictInt(repo.untracked, 0, 1000000),
    last_commit_at: normalizeTimestamp(repo.last_commit_at) || null,
    status: sanitizeEnum(repo.status, ['ok', 'warning', 'critical', 'unsupported'], 'critical'),
    reason: sanitizeStr(repo.reason, 128),
  };
}

function sanitizeBackupSummary(summary, repos) {
  const repoList = Array.isArray(repos) ? repos : [];
  const repoCountersComplete = repoList.length > 0
    && repoList.every(repo => ['ahead', 'behind', 'dirty', 'untracked']
      .every(key => strictInt(repo?.[key], 0, 1000000) != null));
  const counterTotal = key => repoCountersComplete
    ? repoList.reduce((sum, repo) => sum + strictInt(repo[key], 0, 1000000), 0)
    : null;
  const counters = Object.fromEntries(
    ['ahead', 'behind', 'dirty', 'untracked'].map(key => [key, counterTotal(key)]),
  );
  return {
    total: clampInt(summary?.total, 0, 1000000) ?? repoList.length,
    ok: clampInt(summary?.ok, 0, 1000000) ?? repoList.filter(repo => repo.status === 'ok').length,
    warning: clampInt(summary?.warning, 0, 1000000) ?? repoList.filter(repo => repo.status === 'warning').length,
    critical: clampInt(summary?.critical, 0, 1000000) ?? repoList.filter(repo => repo.status === 'critical').length,
    unsupported: clampInt(summary?.unsupported, 0, 1000000) ?? repoList.filter(repo => repo.status === 'unsupported').length,
    ...counters,
    counter_evidence_complete: repoCountersComplete,
    github_remotes: clampInt(summary?.github_remotes, 0, 1000000) ?? repoList.filter(repo => /(^|[/:@])github\.com[/:]/i.test(String(repo.remote || ''))).length,
  };
}

function sanitizeBackupCron(cron) {
  if (!cron || typeof cron !== 'object') return null;
  return {
    supported: typeof cron.supported === 'boolean' ? cron.supported : false,
    status: sanitizeEnum(cron.status, ['ok', 'warning', 'critical', 'unsupported'], cron.supported === false ? 'unsupported' : 'warning'),
    reason: sanitizeStr(cron.reason, 128),
    log_path: sanitizeStr(cron.log_path, 512),
    last_success_at: normalizeTimestamp(cron.last_success_at) || null,
    last_run_at: normalizeTimestamp(cron.last_run_at) || null,
    latest_line: sanitizeStr(cron.latest_line, 240),
  };
}

function sanitizeBackup(backup) {
  if (!backup || typeof backup !== 'object') return null;
  const repos = Array.isArray(backup.repos)
    ? backup.repos.slice(0, 80).map(sanitizeBackupRepo).filter(Boolean)
    : [];
  const cron = sanitizeBackupCron(backup.cron);
  return {
    supported: typeof backup.supported === 'boolean' ? backup.supported : repos.length > 0 || !!cron?.supported,
    status: sanitizeEnum(backup.status, ['ok', 'warning', 'critical', 'unsupported'], backup.supported === false ? 'unsupported' : 'critical'),
    reason: sanitizeStr(backup.reason, 128),
    sampled_at: normalizeTimestamp(backup.sampled_at),
    cron,
    summary: sanitizeBackupSummary(backup.summary, repos),
    repos,
  };
}

// GET /api/agent-health/roster — roster data for all agents (花名册采集)
router.get('/roster', (req, res) => {
  const allHealth = db.getAllAgentHealth();
  const now = Date.now();
  const TEST_AGENTS = new Set(['healthy-bot', 'stall-bot', 'crit-bot', 'agent-a', 'agent-b', 'test-agent']);
  const roster = Object.entries(allHealth)
    .filter(([name]) => !TEST_AGENTS.has(name))
    .map(([name, health]) => {
      const reportReason = evidenceReadReason(health.reported_at, now);
      const readableHealth = healthForRead(health, now);
      return {
        name,
        reported_at: reportReason ? null : timestampMs(health.reported_at),
        stale: reportReason != null,
        runtime_type: readableHealth?.runtime?.type || null,
        runtime_version: readableHealth?.runtime?.version || null,
        runtime_status: readableHealth?.runtime?.status || null,
        roster: readableHealth?.roster || null,
      };
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({ count: roster.length, timestamp: now, agents: roster });
});

// POST /api/agent-health/:name — agent reports its system health (auth required)
router.post('/:name', requireHealthAuth, (req, res) => {
  const agent = db.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  // Use the canonical roster name so health keys line up with getAllAgents()
  const name = agent.name;

  const { disk, memory, cpu, pm2, hostname, runtime, quota, usage, backup, roster, activity_monitor: activityMonitor } = req.body;

  // Validate required fields
  if (!disk || !memory) {
    return res.status(400).json({ error: 'disk and memory are required' });
  }

  const rawDiskPct = strictNumber(disk.pct, 0, 100);
  const rawMemPct = strictNumber(memory.pct, 0, 100);
  if (rawDiskPct == null || rawMemPct == null) {
    return res.status(400).json({ error: 'disk.pct and memory.pct must be finite numbers between 0 and 100' });
  }
  const diskPct = clampNum(rawDiskPct, 0, 100);
  const memPct = clampNum(rawMemPct, 0, 100);
  const memoryCapacity = sanitizeMemoryCapacity(memory);

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
      ...memoryCapacity,
      status: memPct > 90 ? 'critical' : memPct > 80 ? 'warning' : 'ok',
    },
    cpu: sanitizeCpu(cpu),
    pm2: sanitizePm2(pm2),
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
    backup: sanitizeBackup(backup),
    roster: sanitizeRoster(roster),
    activity_monitor: sanitizeActivityMonitor(activityMonitor),
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
    const stale = health ? evidenceReadReason(health.reported_at, now) != null : true;
    const readableHealth = healthForRead(health, now);

    // Determine overall status
    let overall = 'unknown';
    const requiredMetricsComplete = readableHealth?.disk?.status !== 'unknown'
      && readableHealth?.memory?.status !== 'unknown';
    const optionalHardwareInvalid = readableHealth?.memory?.capacity_reason != null
      || readableHealth?.cpu?.reason != null
      || readableHealth?.pm2?.reason != null;
    if (health && !stale && requiredMetricsComplete && !optionalHardwareInvalid) {
      const statuses = [readableHealth.disk.status, readableHealth.memory.status];
      if (readableHealth.pm2) {
        statuses.push(readableHealth.pm2.online === readableHealth.pm2.total && readableHealth.pm2.total > 0 ? 'ok' : readableHealth.pm2.online === 0 ? 'critical' : 'warning');
      }
      if (readableHealth.runtime?.status === 'degraded') statuses.push('warning');
      if (readableHealth.runtime?.status === 'offline' && agent.online) statuses.push('critical');
      overall = statuses.includes('critical') ? 'critical'
        : statuses.includes('warning') ? 'warning' : 'ok';
    }

    return {
      name: agent.name,
      online: !!agent.online,
      overall,
      stale,
      runtime: readableHealth?.runtime || null,
      quota: readableHealth?.quota || null,
      usage: readableHealth?.usage || null,
      backup: readableHealth?.backup || null,
      health: readableHealth,
    };
  });

  res.json({ agents: result, timestamp: now });
});

// GET /api/agent-health/:name — single agent health
router.get('/:name', (req, res) => {
  const agent = db.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const health = db.getAgentHealth(agent.name);
  const now = Date.now();
  const stale = health ? evidenceReadReason(health.reported_at, now) != null : true;
  const readableHealth = healthForRead(health, now);

  res.json({
    name: agent.name,
    online: !!agent.online,
    stale,
    health: readableHealth,
    timestamp: now,
  });
});

module.exports = router;
module.exports.__private = {
  sanitizeActivityMonitor,
  sanitizeBackup,
  sanitizeQuotaWindow,
  sanitizeRuntime,
  sanitizeRoster,
  sanitizeUsageShape,
};
