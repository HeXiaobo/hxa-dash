import { AGENT_STATE_FRESH_MS, buildWorkbenchModel } from './workbench-model.js';

const READ_ENDPOINTS = {
  team: '/api/team',
  limits: '/api/limits',
  tokens: '/api/tokens?days=7',
  backups: '/api/backups',
  agentStates: '/api/agent-state',
  about: '/api/about'
};

const FETCH_TIMEOUT_MS = 10_000;

const WORKBENCH_REFRESH_PLAN = Object.freeze([
  Object.freeze({ intervalMs: 30_000, keys: Object.freeze(['agentStates']) }),
  Object.freeze({ intervalMs: 60_000, keys: Object.freeze(['team', 'limits']) }),
  Object.freeze({ intervalMs: 300_000, keys: Object.freeze(['tokens', 'backups', 'about']) })
]);

export function scheduleWorkbenchRefresh(setIntervalImpl, refresh) {
  return WORKBENCH_REFRESH_PLAN.map(({ intervalMs, keys }) => (
    setIntervalImpl(() => refresh([...keys]), intervalMs)
  ));
}

function withBase(basePath, endpoint) {
  const base = String(basePath || '').replace(/\/+$/, '');
  return `${base}${endpoint}`;
}

export function classicRedirectForHash(hash, basePath = '') {
  const value = String(hash || '');
  if (!value.startsWith('#') || value.length <= 1) return null;
  return `${String(basePath || '').replace(/\/+$/, '')}/classic${value}`;
}

