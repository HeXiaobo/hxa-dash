// Team Utilization & Output Metrics Panel (#62 Phase 1, #66 real-time, #67 per-agent filter)
const Metrics = {
  data: null,
  container: null,

  init() {
    this.container = document.getElementById('metrics-panel');
    this.load();
    // Fallback polling every 5min in case WS disconnects
    setInterval(() => this.load(), 5 * 60 * 1000);
  },

  // Accept data pushed via WebSocket (#66)
  update(metricsData) {
    this.data = metricsData;
    this.render();
  },

  async load() {
    try {
      const r = await fetch(`${BASE}/api/metrics`);
      if (!r.ok) return;
      this.data = await r.json();
      this.render();
    } catch (e) { /* silent fail */ }
  },

  render() {
    if (!this.container || !this.data) return;
    const { team, agents } = this.data;

    // Apply agent filter from overview page (#67)
    const filter = AgentFilter.getFilter('overview');
    const filteredAgents = filter
      ? agents.filter(a => filter.has(a.name))
      : agents;

    // Recompute summary stats for filtered agents (#67)
    const summary = filter ? this._computeFilteredSummary(filteredAgents) : team;

    const cycleTime = summary.cycle_time_median_hours != null
      ? `${summary.cycle_time_median_hours}h`
      : '—';

    const filterLabel = filter
      ? `<span class="metrics-filter-badge">${filteredAgents.length}/${agents.length} 已选</span>`
      : '';

    // Summary cards
    const cards = `
      <div class="metrics-cards">
        <div class="metrics-card">
          <div class="metrics-card-value">${summary.idle_pct}<span class="metrics-card-unit">%</span></div>
          <div class="metrics-card-label">在线空闲率 ${filterLabel}</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${summary.issues_closed_7d}</div>
          <div class="metrics-card-label">Issue 完成 / 7天</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${summary.mrs_merged_7d}</div>
          <div class="metrics-card-label">MR 合并 / 7天</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${cycleTime}</div>
          <div class="metrics-card-label">周期时间中位数</div>
        </div>
      </div>
    `;

    // Agent table (filtered)
    const rows = filteredAgents.map(a => `
      <tr>
        <td class="metrics-agent-name">${esc(a.name)}</td>
        <td><span class="work-status-badge ${esc(a.status)}">${this._statusLabel(a.status)}</span></td>
        <td class="metrics-num">${a.open_tasks}</td>
        <td class="metrics-num">${a.closed_7d}</td>
        <td class="metrics-num">${a.mrs_7d}</td>
      </tr>
    `).join('');

    const table = `
      <div class="metrics-table-wrap">
        <table class="metrics-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>状态</th>
              <th>进行中</th>
              <th>完成 (7d)</th>
              <th>MR (7d)</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5" class="metrics-empty">暂无成员数据</td></tr>'}</tbody>
        </table>
      </div>
    `;

    // Weekly trend bar chart (CSS bars, no canvas)
    const trend = this._renderTrend(summary.weekly_closed || []);

    this.container.innerHTML = cards + table + trend;
  },

  // Recompute summary for a filtered subset of agents (#67)
  _computeFilteredSummary(filteredAgents) {
    const names = new Set(filteredAgents.map(a => a.name));
    const online = filteredAgents.filter(a => a.status !== 'offline');
    const idle = online.filter(a => a.status === 'idle');
    const idlePct = online.length > 0
      ? Math.round((idle.length / online.length) * 100)
      : 0;
    const issuesClosed7d = filteredAgents.reduce((s, a) => s + a.closed_7d, 0);
    const mrsMerged7d = filteredAgents.reduce((s, a) => s + a.mrs_7d, 0);

    return {
      idle_pct: idlePct,
      issues_closed_7d: issuesClosed7d,
      mrs_merged_7d: mrsMerged7d,
      cycle_time_median_hours: this.data.team.cycle_time_median_hours,
      weekly_closed: this.data.team.weekly_closed || [],
    };
  },

  _statusLabel(s) {
    return s === 'busy' ? '进行中' : s === 'idle' ? '空闲' : '离线';
  },

  _renderTrend(weeks) {
    if (weeks.length === 0) return '';

    const maxIssues = Math.max(...weeks.map(w => w.issues_closed), 1);
    const maxMRs    = Math.max(...weeks.map(w => w.mrs_merged),   1);
    const maxVal    = Math.max(maxIssues, maxMRs, 1);

    const bars = weeks.map(w => {
      const iPct = Math.round((w.issues_closed / maxVal) * 100);
      const mPct = Math.round((w.mrs_merged    / maxVal) * 100);
      // Short label: "W10" from "2026-W10"
      const label = w.week.replace(/^\d{4}-/, '');
      return `
        <div class="metrics-trend-col">
          <div class="metrics-trend-bars">
            <div class="metrics-trend-bar bar-issue" style="height:${iPct}%" title="${w.issues_closed} issues"></div>
            <div class="metrics-trend-bar bar-mr"    style="height:${mPct}%" title="${w.mrs_merged} MRs"></div>
          </div>
          <div class="metrics-trend-label">${esc(label)}</div>
          <div class="metrics-trend-nums">${w.issues_closed}/${w.mrs_merged}</div>
        </div>
      `;
    }).join('');

    return `
      <div class="metrics-trend-section">
        <div class="metrics-trend-title">
          按周趋势
          <span class="metrics-trend-legend">
            <span class="metrics-legend-dot dot-issue"></span>Issue
            <span class="metrics-legend-dot dot-mr"></span>MR
          </span>
        </div>
        <div class="metrics-trend-chart">${bars}</div>
      </div>
    `;
  }
};
