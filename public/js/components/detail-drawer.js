// Agent Detail Drawer Component
const DetailDrawer = {
  drawer: null,
  body: null,
  dialog: null,
  previouslyFocused: null,
  openerName: null,
  backgroundStates: [],
  bodyStyle: null,
  requestId: 0,

  init() {
    this.drawer = document.getElementById('detail-drawer');
    this.body = document.getElementById('drawer-body');
    this.dialog = this.drawer?.querySelector('.drawer-content');
    if (!this.drawer || !this.body || !this.dialog) return;

    // Close handlers
    this.drawer.querySelector('.drawer-overlay').addEventListener('click', () => this.close());
    this.drawer.querySelector('.drawer-close').addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
        return;
      }
      if (e.key === 'Tab') this._trapFocus(e);
    });
  },

  async open(name, opener = null) {
    const currentRequest = ++this.requestId;
    this.previouslyFocused = opener instanceof HTMLElement ? opener : document.activeElement;
    this.openerName = name;
    try {
      const res = await fetch(`${BASE}/api/team/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error('Not found');
      const data = await res.json();
      if (currentRequest !== this.requestId) return;
      this.renderDetail(data);
      this.drawer.classList.remove('hidden');
      this.drawer.setAttribute('aria-hidden', 'false');
      this._lockBackground();
      requestAnimationFrame(() => {
        const title = document.getElementById('drawer-title');
        (title || this.dialog).focus({ preventScroll: true });
      });

      // Async-load output trends (#127) + hardware (#122)
      this._loadOutputSection(name);
      this._loadHardwareSection(name);
    } catch (err) {
      console.error('Failed to load agent detail:', err);
      if (currentRequest !== this.requestId) return;
      this.body.innerHTML = `
        <div class="drawer-header">
          <h3 id="drawer-title" tabindex="-1">员工详情暂不可用</h3>
          <p class="drawer-bio">无法读取该员工的详情，请稍后重试。</p>
        </div>`;
      this.drawer.classList.remove('hidden');
      this.drawer.setAttribute('aria-hidden', 'false');
      this._lockBackground();
      requestAnimationFrame(() => document.getElementById('drawer-title')?.focus({ preventScroll: true }));
    }
  },

  isOpen() {
    return !!this.drawer && !this.drawer.classList.contains('hidden');
  },

  _lockBackground() {
    if (this.backgroundStates.length) return;
    const excluded = new Set([this.drawer]);
    const elements = Array.from(document.body.children).filter(element => (
      !excluded.has(element)
      && !['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName)
    ));
    this.backgroundStates = elements.map(element => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden')
    }));
    this.backgroundStates.forEach(({ element }) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });

    const scrollbarGap = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    this.bodyStyle = {
      overflow: document.body.style.overflow,
      paddingRight: document.body.style.paddingRight
    };
    document.body.classList.add('drawer-open');
    document.body.style.overflow = 'hidden';
    if (scrollbarGap) document.body.style.paddingRight = `${scrollbarGap}px`;
  },

  _unlockBackground() {
    this.backgroundStates.forEach(({ element, inert, ariaHidden }) => {
      element.inert = inert;
      if (ariaHidden == null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', ariaHidden);
    });
    this.backgroundStates = [];

    document.body.classList.remove('drawer-open');
    if (this.bodyStyle) {
      document.body.style.overflow = this.bodyStyle.overflow;
      document.body.style.paddingRight = this.bodyStyle.paddingRight;
      this.bodyStyle = null;
    }
  },

  _focusableElements() {
    return Array.from(this.dialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(element => (
      !element.hidden
      && element.getAttribute('aria-hidden') !== 'true'
      && element.getClientRects().length > 0
    ));
  },

  _trapFocus(event) {
    const focusable = this._focusableElements();
    if (!focusable.length) {
      event.preventDefault();
      this.dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (
      active === first
      || active === this.dialog
      || active === document.getElementById('drawer-title')
      || !this.dialog.contains(active)
    )) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  },

  async _loadOutputSection(name) {
    const placeholder = document.getElementById('drawer-output-section');
    if (!placeholder) return;
    placeholder.innerHTML = '<div class="output-loading">加载产出数据…</div>';
    const data = await MemberOutput.fetch(name);
    if (data) {
      placeholder.innerHTML = MemberOutput.renderSection(data);
    } else {
      placeholder.innerHTML = '';
    }
  },

  async _loadHardwareSection(name) {
    const el = document.getElementById('drawer-hardware-section');
    if (!el) return;
    try {
      const res = await fetch(`${BASE}/api/agent-health/${encodeURIComponent(name)}`);
      if (!res.ok) { el.innerHTML = ''; return; }
      const data = await res.json();
      if (!data.health || data.stale) { el.innerHTML = ''; return; }
      el.innerHTML = this._renderHardware(data);
    } catch { el.innerHTML = ''; }
  },

  _renderHardware(data) {
    const h = data.health;
    const fmtTok = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return '—';
      if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(Math.round(n));
    };
    const gauge = (label, pct, status, detail) => {
      if (pct == null) return '';
      const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
      const cls = status === 'critical' ? 'hw-crit' : status === 'warning' ? 'hw-warn' : 'hw-ok';
      return `<div class="drawer-hw-gauge">
        <div class="drawer-hw-bar-wrap">
          <div class="drawer-hw-bar ${cls}" style="width:${safePct}%"></div>
        </div>
        <div class="drawer-hw-info"><span class="drawer-hw-label">${esc(label)}</span><span class="drawer-hw-val">${safePct}%</span></div>
        ${detail ? `<div class="drawer-hw-detail">${esc(detail)}</div>` : ''}
      </div>`;
    };

    const diskDetail = h.disk ? `${h.disk.used || '?'} / ${h.disk.total || '?'}` : '';
    const memDetail = h.memory ? `${h.memory.used_gb || '?'}GB / ${h.memory.total_gb || '?'}GB` : '';
    const cpuDetail = h.cpu && h.cpu.load_avg ? `负载: ${h.cpu.load_avg.join(' / ')}` : '';

    const services = Array.isArray(h.pm2?.services) ? h.pm2.services : [];
    const serviceSummary = services.length
      ? ` · ${services.map(service => `${service.name || '未命名服务'} ${service.status || 'unknown'}`).join(' · ')}`
      : '';
    const pm2HTML = h.pm2
      ? `<div class="drawer-hw-pm2">PM2: ${h.pm2.online}/${h.pm2.total} 在线${esc(serviceSummary)}</div>`
      : '';
    const usageEntries = h.usage && typeof h.usage === 'object' ? Object.entries(h.usage) : [];
    const usageHTML = usageEntries.map(([runtime, usage]) => {
      if (!usage?.supported) return '';
      const tokens = usage.session_tokens || {};
      const total = tokens.total ?? ((tokens.input || 0) + (tokens.output || 0));
      const cache = (tokens.cache_creation || 0) + (tokens.cache_read || 0) + (tokens.cached_input || 0);
      const bits = [
        total ? `用量 ${fmtTok(total)}` : null,
        tokens.output != null ? `输出 ${fmtTok(tokens.output)}` : null,
        cache ? `缓存 ${fmtTok(cache)}` : null,
        tokens.reasoning ? `推理 ${fmtTok(tokens.reasoning)}` : null,
        usage.session_cost_usd != null ? `估算 $${Number(usage.session_cost_usd).toFixed(2)}` : null,
      ].filter(Boolean);
      return bits.length
        ? `<div class="drawer-hw-pm2">${esc(runtime)}: ${esc(bits.join(' · '))}</div>`
        : '';
    }).join('');
    const reportedAgo = data.health.reported_at ? timeAgo(data.health.reported_at) : '';

    return `<div class="drawer-section">
      <h4>采集明细 <span style="font-weight:normal;color:var(--text-secondary);font-size:12px;">${reportedAgo}上报</span></h4>
      ${gauge('磁盘', h.disk?.pct, h.disk?.status, diskDetail)}
      ${gauge('内存', h.memory?.pct, h.memory?.status, memDetail)}
      ${gauge('CPU', h.cpu?.pct, h.cpu?.pct >= 90 ? 'critical' : h.cpu?.pct >= 80 ? 'warning' : 'ok', cpuDetail)}
      ${pm2HTML}
      ${usageHTML}
    </div>`;
  },

  _renderMonitoring(agent) {
    const monitoring = agent.monitoring || {};
    const system = monitoring.system || {};
    const capacity = monitoring.capacity || {};
    const tokens = monitoring.tokens || {};
    const collection = RuntimeCenter._collectionState(monitoring);
    const work = RuntimeCenter._workState(agent);
    const anomalies = RuntimeCenter._anomalyFacts(agent);
    const versions = RuntimeCenter._versionsLabel(agent);
    const observedAt = this._formatObservedAt(monitoring.observed_at);
    const backup = this._monitoringBackupLabel(monitoring.backup);

    const systemText = [
      `CPU ${RuntimeCenter._factPercent(system.cpu_pct)}`,
      `内存 ${RuntimeCenter._factPercent(system.memory_pct)}`,
      `磁盘 ${RuntimeCenter._factPercent(system.disk_pct)}`
    ].join(' · ');
    const pm2Text = system.pm2_online == null && system.pm2_total == null
      ? '未采集'
      : `${RuntimeCenter._factNumber(system.pm2_online)}/${RuntimeCenter._factNumber(system.pm2_total)} 在线`;
    const contextText = [
      RuntimeCenter._factPercent(capacity.context_pct),
      RuntimeCenter._factTokens(capacity.context_tokens)
    ].join(' · ');
    const tokenText = [
      `会话 ${RuntimeCenter._factTokens(tokens.session_total)}`,
      `最近一轮 ${RuntimeCenter._factTokens(tokens.last_turn_total)}`,
      `成本 ${tokens.cost_usd == null ? '未采集' : `$${Number(tokens.cost_usd).toFixed(2)}`}`
    ].join(' · ');

    return `<div class="drawer-section monitoring-detail-section">
      <h4>运行事实</h4>
      <div class="monitoring-detail-states">
        <span class="runtime-pill ${collection.cls}">${esc(collection.label)}</span>
        <span class="runtime-pill ${work.cls}">${esc(work.label)}</span>
      </div>
      <dl class="monitoring-detail-grid">
        ${this._monitoringDetailFact('最近采集', observedAt)}
        ${this._monitoringDetailFact('系统资源', systemText)}
        ${this._monitoringDetailFact('PM2 服务', pm2Text)}
        ${this._monitoringDetailFact('Context', contextText)}
        ${this._monitoringDetailFact('Token', tokenText)}
        ${this._monitoringDetailFact(
          '5 小时额度',
          RuntimeCenter._factPercent(capacity.five_hour_pct),
          this._formatResetAt(capacity.five_hour_resets_at)
        )}
        ${this._monitoringDetailFact(
          '7 天额度',
          RuntimeCenter._factPercent(capacity.seven_day_pct),
          this._formatResetAt(capacity.seven_day_resets_at)
        )}
        ${this._monitoringDetailFact('Runtime / 版本', versions)}
        ${this._monitoringDetailFact('最近成功备份', backup.label, backup.note)}
      </dl>
      <div class="monitoring-detail-anomalies">
        <h4>异常事实</h4>
        ${anomalies.length
          ? `<ul>${anomalies.map(item => `<li class="${item.risk.cls}">${esc(item.risk.detail || item.risk.label)}</li>`).join('')}</ul>`
          : `<p>${agent.monitoring ? '无异常事实' : '未采集'}</p>`}
      </div>
    </div>`;
  },

  _monitoringDetailFact(label, value, note = '') {
    return `<div class="monitoring-detail-fact">
      <dt>${esc(label)}</dt>
      <dd>${esc(value || '未采集')}${note ? `<small>${esc(note)}</small>` : ''}</dd>
    </div>`;
  },

  _formatObservedAt(value) {
    if (!value) return '未采集';
    const timestamp = typeof value === 'number' ? value : new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return '未采集';
    return `${new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(timestamp))}（${timeAgo(timestamp)}）`;
  },

  _formatResetAt(value) {
    if (!value) return '重置时间 未采集';
    const timestamp = typeof value === 'number' ? value : new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return '重置时间 未采集';
    return `重置 ${new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp))}`;
  },

  _monitoringBackupLabel(backup) {
    if (!backup || (
      backup.last_success_at == null
      && ['unsupported', 'unknown', ''].includes(String(backup.status || '').toLowerCase())
    )) {
      return { label: '未采集', note: '' };
    }
    const labels = {
      ok: '正常',
      warning: '需确认',
      critical: '异常',
      unsupported: '未采集'
    };
    return {
      label: labels[String(backup.status || '').toLowerCase()] || '未采集',
      note: backup.last_success_at
        ? this._formatObservedAt(backup.last_success_at)
        : '成功时间 未采集'
    };
  },

  close({ restoreFocus = true } = {}) {
    if (!this.drawer || !this.isOpen()) return;
    this.requestId += 1;
    this.drawer.classList.add('hidden');
    this.drawer.setAttribute('aria-hidden', 'true');
    this._unlockBackground();
    let returnTarget = this.previouslyFocused;
    if (!returnTarget || !returnTarget.isConnected || returnTarget === document.body) {
      returnTarget = Array.from(document.querySelectorAll('.runtime-agent-card[data-name]'))
        .find(element => (
          element.dataset.name === this.openerName
          && element.closest('.page.active')
        )) || null;
    }
    this.previouslyFocused = null;
    this.openerName = null;
    if (restoreFocus && returnTarget instanceof HTMLElement && returnTarget.isConnected) {
      requestAnimationFrame(() => returnTarget.focus({ preventScroll: true }));
    }
  },

  // Group events by day and render activity timeline (#46)
  _renderActivityTimeline(events) {
    const grouped = {};
    events.forEach(e => {
      const d = new Date(e.timestamp);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(e);
    });

    const dayLabels = (key) => {
      const today = new Date(); today.setHours(0,0,0,0);
      const d = new Date(key + 'T00:00:00');
      const diff = Math.floor((today - d) / 86400000);
      if (diff === 0) return '今天';
      if (diff === 1) return '昨天';
      if (diff < 7) return `${diff} 天前`;
      return key;
    };

    const days = Object.keys(grouped).sort().reverse();
    const totalEvents = events.length;

    return `
      <div class="drawer-section">
        <h4>工作时间线 <span style="font-weight:normal;color:var(--text-secondary);font-size:12px;">(近7天 · ${totalEvents} 条)</span></h4>
        <div class="activity-timeline">
          ${days.map(day => `
            <div class="at-day-group">
              <div class="at-day-label">${dayLabels(day)} <span class="at-day-date">${day}</span> <span class="at-day-count">${grouped[day].length}</span></div>
              <div class="at-events">
                ${grouped[day].map(e => {
                  const time = new Date(e.timestamp);
                  const hm = String(time.getHours()).padStart(2,'0') + ':' + String(time.getMinutes()).padStart(2,'0');
                  const url = e.url || e.target_url || '';
                  const title = e.target_title || '';
                  const titleHtml = url
                    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="at-link">${esc(truncate(title, 60))}</a>`
                    : `<span>${esc(truncate(title, 60))}</span>`;
                  return `
                    <div class="at-event">
                      <span class="at-time">${hm}</span>
                      <span class="at-action">${esc(e.action)}</span>
                      ${titleHtml}
                      ${e.project ? `<span class="at-project">${esc(e.project)}</span>` : ''}
                    </div>`;
                }).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
  },

  renderDetail(data) {
    const {
      agent = {},
      current_tasks: currentTasks = [],
      recent_done: recentDone = [],
      events = [],
      collabs = [],
      stats = {}
    } = data || {};

    this.body.innerHTML = `
      <div class="drawer-header">
        <h3 id="drawer-title" tabindex="-1">${esc(agent.name || '未命名员工')}</h3>
        <div class="drawer-role">${esc(agent.role || '—')}</div>
        ${agent.bio ? `<div class="drawer-bio">${esc(agent.bio)}</div>` : ''}
      </div>

      ${this._renderMonitoring(agent)}

      <div class="drawer-section">
        <h4>统计</h4>
        <div class="drawer-stat-grid">
          <div class="stat-box">
            <div class="stat-num">${Number(stats.open_tasks || 0)}</div>
            <div class="stat-label">进行中</div>
          </div>
          <div class="stat-box">
            <div class="stat-num">${Number(stats.closed_tasks || 0)}</div>
            <div class="stat-label">已完成</div>
          </div>
          <div class="stat-box">
            <div class="stat-num">${Number(stats.mr_count || 0)}</div>
            <div class="stat-label">MR</div>
          </div>
          <div class="stat-box">
            <div class="stat-num">${Number(stats.issue_count || 0)}</div>
            <div class="stat-label">Issue</div>
          </div>
        </div>
      </div>

      <div id="drawer-output-section"></div>
      <div id="drawer-hardware-section"></div>

      ${currentTasks.length > 0 ? `
        <div class="drawer-section">
          <h4>当前工作 (${currentTasks.length})</h4>
          <ul class="drawer-task-list">
            ${currentTasks.map(t => `
              <li>
                <a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" style="color: var(--accent); text-decoration: none;">
                  ${esc(t.title)}
                </a>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
                  ${esc(t.project)} · ${t.type}
                </div>
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}

      ${recentDone.length > 0 ? `
        <div class="drawer-section">
          <h4>近期完成 (${recentDone.length})</h4>
          <ul class="drawer-task-list">
            ${recentDone.slice(0, 8).map(t => `
              <li>
                <a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" style="color: var(--text); text-decoration: none;">
                  ${esc(t.title)}
                </a>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
                  ${esc(t.project)} · ${t.type} · ${t.state}
                </div>
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}

      ${collabs.length > 0 ? `
        <div class="drawer-section">
          <h4>协作伙伴</h4>
          <ul class="drawer-collab-list">
            ${collabs.map(c => `
              <li>
                <span>${esc(c.partner)} <span class="collab-type">${esc(c.type)}</span></span>
                <span class="collab-weight">${c.weight}x</span>
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}

      ${events.length > 0 ? this._renderActivityTimeline(events) : ''}
    `;
  }
};
