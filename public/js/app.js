// HxA Dash — Main Application (v4: Mobile UX + skeleton + sort + keyboard shortcuts — #50)

// Progress bar controller (#43)
const Progress = {
  _el: null,
  _timer: null,

  _bar() {
    if (!this._el) this._el = document.getElementById('progress-bar');
    return this._el;
  },

  show() {
    const bar = this._bar();
    if (!bar) return;
    bar.style.transition = 'none';
    bar.style.width = '0%';
    bar.classList.add('active');
    requestAnimationFrame(() => {
      bar.style.transition = 'width .4s ease, opacity .3s ease';
      bar.style.width = '70%';
    });
  },

  done() {
    const bar = this._bar();
    if (!bar) return;
    bar.style.transition = 'width .2s ease, opacity .4s ease .15s';
    bar.style.width = '100%';
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      bar.classList.remove('active');
      bar.style.width = '0%';
    }, 600);
  }
};

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

// Scope manager (#100): multi connect-server × org management
const ScopeManager = {
  STORAGE_KEY: 'hxa-dash-scope',
  scopes: [],
  activeScope: null,

  async init() {
    try {
      const res = await fetch(`${BASE}/api/scopes`);
      if (!res.ok) return;
      const data = await res.json();
      this.scopes = data.scopes || [];

      // Restore last selection or use default
      const saved = localStorage.getItem(this.STORAGE_KEY);
      if (saved && this.scopes.some(s => s.id === saved)) {
        this.activeScope = saved;
      } else {
        this.activeScope = data.default || (this.scopes[0]?.id) || null;
      }

      this._renderSelector(data.servers || []);
    } catch (e) {
      console.error('[ScopeManager] Init error:', e);
    }
  },

  _renderSelector(servers) {
    const sel = document.getElementById('scope-selector');
    if (!sel) return;

    // Hide if single scope
    if (this.scopes.length <= 1) {
      sel.classList.add('hidden');
      return;
    }

    sel.innerHTML = '';
    // Group by server
    if (servers.length > 1) {
      for (const server of servers) {
        const group = document.createElement('optgroup');
        group.label = server.hub.replace(/^https?:\/\//, '').replace(/\/hub\/?$/, '');
        for (const org of server.orgs) {
          const opt = document.createElement('option');
          opt.value = org.id;
          opt.textContent = org.name;
          if (org.id === this.activeScope) opt.selected = true;
          group.appendChild(opt);
        }
        sel.appendChild(group);
      }
    } else {
      for (const s of this.scopes) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        if (s.id === this.activeScope) opt.selected = true;
        sel.appendChild(opt);
      }
    }

    sel.classList.remove('hidden');
    sel.addEventListener('change', () => {
      this.activeScope = sel.value;
      localStorage.setItem(this.STORAGE_KEY, this.activeScope);
      // Update agent filter with scoped agents, then re-render
      const scopedAgents = this.filter(App.data.team);
      AgentFilter.setAgents(scopedAgents);
      App.renderAllPages();
    });
  },

  filter(items) {
    if (!this.activeScope || this.scopes.length <= 1) return items;
    return items.filter(i => !i.scope || i.scope === this.activeScope);
  },

  filterBoard(board) {
    if (!this.activeScope || this.scopes.length <= 1) return board;
    const f = arr => (arr || []).filter(t => !t.scope || t.scope === this.activeScope);
    return { todo: f(board.todo), doing: f(board.doing), done: f(board.done) };
  },

  filterGraph(graph) {
    if (!this.activeScope || this.scopes.length <= 1) return graph;
    const nodes = (graph.nodes || []).filter(n => !n.scope || n.scope === this.activeScope);
    const nodeNames = new Set(nodes.map(n => n.name || n.id));
    const edges = (graph.edges || []).filter(e => nodeNames.has(e.source) && nodeNames.has(e.target));
    return { nodes, edges };
  }
};

