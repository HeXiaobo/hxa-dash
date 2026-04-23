// Member Output Component — per-agent rhythm visualization with optional technical context.
const MemberOutput = {
  _cache: new Map(), // name -> { data, fetchedAt }
  CACHE_TTL: 60000,  // 1 min

  async fetch(agentName, days = 30) {
    const cached = this._cache.get(agentName);
    if (cached && (Date.now() - cached.fetchedAt) < this.CACHE_TTL) return cached.data;

    try {
      const res = await fetch(`${BASE}/api/team/${encodeURIComponent(agentName)}/output?days=${days}`);
      if (!res.ok) return null;
      const data = await res.json();
      this._cache.set(agentName, { data, fetchedAt: Date.now() });
      return data;
    } catch { return null; }
  },

  // Render output section HTML for the detail drawer
  renderSection(data) {
    if (!data || !data.buckets || data.buckets.length === 0) {
      return '<div class="drawer-section"><h4>成员节奏</h4><div class="output-empty">暂无数据</div></div>';
    }

    const s = data.summary || {};
    const days = Number(data.days || 0);
    const buckets = Array.isArray(data.buckets) ? data.buckets : [];
    const totalEvents = Number(s.total_events || 0);
    const totalClosed = Number(s.issues_closed || 0);
    const totalMerged = Number(s.mrs_merged || 0);
    const totalCommits = Number(s.commits || 0);
    const totalComments = Number(s.comments || 0);
    const healthScore = s.health_score != null ? Number(s.health_score) : null;
    const changeHTML = s.change_pct != null
      ? `<span class="output-change ${s.change_pct >= 0 ? 'up' : 'down'}">${s.change_pct >= 0 ? '↑' : '↓'} ${Math.abs(s.change_pct)}%</span>`
      : '';
    const contextHTML = this._renderContext(data);
    const rhythmHTML = this._renderRhythmSummary(buckets, days, totalEvents);

    return `
      <div class="drawer-section output-section">
        <h4>成员节奏 <span class="output-period">${days}天</span> ${changeHTML}</h4>
        <div style="margin:6px 0 12px;color:var(--text-secondary);font-size:12px;line-height:1.5;">
          这是一张事件口径的活动视图，适合看协作节奏、推进密度和状态变化，不等于绩效。
        </div>
        ${contextHTML}
        ${rhythmHTML}

        <div class="output-summary-grid">
          <div class="output-stat"><span class="output-stat-num">${totalEvents}</span><span class="output-stat-label">活动</span></div>
          <div class="output-stat"><span class="output-stat-num">${totalClosed}</span><span class="output-stat-label">闭环</span></div>
          <div class="output-stat"><span class="output-stat-num">${totalMerged}</span><span class="output-stat-label">交付</span></div>
          <div class="output-stat"><span class="output-stat-num">${totalCommits}</span><span class="output-stat-label">变更</span></div>
          <div class="output-stat"><span class="output-stat-num">${totalComments}</span><span class="output-stat-label">沟通</span></div>
          <div class="output-stat"><span class="output-stat-num output-health">${healthScore != null ? healthScore : '—'}</span><span class="output-stat-label">运行分</span></div>
        </div>

        <div class="output-chart-label">每日节奏</div>
        ${this._renderActivityChart(data.buckets)}

        <div class="output-chart-label">事件构成</div>
        ${this._renderBreakdownChart(data.buckets)}
      </div>
    `;
  },

  // SVG sparkline for daily event counts
  _renderActivityChart(buckets) {
    const vals = buckets.map(b => b.events);
    return this._svgLine(vals, 'var(--accent)', 120, true);
  },

  // Stacked bar breakdown
  _renderBreakdownChart(buckets) {
    const w = 280, h = 60, pad = 2;
    const barW = Math.max(2, (w - pad * buckets.length) / buckets.length);
    const maxVal = Math.max(...buckets.map(b => Number(b.commits || 0) + Number(b.issues_closed || 0) + Number(b.mrs_merged || 0) + Number(b.comments || 0)), 1);

    const bars = buckets.map((b, i) => {
      const x = i * (barW + pad);
      const total = Number(b.commits || 0) + Number(b.issues_closed || 0) + Number(b.mrs_merged || 0) + Number(b.comments || 0);
      const scale = h / maxVal;
      let y = h;
      const segs = [];
      const draw = (val, color) => {
        const num = Number(val || 0);
        if (num <= 0) return;
        const segH = num * scale;
        y -= segH;
        segs.push(`<rect x="${x}" y="${y}" width="${barW}" height="${segH}" fill="${color}" rx="1"/>`);
      };
      draw(b.commits, '#bc8cff');
      draw(b.mrs_merged, '#58a6ff');
      draw(b.issues_closed, '#3fb950');
      draw(b.comments, '#f0883e');
      return segs.join('');
    }).join('');

    return `
      <svg class="output-breakdown-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        ${bars}
      </svg>
      <div class="output-legend">
        <span class="output-legend-item"><span class="output-dot" style="background:#3fb950"></span>闭环</span>
        <span class="output-legend-item"><span class="output-dot" style="background:#58a6ff"></span>交付</span>
        <span class="output-legend-item"><span class="output-dot" style="background:#bc8cff"></span>变更</span>
        <span class="output-legend-item"><span class="output-dot" style="background:#f0883e"></span>沟通</span>
      </div>
    `;
  },

  _renderContext(data) {
    const chips = [];
    const summary = data.summary || {};
    const runtime = data.runtime || summary.runtime || null;
    const version = data.version || summary.version || null;
    const quota = data.quota || summary.quota || null;

    if (runtime) {
      const runtimeLabel = runtime.label || runtime.status || runtime.type || '运行中';
      chips.push(`<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;background:rgba(88,166,255,.12);color:#79c0ff;font-size:11px;line-height:1.4;">运行态：${esc(String(runtimeLabel))}</span>`);
    } else if (data.work_state || summary.work_state) {
      chips.push(`<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;background:rgba(63,185,80,.12);color:#7ee787;font-size:11px;line-height:1.4;">工作状态：${esc(String(data.work_state || summary.work_state))}</span>`);
    }

    if (version) {
      chips.push(`<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;background:rgba(210,153,34,.12);color:#e3b341;font-size:11px;line-height:1.4;">版本：${esc(String(version))}</span>`);
    }

    if (quota && (quota.primary || quota.secondary)) {
      const parts = [];
      const primary = quota.primary;
      const secondary = quota.secondary;
      if (primary) parts.push(`5h ${this._quotaPart(primary)}`);
      if (secondary) parts.push(`7d ${this._quotaPart(secondary)}`);
      if (parts.length) chips.push(`<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;background:rgba(240,136,62,.12);color:#ffa657;font-size:11px;line-height:1.4;">限额：${parts.join(' · ')}</span>`);
    }

    if (!chips.length) return '';

    return `
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
        ${chips.join('')}
      </div>
    `;
  },

  _quotaPart(part) {
    if (!part) return '—';
    const used = part.used_percent != null ? `${Number(part.used_percent).toFixed(1)}%` : '—';
    const reset = part.resets_at ? `重置 ${this._formatReset(part.resets_at)}` : '';
    return `${used}${reset ? `，${reset}` : ''}`;
  },

  _formatReset(value) {
    const ts = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(ts)) return '—';
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  },

  _renderRhythmSummary(buckets, days, totalEvents) {
    if (!buckets.length) return '';
    const values = buckets.map(b => Number(b.events || 0));
    const max = Math.max(...values, 0);
    const avg = days > 0 ? (totalEvents / days) : 0;
    const peakIndex = values.indexOf(max);
    const peakBucket = buckets[peakIndex] || {};
    const peakDate = peakBucket.timestamp ? new Date(peakBucket.timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '—';

    return `
      <div class="output-summary-grid" style="margin-bottom:12px;">
        <div class="output-stat"><span class="output-stat-num">${avg.toFixed(1)}</span><span class="output-stat-label">日均活动</span></div>
        <div class="output-stat"><span class="output-stat-num">${max}</span><span class="output-stat-label">峰值日</span></div>
        <div class="output-stat"><span class="output-stat-num">${peakDate}</span><span class="output-stat-label">最高活跃</span></div>
      </div>
    `;
  },

  // Reusable SVG line chart
  _svgLine(values, color, height = 40, fill = false) {
    if (!values.length) return '';
    const w = 280, h = height;
    const max = Math.max(...values, 1);
    const points = values.map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * w;
      const y = h - (v / max) * (h - 4) - 2;
      return `${x},${y}`;
    });

    const fillPath = fill
      ? `<path d="M0,${h} L${points.join(' L')} L${w},${h} Z" fill="${color}" opacity="0.15"/>`
      : '';

    return `
      <svg class="output-line-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        ${fillPath}
        <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  },

  // Mini sparkline for agent cards (7-day, inline SVG)
  renderMiniSparkline(values) {
    if (!values || values.length === 0 || values.every(v => v === 0)) return '';
    const w = 60, h = 16;
    const max = Math.max(...values, 1);
    const points = values.map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * w;
      const y = h - (v / max) * (h - 2) - 1;
      return `${x},${y}`;
    });

    return `<svg class="card-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${points.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
};
