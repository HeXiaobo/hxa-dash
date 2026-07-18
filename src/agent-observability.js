const FIELD_SOURCES = Object.freeze({
  runtime: new Set(['agent_health']),
  model: new Set(['transcript', 'statusline', 'codex']),
  context: new Set(['statusline_roster']),
  quota: new Set(['statusline', 'codex']),
  session_tokens: new Set(['transcript', 'statusline', 'codex']),
  cost: new Set(['statusline', 'codex']),
  backup: new Set(['agent_health']),
  activity: new Set(['activity_monitor_fallback']),
});

const ALLOWED_RUNTIME_TYPES = new Set(['claude_code', 'claude', 'codex', 'openclaw', 'unknown']);
const ALLOWED_BACKUP_STATUSES = new Set(['ok', 'warning', 'critical', 'unsupported']);
const ALLOWED_ACTIVITY_STATES = new Set(['busy', 'idle', 'waiting', 'offline', 'unknown']);
const ALLOWED_ACTIVITY_HEALTH = new Set(['ok', 'unavailable']);
const TOKEN_FIELDS = ['input', 'output', 'cache_creation', 'cache_read', 'cached_input', 'reasoning'];
const EVIDENCE_STALE_MS = 10 * 60 * 1000;
const EVIDENCE_FUTURE_SKEW_MS = 5 * 1000;

function finiteNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function roundedNumber(value, options) {
  const number = finiteNumber(value, options);
  return number == null ? null : Math.round(number * 10) / 10;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
    return milliseconds > 0 ? Math.round(milliseconds) : null;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function evidenceReadReason(value, now) {
  const observedAt = timestampMs(value);
  if (observedAt == null) return 'sample_time_unavailable';
  if (observedAt > now + EVIDENCE_FUTURE_SKEW_MS || now - observedAt > EVIDENCE_STALE_MS) {
    return 'stale_sample';
  }
  return null;
}

function evidenceTimeForRead(value, options = {}) {
  const now = typeof options.now === 'number' && Number.isFinite(options.now)
    ? options.now
    : Date.now();
  const hasReportedAt = Object.prototype.hasOwnProperty.call(options, 'reportedAt');
  const sampledAt = timestampMs(value);
  const reportedAt = hasReportedAt ? timestampMs(options.reportedAt) : null;
  const reason = (hasReportedAt ? evidenceReadReason(options.reportedAt, now) : null)
    || evidenceReadReason(value, now)
    || (hasReportedAt && sampledAt != null && reportedAt != null
      && sampledAt > reportedAt + EVIDENCE_FUTURE_SKEW_MS
      ? 'stale_sample'
      : null);
  return {
    sampledAt: reason ? null : sampledAt,
    reason,
  };
}

function unavailableUsageForRead(reason) {
  return {
    supported: false,
    source: null,
    reason,
    sampled_at: null,
    session_id: null,
    thread_id: null,
    model: null,
    model_source: null,
    model_sampled_at: null,
    model_unavailable_reason: reason,
    plan_type: null,
    session_tokens: null,
    last_turn_tokens: null,
    session_cost_usd: null,
    cost_source: null,
    cost_sampled_at: null,
    estimated_cost: null,
    turns: null,
    partial: null,
  };
}

function usageForRead(usage, options = {}) {
  if (!usage || typeof usage !== 'object') return usage || null;
  const now = typeof options.now === 'number' && Number.isFinite(options.now)
    ? options.now
    : Date.now();
  const evidenceOptions = Object.prototype.hasOwnProperty.call(options, 'reportedAt')
    ? { now, reportedAt: options.reportedAt }
    : { now };
  const usageReason = evidenceTimeForRead(usage.sampled_at, evidenceOptions).reason;
  if (usageReason) return unavailableUsageForRead(usageReason);

  const tokenSourceInvalid = (usage.session_tokens != null || usage.last_turn_tokens != null)
    && safeSource('session_tokens', usage.source) == null;
  const modelSourceInvalid = usage.model != null && safeSource('model', usage.model_source) == null;
  const costSourceInvalid = usage.session_cost_usd != null && safeSource('cost', usage.cost_source) == null;
  const modelReason = usage.model != null
    ? evidenceTimeForRead(usage.model_sampled_at, evidenceOptions).reason
    : null;
  const costReason = usage.session_cost_usd != null
    ? evidenceTimeForRead(usage.cost_sampled_at, evidenceOptions).reason
    : null;
  if (!tokenSourceInvalid && !modelSourceInvalid && !costSourceInvalid && !modelReason && !costReason) {
    return usage;
  }
  const trustedTokenEvidence = !tokenSourceInvalid
    && (sessionTokenEvidence(usage.session_tokens).total != null
      || sessionTokenEvidence(usage.last_turn_tokens).total != null);
  const trustedCostEvidence = !costSourceInvalid
    && finiteNumber(usage.session_cost_usd, { min: 0, max: 1_000_000_000 }) != null;
  const sourceReason = tokenSourceInvalid || modelSourceInvalid || costSourceInvalid
    ? 'invalid_value'
    : null;
  return {
    ...usage,
    supported: usage.supported === true && (trustedTokenEvidence || trustedCostEvidence),
    reason: usage.reason || sourceReason || modelReason || costReason,
    ...(tokenSourceInvalid ? {
      source: null,
      sampled_at: null,
      session_id: null,
      thread_id: null,
      session_tokens: null,
      last_turn_tokens: null,
      partial: null,
    } : {}),
    ...(modelSourceInvalid || modelReason ? {
      model: null,
      model_source: null,
      model_sampled_at: null,
      model_unavailable_reason: modelSourceInvalid ? 'invalid_value' : modelReason,
    } : {}),
    ...(costSourceInvalid || costReason ? {
      session_cost_usd: null,
      cost_source: null,
      cost_sampled_at: null,
      estimated_cost: null,
    } : {}),
  };
}

function unavailableQuotaForRead(reason) {
  return {
    supported: false,
    source: null,
    reason,
    sampled_at: null,
    primary: null,
    secondary: null,
    credits: null,
  };
}

function quotaForRead(quota, options = {}) {
  if (!quota || typeof quota !== 'object') return quota || null;
  if (quota.supported !== true) return quota;
  if (safeSource('quota', quota.source) == null) return unavailableQuotaForRead('invalid_value');
  const now = typeof options.now === 'number' && Number.isFinite(options.now)
    ? options.now
    : Date.now();
  const evidenceOptions = Object.prototype.hasOwnProperty.call(options, 'reportedAt')
    ? { now, reportedAt: options.reportedAt }
    : { now };
  const quotaReason = evidenceTimeForRead(quota.sampled_at, evidenceOptions).reason;
  return quotaReason ? unavailableQuotaForRead(quotaReason) : quota;
}

function latestTimestamp(values) {
  const timestamps = values.map(timestampMs).filter(value => value != null);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function safeSource(field, value) {
  return FIELD_SOURCES[field]?.has(value) ? value : null;
}

function safeIdentifier(value, maxLength = 64) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLength);
  if (!trimmed || !/^[A-Za-z0-9._:+/-]+$/.test(trimmed)) return null;
  return trimmed;
}

function safeReason(value, fallback) {
  const allowed = new Set([
    'not_reported',
    'unsupported',
    'unsupported_for_now',
    'no_used_quota_window',
    'window_not_reported',
    'sample_time_unavailable',
    'stale_sample',
    'invalid_value',
    'no_authoritative_field',
    'three_evidence_not_reported',
    'activity_monitor_unavailable',
  ]);
  return allowed.has(value) ? value : fallback;
}

