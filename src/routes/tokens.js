// Token consumption attribution routes (#93, #102)
// Estimates token usage from actual GitLab activity data
const express = require('express');
const router = express.Router();
const db = require('../db');
const { buildAgents, __private: { selectUsageForRuntime } } = require('./team');

// Cost per 1M tokens (USD) — Claude Sonnet pricing
const COST_PER_M_INPUT  = 3.00;
const COST_PER_M_OUTPUT = 15.00;
const DAY_MS = 86400000;
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const TOKEN_FIELDS = ['input', 'output', 'cache_creation', 'cache_read', 'cached_input', 'reasoning', 'total'];

// Per-action token estimates (based on typical Claude API usage patterns)
// These are rough estimates — actual usage depends on prompt/response complexity
const TOKEN_PER_ACTION = {
  pushed:        8000,   // Code review / commit generation: ~6K input + ~2K output
  commented:     3000,   // Reading context + writing comment: ~2K input + ~1K output
  mr_opened:     12000,  // MR creation: reading diff, writing description
  mr_merged:     2000,   // Merge action: minimal tokens
  issue_opened:  5000,   // Issue triage / creation
  issue_closed:  1500,   // Close action
  reviewed:      6000,   // Code review: reading diff + writing feedback
  approved:      1000,   // Approval: minimal
  default:       3000,   // Fallback for unknown actions
};

// Input/output ratio by action type
const OUTPUT_RATIO = {
  pushed:        0.25,   // 25% output (code generation)
  commented:     0.35,   // 35% output (writing comments)
  mr_opened:     0.30,
  issue_opened:  0.30,
  reviewed:      0.30,
  default:       0.20,
};

function usageTotal(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0;
  if (typeof tokens.total === 'number') return tokens.total;
  return (tokens.input || 0) + (tokens.output || 0) + (tokens.cache_creation || 0) + (tokens.cache_read || 0);
}

