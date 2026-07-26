/**
 * Active data reporting endpoints (hxa-dash #16)
 *
 * POST /api/report              — Agent pushes current status/heartbeat
 * POST /api/webhook/connect     — HxA Connect online/offline callbacks
 * POST /api/webhook/gitlab      — GitLab webhook events (push/MR/issue/note)
 */

const { Router } = require('express');
const db = require('../db');
const { redactSecretShaped, redactSecretShapedDeep } = require('../secret-shapes');
const collab = require('../analyzers/collab');
const { buildAgents } = require('./team');
const { computeMetrics } = require('./metrics');
const {
  hasApiKey,
  requireIngestAuth,
  requireIngestAuthUnlessEnvFlag,
} = require('../auth/api-key');
const { isAuthEnabled } = require('../auth/config');

let ws = null;
let config = null;

function init(wsModule, cfg) {
  ws = wsModule;
  config = cfg;
}

const router = Router();
const requireConnectWebhookAuth = requireIngestAuthUnlessEnvFlag('HXA_CONNECT_WEBHOOK_PUBLIC');

// ---------------------------------------------------------------------------
// Credential-shape guard for every write this router performs (issue #25 P1).
//
// Canonical `wiki/procedures/hxa-dash-anomaly-criteria-v1.md` requires
// 「secret 值形态检测（sk-/ghp_/AIza/JWT/BEGIN）+ 日志与错误路径同样过净化」.
// P1 (61a763f) wired the two agent-* ingest points; Veda's re-verification found
// report.js — /api/report, /api/report/activity, /api/webhook/connect — was not
// wired at all, so a credential in any of those bodies was stored verbatim and
// rendered on the homepage. Deploying without this would be a fake "fixed".
//
// WHY at the db-write boundary rather than a per-field call list: unlike
// agent-health/agent-state, this router has NO field allowlist — the bodies are
// free-form (`metadata` arbitrary object, `tags` array, per-event objects). A
// list of field names can neither reach inside `metadata` nor survive a field
// being added later. Routing every db.* call in this file through these three
// wrappers is greppable ("no bare db.upsert/db.insert in report.js") and cannot
// be forgotten for a new field.
//
// EXCEPTION — identity keys are redacted at the entry point instead: `name` /
// `bot.name` / `agent` are also used for lookups, dedup keys, external_id
// composition and log lines, so redacting them only at the write boundary would
// leave the plaintext in those derived paths.
function safeUpsertAgent(agent) {
  db.upsertAgent(redactSecretShapedDeep(agent));
}

function safeInsertEvent(event) {
  db.insertEvent(redactSecretShapedDeep(event));
}

function safeUpsertTask(task) {
  db.upsertTask(redactSecretShapedDeep(task));
}

function safeUpsertEdge(edge) {
  db.upsertEdge(redactSecretShapedDeep(edge));
}

function verifyGitlabWebhook(req) {
  const secret = config?.webhooks?.gitlab_secret;
  if (secret) return req.headers['x-gitlab-token'] === secret;
  if (isAuthEnabled()) return hasApiKey(req);
  return true;
}

// ---------------------------------------------------------------------------
// POST /api/report — Agent heartbeat / status push
// Body: { name, status?, current_task?, metadata? }
// ---------------------------------------------------------------------------
router.post('/report', requireIngestAuth, (req, res) => {
  const { status, current_task, metadata } = req.body || {};
  // Identity key: redact before it is used as a lookup/dedup key (see the
  // wrapper block above). A credential-shaped name collapses into the marker
  // rather than creating an agent row named after a secret.
  const name = redactSecretShaped((req.body || {}).name);
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
    // Redact INSIDE the object, before serialization: the boundary wrapper would
    // see one big JSON string and replace the whole blob, losing every legitimate
    // field alongside the offending one. Recursing first redacts only the field
    // that actually looks like a credential.
    ...(metadata && { metadata: JSON.stringify(redactSecretShapedDeep(metadata)) })
  };

  safeUpsertAgent(updated);

  // Insert heartbeat event into timeline
  safeInsertEvent({
    agent: name,
    action: current_task ? 'working_on' : 'heartbeat',
    target_title: current_task || 'status update',
    target_url: null,
    project: null,
    timestamp: now
  });

  // Broadcast team update
  if (ws) {
    ws.broadcast('team:update', buildAgents());
    ws.broadcast('metrics:update', computeMetrics());
  }

  res.json({ ok: true, ts: now });
});

