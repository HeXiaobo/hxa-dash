const LimitsDashboard = {
  _data: null,
  _loading: false,

  init() {},

  _formatTokenCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  },

  _formatQuotaText(quota) {
    const parts = [
      quota?.primary?.used_percent != null ? `${quota.primary.used_percent}% / 5h` : null,
      quota?.secondary?.used_percent != null ? `${quota.secondary.used_percent}% / 7d` : null,
    ].filter(Boolean);
    if (parts.length) return parts.join(' · ');
    if (quota?.reason === 'unsupported_for_now') return '暂不支持';
    if (quota?.reason === 'no_used_quota_window') return 'N/A (无窗口)';
    return '未提供';
  },

  _freshnessMeta(quota) {
    const freshness = quota?.freshness || {};
    const sampledAt = freshness.sampled_at || quota?.sampled_at || null;
    if (!quota?.supported) return { cls: 'muted', label: '—', title: quota?.reason || '未追踪' };
    if (!sampledAt) return { cls: 'stale', label: '无采样时间', title: '缺少 sampled_at' };
    const ageText = timeAgo(sampledAt);
    const timeText = formatTime(sampledAt);
    if (freshness.status === 'stale') {
      return { cls: 'stale', label: `${ageText} · 过期`, title: `采样于 ${timeText}` };
    }
    return { cls: 'fresh', label: `${ageText}`, title: `采样于 ${timeText}` };
  },

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
          <div class="metrics-card-value">${team.stale_count || 0}</div>
          <div class="metrics-card-label">采样过期</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${team.unsupported || 0}</div>
          <div class="metrics-card-label">暂不支持</div>
        </div>
        <div class="metrics-card">
          <div class="metrics-card-value">${team.usage_tracked || 0}</div>
          <div class="metrics-card-label">本地 Usage</div>
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
      const usage = agent.usage || {};
      const usageTokens = usage.session_tokens || {};
      const primary = quota.primary || {};
      const secondary = quota.secondary || {};
      const runtimeText = `${runtime.label || runtime.type || 'Unknown'}${runtime.version ? ` ${runtime.version}` : ''}`;
      const workText = agent.work_state === 'working' ? '工作中' : agent.work_state === 'standby' ? '待命' : '离线';
      const quotaText = this._formatQuotaText(quota);
      const freshness = this._freshnessMeta(quota);
      const tokenText = usage.supported
        ? [
            usageTokens.total != null ? this._formatTokenCount(usageTokens.total) : null,
            usageTokens.reasoning != null ? `推理 ${this._formatTokenCount(usageTokens.reasoning)}` : null,
            usage.session_cost_usd != null ? `$${Number(usage.session_cost_usd).toFixed(2)} 估算` : null,
          ].filter(Boolean).join(' · ') || '已观测'
        : '未提供';

      return `
        <tr>
          <td class="metrics-agent-name">${esc(agent.name)}</td>
          <td class="metrics-runtime-name" title="运行时：${esc(runtimeText)}">${esc(runtimeText)}</td>
          <td>${esc(workText)}</td>
          <td>${esc(quotaText)}</td>
          <td><span class="quota-freshness ${freshness.cls}" title="${esc(freshness.title)}">${esc(freshness.label)}</span></td>
          <td>${esc(tokenText)}</td>
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
              <th>运行时</th>
              <th>状态</th>
              <th>限额用量</th>
              <th>采样时间</th>
              <th>本地 Usage</th>
              <th>5h 重置</th>
              <th>7d 重置</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="8" class="metrics-empty">暂无限额数据</td></tr>'}</tbody>
        </table>
      </div>
    `;
  },
};
