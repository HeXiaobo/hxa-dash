// Auto-assign engine (#61)
// Runs every 5 minutes. Detects offline agents with open issues and reassigns
// them to idle agents. Sends HxA Connect notification after each batch.
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const db = require('./db');

const INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const MAX_PER_RUN = 3;                // max reassignments per cycle
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min without last_seen → treat as offline

let gitlabConfig = null;
let gitlabGroupId = null;
// Round-robin index for idle agent selection
let rrIndex = 0;

function init(config) {
  gitlabConfig = config.gitlab;
  gitlabGroupId = config.gitlab.group_id;
}

// Simple GET helper for GitLab API
function glGet(endpoint) {
  const url = `${gitlabConfig.url}/api/v4${endpoint}`;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'PRIVATE-TOKEN': gitlabConfig.token } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 100)}`));
          return;
        }
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Internal POST to our own route — avoids duplicating GitLab + DB logic
function callExecute(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3479;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/auto-assign/execute',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve({ ok: false }); }
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
  for (const [glUser, canonical] of Object.entries(map)) {
    if (canonical === agentName) return glUser;
  }
  return agentName.toLowerCase();
}

// Send HxA Connect notification
function notify(message) {
  const threadTarget = 'org:coco|thread:0f5cfd31-291c-4c9e-95d4-6d24b931229f';
  const scriptPath = '/home/cocoai/zylos/.claude/skills/comm-bridge/scripts/c4-send.js';
  try {
    execSync(`node ${scriptPath} "hxa-connect" "${threadTarget}" ${JSON.stringify(message)}`, {
      timeout: 10000,
      stdio: 'ignore'
    });
  } catch (err) {
    console.error('[AutoAssign] Notify error:', err.message);
  }
}

async function runOnce() {
  try {
    const now = Date.now();

    // Get all agents from in-memory store
    const allAgents = db.getAllAgents();

    // Offline: online=false OR last_seen_at older than threshold
    const offlineAgents = allAgents.filter(a => {
      if (!a.online) return true;
      if (a.last_seen_at && (now - a.last_seen_at) > OFFLINE_THRESHOLD_MS) return true;
      return false;
    });

    if (offlineAgents.length === 0) return; // nothing to do

    // Idle: online=true, open_tasks=0
    const idleAgents = allAgents.filter(a => {
      if (!a.online) return false;
      if (a.last_seen_at && (now - a.last_seen_at) > OFFLINE_THRESHOLD_MS) return false;
      const assignedTasks = db.getTasksForAgent(a.name, { assigneeOnly: true });
      const openCount = assignedTasks.filter(t => t.state === 'opened').length;
      return openCount === 0;
    });

    if (idleAgents.length === 0) return; // no one to reassign to

    // Gather open issues assigned to offline agents (from in-memory task store)
    // Only issues (not MRs), state=opened, type=issue
    const allTasks = db.getAllTasks();
    const offlineNames = new Set(offlineAgents.map(a => a.name));

    const candidateIssues = allTasks.filter(t =>
      t.type === 'issue' &&
      t.state === 'opened' &&
      t.assignee &&
      offlineNames.has(t.assignee)
    );

    if (candidateIssues.length === 0) return; // offline agents have no open issues

    // Pick up to MAX_PER_RUN issues
    const toReassign = candidateIssues.slice(0, MAX_PER_RUN);
    const reassigned = [];

    for (const issue of toReassign) {
      // Parse project_id and issue_iid from task id: "issue-{project_id}-{iid}"
      const parts = issue.id.split('-');
      if (parts.length < 3) continue;
      const project_id = parseInt(parts[1]);
      const issue_iid = parseInt(parts[2]);
      if (isNaN(project_id) || isNaN(issue_iid)) continue;

      // Pick next idle agent (round-robin)
      const targetAgent = idleAgents[rrIndex % idleAgents.length];
      rrIndex++;

      try {
        const result = await callExecute({
          project_id,
          issue_iid,
          assignee_username: targetAgent.name,
          from_agent: issue.assignee,
          reason: `offline agent (${issue.assignee}) — auto-reassigned`
        });

        if (result.ok) {
          reassigned.push({
            issue_title: issue.title,
            issue_url: issue.url,
            from: issue.assignee,
            to: targetAgent.name,
            project: issue.project
          });
        }
      } catch (err) {
        console.error(`[AutoAssign] Failed to reassign issue ${issue.id}:`, err.message);
      }
    }

    // Send HxA Connect notification if anything was reassigned
    if (reassigned.length > 0) {
      const lines = reassigned.map(r =>
        `• [${r.project}] ${r.issue_title} → ${r.from} ⇒ ${r.to}`
      ).join('\n');
      const message = `🔄 [hxa-dash] 自动任务重分配 (${reassigned.length} 个):\n${lines}`;
      notify(message);
      console.log(`[AutoAssign] Reassigned ${reassigned.length} issue(s) and sent notification`);
    }
  } catch (err) {
    console.error('[AutoAssign] Engine error:', err.message);
  }
}

function start() {
  if (!gitlabConfig) {
    console.error('[AutoAssign] Engine not initialized — call init(config) first');
    return;
  }
  console.log('[AutoAssign] Engine started (interval: 5 min)');
  // Run after a short delay on startup so the first poll has populated db
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, INTERVAL_MS);
  }, 60000); // wait 60s for initial data load
}

module.exports = { init, start, runOnce };