async function fetchJson(fetchImpl, url) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('timeout'));
      controller.abort('timeout');
    }, FETCH_TIMEOUT_MS);
  });
  try {
    const request = (async () => {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      return response.json();
    })();
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchWorkbenchSnapshot(fetchImpl = fetch, basePath = '', requestedKeys = Object.keys(READ_ENDPOINTS)) {
  const keys = new Set(requestedKeys);
  const entries = Object.entries(READ_ENDPOINTS).filter(([key]) => keys.has(key));
  const settled = await Promise.allSettled(
    entries.map(([, endpoint]) => fetchJson(fetchImpl, withBase(basePath, endpoint)))
  );
  const snapshot = { errors: [] };
  entries.forEach(([key], index) => {
    const result = settled[index];
    if (result.status === 'fulfilled') snapshot[key] = result.value;
    else snapshot.errors.push({ source: key, reason: result.reason?.message || 'unavailable' });
  });
  return snapshot;
}

export function mergeWorkbenchSnapshots(previousSnapshot, update, requestedKeys) {
  const requested = new Set(requestedKeys);
  const next = { ...(previousSnapshot || {}) };
  for (const key of requested) {
    if (Object.hasOwn(update, key)) next[key] = update[key];
    else delete next[key];
  }
  const retainedErrors = Array.isArray(previousSnapshot?.errors)
    ? previousSnapshot.errors.filter(error => !requested.has(error.source))
    : [];
  next.errors = [...retainedErrors, ...(update.errors || [])];
  return next;
}

export function createWorkbenchRefreshController({
  fetchImpl = fetch,
  basePath = '',
  initialSnapshot = { errors: [] },
  onSnapshot = () => {},
} = {}) {
  let snapshot = initialSnapshot;
  const inFlight = new Map();
  const sourceGenerations = new Map();
  return {
    refresh(requestedKeys = Object.keys(READ_ENDPOINTS)) {
      const keys = [...new Set(requestedKeys)].filter(key => Object.hasOwn(READ_ENDPOINTS, key));
      const group = [...keys].sort().join('\u0000');
      if (inFlight.has(group)) return inFlight.get(group);
      const generation = new Map(keys.map(key => {
        const next = (sourceGenerations.get(key) || 0) + 1;
        sourceGenerations.set(key, next);
        return [key, next];
      }));
      let pending;
      pending = fetchWorkbenchSnapshot(fetchImpl, basePath, keys)
        .then(update => {
          const currentKeys = keys.filter(key => sourceGenerations.get(key) === generation.get(key));
          if (currentKeys.length === 0) return snapshot;
          const currentUpdate = {
            errors: (update.errors || []).filter(error => currentKeys.includes(error.source)),
          };
          for (const key of currentKeys) {
            if (Object.hasOwn(update, key)) currentUpdate[key] = update[key];
          }
          snapshot = mergeWorkbenchSnapshots(snapshot, currentUpdate, currentKeys);
          onSnapshot(snapshot);
          return snapshot;
        })
        .finally(() => {
          if (inFlight.get(group) === pending) inFlight.delete(group);
        });
      inFlight.set(group, pending);
      return pending;
    },
  };
}

function nextAgentStateExpiryDelay(snapshot, now) {
  const expiries = (snapshot?.agentStates?.states || [])
    .map(record => record?.state)
    .filter(state => state?.status === 'fresh' && state?.stale !== true)
    .map(state => Date.parse(state.observed_at) + AGENT_STATE_FRESH_MS + 1)
    .filter(expiresAt => Number.isFinite(expiresAt) && expiresAt > now);
  if (expiries.length === 0) return null;
  return Math.min(...expiries) - now;
}

export function createWorkbenchSnapshotPresenter({
  renderSnapshot = () => {},
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let currentSnapshot = null;
  let expiryTimer = null;
  const present = snapshot => {
    if (expiryTimer !== null) {
      clearTimeoutImpl(expiryTimer);
      expiryTimer = null;
    }
    currentSnapshot = snapshot;
    renderSnapshot(snapshot);
    const expiryDelay = nextAgentStateExpiryDelay(snapshot, now());
    if (expiryDelay !== null) {
      expiryTimer = setTimeoutImpl(() => {
        expiryTimer = null;
        present(currentSnapshot);
      }, expiryDelay);
    }
    return snapshot;
  };
  return {
    present,
    revalidate() {
      return currentSnapshot === null ? null : present(currentSnapshot);
    },
  };
}

export function modelFromSnapshot(snapshot) {
  return buildWorkbenchModel({
    team: snapshot?.team || {},
    limits: snapshot?.limits || {},
    tokens: snapshot?.tokens || {},
    backups: snapshot?.backups || {},
    agentStates: snapshot?.agentStates || {},
    about: snapshot?.about || {}
  });
}

function highestQuota(employee) {
  const values = [employee?.q5, employee?.q7].filter(value => value != null && Number.isFinite(Number(value)));
  return values.length > 0 ? Math.max(...values.map(Number)) : null;
}

function quotaRisk(value) {
  if (value == null) return { label: '待汇总', level: 'mid' };
  if (value >= 85) return { label: '接近上限', level: 'high' };
  if (value >= 70) return { label: '关注', level: 'mid' };
  return { label: '正常', level: 'low' };
}

export function buildWorkbenchPresentation(model) {
  const employees = Array.isArray(model?.employees) ? model.employees : [];
  const total = Number(model?.coverage?.total) || employees.length;
  const quotaEmployees = employees
    .map(employee => ({ employee, peak: highestQuota(employee) }))
    .filter(item => item.peak != null)
    .sort((left, right) => right.peak - left.peak);
  const tokenEmployees = employees
    .filter(employee => employee.tokens != null && Number.isFinite(Number(employee.tokens)))
    .sort((left, right) => Number(right.tokens) - Number(left.tokens));
  const backup = model?.backup || {};
  const restoreLabel = backup.restoreStatus === 'verified'
    ? '已验证'
    : backup.restoreStatus === 'failed' ? '验证失败' : '待验证';

  return {
    updatedAt: model?.updatedAt || null,
    quota: {
      covered: quotaEmployees.length,
      missing: Math.max(0, total - quotaEmployees.length),
      risk: quotaEmployees.filter(item => item.peak >= 85).length,
      rows: quotaEmployees.map(({ employee, peak }) => ({
        id: employee.id,
        name: employee.name,
        q5: employee.q5,
        q7: employee.q7,
        q5Reset: employee.q5Reset || null,
        q7Reset: employee.q7Reset || null,
        ...quotaRisk(peak)
      }))
    },
    tokens: {
      covered: tokenEmployees.length,
      missing: Math.max(0, total - tokenEmployees.length),
      coverageLabel: `可比员工 ${tokenEmployees.length} / ${total}`,
      rows: tokenEmployees.map(employee => ({
        id: employee.id,
        name: employee.name,
        rankLabel: tokenEmployees.length > 1 && employee.rank != null ? String(employee.rank) : '—',
        valueLabel: `${Number(employee.tokens).toLocaleString('zh-CN')} Token`
      })),
      note: tokenEmployees.length > 1 ? '使用同一统计口径生成名次' : '可比员工覆盖不足，不生成名次',
      period: model?.tokenPeriod || null
    },
    backup: {
      covered: Number(backup.covered) || 0,
      healthy: Number(backup.healthy) || 0,
      synchronized: Number(backup.synchronized) || 0,
      latestSuccessAt: backup.latestSuccessAt || null,
      restoreLabel
    }
  };
}

function formatDateTime(value) {
  if (!value) return '暂不可用';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂不可用';
  return date.toLocaleString('zh-CN', { hour12: false });
}

const DETAIL_SOURCE_LABELS = Object.freeze({
  agent_health: '中央健康记录（agent_health）',
  statusline: '本机状态行（statusline）',
  statusline_roster: '本机状态清单（statusline_roster）',
  transcript: '会话记录（transcript）',
  codex: 'Codex 本机记录（codex）',
  dashboard_api: '本机 Dashboard 只读接口（dashboard_api）',
  activity_monitor_fallback: '活跃度监控补充（activity_monitor_fallback）',
});

const DETAIL_REASON_LABELS = Object.freeze({
  not_reported: '未上报',
  unsupported: '不支持',
  unsupported_for_now: '暂不支持',
  no_used_quota_window: '没有可用额度窗口',
  window_not_reported: '对应额度窗口未上报',
  sample_time_unavailable: '缺少采样时间',
  invalid_value: '值格式无效',
  no_authoritative_field: '没有权威字段',
  three_evidence_not_reported: '三项备份证据未齐',
  activity_monitor_unavailable: '活跃度监控不可用',
  stale_sample: '采样已过期',
  single_session_snapshot_not_comparable: '仅有单会话快照，不能用于 7 天排行',
});

function detailSourceLabel(source) {
  return DETAIL_SOURCE_LABELS[source] || '未提供';
}

function detailReasonLabel(reason) {
  return DETAIL_REASON_LABELS[reason] || '未提供有效原因';
}

function detailEvidence({ available, value, source, sampledAt, unavailableReason }) {
  return {
    availability: available ? 'available' : 'unavailable',
    value: available ? value : '暂不可用',
    meta: `来源：${detailSourceLabel(source)} · 采样：${formatDateTime(sampledAt)} · 不可用原因：${available ? '无' : detailReasonLabel(unavailableReason)}`,
  };
}

function runtimeTypeLabel(type) {
  if (type === 'codex') return 'Codex';
  if (type === 'claude' || type === 'claude_code') return 'Claude Code';
  if (type === 'openclaw') return 'OpenClaw';
  if (type === 'unknown') return '运行时类型未知';
  return null;
}

function quotaDetail(window, quota) {
  const available = window?.availability === 'available' && window.usedPercent != null;
  const evidence = detailEvidence({
    available,
    value: available ? `已用 ${window.usedPercent}%` : null,
    source: quota?.source,
    sampledAt: quota?.sampledAt,
    unavailableReason: window?.unavailableReason || 'not_reported',
  });
  if (available && window?.resetsAt) {
    evidence.meta += ` · 重置：${formatDateTime(window.resetsAt)}`;
  }
  return evidence;
}

function comparableTokenRank(employee) {
  const available = employee?.tokens != null && Number.isFinite(Number(employee.tokens));
  const value = employee?.rank != null
    ? `第 ${employee.rank} 名 · ${Number(employee.tokens).toLocaleString('zh-CN')} Token（7 天可比口径）`
    : `${Number(employee?.tokens || 0).toLocaleString('zh-CN')} Token（7 天可比口径；覆盖不足不排名）`;
  return {
    availability: available ? 'available' : 'unavailable',
    value: available ? value : '暂不可用',
    meta: `来源：中央 7 天 Token 汇总（/api/tokens） · 源采样：${formatDateTime(employee?.tokenSampledAt)} · 中央确认：${formatDateTime(employee?.tokenObservedAt)} · 不可用原因：${available ? '无' : detailReasonLabel(employee?.tokenUnavailableReason || 'not_reported')}`,
  };
}

export function buildEmployeeDetailPresentation(employee = {}) {
  const observability = employee.observability || {};
  const runtime = observability.runtime || {};
  const model = observability.model || {};
  const context = observability.context || {};
  const quota = observability.quota || {};
  const sessionTokens = observability.sessionTokens || {};
  const cost = observability.cost || {};
  const backup = observability.backup || {};
  const activity = observability.activity || {};
  const runtimeLabel = runtimeTypeLabel(runtime.type);
  const runtimeAvailable = runtime.availability === 'available' && runtimeLabel != null;
  const modelAvailable = model.availability === 'available' && model.value != null;
  const pendingRestartAvailable = runtime.pendingRestartAvailability === 'available'
    && typeof runtime.pendingRestart === 'boolean';
  const contextAvailable = context.availability === 'available' && context.usedPercent != null;
  const contextParts = contextAvailable ? [`已用 ${context.usedPercent}%`] : [];
  if (contextAvailable && context.remainingPercent != null) contextParts.push(`剩余 ${context.remainingPercent}%`);
  if (contextAvailable && context.totalTokens != null) {
    contextParts.push(`当前上下文 ${Number(context.totalTokens).toLocaleString('zh-CN')} Token`);
  }
  const sessionTokensAvailable = sessionTokens.availability === 'available' && sessionTokens.total != null;
  const costAvailable = cost.availability === 'available' && cost.total != null && cost.currency === 'USD';
  const backupAvailable = backup.availability === 'available' && backup.status != null;
  const lastSuccessAvailable = backupAvailable
    && backup.lastSuccessAvailability === 'available'
    && backup.lastSuccessAt != null;
  const remoteMatchAvailable = backupAvailable
    && backup.remoteMatchAvailability === 'available'
    && typeof backup.remoteMatch === 'boolean';
  const restoreDrillAvailable = backupAvailable
    && backup.restoreDrill?.status === 'verified'
    && backup.restoreDrill?.evidenceAt != null;
  const backupEvidenceReason = backupAvailable
    ? 'three_evidence_not_reported'
    : (backup.unavailableReason || 'not_reported');
  const activityAvailable = activity.availability === 'available'
    && activity.source === 'activity_monitor_fallback'
    && activity.usedForRouting === false;
  const activityState = {
    busy: '工作中',
    idle: '待命',
    waiting: '等待中',
    offline: '离线',
    unknown: '状态未知',
  }[activity.state] || '状态未知';
  const activityHealth = activity.health === 'ok' ? '健康正常' : '健康信息不可用';

  return {
    runtime: detailEvidence({
      available: runtimeAvailable,
      value: `${runtimeLabel}${runtime.version ? ` ${runtime.version}` : ''}`,
      source: runtime.source,
      sampledAt: runtime.sampledAt,
      unavailableReason: runtime.unavailableReason || 'not_reported',
    }),
    model: detailEvidence({
      available: modelAvailable,
      value: model.value,
      source: model.source,
      sampledAt: model.sampledAt,
      unavailableReason: model.unavailableReason || 'not_reported',
    }),
    pendingRestart: detailEvidence({
      available: pendingRestartAvailable,
      value: runtime.pendingRestart ? '等待重启' : '无需重启',
      source: runtime.source,
      sampledAt: runtime.sampledAt,
      unavailableReason: runtime.pendingRestartUnavailableReason || runtime.unavailableReason || 'no_authoritative_field',
    }),
    context: detailEvidence({
      available: contextAvailable,
      value: contextParts.join(' · '),
      source: context.source,
      sampledAt: context.sampledAt,
      unavailableReason: context.unavailableReason || 'not_reported',
    }),
    quotaFiveHour: quotaDetail(quota.fiveHour, quota),
    quotaSevenDay: quotaDetail(quota.sevenDay, quota),
    sessionTokens: detailEvidence({
      available: sessionTokensAvailable,
      value: `${Number(sessionTokens.total).toLocaleString('zh-CN')} Token（单次会话累计）`,
      source: sessionTokens.source,
      sampledAt: sessionTokens.sampledAt,
      unavailableReason: sessionTokens.unavailableReason || 'not_reported',
    }),
    cumulativeCost: detailEvidence({
      available: costAvailable,
      value: `US$${Number(cost.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}（单次会话累计${cost.estimated === true ? '，估算' : ''}）`,
      source: cost.source,
      sampledAt: cost.sampledAt,
      unavailableReason: cost.unavailableReason || 'not_reported',
    }),
    comparableTokenRank: comparableTokenRank(employee),
    backupStatus: detailEvidence({
      available: backupAvailable,
      value: ({ ok: '本机备份记录正常', warning: '本机备份记录需关注', critical: '本机备份记录异常', unsupported: '本机不支持该备份检查' })[backup.status],
      source: backup.source,
      sampledAt: backup.sampledAt,
      unavailableReason: backup.unavailableReason || 'not_reported',
    }),
    backupLastSuccess: detailEvidence({
      available: lastSuccessAvailable,
      value: formatDateTime(backup.lastSuccessAt),
      source: backup.source,
      sampledAt: backup.sampledAt,
      unavailableReason: backupEvidenceReason,
    }),
    backupRemoteMatch: detailEvidence({
      available: remoteMatchAvailable,
      value: backup.remoteMatch ? '预期远端一致，且无未同步改动' : '预期远端或本地同步检查不一致',
      source: backup.source,
      sampledAt: backup.sampledAt,
      unavailableReason: backupEvidenceReason,
    }),
    backupRestoreDrill: detailEvidence({
      available: restoreDrillAvailable,
      value: `已验证 · ${formatDateTime(backup.restoreDrill?.evidenceAt)}`,
      source: backup.source,
      sampledAt: backup.sampledAt,
      unavailableReason: backupEvidenceReason,
    }),
    activity: detailEvidence({
      available: activityAvailable,
      value: `${activityState} · ${activityHealth} · 仅展示，不参与调度`,
      source: activity.source,
      sampledAt: activity.sampledAt,
      unavailableReason: activity.unavailableReason || 'activity_monitor_unavailable',
    }),
  };
}

const DETAIL_DOM_IDS = Object.freeze({
  quotaFiveHour: 'detail-5h',
  quotaSevenDay: 'detail-7d',
  comparableTokenRank: 'detail-rank',
  context: 'detail-context',
  sessionTokens: 'detail-session-tokens',
  cumulativeCost: 'detail-cost',
  runtime: 'detail-runtime-evidence',
  model: 'detail-model',
  pendingRestart: 'detail-pending-restart',
  backupStatus: 'detail-backup-status',
  backupLastSuccess: 'detail-backup-last-success',
  backupRemoteMatch: 'detail-backup-remote',
  backupRestoreDrill: 'detail-backup-restore',
  activity: 'detail-activity',
});

export function applyEmployeeDetail(documentRef, employee) {
  const presentation = buildEmployeeDetailPresentation(employee);
  for (const [key, id] of Object.entries(DETAIL_DOM_IDS)) {
    setText(documentRef, id, presentation[key].value);
    setText(documentRef, `${id}-meta`, presentation[key].meta);
  }
  return presentation;
}

export function formatTokenPeriod(period) {
  const startDate = String(period?.startDate || '');
  const endDate = String(period?.endDate || '');
  const timezone = String(period?.timezone || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !timezone) {
    return '统计时段暂不可用';
  }
  return `统计时段 ${startDate} 至 ${endDate}（${timezone}）`;
}

function setText(documentRef, id, value) {
  const element = documentRef.getElementById(id);
  if (element) element.textContent = String(value);
}

function appendTextElement(documentRef, parent, tag, className, text) {
  const element = documentRef.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function quotaMeter(documentRef, label, value, resetAt) {
  const meter = documentRef.createElement('div');
  meter.className = 'quota-meter';
  const copy = documentRef.createElement('small');
  appendTextElement(documentRef, copy, 'span', '', label);
  const resetCopy = resetAt ? ` · ${formatDateTime(resetAt)} 重置` : '';
  appendTextElement(documentRef, copy, 'span', '', value == null ? '暂不可用' : `已用 ${value}%${resetCopy}`);
  meter.append(copy);
  const track = documentRef.createElement('div');
  track.className = 'track';
  const fill = documentRef.createElement('div');
  fill.className = 'fill';
  fill.style.width = `${value == null ? 0 : Math.max(0, Math.min(100, Number(value)))}%`;
  track.append(fill);
  meter.append(track);
  return meter;
}

function renderQuotaRows(documentRef, id, rows, missing, limit = rows.length) {
  const root = documentRef.getElementById(id);
  if (!root) return;
  root.replaceChildren();
  for (const row of rows.slice(0, limit)) {
    const item = documentRef.createElement('div');
    item.className = 'quota-row';
    appendTextElement(documentRef, item, 'span', 'quota-name', row.name);
    item.append(quotaMeter(documentRef, '5 小时', row.q5, row.q5Reset));
    item.append(quotaMeter(documentRef, '7 天', row.q7, row.q7Reset));
    appendTextElement(documentRef, item, 'span', `quota-risk ${row.level}`, row.label);
    root.append(item);
  }
  if (rows.length === 0 || missing > 0) {
    const unavailable = documentRef.createElement('div');
    unavailable.className = 'quota-row';
    appendTextElement(documentRef, unavailable, 'span', 'quota-name', rows.length === 0 ? '全部 AI 员工' : `其余 ${missing} 名`);
    appendTextElement(documentRef, unavailable, 'span', 'quota-unavailable', '5 小时 / 7 天数据暂不可用 · 不估算');
    appendTextElement(documentRef, unavailable, 'span', 'quota-risk mid', '待汇总');
    root.append(unavailable);
  }
}

function renderTokenRows(documentRef, id, tokenPresentation, limit = tokenPresentation.rows.length) {
  const root = documentRef.getElementById(id);
  if (!root) return;
  root.replaceChildren();
  const rows = tokenPresentation.rows.slice(0, limit);
  if (rows.length === 0) {
    const row = documentRef.createElement('div');
    row.className = 'rank-row';
    appendTextElement(documentRef, row, 'span', 'rank-number', '—');
    appendTextElement(documentRef, row, 'span', 'rank-name', '全部 AI 员工');
    appendTextElement(documentRef, row, 'div', 'rank-track', '');
    appendTextElement(documentRef, row, 'span', 'rank-value', '原始 Token 暂不可用');
    root.append(row);
    return;
  }
  for (const tokenRow of rows) {
    const row = documentRef.createElement('div');
    row.className = 'rank-row';
    appendTextElement(documentRef, row, 'span', 'rank-number', tokenRow.rankLabel);
    appendTextElement(documentRef, row, 'span', 'rank-name', tokenRow.name);
    const track = documentRef.createElement('div');
    track.className = 'rank-track';
    appendTextElement(documentRef, track, 'span', rows.length > 1 ? 'rank-bar-full' : 'rank-bar-empty', '');
    row.append(track);
    appendTextElement(documentRef, row, 'span', 'rank-value', tokenRow.valueLabel);
    root.append(row);
  }
}

function renderLiveStatus(documentRef, snapshot, model, presentation) {
  const degraded = snapshot.errors.length > 0;
  const authExpired = snapshot.errors.some(error => error.reason === 'http_401');
  const accessForbidden = snapshot.errors.some(error => error.reason === 'http_403');
  const status = documentRef.getElementById('workbench-live-status');
  if (status) {
    status.dataset.state = degraded ? 'degraded' : 'ready';
    status.textContent = authExpired
      ? '登录已失效'
      : accessForbidden ? '无权访问'
      : degraded ? `部分数据暂不可用（${snapshot.errors.length}）` : '中央只读数据已连接';
  }
  setText(documentRef, 'workbench-updated', formatDateTime(presentation.updatedAt));
  setText(documentRef, 'employee-count', `权威名册 ${presentation.quota.covered + presentation.quota.missing} 名 · 实时状态按可用数据覆盖`);

  const message = documentRef.getElementById('workbench-live-message');
  if (message) {
    const main = message.querySelector('span');
    const detail = message.querySelector('small');
    if (main) main.textContent = authExpired
      ? '登录状态已失效，请重新登录；当前页面不会把读取失败显示成零值或正常状态。'
      : accessForbidden
        ? '当前身份无权访问中央数据，可能存在租户或权限不匹配；页面不会把读取失败显示成零值或正常状态。'
      : degraded
        ? '已读取可用的中央数据；不可用来源和缺失字段继续明确显示“暂不可用”。'
        : '中央实时只读数据已接入；缺少同口径证据的字段继续明确显示“暂不可用”。';
    if (detail) detail.textContent = '只读页面，不执行升级或恢复';
  }

  globalThis.window?.workbenchView?.updateEmployees(model.employees);
}

function renderBackup(documentRef, backup) {
  const covered = backup.covered;
  const healthy = backup.healthy;
  const synchronized = backup.synchronized;
  const latest = backup.latestSuccessAt ? formatDateTime(backup.latestSuccessAt) : '暂不可用';
  const hasEvidence = covered > 0;

  setText(documentRef, 'backup-home-title', hasEvidence ? `已覆盖 ${covered} 名 AI 员工` : '备份证据尚未接入');
  setText(documentRef, 'backup-home-summary', hasEvidence
    ? `其中 ${healthy} 名备份记录健康、${synchronized} 名通过远端一致性检查；恢复能力仍需独立演练。`
    : '当前没有可核验的备份记录；不会据此推断恢复能力。');
  setText(documentRef, 'backup-home-time', latest);
  setText(documentRef, 'backup-home-covered', hasEvidence ? `${covered} 名` : '暂不可用');
  setText(documentRef, 'backup-home-sync', hasEvidence ? `${synchronized} / ${covered}` : '暂不可用');
  setText(documentRef, 'backup-home-healthy', hasEvidence ? `${healthy} / ${covered}` : '暂不可用');
  setText(documentRef, 'backup-home-restore', backup.restoreLabel);

  setText(documentRef, 'backup-page-latest', latest);
  setText(documentRef, 'backup-page-sync', hasEvidence ? `${synchronized} / ${covered}` : '暂不可用');
  setText(documentRef, 'backup-page-restore', backup.restoreLabel);
  setText(documentRef, 'backup-page-covered', hasEvidence ? `${covered} 名` : '暂不可用');
  setText(documentRef, 'backup-page-healthy', hasEvidence ? `${healthy} 名健康` : '暂不可用');
  setText(documentRef, 'backup-page-synchronized', hasEvidence ? `${synchronized} 名一致` : '暂不可用');
  setText(documentRef, 'backup-page-restore-evidence', backup.restoreLabel === '已验证' ? '已验证' : '缺失');

  const latestStatus = documentRef.getElementById('backup-page-latest-status');
  if (latestStatus) {
    latestStatus.textContent = hasEvidence ? `${healthy} / ${covered} 健康` : '待接入';
    latestStatus.className = `status ${hasEvidence && healthy === covered ? 'ok' : 'waiting'}`;
  }
  const syncStatus = documentRef.getElementById('backup-page-sync-status');
  if (syncStatus) {
    syncStatus.textContent = hasEvidence ? `${synchronized} / ${covered} 一致` : '待接入';
    syncStatus.className = `status ${hasEvidence && synchronized === covered ? 'ok' : 'waiting'}`;
  }
}

export function applyWorkbenchModel(documentRef, snapshot, model) {
  const presentation = buildWorkbenchPresentation(model);
  renderLiveStatus(documentRef, snapshot, model, presentation);

  const { quota, tokens, backup } = presentation;
  for (const prefix of ['home-quota', 'quota']) {
    setText(documentRef, `${prefix}-risk`, quota.risk);
    setText(documentRef, `${prefix}-covered`, quota.covered);
    setText(documentRef, `${prefix}-missing`, quota.missing);
  }
  setText(documentRef, 'quota-page-count', `当前可查看 ${quota.covered} / ${quota.covered + quota.missing} · 其余待汇总`);
  setText(documentRef, 'quota-pending-status', `待汇总 ${quota.missing} 名`);
  renderQuotaRows(documentRef, 'home-quota-list', quota.rows, quota.missing, 5);
  renderQuotaRows(documentRef, 'quota-list', quota.rows, quota.missing);

  setText(documentRef, 'home-token-coverage', tokens.coverageLabel);
  setText(documentRef, 'tokens-coverage-status', tokens.coverageLabel);
  setText(documentRef, 'tokens-page-count', `${tokens.coverageLabel} · ${tokens.note}`);
  const tokenPeriodLabel = formatTokenPeriod(tokens.period);
  setText(documentRef, 'home-token-period', tokenPeriodLabel);
  setText(documentRef, 'tokens-period', tokenPeriodLabel);
  renderTokenRows(documentRef, 'home-token-list', tokens, 6);
  renderTokenRows(documentRef, 'tokens-list', tokens);
  renderBackup(documentRef, backup);
  return presentation;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const basePath = document.documentElement?.dataset?.basePath || '';
  const classicRedirect = classicRedirectForHash(window.location.hash, basePath);
  if (classicRedirect) {
    window.location.replace(classicRedirect);
  } else {
    if (window.workbenchView) {
      window.workbenchView.renderEmployeeDetail = employee => applyEmployeeDetail(document, employee);
    }
    const fetchImpl = window.fetch.bind(window);
    const presenter = createWorkbenchSnapshotPresenter({
      renderSnapshot(snapshot) {
        const model = modelFromSnapshot(snapshot);
        applyWorkbenchModel(document, snapshot, model);
      },
    });
    const controller = createWorkbenchRefreshController({
      fetchImpl,
      basePath,
      onSnapshot: presenter.present,
    });

    void controller.refresh(Object.keys(READ_ENDPOINTS));
    scheduleWorkbenchRefresh(window.setInterval.bind(window), keys => {
      if (document.visibilityState === 'visible') void controller.refresh(keys);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      presenter.revalidate();
      void controller.refresh(['agentStates']);
    });
  }
}
