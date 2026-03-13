// Blocker Detection Component (#56)
// Displays stale issues, unreviewed MRs, and silent agents as alerts
const Blockers = {
  section: null,
  list: null,
  countEl: null,
  _data: [],

  init() {
    this.section = document.getElementById('blocker-section');
    this.list = document.getElementById('blocker-list');
    this.countEl = document.getElementById('blocker-count');
  },

  // Render blockers from API data or computed locally
  render(blockers) {
    this._data = blockers || [];
    if (!this.section || !this.list) return;

    if (this._data.length === 0) {
      this.section.classList.remove('hidden');
      this.section.classList.add('blocker-clear');
      this.list.innerHTML = '<div class="blocker-ok">✅ 团队运转正常</div>';
      this.countEl.textContent = '';
      return;
    }

    this.section.classList.remove('hidden', 'blocker-clear');
    this.countEl.textContent = `${this._data.length} 项`;

    // Sort: critical > warning > info
    const order = { critical: 0, warning: 1, info: 2 };
    this._data.sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9));

    this.list.innerHTML = this._data.map(b => {
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
        </div>`;
    }).join('');
  },

  // Compute blockers from existing data (tasks, agents, events)
  // Called when /api/blockers is not yet available (mock/fallback)
  computeFromData(agents, tasks, events) {
    const now = Date.now();
    const blockers = [];

    // 1. Stale issues: opened > 72h with no recent event
    const openIssues = tasks.filter(t => t.state === 'opened' && t.type === 'issue');
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
