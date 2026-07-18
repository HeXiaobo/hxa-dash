const ROSTER = [
  { id: 'yueran', name: '玥然', role: '日常工作助理', aliases: ['yueran', '玥然'] },
  { id: 'mylos', name: 'Mylos', role: '首席 AI 运营官', aliases: ['mylos'] },
  { id: 'ss', name: 'SS', role: '产品交付 / 销售物料', aliases: ['ss'] },
  { id: 'veda', name: 'Veda', role: '内容运营', aliases: ['veda'] },
  { id: 'aqi', name: '阿七', role: 'AI 专家', aliases: ['aqi', '阿七'] },
  { id: 'xinghang', name: '星航', role: '知乎项目部助理', aliases: ['xinghang', '星航'] },
  { id: 'xiaonuo', name: '小诺', role: '小红书运营部优化师', aliases: ['xiaonuo', '小诺'] },
  { id: 'hongshu', name: 'Hongshu', role: '内容团队 AI 员工', aliases: ['hongshu', '红薯'] },
  { id: 'wanyanshu', name: '万言书', role: 'GEO 业务 AI 员工', aliases: ['wanyanshu', '万言书'] },
  { id: 'xiaoz', name: '小Z', role: '海外营销专家', aliases: ['xiaoz', '小z'] },
  { id: 'linlin', name: '小霖', role: '商务助理', aliases: ['linlin', '小霖'] },
  { id: 'chengzi', name: '橙子', role: '商务助理', aliases: ['chengzi', '橙子'] },
  { id: 'siyue', name: '四月', role: '小红书项目部客户执行', aliases: ['siyue', '四月'] },
  { id: 'yaya', name: '芽芽', role: '小红书项目部客户执行', aliases: ['yaya', '芽芽'] },
  { id: 'xiaochuaner', name: '小小串儿', role: '商务助理', aliases: ['xiaochuaner', '小小串儿'] },
  { id: 'xiaoyou', name: '小优', role: '人力资源 AI 员工', aliases: ['xiaoyou', '小优'] },
  { id: 'xiaodao', name: '小岛', role: '知乎项目部助理', aliases: ['xiaodao', '小岛'] },
  { id: 'kimi', name: 'Kimi', role: '海外事业部 AI 员工', aliases: ['kimi'] },
  { id: 'zhugeliang', name: '诸葛亮', role: '小红书项目部 AI 军师', aliases: ['zhugeliang', '诸葛亮'] },
  { id: 'xiaozhang', name: '小张', role: '小红书商务专员', aliases: ['xiaozhang', '小张'] },
  { id: 'lingling', name: '灵灵', role: '财务专员', aliases: ['lingling', '灵灵'] },
  { id: 'xiaolv', name: '小律', role: '法务部助理', aliases: ['xiaolv', '小律'] },
];

export const AGENT_STATE_FRESH_MS = 30_000;
const AGENT_STATE_FUTURE_SKEW_MS = 5_000;
export const OBSERVABILITY_FRESH_MS = 10 * 60 * 1000;
const OBSERVABILITY_FUTURE_SKEW_MS = 5_000;
const OBSERVABILITY_FIELD_SOURCES = Object.freeze({
  runtime: new Set(['agent_health']),
  model: new Set(['transcript', 'statusline', 'codex']),
  context: new Set(['statusline_roster']),
  quota: new Set(['statusline', 'codex']),
  sessionTokens: new Set(['transcript', 'statusline', 'codex']),
  cost: new Set(['statusline', 'codex']),
  backup: new Set(['agent_health']),
  activity: new Set(['activity_monitor_fallback']),
});
const OBSERVABILITY_REASONS = new Set([
  'not_reported',
  'unsupported',
  'unsupported_for_now',
  'no_used_quota_window',
  'window_not_reported',
  'sample_time_unavailable',
  'invalid_value',
  'no_authoritative_field',
  'three_evidence_not_reported',
  'activity_monitor_unavailable',
  'stale_sample',
  'single_session_snapshot_not_comparable',
]);
const OBSERVABILITY_RUNTIME_TYPES = new Set(['claude_code', 'claude', 'codex', 'openclaw', 'unknown']);

