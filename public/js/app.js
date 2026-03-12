// HxA Dash — Main Application (v2: Multi-page + Agent Filtering)

// Base path detection (works behind reverse proxy with path stripping)
const BASE = (() => {
  const path = location.pathname.replace(/\/$/, '');
  return path.includes('/hxa-dash') ? '/hxa-dash' : '';
})();

// Utility functions (used by components)
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return Math.floor(diff / 86400000) + '天前';
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// App state
const App = {
  ws: null,
  reconnectTimer: null,
  currentPage: 'overview',
  data: { team: [], board: {}, timeline: [], graph: { nodes: [], edges: [] } },

  // Graph instances for overview and collab pages
  overviewGraph: null,
  collabGraph: null,

  async init() {
    // Init components
    AgentFilter.init();
    AgentFilter.initCollabButtons();
    CardWall.init();
    DetailDrawer.init();
    TaskBoard.init();
    Timeline.init();

    // Init graphs
    const overviewCanvas = document.getElementById('overview-collab-canvas');
    const overviewEmpty = document.getElementById('overview-collab-empty');
    if (overviewCanvas) this.overviewGraph = new ForceGraph(overviewCanvas, overviewEmpty);

    const collabCanvas = document.getElementById('collab-canvas');
    const collabEmpty = document.getElementById('collab-empty');
    if (collabCanvas) this.collabGraph = new ForceGraph(collabCanvas, collabEmpty);

    // Router
    this.initRouter();

    // Initial REST fetch
    await this.fetchAll();

    // WebSocket connection
    this.connectWS();

    // Refresh button
    document.getElementById('refresh-btn').addEventListener('click', () => this.fetchAll());

    // Resize handler for graphs
    window.addEventListener('resize', () => {
      if (this.overviewGraph) this.overviewGraph.resize();
      if (this.collabGraph) this.collabGraph.resize();
    });
  },

  // --- Router ---
  initRouter() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        this.navigateTo(page);
      });
    });

    // Handle initial hash
    const hash = location.hash.replace('#', '') || 'overview';
    this.navigateTo(hash, false);
  },

  navigateTo(page, pushState = true) {
    const validPages = ['overview', 'team', 'collab', 'tasks', 'timeline'];
    if (!validPages.includes(page)) page = 'overview';

    // Update nav
    document.querySelectorAll('.nav-item').forEach(n => {
      n.classList.toggle('active', n.dataset.page === page);
    });

    // Update pages
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === `page-${page}`);
    });

    this.currentPage = page;
    if (pushState) location.hash = page;

    // Resize graphs when their page becomes visible
    requestAnimationFrame(() => {
      if (page === 'overview' && this.overviewGraph) this.overviewGraph.resize();
      if (page === 'collab' && this.collabGraph) this.collabGraph.resize();
    });

    // Re-render current page with filters
    this.renderCurrentPage();
  },

  // --- Data Fetching ---
  async fetchAll() {
    try {
      const [teamRes, boardRes, timelineRes, graphRes] = await Promise.all([
        fetch(`${BASE}/api/team`),
        fetch(`${BASE}/api/board`),
        fetch(`${BASE}/api/timeline`),
        fetch(`${BASE}/api/graph`)
      ]);

      if (teamRes.ok) {
        const teamData = await teamRes.json();
        this.data.team = teamData.agents;
        AgentFilter.setAgents(teamData.agents);
      }

      if (boardRes.ok) {
        this.data.board = await boardRes.json();
      }

      if (timelineRes.ok) {
        const tlData = await timelineRes.json();
        this.data.timeline = tlData.events;
      }

      if (graphRes.ok) {
        this.data.graph = await graphRes.json();
      }

      this.updateTimestamp();
      this.renderAllPages();
    } catch (err) {
      console.error('Fetch error:', err);
    }
  },

  // --- Rendering ---
  renderAllPages() {
    this.renderOverview();
    this.renderTeam();
    this.renderCollab();
    this.renderTasks();
    this.renderTimeline();
  },

  renderCurrentPage() {
    switch (this.currentPage) {
      case 'overview': this.renderOverview(); break;
      case 'team': this.renderTeam(); break;
      case 'collab': this.renderCollab(); break;
      case 'tasks': this.renderTasks(); break;
      case 'timeline': this.renderTimeline(); break;
    }
  },

  renderOverview() {
    const filter = AgentFilter.getFilter('overview');
    const agents = filter
      ? this.data.team.filter(a => filter.has(a.name))
      : this.data.team;

    // Cards
    CardWall.renderTo('overview-agent-cards', 'overview-team-stats', agents);

    // Board (filtered)
    const board = this._filterBoard('overview', this.data.board);
    TaskBoard.renderTo('overview', board);

    // Timeline (filtered)
    const events = AgentFilter.filterItems('overview', this.data.timeline, 'agent');
    Timeline.renderTo('overview-timeline', events, 20);

    // Graph (filtered)
    const graphData = this._filterGraph('overview', this.data.graph);
    if (this.overviewGraph) this.overviewGraph.setData(graphData.nodes, graphData.edges);

    AgentFilter.updateCountDisplay('overview');
  },

  renderTeam() {
    // Team page shows ALL agents (with search/status filter)
    const search = (document.getElementById('team-search')?.value || '').toLowerCase();
    const statusFilter = document.getElementById('team-status-filter')?.value || 'all';

    let agents = this.data.team;
    if (search) {
      agents = agents.filter(a =>
        (a.name || '').toLowerCase().includes(search) ||
        (a.role || '').toLowerCase().includes(search) ||
        (a.bio || '').toLowerCase().includes(search)
      );
    }
    if (statusFilter === 'online') agents = agents.filter(a => a.online);
    if (statusFilter === 'offline') agents = agents.filter(a => !a.online);

    CardWall.renderTo('team-agent-cards', 'team-stats', agents);

    // Attach search handlers (once)
    if (!this._teamSearchBound) {
      this._teamSearchBound = true;
      document.getElementById('team-search')?.addEventListener('input', () => this.renderTeam());
      document.getElementById('team-status-filter')?.addEventListener('change', () => this.renderTeam());
    }
  },

  renderCollab() {
    const graphData = this._filterGraph('collab', this.data.graph);
    if (this.collabGraph) this.collabGraph.setData(graphData.nodes, graphData.edges);

    const edgeCountEl = document.getElementById('collab-edge-count');
    if (edgeCountEl) {
      edgeCountEl.textContent = `${graphData.nodes.length} Agent · ${graphData.edges.length} 协作关系`;
    }
  },

  renderTasks() {
    const board = this._filterBoard('tasks', this.data.board);
    TaskBoard.renderTo('tasks', board);

    const totalEl = document.getElementById('tasks-total');
    if (totalEl) {
      const total = (board.todo?.length || 0) + (board.doing?.length || 0) + (board.done?.length || 0);
      totalEl.textContent = `共 ${total} 项`;
    }
    AgentFilter.updateCountDisplay('tasks');
  },

  renderTimeline() {
    const events = AgentFilter.filterItems('timeline', this.data.timeline, 'agent');
    Timeline.renderTo('timeline', events, 100);

    const totalEl = document.getElementById('timeline-total');
    if (totalEl) totalEl.textContent = `共 ${events.length} 条`;

    AgentFilter.updateCountDisplay('timeline');
  },

  // --- Filter Helpers ---
  _filterBoard(context, board) {
    const f = AgentFilter.getFilter(context);
    if (!f) return board;
    return {
      todo: (board.todo || []).filter(t => !t.assignee || f.has(t.assignee)),
      doing: (board.doing || []).filter(t => !t.assignee || f.has(t.assignee)),
      done: (board.done || []).filter(t => !t.assignee || f.has(t.assignee))
    };
  },

  _filterGraph(context, graph) {
    const f = AgentFilter.getFilter(context);
    if (!f || !graph) return graph || { nodes: [], edges: [] };
    const nodes = (graph.nodes || []).filter(n => f.has(n.id));
    const nodeSet = new Set(nodes.map(n => n.id));
    const edges = (graph.edges || []).filter(e => nodeSet.has(e.source) && nodeSet.has(e.target));
    return { nodes, edges };
  },

  // Called by AgentFilter when filter changes
  onFilterChange(context) {
    switch (context) {
      case 'overview': this.renderOverview(); break;
      case 'collab': this.renderCollab(); break;
      case 'tasks': this.renderTasks(); break;
      case 'timeline': this.renderTimeline(); break;
    }
  },

  // --- WebSocket ---
  connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}${BASE}/ws`;

    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.setStatus('connected');
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (e) {
          console.error('WS parse error:', e);
        }
      };

      this.ws.onclose = () => {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.setStatus('disconnected');
      };
    } catch (err) {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  },

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWS();
    }, 5000);
  },

  handleMessage(msg) {
    this.updateTimestamp();

    switch (msg.type) {
      case 'snapshot':
        if (msg.data.team) {
          const agents = Array.isArray(msg.data.team) ? msg.data.team : [];
          this.data.team = agents;
          AgentFilter.setAgents(agents);
        }
        if (msg.data.board) this.data.board = msg.data.board;
        if (msg.data.timeline) this.data.timeline = msg.data.timeline;
        if (msg.data.graph) this.data.graph = msg.data.graph;
        this.renderAllPages();
        break;

      case 'team:update':
        if (Array.isArray(msg.data)) {
          this.data.team = msg.data;
          AgentFilter.setAgents(msg.data);
          this.renderOverview();
          this.renderTeam();
        }
        break;

      case 'board:update':
        this.data.board = msg.data;
        this.renderOverview();
        this.renderTasks();
        break;

      case 'timeline:new':
        if (Array.isArray(msg.data)) {
          this.data.timeline = msg.data;
          this.renderOverview();
          this.renderTimeline();
        }
        break;

      case 'graph:update':
        this.data.graph = msg.data;
        this.renderOverview();
        this.renderCollab();
        break;
    }
  },

  setStatus(status) {
    const el = document.getElementById('ws-status');
    el.className = `status-badge ${status}`;
    const labels = { connected: '已连接', disconnected: '断开', connecting: '连接中…' };
    el.textContent = labels[status] || status;
  },

  updateTimestamp() {
    const el = document.getElementById('last-update');
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    el.textContent = `最后更新: ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
