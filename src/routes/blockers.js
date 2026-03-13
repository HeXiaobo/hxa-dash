const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/blockers
// Detect project blockers: stale issues, unreviewed MRs, idle agents.
// Query params:
//   threshold_issue_h  - hours since last update to flag a stale issue (default: 72)
//   threshold_mr_h     - hours open to flag an unreviewed MR (default: 24)
//   threshold_agent_h  - hours since last_seen_at to flag an idle agent (default: 4)
router.get('/', (req, res) => {
  const threshold_issue_h = Math.max(1, parseInt(req.query.threshold_issue_h) || 72);
  const threshold_mr_h = Math.max(1, parseInt(req.query.threshold_mr_h) || 24);
  const threshold_agent_h = Math.max(1, parseInt(req.query.threshold_agent_h) || 4);

  const now = Date.now();
  const issueThresholdMs = threshold_issue_h * 3600000;
  const mrThresholdMs = threshold_mr_h * 3600000;
  const agentThresholdMs = threshold_agent_h * 3600000;

  const stale_issues = db.getStaleIssues(now, issueThresholdMs);
  const unreviewed_mrs = db.getUnreviewedMRs(now, mrThresholdMs);
  const idle_agents = db.getIdleAgents(now, agentThresholdMs);

  // Flat blockers array for frontend consumption (compatible with Domi's #56 UI)
  const blockers = [
    ...stale_issues.map(i => ({ severity: 'critical', type: 'stale_issue', type_label: '停滞 Issue', title: i.title, url: i.url, assignee: i.assignee, project: i.project, stale_hours: i.stale_hours })),
    ...unreviewed_mrs.map(m => ({ severity: 'warning', type: 'unreviewed_mr', type_label: '无人 Review MR', title: m.title, url: m.url, assignee: m.author, project: m.project, stale_hours: m.hours_open })),
    ...idle_agents.map(a => ({ severity: 'info', type: 'silent_agent', type_label: '失联 Agent', title: a.name, url: null, assignee: a.name, project: null, stale_hours: a.last_seen_hours })),
  ];

  res.json({
    stale_issues,
    unreviewed_mrs,
    idle_agents,
    total: stale_issues.length + unreviewed_mrs.length + idle_agents.length,
    blockers,
  });
});

module.exports = router;