function normalizeName(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

const ALIAS_TO_ID = new Map(
  ROSTER.flatMap(employee => employee.aliases.map(alias => [normalizeName(alias), employee.id])),
);

function rosterId(value) {
  return ALIAS_TO_ID.get(normalizeName(value)) || null;
}

function indexByRosterId(items) {
  const result = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = rosterId(item?.name) || rosterId(item?.display_name);
    if (id && !result.has(id)) result.set(id, item);
  }
  return result;
}

function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentage(value) {
  const number = finiteNumber(value);
  if (number == null) return null;
  return Math.max(0, Math.min(100, Math.round(number * 10) / 10));
}

function strictNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

function strictInteger(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

function strictPercentage(value) {
  const number = strictNumber(value, { min: 0, max: 100 });
  return number == null ? null : Math.round(number * 10) / 10;
}

function observabilityIdentifier(value, maxLength = 128) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !/^[A-Za-z0-9._:+/-]+$/.test(trimmed)) return null;
  return trimmed;
}

function isoTimestamp(value) {
  if (value == null || value === '') return null;
  const numeric = finiteNumber(value);
  const date = numeric == null
    ? new Date(String(value))
    : new Date(numeric > 0 && numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stateLabel(value) {
  const state = String(value || '').trim().toUpperCase();
  if (['BUSY', 'WORKING', 'THINKING'].includes(state)) return '工作中';
  if (['WAITING', 'WAITING_FOR_USER', 'WAITING_APPROVAL'].includes(state)) return '等待确认';
  if (['IDLE', 'STANDBY'].includes(state)) return '待命';
  if (state === 'OFFLINE') return '离线';
  return '暂不可用';
}

function employeeState(agent, dashboardState, now) {
  const state = dashboardState?.state;
  const observedAt = isoTimestamp(state?.observed_at);
  const observedAge = observedAt ? now - Date.parse(observedAt) : null;
  const fresh = state?.status === 'fresh'
    && state?.stale !== true
    && observedAge != null
    && observedAge >= -AGENT_STATE_FUTURE_SKEW_MS
    && Math.max(0, observedAge) <= AGENT_STATE_FRESH_MS;
  if (fresh) {
    return stateLabel(state?.payload?.agent?.state);
  }
  if (!agent) return '暂不可用';
  if (agent.runtime_status === 'offline' || agent.work_state === 'offline') return '离线';
  return stateLabel(agent.work_state);
}

function runtimeLabel(runtime) {
  if (runtime?.label) return String(runtime.label);
  const type = String(runtime?.type || '').toLowerCase();
  if (type === 'codex') return 'Codex';
  if (['claude', 'claude_code'].includes(type)) return 'Claude Code';
  if (type === 'openclaw') return 'OpenClaw';
  return '—';
}

function runtimeVersion(agent) {
  const label = runtimeLabel(agent?.runtime);
  const version = String(agent?.runtime?.version || '').trim();
  return label !== '—' && version ? `${label} ${version}` : '—';
}

function quotaWindow(quota, windowMinutes) {
  if (!quota?.supported || quota?.freshness?.status !== 'fresh') return null;
  const candidates = [quota.primary, quota.secondary].filter(Boolean);
  return candidates.find(window => finiteNumber(window?.window_minutes) === windowMinutes) || null;
}

function validObservedWindow(window) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(window?.start_date || ''))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(window?.end_date || ''))
    && window?.timezone === 'Asia/Shanghai';
}

