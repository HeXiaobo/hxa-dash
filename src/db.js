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

// Task operations
const upsertTask = (task) => {
  store.tasks.set(task.id, { ...task });
};

const getTasksByState = () => {
  const all = [...store.tasks.values()].sort((a, b) => b.updated_at - a.updated_at);
  const opened = all.filter(t => t.state === 'opened');
  // "doing" = has assignee OR has activity in last 7 days with author
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const doing = opened.filter(t => t.assignee || (t.author && t.updated_at > sevenDaysAgo));
  const doingIds = new Set(doing.map(t => t.id));
  return {
    todo: opened.filter(t => !doingIds.has(t.id)),
    doing,
    done: all.filter(t => t.state === 'closed' || t.state === 'merged')
  };
};

const getTasksForAgent = (name) => {
  return [...store.tasks.values()]
    .filter(t => t.assignee === name || t.author === name || (t.reviewer && t.reviewer.split(',').includes(name)))
    .sort((a, b) => b.updated_at - a.updated_at);
};

// Event operations
const insertEvent = (event) => {
  // Dedup by timestamp + agent + action + target
  const exists = store.events.some(e =>
    e.timestamp === event.timestamp &&
    e.agent === event.agent &&
    e.action === event.action &&
    e.target_title === event.target_title
  );
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
  store.collab_edges.set(key, { ...edge });
};

const clearEdges = () => store.collab_edges.clear();

const getCollabEdges = () =>
  [...store.collab_edges.values()].filter(e => e.weight > 0);

const getCollabsForAgent = (name) =>
  [...store.collab_edges.values()].filter(e => e.source === name || e.target === name);

// Project list (derived from tasks)
const getProjects = () => {
  const projects = new Set();
  for (const task of store.tasks.values()) {
    if (task.project && task.project !== 'unknown') projects.add(task.project);
  }
  return [...projects].sort();
};

module.exports = {
  upsertAgent, getAllAgents, getAgent,
  upsertTask, getTasksByState, getTasksForAgent,
  insertEvent, getTimeline, getEventsForAgent,
  upsertEdge, clearEdges, getCollabEdges, getCollabsForAgent,
  getProjects
};
