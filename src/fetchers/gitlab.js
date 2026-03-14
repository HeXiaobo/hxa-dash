const https = require('https');
const http = require('http');
const db = require('../db');
const entity = require('../entity');

let config = null;
const projectNameCache = new Map(); // project_id -> name

function init(cfg) {
  config = cfg.gitlab;
}

function mapUsername(gitlabUsername) {
  // Resolve GitLab username to canonical entity ID
  return entity.resolve('gitlab', gitlabUsername);
}

async function apiFetch(endpoint) {
  const url = `${config.url}/api/v4${endpoint}`;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'PRIVATE-TOKEN': config.token }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} on ${endpoint}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}


// Normalize GitLab Events API action_name to match webhook handler canonical actions.
// Used for external_id construction — ensures webhook and polling produce matching IDs
// for the same real-world event so insertEvent can deduplicate them.
function normalizeGitLabAction(actionName) {
  switch ((actionName || '').toLowerCase()) {
    case 'opened':      return 'open';
    case 'merged':      return 'merge';
    case 'closed':      return 'close';
    case 'reopened':    return 'reopen';
    case 'approved':    return 'approved';
    case 'commented on':return 'comment';
    default:            return actionName || 'update';
  }
}

// Parse session estimate from GitLab labels
// Supports both scoped (estimate::S) and bare (S, M, L, XL) label formats
function parseEstimateLabel(labels) {
  const validSizes = new Set(['S', 'M', 'L', 'XL']);
  for (const label of labels) {
    // Scoped format: estimate::S
    const match = label.match(/^estimate::(\w+)$/i);
    if (match) {
      const size = match[1].toUpperCase();
      if (validSizes.has(size)) return size;
    }
    // Bare format: S, M, L, XL (exact match, case-insensitive)
    const bare = label.trim().toUpperCase();
    if (validSizes.has(bare)) return bare;
  }
  return null;
}

async function fetchIssues() {
  try {
    const issues = await apiFetch(`/groups/${config.group_id}/issues?state=all&per_page=100&order_by=updated_at&sort=desc`);
    const changes = [];

    for (const issue of issues) {
      // Use assignees array (preferred) or fallback to singular assignee
      const assignees = (issue.assignees || []).map(a => mapUsername(a.username));
      const assignee = assignees[0] || (issue.assignee ? mapUsername(issue.assignee.username) : null);
      const task = {
        id: `issue-${issue.project_id}-${issue.iid}`,
        iid: issue.iid,
        project_id: issue.project_id,
        type: 'issue',
        project: issue.references?.full?.split('#')[0]?.replace(/\/$/, '')?.split('/')?.pop() || 'unknown',
        title: issue.title,
        description: issue.description || '',
        state: issue.state,
        assignee: assignee,
        author: issue.author ? mapUsername(issue.author.username) : null,
        reviewer: null,
        url: issue.web_url,
        labels: JSON.stringify(issue.labels || []),
        estimate: parseEstimateLabel(issue.labels || []),
        created_at: new Date(issue.created_at).getTime(),
        updated_at: new Date(issue.updated_at).getTime()
      };
      db.upsertTask(task);
      changes.push(task);
    }
    return changes;
  } catch (err) {
    console.error('[GitLabFetcher] Issues error:', err.message);
    return [];
  }
}

async function fetchMRs() {
  try {
    const mrs = await apiFetch(`/groups/${config.group_id}/merge_requests?state=all&per_page=100&order_by=updated_at&sort=desc`);
    const changes = [];

    for (const mr of mrs) {
      const mrAssignees = (mr.assignees || []).map(a => mapUsername(a.username));
      const assignee = mrAssignees[0] || (mr.assignee ? mapUsername(mr.assignee.username) : null);
      const reviewers = (mr.reviewers || []).map(r => mapUsername(r.username));
      const task = {
        id: `mr-${mr.project_id}-${mr.iid}`,
        type: 'mr',
        project: mr.references?.full?.split('!')[0]?.replace(/\/$/, '')?.split('/')?.pop() || 'unknown',
        title: mr.title,
        state: mr.state,
        assignee: assignee,
        reviewer: reviewers.join(',') || null,
        url: mr.web_url,
        labels: JSON.stringify(mr.labels || []),
        estimate: parseEstimateLabel(mr.labels || []),
        created_at: new Date(mr.created_at).getTime(),
        updated_at: new Date(mr.updated_at).getTime()
      };
      db.upsertTask(task);
      changes.push(task);
    }
    return changes;
  } catch (err) {
    console.error('[GitLabFetcher] MRs error:', err.message);
    return [];
  }
}

async function fetchEvents() {
  try {
    // Fetch projects in the group first, then get events from each project
    // This ensures we get ALL users' events, not just the token owner's
    const projects = await apiFetch(`/groups/${config.group_id}/projects?per_page=100&simple=true`);
    const newEvents = [];
    const seenEventKeys = new Set();

    for (const proj of projects) {
      // Cache project name
      projectNameCache.set(proj.id, proj.name || proj.path);

      let projectEvents;
      try {
        projectEvents = await apiFetch(`/projects/${proj.id}/events?per_page=50`);
      } catch {
        continue; // skip projects we can't access
      }

      for (const event of projectEvents) {
        const agent = event.author ? mapUsername(event.author.username) : 'unknown';
        let action = event.action_name || 'unknown';
        let targetType = event.target_type ? event.target_type.toLowerCase() : (event.push_data ? 'push' : 'unknown');
        let targetTitle = event.target_title || (event.push_data ? `${event.push_data.commit_count} commit(s) to ${event.push_data.ref}` : '');
        const project = projectNameCache.get(event.project_id) || proj.name || `project-${event.project_id}`;

        // Deduplicate events across projects
        const eventKey = `${event.created_at}-${agent}-${action}-${targetType}-${targetTitle}`;
        if (seenEventKeys.has(eventKey)) continue;
        seenEventKeys.add(eventKey);

        // Compute stable external_id for cross-source deduplication.
        // These IDs match the external_id values set by the webhook handler in report.js,
        // so an event inserted by webhook won't be duplicated when polling runs.
        let externalId = null;
        if (targetType === 'mergerequest' && event.target_id) {
          externalId = 'mr:' + event.target_id + ':' + normalizeGitLabAction(event.action_name);
        } else if (targetType === 'issue' && event.target_id) {
          externalId = 'issue:' + event.target_id + ':' + normalizeGitLabAction(event.action_name);
        } else if (targetType === 'note' && event.target_id) {
          // Note events: event.target_id is the note ID
          externalId = 'note:' + event.target_id;
        } else if (event.push_data?.commit_to) {
          // Push events: use HEAD commit SHA — matches webhook's per-commit external_id for the last commit
          externalId = 'commit:' + event.push_data.commit_to;
        }

        const evt = {
          timestamp: new Date(event.created_at).getTime(),
          agent,
          action,
          target_type: targetType,
          target_title: targetTitle,
          project,
          url: event.target_url || '',
          is_collab: 0,
          external_id: externalId
        };
        db.insertEvent(evt);
        newEvents.push(evt);
      }
    }
    return newEvents;
  } catch (err) {
    console.error('[GitLabFetcher] Events error:', err.message);
    return [];
  }
}

async function fetchAll() {
  const [issues, mrs, events] = await Promise.all([
    fetchIssues(),
    fetchMRs(),
    fetchEvents()
  ]);
  return { issues, mrs, events };
}

module.exports = { init, fetchIssues, fetchMRs, fetchEvents, fetchAll, mapUsername };
