// Simple Force-Directed Graph Engine (Canvas-based)
class ForceGraph {
  constructor(canvas, emptyEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.emptyEl = emptyEl || null; // optional empty-state overlay element
    this.nodes = [];
    this.edges = [];
    this.dragging = null;
    this.hovering = null;
    this.hoveringEdge = null;
    this.mouseX = 0;
    this.mouseY = 0;
    this.animFrame = null;

    this.config = {
      repulsion: 800,
      attraction: 0.01,
      damping: 0.9,
      centerForce: 0.005,
      minDist: 60
    };

    this._initEvents();
  }

  setData(nodes, edges) {
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Preserve existing positions if node exists
    const oldMap = new Map(this.nodes.map(n => [n.id, n]));

    this.nodes = nodes.map(n => {
      const old = oldMap.get(n.id);
      return {
        ...n,
        x: old ? old.x : w / 2 + (Math.random() - 0.5) * w * 0.5,
        y: old ? old.y : h / 2 + (Math.random() - 0.5) * h * 0.5,
        vx: old ? old.vx : 0,
        vy: old ? old.vy : 0,
        radius: Math.max(16, 10 + (n.stats?.open_count || 0) * 3 + (n.stats?.closed_count || 0) * 1)
      };
    });

    this.edges = edges.map(e => ({
      ...e,
      sourceNode: this.nodes.find(n => n.id === e.source),
      targetNode: this.nodes.find(n => n.id === e.target)
    })).filter(e => e.sourceNode && e.targetNode);

    // Show/hide empty state
    if (this.emptyEl) {
      this.emptyEl.classList.toggle('hidden', this.edges.length > 0 || this.nodes.length > 0);
    }

    if (!this.animFrame) this._animate();
  }

  _initEvents() {
    const rect = () => this.canvas.getBoundingClientRect();

    this.canvas.addEventListener('mousemove', (e) => {
      const r = rect();
      const scaleX = this.canvas.width / r.width;
      const scaleY = this.canvas.height / r.height;
      this.mouseX = (e.clientX - r.left) * scaleX;
      this.mouseY = (e.clientY - r.top) * scaleY;

      if (this.dragging) {
        this.dragging.x = this.mouseX;
        this.dragging.y = this.mouseY;
        this.dragging.vx = 0;
        this.dragging.vy = 0;
      } else {
        this.hovering = this._findNode(this.mouseX, this.mouseY);
        this.hoveringEdge = this.hovering ? null : this._findEdge(this.mouseX, this.mouseY);
        this.canvas.style.cursor = this.hovering ? 'grab' : 'default';
      }
    });

    this.canvas.addEventListener('mousedown', (e) => {
      const r = rect();
      const scaleX = this.canvas.width / r.width;
      const scaleY = this.canvas.height / r.height;
      const x = (e.clientX - r.left) * scaleX;
      const y = (e.clientY - r.top) * scaleY;
      this.dragging = this._findNode(x, y);
      if (this.dragging) this.canvas.style.cursor = 'grabbing';
    });

    this.canvas.addEventListener('mouseup', () => {
      this.dragging = null;
      this.canvas.style.cursor = this.hovering ? 'grab' : 'default';
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.dragging = null;
      this.hovering = null;
    });
  }

  _findNode(x, y) {
    for (const n of this.nodes) {
      const dx = x - n.x, dy = y - n.y;
      if (dx * dx + dy * dy < n.radius * n.radius) return n;
    }
    return null;
  }

  _findEdge(x, y) {
    // Find edge within ~8px of mouse
    const threshold = 8;
    for (const e of this.edges) {
      const a = e.sourceNode, b = e.targetNode;
      // Point-to-segment distance
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx - x;
      const py = a.y + t * dy - y;
      if (px * px + py * py < threshold * threshold) return e;
    }
    return null;
  }

  _simulate() {
    const { repulsion, attraction, damping, centerForce, minDist } = this.config;
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;

    // Repulsion between all node pairs
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const a = this.nodes[i], b = this.nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < minDist) dist = minDist;
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Attraction along edges
    for (const e of this.edges) {
      const a = e.sourceNode, b = e.targetNode;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = dist * attraction * (1 + e.weight * 0.5);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // Center gravity
    for (const n of this.nodes) {
      n.vx += (cx - n.x) * centerForce;
      n.vy += (cy - n.y) * centerForce;
    }

    // Apply velocity with damping
    for (const n of this.nodes) {
      if (n === this.dragging) continue;
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
      // Bounds
      n.x = Math.max(n.radius, Math.min(this.canvas.width - n.radius, n.x));
      n.y = Math.max(n.radius, Math.min(this.canvas.height - n.radius, n.y));
    }
  }

