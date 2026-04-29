// HxA Dash — Main Application (v4: Mobile UX + skeleton + sort + keyboard shortcuts — #50)

// Progress bar controller (#43)
const Progress = {
  _el: null,
  _timer: null,

  _bar() {
    if (!this._el) this._el = document.getElementById('progress-bar');
    return this._el;
  },

  show() {
    const bar = this._bar();
    if (!bar) return;
    bar.style.transition = 'none';
    bar.style.width = '0%';
    bar.classList.add('active');
    requestAnimationFrame(() => {
      bar.style.transition = 'width .4s ease, opacity .3s ease';
      bar.style.width = '70%';
    });
  },

  done() {
    const bar = this._bar();
    if (!bar) return;
    bar.style.transition = 'width .2s ease, opacity .4s ease .15s';
    bar.style.width = '100%';
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      bar.classList.remove('active');
      bar.style.width = '0%';
    }, 600);
  }
};

// Base path detection (works behind reverse proxy with path stripping)
const BASE = (() => {
  const path = location.pathname.replace(/\/$/, '');
  return path.includes('/hxa-dash') ? '/hxa-dash' : '';
})();

// #114: navbar grouping — map primary tabs to sub-pages
const NAV_GROUPS = {
  overview: { subpages: ['overview'], default: 'overview' },
  team:     { subpages: ['team'], default: 'team' },
  limits:   { subpages: ['limits'], default: 'limits' },
  tokens:   { subpages: ['tokens'], default: 'tokens' },
  backups:  { subpages: ['backups'], default: 'backups' },
  tasks:    { subpages: ['tasks', 'pipeline', 'mr-board'], default: 'tasks' },
  analysis: { subpages: ['estimates'], default: 'estimates' },
  system:   { subpages: ['health', 'live', 'projects', 'report', 'timeline', 'about'], default: 'health' },
  myview:   { subpages: ['myview'], default: 'myview' },
};

// Reverse lookup: subpage → group
const SUBPAGE_TO_GROUP = {};
for (const [group, cfg] of Object.entries(NAV_GROUPS)) {
  for (const sp of cfg.subpages) {
    SUBPAGE_TO_GROUP[sp] = group;
  }
}