function unavailableQuotaWindow(reason = 'window_not_reported') {
  return {
    availability: 'unavailable',
    used_percent: null,
    resets_at: null,
    unavailable_reason: reason,
  };
}

function quotaWindow(quota, windowMinutes, source) {
  if (!quota || quota.supported !== true) {
    return unavailableQuotaWindow(safeReason(quota?.reason, 'not_reported'));
  }
  if (!source) return unavailableQuotaWindow(quota.source == null ? 'not_reported' : 'invalid_value');
  const window = [quota.primary, quota.secondary]
    .find(candidate => finiteNumber(candidate?.window_minutes, { min: 1, max: 525_600 }) === windowMinutes);
  if (!window) return unavailableQuotaWindow();

  const usedPercent = roundedNumber(window.used_percent, { min: 0, max: 100 });
  if (usedPercent == null) return unavailableQuotaWindow('invalid_value');
  return {
    availability: 'available',
    used_percent: usedPercent,
    resets_at: timestampMs(window.resets_at),
    unavailable_reason: null,
  };
}

function sessionTokenEvidence(tokens) {
  if (!tokens || typeof tokens !== 'object') return { total: null, invalid: false };
  const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const explicitTotal = tokenCount(tokens.total);
  if (Object.prototype.hasOwnProperty.call(tokens, 'total') && tokens.total != null && explicitTotal == null) {
    return { total: null, invalid: true };
  }

  let observed = false;
  let total = 0;
  for (const field of TOKEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(tokens, field) && tokens[field] != null
      && tokenCount(tokens[field]) == null) {
      return { total: null, invalid: true };
    }
    const value = tokenCount(tokens[field]);
    if (value == null) continue;
    observed = true;
    total += value;
  }
  const value = explicitTotal != null ? explicitTotal : observed ? total : null;
  return {
    total: value != null && Number.isSafeInteger(value) ? value : null,
    invalid: value != null && !Number.isSafeInteger(value),
  };
}

function buildRuntime(runtime) {
  const type = ALLOWED_RUNTIME_TYPES.has(runtime?.type) ? runtime.type : null;
  const version = safeIdentifier(runtime?.version);
  const source = safeSource('runtime', runtime?.source);
  const sampledAt = timestampMs(runtime?.checked_at);
  const available = source != null && sampledAt != null && Boolean(type || version);
  const pendingRestartAvailable = Object.prototype.hasOwnProperty.call(runtime || {}, 'pending_restart')
    && typeof runtime.pending_restart === 'boolean'
    && available;
  return {
    availability: available ? 'available' : 'unavailable',
    type: available ? type : null,
    version: available ? version : null,
    source,
    sampled_at: sampledAt,
    pending_restart: pendingRestartAvailable ? runtime.pending_restart : null,
    pending_restart_availability: pendingRestartAvailable ? 'available' : 'unavailable',
    pending_restart_unavailable_reason: pendingRestartAvailable ? null : 'no_authoritative_field',
    unavailable_reason: available
      ? null
      : runtime == null ? 'not_reported' : sampledAt == null ? 'sample_time_unavailable' : 'invalid_value',
  };
}

function buildModel(usage, now) {
  const value = safeIdentifier(usage?.model, 128);
  const source = safeSource('model', usage?.model_source);
  const sampledAt = timestampMs(usage?.model_sampled_at);
  const unavailableReason = safeReason(usage?.model_unavailable_reason, null);
  const sampleReason = usage?.model == null
    ? null
    : evidenceReadReason(usage?.model_sampled_at, now);
  const available = value != null && source != null && sampledAt != null && sampleReason == null;
  return {
    availability: available ? 'available' : 'unavailable',
    value: available ? value : null,
    source: available ? source : null,
    sampled_at: available ? sampledAt : null,
    unavailable_reason: available
      ? null
      : usage?.model == null ? unavailableReason || 'not_reported' : sampleReason || 'invalid_value',
  };
}