  _draw() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    const edgeColors = { review: '#bc8cff', issue: '#3fb950', project: '#58a6ff' };

    // Draw edges
    for (const e of this.edges) {
      const a = e.sourceNode, b = e.targetNode;
      const isHighlighted = (this.hovering && (e.sourceNode === this.hovering || e.targetNode === this.hovering))
                         || e === this.hoveringEdge;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = edgeColors[e.type] || '#30363d';
      ctx.lineWidth = isHighlighted ? Math.min(3 + e.weight, 7) : Math.min(1 + e.weight * 0.8, 5);
      ctx.globalAlpha = isHighlighted ? 0.9 : 0.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Draw nodes
    for (const n of this.nodes) {
      const isHovered = n === this.hovering;

      // Node circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = n.online ? '#1a3a2a' : '#1c1c1c';
      ctx.fill();
      ctx.strokeStyle = n.online ? '#3fb950' : '#484f58';
      ctx.lineWidth = isHovered ? 3 : 1.5;
      ctx.stroke();

      // Name
      ctx.fillStyle = '#e6edf3';
      ctx.font = `${isHovered ? 'bold ' : ''}12px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.name, n.x, n.y);

      // Role below (on hover)
      if (isHovered && n.role) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.fillText(n.role, n.x, n.y + n.radius + 12);
      }
    }

    // Edge mid-label on hover (edge directly hovered)
    if (this.hoveringEdge) {
      const e = this.hoveringEdge;
      const midX = (e.sourceNode.x + e.targetNode.x) / 2;
      const midY = (e.sourceNode.y + e.targetNode.y) / 2;
      const typeLabels = { review: 'Code Review', issue: 'Issue 协作', project: '同项目' };
      const label = `${typeLabels[e.type] || e.type}  ×${e.weight}`;
      ctx.font = '11px -apple-system, sans-serif';
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = 'rgba(22,27,34,.92)';
      this._roundRect(ctx, midX - tw/2, midY - 10, tw, 20, 4);
      ctx.fill();
      ctx.strokeStyle = edgeColors[e.type] || '#484f58';
      ctx.lineWidth = 1;
      this._roundRect(ctx, midX - tw/2, midY - 10, tw, 20, 4);
      ctx.stroke();
      ctx.fillStyle = '#e6edf3';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, midX, midY);
    }

    // Multi-line tooltip for hovered node
    if (this.hovering) {
      const n = this.hovering;
      const s = n.stats || {};
      const connectedEdges = this.edges.filter(e => e.sourceNode === n || e.targetNode === n);
      const partnerNames = connectedEdges.map(e =>
        e.sourceNode === n ? e.targetNode.name : e.sourceNode.name
      ).slice(0, 3);

      const lines = [
        `${n.name}${n.role ? '  ' + n.role : ''}`,
        `进行中 ${s.open_count || 0}  · 已完成 ${s.closed_count || 0}`,
        connectedEdges.length > 0
          ? `协作伙伴 (${connectedEdges.length}): ${partnerNames.join(', ')}${connectedEdges.length > 3 ? '…' : ''}`
          : '暂无协作记录'
      ];

      ctx.font = '11px -apple-system, sans-serif';
      const lineH = 16;
      const pad = { x: 12, y: 8 };
      const boxW = Math.max(...lines.map(l => ctx.measureText(l).width)) + pad.x * 2;
      const boxH = lines.length * lineH + pad.y * 2;

      let tx = n.x - boxW / 2;
      let ty = n.y - n.radius - boxH - 8;
      // Keep in bounds
      tx = Math.max(4, Math.min(w - boxW - 4, tx));
      ty = Math.max(4, ty < 4 ? n.y + n.radius + 8 : ty);

      ctx.fillStyle = 'rgba(22,27,34,.93)';
      this._roundRect(ctx, tx, ty, boxW, boxH, 5);
      ctx.fill();
      ctx.strokeStyle = '#30363d';
      ctx.lineWidth = 1;
      this._roundRect(ctx, tx, ty, boxW, boxH, 5);
      ctx.stroke();

      lines.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? '#e6edf3' : '#8b949e';
        ctx.font = i === 0 ? 'bold 11px -apple-system, sans-serif' : '11px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(line, tx + pad.x, ty + pad.y + i * lineH);
      });
    }
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  _animate() {
    this._simulate();
    this._draw();
    this.animFrame = requestAnimationFrame(() => this._animate());
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
  }

  destroy() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
  }
}
