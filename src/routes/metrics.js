// Metrics route: team utilization + output metrics panel (#62)
const express = require('express');
const router = express.Router();
const db = require('../db');
const { buildAgents } = require('./team');

// ISO week string helper: returns "YYYY-Www"
function isoWeek(ts) {
  const d = new Date(ts);
  // Thursday-based ISO week
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Compute metrics data (reusable by REST + WS broadcast)
function computeMetrics() {
  const now = Date.now();
  const ms24h = 24 * 3600 * 1000;
  const ms7d  = 7  * 24 * 3600 * 1000;
  const ms28d = 28 * 24 * 3600 * 1000;

  const since24h = now - ms24h;
  const since7d  = now - ms7d;
  const since28d = now - ms28d;

  const agents = buildAgents();
  const allEvents = db.getEventsInWindow(since7d);

  // ── Per-agent breakdown (runtime + activity based) ─────────────────────
  const agentRows = agents.map(a => {
    const agentEvents = allEvents.filter(e => e.agent === a.name);
    const todayEvents = agentEvents.filter(e => e.timestamp >= since24h);
    const latestEvt = a.last_active_at || (agentEvents.length > 0 ? Math.max(...agentEvents.map(e => e.timestamp || 0)) : 0);

    const todayMessages = todayEvents.filter(e =>
      e.action === 'sent_message' || e.action === 'received_message' || e.action === 'hxa_message'
    ).length;
    const todayTasks = todayEvents.filter(e =>
      e.action === 'task_success' || e.action === 'task_failed' || e.action === 'task_timeout'
    ).length;

    return {
      name: a.name,
      status: a.work_state || 'offline',
      runtime_status: a.runtime_status || 'offline',
      runtime_type: a.runtime?.type || 'unknown',
      runtime_version: a.runtime?.version || null,
      today_messages: todayMessages,
      today_tasks: todayTasks,
      last_active: latestEvt || null,
      events_7d: agentEvents.length,
      active_days_7d: a.stats?.active_days_7d || 0,
      open_tasks: a.stats?.open_tasks || 0,
    };
  });

  // ── Team summary ─────────────────────────────────────────────
  const onlineAgents = agentRows.filter(a => a.runtime_status !== 'offline');
  const workingAgents = agentRows.filter(a => a.status === 'working');
  const standbyAgents = agentRows.filter(a => a.status === 'standby');
  const totalMessages24h = agentRows.reduce((s, a) => s + a.today_messages, 0);
  const totalTasks24h = agentRows.reduce((s, a) => s + a.today_tasks, 0);
  const totalEvents7d = allEvents.length;
  const activeDays7d = agentRows.reduce((s, a) => s + (a.active_days_7d || 0), 0);
  const runtimeDistribution = agentRows.reduce((acc, row) => {
    const type = row.runtime_type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  // ── Weekly trend (events-based) ──────────────────────────────
  const weekMap = new Map();
  for (let w = 0; w < 4; w++) {
    const weekTs = now - w * 7 * 24 * 3600 * 1000;
    const weekKey = isoWeek(weekTs);
    if (!weekMap.has(weekKey)) {
      weekMap.set(weekKey, { week: weekKey, messages: 0, tasks: 0 });
    }
  }
  const weeklyEvents = db.getEventsInWindow(since28d);
  for (const e of weeklyEvents) {
    const key = isoWeek(e.timestamp);
    if (!weekMap.has(key)) weekMap.set(key, { week: key, messages: 0, tasks: 0 });
    const b = weekMap.get(key);
    if (e.action === 'sent_message' || e.action === 'received_message' || e.action === 'hxa_message') b.messages++;
    if (e.action && e.action.startsWith('task_')) b.tasks++;
  }
  const weeklyClosed = [...weekMap.values()].sort((a, b) => a.week.localeCompare(b.week));

  return {
    team: {
      online_count: onlineAgents.length,
      working_count: workingAgents.length,
      standby_count: standbyAgents.length,
      total_messages_24h: totalMessages24h,
      total_tasks_24h: totalTasks24h,
      total_events_7d: totalEvents7d,
      total_active_days_7d: activeDays7d,
      runtime_distribution: runtimeDistribution,
      weekly_closed: weeklyClosed,
    },
    agents: agentRows,
  };
}

// GET /api/metrics
router.get('/', (req, res) => {
  res.json(computeMetrics());
});

// GET /api/metrics/velocity — session-based team velocity
router.get('/velocity', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  const velocity = db.getSessionVelocity(days);
  const summary = db.getSessionSummary();

  // Team-wide velocity
  const totalSessions = velocity.reduce((s, v) => s + v.total_sessions, 0);
  const activeAgents = velocity.length;

  // Total events across all agents (#118)
  const totalEvents = velocity.reduce((s, v) => s + (v.events || 0), 0);

  res.json({
    window_days: days,
    team: {
      total_sessions: totalSessions,
      sessions_per_day: activeAgents > 0 ? Math.round((totalSessions / days) * 100) / 100 : 0,
      active_agents: activeAgents,
      total_events: totalEvents,
    },
    agents: velocity,
    summary,
    estimate_map: {
      sessions: db.ESTIMATE_SESSIONS,
      minutes: db.ESTIMATE_MINUTES,
    },
  });
});

// GET /api/metrics/estimates — per-agent completion time analysis (#79)
router.get('/estimates', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  res.json(db.getCompletionStats(days));
});

module.exports = router;
module.exports.computeMetrics = computeMetrics;
