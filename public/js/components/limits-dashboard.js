const LimitsDashboard = {
  _data: null,
  _loading: false,

  init() {},

  async fetch() {
    if (this._loading) return;
    this._loading = true;
    try {
      const res = await fetch(`${BASE}/api/limits`);
      if (!res.ok) return;
      this._data = await res.json();
      this.render();
    } catch (err) {
      console.error('[LimitsDashboard] fetch error:', err);
    } finally {
      this._loading = false;
    }
  },

  render() {
    const container = document.getElementById('limits-dashboard');
    if (!container) return;
    if (!this._data) {
      container.innerHTML = '<div class="empty-state">加载中…</div>';
      return;
    }

    const team = this._data.team || {};
    const agents = this._data.agents || [];

    const cards = `
      <div class="metrics-cards">
        <div class="metrics-card">
          <div class="metrics-card-value">${team.tracked || 0}<span class="metrics-card-unit">/${team.total || 0}</span></div>
          <div class="metrics-card-label">已追踪限额</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${team.warning_count || 0}</div>
          <div class="metrics-card-label">接近上限</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${team.unsupported || 0}</div>
          <div class="metrics-card-label">暂不支持</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${team.next_reset_at ? formatTime(team.next_reset_at) : '—'}</div>
          <div class="metrics-card-label">最近重置时间</div>
        </div>
      </div>
    `;

    const rows = agents.map(agent => {
      const runtime = agent.runtime || {};
      const quota = agent.quota || {};
      const primary = quota.primary || {};
      const secondary = quota.secondary || {};
      const runtimeText = `${runtime.label || runtime.type || 'Unknown'}${runtime.version ? ` ${runtime.version}` : ''}`;
      const workText = agent.work_state === 'working' ? '工作中' : agent.work_state === 'standby' ? '待命' : '离线';
      const quotaText = quota.supported
        ? `${primary.used_percent ?? '—'}% / 5h · ${secondary.used_percent ?? '—'}% / 7d`
        : (quota.reason === 'unsupported_for_now' ? '暂不支持' : '未提供');

      return `
        <tr>
          <td class="metrics-agent-name">${esc(agent.name)}</td>
          <td>${esc(runtimeText)}</td>
          <td>${esc(workText)}</td>
          <td>${esc(quotaText)}</td>
          <td>${primary.resets_at ? formatTime(primary.resets_at) : '—'}</td>
          <td>${secondary.resets_at ? formatTime(secondary.resets_at) : '—'}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = cards + `
      <div class="metrics-table-wrap">
        <table class="metrics-table">
          <thead>
            <tr>
              <th>成员</th>
              <th>Runtime</th>
              <th>状态</th>
              <th>限额用量</th>
              <th>5h 重置</th>
              <th>7d 重置</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6" class="metrics-empty">暂无限额数据</td></tr>'}</tbody>
        </table>
      </div>
    `;
  },
};
