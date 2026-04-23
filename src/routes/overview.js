// GET /api/overview — agent-friendly overview endpoint (#113)
// Returns aggregated dashboard data in JSON or plain text.
// Use ?format=text for a markdown summary readable by AI agents.
const { Router } = require('express');
const db = require('../db');
const collab = require('../analyzers/collab');
const { buildAgents } = require('./team');

const router = Router();

function buildOverview() {
  const now = Date.now();
  const rawAgents = db.getAllAgents();
  const agents = buildAgents();
  const tasks = db.getAllTasks();

  // Team summary
  const online = agents.filter(a => a.runtime_status !== 'offline');
  const openTasks = tasks.filter(t => t.state === 'opened');
  const assignedOpen = openTasks.filter(t => t.assignee);
  const unassigned = openTasks.filter(t => !t.assignee);
  const workingAgents = agents.filter(a => a.work_state === 'working');
  const standbyAgents = agents.filter(a => a.work_state === 'standby');

  // Board counts
  const board = db.getTasksByState();
  const boardCounts = {
    todo: board.todo.length,
    doing: board.doing.length,
    done: board.done.length,
  };

  // Blockers
  const staleIssues = db.getStaleIssues(now, 72 * 3600000);
  const unreviewedMRs = db.getUnreviewedMRs(now, 24 * 3600000);
  const staleMRs = db.getStaleMRs(now, 0.5 * 3600000);
  const idleAgentsList = db.getIdleAgents(now, 4 * 3600000);

  const blockers = [
    ...staleMRs.map(m => ({
      type: 'stale_mr', severity: 'critical',
      title: m.title, url: m.url, author: m.author, reviewer: m.reviewer,
      project: m.project, stale_minutes: m.stale_minutes,
    })),
    ...staleIssues.filter(i => !i.title?.startsWith('[ClawMark]')).map(i => ({
      type: 'stale_issue', severity: 'critical',
      title: i.title, url: i.url, assignee: i.assignee,
      project: i.project, stale_hours: i.stale_hours,
    })),
    ...unreviewedMRs.map(m => ({
      type: 'unreviewed_mr', severity: 'warning',
      title: m.title, url: m.url, author: m.author,
      project: m.project, hours_open: m.hours_open,
    })),
    ...idleAgentsList.map(a => ({
      type: 'idle_agent', severity: 'info',
      title: a.name, hours_since: a.last_seen_hours,
    })),
  ];

  // Recent timeline
  const timeline = db.getTimeline(10);

  const agentSummaries = agents.map(a => ({
    name: a.name,
    online: a.online,
    status: a.work_state,
    runtime_status: a.runtime_status,
    runtime: a.runtime,
    open_tasks: a.stats?.open_tasks || 0,
    last_active_at: a.last_active_at,
    last_heartbeat_at: a.last_heartbeat_at,
    events_7d: a.events_7d,
    closed_7d: a.closed_7d,
    current_work: (a.current_tasks || []).map(t => ({
      title: t.title,
      url: t.url,
      project: t.project,
      type: t.type,
    })),
  }));

  // Collab summary
  const graph = collab.getGraph();

  return {
    timestamp: new Date().toISOString(),
    team: {
      total: rawAgents.length,
      online: online.length,
      working: workingAgents.length,
      standby: standbyAgents.length,
      offline: agents.filter(a => a.runtime_status === 'offline').length,
    },
    board: boardCounts,
    blockers,
    agents: agentSummaries,
    unassigned_tasks: unassigned.map(t => ({
      title: t.title, url: t.url, project: t.project, type: t.type,
    })),
    recent_activity: timeline.map(e => ({
      agent: e.agent, action: e.action, target: e.target,
      project: e.project, timestamp: e.timestamp,
    })),
    collab: { nodes: graph.nodes.length, edges: graph.edges.length },
  };
}

function toText(data) {
  const lines = [];
  lines.push(`# HxA Dash Overview`);
  lines.push(`Generated: ${data.timestamp}`);
  lines.push('');

  // Team
  const t = data.team;
  lines.push(`## Team (${t.total} agents)`);
  lines.push(`Online: ${t.online} | Working: ${t.working} | Standby: ${t.standby} | Offline: ${t.offline}`);
  lines.push('');

  // Board
  const b = data.board;
  lines.push(`## Task Board`);
  lines.push(`Todo: ${b.todo} | In Progress: ${b.doing} | Done: ${b.done}`);
  lines.push('');

  // Blockers
  if (data.blockers.length > 0) {
    lines.push(`## Blockers (${data.blockers.length})`);
    for (const bl of data.blockers) {
      const sev = bl.severity === 'critical' ? '🔴' : bl.severity === 'warning' ? '🟡' : '🔵';
      if (bl.type === 'stale_mr') {
        lines.push(`${sev} Stale MR: ${bl.title} (${bl.project}) — ${bl.stale_minutes}min, author: ${bl.author}, reviewer: ${bl.reviewer || 'none'}`);
      } else if (bl.type === 'stale_issue') {
        lines.push(`${sev} Stale Issue: ${bl.title} (${bl.project}) — ${bl.stale_hours}h, assignee: ${bl.assignee || 'unassigned'}`);
      } else if (bl.type === 'unreviewed_mr') {
        lines.push(`${sev} Unreviewed MR: ${bl.title} (${bl.project}) — ${bl.hours_open}h open, author: ${bl.author}`);
      } else if (bl.type === 'idle_agent') {
        lines.push(`${sev} Idle Agent: ${bl.title} — ${bl.hours_since}h since last seen`);
      }
    }
    lines.push('');
  } else {
    lines.push(`## Blockers: None`);
    lines.push('');
  }

  // Agents
  lines.push(`## Agents`);
  for (const a of data.agents) {
    const icon = a.status === 'working' ? '🟢' : a.status === 'standby' ? '🟡' : '⚫';
    const work = a.current_work.length > 0
      ? a.current_work.map(w => `${w.title} (${w.project})`).join(', ')
      : 'no tasks';
    const lastActive = a.last_active_at ? new Date(a.last_active_at).toISOString().slice(0, 16) : 'never';
    const metrics = `events_7d: ${a.events_7d ?? 0}, closed_7d: ${a.closed_7d ?? 0}`;
    lines.push(`${icon} ${a.name} [${a.status} / ${a.runtime_status}]: ${work} | last: ${lastActive} | ${metrics}`);
  }
  lines.push('');

  // Unassigned
  if (data.unassigned_tasks.length > 0) {
    lines.push(`## Unassigned Tasks (${data.unassigned_tasks.length})`);
    for (const t of data.unassigned_tasks) {
      lines.push(`- ${t.title} (${t.project}) ${t.url || ''}`);
    }
    lines.push('');
  }

  // Recent activity
  if (data.recent_activity.length > 0) {
    lines.push(`## Recent Activity`);
    for (const e of data.recent_activity) {
      const ts = new Date(e.timestamp).toISOString().slice(11, 16);
      lines.push(`- [${ts}] ${e.agent}: ${e.action} ${e.target || ''} (${e.project || ''})`);
    }
    lines.push('');
  }

  // Collab
  lines.push(`## Collaboration: ${data.collab.nodes} agents, ${data.collab.edges} edges`);

  return lines.join('\n');
}

router.get('/', (req, res) => {
  const data = buildOverview();
  if (req.query.format === 'text') {
    res.type('text/plain; charset=utf-8').send(toText(data));
  } else {
    res.json(data);
  }
});

module.exports = router;