// Utility functions (used by components)
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return Math.floor(diff / 86400000) + '天前';
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const RuntimeCenter = {
  attentionThresholds: {
    quota: 80,
    inactiveMs: 48 * 3600 * 1000,
    heartbeatMs: 10 * 60 * 1000,
    backupMs: 30 * 3600 * 1000
  },

  renderOverview(agents, meta, timeline) {
    const summary = this.summary(agents, meta);
    this._renderSummary(summary);
    const attention = this.attentionItems(agents);
    this._renderAttention(attention);
    this.renderCards('overview-agent-cards', 'overview-team-stats', agents);
    this._renderActivity(timeline, agents);
  },

  renderRoster(agents, statsId) {
    this.renderCards('team-agent-cards', statsId, agents);
  },

  renderCards(containerId, statsId, agents) {
    const container = document.getElementById(containerId);
    const statsEl = document.getElementById(statsId);
    if (!container) return;
    const sorted = [...agents].sort((a, b) => {
      const aa = this.attentionItems([a]).length;
      const bb = this.attentionItems([b]).length;
      if (bb !== aa) return bb - aa;
      const ar = this._isRunning(a) ? 1 : 0;
      const br = this._isRunning(b) ? 1 : 0;
      if (br !== ar) return br - ar;
      return (a.name || '').localeCompare(b.name || '');
    });
    container.innerHTML = sorted.length
      ? sorted.map(a => this.cardHTML(a)).join('')
      : '<div class="empty-state">暂无助理数据</div>';
    container.querySelectorAll('.runtime-agent-card[data-name]').forEach(card => {
      card.addEventListener('click', () => DetailDrawer.open(card.dataset.name));
    });
    if (statsEl) {
      const running = agents.filter(a => this._isRunning(a)).length;
      const working = agents.filter(a => this._isWorking(a)).length;
      const attention = this.attentionItems(agents).length;
      statsEl.textContent = `${agents.length} 位 · ${running} 运行中 · ${working} 工作中 · ${attention} 项关注`;
    }
  },

  renderBackups(backups, agents) {
    const container = document.getElementById('backup-content');
    const summaryEl = document.getElementById('backup-summary');
    if (!container) return;
    const records = this._backupRecords(backups, agents);
    const abnormal = records.filter(r => ['bad', 'warning'].includes(this._backupStatus(r).key));
    const waiting = records.filter(r => this._backupStatus(r).key === 'waiting').length;
    const healthy = records.filter(r => this._backupStatus(r).key === 'ok').length;
    const payloadSummary = backups?.summary || {};
    if (summaryEl) {
      summaryEl.textContent = records.length
        ? `${payloadSummary.total_agents || records.length} 位 · ${payloadSummary.repos || this._backupRepoCount(records)} 个 GitHub 仓库 · ${healthy} 正常 · ${abnormal.length} 异常${waiting ? ` · ${waiting} 待接入` : ''}`
        : '等待 /api/backups 数据';
    }
    if (!records.length) {
      container.innerHTML = `
        <div class="empty-state backup-empty">
          <strong>暂无备份数据</strong>
          <span>/api/backups 尚未返回记录时会显示这里；后续会自动展示每位助理的备份状态。</span>
        </div>
      `;
      return;
    }
    container.innerHTML = `
      <div class="backup-summary-grid">
        <div class="runtime-stat-card"><span class="runtime-stat-value">${payloadSummary.total_agents || records.length}</span><span class="runtime-stat-label">助理</span></div>
        <div class="runtime-stat-card"><span class="runtime-stat-value">${payloadSummary.repos || this._backupRepoCount(records)}</span><span class="runtime-stat-label">GitHub 仓库</span></div>
        <div class="runtime-stat-card"><span class="runtime-stat-value">${healthy}</span><span class="runtime-stat-label">正常</span></div>
        <div class="runtime-stat-card attention"><span class="runtime-stat-value">${abnormal.length}</span><span class="runtime-stat-label">异常</span></div>
      </div>
      <div class="backup-table-wrap">
        <table class="runtime-table">
          <thead><tr><th>助理</th><th>状态</th><th>最近备份</th><th>GitHub 仓库</th><th>未推送</th><th>未拉取</th><th>本地变更</th><th>摘要</th></tr></thead>
          <tbody>
            ${records.map(r => {
              const status = this._backupStatus(r);
              return `<tr>
                <td>${esc(this._backupAgentName(r))}</td>
                <td><span class="runtime-pill ${status.cls}">${status.label}</span></td>
                <td>${esc(this._timeAgoText(this._backupLastSuccessAt(r) || this._backupCheckedAt(r)))}</td>
                <td>${this._backupTargetHTML(r)}</td>
                <td>${esc(String(this._backupNumber(r, 'ahead')))}</td>
                <td>${esc(String(this._backupNumber(r, 'behind')))}</td>
                <td>${esc(String(this._backupNumber(r, 'dirty') + this._backupNumber(r, 'untracked')))}</td>
                <td>${esc(status.detail || this._backupSummaryText(r))}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  filterAgents(agents, filterValue, search) {
    let out = agents;
    if (search) {
      const q = search.toLowerCase();
      out = out.filter(a =>
        (a.name || '').toLowerCase().includes(q) ||
        (a.role || '').toLowerCase().includes(q) ||
        (this._runtimeType(a) || '').toLowerCase().includes(q)
      );
    }
    if (filterValue === 'attention') out = out.filter(a => this.attentionItems([a]).length > 0);
    if (filterValue === 'quota') out = out.filter(a => this._quotaRisk(a).key !== 'ok');
    if (filterValue === 'inactive') out = out.filter(a => this._inactiveRisk(a).key !== 'ok');
    if (filterValue === 'backup') out = out.filter(a => ['bad', 'warning'].includes(this._backupRisk(a).key));
    if (filterValue && filterValue.startsWith('runtime:')) {
      const runtime = filterValue.split(':')[1];
      out = out.filter(a => {
        const type = this._runtimeType(a).toLowerCase();
        return runtime === 'unknown' ? !type || type === 'unknown' : type.includes(runtime);
      });
    }
    return out;
  },

  summary(agents, meta = {}) {
    const total = Number(meta.total_members ?? meta.total ?? meta.member_count ?? agents.length) || agents.length;
    return {
      total,
      running: agents.filter(a => this._isRunning(a)).length,
      working: agents.filter(a => this._isWorking(a)).length,
      attention: this.attentionItems(agents).length
    };
  },

  attentionItems(agents) {
    return agents.flatMap(agent => {
      const items = [];
      const quota = this._quotaRisk(agent);
      const runtime = this._runtimeRisk(agent);
      const inactive = this._inactiveRisk(agent);
      const backup = this._backupRisk(agent);
      if (quota.key !== 'ok') items.push(this._attention(agent, '限额风险', quota));
      if (runtime.key !== 'ok') items.push(this._attention(agent, '运行异常', runtime));
      if (inactive.key !== 'ok') items.push(this._attention(agent, '极度不活跃', inactive));
      if (['bad', 'warning'].includes(backup.key)) items.push(this._attention(agent, 'GitHub 备份异常', backup));
      return items;
    });
  },

  cardHTML(agent) {
    const runtime = this._runtimeLabel(agent);
    const runtimeRisk = this._runtimeRisk(agent);
    const quota = this._quotaRisk(agent);
    const inactive = this._inactiveRisk(agent);
    const backup = this._backupRisk(agent);
    const usage = this._usageLabel(agent);
    const attentionCount = [runtimeRisk, quota, inactive, backup].filter(x => x.key !== 'ok' && x.key !== 'waiting').length;
    const work = this._isWorking(agent) ? '工作中' : this._isRunning(agent) ? '待命' : '离线';
    return `
      <div class="runtime-agent-card ${attentionCount ? 'needs-attention' : ''}" data-name="${esc(agent.name)}">
        <div class="runtime-card-head">
          <div>
            <div class="runtime-card-title">${esc(agent.name || '未命名助理')}</div>
            <div class="runtime-card-subtitle">${esc(agent.role || runtime)}</div>
          </div>
          <span class="runtime-pill ${this._isRunning(agent) ? 'ok' : 'critical'}">${work}</span>
        </div>
        <div class="runtime-card-meta">
          <span>${esc(runtime)}</span>
          <span>心跳 ${esc(this._timeAgoText(this._heartbeatAt(agent)))}</span>
          <span>活动 ${esc(this._timeAgoText(this._lastActivityAt(agent)))}</span>
        </div>
        <div class="runtime-card-badges">
          <span class="runtime-pill ${runtimeRisk.cls}">${runtimeRisk.label}</span>
          <span class="runtime-pill ${quota.cls}">${quota.label}</span>
          <span class="runtime-pill ${usage.cls}">${usage.label}</span>
          <span class="runtime-pill ${backup.cls}">${backup.label}</span>
        </div>
      </div>
    `;
  },

  _renderSummary(summary) {
    const container = document.getElementById('runtime-summary');
    const statsEl = document.getElementById('runtime-overview-stats');
    if (statsEl) statsEl.textContent = `来自 /api/team · 总成员 ${summary.total}`;
    if (!container) return;
    container.innerHTML = `
      <div class="runtime-stat-card"><span class="runtime-stat-value">${summary.total}</span><span class="runtime-stat-label">总成员</span></div>
      <div class="runtime-stat-card"><span class="runtime-stat-value">${summary.running}</span><span class="runtime-stat-label">运行中</span></div>
      <div class="runtime-stat-card"><span class="runtime-stat-value">${summary.working}</span><span class="runtime-stat-label">工作中</span></div>
      <div class="runtime-stat-card attention"><span class="runtime-stat-value">${summary.attention}</span><span class="runtime-stat-label">需关注</span></div>
    `;
  },

  _renderAttention(items) {
    const container = document.getElementById('attention-panel');
    const totalEl = document.getElementById('attention-total');
    if (totalEl) totalEl.textContent = `${items.length} 项`;
    if (!container) return;
    if (!items.length) {
      container.innerHTML = '<div class="empty-state">当前没有需关注项</div>';
      return;
    }
    container.innerHTML = items.slice(0, 24).map(item => `
      <div class="attention-item ${item.risk.cls}">
        <span class="attention-type">${esc(item.type)}</span>
        <span class="attention-agent">${esc(item.agent.name || '-')}</span>
        <span class="attention-detail">${esc(item.risk.detail || item.risk.label)}</span>
      </div>
    `).join('');
  },

  _renderActivity(timeline, agents) {
    const container = document.getElementById('critical-activity');
    const totalEl = document.getElementById('critical-activity-total');
    if (!container) return;
    const names = new Set(agents.map(a => a.name));
    const events = (timeline || []).filter(e => !e.agent || names.has(e.agent)).slice(0, 8);
    if (totalEl) totalEl.textContent = events.length ? `最近 ${events.length} 条` : '';
    if (!events.length) {
      container.innerHTML = '<div class="empty-state">暂无关键活动</div>';
      return;
    }
    container.innerHTML = events.map(e => `
      <div class="runtime-activity-item">
        <span class="runtime-activity-agent">${esc(e.agent || e.actor || '-')}</span>
        <span class="runtime-activity-text">${esc(e.action || e.type || 'activity')} ${esc(truncate(e.target_title || e.title || e.message || '', 52))}</span>
        <span class="runtime-activity-time">${esc(this._timeAgoText(e.timestamp || e.ts || e.created_at))}</span>
      </div>
    `).join('');
  },

  _attention(agent, type, risk) {
    return { agent, type, risk };
  },

  _isRunning(agent) {
    const status = String(agent.runtime_status || agent.runtime?.status || agent.status || '').toLowerCase();
    return agent.online !== false && !['offline', 'stopped', 'down'].includes(status);
  },

  _isWorking(agent) {
    const state = String(agent.work_state || agent.work_status || '').toLowerCase();
    return ['working', 'busy', 'active'].includes(state);
  },

  _runtimeRisk(agent) {
    const status = String(agent.runtime_status || agent.runtime?.status || '').toLowerCase();
    const heartbeat = this._heartbeatAt(agent);
    const heartbeatStale = heartbeat && (Date.now() - new Date(heartbeat).getTime() > this.attentionThresholds.heartbeatMs);
    if (agent.runtime?.stale || agent.hardware?.stale || heartbeatStale) {
      return { key: 'stale', cls: 'warning', label: '心跳断', detail: `心跳 ${this._timeAgoText(heartbeat)}` };
    }
    if (['degraded', 'warning', 'error', 'failed'].includes(status)) {
      return { key: 'degraded', cls: 'warning', label: '运行异常', detail: status };
    }
    if (!this._isRunning(agent)) {
      return { key: 'offline', cls: 'critical', label: '未运行', detail: 'runtime offline' };
    }
    return { key: 'ok', cls: 'ok', label: '运行正常' };
  },

  _quotaRisk(agent) {
    const quota = agent.quota || {};
    const pct = Math.max(
      Number(quota.primary?.used_percent ?? 0),
      Number(quota.secondary?.used_percent ?? 0)
    );
    if (!quota.supported) return { key: 'ok', cls: 'muted', label: quota.reason === 'unsupported_for_now' ? '限额不支持' : '限额待观测' };
    if (pct >= 95) return { key: 'critical', cls: 'critical', label: `限额 ${pct}%`, detail: '即将耗尽' };
    if (pct >= this.attentionThresholds.quota) return { key: 'warning', cls: 'warning', label: `限额 ${pct}%`, detail: '高水位' };
    return { key: 'ok', cls: 'ok', label: pct ? `限额 ${pct}%` : '限额正常' };
  },

  _inactiveRisk(agent) {
    const ts = this._lastActivityAt(agent);
    if (!ts) return { key: 'ok', cls: 'muted', label: '活动待观测', detail: '未上报 last activity' };
    const age = Date.now() - new Date(ts).getTime();
    if (age > this.attentionThresholds.inactiveMs) {
      return { key: 'inactive', cls: 'warning', label: '不活跃', detail: this._timeAgoText(ts) };
    }
    return { key: 'ok', cls: 'ok', label: '活跃' };
  },

  _backupRisk(agent) {
    const backup = agent.backup || agent.github_backup || agent.backups;
    if (!backup) return { key: 'ok', cls: 'muted', label: '备份待接入' };
    const status = this._backupStatus(backup);
    if (status.key !== 'ok') return status;
    return status;
  },

  _backupStatus(backup) {
    if (!backup) return { key: 'ok', cls: 'muted', label: '备份待接入', detail: '无备份数据' };
    const b = Array.isArray(backup) ? backup[0] : backup;
    const summary = b.summary && typeof b.summary === 'object' ? b.summary : null;
    if (summary?.backup_required === false) return { key: 'ok', cls: 'muted', label: '无需备份', detail: this._backupReasonText('backup_not_required') };
    const raw = String(summary?.status || b.status || b.state || '').toLowerCase();
    const reason = summary?.reason || b.reason || b.error || b.message || null;
    const reasonText = this._backupReasonText(reason);

    if (raw === 'critical') {
      const count = Number(summary?.critical || 0);
      const isCron = String(reason || '').includes('backup_') || String(reason || '').includes('last_backup');
      return { key: 'bad', cls: 'critical', label: isCron ? '备份异常' : '备份异常', detail: reasonText || (count ? `${count} 个仓库异常` : '缺少 GitHub 远端或采集失败') };
    }
    if (raw === 'warning') {
      const isCron = String(reason || '').includes('backup_') || String(reason || '').includes('last_backup') || String(reason || '').includes('success_stale');
      return { key: 'warning', cls: 'warning', label: isCron ? '备份待确认' : '待同步', detail: reasonText || this._backupSummaryText(b) };
    }
    if (raw === 'unsupported') {
      const isMissingReport = !reason || reason === 'not_reported';
      return {
        key: isMissingReport ? 'waiting' : 'warning',
        cls: isMissingReport ? 'muted' : 'warning',
        label: isMissingReport ? '备份待接入' : '备份不可用',
        detail: isMissingReport ? '等待上报程序上报' : (reasonText || '备份状态不可用')
      };
    }
    if (raw === 'ok') return { key: 'ok', cls: 'ok', label: this._backupOkLabel(summary) };

    const okRaw = ['ok', 'success', 'healthy', 'fresh', 'synced', 'completed'].includes(raw);
    const failedRaw = ['failed', 'error', 'stale', 'missing', 'blocked'].includes(raw);
    const last = this._backupCheckedAt(b);
    const stale = b.stale || (last && Date.now() - new Date(last).getTime() > this.attentionThresholds.backupMs);
    if (failedRaw || b.error || b.failed || stale) {
      return { key: 'bad', cls: failedRaw || b.error ? 'critical' : 'warning', label: failedRaw || b.error ? '备份异常' : '备份过旧', detail: this._backupReasonText(b.error || b.message) || this._timeAgoText(last) };
    }
    if (okRaw || last) return { key: 'ok', cls: 'ok', label: '备份正常' };
    return { key: 'ok', cls: 'muted', label: '备份待接入' };
  },

  _usageLabel(agent) {
    const usage = agent.usage || {};
    const tokens = usage.session_tokens || {};
    const total = tokens.total ?? ((tokens.input || 0) + (tokens.output || 0));
    if (!usage.supported || !total) return { cls: 'muted', label: '用量待观测' };
    return { cls: 'ok', label: this._formatTokenCount(total) };
  },

  _runtimeLabel(agent) {
    const runtime = agent.runtime || {};
    const label = runtime.label || runtime.type || agent.runtime_type || 'Unknown';
    return `${label}${runtime.version ? ` ${runtime.version}` : ''}`;
  },

  _runtimeType(agent) {
    return String(agent.runtime?.type || agent.runtime?.label || agent.runtime_type || '').toLowerCase();
  },

  _heartbeatAt(agent) {
    return agent.last_heartbeat_at || agent.runtime?.last_heartbeat_at || agent.hardware?.reported_at || agent.reported_at;
  },

  _lastActivityAt(agent) {
    return agent.last_active_at || agent.latest_event?.timestamp || agent.latest_event?.ts || agent.last_seen_at;
  },

  _timeAgoText(ts) {
    if (!ts) return '未知';
    const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
    if (!Number.isFinite(t)) return '未知';
    return timeAgo(t);
  },

  _backupRecords(backups, agents) {
    const raw = Array.isArray(backups) ? backups : (backups?.agents || backups?.backups || backups?.records || []);
    if (raw.length) return raw;
    return agents
      .filter(a => a.backup || a.github_backup || a.backups)
      .map(a => ({ agent: a.name, ...(Array.isArray(a.backups) ? a.backups[0] : (a.backup || a.github_backup || {})) }));
  },

  _backupAgentName(record) {
    return record.agent || record.name || '-';
  },

  _backupCheckedAt(record) {
    return record.summary?.last_run_at || record.cron?.last_run_at || record.summary?.sampled_at || record.reported_at || record.last_success_at || record.last_backup_at || record.updated_at || record.checked_at;
  },

  _backupLastSuccessAt(record) {
    return record.summary?.last_success_at || record.cron?.last_success_at || record.last_success_at || record.last_backup_at;
  },

  _backupNumber(record, key) {
    const value = record.summary?.[key] ?? record[key] ?? 0;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  },

  _backupRepoCount(records) {
    return records.reduce((sum, record) => sum + (Number(record.summary?.total || 0) || (Array.isArray(record.repos) ? record.repos.length : 0)), 0);
  },

  _backupOkLabel(summary) {
    if (summary?.total) return `正常 ${summary.ok || summary.total}/${summary.total}`;
    return '备份正常';
  },

  _backupTargetHTML(record) {
    if (record.summary?.backup_required === false) return '<span class="backup-repo-chip">不要求 GitHub 仓库</span>';
    const repos = Array.isArray(record.repos) ? record.repos : [];
    if (repos.length) {
      const shown = repos.slice(0, 3).map(repo => {
        const label = repo.remote || repo.path || '-';
        return `<span class="backup-repo-chip">${esc(truncate(label, 42))}</span>`;
      }).join('');
      const expected = record.summary?.expected_remote && record.summary?.expected_match === false
        ? `<span class="backup-repo-more">应为 ${esc(truncate(record.summary.expected_remote, 36))}</span>`
        : '';
      return shown + (repos.length > 3 ? `<span class="backup-repo-more">+${repos.length - 3}</span>` : '') + expected;
    }
    if (record.summary?.expected_remote) return `<span class="backup-repo-chip">预期 ${esc(truncate(record.summary.expected_remote, 42))}</span>`;
    if (record.summary?.log_path || record.cron?.log_path) return '<span class="backup-repo-chip">未发现 GitHub 仓库</span>';
    return esc(record.repo || record.repository || record.remote || record.target || '-');
  },

  _backupSummaryText(record) {
    const summary = record.summary || {};
    const parts = [];
    if (summary.backup_required === false) parts.push('非 AI 员工，无需 GitHub 仓库');
    const total = Number(summary.total || 0);
    if (total) parts.push(`${summary.github_remotes || 0}/${total} 个 GitHub 仓库`);
    if (summary.expected_remote && summary.expected_match === false) parts.push('预期仓库未匹配');
    else if (summary.expected_remote && !total) parts.push('预期仓库未上报');
    else if (summary.log_path || record.cron?.log_path) parts.push('仅检测到备份日志');
    const lastSuccess = this._backupLastSuccessAt(record);
    if (lastSuccess) parts.push(`最近成功 ${this._timeAgoText(lastSuccess)}`);
    const ahead = this._backupNumber(record, 'ahead');
    const behind = this._backupNumber(record, 'behind');
    const dirty = this._backupNumber(record, 'dirty');
    const untracked = this._backupNumber(record, 'untracked');
    if (ahead) parts.push(`${ahead} 未推送`);
    if (behind) parts.push(`${behind} 未拉取`);
    if (dirty || untracked) parts.push(`${dirty + untracked} 本地变更`);
    return parts.join(' · ') || this._backupReasonText(record.message || record.reason) || '等待上报程序上报';
  },

  _backupReasonText(reason) {
    const key = String(reason || '').trim();
    if (!key) return '';
    const map = {
      not_reported: '等待上报程序上报',
      unsupported: '备份状态不可用',
      unsupported_for_now: '备份状态暂不支持',
      backup_not_required: '非 AI 员工，无需 GitHub 仓库',
      git_not_available: '未安装 git，无法检查仓库状态',
      collection_failed: '仓库状态采集失败',
      no_github_remote: '未配置 GitHub 远端',
      no_github_backup_repo: '未发现 GitHub 仓库',
      github_repo_mismatch: 'GitHub 仓库不匹配',
      ahead_of_upstream: '有未推送提交',
      dirty_worktree: '有未提交修改',
      untracked_files: '有未跟踪文件',
      behind_upstream: '落后远端仓库',
      backup_log_not_found: '未找到备份日志',
      backup_log_unreadable: '备份日志无法读取',
      last_backup_failed: '最近一次备份失败',
      no_success_marker: '备份日志未发现成功记录',
      failure_after_last_success: '最近成功后又出现失败记录',
      backup_success_too_old: '最近成功备份时间过久',
      backup_success_stale: '最近成功备份已超过预期',
      no_backup_signal_found: '未发现备份日志或备份仓库',
      no_git_repositories_found: '未发现备份仓库'
    };
    if (map[key]) return map[key];
    if (/[\u4e00-\u9fff]/.test(key)) return key;
    return '状态待确认';
  },

  _formatTokenCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  }
};

