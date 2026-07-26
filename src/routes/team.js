const { Router } = require('express');
const db = require('../db');
const collab = require('../analyzers/collab');
const { buildBackupSummary } = require('./backups').__private;

const router = Router();

// Default max concurrent tasks per agent (can be overridden per-agent in entities.json later)
const DEFAULT_MAX_CAPACITY = 5;
const HEALTH_STALE_MS = 15 * 60 * 1000;
const WORK_SIGNAL_WINDOW_MS = 60 * 60 * 1000;
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MESSAGE_ACTIONS = new Set(['sent_message', 'received_message', 'hxa_message']);
const TASK_ACTIONS = new Set(['task_success', 'task_failed', 'task_timeout', 'working_on']);
const IGNORED_WORK_ACTIONS = new Set(['heartbeat', 'came_online', 'went_offline']);

function isWorkSignal(action) {
  return !!action && !IGNORED_WORK_ACTIONS.has(action);
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1e9 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim()) {
      return numeric >= 1e9 && numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeRuntimeType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized === 'claude' || normalized === 'claude-code') return 'claude_code';
  if (normalized === 'codex-cli') return 'codex';
  return normalized;
}

function runtimeLabel(type) {
  switch (type) {
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'openclaw': return 'OpenClaw';
    default: return type || 'Unknown';
  }
}

function normalizeRuntimeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['running', 'online', 'ok', 'healthy'].includes(normalized)) return 'running';
  if (['warning', 'degraded', 'partial'].includes(normalized)) return 'degraded';
  if (['offline', 'stopped', 'down', 'error', 'failed'].includes(normalized)) return 'offline';
  return null;
}

function normalizeQuotaWindow(window, fallbackLabel = null) {
  if (!window || typeof window !== 'object') return null;
  const usedPercent = typeof window.used_percent === 'number'
    ? window.used_percent
    : typeof window.used_percentage === 'number'
      ? window.used_percentage
      : null;
  const resetsAt = normalizeTimestamp(window.resets_at);
  const windowMinutes = typeof window.window_minutes === 'number' ? window.window_minutes : null;
  if (usedPercent == null && !resetsAt && !windowMinutes) return null;
  return {
    label: window.label || fallbackLabel || null,
    window_minutes: windowMinutes,
    used_percent: usedPercent == null ? null : Math.max(0, Math.min(100, Math.round(usedPercent * 10) / 10)),
    resets_at: resetsAt,
  };
}

function normalizeQuotaShape(quota, fallbackSource = 'agent_health') {
  if (!quota || typeof quota !== 'object') return null;
  const primary = normalizeQuotaWindow(quota.primary || quota['5h'], '5h');
  const secondary = normalizeQuotaWindow(quota.secondary || quota['7d'], '7d');
  const requestedSupported = typeof quota.supported === 'boolean'
    ? quota.supported
    : !!(primary || secondary);
  const hasUsedQuotaWindow = [primary, secondary].some(window => typeof window?.used_percent === 'number');
  const supported = requestedSupported && hasUsedQuotaWindow;

  return {
    supported,
    source: quota.source || fallbackSource,
    reason: quota.reason || (requestedSupported && !hasUsedQuotaWindow ? 'no_used_quota_window' : null),
    sampled_at: normalizeTimestamp(quota.sampled_at),
    primary,
    secondary,
    credits: quota.credits || null,
  };
}

function selectQuotaForRuntime(health, runtimeType) {
  if (!health?.quota || typeof health.quota !== 'object') {
    return { supported: false, source: 'agent_health', reason: 'not_reported', primary: null, secondary: null, credits: null, sampled_at: null };
  }

  const quota = health.quota;
  const candidates = [
    runtimeType,
    runtimeType === 'claude' ? 'claude_code' : null,
    runtimeType === 'claude_code' ? 'claude' : null,
  ].filter(Boolean);

  for (const key of candidates) {
    if (quota[key]) {
      return normalizeQuotaShape(quota[key], key) || { supported: false, source: key, reason: 'invalid_payload', primary: null, secondary: null, credits: null, sampled_at: null };
    }
  }

  if (quota.primary || quota.secondary || typeof quota.supported === 'boolean') {
    return normalizeQuotaShape(quota, 'agent_health') || { supported: false, source: 'agent_health', reason: 'invalid_payload', primary: null, secondary: null, credits: null, sampled_at: null };
  }

  return { supported: false, source: 'agent_health', reason: 'not_reported', primary: null, secondary: null, credits: null, sampled_at: null };
}

function normalizeUsageTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const cleaned = {
    input: typeof tokens.input === 'number' ? tokens.input : null,
    output: typeof tokens.output === 'number' ? tokens.output : null,
    cache_creation: typeof tokens.cache_creation === 'number' ? tokens.cache_creation : null,
    cache_read: typeof tokens.cache_read === 'number' ? tokens.cache_read : null,
    cached_input: typeof tokens.cached_input === 'number' ? tokens.cached_input : null,
    reasoning: typeof tokens.reasoning === 'number' ? tokens.reasoning : null,
    total: typeof tokens.total === 'number' ? tokens.total : null,
  };
  return Object.values(cleaned).some(v => v != null) ? cleaned : null;
}

function normalizeUsageShape(usage, fallbackSource = 'agent_health') {
  if (!usage || typeof usage !== 'object') return null;
  const sessionTokens = normalizeUsageTokens(usage.session_tokens);
  const lastTurnTokens = normalizeUsageTokens(usage.last_turn_tokens);
  const supported = typeof usage.supported === 'boolean'
    ? usage.supported
    : !!(sessionTokens || lastTurnTokens);

  return {
    supported,
    source: usage.source || fallbackSource,
    reason: usage.reason || null,
    sampled_at: normalizeTimestamp(usage.sampled_at),
    session_id: usage.session_id || null,
    thread_id: usage.thread_id || null,
    model: usage.model || null,
    plan_type: usage.plan_type || null,
    session_tokens: sessionTokens,
    last_turn_tokens: lastTurnTokens,
    session_cost_usd: typeof usage.session_cost_usd === 'number' ? usage.session_cost_usd : null,
    estimated_cost: !!usage.estimated_cost,
    turns: typeof usage.turns === 'number' ? usage.turns : null,
    partial: !!usage.partial,
  };
}

function selectUsageForRuntime(health, runtimeType) {
  if (!health?.usage || typeof health.usage !== 'object') {
    return { supported: false, source: 'agent_health', reason: 'not_reported', session_tokens: null, last_turn_tokens: null, sampled_at: null };
  }

  const usage = health.usage;
  const candidates = [
    runtimeType,
    runtimeType === 'claude' ? 'claude_code' : null,
    runtimeType === 'claude_code' ? 'claude' : null,
  ].filter(Boolean);

  for (const key of candidates) {
    if (usage[key]) {
      return normalizeUsageShape(usage[key], key) || { supported: false, source: key, reason: 'invalid_payload', session_tokens: null, last_turn_tokens: null, sampled_at: null };
    }
  }

  if (usage.session_tokens || usage.last_turn_tokens || typeof usage.supported === 'boolean') {
    return normalizeUsageShape(usage, 'agent_health') || { supported: false, source: 'agent_health', reason: 'invalid_payload', session_tokens: null, last_turn_tokens: null, sampled_at: null };
  }

  return { supported: false, source: 'agent_health', reason: 'not_reported', session_tokens: null, last_turn_tokens: null, sampled_at: null };
}

function computeOverallSystemHealth(health) {
  if (!health) return 'unknown';
  const resourceStatus = resource => {
    if (typeof resource?.pct === 'number' && Number.isFinite(resource.pct)) {
      if (resource.pct >= 90) return 'critical';
      if (resource.pct >= 80) return 'warning';
      return 'ok';
    }
    return resource?.status || null;
  };
  const statuses = [resourceStatus(health.disk), resourceStatus(health.memory)].filter(Boolean);
  if (health.cpu?.pct != null) {
    statuses.push(health.cpu.pct >= 90 ? 'critical' : health.cpu.pct >= 80 ? 'warning' : 'ok');
  }
  if (health.pm2) {
    if (health.pm2.total > 0 && health.pm2.online === health.pm2.total) statuses.push('ok');
    else if (health.pm2.online === 0) statuses.push('critical');
    else statuses.push('warning');
  }
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return statuses.includes('ok') ? 'ok' : 'unknown';
}

