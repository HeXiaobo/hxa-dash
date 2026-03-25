// Agent Detail Drawer Component
const DetailDrawer = {
  drawer: null,
  body: null,

  init() {
    this.drawer = document.getElementById('detail-drawer');
    this.body = document.getElementById('drawer-body');

    // Close handlers
    this.drawer.querySelector('.drawer-overlay').addEventListener('click', () => this.close());
    this.drawer.querySelector('.drawer-close').addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  },

  async open(name) {
    try {
      const res = await fetch(`${BASE}/api/team/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error('Not found');
      const data = await res.json();
      this.renderDetail(data);
      this.drawer.classList.remove('hidden');

      // Async-load output trends (#127) + hardware (#122)
      this._loadOutputSection(name);
      this._loadHardwareSection(name);
    } catch (err) {
      console.error('Failed to load agent detail:', err);
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
    const gauge = (label, pct, status, detail) => {
      if (pct == null) return '';
      const cls = status === 'critical' ? 'hw-crit' : status === 'warning' ? 'hw-warn' : 'hw-ok';
      return `<div class="drawer-hw-gauge">
        <div class="drawer-hw-bar-wrap">
          <div class="drawer-hw-bar ${cls}" style="width:${pct}%"></div>
        </div>
        <div class="drawer-hw-info"><span class="drawer-hw-label">${label}</span><span class="drawer-hw-val">${pct}%</span></div>
        ${detail ? `<div class="drawer-hw-detail">${esc(detail)}</div>` : ''}
      </div>`;
    };

    const diskDetail = h.disk ? `${h.disk.used || '?'} / ${h.disk.total || '?'}` : '';
    const memDetail = h.memory ? `${h.memory.used_gb || '?'}GB / ${h.memory.total_gb || '?'}GB` : '';
    const cpuDetail = h.cpu && h.cpu.load_avg ? `负载: ${h.cpu.load_avg.join(' / ')}` : '';

    const pm2HTML = h.pm2 ? `<div class="drawer-hw-pm2">⚙️ PM2: ${h.pm2.online}/${h.pm2.total} 在线</div>` : '';
    const reportedAgo = data.health.reported_at ? timeAgo(data.health.reported_at) : '';

    return `<div class="drawer-section">
      <h4>硬件资源 <span style="font-weight:normal;color:var(--text-secondary);font-size:12px;">${reportedAgo}上报</span></h4>
      ${gauge('💾 磁盘', h.disk?.pct, h.disk?.status, diskDetail)}
      ${gauge('🧠 内存', h.memory?.pct, h.memory?.status, memDetail)}
      ${gauge('⚡ CPU', h.cpu?.pct, h.cpu?.pct > 90 ? 'critical' : h.cpu?.pct > 80 ? 'warning' : 'ok', cpuDetail)}
      ${pm2HTML}
    </div>`;
  },

  close() {
    this.drawer.classList.add('hidden');
  },

  // Event type icon mapping
  _eventIcon(action) {
    const icons = {
      'opened': '📋', 'closed': '✅', 'merged': '🔀', 'commented on': '💬',
      'pushed to': '📦', 'approved': '👍', 'assigned': '👤', 'updated': '✏️'
    };
    return icons[action] || '•';
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
                    ? `<a href="${esc(url)}" target="_blank" class="at-link">${esc(truncate(title, 60))}</a>`
                    : `<span>${esc(truncate(title, 60))}</span>`;
                  return `
                    <div class="at-event">
                      <span class="at-icon">${this._eventIcon(e.action)}</span>
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
    const { agent, current_tasks, recent_done, events, collabs, stats } = data;

    this.body.innerHTML = `
      <div class="drawer-header">
        <h3>${esc(agent.name)} <span class="online-dot ${agent.online ? 'online' : 'offline'}"></span></h3>
        <div class="drawer-role">${esc(agent.role || '—')}</div>
        ${agent.bio ? `<div class="drawer-bio">${esc(agent.bio)}</div>` : ''}
      </div>

      <div class="drawer-section">
        <h4>统计</h4>
        <div class="drawer-stat-grid">
          <div class="stat-box">
            <div class="stat-num">${stats.open_tasks}</div>
            <div class="stat-label">进行中</div>
          </div>
          <div class="stat-box">
            <div class="stat-num">${stats.closed_tasks}</div>
            <div class="stat-label">已完成</div>
          </div>
          <div class="stat-box">
            <div class="stat-num">${stats.mr_count}</div>
            <div class="stat-label">MR</div>
          </div>
          <div class="stat-box">
            <div class="stat-num">${stats.issue_count}</div>
            <div class="stat-label">Issue</div>
          </div>
        </div>
      </div>

      <div id="drawer-output-section"></div>
      <div id="drawer-hardware-section"></div>

      ${current_tasks.length > 0 ? `
        <div class="drawer-section">
          <h4>当前工作 (${current_tasks.length})</h4>
          <ul class="drawer-task-list">
            ${current_tasks.map(t => `
              <li>
                <a href="${esc(t.url)}" target="_blank" style="color: var(--accent); text-decoration: none;">
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

      ${recent_done.length > 0 ? `
        <div class="drawer-section">
          <h4>近期完成 (${recent_done.length})</h4>
          <ul class="drawer-task-list">
            ${recent_done.slice(0, 8).map(t => `
              <li>
                <a href="${esc(t.url)}" target="_blank" style="color: var(--text); text-decoration: none;">
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
