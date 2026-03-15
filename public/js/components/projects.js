// Project Dimension (#76) — project-level health, progress, AI planning
const Projects = {
  data: null,

  init() {
    this.load();
    setInterval(() => this.load(), 5 * 60 * 1000);
  },

  // Accept data pushed via WebSocket
  update(projectsData) {
    this.data = projectsData;
    this.render();
  },

  async load() {
    try {
      const r = await fetch(`${BASE}/api/projects`);
      if (!r.ok) return;
      this.data = await r.json();
      this.render();
    } catch (e) { /* silent fail */ }
  },

  render() {
    if (!this.data) return;
    this.renderSummary();
    this.renderHealth();
    this.renderSuggestions();
  },

  renderSummary() {
    const el = document.getElementById('project-summary-cards');
    if (!el) return;

    const projects = this.data.projects || [];
    const totalOpen = projects.reduce((s, p) => s + p.stats.issues.open, 0);
    const totalClosed = projects.reduce((s, p) => s + p.stats.issues.closed, 0);
    const totalMRs = projects.reduce((s, p) => s + p.stats.mrs.open, 0);
    const healthy = projects.filter(p => p.health.level === 'healthy').length;
    const warning = projects.filter(p => p.health.level === 'warning').length;
    const critical = projects.filter(p => p.health.level === 'critical').length;

    el.innerHTML = `
      <div class="summary-card">
        <div class="summary-number">${projects.length}</div>
        <div class="summary-label">活跃项目</div>
      </div>
      <div class="summary-card">
        <div class="summary-number">${totalOpen}</div>
        <div class="summary-label">Open Issues</div>
      </div>
      <div class="summary-card">
        <div class="summary-number">${totalClosed}</div>
        <div class="summary-label">已关闭</div>
      </div>
      <div class="summary-card">
        <div class="summary-number">${totalMRs}</div>
        <div class="summary-label">待 Review MR</div>
      </div>
      <div class="summary-card ${critical > 0 ? 'summary-critical' : warning > 0 ? 'summary-warning' : 'summary-healthy'}">
        <div class="summary-number">${healthy} / ${warning} / ${critical}</div>
        <div class="summary-label">健康 / 警告 / 危险</div>
      </div>
    `;
  },

  renderHealth() {
    const el = document.getElementById('project-health-grid');
    if (!el) return;

    const projects = this.data.projects || [];
    if (projects.length === 0) {
      el.innerHTML = '<div class="empty-state">暂无项目数据</div>';
      return;
    }

    el.innerHTML = projects.map(p => {
      const healthClass = `health-${p.health.level}`;
      const sparkline = this._miniSparkline(p.activity);
      const contributors = (p.stats.contributors || []).slice(0, 5).map(c => esc(c)).join(', ');
      const lastAct = p.last_activity ? timeAgo(p.last_activity) : '无活动';

      return `
        <div class="project-card ${healthClass}">
          <div class="project-card-header">
            <span class="project-name">${esc(p.name)}</span>
            <span class="health-badge ${healthClass}">${p.health.score}</span>
          </div>
          <div class="project-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${p.completion}%"></div>
            </div>
            <span class="progress-text">${p.completion}%</span>
          </div>
          <div class="project-stats-row">
            <span>📋 ${p.stats.issues.open} open / ${p.stats.issues.closed} closed</span>
            <span>🔀 ${p.stats.mrs.open} MR</span>
          </div>
          <div class="project-stats-row">
            <span>⚡ ${p.velocity.issues_closed_7d} closed/7d</span>
            <span>🕐 ${lastAct}</span>
          </div>
          <div class="project-sparkline">${sparkline}</div>
          <div class="project-contributors">👥 ${contributors || '无参与者'}</div>
          ${p.stale_count > 0 ? `<div class="project-stale">⏰ ${p.stale_count} stale</div>` : ''}
        </div>
      `;
    }).join('');
  },

  renderSuggestions() {
    const el = document.getElementById('project-suggestions');
    if (!el) return;

    const projects = this.data.projects || [];
    const allSuggestions = [];
    for (const p of projects) {
      for (const s of (p.suggestions || [])) {
        allSuggestions.push({ ...s, project: p.name });
      }
    }

    // Sort: critical first, then warning, then info
    const typeOrder = { critical: 0, warning: 1, info: 2, success: 3 };
    allSuggestions.sort((a, b) => (typeOrder[a.type] || 9) - (typeOrder[b.type] || 9));

    if (allSuggestions.length === 0) {
      el.innerHTML = '<div class="empty-state">✅ 所有项目状态良好，无需特别关注</div>';
      return;
    }

    el.innerHTML = allSuggestions.map(s => `
      <div class="suggestion-item suggestion-${s.type}">
        <span class="suggestion-icon">${s.icon}</span>
        <span class="suggestion-project">[${esc(s.project)}]</span>
        <span class="suggestion-text">${esc(s.text)}</span>
      </div>
    `).join('');
  },

  // Mini sparkline using CSS bars
  _miniSparkline(activity) {
    if (!activity || activity.length === 0) return '';
    const max = Math.max(...activity.map(a => a.count), 1);
    return '<div class="sparkline">' + activity.map(a => {
      const h = Math.max(2, Math.round((a.count / max) * 20));
      return `<div class="spark-bar" style="height:${h}px" title="${a.count} events"></div>`;
    }).join('') + '</div>';
  },
};