function runtimeEvidenceLevel(health, runtimeType) {
  if (!health || typeof health !== 'object') return 'none';

  const detectionSource = String(health?.runtime?.detection_source || '').toLowerCase();
  if (['override', 'process', 'config', 'env'].includes(detectionSource)) return 'strong';

  if (health?.runtime?.version) return 'strong';

  const quotaSupported = health?.quota && typeof health.quota === 'object'
    ? Object.values(health.quota).some(item => item && typeof item === 'object' && item.supported === true)
    : false;
  if (quotaSupported) return 'weak';

  const usageSupported = health?.usage && typeof health.usage === 'object'
    ? Object.values(health.usage).some(item => item && typeof item === 'object' && item.supported === true)
    : false;
  if (usageSupported) return 'weak';

  if (runtimeType && runtimeType !== 'unknown') return 'weak';
  if (health?.runtime?.source && health.runtime.source !== 'unknown') return 'weak';

  return 'none';
}

function buildRuntimeSummary(agent, health, now) {
  const reportedAt = normalizeTimestamp(health?.reported_at);
  const stale = !reportedAt || (now - reportedAt) > HEALTH_STALE_MS;
  const type = normalizeRuntimeType(health?.runtime?.type);
  const rawStatus = normalizeRuntimeStatus(health?.runtime?.status);
  const systemHealth = computeOverallSystemHealth(health);
  const evidence = runtimeEvidenceLevel(health, type);
  const statusSource = String(health?.runtime?.status_source || '').toLowerCase();
  const detectionSource = String(health?.runtime?.detection_source || '').toLowerCase();
  const runtimeSource = String(health?.runtime?.source || '').toLowerCase();
  const runningIsObserved = ['override', 'process', 'runtime_health'].includes(statusSource)
    || detectionSource === 'process'
    || (type === 'openclaw' && /(health|status)/.test(runtimeSource));

  // Fresh/stale collection, installed runtime, runtime process state, and work
  // evidence are separate. In particular, an installed binary/version cannot
  // promote an agent to "running".
  let status = 'unknown';
  if (!stale && rawStatus === 'running') {
    status = runningIsObserved ? 'running' : 'degraded';
  } else if (!stale && rawStatus) {
    status = rawStatus;
  }

  return {
    type,
    label: runtimeLabel(type),
    version: health?.runtime?.version || null,
    installed: typeof health?.runtime?.installed === 'boolean'
      ? health.runtime.installed
      : !!health?.runtime?.version,
    status,
    status_source: health?.runtime?.status_source || null,
    source: health?.runtime?.source || 'agent_health',
    detection_source: health?.runtime?.detection_source || null,
    checked_at: normalizeTimestamp(health?.runtime?.checked_at) || reportedAt,
    last_heartbeat_at: reportedAt,
    hostname: health?.hostname || null,
    stale,
    system_health: systemHealth,
    evidence,
  };
}

function deriveWorkState(lastWorkSignalAt, now = Date.now()) {
  const observedAt = normalizeTimestamp(lastWorkSignalAt);
  if (observedAt && observedAt > (now - WORK_SIGNAL_WINDOW_MS)) return 'working';
  if (observedAt && observedAt > (now - ACTIVE_WINDOW_MS)) return 'standby';
  return 'unknown';
}

function firstNumber(...values) {
  return values.find(value => typeof value === 'number' && Number.isFinite(value)) ?? null;
}

function firstTimestamp(...values) {
  for (const value of values) {
    const normalized = normalizeTimestamp(value);
    if (normalized != null) return normalized;
  }
  return null;
}

function severityMax(current, next) {
  const rank = { ok: 0, warning: 1, critical: 2 };
  return (rank[next] || 0) > (rank[current] || 0) ? next : current;
}

