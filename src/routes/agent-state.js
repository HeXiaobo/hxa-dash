const { Router } = require('express');
const { redactSecretShaped } = require('../secret-shapes');
const db = require('../db');
const entity = require('../entity');
const { hasApiKey } = require('../auth/api-key');

const FRESH_THRESHOLD_MS = 30_000;
const FUTURE_SKEW_MS = 5_000;
const FRESHNESS_TOLERANCE_MS = 5_000;
const DEGRADATION_REASONS = new Set([
  'read_key_missing',
  'auth_failed',
  'token_exchange_unreachable',
  'token_exchange_failed',
  'state_unreachable',
  'state_unavailable',
  'state_timestamp_invalid',
  'identity_mismatch',
  'dashboard_state_stale',
  'dashboard_unreachable',
  'invalid_base_url',
]);

function requireAgentStateAuth(req, res, next) {
  const name = req.params.name;
  let configured = false;
  let key = null;
  const keyMapJson = process.env.DASHBOARD_STATE_INGEST_KEYS_JSON;
  if (keyMapJson) {
    try {
      const keyMap = JSON.parse(keyMapJson);
      if (keyMap && typeof keyMap === 'object' && !Array.isArray(keyMap)) {
        const entries = Object.entries(keyMap)
          .filter(([agentName, value]) => (
            /^[A-Za-z0-9._-]{1,64}$/.test(agentName)
            && typeof value === 'string'
            && value.length > 0
            && value.length <= 8192
          ));
        configured = entries.length > 0;
        key = entries.find(([agentName]) => agentName === name)?.[1] || null;
      }
    } catch {
      configured = false;
    }
  } else {
    const legacyKey = process.env.DASHBOARD_STATE_INGEST_API_KEY;
    const legacyAgent = process.env.DASHBOARD_STATE_INGEST_AGENT_NAME;
    configured = typeof legacyKey === 'string'
      && legacyKey.length > 0
      && legacyKey.length <= 8192
      && /^[A-Za-z0-9._-]{1,64}$/.test(legacyAgent || '');
    key = configured && legacyAgent === name ? legacyKey : null;
  }
  if (!configured) {
    return res.status(403).json({ error: 'dashboard_state_ingest_not_configured' });
  }
  if (!key || !hasApiKey(req, [key])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function isCanonicalAgent(name, stateDb = db, entityStore = entity) {
  return !!entityStore.get(name) || !!stateDb.getAgent(name);
}

// Same credential-shape guard as agent-health's sanitizeStr — this is the second
// ingest sanitization point; fixing only one would leave half the surface open.
function sanitizeString(value, maxLength = 64) {
  if (typeof value !== 'string') return null;
  const guarded = redactSecretShaped(value);
  if (guarded !== value) return guarded;
  return value.replace(/<[^>]*>/g, '').slice(0, maxLength);
}

function sanitizeIdentifier(value, maxLength = 64) {
  const cleaned = sanitizeString(value, maxLength);
  if (!cleaned || !/^[A-Za-z0-9._:/-]+$/.test(cleaned)) return null;
  if (/zylos_(?:ak|st)_/i.test(cleaned)) return null;
  if (/^(?:sk|gh[pousr]|xox[baprs])[-_]/i.test(cleaned)) return null;
  if (/^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(cleaned)) return null;
  if (/^[a-f0-9]{32,}$/i.test(cleaned)) return null;
  return cleaned;
}

function sanitizePattern(value, maxLength, pattern) {
  const cleaned = sanitizeIdentifier(value, maxLength);
  return cleaned && pattern.test(cleaned) ? cleaned : null;
}

function sanitizeDashboardVersion(value) {
  return sanitizePattern(value, 32, /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
}

function sanitizeRuntimeType(value) {
  return sanitizeEnum(value, ['codex', 'claude', 'openclaw']);
}

function sanitizeRuntimeModel(value) {
  return sanitizePattern(
    value,
    64,
    /^(?:gpt-|codex(?:-|$)|claude-|gemini-|deepseek-|qwen|glm-|kimi|o[134](?:-|$))[A-Za-z0-9._-]*$/i
  );
}

function sanitizeRuntimeVersion(value) {
  return sanitizePattern(value, 64, /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
}

function sanitizeEnum(value, allowed) {
  const cleaned = sanitizeString(value, 32);
  return cleaned && allowed.includes(cleaned) ? cleaned : null;
}

function clampNumber(value, min = 0, max = 100) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, Math.round(value * 10) / 10));
}

function clampInt(value, min = 0, max = 1000) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sanitizeOperationalReason(value) {
  const cleaned = sanitizeString(value, 128);
  if (!cleaned) return null;
  const fixed = new Set([
    'AM heartbeat unavailable — session liveness unconfirmed',
    'Agent session is not responding',
    'No active task',
  ]);
  if (fixed.has(cleaned)) return cleaned;
  const patterns = [
    /^Executing [A-Za-z0-9_.:-]+ \(\d+s\)$/,
    /^[A-Za-z0-9_.:-]+ tool running for \d+s(?: with no progress)?$/,
    /^Turn open for \d+s(?: with no progress| without recent activity)?$/,
    /^Thinking \(\d+s\)$/,
  ];
  return patterns.some(pattern => pattern.test(cleaned)) ? cleaned : null;
}

function sanitizeDashboardPayload(payload, name) {
  if (!payload || payload.schema_version !== 1 || payload.agent?.name !== name) return null;
  const state = sanitizeEnum(payload.agent.state, ['UNKNOWN', 'OFFLINE', 'STUCK', 'POSSIBLY_STUCK', 'BUSY', 'IDLE']);
  const confidence = sanitizeEnum(payload.agent.confidence, ['HIGH', 'MEDIUM', 'LOW']);
  if (!state || !confidence) return null;
  return {
    schema_version: 1,
    dashboard: {
      version: sanitizeDashboardVersion(payload.dashboard?.version),
    },
    agent: {
      name,
      state,
      confidence,
      reason: sanitizeOperationalReason(payload.agent.reason),
      active_subagent_count: clampInt(payload.agent.active_subagent_count),
    },
    runtime: {
      type: sanitizeRuntimeType(payload.runtime?.type),
      model: sanitizeRuntimeModel(payload.runtime?.model),
      effort: sanitizeEnum(payload.runtime?.effort, ['low', 'medium', 'high', 'xhigh', 'auto', 'none']),
      version: sanitizeRuntimeVersion(payload.runtime?.version),
      pending_restart: payload.runtime?.pending_restart === true,
    },
    capacity: {
      context_pct: clampNumber(payload.capacity?.context_pct),
      rate_limit_pct: clampNumber(payload.capacity?.rate_limit_pct),
      rate_limit_7d_pct: clampNumber(payload.capacity?.rate_limit_7d_pct),
    },
    system: {
      cpu_pct: clampNumber(payload.system?.cpu_pct),
      mem_pct: clampNumber(payload.system?.mem_pct),
      disk_pct: clampNumber(payload.system?.disk_pct),
    },
  };
}

function sanitizeHealthPayload(payload) {
  if (!payload || payload.schema_version !== 1 || !payload.dashboard) return null;
  return {
    schema_version: 1,
    dashboard: {
      ok: payload.dashboard.ok === true,
      service: payload.dashboard.service === 'zylos-dashboard' ? 'zylos-dashboard' : null,
      uptime_seconds: clampNumber(payload.dashboard.uptime_seconds, 0, 1e12),
    },
  };
}

function sanitizeDegradedReason(value) {
  return DEGRADATION_REASONS.has(value) ? value : 'unclassified_degradation';
}

function presentState(stored, now = Date.now()) {
  if (!stored) return null;
  const freshnessMs = stored.observed_at == null
    ? null
    : Math.max(0, now - stored.observed_at);
  const stale = freshnessMs == null || freshnessMs > FRESH_THRESHOLD_MS;
  const centrallyStale = stale && stored.status === 'fresh';
  return {
    source: stored.source,
    status: centrallyStale ? 'stale' : stored.status,
    used_for_routing: centrallyStale ? false : stored.used_for_routing,
    observed_at: stored.observed_at == null ? null : new Date(stored.observed_at).toISOString(),
    received_at: new Date(stored.received_at).toISOString(),
    freshness_ms: freshnessMs,
    stale,
    degraded: centrallyStale ? true : stored.degraded,
    ...((centrallyStale || stored.degraded_reason) ? {
      degraded_reason: centrallyStale ? 'central_state_stale' : stored.degraded_reason,
    } : {}),
    payload: stored.payload,
  };
}

function createAgentStateRouter({ stateDb = db, entityStore = entity, now = () => Date.now() } = {}) {
  const router = Router();

router.post('/:name', requireAgentStateAuth, (req, res) => {
  const { name } = req.params;
  if (!isCanonicalAgent(name, stateDb, entityStore)) return res.status(404).json({ error: 'Agent not found' });

  const body = req.body || {};
  const observedAt = body.observed_at == null ? null : Date.parse(body.observed_at);
  const receivedAt = now();
  const freshnessMs = observedAt == null ? null : receivedAt - observedAt;
  const clientFreshnessValid = body.source === 'none'
    ? body.freshness_ms === null
    : typeof body.freshness_ms === 'number'
      && Number.isFinite(body.freshness_ms)
      && body.freshness_ms >= 0;
  const freshnessConsistent = body.source === 'none'
    || Math.abs(body.freshness_ms - Math.max(0, freshnessMs)) <= FRESHNESS_TOLERANCE_MS;
  let payload = null;
  let state = null;

  if (
    body.source === 'dashboard_api'
    && body.status === 'fresh'
    && body.used_for_routing === true
    && body.degraded === false
    && freshnessMs != null
    && freshnessMs <= FRESH_THRESHOLD_MS
  ) {
    payload = sanitizeDashboardPayload(body.payload, name);
    if (payload) {
      state = {
        source: 'dashboard_api',
        status: 'fresh',
        used_for_routing: true,
        freshness_ms: Math.max(0, freshnessMs),
        degraded: false,
        payload,
      };
    }
  } else if (
    body.source === 'dashboard_api'
    && body.status === 'stale'
    && body.used_for_routing === false
    && body.degraded === true
    && typeof body.degraded_reason === 'string'
    && body.degraded_reason.length > 0
    && freshnessMs != null
    && freshnessMs > FRESH_THRESHOLD_MS
  ) {
    payload = sanitizeDashboardPayload(body.payload, name);
    if (payload) {
      state = {
        source: 'dashboard_api',
        status: 'stale',
        used_for_routing: false,
        freshness_ms: Math.max(0, freshnessMs),
        degraded: true,
        degraded_reason: sanitizeDegradedReason(body.degraded_reason),
        payload,
      };
    }
  } else if (
    body.source === 'dashboard_health'
    && body.status === 'degraded'
    && body.used_for_routing === false
    && body.degraded === true
    && typeof body.degraded_reason === 'string'
    && body.degraded_reason.length > 0
    && freshnessMs != null
  ) {
    payload = sanitizeHealthPayload(body.payload);
    if (payload) {
      state = {
        source: 'dashboard_health',
        status: 'degraded',
        used_for_routing: false,
        freshness_ms: Math.max(0, freshnessMs),
        degraded: true,
        degraded_reason: sanitizeDegradedReason(body.degraded_reason),
        payload,
      };
    }
  } else if (
    body.source === 'none'
    && body.status === 'unavailable'
    && body.used_for_routing === false
    && body.degraded === true
    && typeof body.degraded_reason === 'string'
    && body.degraded_reason.length > 0
    && body.observed_at === null
    && body.payload === null
  ) {
    state = {
      source: 'none',
      status: 'unavailable',
      used_for_routing: false,
      freshness_ms: null,
      degraded: true,
      degraded_reason: sanitizeDegradedReason(body.degraded_reason),
      payload: null,
    };
  }

  const valid = body.agent_name === name
    && (body.source === 'none' || (Number.isFinite(observedAt) && freshnessMs >= -FUTURE_SKEW_MS))
    && clientFreshnessValid
    && freshnessConsistent
    && state;

  if (!valid) return res.status(400).json({ error: 'invalid_agent_state' });

  try {
    stateDb.upsertAgentDashboardState(name, state, observedAt, receivedAt);
  } catch {
    return res.status(500).json({ error: 'agent_state_store_failed' });
  }

  return res.json({ ok: true });
});

router.get('/:name', (req, res) => {
  const { name } = req.params;
  if (!isCanonicalAgent(name, stateDb, entityStore)) return res.status(404).json({ error: 'Agent not found' });
  const readAt = now();
  let stored;
  try {
    stored = stateDb.getAgentDashboardState(name);
  } catch {
    return res.status(500).json({ error: 'agent_state_read_failed' });
  }
  const state = presentState(stored, readAt);
  return res.json({
    name,
    state,
    ...(state ? {} : { stale: true }),
    timestamp: new Date(readAt).toISOString(),
  });
});

router.get('/', (_req, res) => {
  const readAt = now();
  let storedStates;
  try {
    storedStates = stateDb.getAllAgentDashboardStates();
  } catch {
    return res.status(500).json({ error: 'agent_state_read_failed' });
  }
  return res.json({
    states: storedStates
      .filter(state => isCanonicalAgent(state.name, stateDb, entityStore))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(state => ({
        name: state.name,
        state: presentState(state, readAt),
      })),
    timestamp: new Date(readAt).toISOString(),
  });
});

  return router;
}

module.exports = createAgentStateRouter();
module.exports.createAgentStateRouter = createAgentStateRouter;
