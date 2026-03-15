// In-memory data store (cache layer — all real data comes from Connect + GitLab)
const store = {
  agents: new Map(),      // name -> agent
  tasks: new Map(),       // id -> task
  events: [],             // sorted by timestamp desc
  collab_edges: new Map() // "source|target|type" -> edge
};

// Agent operations
const upsertAgent = (agent) => {
  store.agents.set(agent.name, { ...agent });
};

const getAllAgents = () => {
  return [...store.agents.values()].sort((a, b) => {
    if (a.online !== b.online) return b.online - a.online;
    return (a.name || '').localeCompare(b.name || '');
  });
};

const getAgent = (name) => store.agents.get(name) || null;

const removeAgent = (name) => store.agents.delete(name);

// Task operations
const upsertTask = (task) => {
  store.tasks.set(task.id, { ...task });
};

const getTasksByState = () => {
  const all = [...store.tasks.values()].sort((a, b) => b.updated_at - a.updated_at);
  const opened = all.filter(t => t.state === 'opened');
  // "doing" = has assignee (someone is actively working on it)
  // "todo" = opened but no assignee (unassigned, waiting for pickup)
  return {
    todo: opened.filter(t => !t.assignee),
    doing: opened.filter(t => !!t.assignee),
    done: all.filter(t => t.state === 'closed' || t.state === 'merged')
  };
};

const getTasksForAgent = (name, { assigneeOnly = false } = {}) => {
  return [...store.tasks.values()]
    .filter(t => {
      if (t.assignee === name) return true;
      if (assigneeOnly) return false;
      return t.author === name || (t.reviewer && t.reviewer.split(',').includes(name));
    })
    .sort((a, b) => b.updated_at - a.updated_at);
};

// Event operations
const insertEvent = (event) => {
  const exists = store.events.some(e => {
    // Primary dedup: external_id match when both events have one
    // external_id is a stable string derived from GitLab object IDs (e.g. "mr:123:open", "note:456", "commit:abc")
    // This correctly deduplicates events inserted by both the webhook handler and the polling fetcher.
    if (event.external_id && e.external_id && event.external_id === e.external_id) return true;
    // Fallback: timestamp + agent + action + title (for events without external_id)
    return e.timestamp === event.timestamp &&
      e.agent === event.agent &&
      e.action === event.action &&
      e.target_title === event.target_title;
  });
  if (!exists) {
    store.events.push({ ...event });
    // Keep sorted desc, limit to 500
    store.events.sort((a, b) => b.timestamp - a.timestamp);
    if (store.events.length > 500) store.events.length = 500;
  }
};

const getTimeline = (limit = 100) => store.events.slice(0, limit);

const getEventsForAgent = (name, limit = 50) =>
  store.events.filter(e => e.agent === name).slice(0, limit);

// Collab operations
const upsertEdge = (edge) => {
  const key = `${edge.source}|${edge.target}|${edge.type}`;
  const existing = store.collab_edges.get(key);
  // Merge details array (deduplicate by url)
  const existingDetails = existing?.details || [];
  const newDetails = edge.details || [];
  const detailMap = new Map(existingDetails.map(d => [d.url, d]));
  for (const d of newDetails) if (d.url) detailMap.set(d.url, d);
  store.collab_edges.set(key, { ...edge, details: [...detailMap.values()] });
};

const clearEdges = () => store.collab_edges.clear();

const getCollabEdges = () =>
  [...store.collab_edges.values()].filter(e => e.weight > 0);

const getCollabsForAgent = (name) =>
  [...store.collab_edges.values()].filter(e => e.source === name || e.target === name);

// Get the top collaboration partner for an agent (highest total weight)
const getTopCollaborator = (name) => {
  const collabs = getCollabsForAgent(name);
  if (collabs.length === 0) return null;
  const partnerWeights = new Map();
  for (const c of collabs) {
    const partner = c.source === name ? c.target : c.source;
    partnerWeights.set(partner, (partnerWeights.get(partner) || 0) + (c.weight || 0));
  }
  let topPartner = null;
  let topWeight = 0;
  for (const [partner, weight] of partnerWeights) {
    if (weight > topWeight) { topPartner = partner; topWeight = weight; }
  }
  return topPartner ? { name: topPartner, weight: topWeight } : null;
};

