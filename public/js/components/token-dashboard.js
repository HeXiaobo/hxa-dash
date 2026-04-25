// Token Consumption Attribution Dashboard (#93)
// Kept as a secondary technical analysis surface; labels are softened for non-code teams.
const TokenDashboard = {
  _data: null,
  _days: 7,
  _COLORS: ['#58a6ff', '#3fb950', '#bc8cff', '#f0883e', '#79c0ff', '#56d364', '#d2a8ff', '#f85149'],

  init() {
    document.querySelectorAll('[data-token-period]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._days = parseInt(btn.dataset.tokenPeriod);
        document.querySelectorAll('[data-token-period]').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        this.fetch();
      });
    });

    window.addEventListener('resize', () => {
      if (this._data) this._render();
    });
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
    const observed = this._hasObserved();
    const badge = document.querySelector('.token-estimate-badge');
    if (badge) {
      badge.textContent = observed ? '🧮 本机观测' : '📊 活动估算';
      badge.title = observed
        ? '来自各 agent 本机 subscription runtime usage 快照，非账单口径'
        : '基于 GitLab 活动事件估算，每类操作按典型 Claude API 用量换算 token 数';
    }

    const chartSection = document.getElementById('token-chart')?.closest('.section');
    const chartTitle = chartSection?.querySelector('.section-header h2');
    const chartSub = chartSection?.querySelector('.trends-sublabel');
    const chartLegend = chartSection?.querySelector('.token-chart-legend');
    if (chartTitle) chartTitle.textContent = observed ? '观测快照' : '消耗趋势';
    if (chartSub) chartSub.textContent = observed
      ? '各 agent 本机会话 Token（输入 + 输出 + 缓存 + 推理）'
      : '每日 Token 用量（输入 + 输出）';
    if (chartLegend) chartLegend.innerHTML = observed ? `
      <span class="trends-legend-item"><span class="trends-legend-dot" style="background:#58a6ff"></span>输入</span>
      <span class="trends-legend-item"><span class="trends-legend-dot" style="background:#79c0ff"></span>缓存</span>
      <span class="trends-legend-item"><span class="trends-legend-dot" style="background:#bc8cff"></span>输出</span>
      <span class="trends-legend-item"><span class="trends-legend-dot" style="background:#f0883e"></span>推理</span>
    ` : `
      <span class="trends-legend-item"><span class="trends-legend-dot" style="background:#58a6ff"></span>输入</span>
      <span class="trends-legend-item"><span class="trends-legend-dot" style="background:#bc8cff"></span>输出</span>
    `;

    const pieTitle = document.getElementById('token-cost-pie')?.closest('.section')?.querySelector('.section-header h2');
    if (pieTitle) pieTitle.textContent = observed ? '观测分布' : '费用分布';

    const tableTitle = document.getElementById('token-agent-table')?.closest('.section')?.querySelector('.section-header h2');
    if (tableTitle) tableTitle.textContent = observed ? 'Agent 观测排行' : 'Agent 消耗排行';
  },

  async fetch() {
    const container = document.getElementById('token-chart');
    if (container) container.innerHTML = '<div class="trends-loading">加载中…</div>';

    try {
      const res = await window.fetch(`${BASE}/api/tokens?days=${this._days}`);
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
          本地观测来自各 agent 的 subscription runtime 快照，适合看会话归因，不代表真实账单。
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
          <div class="token-stat-label">缓存 token</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-value">${this._fmt(observedReasoning)}</div>
          <div class="token-stat-label">推理 token</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-value">${this._fmt(Number(observedSummary.total_output || 0))}</div>
          <div class="token-stat-label">输出 token</div>
        </div>
      `;
      return;
    }

    const totalInput = Number(s.total_input || 0);
    const totalOutput = Number(s.total_output || 0);
    const totalTokens = Number(s.total_tokens || 0);
    const totalCost = Number(s.total_cost_usd || 0);
    const avgDailyTokens = Number(s.avg_daily_tokens || 0);
    const avgDailyCost = Number(s.avg_daily_cost_usd || 0);

    el.innerHTML = `
      <div style="grid-column:1 / -1;padding:4px 2px 10px;color:var(--text-secondary);font-size:12px;line-height:1.5;">
        基于活动事件换算的技术估算，仅用于看趋势和容量，不代表真实账单。
      </div>
      <div class="token-stat">
        <div class="token-stat-value">${this._fmt(totalTokens)}</div>
        <div class="token-stat-label">活动估算总量</div>
      </div>
      <div class="token-stat">
        <div class="token-stat-value">$${totalCost.toFixed(2)}</div>
        <div class="token-stat-label">活动估算费用</div>
      </div>
      <div class="token-stat">
        <div class="token-stat-value">${this._fmt(avgDailyTokens)}</div>
        <div class="token-stat-label">估算日均量</div>
      </div>
      <div class="token-stat">
        <div class="token-stat-value">$${avgDailyCost.toFixed(2)}</div>
        <div class="token-stat-label">估算日均费用</div>
      </div>
      <div class="token-stat">
        <div class="token-stat-value">${this._fmt(totalInput)}</div>
        <div class="token-stat-label">输入估算</div>
      </div>
      <div class="token-stat">
        <div class="token-stat-value">${this._fmt(totalOutput)}</div>
        <div class="token-stat-label">输出估算</div>
      </div>
    `;
  },

  _renderChart() {
    const container = document.getElementById('token-chart');
    if (!container) return;
    if (this._hasObserved()) {
      this._renderObservedChart(container);
      return;
    }

    const daily = this._data.daily || [];
    const W = Math.max(container.clientWidth || 600, 300);
    const H = 200;

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

    const pad = { top: 16, right: 16, bottom: 32, left: 50 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;
    const n = daily.length;
    if (n === 0) return;

    const maxVal = Math.max(1, ...daily.map(d => Number(d.input || 0) + Number(d.output || 0)));
    const xPos = i => pad.left + (n > 1 ? (i / (n - 1)) * cW : cW / 2);
    const yPos = v => pad.top + cH - (v / maxVal) * cH;

    // Grid
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
    const val = (i / 4) * maxVal;
    ctx.fillText(val >= 1e6 ? (val / 1e6).toFixed(1) + 'M' : (val / 1e3).toFixed(0) + 'K', pad.left - 4, y + 3.5);
    }

    // X-axis labels
    const step = n <= 7 ? 1 : n <= 14 ? 2 : 5;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8b949e';
    for (let i = 0; i < n; i++) {
      if (i % step !== 0 && i !== n - 1) continue;
      ctx.fillText(daily[i].date.slice(5), xPos(i), H - 6);
    }

    // Stacked area: output on top of input
    // Input area (bottom)
    ctx.beginPath();
    ctx.moveTo(xPos(0), yPos(0));
    for (let i = 0; i < n; i++) ctx.lineTo(xPos(i), yPos(daily[i].input));
    ctx.lineTo(xPos(n - 1), pad.top + cH);
    ctx.lineTo(xPos(0), pad.top + cH);
    ctx.closePath();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#58a6ff';
    ctx.fill();
    ctx.globalAlpha = 1;

    // Output area (stacked on top)
    ctx.beginPath();
    ctx.moveTo(xPos(0), yPos(daily[0].input));
    for (let i = 0; i < n; i++) ctx.lineTo(xPos(i), yPos(daily[i].input + daily[i].output));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(xPos(i), yPos(daily[i].input));
    ctx.closePath();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#bc8cff';
    ctx.fill();
    ctx.globalAlpha = 1;

    // Input line
    ctx.beginPath();
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      if (i === 0) ctx.moveTo(xPos(i), yPos(daily[i].input));
      else ctx.lineTo(xPos(i), yPos(daily[i].input));
    }
    ctx.stroke();

    // Total line (input + output)
    ctx.beginPath();
    ctx.strokeStyle = '#bc8cff';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      const total = Number(daily[i].input || 0) + Number(daily[i].output || 0);
      if (i === 0) ctx.moveTo(xPos(i), yPos(total));
      else ctx.lineTo(xPos(i), yPos(total));
    }
    ctx.stroke();
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

    const agents = this._data.agents || [];
    if (!agents.length) {
      el.innerHTML = '<div class="trends-empty">暂无数据</div>';
      return;
    }

    const maxTotal = Math.max(...agents.map(a => Number(a.total || 0)), 1);
    const fmt = (n) => {
      if (n == null || Number.isNaN(Number(n))) return '0';
      n = Number(n);
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return String(n);
    };
    const totalTokens = Number((this._data.summary && this._data.summary.total_tokens) || 0);

    el.innerHTML = `
      <table class="token-table">
        <thead>
          <tr>
            <th>#</th>
            <th>成员</th>
            <th>输入估算</th>
            <th>输出估算</th>
            <th>合计</th>
            <th>估算费用</th>
            <th>倾向</th>
            <th>占比</th>
          </tr>
        </thead>
        <tbody>
          ${agents.map((a, i) => {
            const total = Number(a.total || 0);
            const input = Number(a.input || 0);
            const output = Number(a.output || 0);
            const pct = ((total / (totalTokens || 1)) * 100).toFixed(1);
            const barW = (total / maxTotal * 100).toFixed(1);
            const ratio = total > 0 ? output / total : 0;
            const tendency = ratio >= 0.55 ? '生成型' : ratio <= 0.35 ? '读取型' : '均衡型';
            return `<tr>
              <td class="token-rank">${i + 1}</td>
              <td class="token-agent-name">
                <span class="token-agent-dot" style="background:${this._COLORS[i % this._COLORS.length]}"></span>
                <span>${esc(a.name)}</span>
              </td>
              <td>${fmt(input)}</td>
              <td>${fmt(output)}</td>
              <td><strong>${fmt(total)}</strong></td>
              <td>$${Number(a.cost_usd || 0).toFixed(2)}</td>
              <td><span style="display:inline-flex;padding:2px 8px;border-radius:999px;background:rgba(88,166,255,.12);color:#79c0ff;font-size:11px;">${tendency}</span></td>
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
            const input = Number(a.input || 0);
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

    const observedMode = this._hasObserved();
    const agents = observedMode ? (this._data.observed?.agents || []) : (this._data.agents || []);
    if (!agents.length) {
      container.innerHTML = '<div class="trends-empty">暂无数据</div>';
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
    const totalValue = observedMode
      ? Number(this._data.observed?.summary?.total_tokens || 0)
      : Number((this._data.summary && this._data.summary.total_cost_usd) || 0);
    const safeTotalValue = totalValue || 1;

    let startAngle = -Math.PI / 2;

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const value = observedMode ? Number(a.total || 0) : Number(a.cost_usd || 0);
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
    ctx.fillText(observedMode ? this._fmt(totalValue) : `$${totalValue.toFixed(0)}`, cx, cy - 6);
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText(observedMode ? '观测 token' : `${this._days}天估算`, cx, cy + 10);
  }
};
