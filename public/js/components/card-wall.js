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

    // Stats bar: MR + Issue counts + completed
    const statsHTML = `
      <div class="card-stats">
        <span class="card-stat" title="进行中任务">📋 ${stats.open_tasks || 0}</span>
        <span class="card-stat" title="已完成">✅ ${stats.closed_tasks || 0}</span>
        <span class="card-stat" title="合并请求">🔀 ${stats.mr_count || 0}</span>
        <span class="card-stat" title="Issue">📝 ${stats.issue_count || 0}</span>
      </div>
    `;

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
          <span class="agent-name">${esc(agent.name)}</span>
          <span class="work-status-badge ${workStatus}" title="${workStatus}">${statusLabel}</span>
        </div>
        <div class="agent-role">${esc(agent.role || '—')}</div>
        ${agent.bio ? `<div class="agent-bio">${esc(truncate(agent.bio, 60))}</div>` : ''}
        ${statsHTML}
        ${tasksHTML}
        ${activityHTML}
      </div>
    `;
  }
};