// Project list (derived from tasks)
const getProjects = () => {
  const projects = new Set();
  for (const task of store.tasks.values()) {
    if (task.project && task.project !== 'unknown') projects.add(task.project);
  }
  return [...projects].sort();
};

// Stats helpers

// Events within a time window, optionally filtered by agent
const getEventsInWindow = (sinceMs, agent = null) => {
  let events = store.events.filter(e => e.timestamp >= sinceMs);
  if (agent) events = events.filter(e => e.agent === agent);
  return events;
};

// Tasks closed/merged within a time window, optionally filtered by agent
const getTasksClosedInWindow = (sinceMs, agent = null) => {
  return [...store.tasks.values()].filter(t => {
    const closed = t.state === 'closed' || t.state === 'merged';
    const inWindow = t.updated_at >= sinceMs;
    const matchAgent = !agent || t.assignee === agent || t.author === agent;
    return closed && inWindow && matchAgent;
  });
};

// Build time buckets (day or hour granularity) for event histogram
const buildTimeline = (sinceMs, agent = null, granularity = 'day') => {
  const events = getEventsInWindow(sinceMs, agent);
  const bucketMs = granularity === 'hour' ? 3600000 : 86400000;
  const bucketMap = new Map();

  for (const e of events) {
    const key = Math.floor(e.timestamp / bucketMs) * bucketMs;
    if (!bucketMap.has(key)) bucketMap.set(key, { timestamp: key, actions: {}, total: 0 });
    const b = bucketMap.get(key);
    b.actions[e.action] = (b.actions[e.action] || 0) + 1;
    b.total++;
  }

  // Fill empty buckets from sinceMs to now
  const now = Date.now();
  for (let t = Math.floor(sinceMs / bucketMs) * bucketMs; t <= now; t += bucketMs) {
    if (!bucketMap.has(t)) bucketMap.set(t, { timestamp: t, actions: {}, total: 0 });
  }

  return [...bucketMap.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(b => ({
      ...b,
      events: Object.entries(b.actions).map(([action, count]) => ({ action, count }))
    }));
};

// Build trend series: per-day count for a given action filter
const buildTrends = (days = 7) => {
  const sinceMs = Date.now() - days * 86400000;
  const events = getEventsInWindow(sinceMs);
  const tasks = [...store.tasks.values()];

  // Per-day buckets
  const dayMap = new Map();
  const addDay = (ts) => {
    const key = Math.floor(ts / 86400000) * 86400000;
    if (!dayMap.has(key)) dayMap.set(key, { timestamp: key, commits: 0, comments: 0, issues_opened: 0, issues_closed: 0, mrs_merged: 0 });
    return dayMap.get(key);
  };

  // Fill all days first
  const now = Date.now();
  for (let t = Math.floor(sinceMs / 86400000) * 86400000; t <= now; t += 86400000) addDay(t);

  for (const e of events) {
    const b = addDay(e.timestamp);
    if (e.action === 'pushed') b.commits++;
    else if (e.action === 'commented') b.comments++;
    else if (e.action === 'issue_opened') b.issues_opened++;
    else if (e.action === 'issue_closed') b.issues_closed++;
    else if (e.action === 'mr_merged') b.mrs_merged++;
  }

  // Per-agent summary over the window
  const agentNames = [...store.agents.keys()];
  const agentStats = agentNames.map(name => {
    const agentEvents = events.filter(e => e.agent === name);
    const closed = tasks.filter(t =>
      (t.state === 'closed' || t.state === 'merged') &&
      t.updated_at >= sinceMs &&
      (t.assignee === name || t.author === name)
    );
    return {
      name,
      commits: agentEvents.filter(e => e.action === 'pushed').length,
      comments: agentEvents.filter(e => e.action === 'commented').length,
      issues_closed: closed.filter(t => t.type === 'issue').length,
      mrs_merged: closed.filter(t => t.type === 'mr').length,
      total_events: agentEvents.length,
    };
  }).sort((a, b) => b.total_events - a.total_events);

  return {
    buckets: [...dayMap.values()].sort((a, b) => a.timestamp - b.timestamp),
    agents: agentStats,
  };
};

// Per-agent detailed stats snapshot
const getAgentStats = () => {
  const tasks = [...store.tasks.values()];
  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  const recentEvents = store.events.filter(e => e.timestamp >= thirtyDaysAgo);

  return [...store.agents.values()].map(agent => {
    const agentTasks = tasks.filter(t => t.assignee === agent.name || t.author === agent.name);
    const agentEvents = recentEvents.filter(e => e.agent === agent.name);
    const lastEvent = agentEvents[0]; // sorted desc

    return {
      name: agent.name,
      online: agent.online,
      last_seen_at: agent.last_seen_at,
      last_active: lastEvent?.timestamp || null,
      open_tasks: agentTasks.filter(t => t.state === 'opened').length,
      closed_tasks: agentTasks.filter(t => t.state === 'closed' || t.state === 'merged').length,
      mr_count: agentTasks.filter(t => t.type === 'mr').length,
      event_count_30d: agentEvents.length,
    };
  }).sort((a, b) => b.event_count_30d - a.event_count_30d);
};

const getAllTasks = () => [...store.tasks.values()];

const getTask = (id) => store.tasks.get(id) || null;

// Workload report: per-agent productivity breakdown over a configurable time window
const getWorkloadReport = (days = 30) => {
  const sinceMs = Date.now() - days * 86400000;
  const recentEvents = store.events.filter(e => e.timestamp >= sinceMs);
  const tasks = [...store.tasks.values()];

  return [...store.agents.values()].map(agent => {
    const agentEvents = recentEvents.filter(e => e.agent === agent.name);
    const closedTasks = tasks.filter(t =>
      (t.state === 'closed' || t.state === 'merged') &&
      t.updated_at >= sinceMs &&
      (t.assignee === agent.name || t.author === agent.name)
    );

    return {
      name: agent.name,
      online: agent.online,
      closed_issues: closedTasks.filter(t => t.type === 'issue').length,
      merged_mrs: closedTasks.filter(t => t.type === 'mr').length,
      commits: agentEvents.filter(e => e.action === 'pushed').length,
      comments: agentEvents.filter(e => e.action === 'commented').length,
      total_events: agentEvents.length,
    };
  }).sort((a, b) => b.total_events - a.total_events);
};

// Blocker detection helpers

// Stale issues: open issues with no activity for more than thresholdMs
const getStaleIssues = (now, thresholdMs) => {
  return [...store.tasks.values()]
    .filter(t => t.type === 'issue' && t.state === 'opened' && (now - t.updated_at) > thresholdMs)
    .map(t => ({
      title: t.title,
      url: t.url,
      project: t.project,
      assignee: t.assignee || null,
      stale_hours: Math.floor((now - t.updated_at) / 3600000),
    }))
    .sort((a, b) => b.stale_hours - a.stale_hours);
};

// Unreviewed MRs: open MRs created more than thresholdMs ago with no reviewer or unapproved
const getUnreviewedMRs = (now, thresholdMs) => {
  return [...store.tasks.values()]
    .filter(t => t.type === 'mr' && t.state === 'opened' && (now - (t.created_at || t.updated_at)) > thresholdMs)
    .map(t => ({
      title: t.title,
      url: t.url,
      project: t.project,
      author: t.author || null,
      hours_open: Math.floor((now - (t.created_at || t.updated_at)) / 3600000),
    }))
    .sort((a, b) => b.hours_open - a.hours_open);
};

// Stale MRs: open MRs with no activity (updated_at) beyond threshold — 30min SLA default
const getStaleMRs = (now, thresholdMs) => {
  return [...store.tasks.values()]
    .filter(t => t.type === 'mr' && t.state === 'opened' && (now - t.updated_at) > thresholdMs)
    .map(t => ({
      title: t.title,
      url: t.url,
      project: t.project,
      author: t.author || t.assignee || null,
      reviewer: t.reviewer || null,
      stale_minutes: Math.floor((now - t.updated_at) / 60000),
    }))
    .sort((a, b) => b.stale_minutes - a.stale_minutes);
};

// Idle agents: offline agents not seen for more than thresholdMs
const getIdleAgents = (now, thresholdMs) => {
  return [...store.agents.values()]
    .filter(a => !a.online && a.last_seen_at && (now - a.last_seen_at) > thresholdMs)
    .map(a => ({
      name: a.name,
      last_seen_hours: Math.floor((now - a.last_seen_at) / 3600000),
    }))
    .sort((a, b) => b.last_seen_hours - a.last_seen_hours);
};

// Auto-assign event log (persisted via SQLite-like in-memory store)
const autoAssignEvents = [];

const logAutoAssign = ({ ts, project_id, issue_iid, from_agent, to_agent, reason }) => {
  autoAssignEvents.unshift({ id: autoAssignEvents.length + 1, ts, project_id, issue_iid, from_agent, to_agent, reason });
  if (autoAssignEvents.length > 200) autoAssignEvents.length = 200;
};

const getAutoAssignHistory = (limit = 20) => autoAssignEvents.slice(0, limit);

// Unassigned open issues
const getUnassignedIssues = () => {
  return [...store.tasks.values()]
    .filter(t => t.type === 'issue' && t.state === 'opened' && !t.assignee)
    .sort((a, b) => b.created_at - a.created_at);
};

// Session estimate → session count mapping
const ESTIMATE_SESSIONS = { S: 0.5, M: 1, L: 2, XL: 4 };

// Session estimate → human-readable minutes mapping
const ESTIMATE_MINUTES = { S: 20, M: 45, L: 90, XL: 180 };

// Get session velocity: sessions completed per day per agent (rolling window)
const getSessionVelocity = (days = 7) => {
  const sinceMs = Date.now() - days * 86400000;
  const closedTasks = [...store.tasks.values()].filter(t =>
    (t.state === 'closed' || t.state === 'merged') &&
    t.updated_at >= sinceMs &&
    t.estimate
  );

  const agentSessions = new Map();
  for (const t of closedTasks) {
    const agent = t.assignee || t.author;
    if (!agent) continue;
    const sessions = ESTIMATE_SESSIONS[t.estimate] || 0;
    agentSessions.set(agent, (agentSessions.get(agent) || 0) + sessions);
  }

  const result = [];
  for (const [name, totalSessions] of agentSessions) {
    result.push({
      name,
      total_sessions: totalSessions,
      sessions_per_day: Math.round((totalSessions / days) * 100) / 100,
    });
  }

  return result.sort((a, b) => b.sessions_per_day - a.sessions_per_day);
};

// Get session summary for all tasks (estimate distribution)
const getSessionSummary = () => {
  const tasks = [...store.tasks.values()];
  const open = tasks.filter(t => t.state === 'opened');
  const closed = tasks.filter(t => t.state === 'closed' || t.state === 'merged');

  const countByEstimate = (list) => {
    const counts = { S: 0, M: 0, L: 0, XL: 0, unestimated: 0 };
    for (const t of list) {
      if (t.estimate && counts[t.estimate] !== undefined) counts[t.estimate]++;
      else counts.unestimated++;
    }
    return counts;
  };

  const openSessions = open.reduce((s, t) => s + (ESTIMATE_SESSIONS[t.estimate] || 0), 0);
  const openMinutes = open.reduce((s, t) => s + (ESTIMATE_MINUTES[t.estimate] || 0), 0);

  return {
    open: countByEstimate(open),
    closed: countByEstimate(closed),
    open_total_sessions: openSessions,
    open_estimated_minutes: openMinutes,
  };
};

// Blocking MRs per agent: open MRs where agent is author/assignee, open > thresholdMs
const getBlockingMRsForAgent = (name, now, thresholdMs = 15 * 60 * 1000) => {
  return [...store.tasks.values()]
    .filter(t =>
      t.type === 'mr' &&
      t.state === 'opened' &&
      (t.assignee === name || t.author === name) &&
      (now - (t.updated_at || t.created_at)) > thresholdMs
    )
    .map(t => ({
      title: t.title,
      url: t.url,
      project: t.project,
      minutes_stale: Math.floor((now - (t.updated_at || t.created_at)) / 60000),
    }))
    .sort((a, b) => b.minutes_stale - a.minutes_stale);
};

module.exports = {
  upsertAgent, getAllAgents, getAgent, removeAgent,
  upsertTask, getTasksByState, getTasksForAgent, getAllTasks, getTask,
  insertEvent, getTimeline, getEventsForAgent,
  upsertEdge, clearEdges, getCollabEdges, getCollabsForAgent, getTopCollaborator,
  getProjects,
  getEventsInWindow, buildTimeline, buildTrends, getAgentStats,
  getStaleIssues, getUnreviewedMRs, getStaleMRs, getIdleAgents,
  getBlockingMRsForAgent,
  getWorkloadReport,
  logAutoAssign, getAutoAssignHistory,
  getUnassignedIssues,
  getSessionVelocity, getSessionSummary,
  ESTIMATE_SESSIONS, ESTIMATE_MINUTES,
};
