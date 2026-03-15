const { Router } = require('express');
const db = require('../db');
const { parseDependencies } = require('./webhook');

const router = Router();

// GET /api/pipeline — dependency-driven task pipeline (#77)
// Query: ?project= filter by project name
router.get('/', (req, res) => {
  const allTasks = db.getAllTasks();
  const projectFilter = req.query.project || '';
  const agents = db.getAllAgents();
  const agentMap = new Map(agents.map(a => [a.name, a]));
  const now = Date.now();

  // Build task lookup by project_id + iid for dependency resolution
  const taskByProjIid = new Map();
  for (const t of allTasks) {
    if (t.type === 'issue' && t.iid && t.project_id) {
      taskByProjIid.set(`${t.project_id}:${t.iid}`, t);
    }
  }

  // Process open issues only (pipeline = active work)
  let openTasks = allTasks.filter(t => t.type === 'issue' && t.state === 'opened');
  if (projectFilter) {
    openTasks = openTasks.filter(t => t.project === projectFilter);
  }

  // Enrich each task with dependency info and pipeline stage
  const pipelineTasks = openTasks.map(t => {
    const deps = parseDependencies(t.description);
    const depDetails = deps.map(iid => {
      const dep = taskByProjIid.get(`${t.project_id}:${iid}`);
      return {
        iid,
        title: dep?.title || `#${iid}`,
        state: dep?.state || 'unknown',
        met: !dep || dep.state === 'closed' || dep.state === 'merged'
      };
    });

    const allDepsMet = depDetails.every(d => d.met);
    const hasUnmetDeps = depDetails.some(d => !d.met);

    // Determine pipeline stage
    let stage;
    if (hasUnmetDeps) {
      stage = 'blocked'; // waiting for dependencies
    } else if (t.assignee) {
      const agent = agentMap.get(t.assignee);
      const isActive = agent?.online;
      stage = isActive ? 'executing' : 'assigned'; // assigned but agent offline
    } else {
      stage = 'ready'; // deps met, no assignee — can be picked up
    }

    // Find downstream tasks that depend on this issue
    const downstreamIds = [];
    for (const other of openTasks) {
      if (other.id === t.id) continue;
      const otherDeps = parseDependencies(other.description);
      if (otherDeps.includes(t.iid)) {
        downstreamIds.push(other.iid);
      }
    }

    return {
      id: t.id,
      iid: t.iid,
      title: t.title,
      url: t.url || '',
      project: t.project || '',
      projectId: t.project_id,
      assignee: t.assignee || null,
      labels: t.labels || [],
      stage,
      dependencies: depDetails,
      downstreamCount: downstreamIds.length,
      downstreamIids: downstreamIds,
      updatedAt: t.updated_at,
      createdAt: t.created_at
    };
  });

  // Identify critical path: tasks that block the most downstream work
  // Score = direct downstream + transitive downstream (BFS)
  const iidToTask = new Map(pipelineTasks.map(t => [t.iid, t]));
  for (const t of pipelineTasks) {
    let score = 0;
    const visited = new Set();
    const queue = [t.iid];
    while (queue.length > 0) {
      const curr = queue.shift();
      const node = iidToTask.get(curr);
      if (!node) continue;
      for (const ds of node.downstreamIids) {
        if (!visited.has(ds)) {
          visited.add(ds);
          score++;
          queue.push(ds);
        }
      }
    }
    t.criticalScore = score;
    t.isCritical = score >= 2; // blocks 2+ downstream tasks
  }

  // Sort within each stage: critical tasks first, then by downstream count
  pipelineTasks.sort((a, b) => {
    const stageOrder = { executing: 0, assigned: 1, ready: 2, blocked: 3 };
    const sa = stageOrder[a.stage] ?? 9;
    const sb = stageOrder[b.stage] ?? 9;
    if (sa !== sb) return sa - sb;
    if (b.criticalScore !== a.criticalScore) return b.criticalScore - a.criticalScore;
    return b.downstreamCount - a.downstreamCount;
  });

  // Build dependency edges for visualization
  const edges = [];
  for (const t of pipelineTasks) {
    for (const dep of t.dependencies) {
      if (iidToTask.has(dep.iid)) {
        edges.push({
          from: dep.iid,
          to: t.iid,
          met: dep.met
        });
      }
    }
  }

  // Summary counts
  const summary = {
    total: pipelineTasks.length,
    executing: pipelineTasks.filter(t => t.stage === 'executing').length,
    assigned: pipelineTasks.filter(t => t.stage === 'assigned').length,
    ready: pipelineTasks.filter(t => t.stage === 'ready').length,
    blocked: pipelineTasks.filter(t => t.stage === 'blocked').length,
    critical: pipelineTasks.filter(t => t.isCritical).length
  };

  res.json({ tasks: pipelineTasks, edges, summary, timestamp: now });
});

module.exports = router;
