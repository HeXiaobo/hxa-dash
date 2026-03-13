// Metrics route: team utilization + output metrics panel (#62)
const express = require('express');
const router = express.Router();
const db = require('../db');

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
  const ms7d  = 7  * 24 * 3600 * 1000;
  const ms30d = 30 * 24 * 3600 * 1000;
  const ms28d = 28 * 24 * 3600 * 1000; // 4 weeks

  const since7d  = now - ms7d;
  const since30d = now - ms30d;
  const since28d = now - ms28d;

  const agents = db.getAllAgents();
  const tasks  = db.getAllTasks();

  // ── Utilization ──────────────────────────────────────────────
  const onlineAgents = agents.filter(a => a.online);
  const idleOnline   = onlineAgents.filter(a => {
    const open = tasks.filter(t => t.state === 'opened' && t.assignee === a.name).length;
    return open === 0;
  });
  const idlePct = onlineAgents.length > 0
    ? Math.round((idleOnline.length / onlineAgents.length) * 100)
    : 0;

  // ── Output – team totals ──────────────────────────────────────
  const closed7d = tasks.filter(t =>
    (t.state === 'closed') && t.updated_at >= since7d && t.type === 'issue'
  );
  const merged7d = tasks.filter(t =>
    (t.state === 'merged') && t.updated_at >= since7d && t.type === 'mr'
  );

  // Cycle time: issues closed in last 30d that have both created_at and updated_at
  const issuesClosed30d = tasks.filter(t =>
    t.state === 'closed' && t.type === 'issue' &&
    t.updated_at >= since30d && t.created_at && t.updated_at > t.created_at
  );
  let cycleTimeMedianHours = null;
  if (issuesClosed30d.length > 0) {
    const times = issuesClosed30d
      .map(t => (t.updated_at - t.created_at) / 3600000)
      .sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    cycleTimeMedianHours = times.length % 2 === 0
      ? Math.round((times[mid - 1] + times[mid]) / 2 * 10) / 10
      : Math.round(times[mid] * 10) / 10;
  }

  // ── Throughput trend: last 4 weeks ───────────────────────────
  const weekMap = new Map();

  for (let w = 0; w < 4; w++) {
    const weekTs = now - w * 7 * 24 * 3600 * 1000;
    const weekKey = isoWeek(weekTs);
    if (!weekMap.has(weekKey)) {
      weekMap.set(weekKey, { week: weekKey, issues_closed: 0, mrs_merged: 0 });
    }
  }

  const weeklyTasks = tasks.filter(t =>
    (t.state === 'closed' || t.state === 'merged') && t.updated_at >= since28d
  );
  for (const t of weeklyTasks) {
    const key = isoWeek(t.updated_at);
    if (!weekMap.has(key)) weekMap.set(key, { week: key, issues_closed: 0, mrs_merged: 0 });
    const b = weekMap.get(key);
    if (t.state === 'closed'  && t.type === 'issue') b.issues_closed++;
    if (t.state === 'merged'  && t.type === 'mr')    b.mrs_merged++;
  }

  const weeklyClosed = [...weekMap.values()].sort((a, b) => a.week.localeCompare(b.week));

  // ── Per-agent breakdown ───────────────────────────────────────
  const agentRows = agents.map(a => {
    const openTasks   = tasks.filter(t => t.state === 'opened' && t.assignee === a.name).length;
    const closed7dAgt = tasks.filter(t =>
      t.state === 'closed' && t.type === 'issue' &&
      t.updated_at >= since7d &&
      (t.assignee === a.name || t.author === a.name)
    ).length;
    const mrs7dAgt = tasks.filter(t =>
      t.state === 'merged' && t.type === 'mr' &&
      t.updated_at >= since7d &&
      (t.assignee === a.name || t.author === a.name)
    ).length;

    const status = !a.online ? 'offline' : openTasks > 0 ? 'busy' : 'idle';

    return {
      name: a.name,
      status,
      open_tasks: openTasks,
      closed_7d: closed7dAgt,
      mrs_7d: mrs7dAgt,
    };
  });

  return {
    team: {
      idle_pct: idlePct,
      issues_closed_7d: closed7d.length,
      mrs_merged_7d: merged7d.length,
      cycle_time_median_hours: cycleTimeMedianHours,
      weekly_closed: weeklyClosed,
    },
    agents: agentRows,
  };
}

// GET /api/metrics
router.get('/', (req, res) => {
  res.json(computeMetrics());
});

module.exports = router;
module.exports.computeMetrics = computeMetrics;
