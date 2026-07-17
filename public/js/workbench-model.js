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

function observedTokens(tokensPayload) {
  const observed = tokensPayload?.observed;
  if (!observed?.supported || !validObservedWindow(observed.window)) return new Map();
  const result = new Map();
  for (const item of Array.isArray(observed.agents) ? observed.agents : []) {
    const id = rosterId(item?.name);
    const total = finiteNumber(item?.total);
    if (!id || total == null || total < 0 || item?.partial_baseline === true) continue;
    if (!result.has(id)) result.set(id, total);
  }
  return result;
}

function backupSummary(backupsPayload) {
  const records = Array.isArray(backupsPayload?.agents) ? backupsPayload.agents : [];
  const covered = records.filter(record => record?.summary?.supported === true);
  const healthy = covered.filter(record => record.summary?.status === 'ok');
  const synchronized = covered.filter(record => {
    const summary = record.summary || {};
    return summary.expected_match === true
      && [summary.ahead, summary.behind, summary.dirty, summary.untracked]
        .every(value => finiteNumber(value) === 0);
  });
  const latestSuccess = covered
    .map(record => isoTimestamp(record.summary?.last_success_at))
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
  const tokenById = observedTokens(tokens);
  const backupById = indexByRosterId(backups.agents);

  const employees = ROSTER.map(person => {
    const agent = teamById.get(person.id);
    const quota = limitsById.get(person.id)?.quota;
    const q5 = quotaWindow(quota, 300);
    const q7 = quotaWindow(quota, 10080);
    const tokenTotal = tokenById.get(person.id);
    const backup = backupById.get(person.id)?.summary;
    return {
      id: person.id,
      name: person.name,
      role: person.role,
      state: employeeState(agent, statesById.get(person.id), modelNow),
      task: '业务任务源待接入',
      q5: percentage(q5?.used_percent),
      q7: percentage(q7?.used_percent),
      q5Reset: isoTimestamp(q5?.resets_at),
      q7Reset: isoTimestamp(q7?.resets_at),
      tokens: tokenTotal ?? null,
      rank: null,
      version: runtimeVersion(agent),
      target: '—',
      upgradeComponent: '—',
      upgradeCurrent: '—',
      upgradeTarget: '—',
      runtime: runtimeLabel(agent?.runtime),
      upgrade: '无',
      blocker: '暂不可用',
      backupStatus: backup?.supported ? backup.status : 'unavailable',
      updatedAt: newestTimestamp([
        statesById.get(person.id)?.state?.observed_at,
        agent?.last_active_at,
        agent?.last_heartbeat_at,
        quota?.sampled_at,
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
    backup: backupSummary(backups),
    coverage: {
      quota: employees.filter(employee => employee.q5 != null || employee.q7 != null).length,
      tokens: ranked.length,
      total: employees.length,
    },
    updatedAt: newestTimestamp([
      limits?.timestamp,
      backups?.timestamp,
      agentStates?.timestamp,
      observedWindow?.end_ms,
    ]),
    tokenPeriod,
  };
}
