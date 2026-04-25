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

    const runtime = summary.runtime || {};
    el.innerHTML = `
      <div class="live-stat live-stat-active" title="正在处理任务或有明确工作信号">
        <span class="live-stat-num">${summary.working || 0}</span>
        <span class="live-stat-label">🟢 工作中</span>
      </div>
      <div class="live-stat live-stat-online" title="运行正常，但当前没有明显工作信号">
        <span class="live-stat-num">${summary.standby || 0}</span>
        <span class="live-stat-label">🟡 待命</span>
      </div>
      <div class="live-stat live-stat-offline" title="离线">
        <span class="live-stat-num">${summary.offline || 0}</span>
        <span class="live-stat-label">⚫ 离线</span>
      </div>
      <div class="live-stat">
        <span class="live-stat-num">${runtime.degraded || 0}</span>
        <span class="live-stat-label">⚠️ 异常</span>
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
    const workLabels = { working: '🟢 工作中', standby: '🟡 待命', offline: '⚫ 离线' };
    const runtimeLabels = { running: '运行正常', degraded: '异常', offline: '未运行' };
    const statusLabel = workLabels[agent.effectiveStatus] || workLabels.offline;
    const runtimeText = agent.runtime
      ? `${agent.runtime.label || agent.runtime.type || 'Unknown'}${agent.runtime.version ? ` ${agent.runtime.version}` : ''}`
      : 'Unknown';

    const tasksHTML = agent.currentTasks.length
      ? agent.currentTasks.map(t => {
          const badge = (t.type === 'merge_request' || t.type === 'mr') ? '<span class="live-badge-mr">MR</span>' : '<span class="live-badge-issue">Task</span>';
          const link = t.url ? `<a href="${esc(t.url)}" target="_blank" class="live-task-link">${badge} ${esc(truncate(t.title, 50))}</a>` : `${badge} ${esc(truncate(t.title, 50))}`;
          return `<div class="live-task-item">${link} <span class="live-task-project">${esc(t.project)}</span></div>`;
        }).join('')
      : '<span class="live-no-tasks">当前无挂起任务</span>';

    const eventsHTML = agent.recentEvents.length
      ? agent.recentEvents.slice(0, 4).map(e => {
          return `<div class="live-event-item"><span class="live-event-action">${esc(e.action)}</span> ${esc(truncate(e.targetTitle, 40))} <span class="live-event-time">${timeAgo(e.timestamp)}</span></div>`;
        }).join('')
      : '';

    const activityBar = this._activityBar(agent.activityIntensity);
    const lastActive = agent.lastActiveMs !== null ? timeAgo(Date.now() - agent.lastActiveMs) : '';
    const healthBadge = agent.healthScore !== null ? `<span class="live-health">${agent.healthScore}</span>` : '';
    const quotaBadge = agent.quota?.supported ? this._quotaBadge(agent.quota) : '';

    return `<div class="live-agent-row ${statusClass}" data-agent="${esc(agent.name)}">
      <div class="live-agent-header">
        <span class="live-agent-name">${esc(agent.displayName)}</span>
        <span class="live-agent-role">${esc(agent.role || runtimeText)}</span>
        ${healthBadge}
        <span class="live-agent-status">${statusLabel}</span>
      </div>
      <div class="live-agent-role">${esc(runtimeText)} · ${esc(runtimeLabels[agent.runtimeStatus] || '未提供')}</div>
      ${quotaBadge}
      <div class="live-agent-body">
        <div class="live-agent-tasks">
          <div class="live-section-label">当前任务</div>
          ${tasksHTML}
        </div>
        <div class="live-agent-activity">
          <div class="live-section-label">最近信号 ${activityBar}</div>
          ${eventsHTML}
          ${lastActive ? `<div class="live-last-active">最后活动: ${lastActive}</div>` : ''}
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

  _quotaBadge(quota) {
    const parts = [
      quota?.primary?.used_percent != null ? `5h ${quota.primary.used_percent}%` : null,
      quota?.secondary?.used_percent != null ? `7d ${quota.secondary.used_percent}%` : null,
    ].filter(Boolean);
    return parts.length ? `<span class="live-agent-role">${parts.join(' · ')}</span>` : '';
  },

  _fingerprint(agent) {
    const quota = agent.quota || {};
    const quotaWindow = (window) => window
      ? [window.used_percent ?? '', window.resets_at || '', window.window_minutes || ''].join(':')
      : '';
    return JSON.stringify([
      agent.effectiveStatus,
      agent.healthScore,
      agent.activityIntensity,
      agent.lastActiveMs ? Math.floor(agent.lastActiveMs / 60000) : null,
      quota.supported === true ? 1 : quota.supported === false ? 0 : '',
      quota.reason || '',
      quotaWindow(quota.primary),
      quotaWindow(quota.secondary),
      agent.currentTasks.map(t => t.title),
      agent.recentEvents.map(e => e.action + e.targetTitle)
    ]);
  }
};
