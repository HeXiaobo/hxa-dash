// Auto-assign engine (#61 + #74)
// Runs every 5 minutes. Two jobs:
// 1. (#61) Detects offline agents with open issues → reassigns to idle agents
// 2. (#74) Detects new unassigned issues → broadcasts via WebSocket + notifies HxA Connect
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const db = require('./db');
const skillMatcher = require('./skill-matcher');

const INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const MAX_PER_RUN = 3;                // max reassignments per cycle
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min without last_seen → treat as offline

let gitlabConfig = null;
let gitlabGroupId = null;
let wsModule = null;
// Round-robin index for idle agent selection
let rrIndex = 0;
// Track previously seen unassigned issue IDs to detect new ones
const seenUnassigned = new Set();

function init(config, ws) {
  gitlabConfig = config.gitlab;
  gitlabGroupId = config.gitlab.group_id;
  if (ws) wsModule = ws;
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

// (#74) Check for new unassigned issues and broadcast
function checkUnassigned() {
  const unassigned = db.getUnassignedIssues();
  const newIssues = [];

  for (const issue of unassigned) {
    if (!seenUnassigned.has(issue.id)) {
      seenUnassigned.add(issue.id);
      newIssues.push(issue);
    }
  }

  // Clean up: remove IDs no longer in unassigned list (they got assigned)
  for (const id of seenUnassigned) {
    if (!unassigned.find(i => i.id === id)) {
      seenUnassigned.delete(id);
    }
  }

  if (newIssues.length > 0) {
    // Get recommendations for new unassigned issues
    const withRecs = newIssues.map(issue => ({
      ...issue,
      recommendation: skillMatcher.recommend(issue),
    }));

    // Broadcast via WebSocket so all connected agents/dashboards see them
    if (wsModule) {
      wsModule.broadcast('unassigned:new', {
        count: withRecs.length,
        issues: withRecs,
      });
    }

    // Notify HxA Connect
    const lines = withRecs.map(i => {
      const top = i.recommendation.candidates[0];
      const recStr = top ? ` → 推荐: ${top.display_name} (score: ${top.score})` : '';
      return `• [${i.project}] ${i.title}${recStr}`;
    }).join('\n');
    notify(`📋 [hxa-dash] 发现 ${withRecs.length} 个未分配 issue:\n${lines}\n\n任何 agent 可通过 Dash API 领取：POST /api/auto-assign/claim`);

    console.log(`[AutoAssign] Found ${newIssues.length} new unassigned issue(s), broadcasted`);
  }

  // Also broadcast current unassigned count for dashboard display
  if (wsModule && unassigned.length > 0) {
    wsModule.broadcast('unassigned:count', { count: unassigned.length });
  }
}

// (#61) Offline agent reassignment
async function runOfflineReassign() {
  const now = Date.now();
  const allAgents = db.getAllAgents();

  const offlineAgents = allAgents.filter(a => {
    if (!a.online) return true;
    if (a.last_seen_at && (now - a.last_seen_at) > OFFLINE_THRESHOLD_MS) return true;
    return false;
  });

  if (offlineAgents.length === 0) return;

  const idleAgents = allAgents.filter(a => {
    if (!a.online) return false;
    if (a.last_seen_at && (now - a.last_seen_at) > OFFLINE_THRESHOLD_MS) return false;
    const assignedTasks = db.getTasksForAgent(a.name, { assigneeOnly: true });
    const openCount = assignedTasks.filter(t => t.state === 'opened').length;
    return openCount === 0;
  });

  if (idleAgents.length === 0) return;

  const allTasks = db.getAllTasks();
  const offlineNames = new Set(offlineAgents.map(a => a.name));

  const candidateIssues = allTasks.filter(t =>
    t.type === 'issue' &&
    t.state === 'opened' &&
    t.assignee &&
    offlineNames.has(t.assignee)
  );

  if (candidateIssues.length === 0) return;

  const toReassign = candidateIssues.slice(0, MAX_PER_RUN);
  const reassigned = [];

  for (const issue of toReassign) {
    const parts = issue.id.split('-');
    if (parts.length < 3) continue;
    const project_id = parseInt(parts[1]);
    const issue_iid = parseInt(parts[2]);
    if (isNaN(project_id) || isNaN(issue_iid)) continue;

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

  if (reassigned.length > 0) {
    const lines = reassigned.map(r =>
      `• [${r.project}] ${r.issue_title} → ${r.from} ⇒ ${r.to}`
    ).join('\n');
    notify(`🔄 [hxa-dash] 自动任务重分配 (${reassigned.length} 个):\n${lines}`);
    console.log(`[AutoAssign] Reassigned ${reassigned.length} issue(s) and sent notification`);
  }
}

async function runOnce() {
  try {
    // (#74) Check for new unassigned issues
    checkUnassigned();
    // (#61) Reassign offline agent tasks
    await runOfflineReassign();
  } catch (err) {
    console.error('[AutoAssign] Engine error:', err.message);
  }
}

function start() {
  if (!gitlabConfig) {
    console.error('[AutoAssign] Engine not initialized — call init(config) first');
    return;
  }
  console.log('[AutoAssign] Engine started (interval: 5 min, unassigned detection + offline reassign)');
  // Run after a short delay on startup so the first poll has populated db
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, INTERVAL_MS);
  }, 60000); // wait 60s for initial data load
}

module.exports = { init, start, runOnce };
