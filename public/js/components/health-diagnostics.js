// System Health Diagnostics (#94, #104)
// Multi-component view: system + agents + services
const HealthDiagnostics = {
  _data: null,
  _container: null,

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

    // Agent health overview
    const agentSection = this._renderAgentHealth(d.agents);

    // Service endpoints
    const serviceSection = this._renderServices(d.services);

    // System info card
    const sysInfo = `
      <div class="health-card">
        <div class="health-card-title">🖥️ 主机</div>
        <div class="health-info-grid">
          <div class="health-info-item"><span class="health-info-label">主机</span><span class="health-info-value">${esc(d.system.hostname)}</span></div>
          <div class="health-info-item"><span class="health-info-label">平台</span><span class="health-info-value">${esc(d.system.platform)}</span></div>
          <div class="health-info-item"><span class="health-info-label">CPU</span><span class="health-info-value">${d.system.cpu_count} 核 · ${esc(d.system.cpu_model)}</span></div>
          <div class="health-info-item"><span class="health-info-label">负载</span><span class="health-info-value">${d.system.load_avg.join(' / ')}</span></div>
        </div>
      </div>
    `;

    // Resource gauges (#122: add CPU gauge)
    const resources = `
      <div class="health-gauges">
        ${d.cpu ? this._renderGauge('CPU', d.cpu.pct, d.cpu.status, `${d.cpu.cores} 核 · 负载 ${d.system.load_avg.join(' / ')}`) : ''}
        ${this._renderGauge('内存', d.memory.pct, d.memory.status, `${d.memory.used_gb}GB / ${d.memory.total_gb}GB`)}
        ${this._renderGauge('磁盘', d.disk.pct, d.disk.status, `${d.disk.used || '?'} / ${d.disk.total || '?'}`)}
      </div>
    `;

    // PM2 services table
    const pm2Section = this._renderPM2(d.pm2, statusIcon);

    // Footer
    const footer = `
      <div class="health-footer">
        最后检查: ${new Date(d.timestamp).toLocaleString('zh-CN')}
        <button class="btn-sm health-refresh-btn" onclick="HealthDiagnostics.fetch()">🔄 刷新</button>
      </div>
    `;

    this._container.innerHTML = banner + agentSection + serviceSection + sysInfo + resources + pm2Section + footer;
  },

  _renderAgentHealth(agents) {
    if (!agents || !agents.list || agents.list.length === 0) return '';

    const statusConfig = {
      active:        { icon: '🟢', label: '活跃', cls: 'health-ok' },
      idle:          { icon: '🟡', label: '在线/空闲', cls: 'health-warn' },
      recently_seen: { icon: '🟠', label: '近期活跃', cls: 'health-warn' },
      offline:       { icon: '🔴', label: '离线', cls: 'health-crit' },
      unknown:       { icon: '⚪', label: '未知', cls: '' },
    };

    const agentCards = agents.list.map(a => {
      const cfg = statusConfig[a.status] || statusConfig.unknown;
      const lastActiveStr = a.last_active ? this._formatTimeAgo(a.last_active) : '无记录';

      // System health indicators (#115)
      let sysHealthHtml = '';
      if (a.system_health) {
        const sh = a.system_health;
        const diskCls = sh.disk.status === 'critical' ? 'health-crit' : sh.disk.status === 'warning' ? 'health-warn' : 'health-ok';
        const memCls = sh.memory.status === 'critical' ? 'health-crit' : sh.memory.status === 'warning' ? 'health-warn' : 'health-ok';
        const diskIcon = sh.disk.status === 'critical' ? '🔴' : sh.disk.status === 'warning' ? '⚠️' : '✅';
        const memIcon = sh.memory.status === 'critical' ? '🔴' : sh.memory.status === 'warning' ? '⚠️' : '✅';

        // CPU indicator (#122)
        let cpuHtml = '';
        if (sh.cpu) {
          const cpuPct = sh.cpu.pct;
          const cpuStatus = cpuPct > 90 ? 'critical' : cpuPct > 80 ? 'warning' : 'ok';
          const cpuCls = cpuStatus === 'critical' ? 'health-crit' : cpuStatus === 'warning' ? 'health-warn' : 'health-ok';
          const cpuIcon = cpuStatus === 'critical' ? '🔴' : cpuStatus === 'warning' ? '⚠️' : '✅';
          const loadStr = sh.cpu.load_avg ? sh.cpu.load_avg.map(v => v.toFixed(1)).join(', ') : '?';
          cpuHtml = `<span class="${cpuCls}" title="CPU: ${esc(String(cpuPct))}% | 负载: ${esc(loadStr)} | ${esc(String(sh.cpu.cores || '?'))} 核">${cpuIcon} CPU ${esc(String(cpuPct))}%</span>`;
        }

        sysHealthHtml = `
          <div class="health-agent-sys">
            ${cpuHtml}
            <span class="${diskCls}" title="磁盘: ${esc(String(sh.disk.used || '?'))}/${esc(String(sh.disk.total || '?'))}">${diskIcon} 磁盘 ${sh.disk.pct != null ? esc(String(sh.disk.pct)) + '%' : '?'}</span>
            <span class="${memCls}" title="内存: ${esc(String(sh.memory.used_gb || '?'))}GB/${esc(String(sh.memory.total_gb || '?'))}GB">${memIcon} 内存 ${sh.memory.pct != null ? esc(String(sh.memory.pct)) + '%' : '?'}</span>
            ${sh.pm2 ? `<span title="PM2 服务">⚙️ ${esc(String(sh.pm2.online))}/${esc(String(sh.pm2.total))}</span>` : ''}
          </div>
        `;
      } else if (a.system_health_stale) {
        sysHealthHtml = '<div class="health-agent-sys"><span class="health-stale">📡 未报告系统状态</span></div>';
      }

      return `
        <div class="health-agent-card ${cfg.cls}">
          <div class="health-agent-header">
            <span class="health-agent-icon">${cfg.icon}</span>
            <span class="health-agent-name">${esc(a.name)}</span>
          </div>
          <div class="health-agent-detail">${cfg.label}</div>
          ${sysHealthHtml}
          <div class="health-agent-meta">
            <span>最近活动: ${lastActiveStr}</span>
            ${a.open_tasks > 0 ? `<span>待办: ${a.open_tasks}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="health-card">
        <div class="health-card-title">
          🤖 Agent 状态
          <span class="health-card-badge">${agents.online}/${agents.total} 在线</span>
        </div>
        <div class="health-agent-grid">${agentCards}</div>
      </div>
    `;
  },

  _renderServices(services) {
    if (!services || services.length === 0) return '';

    const rows = services.map(svc => {
      const isOk = svc.status === 'ok';
      const cls = isOk ? 'health-ok' : 'health-crit';
      const icon = isOk ? '🟢' : '🔴';
      const statusText = svc.http_status ? `${svc.http_status}` : '超时';
      const latency = svc.latency_ms != null ? `${svc.latency_ms}ms` : '—';
      return `
        <tr class="${cls}">
          <td>${icon} ${esc(svc.name)}</td>
          <td>${esc(svc.category)}</td>
          <td class="health-num">${statusText}</td>
          <td class="health-num">${latency}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="health-card">
        <div class="health-card-title">🌐 服务状态</div>
        <div class="health-table-wrap">
          <table class="health-table">
            <thead>
              <tr><th>服务</th><th>类别</th><th>状态码</th><th>延迟</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  },

  _renderPM2(pm2, statusIcon) {
    // Alert banner for down/errored services (#123)
    const downServices = pm2.services.filter(s => s.status !== 'online');
    const alertBanner = downServices.length > 0 ? `
      <div class="pm2-alert-banner">
        <span class="pm2-alert-icon">🚨</span>
        <span class="pm2-alert-text">${downServices.length} 个服务异常: ${downServices.map(s => esc(s.name) + ' (' + esc(s.status) + ')').join(', ')}</span>
      </div>
    ` : '';

    const pm2Rows = pm2.services.map(svc => {
      const svcClass = svc.status === 'online' ? 'health-ok' : 'health-crit';
      const mem = svc.memory ? `${Math.round(svc.memory / 1048576)}MB` : '—';
      const uptime = svc.uptime != null ? this._formatUptime(Math.floor(svc.uptime / 1000)) : '—';
      const restartBtn = svc.status !== 'online'
        ? `<button class="btn-pm2-restart btn-pm2-restart-urgent" data-service="${esc(svc.name)}" onclick="HealthDiagnostics._restartService('${esc(svc.name)}', this)">重启</button>`
        : `<button class="btn-pm2-restart" data-service="${esc(svc.name)}" onclick="HealthDiagnostics._restartService('${esc(svc.name)}', this)">重启</button>`;
      return `
        <tr class="${svcClass}">
          <td class="health-svc-name">${esc(svc.name)}</td>
          <td><span class="health-status-dot ${svcClass}"></span>${esc(svc.status)}</td>
          <td class="health-num">${svc.pid || '—'}</td>
          <td class="health-num">${mem}</td>
          <td class="health-num">${svc.cpu != null ? svc.cpu + '%' : '—'}</td>
          <td class="health-num">${uptime}</td>
          <td class="health-num">${svc.restarts}</td>
          <td class="health-num">${restartBtn}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="health-card">
        <div class="health-card-title">
          ${statusIcon[pm2.status]} PM2 服务
          <span class="health-card-badge">${pm2.online}/${pm2.total} 在线</span>
        </div>
        ${alertBanner}
        <div class="health-table-wrap">
          <table class="health-table">
            <thead>
              <tr>
                <th>服务</th><th>状态</th><th>PID</th><th>内存</th><th>CPU</th><th>运行时间</th><th>重启次数</th><th>操作</th>
              </tr>
            </thead>
            <tbody>${pm2Rows || '<tr><td colspan="8" class="health-empty">未检测到 PM2 服务</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;
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

  async _restartService(name, btn) {
    if (!confirm(`确定重启服务 "${name}"?`)) return;
    btn.disabled = true;
    btn.textContent = '重启中…';
    try {
      const r = await fetch(`${BASE}/api/pm2/${encodeURIComponent(name)}/restart`, {
        method: 'POST',
        headers: { 'X-API-Key': localStorage.getItem('health_api_key') || '' },
      });
      const data = await r.json();
      if (r.ok) {
        btn.textContent = '已重启';
        btn.classList.add('btn-pm2-restart-ok');
        setTimeout(() => this.fetch(), 2000);
      } else {
        btn.textContent = '失败';
        alert(`重启失败: ${data.error || '未知错误'}`);
      }
    } catch (e) {
      btn.textContent = '失败';
      alert(`重启失败: ${e.message}`);
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '重启';
      btn.classList.remove('btn-pm2-restart-ok');
    }, 5000);
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
  },

  _formatTimeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    return `${Math.floor(diff / 86400000)}天前`;
  }
};
