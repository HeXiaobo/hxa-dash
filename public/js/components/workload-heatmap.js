// Team Workload Heatmap (#111)
// Color-coded grid showing each agent's current load across dimensions.
const WorkloadHeatmap = {
  init() {},

  render(agents) {
    const container = document.getElementById('workload-heatmap');
    if (!container) return;

    // Filter to agents with any task activity
    const active = agents.filter(a => a.online || a.stats?.open_tasks > 0);
    if (active.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无工作负载数据</div>';
      return;
    }

    // Sort: busiest first
    active.sort((a, b) => {
      const loadA = (a.stats?.open_tasks || 0) + (a.blocking_mrs?.length || 0);
      const loadB = (b.stats?.open_tasks || 0) + (b.blocking_mrs?.length || 0);
      return loadB - loadA;
    });

    // Compute per-agent metrics
    const rows = active.map(a => {
      const totalOpen = a.stats?.open_tasks || 0;
      const blockingMRs = a.blocking_mrs?.length || 0;
      const capacityPct = a.capacity ? Math.round((a.capacity.current / a.capacity.max) * 100) : 0;
      return {
        name: a.name,
        online: a.online,
        healthScore: a.health_score || 0,
        openTasks: totalOpen,
        blockingMRs,
        capacityPct,
        workStatus: a.work_status
      };
    });

    // Column definitions
    const cols = [
      { key: 'openTasks', label: '待办任务', thresholds: [0, 2, 4, 6] },
      { key: 'blockingMRs', label: '阻塞 MR', thresholds: [0, 1, 2, 3] },
      { key: 'capacityPct', label: '容量 %', thresholds: [0, 40, 70, 90] },
      { key: 'healthScore', label: '健康分', thresholds: [80, 60, 40, 20], invert: true },
    ];

    let html = '<table class="heatmap-table"><thead><tr><th>Agent</th>';
    for (const col of cols) {
      html += `<th>${esc(col.label)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const row of rows) {
      const statusDot = row.online
        ? '<span class="matrix-status online"></span>'
        : '<span class="matrix-status offline"></span>';
      html += `<tr><td class="heatmap-agent">${esc(row.name)}${statusDot}</td>`;

      for (const col of cols) {
        const val = row[col.key];
        const level = col.invert
          ? this._invertLevel(val, col.thresholds)
          : this._level(val, col.thresholds);
        const cls = `heatmap-cell heatmap-${level}`;
        const display = col.key === 'capacityPct' ? `${val}%` : val;
        html += `<td class="${cls}" title="${esc(col.label)}: ${display}">${display}</td>`;
      }
      html += '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  },

  // Returns 'green' | 'yellow' | 'orange' | 'red' based on ascending thresholds
  _level(val, thresholds) {
    if (val <= thresholds[1]) return 'green';
    if (val <= thresholds[2]) return 'yellow';
    if (val <= thresholds[3]) return 'orange';
    return 'red';
  },

  // Inverted: high values are good (health score)
  _invertLevel(val, thresholds) {
    if (val >= thresholds[0]) return 'green';
    if (val >= thresholds[1]) return 'yellow';
    if (val >= thresholds[2]) return 'orange';
    return 'red';
  }
};
