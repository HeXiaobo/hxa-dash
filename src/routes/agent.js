const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/agent/:name/stats
// Per-agent detailed statistics: completion rate, collaboration, activity breakdown.
// Query params:
//   days - lookback window in days (default: 30, max: 90)
router.get('/:name/stats', (req, res) => {
  const name = req.params.name;
  const agent = db.getAgent(name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const sinceMs = Date.now() - days * 86400000;

  const tasks = db.getTasksForAgent(name, { assigneeOnly: true });
  const openTasks = tasks.filter(t => t.state === 'opened');
  const closedTasks = tasks.filter(t =>
    (t.state === 'closed' || t.state === 'merged') && t.updated_at >= sinceMs
  );
  const totalRecent = tasks.filter(t => t.created_at >= sinceMs || t.updated_at >= sinceMs);

  const events = db.getEventsForAgent(name, 500);
  const recentEvents = events.filter(e => e.timestamp >= sinceMs);

  // Activity breakdown
  const activity = {
    commits: recentEvents.filter(e => e.action === 'pushed').length,
    comments: recentEvents.filter(e => e.action === 'commented').length,
    mr_opened: recentEvents.filter(e => e.action === 'opened' && e.target_type === 'mr').length,
    mr_merged: recentEvents.filter(e => e.action === 'merged').length,
    issues_closed: recentEvents.filter(e => e.action === 'closed').length,
    total: recentEvents.length,
  };

  // Completion rate
  const completionRate = totalRecent.length > 0
    ? Math.round((closedTasks.length / totalRecent.length) * 100)
    : null;

  // Collaboration
  const topCollab = db.getTopCollaborator(name);
  const collabs = db.getCollabsForAgent(name);

  // Average response time (time between events — rough proxy)
  let avgResponseHours = null;
  if (recentEvents.length >= 2) {
    const sorted = [...recentEvents].sort((a, b) => a.timestamp - b.timestamp);
    let totalGap = 0;
    let gaps = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].timestamp - sorted[i - 1].timestamp;
      if (gap < 24 * 3600000) { // Only count gaps < 24h (skip overnight)
        totalGap += gap;
        gaps++;
      }
    }
    if (gaps > 0) avgResponseHours = Math.round((totalGap / gaps / 3600000) * 10) / 10;
  }

  res.json({
    name: agent.name,
    online: agent.online,
    last_seen_at: agent.last_seen_at,
    days,
    tasks: {
      open: openTasks.length,
      closed_in_period: closedTasks.length,
      total_in_period: totalRecent.length,
      completion_rate: completionRate,
    },
    activity,
    collaboration: {
      top_partner: topCollab,
      total_edges: collabs.length,
    },
    avg_activity_gap_hours: avgResponseHours,
  });
});

// GET /api/agent/:name/timeline
// Per-agent event timeline.
// Query params:
//   limit - max events to return (default: 50, max: 200)
router.get('/:name/timeline', (req, res) => {
  const name = req.params.name;
  const agent = db.getAgent(name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const events = db.getEventsForAgent(name, limit);

  res.json({
    name,
    count: events.length,
    events: events.map(e => ({
      timestamp: e.timestamp,
      action: e.action,
      target_type: e.target_type || null,
      target_title: e.target_title || null,
      target_url: e.target_url || null,
      project: e.project || null,
    })),
  });
});

module.exports = router;