function isFreshSample(sampledAt, now) {
  const normalized = normalizeTimestamp(sampledAt);
  if (normalized == null || normalized > now) return false;
  return (now - normalized) <= HEALTH_STALE_MS;
}

function buildMonitoringSummary(health, runtime, quota, usage, backup, now = Date.now()) {
  const observedAt = normalizeTimestamp(health?.reported_at);
  const ageMs = observedAt == null ? null : Math.max(0, now - observedAt);
  const freshness = observedAt == null
    ? 'missing'
    : ageMs > HEALTH_STALE_MS ? 'stale' : 'fresh';
  const roster = health?.roster && typeof health.roster === 'object' ? health.roster : null;
  const fiveHourRoster = roster?.rate_limits?.five_hour || null;
  const sevenDayRoster = roster?.rate_limits?.seven_day || null;

  const contextPct = firstNumber(roster?.context_used_pct);
  const contextTokens = firstNumber(roster?.context_total_tokens);
  const quotaHasFiveHour = typeof quota?.primary?.used_percent === 'number'
    && Number.isFinite(quota.primary.used_percent);
  const quotaHasSevenDay = typeof quota?.secondary?.used_percent === 'number'
    && Number.isFinite(quota.secondary.used_percent);
  const fiveHourPct = firstNumber(quota?.primary?.used_percent, fiveHourRoster?.used_pct);
  const sevenDayPct = firstNumber(quota?.secondary?.used_percent, sevenDayRoster?.used_pct);
  const fiveHourResetsAt = firstTimestamp(quota?.primary?.resets_at, fiveHourRoster?.resets_at);
  const sevenDayResetsAt = firstTimestamp(quota?.secondary?.resets_at, sevenDayRoster?.resets_at);
  const contextSampledAt = firstTimestamp(roster?.sampled_at);
  const fiveHourSampledAt = quotaHasFiveHour
    ? firstTimestamp(quota?.sampled_at)
    : firstTimestamp(roster?.sampled_at);
  const sevenDaySampledAt = quotaHasSevenDay
    ? firstTimestamp(quota?.sampled_at)
    : firstTimestamp(roster?.sampled_at);
  const sessionTotal = firstNumber(usage?.session_tokens?.total, contextTokens);
  const lastTurnTotal = firstNumber(usage?.last_turn_tokens?.total);
  const costUsd = firstNumber(usage?.session_cost_usd, roster?.cost_usd);

  const reasonCodes = [];
  const collectionReasonCodes = [];
  let severity = 'ok';
  const addReason = (code, level = 'warning', { collection = false } = {}) => {
    if (!reasonCodes.includes(code)) reasonCodes.push(code);
    if (collection && !collectionReasonCodes.includes(code)) collectionReasonCodes.push(code);
    severity = severityMax(severity, level);
  };

  if (freshness === 'missing') addReason('report_missing', 'warning', { collection: true });
  if (freshness === 'stale') addReason('report_stale', 'warning', { collection: true });

  const diskPct = firstNumber(health?.disk?.pct);
  const memoryPct = firstNumber(health?.memory?.pct);
  const cpuPct = firstNumber(health?.cpu?.pct);
  const pm2Online = firstNumber(health?.pm2?.online);
  const pm2Total = firstNumber(health?.pm2?.total);

  if (freshness === 'fresh') {
    if (diskPct >= 90 || health?.disk?.status === 'critical') {
      addReason('disk_critical', 'critical', { collection: true });
    } else if (diskPct >= 80 || health?.disk?.status === 'warning') {
      addReason('disk_warning', 'warning', { collection: true });
    }
    if (memoryPct >= 90 || health?.memory?.status === 'critical') {
      addReason('memory_critical', 'critical', { collection: true });
    } else if (memoryPct >= 80 || health?.memory?.status === 'warning') {
      addReason('memory_warning', 'warning', { collection: true });
    }
    if (cpuPct >= 90 || health?.cpu?.status === 'critical') {
      addReason('cpu_critical', 'critical', { collection: true });
    } else if (cpuPct >= 80 || health?.cpu?.status === 'warning') {
      addReason('cpu_warning', 'warning', { collection: true });
    }
    if (pm2Total > 0 && pm2Online === 0) {
      addReason('pm2_offline', 'critical', { collection: true });
    } else if (pm2Total > 0 && pm2Online < pm2Total) {
      addReason('pm2_partial', 'warning', { collection: true });
    }
  }

  if (isFreshSample(contextSampledAt, now)) {
    if (contextPct >= 95) addReason('context_critical', 'critical');
    else if (contextPct >= 80) addReason('context_high', 'warning');
  }
  if (isFreshSample(fiveHourSampledAt, now)) {
    if (fiveHourPct >= 95) addReason('quota_5h_critical', 'critical');
    else if (fiveHourPct >= 80) addReason('quota_5h_high', 'warning');
  }
  if (isFreshSample(sevenDaySampledAt, now)) {
    if (sevenDayPct >= 95) addReason('quota_7d_critical', 'critical');
    else if (sevenDayPct >= 80) addReason('quota_7d_high', 'warning');
  }

  if (backup?.status === 'critical') addReason('backup_critical', 'critical');
  else if (backup?.status === 'warning') addReason('backup_warning', 'warning');
  if (['backup_success_stale', 'backup_success_too_old'].includes(backup?.reason)) {
    addReason('backup_stale', backup.status === 'critical' ? 'critical' : 'warning');
  }

  let collectionStatus = 'unknown';
  if (freshness === 'stale') collectionStatus = 'stale';
  else if (freshness === 'fresh') {
    const collectionSeverity = collectionReasonCodes.some(code => code.endsWith('_critical') || code === 'pm2_offline')
      ? 'critical'
      : collectionReasonCodes.length > 0 ? 'warning' : 'ok';
    collectionStatus = diskPct == null || memoryPct == null ? 'unknown' : collectionSeverity;
  }

  const versions = [];
  if (runtime?.type !== 'unknown' || runtime?.version) {
    versions.push({
      component: 'runtime',
      label: runtime?.label || runtimeLabel(runtime?.type),
      version: runtime?.version || null,
    });
  }
  if (roster?.version) {
    versions.push({
      component: 'statusline',
      label: 'Statusline',
      version: roster.version,
    });
  }

  return {
    observed_at: observedAt,
    freshness,
    age_ms: ageMs,
    collection: {
      status: collectionStatus,
      reason_codes: collectionReasonCodes,
      reported_at: observedAt,
      sampled_at: firstTimestamp(roster?.sampled_at),
    },
    system: {
      cpu_pct: cpuPct,
      memory_pct: memoryPct,
      disk_pct: diskPct,
      pm2_online: pm2Online,
      pm2_total: pm2Total,
    },
    capacity: {
      context_pct: contextPct,
      context_tokens: contextTokens,
      context_sampled_at: contextSampledAt,
      five_hour_pct: fiveHourPct,
      five_hour_resets_at: fiveHourResetsAt,
      five_hour_sampled_at: fiveHourSampledAt,
      seven_day_pct: sevenDayPct,
      seven_day_resets_at: sevenDayResetsAt,
      seven_day_sampled_at: sevenDaySampledAt,
      sampled_at: firstTimestamp(quota?.sampled_at, roster?.sampled_at),
    },
    tokens: {
      session_total: sessionTotal,
      last_turn_total: lastTurnTotal,
      cost_usd: costUsd,
      sampled_at: firstTimestamp(usage?.sampled_at, roster?.sampled_at),
    },
    versions,
    backup: {
      status: backup?.status || 'unsupported',
      last_success_at: firstTimestamp(backup?.last_success_at),
    },
    anomaly: {
      severity,
      reason_codes: reasonCodes,
    },
  };
}