function observedTokens(tokensPayload, now) {
  const observed = tokensPayload?.observed;
  const sampledAt = isoTimestamp(observed?.sampled_at);
  const observation = sampleStatus(observed?.observed_at, now);
  const sourceTimeValid = sampledAt != null
    && observation.sampledAt != null
    && Date.parse(sampledAt) <= now + OBSERVABILITY_FUTURE_SKEW_MS
    && Date.parse(sampledAt) <= Date.parse(observation.sampledAt) + OBSERVABILITY_FUTURE_SKEW_MS;
  const comparable = observed?.supported === true
    && observed?.comparable === true
    && observed?.comparability === 'history_last_turns'
    && validObservedWindow(observed?.window);
  const result = new Map();
  const unavailableReasons = new Map();
  if (comparable && observation.fresh && sourceTimeValid) {
    for (const item of Array.isArray(observed.agents) ? observed.agents : []) {
      const id = rosterId(item?.name);
      const total = strictInteger(item?.total, { min: 0 });
      if (!id) continue;
      if (total == null || item?.partial_baseline !== false) {
        unavailableReasons.set(id, 'invalid_value');
        continue;
      }

      const itemSample = sampleStatus(item?.sampled_at, now);
      const itemObservation = sampleStatus(item?.reported_at ?? item?.observed_at, now);
      if (itemSample.sampledAt == null || itemObservation.sampledAt == null) {
        unavailableReasons.set(id, 'sample_time_unavailable');
        continue;
      }
      const itemTimeConsistent = Date.parse(itemSample.sampledAt)
        <= Date.parse(itemObservation.sampledAt) + OBSERVABILITY_FUTURE_SKEW_MS;
      if (!itemSample.fresh || !itemObservation.fresh || !itemTimeConsistent) {
        unavailableReasons.set(id, 'stale_sample');
        continue;
      }
      if (!result.has(id)) {
        result.set(id, {
          total,
          sampledAt: itemSample.sampledAt,
          observedAt: itemObservation.sampledAt,
        });
      }
    }
  }
  const unavailableReason = result.size > 0
    ? null
    : unavailableReasons.values().next().value
      || (observed?.supported !== true
        ? observabilityReason(observed?.unavailable_reason)
        : observed?.comparable !== true || observed?.comparability !== 'history_last_turns'
          ? observabilityReason(observed?.unavailable_reason, 'single_session_snapshot_not_comparable')
          : !validObservedWindow(observed?.window)
            ? 'invalid_value'
            : (!observation.fresh || sampledAt == null || !sourceTimeValid) && observed != null
              ? sampledAt == null || observation.sampledAt == null
                ? 'sample_time_unavailable'
                : !sourceTimeValid ? 'stale_sample' : observation.unavailableReason
              : 'not_reported');
  return {
    values: result,
    unavailableReasons,
    sampledAt,
    observedAt: observation.sampledAt,
    unavailableReason,
  };
}

function backupSummary(backupsPayload, now) {
  const records = Array.isArray(backupsPayload?.agents) ? backupsPayload.agents : [];
  const covered = records.filter(record => sampleStatus(record?.reported_at, now).fresh
    && sampleStatus(record?.summary?.sampled_at, now).fresh
    && record?.summary?.supported === true);
  const healthy = covered.filter(record => record.summary?.status === 'ok');
  const synchronized = covered.filter(record => {
    const summary = record.summary || {};
    return summary.expected_match === true
      && summary.counter_evidence_complete === true
      && [summary.ahead, summary.behind, summary.dirty, summary.untracked]
        .every(value => finiteNumber(value) === 0);
  });
  const latestSuccess = covered
    .map(record => {
      const succeededAt = isoTimestamp(record.summary?.last_success_at);
      const sampledAt = isoTimestamp(record.summary?.sampled_at);
      if (!succeededAt || !sampledAt) return null;
      const succeededMs = Date.parse(succeededAt);
      return succeededMs <= now + OBSERVABILITY_FUTURE_SKEW_MS
        && succeededMs <= Date.parse(sampledAt)
        ? succeededAt
        : null;
    })
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return {
    covered: covered.length,
    healthy: healthy.length,
    synchronized: synchronized.length,
    latestSuccessAt: latestSuccess,
    restoreStatus: 'unverified',
  };
}