// Scope manager (#100): multi connect-server × org management
const ScopeManager = {
  STORAGE_KEY: 'hxa-dash-scope',
  scopes: [],
  activeScope: null,

  async init() {
    try {
      const res = await fetch(`${BASE}/api/scopes`);
      if (!res.ok) return;
      const data = await res.json();
      this.scopes = data.scopes || [];

      // Restore last selection or use default
      const saved = localStorage.getItem(this.STORAGE_KEY);
      if (saved && this.scopes.some(s => s.id === saved)) {
        this.activeScope = saved;
      } else {
        this.activeScope = data.default || (this.scopes[0]?.id) || null;
      }

      this._renderSelector(data.servers || []);
    } catch (e) {
      console.error('[ScopeManager] Init error:', e);
    }
  },

  _renderSelector(servers) {
    const sel = document.getElementById('scope-selector');
    if (!sel) return;

    // Hide if single scope
    if (this.scopes.length <= 1) {
      sel.classList.add('hidden');
      return;
    }

    sel.innerHTML = '';
    // Group by server
    if (servers.length > 1) {
      for (const server of servers) {
        const group = document.createElement('optgroup');
        group.label = server.hub.replace(/^https?:\/\//, '').replace(/\/hub\/?$/, '');
        for (const org of server.orgs) {
          const opt = document.createElement('option');
          opt.value = org.id;
          opt.textContent = org.name;
          if (org.id === this.activeScope) opt.selected = true;
          group.appendChild(opt);
        }
        sel.appendChild(group);
      }
    } else {
      for (const s of this.scopes) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        if (s.id === this.activeScope) opt.selected = true;
        sel.appendChild(opt);
      }
    }

    sel.classList.remove('hidden');
    sel.addEventListener('change', () => {
      this.activeScope = sel.value;
      localStorage.setItem(this.STORAGE_KEY, this.activeScope);
      // Update agent filter with scoped agents, then re-render
      const scopedAgents = this.filter(App.data.team);
      AgentFilter.setAgents(scopedAgents);
      App.renderAllPages();
    });
  },

  // #107: scope match supports both string and array (agent may belong to multiple orgs)
  _matchScope(item) {
    if (!item.scope && !item.scopes) return true; // no scope = show everywhere
    if (Array.isArray(item.scopes)) return item.scopes.includes(this.activeScope);
    return item.scope === this.activeScope;
  },

  filter(items) {
    if (!this.activeScope || this.scopes.length <= 1) return items;
    return items.filter(i => this._matchScope(i));
  },

  filterBoard(board) {
    if (!this.activeScope || this.scopes.length <= 1) return board;
    const f = arr => (arr || []).filter(t => this._matchScope(t));
    return { todo: f(board.todo), doing: f(board.doing), done: f(board.done) };
  },

  filterGraph(graph) {
    if (!this.activeScope || this.scopes.length <= 1) return graph;
    const nodes = (graph.nodes || []).filter(n => this._matchScope(n));
    const nodeNames = new Set(nodes.map(n => n.name || n.id));
    const edges = (graph.edges || []).filter(e => nodeNames.has(e.source) && nodeNames.has(e.target));
    return { nodes, edges };
  }
};

