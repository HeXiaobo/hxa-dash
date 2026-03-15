const { Router } = require('express');
const db = require('../db');

const router = Router();

// GET /api/projects — project-level aggregated dashboard data
router.get('/', (req, res) => {
  res.json(buildProjects());
});

// GET /api/projects/:name — single project detail
router.get('/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const all = buildProjects();
  const project = all.projects.find(p => p.name === name);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Enrich with full task list + recent events
  const tasks = db.getAllTasks().filter(t => t.project === name);
  const events = db.getTimeline(500).filter(e => e.project === name).slice(0, 50);

  res.json({ ...project, tasks, events });
});

// Build all project summaries
function buildProjects() {
  const projectNames = db.getProjects();
  const allTasks = db.getAllTasks();
  const allEvents = db.getTimeline(500);
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 86400000;
  const thirtyDaysAgo = now - 30 * 86400000;

  const projects = projectNames.map(name => {
    const tasks = allTasks.filter(t => t.project === name);
    const events = allEvents.filter(e => e.project === name);
    const recentEvents = events.filter(e => e.timestamp >= sevenDaysAgo);

    // Issue stats
    const issues = tasks.filter(t => t.type === 'issue');
    const openIssues = issues.filter(t => t.state === 'opened');
    const closedIssues = issues.filter(t => t.state === 'closed' || t.state === 'merged');

    // MR stats
    const mrs = tasks.filter(t => t.type === 'mr');
    const openMRs = mrs.filter(t => t.state === 'opened');
    const mergedMRs = mrs.filter(t => t.state === 'merged' || t.state === 'closed');

    // Velocity: issues closed in last 7 days
    const recentClosed = closedIssues.filter(t => t.updated_at >= sevenDaysAgo);
    const recentMerged = mergedMRs.filter(t => t.updated_at >= sevenDaysAgo);

    // Contributors (unique agents involved)
    const contributors = new Set();
    for (const t of tasks) {
      if (t.assignee) contributors.add(t.assignee);
      if (t.author) contributors.add(t.author);
    }

    // Blockers: stale issues (no update > 48h)
    const staleThreshold = 48 * 3600000;
    const staleIssues = openIssues.filter(t => (now - t.updated_at) > staleThreshold);

    // Activity trend (7 days, per-day)
    const activityBuckets = [];
    for (let d = 0; d < 7; d++) {
      const dayStart = now - (7 - d) * 86400000;
      const dayEnd = dayStart + 86400000;
      const dayEvents = events.filter(e => e.timestamp >= dayStart && e.timestamp < dayEnd);
      activityBuckets.push({
        day: d,
        timestamp: dayStart,
        count: dayEvents.length,
      });
    }

    // Health score (0-100)
    const health = computeProjectHealth({
      openIssues: openIssues.length,
      closedIssues: closedIssues.length,
      openMRs: openMRs.length,
      mergedMRs: mergedMRs.length,
      staleCount: staleIssues.length,
      recentEventCount: recentEvents.length,
      recentClosedCount: recentClosed.length,
    });

    // Completion percentage
    const totalIssues = issues.length || 1;
    const completion = Math.round((closedIssues.length / totalIssues) * 100);

    // AI planning suggestions
    const suggestions = generateSuggestions({
      name,
      openIssues,
      closedIssues,
      openMRs,
      staleIssues,
      recentClosed,
      recentEvents,
      contributors: [...contributors],
    });

    return {
      name,
      stats: {
        issues: { open: openIssues.length, closed: closedIssues.length, total: issues.length },
        mrs: { open: openMRs.length, merged: mergedMRs.length, total: mrs.length },
        contributors: [...contributors],
        contributor_count: contributors.size,
      },
      velocity: {
        issues_closed_7d: recentClosed.length,
        mrs_merged_7d: recentMerged.length,
        events_7d: recentEvents.length,
      },
      health,
      completion,
      stale_count: staleIssues.length,
      activity: activityBuckets,
      suggestions,
      last_activity: events[0]?.timestamp || null,
    };
  });

  // Sort by health (worst first to surface problems)
  projects.sort((a, b) => a.health.score - b.health.score);

  return { projects, total: projects.length };
}

// Compute project health score (0-100)
function computeProjectHealth({ openIssues, closedIssues, openMRs, mergedMRs, staleCount, recentEventCount, recentClosedCount }) {
  let score = 70; // baseline

  // Stale penalty: -10 per stale issue (max -30)
  score -= Math.min(staleCount * 10, 30);

  // Open MR backlog penalty: -5 per open MR beyond 2
  if (openMRs > 2) score -= Math.min((openMRs - 2) * 5, 15);

  // Velocity bonus: +5 per issue closed in 7d (max +20)
  score += Math.min(recentClosedCount * 5, 20);

  // Activity bonus: +1 per 5 events in 7d (max +10)
  score += Math.min(Math.floor(recentEventCount / 5), 10);

  // Completion bonus: if mostly done
  const total = openIssues + closedIssues;
  if (total > 0) {
    const pct = closedIssues / total;
    if (pct >= 0.9) score += 10;
    else if (pct >= 0.7) score += 5;
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    level: score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical',
  };
}

// Generate AI planning suggestions based on project state
function generateSuggestions({ name, openIssues, closedIssues, openMRs, staleIssues, recentClosed, recentEvents, contributors }) {
  const suggestions = [];

  // Stale issues
  if (staleIssues.length > 0) {
    const issueList = staleIssues.slice(0, 3).map(i => i.title).join(', ');
    suggestions.push({
      type: 'warning',
      icon: '⏰',
      text: `${staleIssues.length} 个 issue 超过 48h 无更新：${issueList}`,
      action: 'triage',
    });
  }

  // Open MR backlog
  if (openMRs.length > 2) {
    suggestions.push({
      type: 'warning',
      icon: '🔀',
      text: `${openMRs.length} 个 MR 待 review——建议优先清理 MR 队列`,
      action: 'review',
    });
  }

  // Velocity drop
  if (recentClosed.length === 0 && openIssues.length > 0) {
    suggestions.push({
      type: 'critical',
      icon: '📉',
      text: `过去 7 天没有关闭任何 issue——项目可能停滞`,
      action: 'investigate',
    });
  }

  // Unassigned issues
  const unassigned = openIssues.filter(i => !i.assignee);
  if (unassigned.length > 0) {
    suggestions.push({
      type: 'info',
      icon: '👤',
      text: `${unassigned.length} 个 open issue 未分配`,
      action: 'assign',
    });
  }

  // Single contributor risk
  if (contributors.length === 1 && openIssues.length > 3) {
    suggestions.push({
      type: 'warning',
      icon: '⚠️',
      text: `仅 ${contributors[0]} 一人参与，但有 ${openIssues.length} 个 open issues——建议增加人力`,
      action: 'staff',
    });
  }

  // Nearly done
  const total = openIssues.length + closedIssues.length;
  if (total > 0 && openIssues.length <= 2 && openIssues.length > 0) {
    suggestions.push({
      type: 'info',
      icon: '🎯',
      text: `还剩 ${openIssues.length} 个 issue 就全部完成——冲刺收尾！`,
      action: 'sprint',
    });
  }

  // All done
  if (openIssues.length === 0 && closedIssues.length > 0) {
    suggestions.push({
      type: 'success',
      icon: '✅',
      text: `所有 issue 已关闭——可以安排下一阶段规划`,
      action: 'plan_next',
    });
  }

  return suggestions;
}

module.exports = router;
module.exports.buildProjects = buildProjects;
