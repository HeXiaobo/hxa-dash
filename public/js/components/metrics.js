// Team Utilization & Output Metrics Panel (#62 Phase 1, #66 real-time, #67 per-agent filter)
const Metrics = {
  data: null,
  velocityData: null,
  container: null,

  init() {
    this.container = document.getElementById('metrics-panel');
    this.load();
    this.loadVelocity();
    // Fallback polling every 5min in case WS disconnects
    setInterval(() => this.load(), 5 * 60 * 1000);
    setInterval(() => this.loadVelocity(), 5 * 60 * 1000);
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

  async loadVelocity() {
    try {
      const r = await fetch(`${BASE}/api/metrics/velocity`);
      if (!r.ok) return;
      this.velocityData = await r.json();
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

    const filterLabel = filter
      ? `<span class="metrics-filter-badge">${filteredAgents.length}/${agents.length} 已选</span>`
      : '';

    // Summary cards (runtime + work-state based)
    const cards = `
      <div class="metrics-cards">
        <div class="metrics-card">
          <div class="metrics-card-value">${summary.working_count}<span class="metrics-card-unit">/${summary.online_count}</span></div>
          <div class="metrics-card-label">工作中 / 运行中 ${filterLabel}</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${summary.total_messages_24h}</div>
          <div class="metrics-card-label">互动次数 / 24h</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${summary.total_tasks_24h}</div>
          <div class="metrics-card-label">推进次数 / 24h</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${summary.total_active_days_7d || 0}</div>
          <div class="metrics-card-label">活跃天数累计 / 7天</div>
        </div>
      </div>
    `;

    // Agent table (filtered) — sorted: working first, then by events_7d desc
    const sorted = [...filteredAgents].sort((a, b) => {
      const order = { working: 0, standby: 1, offline: 2 };
      const diff = (order[a.status] ?? 9) - (order[b.status] ?? 9);
      if (diff !== 0) return diff;
      return (b.events_7d || 0) - (a.events_7d || 0);
    });

    const rows = sorted.map(a => `
      <tr>
        <td class="metrics-agent-name">${esc(a.name)}</td>
        <td><span class="work-status-badge ${esc(a.status)}">${this._statusLabel(a.status)}</span></td>
        <td>${esc(this._runtimeLabel(a.runtime_type, a.runtime_version, a.runtime_status))}</td>
        <td class="metrics-num">${a.today_messages}</td>
        <td class="metrics-num">${a.today_tasks}</td>
        <td class="metrics-num metrics-last-active">${this._formatLastActive(a.last_active)}</td>
      </tr>
    `).join('');

    const table = `
      <div class="metrics-table-wrap">
        <table class="metrics-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>状态</th>
              <th>Runtime</th>
              <th class="metrics-num-header">今日互动</th>
              <th class="metrics-num-header">今日推进</th>
              <th class="metrics-num-header">最后活跃</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6" class="metrics-empty">暂无成员数据</td></tr>'}</tbody>
        </table>
      </div>
    `;

    // Weekly trend bar chart (CSS bars, no canvas)
    const trend = this._renderTrend(summary.weekly_closed || []);

    const velocity = this._renderVelocity();
    this.container.innerHTML = cards + table + trend + velocity;
  },

  _computeFilteredSummary(filteredAgents) {
    const online = filteredAgents.filter(a => a.status !== 'offline');
    const working = filteredAgents.filter(a => a.status === 'working');
    return {
      online_count: online.length,
      working_count: working.length,
      standby_count: filteredAgents.filter(a => a.status === 'standby').length,
      total_messages_24h: filteredAgents.reduce((s, a) => s + a.today_messages, 0),
      total_tasks_24h: filteredAgents.reduce((s, a) => s + a.today_tasks, 0),
      total_events_7d: filteredAgents.reduce((s, a) => s + (a.events_7d || 0), 0),
      total_active_days_7d: filteredAgents.reduce((s, a) => s + (a.active_days_7d || 0), 0),
      weekly_closed: this.data.team.weekly_closed || [],
    };
  },

  _statusLabel(s) {
    return s === 'working' ? '工作中' : s === 'standby' ? '待命' : '离线';
  },

  _runtimeLabel(type, version, status) {
    const labels = { claude_code: 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw', unknown: 'Unknown' };
    if ((!type || type === 'unknown') && status === 'degraded') return '待接入';
    const statusLabels = { running: '正常', degraded: '异常', offline: '离线' };
    return `${labels[type] || type || 'Unknown'}${version ? ` ${version}` : ''} · ${statusLabels[status] || '未提供'}`;
  },

  _formatLastActive(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 7 * 24 * 3600 * 1000) return `${Math.floor(diff / 86400000)}天前`;
    return '超过7天';
  },

  _renderTrend(weeks) {
    if (weeks.length === 0) return '';

    const maxMsgs  = Math.max(...weeks.map(w => w.messages || 0), 1);
    const maxTasks = Math.max(...weeks.map(w => w.tasks || 0), 1);
    const maxVal   = Math.max(maxMsgs, maxTasks, 1);

    const bars = weeks.map(w => {
      const mPct = Math.round(((w.messages || 0) / maxVal) * 100);
      const tPct = Math.round(((w.tasks || 0) / maxVal) * 100);
      const label = w.week.replace(/^\d{4}-/, '');
      return `
        <div class="metrics-trend-col">
          <div class="metrics-trend-bars">
            <div class="metrics-trend-bar bar-issue" style="height:${mPct}%" title="${w.messages || 0} 消息"></div>
            <div class="metrics-trend-bar bar-mr"    style="height:${tPct}%" title="${w.tasks || 0} 任务"></div>
          </div>
          <div class="metrics-trend-label">${esc(label)}</div>
          <div class="metrics-trend-nums">${w.messages || 0}/${w.tasks || 0}</div>
        </div>
      `;
    }).join('');

    return `
      <div class="metrics-trend-section">
        <div class="metrics-trend-title">
          按周趋势
          <span class="metrics-trend-legend">
            <span class="metrics-legend-dot dot-issue"></span>消息
            <span class="metrics-legend-dot dot-mr"></span>任务
          </span>
        </div>
        <div class="metrics-trend-chart">${bars}</div>
      </div>
    `;
  },

  _renderVelocity() {
    if (!this.velocityData) return '';
    const { team, agents, summary } = this.velocityData;

    // Session summary cards
    const openSessions = summary.open_total_sessions;
    const openMinutes = summary.open_estimated_minutes;
    const openTimeStr = openMinutes >= 60
      ? `${Math.floor(openMinutes / 60)}h ${openMinutes % 60}m`
      : `${openMinutes}m`;

    const velocityCards = `
      <div class="metrics-section-title">任务负载预估</div>
      <div class="metrics-cards">
        <div class="metrics-card velocity-card">
          <div class="metrics-card-value">${team.sessions_per_day}<span class="metrics-card-unit">/天</span></div>
          <div class="metrics-card-label">团队推进速率</div>
        </div>
        <div class="metrics-card velocity-card">
          <div class="metrics-card-value">${openSessions}</div>
          <div class="metrics-card-label">待完成工作块</div>
        </div>
        <div class="metrics-card velocity-card">
          <div class="metrics-card-value">${openTimeStr}</div>
          <div class="metrics-card-label">预计剩余时间</div>
        </div>
        <div class="metrics-card velocity-card">
          <div class="metrics-card-value">${team.active_agents}</div>
          <div class="metrics-card-label">有记录成员 (7d)</div>
        </div>
      </div>
    `;

    // Estimate distribution for open tasks
    const dist = summary.open;
    const distBar = this._renderEstimateDist(dist);

    // Per-agent velocity table (#118: show activity + estimate breakdown)
    const agentRows = agents.map(a => {
      const source = (a.activity_sessions || 0) > (a.estimate_sessions || 0) ? '📊' : '📋';
      return `
      <tr>
        <td class="metrics-agent-name">${esc(a.name)}</td>
        <td class="metrics-num">${a.total_sessions}</td>
        <td class="metrics-num">${a.sessions_per_day}</td>
        <td class="metrics-num">${a.events || 0}</td>
        <td class="metrics-num">${source}</td>
      </tr>
    `;
    }).join('');

    const agentTable = agents.length > 0 ? `
      <div class="metrics-table-wrap">
        <table class="metrics-table">
          <thead>
            <tr><th>成员</th><th>工作块 (7d)</th><th>日均</th><th>事件数</th><th>口径</th></tr>
          </thead>
          <tbody>${agentRows}</tbody>
        </table>
      </div>
    ` : '';

    return velocityCards + distBar + agentTable;
  },

  _renderEstimateDist(dist) {
    if (!dist) return '';
    const sizes = ['S', 'M', 'L', 'XL'];
    const total = sizes.reduce((s, k) => s + (dist[k] || 0), 0) + (dist.unestimated || 0);
    if (total === 0) return '';

    const bars = sizes.map(size => {
      const count = dist[size] || 0;
      const pct = Math.round((count / total) * 100);
      return `<div class="estimate-dist-segment estimate-dist-${size.toLowerCase()}" style="width:${pct}%" title="${size}: ${count} (${pct}%)">${count > 0 ? size : ''}</div>`;
    }).join('');

    const unest = dist.unestimated || 0;
    const unestPct = Math.round((unest / total) * 100);
    const unestBar = unest > 0
      ? `<div class="estimate-dist-segment estimate-dist-none" style="width:${unestPct}%" title="未估算: ${unest} (${unestPct}%)">?</div>`
      : '';

    return `
      <div class="estimate-dist-section">
        <div class="estimate-dist-title">待办任务估算分布</div>
        <div class="estimate-dist-bar">${bars}${unestBar}</div>
        <div class="estimate-dist-legend">
          <span><span class="estimate-dot estimate-s"></span>S (${dist.S || 0})</span>
          <span><span class="estimate-dot estimate-m"></span>M (${dist.M || 0})</span>
          <span><span class="estimate-dot estimate-l"></span>L (${dist.L || 0})</span>
          <span><span class="estimate-dot estimate-xl"></span>XL (${dist.XL || 0})</span>
          <span><span class="estimate-dot estimate-none"></span>? (${unest})</span>
        </div>
      </div>
    `;
  }
};