function tokenNumber(tokens, key) {
  const value = tokens?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function addUsageTokens(total, next) {
  for (const key of TOKEN_FIELDS) {
    const value = tokenNumber(next, key);
    if (value != null) total[key] = (total[key] || 0) + value;
  }
}

function addCost(total, next) {
  return next == null ? total : (total || 0) + next;
}

function estimateUsageCost(tokens) {
  if (!tokens) return null;
  const inputSide = (tokens.input || 0) + (tokens.cache_creation || 0) + (tokens.cache_read || 0) + (tokens.cached_input || 0);
  const outputSide = (tokens.output || 0) + (tokens.reasoning || 0);
  const cost = (inputSide / 1e6 * COST_PER_M_INPUT) + (outputSide / 1e6 * COST_PER_M_OUTPUT);
  return Math.round(cost * 100) / 100;
}

function dateKey(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function startOfDateKey(key) {
  return Date.parse(`${key}T00:00:00+08:00`);
}

function addDays(key, days) {
  return dateKey(startOfDateKey(key) + days * DAY_MS);
}

function parseDateKey(value) {
  const normalized = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function buildTimeWindow(query, now = Date.now()) {
  const today = dateKey(now);
  const requestedStart = parseDateKey(query.start);
  const requestedEnd = parseDateKey(query.end);

  if (requestedStart && requestedEnd) {
    const startDate = requestedStart <= requestedEnd ? requestedStart : requestedEnd;
    const endDate = requestedStart <= requestedEnd ? requestedEnd : requestedStart;
    const startMs = startOfDateKey(startDate);
    const endExclusiveMs = startOfDateKey(addDays(endDate, 1));
    return {
      mode: 'custom',
      days: Math.max(1, Math.round((endExclusiveMs - startMs) / DAY_MS)),
      start_date: startDate,
      end_date: endDate,
      start_ms: startMs,
      end_ms: endExclusiveMs,
      timezone: 'Asia/Shanghai',
    };
  }

  const parsedDays = parseInt(query.days, 10);
  const days = Number.isFinite(parsedDays) && parsedDays > 0
    ? Math.min(parsedDays, 30)
    : 1;
  const startDate = addDays(today, -(days - 1));
  const endDate = today;
  return {
    mode: days === 1 ? 'today' : 'rolling_days',
    days,
    start_date: startDate,
    end_date: endDate,
    start_ms: startOfDateKey(startDate),
    end_ms: startOfDateKey(addDays(endDate, 1)),
    timezone: 'Asia/Shanghai',
  };
}

function usageSampledAt(agent) {
  const sampledAt = agent.usage?.sampled_at;
  if (typeof sampledAt === 'number' && Number.isFinite(sampledAt)) return sampledAt;
  const heartbeatAt = agent.runtime?.last_heartbeat_at;
  return typeof heartbeatAt === 'number' && Number.isFinite(heartbeatAt) ? heartbeatAt : null;
}

function usageGroupKey(runtimeType, usage) {
  return [
    runtimeType || 'unknown',
    usage.source || 'unknown',
    usage.session_id || 'no-session',
    usage.thread_id || 'no-thread',
    usage.model || 'no-model',
    usage.plan_type || 'no-plan',
  ].join('|');
}

function healthUsageSample(name, health) {
  const runtimeType = health.runtime?.type || 'claude_code';
  const usage = selectUsageForRuntime(health, runtimeType);
  if (!usage?.supported || (!usage.session_tokens && !usage.last_turn_tokens)) return null;
  const reportedAt = typeof health.reported_at === 'number' ? health.reported_at : usageSampledAt({ usage, runtime: health.runtime });
  if (reportedAt == null) return null;
  return {
    key: `${name}|${usageGroupKey(runtimeType, usage)}`,
    name,
    reported_at: reportedAt,
    runtime: { type: runtimeType, version: health.runtime?.version, status: health.runtime?.status },
    usage,
    tokens: usage.session_tokens,
    cost_usd: typeof usage.session_cost_usd === 'number' ? usage.session_cost_usd : null,
  };
}

function formatAgentUsage(agent) {
  const tokens = agent.usage.session_tokens || {};
  return {
    name: agent.name,
    runtime: agent.runtime,
    source: agent.usage.source,
    sampled_at: agent.usage.sampled_at,
    model: agent.usage.model,
    plan_type: agent.usage.plan_type,
    input: tokens.input || 0,
    output: tokens.output || 0,
    cache_creation: tokens.cache_creation || 0,
    cache_read: tokens.cache_read || 0,
    cached_input: tokens.cached_input || 0,
    reasoning: tokens.reasoning || 0,
    total: usageTotal(tokens),
    cost_usd: typeof agent.usage.session_cost_usd === 'number' ? agent.usage.session_cost_usd : null,
    estimated_cost: !!agent.usage.estimated_cost,
  };
}

function formatDeltaAgent(acc) {
  const tokens = acc.tokens || {};
  const usage = acc.latest.usage;
  return {
    name: acc.name,
    runtime: acc.latest.runtime,
    source: usage.source,
    sampled_at: usage.sampled_at,
    reported_at: acc.latest.reported_at,
    model: usage.model,
    plan_type: usage.plan_type,
    input: tokens.input || 0,
    output: tokens.output || 0,
    cache_creation: tokens.cache_creation || 0,
    cache_read: tokens.cache_read || 0,
    cached_input: tokens.cached_input || 0,
    reasoning: tokens.reasoning || 0,
    total: usageTotal(tokens),
    cost_usd: acc.cost_usd,
    estimated_cost: acc.estimated_cost,
    partial_baseline: acc.partial_baseline,
    turn_count: acc.turn_count || 0,
  };
}

function summarizeAgents(agents) {
  const summary = agents.reduce((acc, agent) => {
    acc.total_input += agent.input;
    acc.total_output += agent.output;
    acc.cache_tokens += agent.cache_creation + agent.cache_read + agent.cached_input;
    acc.reasoning_tokens += agent.reasoning;
    acc.total_tokens += agent.total;
    if (agent.cost_usd != null) acc.total_cost_usd += agent.cost_usd;
    if (agent.cost_usd != null) acc.cost_agent_count += 1;
    return acc;
  }, {
    total_input: 0,
    total_output: 0,
    cache_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    cost_agent_count: 0,
  });
  return { ...summary, total_cost_usd: Math.round(summary.total_cost_usd * 100) / 100 };
}

function buildObservedUsage(window) {
  const historyRows = typeof db.iterHealthHistoryBetween === 'function'
    ? db.iterHealthHistoryBetween(window.start_ms, window.end_ms)
    : typeof db.getHealthHistoryBetween === 'function'
      ? db.getHealthHistoryBetween(window.start_ms, window.end_ms)
    : [];

  const historyUsage = buildObservedUsageFromHistory(historyRows, window);
  let agents = historyUsage.agents;
  let fromHistory = historyUsage.sample_count > 0 && agents.length > 0;
  if (!fromHistory) {
    agents = buildAgents()
      .filter(agent => agent.usage?.supported)
      .filter(agent => {
        const sampledAt = usageSampledAt(agent);
        return sampledAt != null && sampledAt >= window.start_ms && sampledAt < window.end_ms;
      })
      .map(formatAgentUsage)
      .sort((a, b) => b.total - a.total);
  }

  return {
    supported: agents.length > 0,
    agent_count: agents.length,
    window,
    summary: summarizeAgents(agents),
    agents,
    methodology: fromHistory
      ? '来自历史健康快照，按时间窗口汇总去重后的最后一轮用量'
      : '来自各 agent 本机 runtime usage 快照，subscription 模式下为本地观测值，非账单口径',
  };
}

function buildObservedUsageFromHistory(historyRows, window) {
  let sampleCount = 0;
  const seenTurns = new Set();
  const agentsByName = new Map();

  for (const row of historyRows) {
    if (row.reported_at == null || row.reported_at >= window.end_ms) continue;
    const sample = healthUsageSample(row.name, row);
    if (!sample) continue;
    sampleCount += 1;

    const tokens = sample.usage.last_turn_tokens;
    if (!tokens) continue;
    const turnAt = typeof sample.usage.sampled_at === 'number' && Number.isFinite(sample.usage.sampled_at)
      ? sample.usage.sampled_at
      : sample.reported_at;
    if (turnAt < window.start_ms || turnAt >= window.end_ms) continue;

    const tokenSignature = TOKEN_FIELDS.map(key => tokenNumber(tokens, key) ?? '').join(',');
    const turnKey = `${sample.key}|${turnAt}|${tokenSignature}`;
    if (seenTurns.has(turnKey)) continue;
    seenTurns.add(turnKey);

    const existing = agentsByName.get(sample.name) || {
      name: sample.name,
      latest: sample,
      tokens: {},
      cost_usd: null,
      estimated_cost: true,
      partial_baseline: false,
      turn_count: 0,
    };
    if (sample.reported_at >= existing.latest.reported_at) existing.latest = sample;
    addUsageTokens(existing.tokens, tokens);
    existing.cost_usd = addCost(existing.cost_usd, estimateUsageCost(tokens));
    existing.turn_count += 1;
    agentsByName.set(sample.name, existing);
  }

  const agents = [...agentsByName.values()]
    .map(formatDeltaAgent)
    .filter(agent => agent.total > 0 || agent.cost_usd != null)
    .sort((a, b) => b.total - a.total);

  return { agents, sample_count: sampleCount };
}

// GET /api/tokens — token consumption estimates for a time window
router.get('/', (req, res) => {
  const window = buildTimeWindow(req.query);
  const days = window.days;
  const now = Date.now();
  const sinceMs = window.start_ms;

  const agents = db.getAllAgents();
  const observed = buildObservedUsage(window);
  if (agents.length === 0) {
    return res.json({
      window_days: days,
      window,
      estimated: true,
      observed,
      summary: { total_input: 0, total_output: 0, total_tokens: 0, total_cost_usd: 0, avg_daily_tokens: 0, avg_daily_cost_usd: 0 },
      daily: [],
      agents: [],
      pricing: { input_per_m: COST_PER_M_INPUT, output_per_m: COST_PER_M_OUTPUT },
    });
  }

  // Build per-day, per-agent token estimates from real event data
  const dailyMap = new Map(); // "YYYY-MM-DD" -> { total_input, total_output, agents: {} }
  const agentTotals = new Map(); // agent name -> { input, output }

  // Initialize all days in window
  for (let d = days - 1; d >= 0; d--) {
    const key = addDays(window.end_date, -d);
    dailyMap.set(key, { total_input: 0, total_output: 0, agents: {} });
  }

  // Process real events from the database
  const allEvents = db.getEventsInWindow(sinceMs);

  for (const event of allEvents) {
    if (event.timestamp >= window.end_ms) continue;
    const key = dateKey(event.timestamp);
    const agent = event.agent;
    if (!agent || !dailyMap.has(key)) continue;

    const action = event.action || 'default';
    const totalTokens = TOKEN_PER_ACTION[action] || TOKEN_PER_ACTION.default;
    const outputRatio = OUTPUT_RATIO[action] || OUTPUT_RATIO.default;
    const outputTokens = Math.round(totalTokens * outputRatio);
    const inputTokens = totalTokens - outputTokens;

    // Add to daily totals
    const day = dailyMap.get(key);
    day.total_input += inputTokens;
    day.total_output += outputTokens;

    if (!day.agents[agent]) day.agents[agent] = { input: 0, output: 0 };
    day.agents[agent].input += inputTokens;
    day.agents[agent].output += outputTokens;

    // Add to agent totals
    const prev = agentTotals.get(agent) || { input: 0, output: 0 };
    agentTotals.set(agent, {
      input: prev.input + inputTokens,
      output: prev.output + outputTokens,
    });
  }

  // Build daily series
  const dailySeries = [];
  let totalInput = 0;
  let totalOutput = 0;

  for (const [key, day] of dailyMap) {
    dailySeries.push({ date: key, input: day.total_input, output: day.total_output });
    totalInput += day.total_input;
    totalOutput += day.total_output;
  }

  // Per-agent breakdown sorted by total tokens desc
  const agentBreakdown = [...agentTotals.entries()]
    .map(([name, usage]) => ({
      name,
      input: usage.input,
      output: usage.output,
      total: usage.input + usage.output,
      cost_usd: (usage.input / 1e6 * COST_PER_M_INPUT) + (usage.output / 1e6 * COST_PER_M_OUTPUT),
    }))
    .sort((a, b) => b.total - a.total);

  const totalTokens = totalInput + totalOutput;
  const totalCost = (totalInput / 1e6 * COST_PER_M_INPUT) + (totalOutput / 1e6 * COST_PER_M_OUTPUT);

  res.json({
    window_days: days,
    window,
    estimated: true,
    observed,
    methodology: '基于 GitLab 活动事件估算，每类操作按典型 Claude API 用量换算 token 数',
    event_count: allEvents.length,
    summary: {
      total_input: totalInput,
      total_output: totalOutput,
      total_tokens: totalTokens,
      total_cost_usd: Math.round(totalCost * 100) / 100,
      avg_daily_tokens: Math.round(totalTokens / days),
      avg_daily_cost_usd: Math.round((totalCost / days) * 100) / 100,
    },
    daily: dailySeries,
    agents: agentBreakdown,
    pricing: {
      input_per_m: COST_PER_M_INPUT,
      output_per_m: COST_PER_M_OUTPUT,
    },
  });
});

module.exports = router;
module.exports.__private = { buildTimeWindow, buildObservedUsageFromHistory };
