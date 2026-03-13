// Auto-assign route (#61 + #74)
// POST /api/auto-assign/execute    — reassign a GitLab issue to a new agent
// GET  /api/auto-assign/history    — return recent auto-assign events
// POST /api/auto-assign/smart      — skill-aware smart assign (#74)
// GET  /api/auto-assign/unassigned — list unassigned issues with recommendations (#74)
// POST /api/auto-assign/claim      — agent self-claims a task (#74)
const { Router } = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const skillMatcher = require('../skill-matcher');

const router = Router();

// Load GitLab config once
const configPath = path.join(__dirname, '..', '..', 'config', 'sources.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const gitlabConfig = config.gitlab;

// GitLab API helper (PUT / POST with body)
function gitlabRequest(method, endpoint, body) {
  const url = `${gitlabConfig.url}/api/v4${endpoint}`;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const urlObj = new URL(url);
    const req = mod.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'PRIVATE-TOKEN': gitlabConfig.token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} on ${method} ${endpoint}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// Resolve canonical agent name -> GitLab username
function getGitlabUsername(agentName) {
  const map = gitlabConfig.username_map || {};
  // Invert the map: canonical name -> gitlab username
  for (const [glUser, canonical] of Object.entries(map)) {
    if (canonical === agentName) return glUser;
  }
  // Fallback: lowercase agent name
  return agentName.toLowerCase();
}

// POST /api/auto-assign/execute
// Body: { project_id, issue_iid, assignee_username, reason, from_agent }
router.post('/execute', async (req, res) => {
  const { project_id, issue_iid, assignee_username, reason, from_agent } = req.body || {};

  if (!project_id || !issue_iid || !assignee_username) {
    return res.status(400).json({ error: 'project_id, issue_iid, and assignee_username are required' });
  }

  try {
    // Resolve GitLab user ID for the new assignee
    const entity = require('../entity');
    const glUsername = getGitlabUsername(assignee_username);

    // Look up user ID from GitLab
    const usersEndpoint = `/users?username=${encodeURIComponent(glUsername)}&per_page=1`;
    const glFetch = (endpoint) => new Promise((resolve, reject) => {
      const url = `${gitlabConfig.url}/api/v4${endpoint}`;
      const mod = url.startsWith('https') ? https : http;
      const req2 = mod.get(url, { headers: { 'PRIVATE-TOKEN': gitlabConfig.token } }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      });
      req2.on('error', reject);
      req2.setTimeout(10000, () => { req2.destroy(); reject(new Error('timeout')); });
    });

    const users = await glFetch(usersEndpoint);
    if (!users || users.length === 0) {
      return res.status(404).json({ error: `GitLab user not found: ${glUsername}` });
    }
    const userId = users[0].id;

    // Update the issue in GitLab
    await gitlabRequest('PUT', `/projects/${project_id}/issues/${issue_iid}`, {
      assignee_ids: [userId]
    });

    // Log to DB
    const event = {
      ts: Date.now(),
      project_id,
      issue_iid,
      from_agent: from_agent || 'unknown',
      to_agent: assignee_username,
      reason: reason || 'auto-reassign'
    };
    db.logAutoAssign(event);

    console.log(`[AutoAssign] Issue !${issue_iid} (project ${project_id}): ${from_agent} → ${assignee_username} (${reason})`);

    res.json({ ok: true, event });
  } catch (err) {
    console.error('[AutoAssign] Execute error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auto-assign/history
router.get('/history', (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  res.json({ events: db.getAutoAssignHistory(limit) });
});

// Helper: look up GitLab user ID by username
function glFetchUserId(glUsername) {
  return new Promise((resolve, reject) => {
    const url = `${gitlabConfig.url}/api/v4/users?username=${encodeURIComponent(glUsername)}&per_page=1`;
    const mod = url.startsWith('https') ? https : http;
    const req2 = mod.get(url, { headers: { 'PRIVATE-TOKEN': gitlabConfig.token } }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const users = JSON.parse(d);
          if (!users || users.length === 0) return reject(new Error(`GitLab user not found: ${glUsername}`));
          resolve(users[0].id);
        } catch (e) { reject(e); }
      });
    });
    req2.on('error', reject);
    req2.setTimeout(10000, () => { req2.destroy(); reject(new Error('timeout')); });
  });
}

// Helper: assign a GitLab issue and log the event
async function assignIssue(project_id, issue_iid, agentName, from, reason) {
  const glUsername = getGitlabUsername(agentName);
  const userId = await glFetchUserId(glUsername);

  await gitlabRequest('PUT', `/projects/${project_id}/issues/${issue_iid}`, {
    assignee_ids: [userId]
  });

  const event = {
    ts: Date.now(),
    project_id,
    issue_iid,
    from_agent: from || 'unassigned',
    to_agent: agentName,
    reason: reason || 'auto-assign'
  };
  db.logAutoAssign(event);
  return event;
}

