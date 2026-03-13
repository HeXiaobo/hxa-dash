// Agent Card Wall Component (v2: supports multiple render targets)
const CardWall = {
  init() {},

  // Render to a specific container
  renderTo(containerId, statsId, agents) {
    const container = document.getElementById(containerId);
    const statsEl = document.getElementById(statsId);
    if (!container) return;

    // Sort: online first, then by name
    const sorted = [...agents].sort((a, b) => {
      if (a.online !== b.online) return b.online - a.online;
      return (a.name || '').localeCompare(b.name || '');
    });

    container.innerHTML = sorted.map(agent => this.cardHTML(agent)).join('');

    // Stats
    const online = agents.filter(a => a.online).length;
    if (statsEl) statsEl.textContent = `${online} 在线 / ${agents.length} 总计`;

    // Click handlers
    container.querySelectorAll('.agent-card').forEach(card => {
      card.addEventListener('click', () => {
        DetailDrawer.open(card.dataset.name);
      });
    });
  },

  cardHTML(agent) {
    const tasks = agent.current_tasks || [];
    const stats = agent.stats || {};
    const latestEvent = agent.latest_event;
    const onlineClass = agent.online ? 'online' : 'offline';
    const lastSeen = agent.last_seen_at ? timeAgo(agent.last_seen_at) : '';

    // Work status badge (#38)
    const workStatus = agent.work_status || (agent.online ? 'idle' : 'offline');
    const statusLabels = { busy: '🔴 繁忙', idle: '🟢 空闲', offline: '⚫ 离线' };
    const statusLabel = statusLabels[workStatus] || statusLabels.offline;

    // Health score indicator (#45)
    const hs = agent.health_score != null ? agent.health_score : null;
    const hsClass = hs != null ? (hs > 70 ? 'health-green' : hs >= 40 ? 'health-yellow' : 'health-red') : '';
    const healthHTML = hs != null
      ? `<span class="health-dot ${hsClass}" title="健康分: ${hs}"></span>`
      : '';

    // Last seen prominently for offline agents (#44)
    const lastSeenHTML = (!agent.online && lastSeen)
      ? `<div class="card-last-seen">最后活跃: ${lastSeen}</div>`
      : '';

    // Tags / specialization badges (#44)
    const tags = agent.tags || [];
    const tagsHTML = tags.length > 0
      ? `<div class="card-tags">${tags.map(t => `<span class="tag-badge">${esc(t)}</span>`).join('')}</div>`
      : '';

    // Capacity bar (#44)
    const cap = agent.capacity || { current: 0, max: 5 };
    const capPct = Math.min(100, Math.round((cap.current / cap.max) * 100));
    const capClass = capPct > 80 ? 'cap-high' : capPct > 50 ? 'cap-mid' : 'cap-low';
    const capacityHTML = `
      <div class="card-capacity" title="负载: ${cap.current}/${cap.max}">
        <span class="cap-label">${cap.current}/${cap.max}</span>
        <div class="cap-bar"><div class="cap-fill ${capClass}" style="width:${capPct}%"></div></div>
      </div>
    `;

    // Active projects (#44)
    const activeProjects = agent.active_projects || [];
    const projectsHTML = activeProjects.length > 0
      ? `<div class="card-active-projects">${activeProjects.map(p => `<span class="project-badge">${esc(p)}</span>`).join('')}</div>`
      : '';

    // Top collaborator (#44)
    const topCollab = agent.top_collaborator;
    const collabHTML = topCollab
      ? `<div class="card-top-collab" title="最佳拍档 (权重 ${topCollab.weight})">🤝 ${esc(topCollab.name)}</div>`
      : '';

    // Stats bar: quick glance numbers
    const statsHTML = `
      <div class="card-stats">
        <span class="card-stat" title="进行中任务">📋 ${stats.open_tasks || 0}</span>
        <span class="card-stat" title="已完成">✅ ${stats.closed_tasks || 0}</span>
        <span class="card-stat" title="合并请求">🔀 ${stats.mr_count || 0}</span>
        <span class="card-stat" title="Issue">📝 ${stats.issue_count || 0}</span>
      </div>
    `;

    // Historical stats (collapsible, #39)
    const avgTime = stats.avg_completion_ms ? this.formatDuration(stats.avg_completion_ms) : '—';
    const historyHTML = (stats.closed_last_7d != null || stats.closed_last_30d != null) ? `
      <details class="card-history" onclick="event.stopPropagation()">
        <summary class="history-toggle">📊 历史统计</summary>
        <div class="history-grid">
          <span class="history-label">近 7 天</span><span class="history-value">${stats.closed_last_7d || 0} 完成</span>
          <span class="history-label">近 30 天</span><span class="history-value">${stats.closed_last_30d || 0} 完成</span>
          <span class="history-label">平均耗时</span><span class="history-value">${avgTime}</span>
        </div>
      </details>
    ` : '';

    // Latest activity
    const activityHTML = latestEvent ? `
      <div class="card-latest-activity" title="${latestEvent.project || ''}">
        <span class="activity-action">${esc(latestEvent.action || '')}</span>
        <span class="activity-target">${esc(truncate(latestEvent.target_title || '', 30))}</span>
        <span class="activity-time">${latestEvent.timestamp ? timeAgo(latestEvent.timestamp) : ''}</span>
      </div>
    ` : '';

    // Current tasks with clickable GitLab links (#38)
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

    return `
      <div class="agent-card ${onlineClass}" data-name="${esc(agent.name)}">
        <div class="card-top">
          <div class="card-top-left">${healthHTML}<span class="agent-name">${esc(agent.name)}</span></div>
          <span class="work-status-badge ${workStatus}" title="${workStatus}">${statusLabel}</span>
        </div>
        <div class="agent-role">${esc(agent.role || '—')}</div>
        ${agent.bio ? `<div class="agent-bio">${esc(truncate(agent.bio, 60))}</div>` : ''}
        ${lastSeenHTML}
        ${tagsHTML}
        ${capacityHTML}
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
