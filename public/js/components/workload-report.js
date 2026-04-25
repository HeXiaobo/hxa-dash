// Workload Report Component — team rhythm summary, with code metrics as secondary context.
const WorkloadReport = {
  _data: null,
  _days: 30,
  _sortKey: 'total_events',
  _sortAsc: false,

  init() {
    document.querySelectorAll('[data-workload-period]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._days = parseInt(btn.dataset.workloadPeriod, 10);
        document.querySelectorAll('[data-workload-period]').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        this.fetch();
      });
    });
    this.fetch();
  },

  async fetch() {
    const el = document.getElementById('workload-table-body');
    if (el) el.innerHTML = '<tr><td colspan="6" class="workload-loading">加载中…</td></tr>';
    const label = document.getElementById('workload-period-label');
    if (label) label.textContent = `过去 ${this._days} 天 · 团队节奏`;
    try {
      const res = await fetch(`${BASE}/api/stats/workload?days=${this._days}`);
      if (!res.ok) throw new Error('fetch failed');
      this._data = await res.json();
      this._render();
    } catch {
      const tbody = document.getElementById('workload-table-body');
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="workload-empty">数据加载失败</td></tr>';
    }
  },

  _sortBy(key) {
    if (this._sortKey === key) {
      this._sortAsc = !this._sortAsc;
    } else {
      this._sortKey = key;
      this._sortAsc = false;
    }
    this._render();
  },

  _render() {
    if (!this._data) return;
    const agents = [...(this._data.agents || [])].map(agent => this._normalizeAgent(agent));

    agents.sort((a, b) => {
      const av = a[this._sortKey] ?? 0;
      const bv = b[this._sortKey] ?? 0;
      if (typeof av === 'string') return this._sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return this._sortAsc ? av - bv : bv - av;
    });

    const tbody = document.getElementById('workload-table-body');
    if (!tbody) return;

    if (agents.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="workload-empty">暂无数据</td></tr>';
      return;
    }

    const maxVals = {
      deliverables: Math.max(...agents.map(a => a.deliverables), 1),
      task_advances: Math.max(...agents.map(a => a.task_advances), 1),
      message_interactions: Math.max(...agents.map(a => a.message_interactions), 1),
      active_days: Math.max(...agents.map(a => a.active_days), 1),
    };

    const bar = (val, max, color) => {
      const num = Number(val) || 0;
      const pct = max > 0 ? Math.round((num / max) * 100) : 0;
      return `<div class="workload-bar-wrap">
        <div class="workload-bar" style="width:${pct}%;background:${color}"></div>
        <span class="workload-bar-val">${num}</span>
      </div>`;
    };

    tbody.innerHTML = agents.map(a => {
      const status = this._statusMeta(a);
      const runtimeLabel = status.runtimeLabel
        ? `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;background:rgba(88,166,255,.12);color:#58a6ff;font-size:11px;">${status.runtimeLabel}</span>`
        : '';
      const chip = `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;background:${status.bg};color:${status.fg};font-size:11px;">${status.label}</span>`;
      const hint = a.rhythm_label
        ? `<div style="margin-top:4px;font-size:11px;color:var(--text-secondary);">${esc(a.rhythm_label)}</div>`
        : '';

      return `<tr>
        <td class="workload-name">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <span class="workload-dot" style="background:${status.dot};margin-top:6px;"></span>
            <div>
              <div style="font-weight:600;">${esc(a.name)}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
                ${chip}
                ${runtimeLabel}
              </div>
              ${hint}
            </div>
          </div>
        </td>
        <td>${bar(a.deliverables, maxVals.deliverables, '#3fb950')}</td>
        <td class="mobile-hide">${bar(a.task_advances, maxVals.task_advances, '#58a6ff')}</td>
        <td class="mobile-hide">${bar(a.message_interactions, maxVals.message_interactions, '#bc8cff')}</td>
        <td>${bar(a.active_days, maxVals.active_days, '#f0883e')}</td>
        <td class="workload-total">${a.total_events}</td>
      </tr>`;
    }).join('');

    const label = document.getElementById('workload-period-label');
    if (label) label.textContent = `过去 ${this._days} 天 · 团队节奏`;
  },

  _normalizeAgent(agent) {
    const deliverables = Number(agent.deliverables ?? agent.closed_issues ?? agent.issues_closed ?? 0) || 0;
    const task_advances = Number(agent.task_advances ?? agent.merged_mrs ?? agent.mrs_merged ?? 0) || 0;
    const message_interactions = Number(agent.message_interactions ?? agent.comments ?? 0) || 0;
    const active_days = Number(agent.active_days ?? 0) || 0;
    const total = Number(agent.total_events ?? agent.total ?? (deliverables + task_advances + message_interactions + active_days)) || 0;
    const status = this._statusMeta(agent);

    let rhythm_label = agent.rhythm_label || '';
    if (!rhythm_label) {
      if (total === 0) rhythm_label = '暂无事件';
      else if (total < 4) rhythm_label = '轻量参与';
      else if (total < 12) rhythm_label = '节奏平稳';
      else rhythm_label = '节奏活跃';
    }

    return {
      ...agent,
      deliverables,
      task_advances,
      message_interactions,
      active_days,
      total_events: total,
      rhythm_label,
      status_label: status.label,
    };
  },

  _statusMeta(agent) {
    const work = String(agent.work_state || agent.work_status || '').toLowerCase();
    const runtime = String(agent.runtime_status || agent.health_status || '').toLowerCase();
    const online = agent.online !== false;

    if (!online || runtime === 'offline') {
      return { label: '离线', runtimeLabel: runtime === 'offline' ? '运行态离线' : '', dot: '#6e7681', bg: 'rgba(110,118,129,.14)', fg: '#c9d1d9' };
    }
    if (runtime === 'degraded' || runtime === 'warning') {
      return { label: '待命', runtimeLabel: '待校验', dot: '#f0883e', bg: 'rgba(240,136,62,.14)', fg: '#ffa657' };
    }
    if (work === 'working' || work === 'busy') {
      return { label: '工作中', runtimeLabel: runtime && runtime !== 'running' ? this._prettyRuntime(runtime) : '运行中', dot: '#3fb950', bg: 'rgba(63,185,80,.14)', fg: '#7ee787' };
    }
    if (work === 'idle' || work === 'inactive' || work === 'standby') {
      return { label: '待命', runtimeLabel: runtime === 'running' ? '运行中' : this._prettyRuntime(runtime), dot: '#d29922', bg: 'rgba(210,153,34,.14)', fg: '#e3b341' };
    }
    return { label: '待命', runtimeLabel: runtime === 'running' ? '运行中' : this._prettyRuntime(runtime), dot: '#58a6ff', bg: 'rgba(88,166,255,.14)', fg: '#79c0ff' };
  },

  _prettyRuntime(runtime) {
    if (!runtime) return '';
    const map = {
      running: '运行中',
      online: '运行中',
      active: '运行中',
      degraded: '待校验',
      warning: '待校验',
      offline: '离线',
    };
    return map[runtime] || runtime;
  },

  exportJSON() {
    if (!this._data) return;
    const blob = new Blob([JSON.stringify(this._data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workload-report-${this._days}d.json`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