function newestTimestamp(values) {
  return values
    .map(isoTimestamp)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function observabilitySource(field, value) {
  return OBSERVABILITY_FIELD_SOURCES[field]?.has(value) ? value : null;
}

function observabilityReason(value, fallback = 'not_reported') {
  return OBSERVABILITY_REASONS.has(value) ? value : fallback;
}

function sampleStatus(value, now) {
  const sampledAt = isoTimestamp(value);
  if (!sampledAt) return { sampledAt: null, fresh: false, unavailableReason: 'sample_time_unavailable' };
  const age = now - Date.parse(sampledAt);
  const fresh = age >= -OBSERVABILITY_FUTURE_SKEW_MS && Math.max(0, age) <= OBSERVABILITY_FRESH_MS;
  return { sampledAt, fresh, unavailableReason: fresh ? null : 'stale_sample' };
}

function normalizedAvailability(rawAvailability, sample, rawReason, hasValue) {
  if (rawAvailability !== 'available') {
    return { availability: 'unavailable', unavailableReason: observabilityReason(rawReason) };
  }
  if (!hasValue) {
    return {
      availability: 'unavailable',
      unavailableReason: observabilityReason(rawReason, 'invalid_value'),
    };
  }
  if (!sample.fresh) {
    return { availability: 'unavailable', unavailableReason: sample.unavailableReason };
  }
  return { availability: 'available', unavailableReason: null };
}

function normalizeAgentObservability(raw, now) {
  const contractAvailable = raw?.schema_version === 1;
  const overallSample = sampleStatus(raw?.sampled_at, now);
  const runtimeSample = sampleStatus(raw?.runtime?.sampled_at, now);
  const runtimeSource = observabilitySource('runtime', raw?.runtime?.source);
  const runtimeType = OBSERVABILITY_RUNTIME_TYPES.has(raw?.runtime?.type) ? raw.runtime.type : null;
  const runtimeVersion = observabilityIdentifier(raw?.runtime?.version, 64);
  const runtimeAvailability = normalizedAvailability(
    contractAvailable ? raw?.runtime?.availability : null,
    runtimeSample,
    raw?.runtime?.unavailable_reason,
    runtimeSource != null && Boolean(runtimeType || runtimeVersion),
  );
  const pendingRestartAvailable = contractAvailable
    && runtimeSource != null
    && runtimeSample.fresh
    && raw?.runtime?.pending_restart_availability === 'available'
    && typeof raw?.runtime?.pending_restart === 'boolean';

  const modelSample = sampleStatus(raw?.model?.sampled_at, now);
  const modelSource = observabilitySource('model', raw?.model?.source);
  const modelValue = observabilityIdentifier(raw?.model?.value);
  const modelAvailability = normalizedAvailability(
    contractAvailable ? raw?.model?.availability : null,
    modelSample,
    raw?.model?.unavailable_reason,
    modelSource != null && modelValue != null,
  );

  const contextSample = sampleStatus(raw?.context?.sampled_at, now);
  const contextSource = observabilitySource('context', raw?.context?.source);
  const contextUsed = strictPercentage(raw?.context?.used_percent);
  const contextAvailability = normalizedAvailability(
    contractAvailable ? raw?.context?.availability : null,
    contextSample,
    raw?.context?.unavailable_reason,
    contextSource != null && contextUsed != null,
  );

  const quotaSample = sampleStatus(raw?.quota?.sampled_at, now);
  const quotaSource = observabilitySource('quota', raw?.quota?.source);
  const normalizeQuotaWindow = window => {
    const usedPercent = strictPercentage(window?.used_percent);
    const availability = normalizedAvailability(
      contractAvailable ? window?.availability : null,
      quotaSample,
      window?.unavailable_reason,
      quotaSource != null && usedPercent != null,
    );
    return {
      ...availability,
      usedPercent: availability.availability === 'available' ? usedPercent : null,
      resetsAt: availability.availability === 'available' ? isoTimestamp(window?.resets_at) : null,
    };
  };

  const tokenSample = sampleStatus(raw?.session_tokens?.sampled_at, now);
  const sessionTokenSource = observabilitySource('sessionTokens', raw?.session_tokens?.source);
  const sessionTokenTotal = strictInteger(raw?.session_tokens?.total, { min: 0 });
  const sessionTokenAvailability = normalizedAvailability(
    contractAvailable ? raw?.session_tokens?.availability : null,
    tokenSample,
    raw?.session_tokens?.unavailable_reason,
    sessionTokenSource != null
      && sessionTokenTotal != null
      && raw?.session_tokens?.scope === 'single_session'
      && raw?.session_tokens?.partial === false,
  );

  const costSample = sampleStatus(raw?.cost?.sampled_at, now);
  const costSource = observabilitySource('cost', raw?.cost?.source);
  const costTotal = strictNumber(raw?.cost?.total, { min: 0, max: 1_000_000_000 });
  const costAvailability = normalizedAvailability(
    contractAvailable ? raw?.cost?.availability : null,
    costSample,
    raw?.cost?.unavailable_reason,
    costSource != null
      && costTotal != null
      && raw?.cost?.currency === 'USD'
      && raw?.cost?.scope === 'single_session_cumulative'
      && typeof raw?.cost?.estimated === 'boolean',
  );

  const backupSample = sampleStatus(raw?.backup?.sampled_at, now);
  const backupSource = observabilitySource('backup', raw?.backup?.source);
  const backupStatus = ['ok', 'warning', 'critical', 'unsupported'].includes(raw?.backup?.status)
    ? raw.backup.status
    : null;
  const backupAvailability = normalizedAvailability(
    contractAvailable ? raw?.backup?.availability : null,
    backupSample,
    raw?.backup?.unavailable_reason,
    backupSource != null && backupStatus != null && raw?.backup?.scope === 'local_health',
  );
  const backupEvidenceAvailable = backupAvailability.availability === 'available';
  const rawBackupLastSuccessAt = isoTimestamp(raw?.backup?.last_success_at);
  const backupLastSuccessTimeValid = rawBackupLastSuccessAt != null
    && backupSample.sampledAt != null
    && Date.parse(rawBackupLastSuccessAt) <= now + OBSERVABILITY_FUTURE_SKEW_MS
    && Date.parse(rawBackupLastSuccessAt) <= Date.parse(backupSample.sampledAt);
  const backupLastSuccessAt = backupEvidenceAvailable
    && raw?.backup?.last_success_availability === 'available'
    && backupLastSuccessTimeValid
    ? rawBackupLastSuccessAt
    : null;
  const backupRemoteMatch = backupEvidenceAvailable
    && raw?.backup?.remote_match_availability === 'available'
    && typeof raw?.backup?.remote_match === 'boolean'
    ? raw.backup.remote_match
    : null;
  const rawBackupRestoreEvidenceAt = isoTimestamp(raw?.backup?.restore_drill?.evidence_at);
  const backupRestoreEvidenceAt = backupEvidenceAvailable
    && raw?.backup?.restore_drill?.status === 'verified'
    ? rawBackupRestoreEvidenceAt
    : null;

  const activitySample = sampleStatus(raw?.activity?.sampled_at, now);
  const activitySource = raw?.activity?.source === 'activity_monitor_fallback'
    ? 'activity_monitor_fallback'
    : null;
  const safeDisplayFallback = activitySource != null
    && raw?.activity?.used_for_routing === false
    && ['busy', 'idle', 'waiting', 'offline', 'unknown'].includes(raw?.activity?.state)
    && ['ok', 'unavailable'].includes(raw?.activity?.health);
  const activityAvailability = normalizedAvailability(
    contractAvailable ? raw?.activity?.availability : null,
    activitySample,
    raw?.activity?.unavailable_reason || 'activity_monitor_unavailable',
    safeDisplayFallback,
  );

  return {
    schemaVersion: contractAvailable ? 1 : null,
    sampledAt: overallSample.sampledAt,
    runtime: {
      ...runtimeAvailability,
      type: runtimeAvailability.availability === 'available' ? runtimeType : null,
      version: runtimeAvailability.availability === 'available' ? runtimeVersion : null,
      source: runtimeSource,
      sampledAt: runtimeSample.sampledAt,
      pendingRestart: pendingRestartAvailable ? raw.runtime.pending_restart : null,
      pendingRestartAvailability: pendingRestartAvailable ? 'available' : 'unavailable',
      pendingRestartUnavailableReason: pendingRestartAvailable
        ? null
        : observabilityReason(
            runtimeSample.fresh
              ? raw?.runtime?.pending_restart_unavailable_reason
              : runtimeSample.unavailableReason,
            'no_authoritative_field',
          ),
    },
    model: {
      ...modelAvailability,
      value: modelAvailability.availability === 'available' ? modelValue : null,
      source: modelSource,
      sampledAt: modelSample.sampledAt,
    },
    context: {
      ...contextAvailability,
      usedPercent: contextAvailability.availability === 'available' ? contextUsed : null,
      remainingPercent: contextAvailability.availability === 'available'
        ? strictPercentage(raw?.context?.remaining_percent)
        : null,
      totalTokens: contextAvailability.availability === 'available'
        ? strictInteger(raw?.context?.total_tokens, { min: 0 })
        : null,
      planType: contextAvailability.availability === 'available'
        ? observabilityIdentifier(raw?.context?.plan_type, 32)
        : null,
      source: contextSource,
      sampledAt: contextSample.sampledAt,
    },
    quota: {
      source: quotaSource,
      sampledAt: quotaSample.sampledAt,
      fiveHour: normalizeQuotaWindow(raw?.quota?.five_hour),
      sevenDay: normalizeQuotaWindow(raw?.quota?.seven_day),
    },
    sessionTokens: {
      ...sessionTokenAvailability,
      scope: 'single_session',
      total: sessionTokenAvailability.availability === 'available' ? sessionTokenTotal : null,
      source: sessionTokenSource,
      sampledAt: tokenSample.sampledAt,
      partial: sessionTokenAvailability.availability === 'available' ? false : null,
    },
    cost: {
      ...costAvailability,
      scope: 'single_session_cumulative',
      currency: 'USD',
      total: costAvailability.availability === 'available' ? costTotal : null,
      source: costSource,
      sampledAt: costSample.sampledAt,
      estimated: costAvailability.availability === 'available' ? raw.cost.estimated : null,
    },
    backup: {
      ...backupAvailability,
      status: backupAvailability.availability === 'available' ? backupStatus : null,
      source: backupSource,
      sampledAt: backupSample.sampledAt,
      lastSuccessAt: backupLastSuccessAt,
      lastSuccessAvailability: backupEvidenceAvailable
        && raw?.backup?.last_success_availability === 'available'
        && backupLastSuccessAt
        ? 'available'
        : 'unavailable',
      remoteMatch: backupRemoteMatch,
      remoteMatchAvailability: backupEvidenceAvailable
        && raw?.backup?.remote_match_availability === 'available'
        && backupRemoteMatch != null
        ? 'available'
        : 'unavailable',
      restoreDrill: {
        status: backupEvidenceAvailable
          && raw?.backup?.restore_drill?.status === 'verified'
          && backupRestoreEvidenceAt
          ? 'verified'
          : 'unavailable',
        evidenceAt: backupRestoreEvidenceAt,
      },
    },
    activity: {
      ...activityAvailability,
      state: activityAvailability.availability === 'available' ? raw.activity.state : null,
      health: activityAvailability.availability === 'available' ? raw.activity.health : null,
      source: activitySource,
      sampledAt: activitySample.sampledAt,
      usedForRouting: false,
    },
  };
}

export function buildWorkbenchModel({
  now = Date.now(),
  team = {},
  limits = {},
  tokens = {},
  backups = {},
  agentStates = {},
} = {}) {
  const modelNow = finiteNumber(now) ?? Date.now();
  const teamById = indexByRosterId(team.agents);
  const limitsById = indexByRosterId(limits.agents);
  const statesById = indexByRosterId(agentStates.states);
  const tokenEvidence = observedTokens(tokens, modelNow);
  const tokenById = tokenEvidence.values;
  const backupById = indexByRosterId(backups.agents);

  const employees = ROSTER.map(person => {
    const agent = teamById.get(person.id);
    const quota = limitsById.get(person.id)?.quota;
    const hasObservabilityEnvelope = Object.prototype.hasOwnProperty.call(agent || {}, 'observability');
    const observability = normalizeAgentObservability(agent?.observability, modelNow);
    const q5 = quotaWindow(quota, 300);
    const q7 = quotaWindow(quota, 10080);
    const tokenRecord = tokenById.get(person.id);
    const tokenTotal = tokenRecord?.total ?? null;
    const backupRecord = backupById.get(person.id);
    const backup = sampleStatus(backupRecord?.reported_at, modelNow).fresh
      && sampleStatus(backupRecord?.summary?.sampled_at, modelNow).fresh
      ? backupRecord?.summary
      : null;
    const displayRuntime = hasObservabilityEnvelope ? observability.runtime : agent?.runtime;
    return {
      id: person.id,
      name: person.name,
      role: person.role,
      state: employeeState(agent, statesById.get(person.id), modelNow),
      task: '业务任务源待接入',
      q5: hasObservabilityEnvelope
        ? observability.quota.fiveHour.usedPercent
        : percentage(q5?.used_percent),
      q7: hasObservabilityEnvelope
        ? observability.quota.sevenDay.usedPercent
        : percentage(q7?.used_percent),
      q5Reset: hasObservabilityEnvelope
        ? observability.quota.fiveHour.resetsAt
        : isoTimestamp(q5?.resets_at),
      q7Reset: hasObservabilityEnvelope
        ? observability.quota.sevenDay.resetsAt
        : isoTimestamp(q7?.resets_at),
      tokens: tokenTotal,
      tokenSampledAt: tokenRecord?.sampledAt ?? null,
      tokenObservedAt: tokenRecord?.observedAt ?? null,
      tokenUnavailableReason: tokenTotal == null
        ? tokenEvidence.unavailableReasons.get(person.id) || tokenEvidence.unavailableReason || 'not_reported'
        : null,
      rank: null,
      version: runtimeVersion({ runtime: displayRuntime }),
      target: '—',
      upgradeComponent: '—',
      upgradeCurrent: '—',
      upgradeTarget: '—',
      runtime: runtimeLabel(displayRuntime),
      upgrade: '无',
      blocker: '暂不可用',
      backupStatus: hasObservabilityEnvelope
        ? observability.backup.availability === 'available' ? observability.backup.status : 'unavailable'
        : backup?.supported ? backup.status : 'unavailable',
      observability,
      updatedAt: newestTimestamp([
        statesById.get(person.id)?.state?.observed_at,
        agent?.last_active_at,
        agent?.last_heartbeat_at,
        quota?.sampled_at,
        observability.sampledAt,
      ]),
      observed: Boolean(agent),
    };
  });

  const ranked = employees
    .filter(employee => employee.tokens != null)
    .sort((left, right) => right.tokens - left.tokens);
  if (ranked.length > 1) ranked.forEach((employee, index) => { employee.rank = index + 1; });

  const observedWindow = tokens?.observed?.window;
  const tokenPeriod = validObservedWindow(observedWindow)
    ? {
        startDate: observedWindow.start_date,
        endDate: observedWindow.end_date,
        timezone: observedWindow.timezone,
      }
    : null;

  return {
    employees,
    tasks: [],
    backup: backupSummary(backups, modelNow),
    coverage: {
      quota: employees.filter(employee => employee.q5 != null || employee.q7 != null).length,
      tokens: ranked.length,
      total: employees.length,
    },
    updatedAt: newestTimestamp([
      limits?.timestamp,
      backups?.timestamp,
      agentStates?.timestamp,
      tokens?.observed?.observed_at ?? tokens?.observed?.sampled_at,
    ]),
    tokenPeriod,
  };
}
