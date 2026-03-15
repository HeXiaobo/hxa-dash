// Agent Time Estimation Component (#79)
// Shows per-agent historical completion times and predictions for open tasks
const TimeEstimates = {
  _data: null,
  _period: 30,

  init() {
    // Period toggle buttons
    document.querySelectorAll('[data-estimate-period]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-estimate-period]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._period = parseInt(btn.dataset.estimatePeriod);
        this.fetch();
      });
    });
  },

  async fetch() {
    try {
      const r = await fetch(`${BASE}/api/metrics/estimates?days=${this._period}`);
      if (!r.ok) return;
      this._data = await r.json();
      this.render();
    } catch (e) { /* silent fail */ }
  },

  render() {
    const container = document.getElementById('time-estimates');
    if (!container || !this._data) return;
    const d = this._data;

    // Team-wide estimate averages
    const teamCards = this._renderTeamCards(d.team);

    // Per-agent table
    const agentTable = this._renderAgentTable(d.agents);

    // Predictions for open tasks
    const predictions = this._renderPredictions(d.predictions);

    container.innerHTML = teamCards + agentTable + predictions;
  },

  _renderTeamCards(team) {
    const sizes = ['S', 'M', 'L', 'XL'];
    const cards = sizes.map(size => {
      const stats = team[size];
      if (!stats || stats.count === 0) {
        return `
          <div class="metrics-card">
            <div class="metrics-card-value">—</div>
            <div class="metrics-card-label">${size} 平均耗时</div>
          </div>
        `;
      }
      return `
        <div class="metrics-card">
          <div class="metrics-card-value">${stats.avg_hours}<span class="metrics-card-unit">h</span></div>
          <div class="metrics-card-label">${size} 平均耗时 <span class="te-count">(${stats.count})</span></div>
        </div>
      `;
    }).join('');

    return `
      <div class="metrics-section-title">团队平均完成时间（按估算大小）</div>
      <div class="metrics-cards">${cards}</div>
    `;
  },

  _renderAgentTable(agents) {
    if (!agents.length) return '<div class="te-empty">暂无完成数据</div>';

    const sizes = ['S', 'M', 'L', 'XL'];
    const rows = agents.map(a => {
      const cells = sizes.map(size => {
        const s = a.by_estimate[size];
        if (!s) return '<td class="metrics-num te-na">—</td>';
        return `<td class="metrics-num" title="中位数: ${s.median_hours}h, 最快: ${s.min_hours}h, 最慢: ${s.max_hours}h">${s.avg_hours}h <span class="te-sub">(${s.count})</span></td>`;
      }).join('');

      return `
        <tr>
          <td class="metrics-agent-name">${esc(a.name)}</td>
          <td class="metrics-num">${a.total_completed}</td>
          <td class="metrics-num">${a.avg_hours_per_task}h</td>
          ${cells}
        </tr>
      `;
    }).join('');

    return `
      <div class="metrics-section-title">Agent 完成时间分析</div>
      <div class="metrics-table-wrap">
        <table class="metrics-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th class="metrics-num-header">完成数</th>
              <th class="metrics-num-header">平均/任务</th>
              ${sizes.map(s => `<th class="metrics-num-header">${s}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  },

  _renderPredictions(predictions) {
    if (!predictions || !predictions.length) return '';

    const rows = predictions.map(p => {
      const predStr = p.predicted_hours != null
        ? `<span class="te-pred">${p.predicted_hours}h</span>`
        : '<span class="te-na">—</span>';
      return `
        <tr>
          <td class="te-task-title">${p.url ? `<a href="${esc(p.url)}" target="_blank" class="te-link">${esc(truncate(p.title, 50))}</a>` : esc(truncate(p.title, 50))}</td>
          <td class="metrics-num">${esc(p.assignee)}</td>
          <td class="metrics-num"><span class="te-est-badge te-est-${(p.estimate || '').toLowerCase()}">${esc(p.estimate)}</span></td>
          <td class="metrics-num">${predStr}</td>
          <td class="te-project">${esc(p.project || '')}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="metrics-section-title">待办任务预估完成时间</div>
      <div class="metrics-table-wrap">
        <table class="metrics-table">
          <thead>
            <tr>
              <th>任务</th>
              <th class="metrics-num-header">负责人</th>
              <th class="metrics-num-header">估算</th>
              <th class="metrics-num-header">预测耗时</th>
              <th>项目</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }
};
