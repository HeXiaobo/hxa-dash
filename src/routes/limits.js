const { Router } = require('express');
const { buildAgents } = require('./team');

const router = Router();
const QUOTA_STALE_MS = 10 * 60 * 1000;

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function quotaFreshness(quota, fallbackSampledAt, now = Date.now()) {
  if (!quota?.supported) {
    return { status: 'unsupported', sampled_at: normalizeTimestamp(quota?.sampled_at) || null, age_ms: null, stale_after_ms: QUOTA_STALE_MS };
  }

  const sampledAt = normalizeTimestamp(quota.sampled_at) || normalizeTimestamp(fallbackSampledAt);
  const ageMs = sampledAt ? Math.max(0, now - sampledAt) : null;
  const stale = !sampledAt || ageMs > QUOTA_STALE_MS;
  return {
    status: stale ? 'stale' : 'fresh',
    sampled_at: sampledAt,
    age_ms: ageMs,
    stale_after_ms: QUOTA_STALE_MS,
  };
}

function enrichQuota(quota, fallbackSampledAt, now = Date.now()) {
  if (!quota || typeof quota !== 'object') return quota;
  const freshness = quotaFreshness(quota, fallbackSampledAt, now);
  return {
    ...quota,
    sampled_at: freshness.sampled_at || quota.sampled_at || null,
    freshness,
  };
}

function nextResetAt(agents) {
  const timestamps = agents.flatMap(agent => [
    agent.quota?.primary?.resets_at || null,
    agent.quota?.secondary?.resets_at || null,
  ].filter(Boolean));
  if (timestamps.length === 0) return null;
  return Math.min(...timestamps);
}

router.get('/', (req, res) => {
  const now = Date.now();
  const agents = buildAgents().map(agent => {
    const quota = enrichQuota(agent.quota, agent.last_heartbeat_at, now);
    return {
      name: agent.name,
      role: agent.role || '',
      work_state: agent.work_state,
      runtime_status: agent.runtime_status,
      runtime: agent.runtime,
      quota,
      usage: agent.usage,
      last_active_at: agent.last_active_at,
      last_heartbeat_at: agent.last_heartbeat_at,
    };
  });

  const supported = agents.filter(agent => agent.quota?.supported);
  const freshSupported = supported.filter(agent => agent.quota?.freshness?.status === 'fresh');
  const staleSupported = supported.filter(agent => agent.quota?.freshness?.status === 'stale');
  const usageTracked = agents.filter(agent => agent.usage?.supported);
  const warningCount = freshSupported.filter(agent => {
    const primary = agent.quota?.primary?.used_percent || 0;
    const secondary = agent.quota?.secondary?.used_percent || 0;
    return primary >= 80 || secondary >= 80;
  }).length;

  res.json({
    timestamp: now,
    team: {
      total: agents.length,
      tracked: freshSupported.length,
      stale_count: staleSupported.length,
      unsupported: agents.length - supported.length,
      usage_tracked: usageTracked.length,
      warning_count: warningCount,
      next_reset_at: nextResetAt(freshSupported),
      runtime_distribution: agents.reduce((acc, agent) => {
        const type = agent.runtime?.type || 'unknown';
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {}),
    },
    agents,
  });
});

module.exports = router;
module.exports.__private = { QUOTA_STALE_MS, enrichQuota, quotaFreshness };
