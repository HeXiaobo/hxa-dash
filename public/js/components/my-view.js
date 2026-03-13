// My View Component (#55, #73) — Personal TODO + pending reviews panel
const MyView = {
  _selectedAgent: localStorage.getItem('myview-agent') || '',
  _data: null,
  _loading: false,
  _agentMap: new Map(), // name -> agent info (including kind)

  init() {
    const select = document.getElementById('myview-agent-select');
    if (select) {
      select.addEventListener('change', () => {
        this._selectedAgent = select.value;
        localStorage.setItem('myview-agent', this._selectedAgent);
        this.fetchAndRender();
      });
    }
  },

  populateAgents(agents) {
    const select = document.getElementById('myview-agent-select');
    if (!select) return;

    // Cache agent info for kind lookup
    this._agentMap.clear();
    agents.forEach(a => this._agentMap.set(a.name, a));

    const saved = this._selectedAgent;
    const validNames = new Set(agents.map(a => a.name));

    // Group by kind: humans first, then agents (#73)
    const humans = agents.filter(a => a.kind === 'human');
    const bots = agents.filter(a => a.kind !== 'human');

    let options = '<option value="">选择身份…</option>';
    if (humans.length > 0) {
      options += '<optgroup label="Human">' +
        humans.map(a =>
          `<option value="${esc(a.name)}"${a.name === saved ? ' selected' : ''}>${esc(a.name)} (${esc(a.role || 'human')})</option>`
        ).join('') + '</optgroup>';
    }
    if (bots.length > 0) {
      options += '<optgroup label="Agent">' +
        bots.map(a =>
          `<option value="${esc(a.name)}"${a.name === saved ? ' selected' : ''}>${esc(a.name)}${a.online ? '' : ' (离线)'}</option>`
        ).join('') + '</optgroup>';
    }
    select.innerHTML = options;

    // Restore saved selection if still valid
    if (saved && validNames.has(saved)) {
      select.value = saved;
      this.fetchAndRender();
    } else {
      this._selectedAgent = '';
      this._data = null;
      this.render();
    }
  },

  async fetchAndRender() {
    const name = this._selectedAgent;
    if (!name) {
      this._data = null;
      this.render();
      return;
    }

    this._loading = true;
    this.render();

    try {
      const res = await fetch(`${BASE}/api/my/${encodeURIComponent(name)}`);
      if (res.ok) {
        this._data = await res.json();
      } else {
        this._data = null;
      }
    } catch {
      this._data = null;
    }

    this._loading = false;
    this.render();
  },

  render() {
    const container = document.getElementById('myview-content');
    if (!container) return;

    if (!this._selectedAgent) {
      container.innerHTML = '<div class="empty-state">请在上方选择身份查看个人面板</div>';
      return;
    }

    if (this._loading) {
      container.innerHTML = '<div class="empty-state">加载中…</div>';
      return;
    }

    if (!this._data) {
      container.innerHTML = '<div class="empty-state">无法加载数据</div>';
      return;
    }

    const { agent, todos, pending_reviews, active_projects, blockers } = this._data;

    container.innerHTML = `
      ${this._renderAgentHeader(agent)}
      <div class="myview-grid">
        <div class="myview-panel">
          <div class="myview-panel-header">
            <h3>我的 TODO</h3>
            <span class="myview-badge">${todos.length}</span>
          </div>
          ${this._renderTodoList(todos)}
        </div>
        <div class="myview-panel">
          <div class="myview-panel-header">
            <h3>待我 Review</h3>
            <span class="myview-badge">${pending_reviews.length}</span>
          </div>
          ${this._renderReviewList(pending_reviews)}
        </div>
      </div>
      <div class="myview-grid">
        <div class="myview-panel">
          <div class="myview-panel-header">
            <h3>活跃项目</h3>
            <span class="myview-badge">${active_projects.length}</span>
          </div>
          ${this._renderProjects(active_projects)}
        </div>
        <div class="myview-panel">
          <div class="myview-panel-header">
            <h3>相关卡点</h3>
            <span class="myview-badge${blockers.length > 0 ? ' myview-badge-warn' : ''}">${blockers.length}</span>
          </div>
          ${this._renderBlockers(blockers)}
        </div>
      </div>
    `;
  },

  _renderAgentHeader(agent) {
    const cached = this._agentMap.get(agent.name);
    const isHuman = cached && cached.kind === 'human';
    const kindBadge = isHuman ? '<span class="kind-badge human">Human</span>' : '<span class="kind-badge agent">Agent</span>';

    if (isHuman) {
      // Humans don't have online/offline status — show role instead
      return `
        <div class="myview-header">
          ${kindBadge}
          <span class="myview-name">${esc(agent.name)}</span>
          <span class="myview-role">${esc(agent.role || '')}</span>
        </div>
      `;
    }

    const statusClass = agent.online ? 'online' : 'offline';
    const statusText = agent.online ? '在线' : '离线';
    return `
      <div class="myview-header">
        ${kindBadge}
        <span class="online-dot ${statusClass}"></span>
        <span class="myview-name">${esc(agent.name)}</span>
        <span class="myview-role">${esc(agent.role || '')}</span>
        <span class="status-badge ${statusClass === 'online' ? 'connected' : 'disconnected'}">${statusText}</span>
      </div>
    `;
  },

  _renderTodoList(todos) {
    if (todos.length === 0) return '<div class="myview-empty">没有待办任务</div>';
    return `<div class="myview-list">${todos.map(t => `
      <div class="myview-item">
        <a href="${esc(t.url)}" target="_blank" class="myview-item-title">${esc(truncate(t.title, 70))}</a>
        <div class="myview-item-meta">
          <span class="myview-project">${esc(t.project)}</span>
          ${t.created_at ? `<span>${timeAgo(t.created_at)}</span>` : ''}
        </div>
      </div>
    `).join('')}</div>`;
  },

  _renderReviewList(reviews) {
    if (reviews.length === 0) return '<div class="myview-empty">没有待 review 的 MR</div>';
    return `<div class="myview-list">${reviews.map(r => `
      <div class="myview-item myview-item-review">
        <a href="${esc(r.url)}" target="_blank" class="myview-item-title">${esc(truncate(r.title, 70))}</a>
        <div class="myview-item-meta">
          <span class="myview-project">${esc(r.project)}</span>
          ${r.created_at ? `<span>${timeAgo(r.created_at)}</span>` : ''}
        </div>
      </div>
    `).join('')}</div>`;
  },

  _renderProjects(projects) {
    if (projects.length === 0) return '<div class="myview-empty">没有活跃项目</div>';
    return `<div class="myview-projects">${projects.map(p =>
      `<span class="project-badge">${esc(p)}</span>`
    ).join('')}</div>`;
  },

  _renderBlockers(blockers) {
    if (blockers.length === 0) return '<div class="myview-empty myview-ok">无卡点</div>';
    return `<div class="myview-list">${blockers.map(b => `
      <div class="myview-item myview-item-blocker">
        <a href="${esc(b.url)}" target="_blank" class="myview-item-title">${esc(truncate(b.title, 70))}</a>
        <div class="myview-item-meta">
          <span class="myview-stale">${b.stale_hours}h 无更新</span>
          <span>${esc(b.type)}</span>
        </div>
      </div>
    `).join('')}</div>`;
  }
};
