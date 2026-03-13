const { Router } = require('express');
const db = require('../db');

const router = Router();

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

// GET /api/my/:name — personal view for the specified agent or human team member (#73)
router.get('/:name', (req, res) => {
  const { name } = req.params;
  const agent = db.getAgent(name);
  if (!agent) return res.status(404).json({ error: 'Team member not found' });

  const allTasks = [...db.getAllTasks()];
  const now = Date.now();

  // Assigned open issues (todos)
  const todos = allTasks
    .filter(t => t.assignee === name && t.state === 'opened' && t.type === 'issue')
    .map(t => ({ title: t.title, url: t.url, project: t.project, type: t.type, created_at: t.created_at }));

  // MRs awaiting review (reviewer field contains name, state=opened)
  const pending_reviews = allTasks
    .filter(t =>
      t.state === 'opened' &&
      t.type === 'mr' &&
      t.reviewer &&
      t.reviewer.split(',').map(r => r.trim()).includes(name)
    )
    .map(t => ({ title: t.title, url: t.url, project: t.project, created_at: t.created_at }));

  // Active projects: unique projects from agent's open assigned tasks
  const active_projects = [...new Set(
    allTasks
      .filter(t => t.assignee === name && t.state === 'opened' && t.project)
      .map(t => t.project)
  )].sort();

  // Blockers: stale open tasks in active projects (not assigned to this agent)
  const activeProjectSet = new Set(active_projects);
  const blockers = allTasks
    .filter(t =>
      t.state === 'opened' &&
      t.project &&
      activeProjectSet.has(t.project) &&
      t.assignee !== name &&
      (now - t.updated_at) >= STALE_THRESHOLD_MS
    )
    .map(t => ({
      type: t.type,
      title: t.title,
      url: t.url,
      stale_hours: Math.floor((now - t.updated_at) / 3600000)
    }))
    .sort((a, b) => b.stale_hours - a.stale_hours)
    .slice(0, 10);

  res.json({
    agent: { name: agent.name, role: agent.role, online: !!agent.online },
    todos,
    pending_reviews,
    active_projects,
    blockers
  });
});

module.exports = router;