function buildContext(roster, now, evidenceOptions = { now }) {
  const usedPercent = roundedNumber(roster?.context_used_pct, { min: 0, max: 100 });
  const sampledAt = timestampMs(roster?.sampled_at);
  const source = safeSource('context', 'statusline_roster');
  const sampleReason = roster?.context_used_pct == null
    ? null
    : evidenceTimeForRead(roster?.sampled_at, evidenceOptions).reason;
  const available = usedPercent != null && sampledAt != null && source != null && sampleReason == null;
  if (!available) {
    return {
      availability: 'unavailable',
      used_percent: null,
      remaining_percent: null,
      total_tokens: null,
      plan_type: null,
      source: null,
      sampled_at: null,
      unavailable_reason: roster?.context_used_pct == null
        ? 'not_reported'
        : sampleReason || 'invalid_value',
    };
  }
  return {
    availability: 'available',
    used_percent: usedPercent,
    remaining_percent: Math.round((100 - usedPercent) * 10) / 10,
    total_tokens: finiteNumber(roster?.context_used_tokens ?? roster?.context_total_tokens, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    plan_type: safeIdentifier(roster?.plan_type, 32),
    source: 'statusline_roster',
    sampled_at: sampledAt,
    unavailable_reason: null,
  };
}

function buildSessionTokens(usage) {
  const evidence = sessionTokenEvidence(usage?.session_tokens);
  const source = safeSource('session_tokens', usage?.source);
  const sampledAt = timestampMs(usage?.sampled_at);
  const exactScope = usage?.partial === false;
  const available = usage?.supported === true
    && evidence.total != null
    && !evidence.invalid
    && exactScope
    && source != null
    && sampledAt != null;
  return {
    availability: available ? 'available' : 'unavailable',
    scope: 'single_session',
    total: available ? evidence.total : null,
    source,
    sampled_at: sampledAt,
    partial: typeof usage?.partial === 'boolean' ? usage.partial : null,
    unavailable_reason: available
      ? null
      : usage?.session_tokens == null
        ? safeReason(usage?.reason, 'not_reported')
        : sampledAt == null ? 'sample_time_unavailable' : 'invalid_value',
  };
}

function buildCost(usage) {
  const total = finiteNumber(usage?.session_cost_usd, { min: 0, max: 1_000_000_000 });
  const source = safeSource('cost', usage?.cost_source);
  const sampledAt = timestampMs(usage?.cost_sampled_at);
  const estimated = typeof usage?.estimated_cost === 'boolean' ? usage.estimated_cost : null;
  const available = usage?.supported === true
    && total != null
    && source != null
    && sampledAt != null
    && estimated != null;
  return {
    availability: available ? 'available' : 'unavailable',
    currency: 'USD',
    scope: 'single_session_cumulative',
    total: available ? total : null,
    source,
    sampled_at: sampledAt,
    estimated: available ? estimated : null,
    unavailable_reason: available
      ? null
      : source == null && usage?.cost_source == null
        ? safeReason(usage?.reason, 'not_reported')
        : sampledAt == null ? 'sample_time_unavailable' : 'invalid_value',
  };
}

function buildBackup(backup) {
  const supported = backup?.supported === true;
  const status = supported && ALLOWED_BACKUP_STATUSES.has(backup.status) ? backup.status : null;
  const source = safeSource('backup', 'agent_health');
  const sampledAt = supported ? timestampMs(backup.sampled_at) : null;
  const lastSuccessAt = supported ? timestampMs(backup.last_success_at ?? backup.cron?.last_success_at) : null;
  const expectedMatch = supported && typeof backup.expected_match === 'boolean' ? backup.expected_match : null;
  const counters = ['ahead', 'behind', 'dirty', 'untracked']
    .map(field => finiteNumber(backup?.[field], { min: 0, max: Number.MAX_SAFE_INTEGER }));
  const countersAvailable = backup?.counter_evidence_complete === true
    && counters.every(value => value != null);
  const remoteMatch = expectedMatch === false
    ? false
    : expectedMatch === true && countersAvailable
      ? counters.every(value => value === 0)
      : null;
  const proofCount = [lastSuccessAt != null, remoteMatch != null, false].filter(Boolean).length;
  return {
    availability: status && sampledAt != null ? 'available' : 'unavailable',
    status,
    scope: 'local_health',
    source,
    sampled_at: sampledAt,
    last_success_at: lastSuccessAt,
    last_success_availability: lastSuccessAt == null ? 'unavailable' : 'available',
    remote_match: remoteMatch,
    remote_match_availability: remoteMatch == null ? 'unavailable' : 'available',
    restore_drill: { status: 'unavailable', evidence_at: null },
    three_evidence_availability: proofCount > 0 ? 'partial' : 'unavailable',
    unavailable_reason: status && sampledAt != null
      ? null
      : sampledAt == null && supported ? 'sample_time_unavailable' : safeReason(backup?.reason, 'not_reported'),
  };
}

function buildActivityFallback(activity, now, evidenceOptions = { now }) {
  const source = safeSource('activity', activity?.source);
  const state = typeof activity?.state === 'string' ? activity.state.toLowerCase() : null;
  const health = typeof activity?.health === 'string' ? activity.health.toLowerCase() : null;
  const sampledAt = timestampMs(activity?.observed_at ?? activity?.sampled_at);
  const trusted = source === 'activity_monitor_fallback'
    && activity?.used_for_routing === false
    && ALLOWED_ACTIVITY_STATES.has(state)
    && ALLOWED_ACTIVITY_HEALTH.has(health);
  const sampleReason = trusted
    ? evidenceTimeForRead(activity?.observed_at ?? activity?.sampled_at, evidenceOptions).reason
    : null;
  const available = trusted && sampledAt != null && sampleReason == null;
  return {
    availability: available ? 'available' : 'unavailable',
    state: available ? state : null,
    health: available ? health : null,
    source: available ? source : null,
    sampled_at: available ? sampledAt : null,
    used_for_routing: false,
    unavailable_reason: available ? null : sampleReason || 'activity_monitor_unavailable',
  };
}

function buildAgentObservability(options = {}) {
  const { runtime, quota, usage, backup, roster, activity, now = Date.now() } = options;
  const evidenceOptions = Object.prototype.hasOwnProperty.call(options, 'reportedAt')
    ? { now, reportedAt: options.reportedAt }
    : { now };
  const runtimeSummary = buildRuntime(runtime);
  const model = buildModel(usage, now);
  const context = buildContext(roster, now, evidenceOptions);
  const quotaSource = safeSource('quota', quota?.source);
  const quotaSampledAt = timestampMs(quota?.sampled_at);
  const sessionTokens = buildSessionTokens(usage);
  const cost = buildCost(usage);
  const backupSummary = buildBackup(backup);
  const activityFallback = buildActivityFallback(activity, now, evidenceOptions);

  return {
    schema_version: 1,
    source: 'agent_health',
    sampled_at: latestTimestamp([
      runtimeSummary.sampled_at,
      model.sampled_at,
      context.sampled_at,
      quotaSampledAt,
      sessionTokens.sampled_at,
      cost.sampled_at,
      backupSummary.sampled_at,
      activityFallback.sampled_at,
    ]),
    runtime: runtimeSummary,
    model,
    context,
    quota: {
      source: quotaSource,
      sampled_at: quotaSampledAt,
      five_hour: quotaWindow(quota, 300, quotaSource),
      seven_day: quotaWindow(quota, 10_080, quotaSource),
    },
    session_tokens: sessionTokens,
    cost,
    backup: backupSummary,
    activity: activityFallback,
  };
}

module.exports = { buildAgentObservability, evidenceTimeForRead, quotaForRead, usageForRead };