function buildFleetMonitoringSummary(agents) {
  const rows = Array.isArray(agents) ? agents : [];
  const total = rows.length;
  const fresh = rows.filter(agent => agent.monitoring?.freshness === 'fresh').length;
  const stale = rows.filter(agent => agent.monitoring?.freshness === 'stale').length;
  const missing = rows.filter(agent => agent.monitoring?.freshness === 'missing').length;
  const observed = fresh + stale;
  const agentAttention = rows.filter(agent => agent.monitoring?.anomaly?.severity !== 'ok').length;
  const ingestChainSuspected = total > 0 && (stale + missing) === total;
  const independentAttention = rows.filter(agent => {
    const codes = agent.monitoring?.anomaly?.reason_codes;
    return Array.isArray(codes)
      && codes.some(code => !['report_stale', 'report_missing'].includes(code));
  }).length;
  const hasCritical = rows.some(agent => agent.monitoring?.anomaly?.severity === 'critical');
  const needsAttention = ingestChainSuspected
    ? 1 + independentAttention
    : agentAttention;
  const severity = hasCritical
    ? 'critical'
    : needsAttention > 0 ? 'warning' : 'ok';

  return {
    total,
    observed,
    fresh,
    stale,
    missing,
    needs_attention: needsAttention,
    anomaly: {
      severity,
      reason_codes: ingestChainSuspected ? ['ingest_chain_suspected'] : [],
    },
  };
}