// App state
const App = {
  ws: null,
  reconnectTimer: null,
  currentPage: 'overview',
  data: { team: [], board: {}, timeline: [], graph: { nodes: [], edges: [] }, projects: [] },
  selectedProject: '',  // '' = all projects

  // Graph instances for overview and collab pages
  overviewGraph: null,
  collabGraph: null,

  async init() {
    // Init scope manager (#100)
    await ScopeManager.init();

    // Init components
    AgentFilter.init();
    AgentFilter.initCollabButtons();
    CardWall.init();
    DetailDrawer.init();
    TaskBoard.init();
    Timeline.init();
    CollabMatrix.init();
    TrendsChart.init();
    Blockers.init();
    WorkloadReport.init();
    Suggestions.init();
    Metrics.init();
    MyView.init();
    TokenDashboard.init();
    LiveDashboard.init();
    Pipeline.init();
    TimeEstimates.init();
    HealthDiagnostics.init();
    Projects.init();

    // Workload report: sortable headers + export
    document.querySelectorAll('.workload-table thead .sortable').forEach(th => {
      th.addEventListener('click', () => WorkloadReport._sortBy(th.dataset.sort));
    });
    const exportBtn = document.getElementById('workload-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', () => WorkloadReport.exportJSON());

    // Weekly report export (#60)
    const weeklyExportBtn = document.getElementById('weekly-report-export-btn');
    if (weeklyExportBtn) weeklyExportBtn.addEventListener('click', () => WeeklyReport.export());

    // Init graphs
    const overviewCanvas = document.getElementById('overview-collab-canvas');
    const overviewEmpty = document.getElementById('overview-collab-empty');
    if (overviewCanvas) this.overviewGraph = new ForceGraph(overviewCanvas, overviewEmpty);

    const collabCanvas = document.getElementById('collab-canvas');
    const collabEmpty = document.getElementById('collab-empty');
    if (collabCanvas) this.collabGraph = new ForceGraph(collabCanvas, collabEmpty);

    // Router
    this.initRouter();

    // #50: Show skeleton cards while first fetch runs
    this.renderSkeletons('overview-agent-cards', 6);
    this.renderSkeletons('team-agent-cards', 6);

    // Initial REST fetch
    await this.fetchAll();

    // WebSocket connection
    this.connectWS();

    // Refresh button
    document.getElementById('refresh-btn').addEventListener('click', () => this.fetchAll());

    // Project filter
    const projectSelect = document.getElementById('collab-project-filter');
    if (projectSelect) {
      projectSelect.addEventListener('change', () => {
        this.selectedProject = projectSelect.value;
        this.fetchCollabGraph();
      });
    }

    // Resize handler for graphs
    window.addEventListener('resize', () => {
      if (this.overviewGraph) this.overviewGraph.resize();
      if (this.collabGraph) this.collabGraph.resize();
    });

    // #50: Sort dropdowns
    const overviewSort = document.getElementById('overview-sort');
    if (overviewSort) overviewSort.addEventListener('change', () => this.renderOverview());
    const teamSort = document.getElementById('team-sort');
    if (teamSort) teamSort.addEventListener('change', () => this.renderTeam());

    // #50: Hamburger mobile nav
    this.initMobileNav();

    // #50: Keyboard shortcuts
    this.initKeyboardShortcuts();

    // #50: Auto-refresh countdown (30s interval)
    this.initAutoRefresh();

    // #50: Show skeleton loading on initial load (already running fetchAll above)
    // Skeletons are shown by renderSkeletons() called before first fetchAll
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
    const validPages = ['overview', 'team', 'collab', 'tasks', 'timeline', 'report', 'tokens', 'estimates', 'live', 'pipeline', 'health', 'projects', 'myview', 'about'];
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

    // Lazy-load token data when first visiting tokens page
    if (page === 'tokens' && !TokenDashboard._data) TokenDashboard.fetch();
    // Lazy-load live dashboard (#95)
    if (page === 'live') LiveDashboard.fetch();
    // Lazy-load pipeline (#77)
    if (page === 'pipeline') Pipeline.fetch();
    // Lazy-load time estimates (#79)
    if (page === 'estimates') TimeEstimates.fetch();
    // Lazy-load health diagnostics (#94)
    if (page === 'health') HealthDiagnostics.fetch();
    if (page === 'projects' && !Projects.data) Projects.load();
    if (page === 'about') this.loadAbout();
  },

  // --- Data Fetching ---
  async fetchAll() {
    Progress.show();
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
        AgentFilter.setAgents(ScopeManager.filter(teamData.agents));
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

      // Fetch project list
      try {
        const projRes = await fetch(`${BASE}/api/projects`);
        if (projRes.ok) {
          const projData = await projRes.json();
          this.data.projects = projData.projects || [];
          this._populateProjectFilter();
        }
      } catch {}

      this.updateTimestamp();
      Progress.done();
      this.renderAllPages();
    } catch (err) {
      Progress.done();
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
    this.renderMyView();
  },

  renderCurrentPage() {
    switch (this.currentPage) {
      case 'overview': this.renderOverview(); break;
      case 'team': this.renderTeam(); break;
      case 'collab': this.renderCollab(); break;
      case 'tasks': this.renderTasks(); break;
      case 'timeline': this.renderTimeline(); break;
      case 'live': LiveDashboard.render(); break;
      case 'pipeline': Pipeline.render(); break;
      case 'myview': this.renderMyView(); break;
    }
  },

  renderOverview() {
    const filter = AgentFilter.getFilter('overview');
    const scopedTeam = ScopeManager.filter(this.data.team);
    const agents = filter
      ? scopedTeam.filter(a => filter.has(a.name))
      : scopedTeam;

    // Team Capacity (#45)
    TeamCapacity.render(agents);

    // Blocker Detection (#56)
    this._renderBlockers(agents);

    // Action Suggestions (#57)
    Suggestions.render(agents, this.data.board, this.data.timeline || []);

    // Cards — apply sort (#50)
    const sortedForOverview = this._applySortOrder(agents, document.getElementById('overview-sort')?.value || 'default');
    CardWall.renderTo('overview-agent-cards', 'overview-team-stats', sortedForOverview);

    // Board (filtered)
    const board = this._filterBoard('overview', this.data.board);
    TaskBoard.renderTo('overview', board);

    // Timeline (filtered — scope then agent)
    const scopedTimeline = ScopeManager.filter(this.data.timeline);
    const events = AgentFilter.filterItems('overview', scopedTimeline, 'agent');
    Timeline.renderTo('overview-timeline', events, 20);

    // Graph (filtered)
    const graphData = this._filterGraph('overview', this.data.graph);
    if (this.overviewGraph) this.overviewGraph.setData(graphData.nodes, graphData.edges);

  },

  renderTeam() {
    // Team page shows ALL agents (with search/status filter), scoped (#100)
    const search = (document.getElementById('team-search')?.value || '').toLowerCase();
    const statusFilter = document.getElementById('team-status-filter')?.value || 'all';

    let agents = ScopeManager.filter(this.data.team);
    if (search) {
      agents = agents.filter(a =>
        (a.name || '').toLowerCase().includes(search) ||
        (a.role || '').toLowerCase().includes(search) ||
        (a.bio || '').toLowerCase().includes(search)
      );
    }
    if (statusFilter === 'online') agents = agents.filter(a => a.online);
    if (statusFilter === 'offline') agents = agents.filter(a => !a.online);

    // Apply sort (#50)
    const sortVal = document.getElementById('team-sort')?.value || 'default';
    agents = this._applySortOrder(agents, sortVal);

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

    // Render matrix view
    CollabMatrix.render(graphData.nodes, graphData.edges);

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
  },

  renderTimeline() {
    const scopedTimeline = ScopeManager.filter(this.data.timeline);
    const events = AgentFilter.filterItems('timeline', scopedTimeline, 'agent');
    Timeline.renderTo('timeline', events, 100);

    const totalEl = document.getElementById('timeline-total');
    if (totalEl) totalEl.textContent = `共 ${events.length} 条`;

  },

  renderMyView() {
    MyView.populateAgents(this.data.team);
  },

  // --- Filter Helpers ---
  // Blocker detection — try API first, fallback to local computation (#56, #63, #68)
  async _renderBlockers(agents) {
    try {
      const res = await fetch(`${BASE}/api/blockers`);
      if (res.ok) {
        const data = await res.json();
        Blockers.render(data.blockers || [], data.thresholds);
        return;
      }
    } catch (_) { /* API not available, fallback */ }

    // Fallback: compute from local data
    const allTasks = [
      ...(this.data.board.todo || []),
      ...(this.data.board.doing || []),
      ...(this.data.board.done || [])
    ];
    const blockers = Blockers.computeFromData(agents, allTasks, this.data.timeline || []);
    Blockers.render(blockers);
  },

  _filterBoard(context, board) {
    // Apply scope filter first (#100), then agent filter
    const scoped = ScopeManager.filterBoard(board);
    const f = AgentFilter.getFilter(context);
    if (!f) return scoped;
    return {
      todo: (scoped.todo || []).filter(t => !t.assignee || f.has(t.assignee)),
      doing: (scoped.doing || []).filter(t => !t.assignee || f.has(t.assignee)),
      done: (scoped.done || []).filter(t => !t.assignee || f.has(t.assignee))
    };
  },

  _filterGraph(context, graph) {
    // Apply scope filter first (#100), then agent filter
    const scoped = ScopeManager.filterGraph(graph || { nodes: [], edges: [] });
    const f = AgentFilter.getFilter(context);
    if (!f) return scoped;
    const nodes = (scoped.nodes || []).filter(n => f.has(n.id));
    const nodeSet = new Set(nodes.map(n => n.id));
    const edges = (scoped.edges || []).filter(e => nodeSet.has(e.source) && nodeSet.has(e.target));
    return { nodes, edges };
  },

  // Project filter helpers
  _populateProjectFilter() {
    const select = document.getElementById('collab-project-filter');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">全部项目</option>' +
      this.data.projects.map(p => `<option value="${esc(p)}"${p === current ? ' selected' : ''}>${esc(p)}</option>`).join('');
  },

  async fetchCollabGraph() {
    try {
      const url = this.selectedProject
        ? `${BASE}/api/graph?project=${encodeURIComponent(this.selectedProject)}`
        : `${BASE}/api/graph`;
      const res = await fetch(url);
      if (res.ok) {
        this.data.graph = await res.json();
        this.renderCollab();
        this.renderOverview();
      }
    } catch (err) {
      console.error('Graph fetch error:', err);
    }
  },

  // Called by AgentFilter when global filter changes (#87)
  onGlobalFilterChange() {
    this.renderAllPages();
    Metrics.render();
  },

  // Legacy compat
  onFilterChange(_context) {
    this.onGlobalFilterChange();
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
          AgentFilter.setAgents(ScopeManager.filter(agents));
        }
        if (msg.data.board) this.data.board = msg.data.board;
        if (msg.data.timeline) this.data.timeline = msg.data.timeline;
        if (msg.data.graph) this.data.graph = msg.data.graph;
        if (msg.data.metrics) {
          Metrics.update(msg.data.metrics);
          Suggestions.updateMetrics(msg.data.metrics);
        }
        if (msg.data.projects) {
          Projects.update(msg.data.projects);
        }
        this.renderAllPages();
        break;

      case 'metrics:update':
        Metrics.update(msg.data);
        break;

      case 'team:update':
        if (Array.isArray(msg.data)) {
          this.data.team = msg.data;
          AgentFilter.setAgents(ScopeManager.filter(msg.data));
          this.renderOverview();
          this.renderTeam();
        }
        break;

      case 'board:update':
        this.data.board = msg.data;
        this.renderOverview();
        this.renderTasks();
        if (this.currentPage === 'myview') MyView.fetchAndRender();
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
    el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  },

  // --- #50: Skeleton loading screens ---
  renderSkeletons(containerId, count = 4) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = Array.from({ length: count }, () => `
      <div class="skeleton-card">
        <div class="skeleton-row">
          <div class="skeleton-line sk-h1" style="width:55%"></div>
          <div class="skeleton-line sk-tag" style="margin-left:auto;width:18%"></div>
        </div>
        <div class="skeleton-line sk-h2"></div>
        <div class="skeleton-line sk-h3"></div>
        <div class="skeleton-row" style="margin-top:4px">
          <div class="skeleton-line sk-tag" style="width:22%"></div>
          <div class="skeleton-line sk-tag" style="width:22%"></div>
          <div class="skeleton-line sk-tag" style="width:22%"></div>
        </div>
      </div>
    `).join('');
  },

  // --- #50: Sort helper ---
  _applySortOrder(agents, sortKey) {
    const arr = [...agents];
    switch (sortKey) {
      case 'health':
        // Descending health score; agents without score go last
        arr.sort((a, b) => {
          const ha = a.health_score ?? -1;
          const hb = b.health_score ?? -1;
          if (hb !== ha) return hb - ha;
          return (a.name || '').localeCompare(b.name || '');
        });
        break;
      case 'activity': {
        // Descending by latest_event timestamp, then online first
        const ts = ag => (ag.latest_event && ag.latest_event.ts) ? ag.latest_event.ts : 0;
        arr.sort((a, b) => {
          const diff = ts(b) - ts(a);
          if (diff !== 0) return diff;
          return (a.name || '').localeCompare(b.name || '');
        });
        break;
      }
      case 'name':
        arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        break;
      default:
        // Default: online first, then by name (CardWall's own sort)
        break;
    }
    return arr;
  },

  // --- #50: Hamburger mobile nav ---
  initMobileNav() {
    const hamburger = document.getElementById('nav-hamburger');
    const closeBtn  = document.getElementById('nav-close-btn');
    if (!hamburger) return;

    const open = () => {
      document.body.classList.add('nav-mobile-open');
      hamburger.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      document.body.classList.remove('nav-mobile-open');
      hamburger.setAttribute('aria-expanded', 'false');
    };

    hamburger.addEventListener('click', open);
    closeBtn && closeBtn.addEventListener('click', close);

    // Close nav when a nav item is tapped on mobile
    document.getElementById('main-nav')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('nav-item')) close();
    });
  },

  // --- #50: Keyboard shortcuts ---
  initKeyboardShortcuts() {
    this._kbdIndex = -1; // current focused card index in active card list

    document.addEventListener('keydown', (e) => {
      // Ignore when typing in inputs
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      // Ignore if a modifier key is held
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'r':
        case 'R':
          e.preventDefault();
          this.fetchAll();
          break;
        case 'j':
        case 'J':
          e.preventDefault();
          this._kbdNavigate(1);
          break;
        case 'k':
        case 'K':
          e.preventDefault();
          this._kbdNavigate(-1);
          break;
        case 'Escape':
          this._kbdClearFocus();
          break;
      }
    });
  },

  _kbdNavigate(direction) {
    // Get visible cards on the current page
    const page = document.querySelector('.page.active');
    if (!page) return;
    const cards = Array.from(page.querySelectorAll('.agent-card'));
    if (!cards.length) return;

    // Remove previous focus
    cards.forEach(c => c.classList.remove('kbd-focused'));

    this._kbdIndex = Math.max(0, Math.min(cards.length - 1, (this._kbdIndex + direction + cards.length) % cards.length));

    const card = cards[this._kbdIndex];
    card.classList.add('kbd-focused');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  _kbdClearFocus() {
    document.querySelectorAll('.agent-card.kbd-focused').forEach(c => c.classList.remove('kbd-focused'));
    this._kbdIndex = -1;
  },

  // --- #50: Auto-refresh countdown (30s) ---
  // --- #108: About page ---
  async loadAbout() {
    try {
      const res = await fetch(`${BASE}/api/about`);
      if (!res.ok) return;
      const info = await res.json();
      const el = (id) => document.getElementById(id);
      if (el('about-version')) el('about-version').textContent = info.version || '-';
      if (el('about-uptime')) el('about-uptime').textContent = info.uptime || '-';
      if (el('about-node')) el('about-node').textContent = info.node || '-';
      if (el('about-scopes')) el('about-scopes').textContent = info.scopes || '-';
    } catch { /* ignore */ }
  },

  // --- #50: Auto-refresh countdown (30s) ---
  initAutoRefresh() {
    const INTERVAL = 30; // seconds
    let remaining = INTERVAL;
    const el = document.getElementById('refresh-countdown');
    const statusEl = document.getElementById('refresh-status');

    const tick = () => {
      if (!el) return;
      if (remaining <= 0) {
        el.textContent = '刷新中…';
        if (statusEl) statusEl.classList.add('refreshing');
        this.fetchAll().finally(() => {
          remaining = INTERVAL;
          if (statusEl) statusEl.classList.remove('refreshing');
        });
      } else {
        el.textContent = `${remaining}s`;
        if (statusEl) statusEl.classList.remove('refreshing');
        remaining--;
      }
    };

    tick();
    this._autoRefreshTimer = setInterval(tick, 1000);

    // Reset countdown whenever manual refresh fires
    const origFetch = this.fetchAll.bind(this);
    this.fetchAll = (...args) => {
      remaining = INTERVAL;
      if (el) el.textContent = '刷新中…';
      if (statusEl) statusEl.classList.add('refreshing');
      return origFetch(...args).finally(() => {
        if (statusEl) statusEl.classList.remove('refreshing');
      });
    };
  }
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
