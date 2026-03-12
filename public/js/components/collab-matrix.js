// Collaboration Heatmap Matrix Component (#29)
const CollabMatrix = {
  init() {
    // View toggle
    const graphBtn = document.getElementById('collab-view-graph');
    const matrixBtn = document.getElementById('collab-view-matrix');
    if (graphBtn && matrixBtn) {
      graphBtn.addEventListener('click', () => this._setView('graph'));
      matrixBtn.addEventListener('click', () => this._setView('matrix'));
    }
  },

  _currentView: 'graph',

  _setView(view) {
    this._currentView = view;
    const graphView = document.getElementById('collab-graph-view');
    const matrixView = document.getElementById('collab-matrix-view');
    const graphBtn = document.getElementById('collab-view-graph');
    const matrixBtn = document.getElementById('collab-view-matrix');

    if (graphView) graphView.style.display = view === 'graph' ? '' : 'none';
    if (matrixView) matrixView.style.display = view === 'matrix' ? '' : 'none';
    if (graphBtn) graphBtn.classList.toggle('active', view === 'graph');
    if (matrixBtn) matrixBtn.classList.toggle('active', view === 'matrix');

    // Resize graph canvas when switching back
    if (view === 'graph' && App.collabGraph) {
      requestAnimationFrame(() => App.collabGraph.resize());
    }
  },

  render(nodes, edges) {
    const container = document.getElementById('collab-matrix');
    if (!container) return;

    // Only show nodes that have edges
    const edgeAgents = new Set();
    for (const e of edges) {
      edgeAgents.add(e.source);
      edgeAgents.add(e.target);
    }
    const activeNodes = nodes.filter(n => edgeAgents.has(n.id));

    if (activeNodes.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无协作数据</div>';
      return;
    }

    // Sort nodes by total edge weight (most collaborative first)
    const weightMap = new Map();
    for (const e of edges) {
      weightMap.set(e.source, (weightMap.get(e.source) || 0) + e.weight);
      weightMap.set(e.target, (weightMap.get(e.target) || 0) + e.weight);
    }
    activeNodes.sort((a, b) => (weightMap.get(b.id) || 0) - (weightMap.get(a.id) || 0));

    // Build edge lookup: "a|b" -> { review, issue, project, total }
    const pairMap = new Map();
    for (const e of edges) {
      const pair = [e.source, e.target].sort().join('|');
      if (!pairMap.has(pair)) pairMap.set(pair, { review: 0, issue: 0, project: 0, total: 0, details: [] });
      const p = pairMap.get(pair);
      p[e.type] = (p[e.type] || 0) + e.weight;
      p.total += e.weight;
      if (e.details) p.details.push(...e.details);
    }

    // Find max weight for color scaling
    const maxWeight = Math.max(1, ...Array.from(pairMap.values()).map(p => p.total));

    // Build HTML table
    const names = activeNodes.map(n => n.name);
    let html = '<table class="matrix-table"><thead><tr><th></th>';
    for (const name of names) {
      html += `<th class="matrix-col-header"><span>${esc(name)}</span></th>`;
    }
    html += '</tr></thead><tbody>';

    for (let i = 0; i < names.length; i++) {
      html += `<tr><td class="matrix-row-header">${esc(names[i])}<span class="matrix-status ${activeNodes[i].online ? 'online' : 'offline'}"></span></td>`;
      for (let j = 0; j < names.length; j++) {
        if (i === j) {
          // Diagonal: show agent stats
          const s = activeNodes[i].stats || {};
          const total = (s.mr_count || 0) + (s.issue_count || 0);
          html += `<td class="matrix-cell matrix-diag" title="${esc(names[i])}: MR ${s.mr_count || 0}, Issue ${s.issue_count || 0}">${total || '-'}</td>`;
        } else {
          const pair = [names[i], names[j]].sort().join('|');
          const p = pairMap.get(pair);
          if (p && p.total > 0) {
            const intensity = Math.min(p.total / maxWeight, 1);
            const color = this._blendColor(p, intensity);
            const tooltip = this._cellTooltip(names[i], names[j], p);
            html += `<td class="matrix-cell matrix-active" style="background:${color}" title="${esc(tooltip)}">${p.total}</td>`;
          } else {
            html += '<td class="matrix-cell">-</td>';
          }
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  },

  _blendColor(p, intensity) {
    // Determine dominant type and blend color
    const types = [
      { type: 'review', weight: p.review || 0, r: 188, g: 140, b: 255 },
      { type: 'issue', weight: p.issue || 0, r: 63, g: 185, b: 80 },
      { type: 'project', weight: p.project || 0, r: 88, g: 166, b: 255 }
    ];
    const total = types.reduce((s, t) => s + t.weight, 0) || 1;
    let r = 0, g = 0, b = 0;
    for (const t of types) {
      const ratio = t.weight / total;
      r += t.r * ratio;
      g += t.g * ratio;
      b += t.b * ratio;
    }
    const alpha = 0.15 + intensity * 0.65;
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha.toFixed(2)})`;
  },

  _cellTooltip(a, b, p) {
    const parts = [`${a} ↔ ${b} (共 ${p.total} 次)`];
    if (p.review) parts.push(`Review: ${p.review}`);
    if (p.issue) parts.push(`Issue: ${p.issue}`);
    if (p.project) parts.push(`同项目: ${p.project}`);
    return parts.join('\n');
  }
};