// ---------------------------------------------------------------------------
// POST /api/webhook/connect — HxA Connect online/offline callbacks
// Body: { event: 'bot.online'|'bot.offline', bot: { name, role, bio, tags } }
// ---------------------------------------------------------------------------
router.post('/webhook/connect', requireConnectWebhookAuth, (req, res) => {
  const { event, bot } = req.body || {};
  if (!event || !bot?.name) return res.status(400).json({ error: 'event and bot.name required' });

  const now = Date.now();
  // Identity key redacted at entry — it is the agent key, the dedup key and it
  // is echoed into the log line below.
  const botName = redactSecretShaped(bot.name);
  const existing = db.getAgent(botName);
  const isOnline = event === 'bot.online';

  const agent = {
    name: botName,
    role: bot.role || existing?.role || '',
    bio: bot.bio || existing?.bio || '',
    // Same reason as `metadata` on /api/report: recurse into the array before
    // serializing, so one credential-shaped tag does not void the whole list.
    tags: JSON.stringify(redactSecretShapedDeep(bot.tags || [])),
    online: isOnline ? 1 : 0,
    last_seen_at: now,
    updated_at: now
  };

  safeUpsertAgent(agent);

  // Insert online/offline event
  safeInsertEvent({
    agent: botName,
    action: isOnline ? 'came_online' : 'went_offline',
    target_title: isOnline ? 'came online' : 'went offline',
    target_url: null,
    project: null,
    timestamp: now
  });

  // Broadcast
  if (ws) {
    ws.broadcast('team:update', buildAgents());
    ws.broadcast('metrics:update', computeMetrics());
    ws.broadcast('timeline:new', db.getTimeline(20));
  }

  // canonical: 「日志与错误路径同样过净化」 — hence botName, not bot.name.
  console.log(`[Webhook/Connect] ${botName} ${event}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/webhook/gitlab — GitLab group webhook
// Handles: Push, Merge Request, Issue, Note (comment)
// ---------------------------------------------------------------------------
router.post('/webhook/gitlab', (req, res) => {
  if (!verifyGitlabWebhook(req)) {
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
    // canonical explicitly names the error path: a thrown message can quote the
    // offending payload value back out, into both the log and the HTTP response.
    const safeMessage = redactSecretShaped(err.message);
    console.error('[Webhook/GitLab] Error:', safeMessage);
    res.status(500).json({ error: safeMessage });
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

// Resolved agent names are written to the DB *and* echoed into the console.log
// lines below, so the credential guard is applied here at the single place every
// gitlab handler derives a name — canonical: 「日志与错误路径同样过净化」.
function resolveAgent(username, usernameMap) {
  // Use entity layer first (canonical ID resolution), fallback to legacy usernameMap
  const entity = require('../entity');
  const resolved = entity.resolve('gitlab', username);
  if (resolved !== username) return redactSecretShaped(resolved);
  return redactSecretShaped(usernameMap[username] || username || null);
}

// Project names / actions / noteable types come straight from the payload and are
// interpolated into log lines, so they get the same treatment at derivation.
function safeLabel(value, fallback) {
  return redactSecretShaped(value) || fallback;
}

function handlePush(payload, usernameMap, now) {
  const agent = resolveAgent(payload.user_username, usernameMap);
  if (!agent) return false;

  const commits = payload.commits || [];
  const project = safeLabel(payload.project?.name || payload.repository?.name, 'unknown');
  const branch = (payload.ref || '').replace('refs/heads/', '');

  for (const commit of commits.slice(0, 5)) {
    safeInsertEvent({
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
    safeInsertEvent({
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
  const action = redactSecretShaped(payload.object_attributes?.action);
  const mr = payload.object_attributes;
  if (!mr) return false;

  const agent = resolveAgent(payload.user?.username, usernameMap);
  const project = safeLabel(payload.project?.name, 'unknown');

  // Upsert task
  safeUpsertTask({
    id: `mr-${mr.project_id || payload.project?.id}-${mr.iid}`,
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
    safeInsertEvent({
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
      safeUpsertEdge({
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
  const action = redactSecretShaped(payload.object_attributes?.action);
  const issue = payload.object_attributes;
  if (!issue) return false;

  const agent = resolveAgent(payload.user?.username, usernameMap);
  const project = safeLabel(payload.project?.name, 'unknown');
  const assignees = (issue.assignees || []).map(a => resolveAgent(a.username, usernameMap)).filter(Boolean);

  safeUpsertTask({
    id: `issue-${issue.project_id || payload.project?.id}-${issue.iid}`,
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
    safeInsertEvent({
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

  const project = safeLabel(payload.project?.name, 'unknown');
  const targetType = safeLabel(note.noteable_type, 'unknown');
  const targetTitle =
    payload.merge_request?.title ||
    payload.issue?.title ||
    payload.commit?.message?.split('\n')[0] ||
    'comment';

  safeInsertEvent({
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
    safeUpsertEdge({
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

// ---------------------------------------------------------------------------
// GET /api/report/summary — Team productivity summary for a given period (#45)
// Query: ?days=7 (default 7)
// ---------------------------------------------------------------------------
router.get('/report/summary', (req, res) => {
  const days = Math.max(1, Math.min(90, parseInt(req.query.days) || 7));
  const now = Date.now();
  const periodStart = now - days * 24 * 60 * 60 * 1000;

  const agents = db.getAllAgents();
  const board = db.getTasksByState();
  const allTasks = [...board.todo, ...board.doing, ...board.done];

  // Tasks completed in the period
  const completedInPeriod = allTasks.filter(t =>
    (t.state === 'closed' || t.state === 'merged') && t.updated_at > periodStart
  );

  // Active tasks (currently open with assignee)
  const activeTasks = allTasks.filter(t => t.state === 'opened' && t.assignee);
  const totalOpen = allTasks.filter(t => t.state === 'opened').length;

  // Per-agent load
  const agentLoad = {};
  for (const t of activeTasks) {
    agentLoad[t.assignee] = (agentLoad[t.assignee] || 0) + 1;
  }

  // Bottleneck: agent with most open tasks
  let bottleneck = null;
  let maxLoad = 0;
  for (const [name, count] of Object.entries(agentLoad)) {
    if (count > maxLoad) { bottleneck = name; maxLoad = count; }
  }

  // Team utilization: ratio of agents with at least one open task
  const onlineAgents = agents.filter(a => a.online);
  const busyAgents = onlineAgents.filter(a => agentLoad[a.name] > 0);
  const utilization = onlineAgents.length > 0
    ? Math.round((busyAgents.length / onlineAgents.length) * 100)
    : 0;

  // Events in period
  const events = db.getTimeline(500).filter(e => e.timestamp > periodStart);

  res.json({
    period: { days, from: periodStart, to: now },
    summary: {
      total_agents: agents.length,
      online_agents: onlineAgents.length,
      total_open_tasks: totalOpen,
      active_tasks: activeTasks.length,
      completed_in_period: completedInPeriod.length,
      utilization_pct: utilization,
      total_events: events.length,
      bottleneck: bottleneck ? { agent: bottleneck, open_tasks: maxLoad } : null
    },
    per_agent: agents.map(a => ({
      name: a.name,
      online: !!a.online,
      open_tasks: agentLoad[a.name] || 0,
      completed: completedInPeriod.filter(t => t.assignee === a.name).length
    }))
  });
});

// ---------------------------------------------------------------------------
// POST /api/report/activity — External bot activity reporting
// Allows any bot to push its own activity events (messages, tasks, etc.)
// Body: { agent, events: [{ action, target_type?, target_title, timestamp?, external_id? }] }
// ---------------------------------------------------------------------------
router.post('/report/activity', requireIngestAuth, (req, res) => {
  const { events: activityEvents } = req.body || {};
  // Identity key redacted at entry: it feeds entity resolution AND is
  // interpolated into the fallback external_id below, which the write-boundary
  // wrapper could then only void wholesale.
  const agent = redactSecretShaped((req.body || {}).agent);
  if (!agent) return res.status(400).json({ error: 'agent required' });
  if (!Array.isArray(activityEvents) || activityEvents.length === 0) {
    return res.status(400).json({ error: 'events array required' });
  }

  const now = Date.now();
  const entity = require('../entity');
  const canonicalAgent = entity.resolve('connect', agent) || agent;
  let inserted = 0;

  for (const evt of activityEvents.slice(0, 50)) {
    if (!evt.action) continue;
    // `action` is redacted here as well as at the boundary, because it is
    // interpolated into the composed external_id.
    const action = redactSecretShaped(evt.action);
    safeInsertEvent({
      timestamp: evt.timestamp || now,
      agent: canonicalAgent,
      action,
      target_type: evt.target_type || 'external',
      target_title: evt.target_title || action,
      project: evt.project || null,
      url: evt.url || null,
      is_collab: evt.is_collab || 0,
      external_id: evt.external_id || `ext:${agent}:${action}:${now}`
    });
    inserted++;
  }

  if (ws && inserted > 0) {
    ws.broadcast('timeline:new', db.getTimeline(50));
    ws.broadcast('team:update', buildAgents());
    ws.broadcast('metrics:update', computeMetrics());
  }

  res.json({ ok: true, inserted });
});

module.exports = { router, init };
