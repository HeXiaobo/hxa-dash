// Workload Report Component — per-agent productivity summary (#59)
const WorkloadReport = {
  _data: null,
  _days: 30,
  _sortKey: 'total_events',
  _sortAsc: false,

  init() {
    document.querySelectorAll('[data-workload-period]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._days = parseInt(btn.dataset.workloadPeriod);
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
    const agents = [...this._data.agents];

    // Sort
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

    // Max values for bar scaling
    const maxVals = {
      closed_issues: Math.max(...agents.map(a => a.closed_issues), 1),
      merged_mrs: Math.max(...agents.map(a => a.merged_mrs), 1),
      commits: Math.max(...agents.map(a => a.commits), 1),
      comments: Math.max(...agents.map(a => a.comments), 1),
    };

    tbody.innerHTML = agents.map(a => {
      const statusDot = a.online
        ? '<span class="workload-dot online"></span>'
        : '<span class="workload-dot offline"></span>';

      const bar = (val, max, color) => {
        const pct = max > 0 ? Math.round((val / max) * 100) : 0;
        return `<div class="workload-bar-wrap">
          <div class="workload-bar" style="width:${pct}%;background:${color}"></div>
          <span class="workload-bar-val">${val}</span>
        </div>`;
      };

      return `<tr>
        <td class="workload-name">${statusDot}${esc(a.name)}</td>
        <td>${bar(a.closed_issues, maxVals.closed_issues, '#3fb950')}</td>
        <td>${bar(a.merged_mrs, maxVals.merged_mrs, '#58a6ff')}</td>
        <td>${bar(a.commits, maxVals.commits, '#bc8cff')}</td>
        <td>${bar(a.comments, maxVals.comments, '#f0883e')}</td>
        <td class="workload-total">${a.total_events}</td>
      </tr>`;
    }).join('');

    // Update period label
    const label = document.getElementById('workload-period-label');
    if (label) label.textContent = `过去 ${this._days} 天`;
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
