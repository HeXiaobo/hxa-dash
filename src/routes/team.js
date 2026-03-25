const { Router } = require('express');
const db = require('../db');
const collab = require('../analyzers/collab');

const router = Router();

// Default max concurrent tasks per agent (can be overridden per-agent in entities.json later)
const DEFAULT_MAX_CAPACITY = 5;

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

    // Work status: busy (has assigned open tasks) / idle / offline
    const workStatus = !a.online ? 'offline' : openTasks.length > 0 ? 'busy' : 'idle';

    // Historical stats (#39)
    const now = Date.now();
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
    const lastActiveAt = latestEvent ? latestEvent.timestamp : (a.last_seen_at || null);

    return {
      ...a,
      tags: safeJSON(a.tags),
      online: !!a.online,
      work_status: workStatus,
      active_projects: activeProjects,
      top_collaborator: topCollaborator,
      capacity,
      health_score: healthScore,
      last_active_at: lastActiveAt,
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
      sparkline_7d: db.getAgentSparkline7d(a.name),
      hardware: buildHardwareSummary(a.name),
      stats: {
        open_tasks: openTasks.length,
        closed_tasks: closedTasks.length,
        mr_count: allTasks.filter(t => t.type === 'mr').length,
        issue_count: allTasks.filter(t => t.type === 'issue').length,
        recent_events: recentEvents.length,
        closed_last_7d: closedLast7,
        closed_last_30d: closedLast30,
        avg_completion_ms: avgCompletionMs
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
    stats: {
      total: agents.length,
      online,
      offline: agents.length - online
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
  const agent = db.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const tasks = db.getTasksForAgent(agent.name);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const events = db.getEventsForAgent(agent.name, 200).filter(e => (e.timestamp || 0) > sevenDaysAgo);
  const collabs = db.getCollabsForAgent(agent.name);

  res.json({
    agent: { ...agent, tags: safeJSON(agent.tags), online: !!agent.online },
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
function buildHardwareSummary(agentName) {
  const health = db.getAgentHealth(agentName);
  if (!health) return null;

  const stale = (Date.now() - health.reported_at) > 10 * 60 * 1000;
  return {
    disk_pct: health.disk ? health.disk.pct : null,
    disk_status: health.disk ? health.disk.status : null,
    mem_pct: health.memory ? health.memory.pct : null,
    mem_status: health.memory ? health.memory.status : null,
    cpu_pct: health.cpu ? health.cpu.pct : null,
    pm2_online: health.pm2 ? health.pm2.online : null,
    pm2_total: health.pm2 ? health.pm2.total : null,
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
  try { return JSON.parse(str); } catch { return []; }
}

module.exports = router;
module.exports.buildAgents = buildAgents;
