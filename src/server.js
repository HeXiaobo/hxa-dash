const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const ws = require('./ws');
const connectFetcher = require('./fetchers/connect');
const gitlabFetcher = require('./fetchers/gitlab');
const collab = require('./analyzers/collab');

const teamRoutes = require('./routes/team');
const { buildAgents } = teamRoutes;
const boardRoutes = require('./routes/board');
const { buildBoard } = boardRoutes;
const timelineRoutes = require('./routes/timeline');
const reportRoutes = require('./routes/report');
const statsRoutes = require('./routes/stats');
const trendsRoutes = require('./routes/trends');
const myRoutes = require('./routes/my');
const blockersRoutes = require('./routes/blockers');
const autoAssignRoutes = require('./routes/auto-assign');
const autoAssignEngine = require('./auto-assign-engine');
const metricsRoutes = require('./routes/metrics');
const { computeMetrics } = metricsRoutes;
const agentRoutes = require('./routes/agent');
const tokenRoutes = require('./routes/tokens');
const webhookRoutes = require('./routes/webhook');

const PORT = process.env.PORT || 3479;

// Load config
const configPath = path.join(__dirname, '..', 'config', 'sources.json');
if (!fs.existsSync(configPath)) {
  console.error('config/sources.json not found');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Init entity layer
const entity = require('./entity');
// Load from dedicated entities.json first (committed, non-sensitive)
const entitiesPath = path.join(__dirname, '..', 'config', 'entities.json');
if (fs.existsSync(entitiesPath)) {
  const entitiesConfig = JSON.parse(fs.readFileSync(entitiesPath, 'utf8'));
  entity.loadFromConfig(entitiesConfig.entities || []);
}
// sources.json entities override/extend (for local overrides)
if (config.entities) {
  entity.loadFromConfig(config.entities);
}

// Init fetchers
connectFetcher.init(config);
gitlabFetcher.init(config);

// Auto-assign engine initialized in startPolling() with ws reference

// Express app
const app = express();
const server = http.createServer(app);

// Body parsing (needed for webhook/report endpoints)
app.use(express.json({ limit: '1mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api/team', teamRoutes);
app.use('/api/board', boardRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/trends', trendsRoutes);
app.use('/api/my', myRoutes);
app.use('/api/blockers', blockersRoutes);
app.use('/api/auto-assign', autoAssignRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api', reportRoutes.router);

// GET /api/health — system health check (#48)
app.get('/api/health', (req, res) => {
  const agents = db.getAllAgents();
  const tasks = db.getAllTasks();
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    clients: ws.getClientCount(),
    timestamp: Date.now(),
    data: {
      agents_loaded: agents.length,
      tasks_loaded: tasks.length,
      events_in_store: db.getTimeline(1000).length,
      gitlab_sources: config.gitlab?.projects?.length || 0,
    },
  });
});

// Graph endpoint (supports ?project= filter)
app.get('/api/graph', (req, res) => {
  const graph = collab.getGraph();
  const project = req.query.project;
  if (project) {
    res.json(collab.getGraphByProject(project));
  } else {
    res.json(graph);
  }
});

// Projects endpoint
app.get('/api/projects', (req, res) => {
  res.json({ projects: db.getProjects() });
});

// Init report routes (needs ws + config)
reportRoutes.init(ws, config);

// Init webhook routes (needs ws + config for downstream notifications)
webhookRoutes.init(config, ws);

// Init WebSocket with snapshot provider (includes metrics for real-time updates #66)
ws.init(server, () => ({
  team: buildAgents(),
  board: buildBoard(),
  timeline: db.getTimeline(50),
  graph: collab.getGraph(),
  metrics: computeMetrics()
}));

// Data polling engine
let isPolling = false;

async function pollAll() {
  if (isPolling) return;
  isPolling = true;

  try {
    // Fetch from all sources
    const { agents, changes: agentChanges } = await connectFetcher.fetchAgents();
    const gitlabData = await gitlabFetcher.fetchAll();

    // Analyze collaboration
    const graph = collab.analyze();

    // Build full snapshot (includes metrics for real-time updates #66)
    const snapshot = {
      team: buildAgents(),
      board: buildBoard(),
      timeline: db.getTimeline(50),
      graph,
      metrics: computeMetrics()
    };

    // Always broadcast full snapshot after each poll cycle (#40)
    ws.broadcast('snapshot', snapshot);

    console.log(`[Poll] Agents: ${agents.length}, Issues: ${gitlabData.issues.length}, MRs: ${gitlabData.mrs.length}, Events: ${gitlabData.events.length}, Edges: ${graph.edges.length}`);
  } catch (err) {
    console.error('[Poll] Error:', err.message);
  } finally {
    isPolling = false;
  }
}

// Initial fetch + periodic polling
async function startPolling() {
  console.log('[Poll] Initial data fetch...');
  await pollAll();

  // Send snapshot to any early-connecting clients
  const snapshot = {
    team: buildAgents(),
    board: buildBoard(),
    timeline: db.getTimeline(50),
    graph: collab.getGraph(),
    metrics: computeMetrics()
  };
  ws.sendSnapshot(snapshot);

  // Start auto-assign engine (#61 + #74: pass ws for unassigned broadcasts)
  autoAssignEngine.init(config, ws);
  autoAssignEngine.start();

  // Connect polling (30s) — always broadcast so clients stay in sync (#40)
  setInterval(async () => {
    await connectFetcher.fetchAgents();
    ws.broadcast('team:update', buildAgents());
  }, config.polling?.connect_interval_ms || 30000);

  // GitLab polling (60s)
  setInterval(async () => {
    const data = await gitlabFetcher.fetchAll();
    const graph = collab.analyze();

    // Always broadcast all data channels so manual refresh button is never needed (#40)
    ws.broadcast('board:update', buildBoard());
    ws.broadcast('timeline:new', db.getTimeline(50));
    ws.broadcast('graph:update', graph);
    // Refresh metrics after GitLab data changes (#66)
    ws.broadcast('metrics:update', computeMetrics());
  }, config.polling?.gitlab_interval_ms || 60000);
}

// Start server
server.listen(PORT, () => {
  console.log(`[HxA Dash] Running on port ${PORT}`);
  startPolling();
});
