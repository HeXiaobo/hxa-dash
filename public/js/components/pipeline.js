// Pipeline View — dependency-driven task flow (#77)
const Pipeline = {
  _data: null,
  _fingerprints: {},
  _projectFilter: '',

  init() {
    const select = document.getElementById('pipeline-project-filter');
    if (select) {
      select.addEventListener('change', () => {
        this._projectFilter = select.value;
        this.fetch();
      });
    }
  },

  async fetch() {
    try {
      const url = this._projectFilter
        ? `${BASE}/api/pipeline?project=${encodeURIComponent(this._projectFilter)}`
        : `${BASE}/api/pipeline`;
      const res = await fetch(url);
      if (!res.ok) return;
      this._data = await res.json();
      this._populateProjectFilter();
      this.render();
    } catch (err) {
      console.error('[Pipeline] fetch error:', err);
    }
  },

  render() {
    if (!this._data) return;
    this._renderSummary(this._data.summary);
    this._renderStages(this._data.tasks);
    this._renderEdges(this._data.tasks, this._data.edges);
  },

  update(data) {
    if (data) this._data = data;
    this.render();
  },

  _populateProjectFilter() {
    const select = document.getElementById('pipeline-project-filter');
    if (!select || !this._data) return;
    const projects = new Set(this._data.tasks.map(t => t.project).filter(Boolean));
    const current = select.value;
    select.innerHTML = '<option value="">全部项目</option>' +
      [...projects].sort().map(p =>
        `<option value="${esc(p)}"${p === current ? ' selected' : ''}>${esc(p)}</option>`
      ).join('');
  },

  _renderSummary(summary) {
    const el = document.getElementById('pipeline-summary');
    if (!el || !summary) return;
    const fp = JSON.stringify(summary);
    if (this._fingerprints._summary === fp) return;
    this._fingerprints._summary = fp;

    el.innerHTML = `
      <div class="pipe-stat pipe-stat-executing">
        <span class="pipe-stat-num">${summary.executing}</span>
        <span class="pipe-stat-label">执行中</span>
      </div>
      <div class="pipe-stat pipe-stat-assigned">
        <span class="pipe-stat-num">${summary.assigned}</span>
        <span class="pipe-stat-label">已分配</span>
      </div>
      <div class="pipe-stat pipe-stat-ready">
        <span class="pipe-stat-num">${summary.ready}</span>
        <span class="pipe-stat-label">可开始</span>
      </div>
      <div class="pipe-stat pipe-stat-blocked">
        <span class="pipe-stat-num">${summary.blocked}</span>
        <span class="pipe-stat-label">等待依赖</span>
      </div>
      ${summary.critical > 0 ? `
      <div class="pipe-stat pipe-stat-critical">
        <span class="pipe-stat-num">${summary.critical}</span>
        <span class="pipe-stat-label">⚠ 瓶颈</span>
      </div>` : ''}
    `;
  },

  _renderStages(tasks) {
    const stages = {
      executing: document.getElementById('pipe-executing'),
      assigned: document.getElementById('pipe-assigned'),
      ready: document.getElementById('pipe-ready'),
      blocked: document.getElementById('pipe-blocked')
    };

    for (const [stage, el] of Object.entries(stages)) {
      if (!el) continue;
      const stageTasks = tasks.filter(t => t.stage === stage);
      const fp = JSON.stringify(stageTasks.map(t => [t.iid, t.title, t.assignee, t.isCritical, t.criticalScore]));
      if (this._fingerprints[`stage_${stage}`] === fp) continue;
      this._fingerprints[`stage_${stage}`] = fp;

      if (stageTasks.length === 0) {
        el.innerHTML = '<div class="pipe-empty">无任务</div>';
        continue;
      }

      el.innerHTML = stageTasks.map(t => this._taskCardHTML(t)).join('');
    }
  },

  _taskCardHTML(t) {
    const criticalClass = t.isCritical ? 'pipe-card-critical' : '';
    const assigneeHTML = t.assignee
      ? `<span class="pipe-assignee">${esc(t.assignee)}</span>`
      : '<span class="pipe-unassigned">未分配</span>';

    const depsHTML = t.dependencies.length > 0
      ? `<div class="pipe-deps">${t.dependencies.map(d =>
          `<span class="pipe-dep ${d.met ? 'pipe-dep-met' : 'pipe-dep-unmet'}" title="${esc(d.title)}">#${d.iid} ${d.met ? '✓' : '⏳'}</span>`
        ).join('')}</div>`
      : '';

    const downstreamHTML = t.downstreamCount > 0
      ? `<span class="pipe-downstream" title="blocks ${t.downstreamCount} tasks">→ ${t.downstreamCount}</span>`
      : '';

    const link = t.url
      ? `<a href="${esc(t.url)}" target="_blank" class="pipe-title">${esc(truncate(t.title, 60))}</a>`
      : `<span class="pipe-title">${esc(truncate(t.title, 60))}</span>`;

    return `<div class="pipe-card ${criticalClass}" data-iid="${t.iid}" data-project-id="${t.projectId}">
      <div class="pipe-card-header">
        <span class="pipe-iid">#${t.iid}</span>
        ${link}
        ${downstreamHTML}
      </div>
      <div class="pipe-card-meta">
        ${assigneeHTML}
        <span class="pipe-project">${esc(t.project)}</span>
        ${t.isCritical ? '<span class="pipe-critical-badge">瓶颈</span>' : ''}
      </div>
      ${depsHTML}
    </div>`;
  },

  _renderEdges(tasks, edges) {
    const canvas = document.getElementById('pipe-dep-canvas');
    if (!canvas || !edges.length) {
      if (canvas) canvas.style.display = 'none';
      return;
    }

    // Only render dep lines if container is visible
    const container = document.getElementById('pipeline-flow');
    if (!container || container.offsetHeight === 0) return;

    canvas.style.display = 'block';
    canvas.width = container.offsetWidth;
    canvas.height = container.offsetHeight;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Find card positions for edge drawing
    const cards = container.querySelectorAll('.pipe-card');
    const cardPositions = new Map();
    for (const card of cards) {
      const iid = parseInt(card.dataset.iid);
      const rect = card.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      cardPositions.set(iid, {
        x: rect.left - containerRect.left + rect.width / 2,
        y: rect.top - containerRect.top + rect.height / 2,
        right: rect.right - containerRect.left,
        left: rect.left - containerRect.left
      });
    }

    ctx.lineWidth = 1.5;
    for (const edge of edges) {
      const from = cardPositions.get(edge.from);
      const to = cardPositions.get(edge.to);
      if (!from || !to) continue;

      ctx.strokeStyle = edge.met
        ? 'rgba(63, 185, 80, 0.4)'
        : 'rgba(210, 153, 34, 0.6)';
      ctx.setLineDash(edge.met ? [] : [4, 3]);

      ctx.beginPath();
      ctx.moveTo(from.right, from.y);
      const midX = (from.right + to.left) / 2;
      ctx.bezierCurveTo(midX, from.y, midX, to.y, to.left, to.y);
      ctx.stroke();

      // Arrow
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(to.left, to.y);
      ctx.lineTo(to.left - 6, to.y - 3);
      ctx.lineTo(to.left - 6, to.y + 3);
      ctx.fill();
    }
  }
};