// Build enriched agent list — shared between REST and WS broadcasts
function buildAgents() {
  return db.getAllAgents().map(a => {
    // Assignee-only tasks for status/current work (don't show authored/reviewed tasks as "my work")
    const assignedTasks = db.getTasksForAgent(a.name, { assigneeOnly: true });
    const openTasks = assignedTasks.filter(t => t.state === 'opened');
    // All related tasks (assignee + author + reviewer) for historical stats
    const allTasks = db.getTasksForAgent(a.name);
    const closedTasks = allTasks.filter(t => t.state === 'closed' || t.state === 'merged');
    const recentEvents = db.getEventsForAgent(a.name, 5);
    const latestEvent = recentEvents[0] || null;
    const allRecentEvents = db.getEventsForAgent(a.name, 200);
    const health = db.getAgentHealth(a.name);

    const now = Date.now();
    const runtime = buildRuntimeSummary(a, health, now);
    const quota = selectQuotaForRuntime(health, runtime.type);
    const usage = selectUsageForRuntime(health, runtime.type);
    const backup = buildBackupSummary(health?.backup || null, a.name);
    const recentWorkEvents = allRecentEvents.filter(e => e.timestamp && e.timestamp > (now - WORK_SIGNAL_WINDOW_MS) && isWorkSignal(e.action));
    const lastWorkSignal = recentWorkEvents[0] || allRecentEvents.find(e => isWorkSignal(e.action)) || null;
    const latestEventTs = (lastWorkSignal && lastWorkSignal.timestamp) || 0;
    const workState = deriveWorkState(latestEventTs, now);
    const monitoring = buildMonitoringSummary(health, runtime, quota, usage, backup, now);

    const sevenDays = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDays = now - 30 * 24 * 60 * 60 * 1000;
    const closedLast7 = closedTasks.filter(t => t.updated_at > sevenDays).length;
    const closedLast30 = closedTasks.filter(t => t.updated_at > thirtyDays).length;

    // Average completion time (for tasks with both created_at and updated_at where closed)
    const completionTimes = closedTasks
      .filter(t => t.created_at && t.updated_at && t.updated_at > t.created_at)
      .map(t => t.updated_at - t.created_at);
    const avgCompletionMs = completionTimes.length > 0
      ? completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length
      : null;

    // Active projects: distinct project names from open assigned tasks (#44)
    const activeProjects = [...new Set(openTasks.map(t => t.project).filter(p => p && p !== 'unknown'))];

    // Top collaborator (#44)
    const topCollaborator = db.getTopCollaborator(a.name);

    // Capacity: current open tasks vs max capacity (#44)
    const capacity = { current: openTasks.length, max: DEFAULT_MAX_CAPACITY };

    // Health score: 0-100 based on activity recency + completion rate + task load balance (#45)
    const healthScore = computeHealthScore(recentEvents, closedTasks, openTasks, now);

    // Blocking MRs: open MRs stale > 15 min (agent-scale SLA) (#98)
    const blockingMRs = db.getBlockingMRsForAgent(a.name, now);

    // Last active time: most recent event timestamp (#98)
    const lastActiveAt = lastWorkSignal ? lastWorkSignal.timestamp : (latestEvent ? latestEvent.timestamp : (a.last_seen_at || null));

    // Activity metrics (#135): events and closed tasks in last 7 days
    const events7d = db.getEventsInWindow(sevenDays, a.name);
    const closed7d = db.getTasksClosedInWindow(sevenDays, a.name);
    const workSignals7d = events7d.filter(e => isWorkSignal(e.action));
    const messages24h = db.getEventsInWindow(now - 24 * 60 * 60 * 1000, a.name).filter(e => MESSAGE_ACTIONS.has(e.action)).length;
    const tasks24h = db.getEventsInWindow(now - 24 * 60 * 60 * 1000, a.name).filter(e => TASK_ACTIONS.has(e.action)).length;
    const activeDays7d = new Set(workSignals7d.map(e => new Date(e.timestamp).toISOString().slice(0, 10))).size;

    return {
      ...a,
      tags: safeJSON(a.tags),
      online: !!a.online,
      work_state: workState,
      runtime_status: runtime.status,
      work_status: workState,
      tier_status: runtime.status,
      runtime,
      quota,
      usage,
      backup,
      monitoring,
      last_heartbeat_at: runtime.last_heartbeat_at,
      active_projects: activeProjects,
      top_collaborator: topCollaborator,
      capacity,
      health_score: healthScore,
      last_active_at: lastActiveAt,
      events_7d: events7d.length,
      closed_7d: closed7d.length,
      blocking_mrs: blockingMRs,
      current_tasks: openTasks.slice(0, 3).map(t => ({
        title: t.title,
        type: t.type,
        state: t.state,
        url: t.url || null,
        project: t.project || null,
        updated_at: t.updated_at
      })),
      latest_event: latestEvent ? {
        action: latestEvent.action,
        target_title: latestEvent.target_title,
        timestamp: latestEvent.timestamp,
        project: latestEvent.project
      } : null,
      recent_work_signal: lastWorkSignal ? {
        action: lastWorkSignal.action,
        target_title: lastWorkSignal.target_title,
        timestamp: lastWorkSignal.timestamp,
        project: lastWorkSignal.project
      } : null,
      sparkline_7d: db.getAgentSparkline7d(a.name),
      hardware: buildHardwareSummary(health, runtime),
      stats: {
        open_tasks: openTasks.length,
        closed_tasks: closedTasks.length,
        mr_count: allTasks.filter(t => t.type === 'mr').length,
        issue_count: allTasks.filter(t => t.type === 'issue').length,
        recent_events: recentEvents.length,
        closed_last_7d: closedLast7,
        closed_last_30d: closedLast30,
        avg_completion_ms: avgCompletionMs,
        work_signals_7d: workSignals7d.length,
        messages_24h: messages24h,
        tasks_24h: tasks24h,
        active_days_7d: activeDays7d,
      }
    };
  });
}

