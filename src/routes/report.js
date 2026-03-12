/**
 * Active data reporting endpoints (hxa-dash #16)
 *
 * POST /api/report              — Agent pushes current status/heartbeat
 * POST /api/webhook/connect     — HxA Connect online/offline callbacks
 * POST /api/webhook/gitlab      — GitLab webhook events (push/MR/issue/note)
 */

const { Router } = require('express');
const db = require('../db');
const collab = require('../analyzers/collab');

let ws = null;
let config = null;

function init(wsModule, cfg) {
  ws = wsModule;
  config = cfg;
}

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/report — Agent heartbeat / status push
// Body: { name, status?, current_task?, metadata? }
// ---------------------------------------------------------------------------
router.post('/report', (req, res) => {
  const { name, status, current_task, metadata } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const now = Date.now();
  const existing = db.getAgent(name);

  const updated = {
    name,
    role: existing?.role || '',
    bio: existing?.bio || '',
    tags: existing?.tags || '[]',
    online: 1,
    last_seen_at: now,
    updated_at: now,
    ...(status && { status }),
    ...(current_task && { current_task }),
    ...(metadata && { metadata: JSON.stringify(metadata) })
  };

  db.upsertAgent(updated);

  // Insert heartbeat event into timeline
  db.insertEvent({
    agent: name,
    action: current_task ? 'working_on' : 'heartbeat',
    target_title: current_task || 'status update',
    target_url: null,
    project: null,
    timestamp: now
  });

  // Broadcast team update
  if (ws) ws.broadcast('team:update', db.getAllAgents());

  res.json({ ok: true, ts: now });
});

