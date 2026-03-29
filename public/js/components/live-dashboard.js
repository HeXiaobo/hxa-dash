// Live Dashboard — Agent real-time work view (#95)
const LiveDashboard = {
  _data: null,
  _fingerprints: {},

  init() {
    // Nothing to bind at init — lazy-loaded on navigate
  },

  async fetch() {
    try {
      const res = await fetch(`${BASE}/api/live`);
      if (!res.ok) return;
      const data = await res.json();
      this._data = data;
      this.render();
    } catch (err) {
      console.error('[LiveDashboard] fetch error:', err);
    }
  },

  render() {
    if (!this._data) return;
    this._renderSummary(this._data.summary);
    this._renderAgents(this._data.agents);
  },

  update(data) {
    if (data) this._data = data;
    this.render();
  },

  _renderSummary(summary) {
    const el = document.getElementById('live-summary');
    if (!el || !summary) return;

    const fp = JSON.stringify(summary);
    if (this._fingerprints._summary === fp) return;
    this._fingerprints._summary = fp;

    const tier = summary.tier || {};
    el.innerHTML = `
      <div class="live-stat live-stat-active" title="GitLab 30min 内有活动">
        <span class="live-stat-num">${tier.active || 0}</span>
        <span class="live-stat-label">🟢 活跃</span>
      </div>
      <div class="live-stat live-stat-online" title="在线但无近期 GitLab 活动">
        <span class="live-stat-num">${tier.online || 0}</span>
        <span class="live-stat-label">🟡 在线</span>
      </div>
      <div class="live-stat live-stat-offline" title="离线">
        <span class="live-stat-num">${tier.offline || 0}</span>
        <span class="live-stat-label">⚫ 离线</span>
      </div>
      <div class="live-stat">
        <span class="live-stat-num">${summary.total}</span>
        <span class="live-stat-label">Total</span>
      </div>
    `;
  },

  _renderAgents(agents) {
    const container = document.getElementById('live-content');
    if (!container || !agents) return;

    // Build a map of existing rows for incremental update
    const existingRows = {};
    container.querySelectorAll('.live-agent-row').forEach(row => {
      existingRows[row.dataset.agent] = row;
    });

    const seen = new Set();
    agents.forEach(agent => {
      seen.add(agent.name);
      const fp = this._fingerprint(agent);
      if (this._fingerprints[agent.name] === fp && existingRows[agent.name]) return;
      this._fingerprints[agent.name] = fp;

      const html = this._agentRowHTML(agent);
      if (existingRows[agent.name]) {
        existingRows[agent.name].outerHTML = html;
      } else {
        container.insertAdjacentHTML('beforeend', html);
      }
    });

    // Remove agents no longer in data
    container.querySelectorAll('.live-agent-row').forEach(row => {
      if (!seen.has(row.dataset.agent)) {
        row.remove();
        delete this._fingerprints[row.dataset.agent];
      }
    });
  },

  _agentRowHTML(agent) {
    const statusClass = `live-status-${agent.effectiveStatus}`;
    // 3-tier status (#136) takes precedence for display label
    const tierStatus = agent.tierStatus || (agent.online ? 'online' : 'offline');
    const tierLabels = { active: '🟢 活跃', online: '🟡 在线', offline: '⚫ 离线' };
    const statusLabel = tierLabels[tierStatus] || tierLabels.offline;

    const tasksHTML = agent.currentTasks.length
      ? agent.currentTasks.map(t => {
          const badge = t.type === 'merge_request' ? '<span class="live-badge-mr">MR</span>' : '<span class="live-badge-issue">Issue</span>';
          const link = t.url ? `<a href="${esc(t.url)}" target="_blank" class="live-task-link">${badge} ${esc(truncate(t.title, 50))}</a>` : `${badge} ${esc(truncate(t.title, 50))}`;
          return `<div class="live-task-item">${link} <span class="live-task-project">${esc(t.project)}</span></div>`;
        }).join('')
      : '<span class="live-no-tasks">No open tasks</span>';

    const eventsHTML = agent.recentEvents.length
      ? agent.recentEvents.slice(0, 4).map(e => {
          return `<div class="live-event-item"><span class="live-event-action">${esc(e.action)}</span> ${esc(truncate(e.targetTitle, 40))} <span class="live-event-time">${timeAgo(e.timestamp)}</span></div>`;
        }).join('')
      : '';

    const activityBar = this._activityBar(agent.activityIntensity);
    const lastActive = agent.lastActiveMs !== null ? timeAgo(Date.now() - agent.lastActiveMs) : '';
    const healthBadge = agent.healthScore !== null ? `<span class="live-health">${agent.healthScore}</span>` : '';

    return `<div class="live-agent-row ${statusClass}" data-agent="${esc(agent.name)}">
      <div class="live-agent-header">
        <span class="live-agent-name">${esc(agent.displayName)}</span>
        <span class="live-agent-role">${esc(agent.role)}</span>
        ${healthBadge}
        <span class="live-agent-status">${statusLabel}</span>
      </div>
      <div class="live-agent-body">
        <div class="live-agent-tasks">
          <div class="live-section-label">Current Work</div>
          ${tasksHTML}
        </div>
        <div class="live-agent-activity">
          <div class="live-section-label">Recent Activity ${activityBar}</div>
          ${eventsHTML}
          ${lastActive ? `<div class="live-last-active">Last active: ${lastActive}</div>` : ''}
        </div>
      </div>
    </div>`;
  },

  _activityBar(intensity) {
    const maxBars = 5;
    const filled = Math.min(intensity, maxBars);
    let html = '<span class="live-activity-bar">';
    for (let i = 0; i < maxBars; i++) {
      html += `<span class="live-bar ${i < filled ? 'live-bar-filled' : ''}"></span>`;
    }
    html += '</span>';
    return html;
  },

  _fingerprint(agent) {
    return JSON.stringify([
      agent.effectiveStatus,
      agent.healthScore,
      agent.activityIntensity,
      agent.lastActiveMs ? Math.floor(agent.lastActiveMs / 60000) : null,
      agent.currentTasks.map(t => t.title),
      agent.recentEvents.map(e => e.action + e.targetTitle)
    ]);
  }
};
