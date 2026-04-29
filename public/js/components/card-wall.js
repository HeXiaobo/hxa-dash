// Agent Card Wall Component (v3: incremental DOM updates — #43)
const CardWall = {
  init() {},

  _formatTokenCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  },

  _quotaStat(window, label, title, icon) {
    if (window?.used_percent == null) return '';
    return `<span class="card-stat" title="${title}">${icon} ${window.used_percent}% / ${label}</span>`;
  },

  // Fingerprint for detecting meaningful changes (online state, work status, tasks, stats)
  _fingerprint(agent) {
    const tasks = (agent.current_tasks || []).map(t => t.title).join('|');
    const s = agent.stats || {};
    const bmrs = (agent.blocking_mrs || []).map(m => m.title + ':' + m.minutes_stale).join('|');
    const runtime = agent.runtime || {};
    const quota = agent.quota || {};
    const usage = agent.usage || {};
    const sessionTokens = usage.session_tokens || {};
    const lastTurnTokens = usage.last_turn_tokens || {};
    const quotaWindow = (window) => window
      ? [
          window.label || '',
          window.window_minutes || '',
          window.used_percent ?? '',
          window.resets_at || ''
        ].join(':')
      : '';
    const credits = quota.credits || {};
    const hw = agent.hardware || {};
    return [
      agent.online ? 1 : 0,
      agent.work_state || '',
      agent.work_status || '',
      agent.runtime_status || '',
      agent.role || '',
      agent.bio || '',
      tasks,
      s.open_tasks, s.closed_tasks, s.mr_count, s.issue_count,
      s.closed_last_7d, s.closed_last_30d,
      (agent.capacity || {}).current, (agent.capacity || {}).max,
      agent.health_score,
      (agent.latest_event || {}).target_title,
      (agent.active_projects || []).join('|'),
      (agent.tags || []).join('|'),
      (agent.top_collaborator || {}).name,
      agent.last_active_at || '',
      agent.events_7d || 0,
      agent.closed_7d || 0,
      bmrs,
      (agent.sparkline_7d || []).join(','),
      runtime.type || '',
      runtime.label || '',
      runtime.version || '',
      runtime.status || '',
      runtime.source || '',
      runtime.detection_source || '',
      runtime.checked_at || '',
      runtime.last_heartbeat_at || '',
      runtime.stale ? 1 : 0,
      runtime.system_health || '',
      agent.last_heartbeat_at || '',
      quota.supported === true ? 1 : quota.supported === false ? 0 : '',
      quota.source || '',
      quota.reason || '',
      quota.sampled_at || '',
      quotaWindow(quota.primary),
      quotaWindow(quota.secondary),
      credits.total ?? '',
      credits.remaining ?? '',
      usage.supported === true ? 1 : usage.supported === false ? 0 : '',
      usage.source || '',
      usage.reason || '',
      usage.sampled_at || '',
      usage.model || '',
      usage.plan_type || '',
      usage.session_cost_usd ?? '',
      usage.estimated_cost ? 1 : 0,
      sessionTokens.input ?? '',
      sessionTokens.output ?? '',
      sessionTokens.cache_creation ?? '',
      sessionTokens.cache_read ?? '',
      sessionTokens.cached_input ?? '',
      sessionTokens.reasoning ?? '',
      sessionTokens.total ?? '',
      lastTurnTokens.input ?? '',
      lastTurnTokens.output ?? '',
      lastTurnTokens.total ?? '',
      hw.disk_pct ?? '',
      hw.disk_status || '',
      hw.mem_pct ?? '',
      hw.mem_status || '',
      hw.cpu_pct ?? '',
      hw.pm2_online ?? '',
      hw.pm2_total ?? '',
      hw.runtime_type || '',
      hw.runtime_version || '',
      hw.runtime_status || '',
      hw.system_health || '',
      hw.stale ? 1 : 0,
      hw.reported_at || ''
    ].join('\x1f');
  },

  // Render to a specific container — incremental update (#43)
  renderTo(containerId, statsId, agents) {
    const container = document.getElementById(containerId);
    const statsEl = document.getElementById(statsId);
    if (!container) return;

    // Clear skeleton placeholders on first real render (#105)
    container.querySelectorAll('.skeleton-card').forEach(el => el.remove());

    // Sort: online first, then by name
    const sorted = [...agents].sort((a, b) => {
      if (a.online !== b.online) return b.online - a.online;
      return (a.name || '').localeCompare(b.name || '');
    });

    const newNames = sorted.map(a => a.name);
    const existingCards = new Map();
    container.querySelectorAll('.agent-card[data-name]').forEach(el => {
      existingCards.set(el.dataset.name, el);
    });

    // Remove cards no longer in the list
    for (const [name, el] of existingCards) {
      if (!newNames.includes(name)) el.remove();
    }

    // Insert / update cards in correct order
    sorted.forEach((agent, idx) => {
      const existing = existingCards.get(agent.name);
      const fp = this._fingerprint(agent);

      if (!existing) {
        // New card — insert at correct position and animate in
        const el = document.createElement('div');
        el.innerHTML = this.cardHTML(agent);
        const card = el.firstElementChild;
        card.classList.add('card-enter');
        card.addEventListener('animationend', () => card.classList.remove('card-enter'), { once: true });
        card.setAttribute('data-fp', fp);
        const ref = container.children[idx];
        container.insertBefore(card, ref || null);
        card.addEventListener('click', () => DetailDrawer.open(card.dataset.name));
      } else {
        // Move to correct position if needed
        const currentIdx = Array.from(container.children).indexOf(existing);
        if (currentIdx !== idx) {
          const ref = container.children[idx];
          container.insertBefore(existing, ref || null);
        }

        // Update content only if fingerprint changed
        if (existing.getAttribute('data-fp') !== fp) {
          const el = document.createElement('div');
          el.innerHTML = this.cardHTML(agent);
          const newCard = el.firstElementChild;
          newCard.setAttribute('data-fp', fp);
          newCard.classList.add('card-flash');
          existing.replaceWith(newCard);
          newCard.addEventListener('click', () => DetailDrawer.open(newCard.dataset.name));
        }
      }
    });

    // #105: remove any orphan children that aren't agent cards (skeleton debris, etc.)
    for (const child of [...container.children]) {
      if (!child.classList.contains('agent-card') || !child.dataset.name) {
        child.remove();
      }
    }

    // Stats (HxA Friendly #58: unified Human+Agent language)
    const active = agents.filter(a => a.runtime_status !== 'offline').length;
    if (statsEl) statsEl.textContent = `${active} 运行中 / ${agents.length} 成员`;
  },

  cardHTML(agent) {
    const tasks = agent.current_tasks || [];
    const stats = agent.stats || {};
    const latestEvent = agent.latest_event;
    const onlineClass = agent.online ? 'online' : 'offline';
    const lastSeen = agent.last_seen_at ? timeAgo(agent.last_seen_at) : '';

    // Identity badge (HxA Friendly #58: Human/Agent parity, subtle label)
    const kind = agent.kind || 'agent'; // 'human' | 'agent'
    const kindBadge = kind === 'human'
      ? '<span class="kind-badge kind-human" title="Human">🧑</span>'
      : '<span class="kind-badge kind-agent" title="Agent">🤖</span>';

    const workState = agent.work_state || agent.work_status || 'offline';
    const runtimeStatus = agent.runtime_status || agent.tier_status || 'offline';
    const runtime = agent.runtime || {};
    const runtimeType = runtime.label || runtime.type || 'Unknown';
    const runtimeVersion = runtime.version ? ` ${runtime.version}` : '';
    const statusLabels = { working: '🟢 工作中', standby: '🟡 待命', offline: '⚫ 离线' };
    const runtimeLabels = { running: '运行正常', degraded: '异常', offline: '未运行' };
    const badgeClass = workState === 'working' ? 'busy' : workState === 'standby' ? 'idle' : 'offline';
    const statusLabel = statusLabels[workState] || statusLabels.offline;

    const hs = agent.health_score != null ? agent.health_score : null;
    const hsClass = hs != null ? (hs > 70 ? 'health-green' : hs >= 40 ? 'health-yellow' : 'health-red') : '';
    const healthHTML = hs != null
      ? `<span class="health-dot ${hsClass}" title="健康分: ${hs}"></span>`
      : '';

    // Last active time (#98) — show for all agents
    const lastActiveAt = agent.last_active_at;
    const lastActiveHTML = lastActiveAt
      ? `<div class="card-last-active">最后活跃: ${timeAgo(lastActiveAt)}</div>`
      : (!agent.online && lastSeen)
        ? `<div class="card-last-active">最后活跃: ${lastSeen}</div>`
        : '';

    // Blocking MRs (#98) — red light for stale MRs
    const blockingMRs = agent.blocking_mrs || [];
    const blockingHTML = blockingMRs.length > 0
      ? `<div class="card-blocking-mrs">
          ${blockingMRs.slice(0, 2).map(m => {
            const severity = m.minutes_stale > 30 ? 'critical' : 'warning';
            const link = m.url
              ? `<a href="${esc(m.url)}" class="blocking-mr-link" target="_blank" rel="noopener" onclick="event.stopPropagation()">🔀 ${esc(truncate(m.title, 35))}</a>`
              : `<span class="blocking-mr-link">🔀 ${esc(truncate(m.title, 35))}</span>`;
            return `<div class="blocking-mr-item ${severity}">
              <span class="blocking-light"></span>
              ${link}
              <span class="blocking-time">${m.minutes_stale}m</span>
            </div>`;
          }).join('')}
          ${blockingMRs.length > 2 ? `<div class="blocking-mr-item more">+${blockingMRs.length - 2} more</div>` : ''}
        </div>`
      : '';

    const tags = agent.tags || [];
    const tagsHTML = tags.length > 0
      ? `<div class="card-tags">${tags.map(t => `<span class="tag-badge">${esc(t)}</span>`).join('')}</div>`
      : '';

    const cap = agent.capacity || { current: 0, max: 5 };
    const capPct = cap.max > 0 ? Math.min(100, Math.round((cap.current / cap.max) * 100)) : 0;
    const capClass = capPct > 80 ? 'cap-high' : capPct > 50 ? 'cap-mid' : 'cap-low';
    const capacityHTML = `
      <div class="card-capacity" title="负载: ${cap.current}/${cap.max}">
        <span class="cap-label">${cap.current}/${cap.max}</span>
        <div class="cap-bar"><div class="cap-fill ${capClass}" style="width:${capPct}%"></div></div>
      </div>
    `;

    const activeProjects = agent.active_projects || [];
    const projectsHTML = activeProjects.length > 0
      ? `<div class="card-active-projects">${activeProjects.map(p => `<span class="project-badge">${esc(p)}</span>`).join('')}</div>`
      : '';

    const topCollab = agent.top_collaborator;
    const collabHTML = topCollab
      ? `<div class="card-top-collab" title="最佳拍档 (权重 ${topCollab.weight})">🤝 ${esc(topCollab.name)}</div>`
      : '';

    const isUnknownRuntime = runtimeType === 'Unknown' || runtimeType === 'unknown' || !runtimeType;
    const runtimeHTML = isUnknownRuntime && runtimeStatus !== 'running' ? `
      <div class="card-hardware">
        <span class="hw-badge hw-stale" title="Runtime">待接入</span>
      </div>
    ` : `
      <div class="card-hardware">
        <span class="hw-badge ${runtimeStatus === 'running' ? 'hw-ok' : runtimeStatus === 'degraded' ? 'hw-warn' : 'hw-crit'}" title="Runtime">
          ⚙️ ${esc(runtimeType)}${esc(runtimeVersion)}
        </span>
        <span class="hw-badge ${runtimeStatus === 'running' ? 'hw-ok' : runtimeStatus === 'degraded' ? 'hw-warn' : 'hw-crit'}" title="运行状态">
          ${esc(runtimeLabels[runtimeStatus] || '未提供')}
        </span>
        ${agent.last_heartbeat_at ? `<span class="hw-badge hw-ok" title="最后心跳">🫀 ${esc(timeAgo(agent.last_heartbeat_at))}</span>` : ''}
      </div>
    `;

    // Hardware resource badges (#122)
    const hw = agent.hardware;
    const hwHTML = hw && !hw.stale ? (() => {
      const badge = (label, pct, status) => {
        if (pct == null) return '';
        const cls = status === 'critical' ? 'hw-crit' : status === 'warning' ? 'hw-warn' : 'hw-ok';
        return `<span class="hw-badge ${cls}" title="${label}: ${pct}%">${label} ${pct}%</span>`;
      };
      return `<div class="card-hardware">
        ${badge('💾', hw.disk_pct, hw.disk_status)}
        ${badge('🧠', hw.mem_pct, hw.mem_status)}
        ${hw.cpu_pct != null ? badge('⚡', hw.cpu_pct, hw.cpu_pct > 90 ? 'critical' : hw.cpu_pct > 80 ? 'warning' : 'ok') : ''}
        ${hw.pm2_total != null ? `<span class="hw-badge hw-ok" title="PM2: ${hw.pm2_online}/${hw.pm2_total}">⚙️ ${hw.pm2_online}/${hw.pm2_total}</span>` : ''}
      </div>`;
    })() : '';

    const statsHTML = `
      <div class="card-stats">
        <span class="card-stat" title="进行中任务">📋 ${stats.open_tasks || 0}</span>
        <span class="card-stat" title="近 24h 沟通">💬 ${stats.messages_24h || 0}</span>
        <span class="card-stat" title="近 24h 推进">🚀 ${stats.tasks_24h || 0}</span>
        <span class="card-stat" title="近 7 天活跃天数">📆 ${stats.active_days_7d || 0}</span>
      </div>
    `;

    // Activity metrics (#135): events and closed tasks in last 7 days
    const events7d = agent.events_7d;
    const closed7d = agent.closed_7d;
    const activityMetricsHTML = (events7d != null || closed7d != null) ? `
      <div class="card-activity-metrics">
        <span class="card-stat" title="近 7 天事件数">⚡ ${events7d || 0} 事件/7d</span>
        <span class="card-stat" title="近 7 天完成数">🏁 ${closed7d || 0} 完成/7d</span>
      </div>
    ` : '';

    const sparklineHTML = (typeof MemberOutput !== 'undefined' && agent.sparkline_7d)
      ? MemberOutput.renderMiniSparkline(agent.sparkline_7d)
      : '';

    const quota = agent.quota || {};
    const quotaStats = [
      this._quotaStat(quota.primary, '5h', '5 小时限额', '⏳'),
      this._quotaStat(quota.secondary, '7d', '7 天限额', '📅'),
    ].filter(Boolean).join('');
    const quotaHTML = quota.supported && quotaStats ? `
      <div class="card-activity-metrics">
        ${quotaStats}
      </div>
    ` : runtime.type === 'openclaw'
      ? `<div class="card-activity-metrics"><span class="card-stat" title="OpenClaw 暂不支持限额">🧩 OpenClaw</span></div>`
      : runtime.type === 'codex'
        ? `<div class="card-activity-metrics"><span class="card-stat" title="Codex 额度数据待更新（需活跃会话产生限额快照）">⏳ 额度待更新</span></div>`
        : '';
    const usage = agent.usage || {};
    const usageTokens = usage.session_tokens || {};
    const usageTotal = usageTokens.total ?? ((usageTokens.input || 0) + (usageTokens.output || 0));
    const cacheTokens = (usageTokens.cache_creation || 0) + (usageTokens.cache_read || 0) + (usageTokens.cached_input || 0);
    const usageHTML = usage.supported && usageTotal ? `
      <div class="card-activity-metrics">
        <span class="card-stat" title="本机会话用量，本地观测非账单口径">🧮 ${this._formatTokenCount(usageTotal)}</span>
        ${cacheTokens ? `<span class="card-stat" title="缓存用量">🗄️ ${this._formatTokenCount(cacheTokens)}</span>` : ''}
        ${usageTokens.reasoning ? `<span class="card-stat" title="推理用量">🧠 ${this._formatTokenCount(usageTokens.reasoning)}</span>` : ''}
      </div>
    ` : '';

    const avgTime = stats.avg_completion_ms ? this.formatDuration(stats.avg_completion_ms) : '—';
    const historyHTML = (stats.closed_last_7d != null || stats.closed_last_30d != null) ? `
      <details class="card-history" onclick="event.stopPropagation()">
        <summary class="history-toggle">📊 历史统计 ${sparklineHTML}</summary>
        <div class="history-grid">
          <span class="history-label">近 7 天</span><span class="history-value">${stats.closed_last_7d || 0} 完成</span>
          <span class="history-label">近 30 天</span><span class="history-value">${stats.closed_last_30d || 0} 完成</span>
          <span class="history-label">平均耗时</span><span class="history-value">${avgTime}</span>
        </div>
      </details>
    ` : '';

    const activityHTML = latestEvent ? `
      <div class="card-latest-activity" title="${latestEvent.project || ''}">
        <span class="activity-action">${esc(latestEvent.action || '')}</span>
        <span class="activity-target">${esc(truncate(latestEvent.target_title || '', 30))}</span>
        <span class="activity-time">${latestEvent.timestamp ? timeAgo(latestEvent.timestamp) : ''}</span>
      </div>
    ` : '';

    const tasksHTML = tasks.length > 0 ? `
      <div class="agent-tasks-preview">
        ${tasks.slice(0, 2).map(t => {
          const icon = t.type === 'mr' ? '🔀' : '📝';
          const proj = t.project ? `<span class="task-project">${esc(t.project)}</span>` : '';
          const link = t.url
            ? `<a href="${esc(t.url)}" class="task-link" target="_blank" rel="noopener" onclick="event.stopPropagation()">${icon} ${esc(truncate(t.title, 35))}</a>`
            : `<span class="task-link">${icon} ${esc(truncate(t.title, 35))}</span>`;
          return `<div class="task-item">${link}${proj}</div>`;
        }).join('')}
        ${tasks.length > 2 ? `<div class="task-item task-more">+${tasks.length - 2} more</div>` : ''}
      </div>
    ` : '';

    const offlineBanner = !agent.online ? '<span class="offline-banner">离线</span>' : '';

    return `
      <div class="agent-card ${onlineClass}" data-name="${esc(agent.name)}">
        ${offlineBanner}
        <div class="card-top">
          <div class="card-top-left">${healthHTML}${kindBadge}<span class="agent-name">${esc(agent.name)}</span></div>
          <span class="work-status-badge ${badgeClass}" title="${workState}">${statusLabel}</span>
        </div>
        <div class="agent-role">${esc(agent.role || (agent.kind === 'human' ? '团队成员' : 'AI Agent'))}</div>
        ${agent.bio ? `<div class="agent-bio">${esc(truncate(agent.bio, 60))}</div>` : ''}
        ${lastActiveHTML}
        ${runtimeHTML}
        ${blockingHTML}
        ${tagsHTML}
        ${capacityHTML}
        ${hwHTML}
        ${projectsHTML}
        ${collabHTML}
        ${statsHTML}
        ${quotaHTML}
        ${usageHTML}
        ${activityMetricsHTML}
        ${historyHTML}
        ${tasksHTML}
        ${activityHTML}
      </div>
    `;
  },

  formatDuration(ms) {
    const hours = ms / (1000 * 60 * 60);
    if (hours < 1) return `${Math.round(ms / (1000 * 60))}m`;
    if (hours < 24) return `${Math.round(hours)}h`;
    const days = hours / 24;
    return `${days.toFixed(1)}d`;
  }
};
