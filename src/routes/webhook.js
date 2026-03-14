// GitLab Webhook handler — auto-trigger downstream tasks on issue close (#78)
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');

let webhookSecret = null;
let wsRef = null;
let gitlabConfig = null;

function init(config, ws) {
  webhookSecret = config.webhooks?.gitlab_secret || null;
  wsRef = ws;
  gitlabConfig = config.gitlab;
}

// Verify GitLab webhook token
function verifyToken(req) {
  if (!webhookSecret) return true; // no secret configured = accept all
  return req.headers['x-gitlab-token'] === webhookSecret;
}

// Parse dependency references from issue description
// Supports: "依赖: #225, #226", "Depends on: #10, #20", "blocked by #5"
function parseDependencies(description) {
  if (!description) return [];
  const deps = new Set();

  // Pattern: 依赖: #N, #M or 依赖：#N、#M
  const zhMatch = description.match(/依赖[：:]\s*([#\d,、\s]+)/gi);
  if (zhMatch) {
    for (const m of zhMatch) {
      const nums = m.match(/#(\d+)/g);
      if (nums) nums.forEach(n => deps.add(parseInt(n.replace('#', ''))));
    }
  }

  // Pattern: depends on #N, #M or blocked by #N
  const enMatch = description.match(/(?:depends?\s+on|blocked?\s+by)[：:]*\s*([#\d,\s]+)/gi);
  if (enMatch) {
    for (const m of enMatch) {
      const nums = m.match(/#(\d+)/g);
      if (nums) nums.forEach(n => deps.add(parseInt(n.replace('#', ''))));
    }
  }

  return [...deps];
}

// Find downstream issues that depend on the given issue IID within the same project
function findDownstreamIssues(closedProjectId, closedIid) {
  const allTasks = db.getAllTasks();
  const downstream = [];

  for (const task of allTasks) {
    if (task.type !== 'issue' || task.state !== 'opened') continue;
    // Only match within same project to avoid cross-project IID collisions
    if (task.project_id !== closedProjectId) continue;

    const deps = parseDependencies(task.description);
    if (deps.length > 0 && deps.includes(closedIid)) {
      downstream.push({ task, deps });
    }
  }

  return downstream;
}

// Check if all dependencies of an issue are closed (same project scope)
function allDepsClosed(deps, projectId) {
  const allTasks = db.getAllTasks();
  // Build lookup: iid -> task (scoped to same project)
  const taskByIid = new Map();
  for (const t of allTasks) {
    if (t.type === 'issue' && t.iid && t.project_id === projectId) {
      taskByIid.set(t.iid, t);
    }
  }

  for (const depIid of deps) {
    if (depIid === 0) continue; // skip zero IID
    const depTask = taskByIid.get(depIid);
    if (!depTask || depTask.state !== 'closed') return false;
  }
  return true;
}

// POST /api/webhook/gitlab
router.post('/gitlab', (req, res) => {
  if (!verifyToken(req)) {
    return res.status(403).json({ error: 'invalid token' });
  }

  const event = req.headers['x-gitlab-event'];
  const body = req.body;

  // Only handle issue close events
  if (event !== 'Issue Hook' || body.object_attributes?.action !== 'close') {
    return res.json({ status: 'ignored', reason: 'not an issue close event' });
  }

  const issue = body.object_attributes;
  const projectId = body.project?.id;
  const closedIid = issue.iid;
  const closedTitle = issue.title;
  const closedUrl = issue.url;

  console.log(`[Webhook] Issue #${closedIid} closed: ${closedTitle}`);

  // Find downstream issues that had this as a dependency
  const downstream = findDownstreamIssues(projectId, closedIid);
  const unblocked = [];

  for (const { task, deps } of downstream) {
    if (allDepsClosed(deps, task.project_id)) {
      unblocked.push(task);

      // Create timeline event for the unblock
      const assignee = task.assignee || 'unassigned';
      db.insertEvent({
        timestamp: Date.now(),
        agent: assignee,
        action: 'unblocked',
        target_title: task.title,
        target_url: task.url,
        external_id: `unblock:${task.id}:${closedIid}`,
        details: `All dependencies met after #${closedIid} closed`,
      });

      console.log(`[Webhook] Unblocked: ${task.title} (assignee: ${assignee})`);
    }
  }

  // Broadcast unblocked tasks to dashboard
  if (unblocked.length > 0 && wsRef) {
    wsRef.broadcast('tasks:unblocked', unblocked.map(t => ({
      id: t.id,
      iid: t.iid,
      title: t.title,
      url: t.url,
      assignee: t.assignee,
      project: t.project,
      trigger: `#${closedIid} ${closedTitle}`,
    })));

    // Also refresh timeline
    wsRef.broadcast('timeline:new', db.getTimeline(50));
  }

  res.json({
    status: 'ok',
    closed_issue: `#${closedIid}`,
    downstream_checked: downstream.length,
    unblocked: unblocked.map(t => ({ iid: t.iid, title: t.title, assignee: t.assignee })),
  });
});

// GET /api/webhook/status — check webhook configuration
router.get('/status', (req, res) => {
  res.json({
    configured: !!webhookSecret,
    endpoint: '/api/webhook/gitlab',
  });
});

module.exports = router;
module.exports.init = init;
module.exports.parseDependencies = parseDependencies;
