// Agent Card Wall Component (v3: incremental DOM updates — #43)
const CardWall = {
  init() {},

  // Fingerprint for detecting meaningful changes (online state, work status, tasks, stats)
  _fingerprint(agent) {
    const tasks = (agent.current_tasks || []).map(t => t.title).join('|');
    const s = agent.stats || {};
    const bmrs = (agent.blocking_mrs || []).map(m => m.title + ':' + m.minutes_stale).join('|');
    return [
      agent.online ? 1 : 0,
      agent.work_status || '',
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
      bmrs,
      (agent.sparkline_7d || []).join(','),
      agent.hardware ? `${agent.hardware.disk_pct}|${agent.hardware.mem_pct}|${agent.hardware.cpu_pct}` : ''
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
    const active = agents.filter(a => a.online).length;
    if (statsEl) statsEl.textContent = `${active} 活跃 / ${agents.length} 成员`;
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

    // Work status badge (#38)
    const workStatus = agent.work_status || (agent.online ? 'idle' : 'offline');
    const statusLabels = { busy: '🔴 繁忙', idle: '🟢 空闲', offline: '⚫ 离线' };
    const statusLabel = statusLabels[workStatus] || statusLabels.offline;

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
        <span class="card-stat" title="已完成">✅ ${stats.closed_tasks || 0}</span>
        <span class="card-stat" title="合并请求">🔀 ${stats.mr_count || 0}</span>
        <span class="card-stat" title="Issue">📝 ${stats.issue_count || 0}</span>
      </div>
    `;

    const sparklineHTML = (typeof MemberOutput !== 'undefined' && agent.sparkline_7d)
      ? MemberOutput.renderMiniSparkline(agent.sparkline_7d)
      : '';

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
          <span class="work-status-badge ${workStatus}" title="${workStatus}">${statusLabel}</span>
        </div>
        <div class="agent-role">${esc(agent.role || (agent.kind === 'human' ? '团队成员' : 'AI Agent'))}</div>
        ${agent.bio ? `<div class="agent-bio">${esc(truncate(agent.bio, 60))}</div>` : ''}
        ${lastActiveHTML}
        ${blockingHTML}
        ${tagsHTML}
        ${capacityHTML}
        ${hwHTML}
        ${projectsHTML}
        ${collabHTML}
        ${statsHTML}
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
