// Blocker Detection Component (#56, #63, #68, #71)
// Displays stale issues, unreviewed MRs, and silent agents as alerts
const Blockers = {
  section: null,
  list: null,
  countEl: null,
  defEl: null,
  _data: [],
  _collapsed: false,
  _dismissed: new Set(),
  _STORAGE_KEY: 'hxa-dash-dismissed-blockers',

  init() {
    this.section = document.getElementById('blocker-section');
    this.list = document.getElementById('blocker-list');
    this.countEl = document.getElementById('blocker-count');
    this.defEl = document.getElementById('blocker-definitions');
    this._loadDismissed();
    // Toggle collapse on header click
    const header = this.section && this.section.querySelector('.section-header');
    if (header) {
      header.style.cursor = 'pointer';
      header.addEventListener('click', () => this._toggle());
    }
  },

  _blockerKey(b) {
    return `${b.type}::${b.title}`;
  },

  _loadDismissed() {
    try {
      const raw = localStorage.getItem(this._STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        this._dismissed = new Set(arr);
      }
    } catch (_) { /* ignore */ }
  },

  _saveDismissed() {
    try {
      localStorage.setItem(this._STORAGE_KEY, JSON.stringify([...this._dismissed]));
    } catch (_) { /* ignore */ }
  },

  dismiss(key) {
    this._dismissed.add(key);
    this._saveDismissed();
    this.render(this._data, this._thresholds);
  },

  resetDismissed() {
    this._dismissed.clear();
    this._saveDismissed();
    this.render(this._data, this._thresholds);
  },

  _toggle() {
    this._collapsed = !this._collapsed;
    if (this.list) this.list.classList.toggle('hidden', this._collapsed);
    if (this.defEl) this.defEl.classList.toggle('hidden', this._collapsed);
    const arrow = this.section && this.section.querySelector('.blocker-toggle');
    if (arrow) arrow.textContent = this._collapsed ? '▸' : '▾';
  },

  // Render blockers from API data or computed locally
  render(blockers, thresholds) {
    if (blockers) this._data = blockers;
    this._thresholds = thresholds;
    if (!this.section || !this.list) return;

    // Update definitions tooltip with thresholds
    if (this.defEl) {
      const t = thresholds || { stale_issue_hours: 72, unreviewed_mr_hours: 24, idle_agent_hours: 4 };
      this.defEl.innerHTML =
        `<span>🔴 Issue 超过 ${t.stale_issue_hours}h 无更新</span>` +
        `<span>🟡 MR 开启超过 ${t.unreviewed_mr_hours}h 未 review</span>` +
        `<span>⚫ Agent 离线超过 ${t.idle_agent_hours}h</span>`;
    }

    // Filter out dismissed blockers
    const visible = this._data.filter(b => !this._dismissed.has(this._blockerKey(b)));
    const dismissedCount = this._data.length - visible.length;

    if (visible.length === 0) {
      this.section.classList.remove('hidden');
      this.section.classList.add('blocker-clear');
      this.list.innerHTML = dismissedCount > 0
        ? `<div class="blocker-dismissed-hint">${dismissedCount} 项已关闭 · <a href="#" onclick="Blockers.resetDismissed();return false">全部恢复</a></div>`
        : '';
      this.countEl.textContent = dismissedCount > 0 ? `${dismissedCount} 项已关闭` : '无卡点';
      // Auto-collapse when no visible blockers (#68)
      if (!this._collapsed) this._toggle();
      return;
    }

    this.section.classList.remove('hidden', 'blocker-clear');
    this.countEl.textContent = `${visible.length} 项` + (dismissedCount > 0 ? ` (${dismissedCount} 已关闭)` : '');
    // Auto-expand when there are blockers
    if (this._collapsed) this._toggle();

    // Sort: critical > warning > info
    const order = { critical: 0, warning: 1, info: 2 };
    visible.sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9));

    this.list.innerHTML = visible.map(b => {
      const key = this._blockerKey(b);
      const icon = b.severity === 'critical' ? '🔴'
        : b.severity === 'warning' ? '🟡' : '⚫';
      const timeStr = b.stale_hours ? `${Math.round(b.stale_hours)}h` : '';
      const link = b.url
        ? `<a href="${esc(b.url)}" target="_blank" class="blocker-link">${esc(b.title)}</a>`
        : `<span>${esc(b.title)}</span>`;
      return `
        <div class="blocker-item blocker-${esc(b.severity)}">
          <span class="blocker-icon">${icon}</span>
          <div class="blocker-body">
            <div class="blocker-title">${link}</div>
            <div class="blocker-meta">
              ${b.assignee ? `<span class="blocker-assignee">${esc(b.assignee)}</span>` : ''}
              ${b.project ? `<span class="blocker-project">${esc(b.project)}</span>` : ''}
              ${timeStr ? `<span class="blocker-time">${timeStr} 无活动</span>` : ''}
              <span class="blocker-type">${esc(b.type_label || b.type || '')}</span>
            </div>
          </div>
          <button class="blocker-dismiss" onclick="Blockers.dismiss('${esc(key)}')" title="关闭此告警">✕</button>
        </div>`;
    }).join('')
    + (dismissedCount > 0 ? `<div class="blocker-dismissed-hint">${dismissedCount} 项已关闭 · <a href="#" onclick="Blockers.resetDismissed();return false">全部恢复</a></div>` : '');
  },

  // Compute blockers from existing data (tasks, agents, events)
  // Called when /api/blockers is not yet available (mock/fallback)
  computeFromData(agents, tasks, events) {
    const now = Date.now();
    const blockers = [];

    // 1. Stale issues: opened > 72h with no recent event (exclude ClawMark feedback)
    const openIssues = tasks.filter(t => t.state === 'opened' && t.type === 'issue' && !(t.title && t.title.startsWith('[ClawMark]')));
    for (const issue of openIssues) {
      const lastActivity = this._lastEventFor(events, issue.title) || issue.updated_at || issue.created_at;
      const hoursStale = (now - lastActivity) / (1000 * 60 * 60);
      if (hoursStale > 72) {
        blockers.push({
          severity: 'critical',
          type: 'stale_issue',
          type_label: '停滞 Issue',
          title: issue.title,
          url: issue.url || null,
          assignee: issue.assignee || null,
          project: issue.project || null,
          stale_hours: hoursStale
        });
      }
    }

    // 2. Unreviewed MRs: opened > 24h
    const openMRs = tasks.filter(t => t.state === 'opened' && t.type === 'mr');
    for (const mr of openMRs) {
      const age = (now - (mr.created_at || mr.updated_at)) / (1000 * 60 * 60);
      if (age > 24) {
        blockers.push({
          severity: 'warning',
          type: 'unreviewed_mr',
          type_label: '无人 Review MR',
          title: mr.title,
          url: mr.url || null,
          assignee: mr.assignee || null,
          project: mr.project || null,
          stale_hours: age
        });
      }
    }

    // 3. Silent agents: online but no events in 4h
    for (const agent of agents) {
      if (!agent.online) continue;
      const agentEvents = events.filter(e => e.agent === agent.name);
      const latest = agentEvents[0]; // events sorted desc
      if (!latest || (now - latest.timestamp) > 4 * 60 * 60 * 1000) {
        const hours = latest ? (now - latest.timestamp) / (1000 * 60 * 60) : null;
        blockers.push({
          severity: 'info',
          type: 'silent_agent',
          type_label: '失联 Agent',
          title: agent.name,
          assignee: agent.name,
          project: null,
          url: null,
          stale_hours: hours
        });
      }
    }

    return blockers;
  },

  _lastEventFor(events, title) {
    const match = events.find(e => e.target_title && e.target_title.includes(title));
    return match ? match.timestamp : null;
  }
};
