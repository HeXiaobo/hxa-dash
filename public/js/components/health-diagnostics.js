// System Health Diagnostics (#94, #104)
// Member runtime panel with host/resource/quota focus
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

    const d = this._data || {};
    const agents = this._extractAgentList(d.agents);
    const summary = this._buildSummary(agents);
    const statusIcon = { ok: '✅', warning: '⚠️', critical: '🔴' };
    const statusLabel = { ok: '正常', warning: '警告', critical: '异常' };
    const statusClass = { ok: 'health-ok', warning: 'health-warn', critical: 'health-crit' };
    const overallKey = statusClass[d.overall] ? d.overall : 'warning';

    const banner = `
      <div class="health-banner ${statusClass[overallKey]}">
        <span class="health-banner-icon">${statusIcon[overallKey]}</span>
        <span class="health-banner-text">系统状态: ${statusLabel[overallKey]}</span>
        <span class="health-banner-uptime">运行时间: ${this._formatUptime(d.uptime_seconds || d.uptime || 0)}</span>
      </div>
    `;

    const memberSection = this._renderMemberPanel(agents, summary);
    const systemSection = this._renderSystemPanel(d, summary);
    const serviceSection = this._renderServices(d.services);
    const pm2Section = this._renderPM2(this._normalizePM2(d.pm2), statusIcon);

    const footer = `
      <div class="health-footer">
        最后检查: ${this._formatDateTime(d.timestamp || Date.now())}
        <button class="btn-sm health-refresh-btn" onclick="HealthDiagnostics.fetch()">🔄 刷新</button>
      </div>
    `;

    this._container.innerHTML = banner + memberSection + systemSection + serviceSection + pm2Section + footer;
  },

  _renderMemberPanel(agents, summary) {
    if (!agents.length) {
      return `
        <div class="health-card">
          <div class="health-card-title">🤖 成员运行态</div>
          <div class="health-empty">暂无成员数据</div>
        </div>
      `;
    }

    const cards = agents.map(agent => {
      const runtimeState = this._normalizeRuntimeState(agent.runtime_status);
      const workState = this._normalizeWorkState(agent.work_status);
      const runtimeMeta = this._runtimeMeta(agent.runtime, agent.runtime_type, agent.version);
      const resource = agent.resources;
      const heartbeat = this._timeLabel(agent.last_heartbeat_at || agent.reported_at || agent.last_seen_at);
      const activity = this._timeLabel(agent.last_active_at || agent.last_active);
      const quota = this._renderQuota(agent.quota, runtimeMeta.type);
      const quotaStatus = quota ? quota.status : 'unsupported';
      const runtimeLabel = runtimeMeta.label || '';
      const runtimeVersion = runtimeMeta.version || agent.version;
      const workBadgeClass = workState.cls || 'health-stale';
      const hasHealthData = !!(agent.last_heartbeat_at || agent.resources?.disk || agent.resources?.memory);
      const isUnknownRuntime = !runtimeLabel || runtimeLabel === 'Unknown' || runtimeLabel === 'unknown';

      if (!hasHealthData) {
        return `
          <div class="health-agent-card health-agent-pending">
            <div class="health-agent-header">
              <span class="health-agent-icon">${workState.icon || '⚪'}</span>
              <span class="health-agent-name">${esc(agent.name || '未命名')}</span>
              <span class="${workBadgeClass}" style="margin-left:auto;font-size:11px;">${workState.label}</span>
            </div>
            <div class="health-agent-detail" style="margin-top:6px;">
              <span class="health-stale">待接入 · 健康上报未部署</span>
            </div>
            <div class="health-info-grid" style="margin-top:8px;">
              <div class="health-info-item">
                <span class="health-info-label">最后活动</span>
                <span class="health-info-value">${activity}</span>
              </div>
            </div>
          </div>
        `;
      }

      const host = agent.host || '';
      const runtimeBadgeClass = runtimeState.cls || 'health-stale';
      const versionStr = runtimeVersion ? ` v${runtimeVersion}` : '';

      return `
        <div class="health-agent-card">
          <div class="health-agent-header">
            <span class="health-agent-icon">${runtimeState.icon || '⚪'}</span>
            <span class="health-agent-name">${esc(agent.name || '未命名')}</span>
            <span class="${workBadgeClass}" style="margin-left:auto;font-size:11px;">${workState.label}</span>
          </div>
          <div class="health-agent-detail" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            ${!isUnknownRuntime ? `<span class="health-card-badge">${esc(runtimeLabel)}${esc(versionStr)}</span>` : ''}
            <span class="${runtimeBadgeClass}">${runtimeState.label}</span>
            ${host ? `<span class="health-card-badge" title="${esc(host)}">${esc(host.split('.')[0])}</span>` : ''}
          </div>
          <div class="health-info-grid" style="margin-top:8px;">
            <div class="health-info-item">
              <span class="health-info-label">最后心跳</span>
              <span class="health-info-value">${heartbeat}</span>
            </div>
            <div class="health-info-item">
              <span class="health-info-label">最后活动</span>
              <span class="health-info-value">${activity}</span>
            </div>
          </div>
          ${this._renderResourceChips(resource, agent.health_stale)}
          ${quota && quotaStatus === 'supported' ? `
            <div class="health-agent-meta" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px;">
              ${quota.summary.map(item => `<span class="health-card-badge">${esc(item)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="health-card">
        <div class="health-card-title">
          🤖 成员运行态
          <span class="health-card-badge">${summary.total} 名成员</span>
        </div>
        <div class="health-agent-grid">${cards}</div>
      </div>
    `;
  },

  _renderSystemPanel(d, summary) {
    const system = this._normalizeSystem(d);
    const badges = [];
    if (summary.running > 0) badges.push(`<span class="health-card-badge">运行中 ${summary.running}</span>`);
    if (summary.working > 0) badges.push(`<span class="health-card-badge">工作中 ${summary.working}</span>`);
    if (summary.standby > 0) badges.push(`<span class="health-card-badge">待命 ${summary.standby}</span>`);
    if (summary.offline > 0) badges.push(`<span class="health-card-badge">离线 ${summary.offline}</span>`);
    if (summary.quotaSupported > 0) badges.push(`<span class="health-card-badge">quota 支持 ${summary.quotaSupported}</span>`);
    if (summary.quotaUnsupported > 0) badges.push(`<span class="health-card-badge">quota 不支持 ${summary.quotaUnsupported}</span>`);

    return `
      <div class="health-card">
        <div class="health-card-title">
          🧭 系统总览
          <span class="health-card-badge">${system.hostname || 'unknown'}</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;">${badges.join('')}</div>
        <div class="health-info-grid">
          <div class="health-info-item">
            <span class="health-info-label">主机</span>
            <span class="health-info-value">${esc(system.hostname || '—')}</span>
          </div>
          <div class="health-info-item">
            <span class="health-info-label">平台</span>
            <span class="health-info-value">${esc(system.platform || '—')}</span>
          </div>
          <div class="health-info-item">
            <span class="health-info-label">CPU</span>
            <span class="health-info-value">${system.cpu}</span>
          </div>
          <div class="health-info-item">
            <span class="health-info-label">负载</span>
            <span class="health-info-value">${system.loadAvg}</span>
          </div>
          <div class="health-info-item">
            <span class="health-info-label">内存</span>
            <span class="health-info-value">${system.memory}</span>
          </div>
          <div class="health-info-item">
            <span class="health-info-label">磁盘</span>
            <span class="health-info-value">${system.disk}</span>
          </div>
          <div class="health-info-item">
            <span class="health-info-label">PM2</span>
            <span class="health-info-value">${system.pm2}</span>
          </div>
          <div class="health-info-item">
            <span class="health-info-label">数据更新时间</span>
            <span class="health-info-value">${this._formatDateTime(d.timestamp || Date.now())}</span>
          </div>
        </div>
      </div>
    `;
  },

  _renderResourceChips(resource, stale) {
    const chips = [];
    if (resource.cpu) {
      chips.push(`<span class="${resource.cpu.cls}">${resource.cpu.icon} CPU ${resource.cpu.pct != null ? esc(this._formatPercent(resource.cpu.pct)) : '—'}</span>`);
    }
    if (resource.memory) {
      chips.push(`<span class="${resource.memory.cls}">${resource.memory.icon} 内存 ${resource.memory.pct != null ? esc(this._formatPercent(resource.memory.pct)) : '—'}</span>`);
    }
    if (resource.disk) {
      chips.push(`<span class="${resource.disk.cls}">${resource.disk.icon} 磁盘 ${resource.disk.pct != null ? esc(this._formatPercent(resource.disk.pct)) : '—'}</span>`);
    }
    if (resource.pm2) {
      const pm2Online = resource.pm2.online ?? resource.pm2.running ?? 0;
      const pm2Total = resource.pm2.total ?? (Array.isArray(resource.pm2.services) ? resource.pm2.services.length : 0);
      chips.push(`<span class="${resource.pm2.cls || 'health-ok'}">${resource.pm2.icon || '⚙️'} PM2 ${pm2Online}/${pm2Total}</span>`);
    }
    if (!chips.length) {
      return stale ? `
        <div class="health-agent-sys" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
          <span class="health-stale">资源未上报</span>
        </div>
      ` : '';
    }
    return `
      <div class="health-agent-sys" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
        ${chips.join('')}
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
    if (!pm2) return '';

    const services = Array.isArray(pm2.services) ? pm2.services : [];
    const downServices = services.filter(s => s.status !== 'online');
    const alertBanner = downServices.length > 0 ? `
      <div class="pm2-alert-banner">
        <span class="pm2-alert-icon">🚨</span>
        <span class="pm2-alert-text">${downServices.length} 个服务异常: ${downServices.map(s => esc(s.name) + ' (' + esc(s.status) + ')').join(', ')}</span>
      </div>
    ` : '';

    const pm2Rows = services.map(svc => {
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
          ${statusIcon[pm2.status] || '⚙️'} PM2 服务
          <span class="health-card-badge">${pm2.online || 0}/${pm2.total || 0} 在线</span>
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

  _renderQuota(quota, runtimeType) {
    const q = this._asObject(quota);
    const supported = q.supported !== false && q.unsupported !== true;
    const unsupportedByRuntime = /openclaw/i.test(String(runtimeType || ''));
    if (!supported || unsupportedByRuntime) {
      return {
        status: 'unsupported',
        label: 'unsupported',
        summary: ['quota 不支持'],
      };
    }

    if (!q || Object.keys(q).length === 0) {
      return null;
    }

    const items = [];
    const primary = this._normalizeQuotaWindow(q.primary || q.primary_limit || q.five_hour || q['5h'] || q.fiveh || q.limit_5h || q.limit5h, '5h');
    const secondary = this._normalizeQuotaWindow(q.secondary || q.secondary_limit || q.seven_day || q['7d'] || q.sevend || q.limit_7d || q.limit7d, '7d');

    if (primary) items.push(primary);
    if (secondary) items.push(secondary);

    if (!items.length) {
      const used = q.used_percent != null ? `${this._formatPercent(q.used_percent)} 已用` : null;
      const reset = q.resets_at ? `重置 ${this._formatTimeAgo(q.resets_at)}` : null;
      const fallback = [used, reset].filter(Boolean).join(' · ');
      if (fallback) items.push(fallback);
    }

    return {
      status: 'supported',
      label: 'supported',
      summary: items.length ? items : ['quota 已就绪'],
    };
  },

  _normalizeQuotaWindow(window, fallbackLabel) {
    const q = this._asObject(window);
    if (!q || Object.keys(q).length === 0) return null;

    const label = q.label || q.name || q.window || fallbackLabel;
    const usedPercent = this._normalizePercentValue(q.used_percent ?? q.used ?? q.percent ?? q.ratio);
    const resetAt = q.resets_at || q.reset_at || q.next_reset_at || q.resetTime;
    const remaining = this._normalizePercentValue(q.remaining_percent ?? q.remaining);
    const pieces = [];
    if (usedPercent != null) pieces.push(`${label} ${this._formatPercent(usedPercent)} 已用`);
    if (remaining != null) pieces.push(`${this._formatPercent(remaining)} 剩余`);
    if (resetAt) pieces.push(`重置 ${this._formatTimeAgo(resetAt)}`);
    if (!pieces.length) return `${label}`;
    return pieces.join(' · ');
  },

  _normalizePM2(pm2) {
    const value = this._asObject(pm2);
    if (!value || Object.keys(value).length === 0) return null;
    return {
      ...value,
      services: Array.isArray(value.services) ? value.services : [],
    };
  },

  _normalizeSystem(d) {
    const system = this._asObject(d.system);
    const loadAvg = this._arrayText(system.load_avg || d.load_avg || d.system?.load_avg);
    return {
      hostname: system.hostname || d.hostname || '—',
      platform: system.platform || d.platform || '—',
      cpu: this._systemCpuText(d),
      loadAvg,
      memory: this._systemMemoryText(d),
      disk: this._systemDiskText(d),
      pm2: this._systemPM2Text(d),
    };
  },

  _systemCpuText(d) {
    const cpu = this._asObject(d.cpu || d.system?.cpu);
    if (!cpu || Object.keys(cpu).length === 0) return '—';
    const cores = cpu.cores || cpu.count || d.system?.cpu_count || '?';
    const model = cpu.model || cpu.name || d.system?.cpu_model || '';
    return [cores ? `${cores} 核` : null, model].filter(Boolean).join(' · ') || '—';
  },

  _systemMemoryText(d) {
    const memory = this._asObject(d.memory || d.system?.memory);
    if (!memory || Object.keys(memory).length === 0) return '—';
    const used = memory.used_gb ?? memory.used ?? memory.used_mb;
    const total = memory.total_gb ?? memory.total ?? memory.total_mb;
    if (used != null && total != null) return `${used} / ${total}`;
    const pct = memory.pct ?? memory.percent;
    return pct != null ? `${this._formatPercent(pct)}` : '—';
  },

  _systemDiskText(d) {
    const disk = this._asObject(d.disk || d.system?.disk);
    if (!disk || Object.keys(disk).length === 0) return '—';
    const used = disk.used || disk.used_gb || disk.used_mb;
    const total = disk.total || disk.total_gb || disk.total_mb;
    if (used != null && total != null) return `${used} / ${total}`;
    const pct = disk.pct ?? disk.percent;
    return pct != null ? `${this._formatPercent(pct)}` : '—';
  },

  _systemPM2Text(d) {
    const pm2 = this._asObject(d.pm2);
    if (!pm2 || Object.keys(pm2).length === 0) return '—';
    const online = pm2.online ?? pm2.running ?? 0;
    const total = pm2.total ?? (Array.isArray(pm2.services) ? pm2.services.length : 0);
    return `${online}/${total}`;
  },

  _buildSummary(agents) {
    const summary = {
      total: agents.length,
      running: 0,
      working: 0,
      standby: 0,
      offline: 0,
      quotaSupported: 0,
      quotaUnsupported: 0,
    };

    agents.forEach(agent => {
      const runtimeState = this._normalizeRuntimeState(agent.runtime_status);
      const workState = this._normalizeWorkState(agent.work_status);
      if (runtimeState.key === 'running') summary.running += 1;
      if (workState.key === 'working') summary.working += 1;
      if (workState.key === 'standby') summary.standby += 1;
      if (workState.key === 'offline' || runtimeState.key === 'offline') summary.offline += 1;

      const quota = this._renderQuota(agent.quota, this._runtimeMeta(agent.runtime, agent.runtime_type).type);
      if (quota) {
        if (quota.status === 'unsupported') summary.quotaUnsupported += 1;
        else summary.quotaSupported += 1;
      }
    });

    return summary;
  },

  _extractAgentList(source) {
    if (Array.isArray(source)) return source.map(a => this._normalizeAgent(a));
    if (!source || typeof source !== 'object') return [];
    const candidates = source.list || source.items || source.data || source.agents || source.members || [];
    if (Array.isArray(candidates)) return candidates.map(a => this._normalizeAgent(a));
    return [];
  },

  _normalizeAgent(agent) {
    const raw = this._asObject(agent);
    const runtimeObj = this._asObject(raw.runtime);
    const healthObj = this._asObject(raw.system_health || raw.health || raw.hardware || raw.resources);
    const quotaObj = this._asObject(raw.quota || raw.limits || runtimeObj.quota || runtimeObj.limits);
    const runtimeType = runtimeObj.type || raw.runtime_type || raw.runtime_name || (typeof raw.runtime === 'string' ? raw.runtime : '') || raw.agent_runtime || raw.runtime_label;
    const version = runtimeObj.version || raw.runtime_version || raw.version || raw.build_version || raw.build || raw.release;
    const runtimeStatus = runtimeObj.status || raw.runtime_status || raw.runtimeState || raw.service_status || healthObj.runtime_status || raw.status;
    const workStatus = raw.work_status || raw.state || raw.workState || raw.activity_status || raw.tier_status || raw.status;
    const heartbeatAt = raw.last_heartbeat_at || raw.last_heartbeat || raw.heartbeat_at || raw.reported_at || healthObj.reported_at || runtimeObj.last_heartbeat_at || runtimeObj.last_heartbeat || raw.updated_at;
    const lastActiveAt = raw.last_active_at || raw.last_active || raw.activity_at || raw.last_event_at || raw.latest_event_at || raw.updated_at;
    const host = raw.host || raw.hostname || raw.node || raw.machine || raw.system?.hostname || healthObj.hostname || runtimeObj.host || runtimeObj.hostname;

    return {
      ...raw,
      runtime: runtimeObj,
      runtime_status: runtimeStatus,
      work_status: workStatus,
      runtime_type: runtimeType,
      version,
      host,
      last_heartbeat_at: heartbeatAt,
      last_active_at: lastActiveAt,
      health_stale: Boolean(raw.system_health_stale || raw.health_stale || healthObj.stale),
      resources: this._normalizeResources(healthObj, raw),
      quota: quotaObj,
    };
  },

  _normalizeResources(healthObj, raw) {
    const system = this._asObject(healthObj);
    const top = this._asObject(raw);
    const disk = this._normalizeResourceBlock(system.disk || system.storage || top.disk, 'disk');
    const memory = this._normalizeResourceBlock(system.memory || system.mem || top.memory, 'memory');
    const cpu = this._normalizeResourceBlock(system.cpu || top.cpu, 'cpu');
    const pm2 = this._normalizePM2(system.pm2 || top.pm2);
    return { disk, memory, cpu, pm2 };
  },

  _normalizeResourceBlock(block, type) {
    const value = this._asObject(block);
    if (!value || Object.keys(value).length === 0) return null;

    const pct = this._normalizePercentValue(value.pct ?? value.percent ?? value.usage_percent ?? value.used_percent);
    const used = value.used_gb ?? value.used_mb ?? value.used ?? value.usedBytes;
    const total = value.total_gb ?? value.total_mb ?? value.total ?? value.totalBytes;
    const status = value.status || this._statusFromPercent(pct);
    const cls = status === 'critical' ? 'health-crit' : status === 'warning' ? 'health-warn' : 'health-ok';
    const icon = status === 'critical' ? '🔴' : status === 'warning' ? '⚠️' : '✅';
    const label = type === 'cpu'
      ? `${this._formatPercent(pct)}`
      : used != null && total != null
        ? `${used} / ${total}`
        : pct != null
          ? `${this._formatPercent(pct)}`
          : '—';

    return {
      ...value,
      pct,
      used,
      total,
      status,
      cls,
      icon,
      label,
    };
  },

  _runtimeMeta(runtime, fallbackType, fallbackVersion) {
    const r = this._asObject(runtime);
    const type = r.type || r.name || r.runtime_type || r.label || fallbackType;
    const version = r.version || r.build || r.release || r.runtime_version || fallbackVersion;
    return {
      type: this._runtimeLabel(type),
      version: version || null,
      label: this._runtimeLabel(type),
    };
  },

  _runtimeLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const low = raw.toLowerCase();
    if (low.includes('claude')) return 'Claude Code';
    if (low.includes('codex')) return 'Codex';
    if (low.includes('openclaw')) return 'OpenClaw';
    if (low === 'cli') return 'CLI';
    return raw;
  },

  _normalizeRuntimeState(value) {
    const raw = String(value || '').toLowerCase();
    if (!raw) return { key: 'unknown', label: '未知', icon: '⚪', cls: '' };
    if (['running', 'online', 'healthy', 'active'].includes(raw)) {
      return { key: 'running', label: '运行中', icon: '🟢', cls: 'health-ok' };
    }
    if (['degraded', 'warning', 'warn', 'partial'].includes(raw)) {
      return { key: 'degraded', label: '待校验', icon: '⚠️', cls: 'health-warn' };
    }
    if (['offline', 'down', 'error', 'errored', 'stopped'].includes(raw)) {
      return { key: 'offline', label: '离线', icon: '🔴', cls: 'health-crit' };
    }
    return { key: 'unknown', label: this._prettyLabel(value), icon: '⚪', cls: 'health-stale' };
  },

  _normalizeWorkState(value) {
    const raw = String(value || '').toLowerCase();
    if (!raw) return { key: 'unknown', label: '未知', icon: '⚪', cls: 'health-stale' };
    if (['working', 'busy', 'active', 'engaged'].includes(raw)) {
      return { key: 'working', label: '工作中', icon: '🟢', cls: 'health-ok' };
    }
    if (['standby', 'idle', 'online', 'recently_seen', 'available'].includes(raw)) {
      return { key: 'standby', label: '待命', icon: '🟡', cls: 'health-warn' };
    }
    if (['offline', 'inactive', 'away', 'disconnected'].includes(raw)) {
      return { key: 'offline', label: '离线', icon: '⚫', cls: 'health-crit' };
    }
    return { key: 'unknown', label: this._prettyLabel(value), icon: '⚪', cls: 'health-stale' };
  },

  _statusFromPercent(pct) {
    const n = this._normalizePercentValue(pct);
    if (!Number.isFinite(n)) return 'ok';
    if (n >= 90) return 'critical';
    if (n >= 80) return 'warning';
    return 'ok';
  },

  _prettyLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '未知';
    return raw.replace(/_/g, ' ');
  },

  _asObject(value) {
    if (!value || typeof value !== 'object') return {};
    if (Array.isArray(value)) return {};
    return value;
  },

  _arrayText(value) {
    if (!Array.isArray(value)) return '—';
    return value.map(v => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : String(v))).join(' / ');
  },

  _toMs(value) {
    if (value == null) return null;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    const raw = String(value).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      return n < 1e12 ? n * 1000 : n;
    }
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  },

  _timeLabel(value) {
    const ms = this._toMs(value);
    if (!ms) return '<span class="health-stale">无记录</span>';
    return `<span title="${esc(this._formatDateTime(ms))}">${esc(this._formatTimeAgo(ms))}</span>`;
  },

  _formatDateTime(value) {
    const ms = this._toMs(value);
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  },

  _formatPercent(value) {
    const n = this._normalizePercentValue(value);
    if (!Number.isFinite(n)) return '—';
    return `${Math.round(n)}%`;
  },

  _normalizePercentValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NaN;
    if (n > 0 && n <= 1) return n * 100;
    return n;
  },

  _formatTimeAgo(ts) {
    const ms = this._toMs(ts);
    if (!ms) return '—';
    const diff = Date.now() - ms;
    if (diff >= 0) {
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
      return `${Math.floor(diff / 86400000)}天前`;
    }
    const future = Math.abs(diff);
    if (future < 60000) return '马上';
    if (future < 3600000) return `${Math.floor(future / 60000)}分钟后`;
    if (future < 86400000) return `${Math.floor(future / 3600000)}小时后`;
    return `${Math.floor(future / 86400000)}天后`;
  },

  _formatUptime(seconds) {
    const n = Number(seconds) || 0;
    if (n < 60) return `${n}秒`;
    if (n < 3600) return `${Math.floor(n / 60)}分钟`;
    if (n < 86400) {
      const h = Math.floor(n / 3600);
      const m = Math.floor((n % 3600) / 60);
      return `${h}小时${m}分`;
    }
    const d = Math.floor(n / 86400);
    const h = Math.floor((n % 86400) / 3600);
    return `${d}天${h}小时`;
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
};