// ---------------------------------------------------------------------------
// POST /api/webhook/connect — HxA Connect online/offline callbacks
// Body: { event: 'bot.online'|'bot.offline', bot: { name, role, bio, tags } }
// ---------------------------------------------------------------------------
router.post('/webhook/connect', (req, res) => {
  const { event, bot } = req.body || {};
  if (!event || !bot?.name) return res.status(400).json({ error: 'event and bot.name required' });

  const now = Date.now();
  const existing = db.getAgent(bot.name);
  const isOnline = event === 'bot.online';

  const agent = {
    name: bot.name,
    role: bot.role || existing?.role || '',
    bio: bot.bio || existing?.bio || '',
    tags: JSON.stringify(bot.tags || []),
    online: isOnline ? 1 : 0,
    last_seen_at: now,
    updated_at: now
  };

  db.upsertAgent(agent);

  // Insert online/offline event
  db.insertEvent({
    agent: bot.name,
    action: isOnline ? 'came_online' : 'went_offline',
    target_title: isOnline ? 'came online' : 'went offline',
    target_url: null,
    project: null,
    timestamp: now
  });

  // Broadcast
  if (ws) {
    ws.broadcast('team:update', db.getAllAgents());
    ws.broadcast('timeline:new', db.getTimeline(20));
  }

  console.log(`[Webhook/Connect] ${bot.name} ${event}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/webhook/gitlab — GitLab group webhook
// Handles: Push, Merge Request, Issue, Note (comment)
// ---------------------------------------------------------------------------
router.post('/webhook/gitlab', (req, res) => {
  // Validate secret if configured
  const secret = config?.webhooks?.gitlab_secret;
  if (secret && req.headers['x-gitlab-token'] !== secret) {
    return res.status(401).json({ error: 'invalid token' });
  }

  const event = req.headers['x-gitlab-event'];
  const payload = req.body;
  if (!event || !payload) return res.status(400).json({ error: 'missing event or payload' });

  try {
    const handled = handleGitLabEvent(event, payload);
    if (handled) {
      const graph = collab.analyze();
      if (ws) {
        ws.broadcast('board:update', db.getTasksByState());
        ws.broadcast('timeline:new', db.getTimeline(20));
        ws.broadcast('graph:update', graph);
      }
    }
    res.json({ ok: true, handled });
  } catch (err) {
    console.error('[Webhook/GitLab] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GitLab event handlers
// ---------------------------------------------------------------------------
function handleGitLabEvent(eventHeader, payload) {
  const usernameMap = config?.gitlab?.username_map || {};
  const now = Date.now();

  switch (eventHeader) {
    case 'Push Hook':
    case 'Tag Push Hook':
      return handlePush(payload, usernameMap, now);

    case 'Merge Request Hook':
      return handleMR(payload, usernameMap, now);

    case 'Issue Hook':
      return handleIssue(payload, usernameMap, now);

    case 'Note Hook':
    case 'Confidential Note Hook':
      return handleNote(payload, usernameMap, now);

    default:
      console.log(`[Webhook/GitLab] Unhandled event: ${eventHeader}`);
      return false;
  }
}

function resolveAgent(username, usernameMap) {
  // Use entity layer first (canonical ID resolution), fallback to legacy usernameMap
  const entity = require('../entity');
  const resolved = entity.resolve('gitlab', username);
  if (resolved !== username) return resolved;
  return usernameMap[username] || username || null;
}

function handlePush(payload, usernameMap, now) {
  const agent = resolveAgent(payload.user_username, usernameMap);
  if (!agent) return false;

  const commits = payload.commits || [];
  const project = payload.project?.name || payload.repository?.name || 'unknown';
  const branch = (payload.ref || '').replace('refs/heads/', '');

  for (const commit of commits.slice(0, 5)) {
    db.insertEvent({
      agent,
      action: 'pushed',
      target_title: commit.message?.split('\n')[0]?.slice(0, 100) || 'commit',
      target_url: commit.url || null,
      project,
      timestamp: new Date(commit.timestamp).getTime() || now,
      // external_id: stable per-commit ID for dedup against polling fetchEvents
      external_id: commit.id ? 'commit:' + commit.id : null
    });
  }

  if (commits.length === 0) {
    db.insertEvent({
      agent,
      action: 'pushed',
      target_title: `to ${branch}`,
      target_url: payload.project?.web_url || null,
      project,
      timestamp: now
    });
  }

  console.log(`[Webhook/GitLab] Push: ${agent} → ${project} (${commits.length} commits)`);
  return true;
}

function handleMR(payload, usernameMap, now) {
  const action = payload.object_attributes?.action;
  const mr = payload.object_attributes;
  if (!mr) return false;

  const agent = resolveAgent(payload.user?.username, usernameMap);
  const project = payload.project?.name || 'unknown';

  // Upsert task
  db.upsertTask({
    id: `mr:${mr.id}`,
    type: 'mr',
    title: mr.title || '',
    state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'opened',
    assignee: resolveAgent(mr.assignee?.username, usernameMap) || null,
    author: resolveAgent(mr.author_id ? payload.user?.username : null, usernameMap) || agent,
    project,
    url: mr.url || null,
    updated_at: new Date(mr.updated_at).getTime() || now
  });

  if (agent) {
    db.insertEvent({
      agent,
      action: `mr_${action || 'updated'}`,
      target_title: mr.title || 'MR',
      target_url: mr.url || null,
      project,
      timestamp: now,
      // external_id: matches polling fetchEvents external_id for same MR event
      external_id: mr.id ? 'mr:' + mr.id + ':' + (action || 'update') : null
    });
  }

  // Track reviewer collaboration edge
  const reviewers = payload.reviewers || [];
  for (const reviewer of reviewers) {
    const reviewerAgent = resolveAgent(reviewer.username, usernameMap);
    if (agent && reviewerAgent && agent !== reviewerAgent) {
      db.upsertEdge({
        source: agent,
        target: reviewerAgent,
        type: 'review',
        weight: 1,
        updated_at: now
      });
    }
  }

  console.log(`[Webhook/GitLab] MR ${action}: ${agent} → ${project}`);
  return true;
}

function handleIssue(payload, usernameMap, now) {
  const action = payload.object_attributes?.action;
  const issue = payload.object_attributes;
  if (!issue) return false;

  const agent = resolveAgent(payload.user?.username, usernameMap);
  const project = payload.project?.name || 'unknown';
  const assignees = (issue.assignees || []).map(a => resolveAgent(a.username, usernameMap)).filter(Boolean);

  db.upsertTask({
    id: `issue:${issue.id}`,
    type: 'issue',
    title: issue.title || '',
    state: issue.state === 'closed' ? 'closed' : 'opened',
    assignee: assignees[0] || null,
    author: agent,
    project,
    url: issue.url || null,
    updated_at: new Date(issue.updated_at).getTime() || now
  });

  if (agent) {
    db.insertEvent({
      agent,
      action: `issue_${action || 'updated'}`,
      target_title: issue.title || 'issue',
      target_url: issue.url || null,
      project,
      timestamp: now,
      // external_id: matches polling fetchEvents external_id for same issue event
      external_id: issue.id ? 'issue:' + issue.id + ':' + (action || 'update') : null
    });
  }

  console.log(`[Webhook/GitLab] Issue ${action}: ${agent} → ${project}`);
  return true;
}

function handleNote(payload, usernameMap, now) {
  const note = payload.object_attributes;
  if (!note) return false;

  const agent = resolveAgent(payload.user?.username, usernameMap);
  if (!agent) return false;

  const project = payload.project?.name || 'unknown';
  const targetType = note.noteable_type || 'unknown';
  const targetTitle =
    payload.merge_request?.title ||
    payload.issue?.title ||
    payload.commit?.message?.split('\n')[0] ||
    'comment';

  db.insertEvent({
    agent,
    action: 'commented',
    target_title: targetTitle.slice(0, 100),
    target_url: note.url || null,
    project,
    timestamp: new Date(note.created_at).getTime() || now,
    // external_id: matches polling fetchEvents external_id for same note event
    external_id: note.id ? 'note:' + note.id : null
  });

  // Track collaboration with MR/issue author
  const targetAuthor = resolveAgent(
    payload.merge_request?.assignee?.username ||
    payload.issue?.assignees?.[0]?.username,
    usernameMap
  );
  if (targetAuthor && targetAuthor !== agent) {
    db.upsertEdge({
      source: agent,
      target: targetAuthor,
      type: 'comment',
      weight: 1,
      updated_at: now
    });
  }

  console.log(`[Webhook/GitLab] Note on ${targetType}: ${agent} → ${project}`);
  return true;
}

module.exports = { router, init };
