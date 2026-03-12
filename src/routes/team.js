const { Router } = require('express');
const db = require('../db');
const collab = require('../analyzers/collab');

const router = Router();

// GET /api/team — all agents + stats
router.get('/', (req, res) => {
  const agents = db.getAllAgents().map(a => {
    const allTasks = db.getTasksForAgent(a.name);
    const openTasks = allTasks.filter(t => t.state === 'opened');
    const closedTasks = allTasks.filter(t => t.state === 'closed' || t.state === 'merged');
    const recentEvents = db.getEventsForAgent(a.name, 5);
    const latestEvent = recentEvents[0] || null;

    // Work status: busy (has open tasks) / idle (online, no open tasks) / offline
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

    return {
      ...a,
      tags: safeJSON(a.tags),
      online: !!a.online,
      work_status: workStatus,
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

// GET /api/team/:name — single agent detail
router.get('/:name', (req, res) => {
  const agent = db.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const tasks = db.getTasksForAgent(agent.name);
  const events = db.getEventsForAgent(agent.name, 30);
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

function safeJSON(str) {
  try { return JSON.parse(str); } catch { return []; }
}

module.exports = router;
