// System Health Diagnostics (#94)
const HealthDiagnostics = {
  _data: null,
  _container: null,
  _pollTimer: null,

  init() {
    this._container = document.getElementById('health-diagnostics');
  },

  async fetch() {
    try {
      const r = await fetch(`${BASE}/api/diagnostics`);
      if (!r.ok) return;
      this._data = await r.json();
      this.render();
    } catch (e) { /* silent fail */ }
  },

  render() {
    if (!this._container || !this._data) return;
    const d = this._data;

    const statusIcon = { ok: '✅', warning: '⚠️', critical: '🔴' };
    const statusLabel = { ok: '正常', warning: '警告', critical: '异常' };
    const statusClass = { ok: 'health-ok', warning: 'health-warn', critical: 'health-crit' };

    // Overall status banner
    const banner = `
      <div class="health-banner ${statusClass[d.overall]}">
        <span class="health-banner-icon">${statusIcon[d.overall]}</span>
        <span class="health-banner-text">系统状态: ${statusLabel[d.overall]}</span>
        <span class="health-banner-uptime">运行时间: ${this._formatUptime(d.uptime_seconds)}</span>
      </div>
    `;

    // System info card
    const sysInfo = `
      <div class="health-card">
        <div class="health-card-title">🖥️ 系统信息</div>
        <div class="health-info-grid">
          <div class="health-info-item"><span class="health-info-label">主机</span><span class="health-info-value">${esc(d.system.hostname)}</span></div>
          <div class="health-info-item"><span class="health-info-label">平台</span><span class="health-info-value">${esc(d.system.platform)}</span></div>
          <div class="health-info-item"><span class="health-info-label">CPU</span><span class="health-info-value">${d.system.cpu_count} 核 · ${esc(d.system.cpu_model)}</span></div>
          <div class="health-info-item"><span class="health-info-label">负载</span><span class="health-info-value">${d.system.load_avg.join(' / ')}</span></div>
        </div>
      </div>
    `;

    // Resource gauges
    const resources = `
      <div class="health-gauges">
        ${this._renderGauge('内存', d.memory.pct, d.memory.status, `${d.memory.used_gb}GB / ${d.memory.total_gb}GB`)}
        ${this._renderGauge('磁盘', d.disk.pct, d.disk.status, `${d.disk.used || '?'} / ${d.disk.total || '?'}`)}
      </div>
    `;

    // PM2 services table
    const pm2Header = `
      <div class="health-card">
        <div class="health-card-title">
          ${statusIcon[d.pm2.status]} PM2 服务
          <span class="health-card-badge">${d.pm2.online}/${d.pm2.total} 在线</span>
        </div>
    `;

    const pm2Rows = d.pm2.services.map(svc => {
      const svcClass = svc.status === 'online' ? 'health-ok' : 'health-crit';
      const mem = svc.memory ? `${Math.round(svc.memory / 1048576)}MB` : '—';
      const uptime = svc.uptime != null ? this._formatUptime(Math.floor(svc.uptime / 1000)) : '—';
      return `
        <tr class="${svcClass}">
          <td class="health-svc-name">${esc(svc.name)}</td>
          <td><span class="health-status-dot ${svcClass}"></span>${esc(svc.status)}</td>
          <td class="health-num">${svc.pid || '—'}</td>
          <td class="health-num">${mem}</td>
          <td class="health-num">${svc.cpu != null ? svc.cpu + '%' : '—'}</td>
          <td class="health-num">${uptime}</td>
          <td class="health-num">${svc.restarts}</td>
        </tr>
      `;
    }).join('');

    const pm2Table = `
      ${pm2Header}
        <div class="health-table-wrap">
          <table class="health-table">
            <thead>
              <tr>
                <th>服务</th>
                <th>状态</th>
                <th>PID</th>
                <th>内存</th>
                <th>CPU</th>
                <th>运行时间</th>
                <th>重启次数</th>
              </tr>
            </thead>
            <tbody>${pm2Rows || '<tr><td colspan="7" class="health-empty">未检测到 PM2 服务</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;

    // Last check timestamp
    const footer = `
      <div class="health-footer">
        最后检查: ${new Date(d.timestamp).toLocaleString('zh-CN')}
        <button class="btn-sm health-refresh-btn" onclick="HealthDiagnostics.fetch()">🔄 刷新</button>
      </div>
    `;

    this._container.innerHTML = banner + sysInfo + resources + pm2Table + footer;
  },

  _renderGauge(label, pct, status, detail) {
    const statusClass = { ok: 'health-ok', warning: 'health-warn', critical: 'health-crit' };
    const cls = statusClass[status] || 'health-ok';
    const p = pct || 0;
    return `
      <div class="health-gauge">
        <div class="health-gauge-ring">
          <svg viewBox="0 0 36 36" class="health-gauge-svg">
            <path class="health-gauge-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
            <path class="health-gauge-fill ${cls}" stroke-dasharray="${p}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
          </svg>
          <div class="health-gauge-text">${p}%</div>
        </div>
        <div class="health-gauge-label">${label}</div>
        <div class="health-gauge-detail">${detail}</div>
      </div>
    `;
  },

  _formatUptime(seconds) {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    if (seconds < 86400) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return `${h}小时${m}分`;
    }
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    return `${d}天${h}小时`;
  }
};
