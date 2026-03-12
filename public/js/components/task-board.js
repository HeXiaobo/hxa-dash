// Task Board Component (v3: animations + unassigned display)
const TaskBoard = {
  // Track previous state for change detection
  _prevCounts: {},

  init() {},

  // Render to a specific page prefix (overview or tasks)
  renderTo(prefix, board) {
    const isOverview = prefix === 'overview';
    const p = isOverview ? 'overview-' : '';

    this.renderColumn(`${p}todo`, board.todo || [], 'todo');
    this.renderColumn(`${p}doing`, board.doing || [], 'doing');
    this.renderColumn(`${p}done`, board.done || [], 'done');
  },

  renderColumn(stateId, tasks, colType) {
    const list = document.getElementById(`${stateId}-list`);
    const count = document.getElementById(`${stateId}-count`);
    if (!list) return;

    // Detect count change for pulse animation
    const prevCount = this._prevCounts[stateId];
    if (count) {
      count.textContent = tasks.length;
      if (prevCount !== undefined && prevCount !== tasks.length) {
        count.classList.remove('count-changed');
        // Force reflow to restart animation
        void count.offsetWidth;
        count.classList.add('count-changed');
      }
    }
    this._prevCounts[stateId] = tasks.length;

    if (tasks.length === 0) {
      list.innerHTML = '<div class="empty-state">暂无任务</div>';
      return;
    }

    // Track previous task IDs for detecting new/moved tasks
    const prevIds = new Set(list.querySelectorAll('.task-card[data-task-id]'));
    const prevIdSet = new Set();
    prevIds.forEach(el => prevIdSet.add(el.dataset.taskId));

    // Show max 30 per column
    const shown = tasks.slice(0, 30);
    list.innerHTML = shown.map((t, i) => {
      const labels = Array.isArray(t.labels) ? t.labels : safeParseJSON(t.labels);
      const isNew = prevIdSet.size > 0 && !prevIdSet.has(String(t.id));
      const isDone = colType === 'done' && isNew;
      const extraClass = isDone ? ' task-done-flash' : '';
      const delay = `animation-delay: ${i * 30}ms;`;
      return `
        <div class="task-card task-type-${esc(t.type)}${extraClass}" data-task-id="${esc(String(t.id))}" style="${delay}">
          <div class="task-title">
            <a href="${esc(t.url)}" target="_blank" style="color: var(--text); text-decoration: none;">
              ${esc(truncate(t.title, 60))}
            </a>
          </div>
          <div class="task-meta">
            ${t.assignee ? `<span class="task-assignee">${esc(t.assignee)}</span>` : '<span class="task-unassigned">未分配</span>'}
            <span>${esc(t.project)}</span>
            <span>${t.type}</span>
            ${t.updated_at ? `<span>${timeAgo(t.updated_at)}</span>` : ''}
          </div>
          ${labels.length > 0 ? `
            <div style="margin-top: 4px;">
              ${labels.slice(0, 3).map(l => `<span class="task-label">${esc(l)}</span>`).join(' ')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    if (tasks.length > 30) {
      list.innerHTML += `<div style="text-align:center; color: var(--text-secondary); font-size: 12px; padding: 8px;">+${tasks.length - 30} more</div>`;
    }
  }
};

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return []; }
}
