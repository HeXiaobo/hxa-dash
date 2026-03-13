// Auto-assign route (#61)
// POST /api/auto-assign/execute  — reassign a GitLab issue to a new agent
// GET  /api/auto-assign/history  — return recent auto-assign events
const { Router } = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const db = require('../db');

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

module.exports = router;
