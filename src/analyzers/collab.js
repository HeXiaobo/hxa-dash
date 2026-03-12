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

  for (const [, agents] of projectAgents) {
    const agentList = [...agents];
    for (let i = 0; i < agentList.length; i++) {
      for (let j = i + 1; j < agentList.length; j++) {
        const pp = [agentList[i], agentList[j]].sort();
        const key = `${pp[0]}|${pp[1]}|project`;
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
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

  for (const [, agents] of targetAgents) {
    if (agents.size < 2) continue;
    const agentList = [...agents];
    for (let i = 0; i < agentList.length; i++) {
      for (let j = i + 1; j < agentList.length; j++) {
        const ip = [agentList[i], agentList[j]].sort();
        const key = `${ip[0]}|${ip[1]}|issue`;
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
      }
    }
  }

  // Write edges
  for (const [key, weight] of edgeMap) {
    const [source, target, type] = key.split('|');
    db.upsertEdge({ source, target, type, weight, updated_at: now });
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
      weight: e.weight
    }))
  };
}

function getGraphByProject(project) {
  const agents = db.getAllAgents();
  const board = db.getTasksByState();
  const allTasks = [...board.todo, ...board.doing, ...board.done];

  // Find agents who worked on this project
  const projectAgentNames = new Set();
  for (const task of allTasks) {
    if (task.project === project) {
      if (task.assignee) projectAgentNames.add(task.assignee);
      if (task.author) projectAgentNames.add(task.author);
      if (task.reviewer) {
        task.reviewer.split(',').filter(Boolean).forEach(r => projectAgentNames.add(r));
      }
    }
  }

  // Filter edges: both endpoints must be project participants
  const edges = db.getCollabEdges().filter(e =>
    projectAgentNames.has(e.source) && projectAgentNames.has(e.target)
  );

  const edgeAgents = new Set();
  edges.forEach(e => { edgeAgents.add(e.source); edgeAgents.add(e.target); });

  // Include all project participants as nodes (even if no edges)
  const nodeNames = new Set([...projectAgentNames, ...edgeAgents]);

  const nodes = agents
    .filter(a => nodeNames.has(a.name))
    .map(a => {
      const tasks = db.getTasksForAgent(a.name).filter(t => t.project === project);
      return {
        id: a.name,
        name: a.name,
        role: a.role,
        online: !!a.online,
        stats: {
          mr_count: tasks.filter(t => t.type === 'mr').length,
          issue_count: tasks.filter(t => t.type === 'issue').length,
          open_count: tasks.filter(t => t.state === 'opened').length,
          closed_count: tasks.filter(t => t.state === 'closed' || t.state === 'merged').length
        }
      };
    });

  return {
    nodes,
    edges: edges.map(e => ({
      source: e.source,
      target: e.target,
      type: e.type,
      weight: e.weight
    }))
  };
}

module.exports = { analyze, getGraph, getGraphByProject };
