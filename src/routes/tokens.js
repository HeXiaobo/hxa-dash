// Token consumption attribution routes (#93, #102)
// Estimates token usage from actual GitLab activity data
const express = require('express');
const router = express.Router();
const db = require('../db');

// Cost per 1M tokens (USD) — Claude Sonnet pricing
const COST_PER_M_INPUT  = 3.00;
const COST_PER_M_OUTPUT = 15.00;

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

// GET /api/tokens — token consumption estimates for a time window
router.get('/', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  const now = Date.now();
  const dayMs = 86400000;
  const sinceMs = now - days * dayMs;

  const agents = db.getAllAgents();
  if (agents.length === 0) {
    return res.json({
      window_days: days,
      estimated: true,
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
    const date = new Date(now - d * dayMs);
    const key = date.toISOString().slice(0, 10);
    dailyMap.set(key, { total_input: 0, total_output: 0, agents: {} });
  }

  // Process real events from the database
  const allEvents = db.getEventsInWindow(sinceMs);

  for (const event of allEvents) {
    const date = new Date(event.timestamp);
    const key = date.toISOString().slice(0, 10);
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
    estimated: true,
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