// App state
const App = {
  ws: null,
  reconnectTimer: null,
  currentPage: 'overview',
  data: { team: [], teamMeta: {}, board: {}, timeline: [], graph: { nodes: [], edges: [] }, projects: [], backups: [] },
  selectedProject: '',  // '' = all projects

  // Graph instances for overview and collab pages
  overviewGraph: null,
  collabGraph: null,

  async init() {
    // Init scope manager (#100)
    await ScopeManager.init();

    // Init components
    AgentFilter.init();
    AgentFilter.initCollabButtons();
    CardWall.init();
    DetailDrawer.init();
    TaskBoard.init();
    Timeline.init();
    CollabMatrix.init();
    TrendsChart.init();
    Blockers.init();
    WorkloadHeatmap.init();
    WorkloadReport.init();
    Suggestions.init();
    Metrics.init();
    MyView.init();
    TokenDashboard.init();
    LimitsDashboard.init();
    LiveDashboard.init();
    Pipeline.init();
    MRBoard.init();
    TimeEstimates.init();
    HealthDiagnostics.init();
    Projects.init();

    // Workload report: sortable headers + export
    document.querySelectorAll('.workload-table thead .sortable').forEach(th => {
      th.addEventListener('click', () => WorkloadReport._sortBy(th.dataset.sort));
    });
    const exportBtn = document.getElementById('workload-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', () => WorkloadReport.exportJSON());

    // Weekly report export (#60)
    const weeklyExportBtn = document.getElementById('weekly-report-export-btn');
    if (weeklyExportBtn) weeklyExportBtn.addEventListener('click', () => WeeklyReport.export());

    // Init graphs
    const overviewCanvas = document.getElementById('overview-collab-canvas');
    const overviewEmpty = document.getElementById('overview-collab-empty');
    if (overviewCanvas) this.overviewGraph = new ForceGraph(overviewCanvas, overviewEmpty);

    const collabCanvas = document.getElementById('collab-canvas');
    const collabEmpty = document.getElementById('collab-empty');
    if (collabCanvas) this.collabGraph = new ForceGraph(collabCanvas, collabEmpty);

    // Router
    this.initRouter();

    // #50: Show skeleton cards while first fetch runs
    this.renderSkeletons('overview-agent-cards', 6);
    this.renderSkeletons('team-agent-cards', 6);

    // Initial REST fetch
    await this.fetchAll();

    // WebSocket connection
    this.connectWS();

    // Refresh button
    document.getElementById('refresh-btn').addEventListener('click', () => this.fetchAll());

    // Project filter
    const projectSelect = document.getElementById('collab-project-filter');
    if (projectSelect) {
      projectSelect.addEventListener('change', () => {
        this.selectedProject = projectSelect.value;
        this.fetchCollabGraph();
      });
    }

    // Resize handler for graphs
    window.addEventListener('resize', () => {
      if (this.overviewGraph) this.overviewGraph.resize();
      if (this.collabGraph) this.collabGraph.resize();
    });

    // #50: Sort dropdowns
    const overviewSort = document.getElementById('overview-sort');
    if (overviewSort) overviewSort.addEventListener('change', () => this.renderOverview());
    const teamSort = document.getElementById('team-sort');
    if (teamSort) teamSort.addEventListener('change', () => this.renderTeam());

    // #50: Hamburger mobile nav
    this.initMobileNav();

    // #50: Keyboard shortcuts
    this.initKeyboardShortcuts();

    // #50: Auto-refresh countdown (30s interval)
    this.initAutoRefresh();

    // #50: Show skeleton loading on initial load (already running fetchAll above)
    // Skeletons are shown by renderSkeletons() called before first fetchAll
  },

  // --- Router (#114: grouped nav) ---
  initRouter() {
    // Primary nav items
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const group = item.dataset.page;
        const cfg = NAV_GROUPS[group];
        this.navigateTo(cfg ? cfg.default : group);
      });
    });

    // Sub-tab items
    document.querySelectorAll('.sub-tab').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        this.navigateTo(item.dataset.subpage);
      });
    });

    // Handle browser back/forward
    window.addEventListener('hashchange', () => {
      const hash = location.hash.replace('#', '') || 'overview';
      const resolved = this._resolveHash(hash);
      this.navigateTo(resolved, false);
    });

    // Handle initial hash
    const hash = location.hash.replace('#', '') || 'overview';
    const resolved = this._resolveHash(hash);
    this.navigateTo(resolved, false);
  },

  // #114: resolve hash string to actual subpage
  _resolveHash(hash) {
    const legacyHashMap = {
      analysis: 'report',
      'analysis/report': 'report',
      'analysis/timeline': 'timeline',
      'analysis/limits': 'limits',
      'analysis/tokens': 'tokens',
      'analysis/estimates': 'estimates',
      tasks: 'tasks',
      'team/live': 'live',
      myview: 'myview',
      'myview/about': 'about'
    };
    if (legacyHashMap[hash]) return legacyHashMap[hash];

    // Handle "group/subpage" format (e.g., "tasks/pipeline")
    if (hash.includes('/')) {
      const [group, sub] = hash.split('/');
      const cfg = NAV_GROUPS[group];
      if (cfg && cfg.subpages.includes(sub)) return sub;
      // Invalid sub, fall back to group default
      if (cfg) return cfg.default;
      return 'overview';
    }
    // Handle legacy flat hashes (e.g., "#collab" → collab page)
    if (SUBPAGE_TO_GROUP[hash]) return hash;
    // Handle group name directly (e.g., "#team" → team default)
    if (NAV_GROUPS[hash]) return NAV_GROUPS[hash].default;
    return 'overview';
  },

  navigateTo(page, pushState = true) {
    const allSubpages = Object.values(NAV_GROUPS).flatMap(g => g.subpages);
    if (!allSubpages.includes(page)) page = 'overview';

    const group = SUBPAGE_TO_GROUP[page];

    // Update primary nav
    document.querySelectorAll('.nav-item').forEach(n => {
      n.classList.toggle('active', n.dataset.page === group);
    });

    // Update sub-tabs visibility
    document.querySelectorAll('.sub-tabs').forEach(st => {
      const isActiveGroup = st.dataset.group === group;
      st.classList.toggle('hidden', !isActiveGroup);
    });

    // Update sub-tab active state
    document.querySelectorAll('.sub-tab').forEach(st => {
      st.classList.toggle('active', st.dataset.subpage === page);
    });

    // Update pages
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === `page-${page}`);
    });

    this.currentPage = page;
    if (pushState) {
      // Build hash: group/subpage or just group if it's the default
      const cfg = NAV_GROUPS[group];
      const hash = (cfg && page === cfg.default) ? group : `${group}/${page}`;
      location.hash = hash;
    }

    // Resize graphs when their page becomes visible
    requestAnimationFrame(() => {
      if (page === 'overview' && this.overviewGraph) this.overviewGraph.resize();
      if (page === 'collab' && this.collabGraph) this.collabGraph.resize();
    });

    // Re-render current page with filters
    this.renderCurrentPage();

    // Lazy-load pages
    if (page === 'tokens' && !TokenDashboard._data) TokenDashboard.fetch();
    if (page === 'limits' && !LimitsDashboard._data) LimitsDashboard.fetch();
    if (page === 'live') LiveDashboard.fetch();
    if (page === 'pipeline') Pipeline.fetch();
    if (page === 'mr-board') MRBoard.fetch();
    if (page === 'estimates') TimeEstimates.fetch();
    if (page === 'health') HealthDiagnostics.fetch();
    if (page === 'projects' && !Projects.data) Projects.load();
    if (page === 'about') this.loadAbout();
    if (page === 'backups') this.renderBackups();
  },

  // --- Data Fetching ---
  async fetchAll() {
    Progress.show();
    try {
      const [teamRes, boardRes, timelineRes, graphRes, backupsRes] = await Promise.all([
        fetch(`${BASE}/api/team`),
        fetch(`${BASE}/api/board`),
        fetch(`${BASE}/api/timeline`),
        fetch(`${BASE}/api/graph`),
        fetch(`${BASE}/api/backups`).catch(() => null)
      ]);

      if (teamRes.ok) {
        const teamData = await teamRes.json();
        const teamMeta = teamData.stats || teamData.summary || teamData.meta || {};
        this.data.team = teamData.agents || [];
        this.data.teamMeta = {
          ...teamMeta,
          total_members: teamData.total_members ?? teamMeta.total_members,
          total: teamData.total ?? teamMeta.total,
          member_count: teamData.member_count ?? teamMeta.member_count
        };
        AgentFilter.setAgents(ScopeManager.filter(this.data.team));
      }

      if (boardRes.ok) {
        this.data.board = await boardRes.json();
      }

      if (timelineRes.ok) {
        const tlData = await timelineRes.json();
        this.data.timeline = tlData.events;
      }

      if (graphRes.ok) {
        this.data.graph = await graphRes.json();
      }

      if (backupsRes && backupsRes.ok) {
        this.data.backups = await backupsRes.json();
      } else {
        this.data.backups = [];
      }

      // Fetch project list
      try {
        const projRes = await fetch(`${BASE}/api/projects`);
        if (projRes.ok) {
          const projData = await projRes.json();
          this.data.projects = projData.projects || [];
          this._populateProjectFilter();
        }
      } catch {}

      this.updateTimestamp();
      Progress.done();
      this.renderAllPages();
    } catch (err) {
      Progress.done();
      console.error('Fetch error:', err);
    }
  },

  // --- Rendering ---
  renderAllPages() {
    this.renderOverview();
    this.renderTeam();
    this.renderCollab();
    this.renderTasks();
    this.renderTimeline();
    this.renderMyView();
    this.renderBackups();
    WorkloadHeatmap.render(this.data.team);
  },

  renderCurrentPage() {
    switch (this.currentPage) {
      case 'overview': this.renderOverview(); break;
      case 'team': this.renderTeam(); break;
      case 'collab': this.renderCollab(); break;
      case 'tasks': this.renderTasks(); break;
      case 'timeline': this.renderTimeline(); break;
      case 'backups': this.renderBackups(); break;
      case 'live': LiveDashboard.render(); break;
      case 'limits': LimitsDashboard.render(); break;
      case 'pipeline': Pipeline.render(); break;
      case 'myview': this.renderMyView(); break;
    }
  },

  renderOverview() {
    const filter = AgentFilter.getFilter('overview');
    const scopedTeam = ScopeManager.filter(this.data.team);
    const agents = filter
      ? scopedTeam.filter(a => filter.has(a.name))
      : scopedTeam;

    const sortedForOverview = this._applySortOrder(agents, document.getElementById('overview-sort')?.value || 'default');
    const scopedTimeline = ScopeManager.filter(this.data.timeline);
    const events = AgentFilter.filterItems('overview', scopedTimeline, 'agent');
    RuntimeCenter.renderOverview(sortedForOverview, this.data.teamMeta, events || []);
  },

  renderTeam() {
    // Team page: scoped (#100) + global agent filter (#91) + search/status filter
    const search = (document.getElementById('team-search')?.value || '').toLowerCase();
    const statusFilter = document.getElementById('team-status-filter')?.value || 'all';

    const filter = AgentFilter.getFilter('team');
    let agents = ScopeManager.filter(this.data.team);
    if (filter) agents = agents.filter(a => filter.has(a.name));
    if (search) {
      agents = agents.filter(a =>
        (a.name || '').toLowerCase().includes(search) ||
        (a.role || '').toLowerCase().includes(search) ||
        (a.bio || '').toLowerCase().includes(search)
      );
    }
    agents = RuntimeCenter.filterAgents(agents, statusFilter, search);

    // Apply sort (#50)
    const sortVal = document.getElementById('team-sort')?.value || 'default';
    agents = this._applySortOrder(agents, sortVal);

    RuntimeCenter.renderRoster(agents, 'team-stats');

    // Attach search handlers (once)
    if (!this._teamSearchBound) {
      this._teamSearchBound = true;
      document.getElementById('team-search')?.addEventListener('input', () => this.renderTeam());
      document.getElementById('team-status-filter')?.addEventListener('change', () => this.renderTeam());
    }
  },

  renderCollab() {
    const graphData = this._filterGraph('collab', this.data.graph);
    if (this.collabGraph) this.collabGraph.setData(graphData.nodes, graphData.edges);

    // Render matrix view
    CollabMatrix.render(graphData.nodes, graphData.edges);

    const edgeCountEl = document.getElementById('collab-edge-count');
    if (edgeCountEl) {
      edgeCountEl.textContent = `${graphData.nodes.length} Agent · ${graphData.edges.length} 协作关系`;
    }
  },

  renderTasks() {
    const board = this._filterBoard('tasks', this.data.board);
    TaskBoard.renderTo('tasks', board);

    const totalEl = document.getElementById('tasks-total');
    if (totalEl) {
      const total = (board.todo?.length || 0) + (board.doing?.length || 0) + (board.done?.length || 0);
      totalEl.textContent = `共 ${total} 项`;
    }
  },

  renderTimeline() {
    const scopedTimeline = ScopeManager.filter(this.data.timeline);
    const events = AgentFilter.filterItems('timeline', scopedTimeline, 'agent');
    Timeline.renderTo('timeline', events, 100);

    const totalEl = document.getElementById('timeline-total');
    if (totalEl) totalEl.textContent = `共 ${events.length} 条`;

  },

  renderMyView() {
    MyView.populateAgents(this.data.team);
  },

  renderBackups() {
    RuntimeCenter.renderBackups(this.data.backups, ScopeManager.filter(this.data.team));
  },

  // --- Filter Helpers ---
  // Blocker detection — try API first, fallback to local computation (#56, #63, #68)
  async _renderBlockers(agents) {
    try {
      const res = await fetch(`${BASE}/api/blockers`);
      if (res.ok) {
        const data = await res.json();
        Blockers.render(data.blockers || [], data.thresholds);
        return;
      }
    } catch (_) { /* API not available, fallback */ }

    // Fallback: compute from local data
    const allTasks = [
      ...(this.data.board.todo || []),
      ...(this.data.board.doing || []),
      ...(this.data.board.done || [])
    ];
    const blockers = Blockers.computeFromData(agents, allTasks, this.data.timeline || []);
    Blockers.render(blockers);
  },

  _filterBoard(context, board) {
    // Apply scope filter first (#100), then agent filter
    const scoped = ScopeManager.filterBoard(board);
    const f = AgentFilter.getFilter(context);
    if (!f) return scoped;
    return {
      todo: (scoped.todo || []).filter(t => !t.assignee || f.has(t.assignee)),
      doing: (scoped.doing || []).filter(t => !t.assignee || f.has(t.assignee)),
      done: (scoped.done || []).filter(t => !t.assignee || f.has(t.assignee))
    };
  },

  _filterGraph(context, graph) {
    // Apply scope filter first (#100), then agent filter
    const scoped = ScopeManager.filterGraph(graph || { nodes: [], edges: [] });
    const f = AgentFilter.getFilter(context);
    if (!f) return scoped;
    const nodes = (scoped.nodes || []).filter(n => f.has(n.id));
    const nodeSet = new Set(nodes.map(n => n.id));
    const edges = (scoped.edges || []).filter(e => nodeSet.has(e.source) && nodeSet.has(e.target));
    return { nodes, edges };
  },

  // Project filter helpers
  _populateProjectFilter() {
    const select = document.getElementById('collab-project-filter');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">全部项目</option>' +
      this.data.projects.map(p => `<option value="${esc(p)}"${p === current ? ' selected' : ''}>${esc(p)}</option>`).join('');
  },

  async fetchCollabGraph() {
    try {
      const url = this.selectedProject
        ? `${BASE}/api/graph?project=${encodeURIComponent(this.selectedProject)}`
        : `${BASE}/api/graph`;
      const res = await fetch(url);
      if (res.ok) {
        this.data.graph = await res.json();
        this.renderCollab();
        this.renderOverview();
      }
    } catch (err) {
      console.error('Graph fetch error:', err);
    }
  },

  // Called by AgentFilter when global filter changes (#87)
  onGlobalFilterChange() {
    this.renderAllPages();
    Metrics.render();
  },

  // Legacy compat
  onFilterChange(_context) {
    this.onGlobalFilterChange();
  },

  // --- WebSocket ---
  connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}${BASE}/ws`;

    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.setStatus('connected');
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (e) {
          console.error('WS parse error:', e);
        }
      };

      this.ws.onclose = () => {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.setStatus('disconnected');
      };
    } catch (err) {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  },

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWS();
    }, 5000);
  },

  handleMessage(msg) {
    this.updateTimestamp();

    switch (msg.type) {
      case 'snapshot':
        if (msg.data.team) {
          const agents = Array.isArray(msg.data.team) ? msg.data.team : [];
          this.data.team = agents;
          this.data.teamMeta = msg.data.teamMeta || msg.data.team_meta || msg.data.stats || this.data.teamMeta;
          AgentFilter.setAgents(ScopeManager.filter(agents));
        }
        if (msg.data.board) this.data.board = msg.data.board;
        if (msg.data.timeline) this.data.timeline = msg.data.timeline;
        if (msg.data.graph) this.data.graph = msg.data.graph;
        if (msg.data.metrics) {
          Metrics.update(msg.data.metrics);
          Suggestions.updateMetrics(msg.data.metrics);
        }
        if (msg.data.projects) {
          Projects.update(msg.data.projects);
        }
        if (msg.data.backups) {
          this.data.backups = msg.data.backups;
        }
        this.renderAllPages();
        break;

      case 'metrics:update':
        Metrics.update(msg.data);
        break;

      case 'team:update':
        if (Array.isArray(msg.data)) {
          this.data.team = msg.data;
          AgentFilter.setAgents(ScopeManager.filter(msg.data));
          this.renderOverview();
          this.renderTeam();
          this.renderBackups();
          if (this.currentPage === 'live') LiveDashboard.fetch();
          if (this.currentPage === 'limits') LimitsDashboard.fetch();
        }
        break;

      case 'backups:update':
        this.data.backups = msg.data || [];
        this.renderOverview();
        this.renderTeam();
        this.renderBackups();
        break;

      case 'board:update':
        this.data.board = msg.data;
        this.renderOverview();
        this.renderTasks();
        if (this.currentPage === 'myview') MyView.fetchAndRender();
        break;

      case 'timeline:new':
        if (Array.isArray(msg.data)) {
          this.data.timeline = msg.data;
          this.renderOverview();
          this.renderTimeline();
        }
        break;

      case 'graph:update':
        this.data.graph = msg.data;
        this.renderOverview();
        this.renderCollab();
        break;

      case 'pm2:update':
        // Real-time PM2 status update (#123) — refresh health page if visible
        if (this.currentPage === 'health') {
          HealthDiagnostics.fetch();
        }
        break;
    }
  },

  setStatus(status) {
    const el = document.getElementById('ws-status');
    el.className = `status-badge ${status}`;
    const labels = { connected: '已连接', disconnected: '断开', connecting: '连接中…' };
    el.textContent = labels[status] || status;
  },

  updateTimestamp() {
    const el = document.getElementById('last-update');
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  },

  // --- #50: Skeleton loading screens ---
  renderSkeletons(containerId, count = 4) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = Array.from({ length: count }, () => `
      <div class="skeleton-card">
        <div class="skeleton-row">
          <div class="skeleton-line sk-h1" style="width:55%"></div>
          <div class="skeleton-line sk-tag" style="margin-left:auto;width:18%"></div>
        </div>
        <div class="skeleton-line sk-h2"></div>
        <div class="skeleton-line sk-h3"></div>
        <div class="skeleton-row" style="margin-top:4px">
          <div class="skeleton-line sk-tag" style="width:22%"></div>
          <div class="skeleton-line sk-tag" style="width:22%"></div>
          <div class="skeleton-line sk-tag" style="width:22%"></div>
        </div>
      </div>
    `).join('');
  },

  // --- #50: Sort helper ---
  _applySortOrder(agents, sortKey) {
    const arr = [...agents];
    switch (sortKey) {
      case 'health':
        // Descending health score; agents without score go last
        arr.sort((a, b) => {
          const ha = a.health_score ?? -1;
          const hb = b.health_score ?? -1;
          if (hb !== ha) return hb - ha;
          return (a.name || '').localeCompare(b.name || '');
        });
        break;
      case 'activity': {
        // Descending by latest_event timestamp, then online first
        const ts = ag => (ag.latest_event && ag.latest_event.ts) ? ag.latest_event.ts : 0;
        arr.sort((a, b) => {
          const diff = ts(b) - ts(a);
          if (diff !== 0) return diff;
          return (a.name || '').localeCompare(b.name || '');
        });
        break;
      }
      case 'name':
        arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        break;
      default:
        // Default: online first, then by name (CardWall's own sort)
        break;
    }
    return arr;
  },

  // --- #50: Hamburger mobile nav ---
  initMobileNav() {
    const hamburger = document.getElementById('nav-hamburger');
    const closeBtn  = document.getElementById('nav-close-btn');
    if (!hamburger) return;

    const open = () => {
      document.body.classList.add('nav-mobile-open');
      hamburger.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      document.body.classList.remove('nav-mobile-open');
      hamburger.setAttribute('aria-expanded', 'false');
    };

    hamburger.addEventListener('click', open);
    closeBtn && closeBtn.addEventListener('click', close);

    // Close nav when a nav item is tapped on mobile
    document.getElementById('main-nav')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('nav-item')) close();
    });
  },

  // --- #50: Keyboard shortcuts ---
  initKeyboardShortcuts() {
    this._kbdIndex = -1; // current focused card index in active card list

    document.addEventListener('keydown', (e) => {
      // Ignore when typing in inputs
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      // Ignore if a modifier key is held
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'r':
        case 'R':
          e.preventDefault();
          this.fetchAll();
          break;
        case 'j':
        case 'J':
          e.preventDefault();
          this._kbdNavigate(1);
          break;
        case 'k':
        case 'K':
          e.preventDefault();
          this._kbdNavigate(-1);
          break;
        case 'Escape':
          this._kbdClearFocus();
          break;
      }
    });
  },

  _kbdNavigate(direction) {
    // Get visible cards on the current page
    const page = document.querySelector('.page.active');
    if (!page) return;
    const cards = Array.from(page.querySelectorAll('.runtime-agent-card, .agent-card'));
    if (!cards.length) return;

    // Remove previous focus
    cards.forEach(c => c.classList.remove('kbd-focused'));

    this._kbdIndex = Math.max(0, Math.min(cards.length - 1, (this._kbdIndex + direction + cards.length) % cards.length));

    const card = cards[this._kbdIndex];
    card.classList.add('kbd-focused');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  _kbdClearFocus() {
    document.querySelectorAll('.runtime-agent-card.kbd-focused, .agent-card.kbd-focused').forEach(c => c.classList.remove('kbd-focused'));
    this._kbdIndex = -1;
  },

  // --- #50: Auto-refresh countdown (30s) ---
  // --- #108, #133: About / Version info page ---
  async loadAbout() {
    try {
      const res = await fetch(`${BASE}/api/about`);
      if (!res.ok) return;
      const info = await res.json();
      const el = (id) => document.getElementById(id);
      // Client info — same version/commit as server since no separate build step
      if (el('about-client-version')) el('about-client-version').textContent = info.version || '-';
      if (el('about-client-commit')) el('about-client-commit').textContent = info.commit || '-';
      if (el('about-client-build')) el('about-client-build').textContent = info.buildTime ? new Date(info.buildTime).toLocaleString() : '-';
      // Server info
      if (el('about-server-version')) el('about-server-version').textContent = info.version || '-';
      if (el('about-server-commit')) el('about-server-commit').textContent = info.commit || '-';
      if (el('about-server-build')) el('about-server-build').textContent = info.buildTime ? new Date(info.buildTime).toLocaleString() : '-';
      if (el('about-uptime')) el('about-uptime').textContent = info.uptime || '-';
      if (el('about-node')) el('about-node').textContent = info.node || '-';
      if (el('about-scopes')) el('about-scopes').textContent = info.scopes || '-';
    } catch { /* ignore */ }
  },

  // --- #50: Auto-refresh countdown (30s) ---
  initAutoRefresh() {
    const INTERVAL = 30; // seconds
    let remaining = INTERVAL;
    const el = document.getElementById('refresh-countdown');
    const statusEl = document.getElementById('refresh-status');

    const tick = () => {
      if (!el) return;
      if (remaining <= 0) {
        el.textContent = '刷新中…';
        if (statusEl) statusEl.classList.add('refreshing');
        this.fetchAll().finally(() => {
          remaining = INTERVAL;
          if (statusEl) statusEl.classList.remove('refreshing');
        });
      } else {
        el.textContent = `${remaining}s`;
        if (statusEl) statusEl.classList.remove('refreshing');
        remaining--;
      }
    };

    tick();
    this._autoRefreshTimer = setInterval(tick, 1000);

    // Reset countdown whenever manual refresh fires
    const origFetch = this.fetchAll.bind(this);
    this.fetchAll = (...args) => {
      remaining = INTERVAL;
      if (el) el.textContent = '刷新中…';
      if (statusEl) statusEl.classList.add('refreshing');
      return origFetch(...args).finally(() => {
        if (statusEl) statusEl.classList.remove('refreshing');
      });
    };
  }
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