// GET /api/team — all agents + stats
router.get('/', (req, res) => {
  const agents = buildAgents();

  const online = agents.filter(a => a.online).length;
  res.json({
    agents,
    monitoring: buildFleetMonitoringSummary(agents),
    stats: {
      total: agents.length,
      online,
      offline: agents.length - online,
      work_state: {
        working: agents.filter(a => a.work_state === 'working').length,
        standby: agents.filter(a => a.work_state === 'standby').length,
        offline: agents.filter(a => a.work_state === 'offline').length,
        unknown: agents.filter(a => a.work_state === 'unknown').length,
      },
      runtime: {
        running: agents.filter(a => a.runtime_status === 'running').length,
        degraded: agents.filter(a => a.runtime_status === 'degraded').length,
        offline: agents.filter(a => a.runtime_status === 'offline').length,
        unknown: agents.filter(a => a.runtime_status === 'unknown').length,
      },
    }
  });
});

// GET /api/team/:name/output — per-agent daily output time-series (#127)
router.get('/:name/output', (req, res) => {
  const agent = db.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const output = db.getAgentDailyOutput(agent.name, days);
  res.json(output);
});

// GET /api/team/:name — single agent detail
router.get('/:name', (req, res) => {
  const agent = buildAgents().find(item => item.name === req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const tasks = db.getTasksForAgent(agent.name);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const events = db.getEventsForAgent(agent.name, 200).filter(e => (e.timestamp || 0) > sevenDaysAgo);
  const collabs = db.getCollabsForAgent(agent.name);

  res.json({
    agent,
    current_tasks: tasks.filter(t => t.state === 'opened'),
    recent_done: tasks.filter(t => t.state === 'closed' || t.state === 'merged').slice(0, 10),
    events,
    collabs: collabs.map(c => ({
      partner: c.source === agent.name ? c.target : c.source,
      type: c.type,
      weight: c.weight
    })),
    stats: {
      mr_count: tasks.filter(t => t.type === 'mr').length,
      issue_count: tasks.filter(t => t.type === 'issue').length,
      open_tasks: tasks.filter(t => t.state === 'opened').length,
      closed_tasks: tasks.filter(t => t.state === 'closed' || t.state === 'merged').length
    }
  });
});

// Build compact hardware summary from agent-health data (#122)
function buildHardwareSummary(health, runtime) {
  if (!health) return null;

  const stale = (Date.now() - health.reported_at) > HEALTH_STALE_MS;
  return {
    disk_pct: health.disk ? health.disk.pct : null,
    disk_status: health.disk ? health.disk.status : null,
    mem_pct: health.memory ? health.memory.pct : null,
    mem_status: health.memory ? health.memory.status : null,
    cpu_pct: health.cpu ? health.cpu.pct : null,
    pm2_online: health.pm2 ? health.pm2.online : null,
    pm2_total: health.pm2 ? health.pm2.total : null,
    hostname: health.hostname || runtime?.hostname || null,
    runtime_type: runtime?.type || 'unknown',
    runtime_version: runtime?.version || null,
    runtime_status: runtime?.status || 'unknown',
    system_health: runtime?.system_health || 'unknown',
    stale,
    reported_at: health.reported_at,
  };
}

// Compute a 0-100 health score based on activity recency, completion rate, and load balance (#45)
function computeHealthScore(recentEvents, closedTasks, openTasks, now) {
  // 1. Activity recency (0-40): how recently was the agent active?
  // recentEvents is sorted desc by timestamp (see db.getEventsForAgent), so [0] is the latest
  let activityScore = 0;
  if (recentEvents.length > 0) {
    const latestTs = recentEvents[0].timestamp || 0;
    const hoursSince = (now - latestTs) / (1000 * 60 * 60);
    if (hoursSince < 1) activityScore = 40;
    else if (hoursSince < 6) activityScore = 35;
    else if (hoursSince < 24) activityScore = 25;
    else if (hoursSince < 72) activityScore = 15;
    else if (hoursSince < 168) activityScore = 5;
    else activityScore = 0;
  }

  // 2. Completion rate (0-30): ratio of closed tasks to total
  let completionScore = 0;
  const totalTasks = closedTasks.length + openTasks.length;
  if (totalTasks > 0) {
    const ratio = closedTasks.length / totalTasks;
    completionScore = Math.round(ratio * 30);
  }

  // 3. Load balance (0-30): not too few, not too many open tasks
  let loadScore = 0;
  const openCount = openTasks.length;
  if (openCount === 0) loadScore = 10;        // idle — low but not zero
  else if (openCount <= 3) loadScore = 30;     // healthy load
  else if (openCount <= 5) loadScore = 20;     // moderate
  else if (openCount <= 8) loadScore = 10;     // heavy
  else loadScore = 5;                          // overloaded

  return Math.min(100, activityScore + completionScore + loadScore);
}

function safeJSON(str) {
  if (Array.isArray(str)) return str;
  try { return JSON.parse(str); } catch { return []; }
}

module.exports = router;
module.exports.buildAgents = buildAgents;
module.exports.__private = {
  HEALTH_STALE_MS,
  runtimeEvidenceLevel,
  buildRuntimeSummary,
  selectQuotaForRuntime,
  selectUsageForRuntime,
  deriveWorkState,
  buildMonitoringSummary,
  buildFleetMonitoringSummary,
};