// Helper: parse task_id "issue-{project_id}-{iid}"
function parseTaskId(task_id) {
  const parts = task_id.split('-');
  if (parts.length < 3) return null;
  const project_id = parseInt(parts[1]);
  const issue_iid = parseInt(parts[2]);
  if (isNaN(project_id) || isNaN(issue_iid)) return null;
  return { project_id, issue_iid };
}

// POST /api/auto-assign/smart (#74 — skill-aware smart assign)
// Body: { task_id }  — pick best available agent using skill matching + workload
// Returns: { ok, assignee, recommendation, event } or { error }
router.post('/smart', async (req, res) => {
  const { task_id } = req.body || {};
  if (!task_id) return res.status(400).json({ error: 'task_id required' });

  const task = db.getTask(task_id);
  if (!task) return res.status(404).json({ error: `Task not found: ${task_id}` });
  if (task.type !== 'issue') return res.status(400).json({ error: 'Only issues can be smart-assigned' });
  if (task.state !== 'opened') return res.status(400).json({ error: 'Issue is not open' });

  const parsed = parseTaskId(task_id);
  if (!parsed) return res.status(400).json({ error: 'Invalid task_id format' });

  // Use skill matcher for recommendation
  const recommendation = skillMatcher.recommend(task);
  if (recommendation.candidates.length === 0) {
    return res.status(503).json({ error: 'No available agents for assignment' });
  }

  const best = recommendation.candidates[0];

  try {
    const event = await assignIssue(
      parsed.project_id, parsed.issue_iid,
      best.agent, task.assignee || 'unassigned',
      `smart-assign (score: ${best.score}, skills: ${recommendation.issue_skills.join(',')})`
    );

    console.log(`[SmartAssign] Issue #${parsed.issue_iid} (project ${parsed.project_id}) → ${best.agent} (score: ${best.score})`);
    res.json({ ok: true, assignee: best.agent, recommendation, event });
  } catch (err) {
    console.error('[SmartAssign] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auto-assign/unassigned (#74)
// Returns all unassigned open issues with recommended assignees
// Query params: ?project=name (optional filter)
router.get('/unassigned', (req, res) => {
  const all = skillMatcher.getUnassignedWithRecommendations();
  const project = req.query.project;
  const filtered = project ? all.filter(i => i.project === project) : all;
  res.json({
    count: filtered.length,
    issues: filtered.map(i => ({
      id: i.id,
      title: i.title,
      project: i.project,
      url: i.url,
      labels: i.labels,
      created_at: i.created_at,
      updated_at: i.updated_at,
      recommendation: i.recommendation,
    }))
  });
});

// POST /api/auto-assign/claim (#74 — decentralized agent self-claim)
// Body: { task_id, agent }  — agent claims a task for itself
// Returns: { ok, event } or { error }
router.post('/claim', async (req, res) => {
  const { task_id, agent } = req.body || {};
  if (!task_id || !agent) return res.status(400).json({ error: 'task_id and agent are required' });

  const task = db.getTask(task_id);
  if (!task) return res.status(404).json({ error: `Task not found: ${task_id}` });
  if (task.type !== 'issue') return res.status(400).json({ error: 'Only issues can be claimed' });
  if (task.state !== 'opened') return res.status(400).json({ error: 'Issue is not open' });
  if (task.assignee) return res.status(409).json({ error: `Already assigned to ${task.assignee}` });

  const parsed = parseTaskId(task_id);
  if (!parsed) return res.status(400).json({ error: 'Invalid task_id format' });

  try {
    const event = await assignIssue(
      parsed.project_id, parsed.issue_iid,
      agent, 'unassigned',
      `self-claim by ${agent}`
    );

    console.log(`[Claim] Issue #${parsed.issue_iid} claimed by ${agent}`);
    res.json({ ok: true, event });
  } catch (err) {
    console.error('[Claim] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auto-assign/recommend (#74)
// Body via query: ?task_id=issue-X-Y
// Returns recommendation without assigning
router.get('/recommend', (req, res) => {
  const task_id = req.query.task_id;
  if (!task_id) return res.status(400).json({ error: 'task_id query param required' });

  const task = db.getTask(task_id);
  if (!task) return res.status(404).json({ error: `Task not found: ${task_id}` });

  const recommendation = skillMatcher.recommend(task);
  res.json({ task_id, title: task.title, recommendation });
});

module.exports = router;
