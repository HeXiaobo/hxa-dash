// Token Consumption Attribution Dashboard (#93)
// Kept as a secondary technical analysis surface; labels are softened for non-code teams.
const TokenDashboard = {
  _data: null,
  _range: 'today',
  _customStart: null,
  _customEnd: null,
  _COLORS: ['#58a6ff', '#3fb950', '#bc8cff', '#f0883e', '#79c0ff', '#56d364', '#d2a8ff', '#f85149'],

  init() {
    const today = this._todayKey();
    this._customStart = today;
    this._customEnd = today;
    const startInput = document.getElementById('token-start-date');
    const endInput = document.getElementById('token-end-date');
    if (startInput) startInput.value = today;
    if (endInput) endInput.value = today;

    document.querySelectorAll('[data-token-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._range = btn.dataset.tokenRange || 'today';
        document.querySelectorAll('[data-token-range]').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        this._syncCustomRangeVisibility();
        this.fetch();
      });
    });

    [startInput, endInput].forEach(input => {
      if (!input) return;
      input.addEventListener('change', () => {
        this._customStart = startInput?.value || today;
        this._customEnd = endInput?.value || this._customStart;
        this._range = 'custom';
        document.querySelectorAll('[data-token-range]').forEach(b =>
          b.classList.toggle('active', b.dataset.tokenRange === 'custom')
        );
        this._syncCustomRangeVisibility();
        this.fetch();
      });
    });

    this._syncCustomRangeVisibility();

    window.addEventListener('resize', () => {
      if (this._data) this._render();
    });
  },

  _todayKey() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  },

  _syncCustomRangeVisibility() {
    const custom = document.getElementById('token-custom-range');
    if (custom) custom.hidden = this._range !== 'custom';
  },

  _hasObserved() {
    return Boolean(this._data?.observed?.supported && this._data.observed.agents?.length);
  },

  _fmt(n) {
    if (n == null || Number.isNaN(Number(n))) return '0';
    n = Number(n);
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  },

  _cacheTokens(agent) {
    return Number(agent.cache_creation || 0) + Number(agent.cache_read || 0) + Number(agent.cached_input || 0);
  },

  _observedSegments(agent) {
    const cachedInput = Number(agent.cached_input || 0);
    const cache = this._cacheTokens(agent);
    const reasoning = Number(agent.reasoning || 0);
    return {
      input: Math.max(0, Number(agent.input || 0) - cachedInput),
      cache,
      output: Math.max(0, Number(agent.output || 0) - reasoning),
      reasoning,
    };
  },

  _setModeLabels() {
    const badge = document.querySelector('.token-estimate-badge');
    if (badge) {
      badge.textContent = '🧮 本机观测';
      badge.title = '来自各 agent 本机 subscription runtime usage 历史快照增量，非账单口径';
    }

    const chartSection = document.getElementById('token-chart')?.closest('.section');
    const chartTitle = chartSection?.querySelector('.section-header h2');
    const chartSub = chartSection?.querySelector('.trends-sublabel');
    const chartLegend = chartSection?.querySelector('.token-chart-legend');
    if (chartTitle) chartTitle.textContent = '观测增量';
    if (chartSub) chartSub.textContent = '各 agent 本机时间段用量增量（输入 + 输出 + 缓存 + 推理）';
    if (chartLegend) chartLegend.innerHTML = `
      <span class="trends-legend-item"><span class="trends-legend-dot" style="background:#58a6ff"></span>输入</span>
      <span class="trends-legend-item"><span class="trends-legend-dot" style="background:#79c0ff"></span>缓存</span>
      <span class="trends-legend-item"><span class="trends-legend-dot" style="background:#bc8cff"></span>输出</span>
      <span class="trends-legend-item"><span class="trends-legend-dot" style="background:#f0883e"></span>推理</span>
    `;

    const pieTitle = document.getElementById('token-cost-pie')?.closest('.section')?.querySelector('.section-header h2');
    if (pieTitle) pieTitle.textContent = '观测分布';

    const tableTitle = document.getElementById('token-agent-table')?.closest('.section')?.querySelector('.section-header h2');
    if (tableTitle) tableTitle.textContent = 'Agent 观测排行';
  },

  async fetch() {
    const container = document.getElementById('token-chart');
    if (container) container.innerHTML = '<div class="trends-loading">加载中…</div>';

    try {
      const params = new URLSearchParams();
      if (this._range === 'custom') {
        params.set('start', this._customStart || this._todayKey());
        params.set('end', this._customEnd || this._customStart || this._todayKey());
      } else if (this._range === 'today') {
        params.set('days', '1');
      } else {
        params.set('days', String(parseInt(this._range, 10) || 1));
      }
      const res = await window.fetch(`${BASE}/api/tokens?${params.toString()}`);
      if (!res.ok) throw new Error('fetch failed');
      this._data = await res.json();
      this._render();
    } catch {
      if (container) container.innerHTML = '<div class="trends-empty">数据加载失败</div>';
    }
  },

  _render() {
    if (!this._data) return;
    this._setModeLabels();
    this._renderSummary();
    this._renderChart();
    this._renderAgentTable();
    this._renderCostPie();
  },

  _renderSummary() {
    const el = document.getElementById('token-summary');
    if (!el) return;
    const s = this._data.summary || {};
    const observed = this._data.observed || {};
    const observedSummary = observed.summary || {};

    if (this._hasObserved()) {
      const observedTokens = Number(observedSummary.total_tokens || 0);
      const observedCost = Number(observedSummary.total_cost_usd || 0);
      const observedCostText = observedSummary.cost_agent_count > 0 ? `$${observedCost.toFixed(2)}` : '—';
      const observedCache = Number(observedSummary.cache_tokens || 0);
      const observedReasoning = Number(observedSummary.reasoning_tokens || 0);

      el.innerHTML = `
        <div style="grid-column:1 / -1;padding:4px 2px 10px;color:var(--text-secondary);font-size:12px;line-height:1.5;">
          本地观测来自各 agent 的 subscription runtime 历史快照增量，适合看会话归因，不代表真实账单。<br>
          <span style="color:var(--orange);font-size:11px;">⚠ 首个采样点之前的用量无法反推，刚上线或缺少基线时会偏保守。</span>
        </div>
        <div class="token-stat">
          <div class="token-stat-value">${this._fmt(observedTokens)}</div>
          <div class="token-stat-label">观测总量</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-value">${observedCostText}</div>
          <div class="token-stat-label">估算费用</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-value">${observed.agent_count || 0}</div>
          <div class="token-stat-label">观测成员</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-value">${this._fmt(observedCache)}</div>
          <div class="token-stat-label">缓存</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-value">${this._fmt(observedReasoning)}</div>
          <div class="token-stat-label">推理</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-value">${this._fmt(Number(observedSummary.total_output || 0))}</div>
          <div class="token-stat-label">输出</div>
        </div>
      `;
      return;
    }

    el.innerHTML = '<div class="trends-empty" style="grid-column:1/-1">暂无观测数据</div>';
  },

  _renderChart() {
    const container = document.getElementById('token-chart');
    if (!container) return;
    if (this._hasObserved()) {
      this._renderObservedChart(container);
      return;
    }

    container.innerHTML = '<div class="trends-empty">暂无观测数据</div>';
  },

  _renderObservedChart(container) {
    const agents = (this._data.observed?.agents || []).slice(0, 12);
    if (!agents.length) {
      container.innerHTML = '<div class="trends-empty">暂无观测数据</div>';
      return;
    }

    const W = Math.max(container.clientWidth || 600, 300);
    const H = 220;
    let canvas = container.querySelector('canvas');
    if (!canvas) {
      container.innerHTML = '';
      canvas = document.createElement('canvas');
      container.appendChild(canvas);
    }
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const pad = { top: 18, right: 16, bottom: 46, left: 50 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;
    const maxVal = Math.max(1, ...agents.map(a => Number(a.total || 0)));
    const barGap = 8;
    const barW = Math.max(8, (cW - barGap * (agents.length - 1)) / agents.length);
    const colors = {
      input: '#58a6ff',
      cache: '#79c0ff',
      output: '#bc8cff',
      reasoning: '#f0883e',
    };

    ctx.lineWidth = 1;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + cH - (i / 4) * cH;
      ctx.strokeStyle = 'rgba(48,54,61,0.9)';
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + cW, y);
      ctx.stroke();
      ctx.fillStyle = '#8b949e';
      ctx.fillText(this._fmt((i / 4) * maxVal), pad.left - 4, y + 3.5);
    }

    agents.forEach((agent, i) => {
      const x = pad.left + i * (barW + barGap);
      let y = pad.top + cH;
      const segments = this._observedSegments(agent);
      ['input', 'cache', 'output', 'reasoning'].forEach(key => {
        const value = Number(segments[key] || 0);
        if (!value) return;
        const h = (value / maxVal) * cH;
        y -= h;
        ctx.fillStyle = colors[key];
        ctx.fillRect(x, y, barW, h);
      });

      ctx.fillStyle = '#8b949e';
      ctx.textAlign = 'center';
      ctx.save();
      ctx.translate(x + barW / 2, H - 8);
      ctx.rotate(-Math.PI / 8);
      ctx.fillText(String(agent.name || '').slice(0, 10), 0, 0);
      ctx.restore();
    });
  },

  _renderAgentTable() {
    const el = document.getElementById('token-agent-table');
    if (!el) return;
    if (this._hasObserved()) {
      this._renderObservedAgentTable(el);
      return;
    }

    el.innerHTML = '<div class="trends-empty">暂无观测数据</div>';
  },

  _renderObservedAgentTable(el) {
    const agents = this._data.observed?.agents || [];
    if (!agents.length) {
      el.innerHTML = '<div class="trends-empty">暂无观测数据</div>';
      return;
    }

    const maxTotal = Math.max(...agents.map(a => Number(a.total || 0)), 1);
    const totalTokens = Number(this._data.observed?.summary?.total_tokens || 0);

    el.innerHTML = `
      <table class="token-table">
        <thead>
          <tr>
            <th>#</th>
            <th>成员</th>
            <th>Runtime</th>
            <th>输入</th>
            <th>输出</th>
            <th>缓存</th>
            <th>推理</th>
            <th>合计</th>
            <th>模型/计划</th>
            <th>占比</th>
          </tr>
        </thead>
        <tbody>
          ${agents.map((a, i) => {
            const total = Number(a.total || 0);
            const input = Number(a.input || 0) + Number(a.cache_read || 0) + Number(a.cache_creation || 0);
            const output = Number(a.output || 0);
            const cache = this._cacheTokens(a);
            const reasoning = Number(a.reasoning || 0);
            const pct = ((total / (totalTokens || 1)) * 100).toFixed(1);
            const barW = (total / maxTotal * 100).toFixed(1);
            const runtimeText = a.runtime
              ? `${a.runtime.label || a.runtime.type || 'Unknown'}${a.runtime.version ? ` ${a.runtime.version}` : ''}`
              : 'Unknown';
            const modelText = [a.model, a.plan_type].filter(Boolean).join(' · ') || '—';
            return `<tr>
              <td class="token-rank">${i + 1}</td>
              <td class="token-agent-name">
                <span class="token-agent-dot" style="background:${this._COLORS[i % this._COLORS.length]}"></span>
                <span>${esc(a.name)}</span>
              </td>
              <td>${esc(runtimeText)}</td>
              <td>${this._fmt(input)}</td>
              <td>${this._fmt(output)}</td>
              <td>${this._fmt(cache)}</td>
              <td>${this._fmt(reasoning)}</td>
              <td><strong>${this._fmt(total)}</strong></td>
              <td>${esc(modelText)}</td>
              <td>
                <div class="token-bar-cell">
                  <div class="token-bar" style="width:${barW}%;background:${this._COLORS[i % this._COLORS.length]}"></div>
                  <span>${pct}%</span>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  },

  _renderCostPie() {
    const container = document.getElementById('token-cost-pie');
    if (!container) return;

    const agents = this._data.observed?.agents || [];
    if (!agents.length) {
      container.innerHTML = '<div class="trends-empty">暂无观测数据</div>';
      return;
    }

    const size = Math.min(container.clientWidth || 200, 200);
    let canvas = container.querySelector('canvas');
    if (!canvas) {
      container.innerHTML = '';
      canvas = document.createElement('canvas');
      container.appendChild(canvas);
    }
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 8;
    const innerR = r * 0.55;
    const totalValue = Number(this._data.observed?.summary?.total_tokens || 0);
    const safeTotalValue = totalValue || 1;

    let startAngle = -Math.PI / 2;

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const value = Number(a.total || 0);
      const slice = (value / safeTotalValue) * Math.PI * 2;
      const endAngle = startAngle + slice;

      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = this._COLORS[i % this._COLORS.length];
      ctx.fill();

      startAngle = endAngle;
    }

    // Center text
    ctx.fillStyle = '#e6edf3';
    ctx.font = 'bold 16px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this._fmt(totalValue), cx, cy - 6);
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText('观测总量', cx, cy + 10);
  }
};
