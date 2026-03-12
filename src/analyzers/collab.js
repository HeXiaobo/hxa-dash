const db = require('../db');

function analyze() {
  // Clear existing edges
  db.clearEdges();

  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const edgeMap = new Map();

  // Get all tasks from in-memory store
  const board = db.getTasksByState();
  const allTasks = [...board.todo, ...board.doing, ...board.done];

  // Edge detail map: key -> { weight, details[], first_seen, last_seen }
  const edgeDetailMap = new Map();
  const addEdge = (key, detail, timestamp) => {
    const existing = edgeDetailMap.get(key) || { weight: 0, details: [], first_seen: timestamp, last_seen: timestamp };
    existing.weight += 1;
    existing.first_seen = Math.min(existing.first_seen, timestamp || now);
    existing.last_seen = Math.max(existing.last_seen, timestamp || now);
    if (detail && detail.url && !existing.details.find(d => d.url === detail.url)) {
      existing.details.push(detail);
    }
    edgeDetailMap.set(key, existing);
  };

  // 1. Review edges: MR assignee <-> reviewer
  const mrs = allTasks.filter(t => t.type === 'mr' && t.reviewer && t.updated_at > thirtyDaysAgo);

  for (const mr of mrs) {
    if (!mr.assignee || !mr.reviewer) continue;
    const reviewers = mr.reviewer.split(',').filter(Boolean);
    for (const rev of reviewers) {
      if (rev === mr.assignee) continue;
      const pair = [mr.assignee, rev].sort();
      const key = `${pair[0]}|${pair[1]}|review`;
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
      addEdge(key, { title: mr.title, url: mr.url, project: mr.project, type: 'mr' }, mr.updated_at);
    }
  }

  // 2. Project edges: agents working on same project
  const projectAgents = new Map();
  const recentTasks = allTasks.filter(t => t.updated_at > thirtyDaysAgo);

  for (const task of recentTasks) {
    if (!task.assignee) continue;
    if (!projectAgents.has(task.project)) projectAgents.set(task.project, new Set());
    projectAgents.get(task.project).add(task.assignee);
  }

  // Track project tasks per agent for detail lookup
  const projectTaskMap = new Map(); // "project|agent" -> task[]
  for (const task of recentTasks) {
    if (!task.assignee) continue;
    const k = `${task.project}|${task.assignee}`;
    if (!projectTaskMap.has(k)) projectTaskMap.set(k, []);
    projectTaskMap.get(k).push(task);
  }

  for (const [project, agents] of projectAgents) {
    const agentList = [...agents];
    for (let i = 0; i < agentList.length; i++) {
      for (let j = i + 1; j < agentList.length; j++) {
        const pp = [agentList[i], agentList[j]].sort();
        const key = `${pp[0]}|${pp[1]}|project`;
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
        // Pick a representative task for detail
        const tasks = [...(projectTaskMap.get(`${project}|${agentList[i]}`) || []), ...(projectTaskMap.get(`${project}|${agentList[j]}`) || [])];
        const rep = tasks[0];
        addEdge(key, rep ? { title: rep.title, url: rep.url, project: rep.project, type: rep.type } : null, rep?.updated_at);
      }
    }
  }

  // 3. Event-based collaboration: agents active on same targets
  const recentEvents = db.getTimeline(500).filter(e => e.timestamp > thirtyDaysAgo);
  const targetAgents = new Map();

  for (const evt of recentEvents) {
    if (!evt.target_title || !evt.agent) continue;
    const key = `${evt.project}:${evt.target_title}`;
    if (!targetAgents.has(key)) targetAgents.set(key, new Set());
    targetAgents.get(key).add(evt.agent);
  }

  // Track event details per target for issue edge details
  const targetEventMap = new Map(); // target_key -> evt[]
  for (const evt of recentEvents) {
    if (!evt.target_title || !evt.agent) continue;
    const k = `${evt.project}:${evt.target_title}`;
    if (!targetEventMap.has(k)) targetEventMap.set(k, []);
    targetEventMap.get(k).push(evt);
  }

  for (const [targetKey, agents] of targetAgents) {
    if (agents.size < 2) continue;
    const agentList = [...agents];
    const evts = targetEventMap.get(targetKey) || [];
    for (let i = 0; i < agentList.length; i++) {
      for (let j = i + 1; j < agentList.length; j++) {
        const ip = [agentList[i], agentList[j]].sort();
        const key = `${ip[0]}|${ip[1]}|issue`;
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
        const rep = evts[0];
        addEdge(key, rep ? { title: rep.target_title, url: rep.target_url || null, project: rep.project, type: 'issue' } : null, rep?.timestamp);
      }
    }
  }

  // Write edges (prefer edgeDetailMap over edgeMap)
  for (const [key, weight] of edgeMap) {
    const [source, target, type] = key.split('|');
    const detail = edgeDetailMap.get(key) || {};
    db.upsertEdge({
      source, target, type,
      weight: detail.weight || weight,
      details: detail.details || [],
      first_seen: detail.first_seen || now,
      last_seen: detail.last_seen || now,
      updated_at: now
    });
  }

  return getGraph();
}

function getGraph() {
  const agents = db.getAllAgents();
  const edges = db.getCollabEdges();

  const nodes = agents.map(a => ({
    id: a.name,
    name: a.name,
    role: a.role,
    online: !!a.online,
    stats: {}
  }));

  for (const node of nodes) {
    const tasks = db.getTasksForAgent(node.name);
    node.stats = {
      mr_count: tasks.filter(t => t.type === 'mr').length,
      issue_count: tasks.filter(t => t.type === 'issue').length,
      open_count: tasks.filter(t => t.state === 'opened').length,
      closed_count: tasks.filter(t => t.state === 'closed' || t.state === 'merged').length
    };
  }

  return {
    nodes,
    edges: edges.map(e => ({
      source: e.source,
      target: e.target,
      type: e.type,
      weight: e.weight,
      details: (e.details || []).slice(0, 10), // cap at 10 records
      first_seen: e.first_seen || null,
      last_seen: e.last_seen || null
    }))
  };
}

module.exports = { analyze, getGraph };
