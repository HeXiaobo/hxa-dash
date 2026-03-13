// Action Suggestions Component (#57, #61, #62)
// Rule engine: generates next-step recommendations from team/task/event data
// Phase 2: integrates /api/metrics thresholds for utilization + output signals
const Suggestions = {
  container: null,
  autoAssignHistory: [],
  metricsData: null,

  init() {
    this.container = document.getElementById('suggestions-list');
    this._loadAutoAssignHistory();
    this._loadMetrics();
    setInterval(() => this._loadAutoAssignHistory(), 5 * 60 * 1000);
    setInterval(() => this._loadMetrics(), 5 * 60 * 1000);
  },

  _loadAutoAssignHistory() {
    fetch('/api/auto-assign/history?limit=5')
      .then(r => r.json())
      .then(data => { this.autoAssignHistory = data.events || []; })
      .catch(() => {});
  },

  _loadMetrics() {
    fetch('/api/metrics')
      .then(r => r.json())
      .then(data => { this.metricsData = data; })
      .catch(() => {});
  },

  // Generate and render suggestions
  render(agents, tasks, events) {
    if (!this.container) return;
    const suggestions = this.generate(agents, tasks, events);
    const historyItems = this._renderAutoAssignHistory();

    if (suggestions.length === 0 && historyItems === '') {
      this.container.innerHTML = '<div class="sug-empty">✅ 暂无待办建议，团队状态良好</div>';
      return;
    }

    this.container.innerHTML = suggestions.slice(0, 5).map((s, i) => `
      <div class="sug-item sug-${esc(s.priority)}">
        <span class="sug-rank">${i + 1}</span>
        <span class="sug-icon">${s.icon}</span>
        <div class="sug-body">
          <div class="sug-text">${s.html}</div>
          ${s.reason ? `<div class="sug-reason">${esc(s.reason)}</div>` : ''}
        </div>
      </div>
    `).join('') + historyItems;
  },

  _renderAutoAssignHistory() {
    if (!this.autoAssignHistory || this.autoAssignHistory.length === 0) return '';
    const items = this.autoAssignHistory.map(e => {
      const when = e.ts ? new Date(e.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      return `
        <div class="sug-item sug-info">
          <span class="sug-rank">—</span>
          <span class="sug-icon">🔄</span>
          <div class="sug-body">
            <div class="sug-text">自动重分配: Issue !${esc(String(e.issue_iid))} → <strong>${esc(e.to_agent)}</strong></div>
            <div class="sug-reason">${esc(e.from_agent)} → ${esc(e.to_agent)}${when ? ' · ' + when : ''}</div>
          </div>
        </div>
      `;
    }).join('');
    return `<div class="sug-section-header" style="padding:4px 8px;font-size:11px;color:#888;margin-top:6px;">最近自动重分配</div>${items}`;
  },

  // Rule engine: produce sorted suggestions
  generate(agents, tasks, events) {
    const now = Date.now();
    const suggestions = [];

    const allTasks = [
      ...(tasks.todo || []),
      ...(tasks.doing || []),
      ...(tasks.done || [])
    ];
    const openTasks = [...(tasks.todo || []), ...(tasks.doing || [])];

    // Rule 1: Pending review MRs (> 2h since creation)
    const openMRs = openTasks.filter(t => t.type === 'mr' && t.state === 'opened');
    const staleMRs = openMRs.filter(t => {
      const age = (now - (t.created_at || t.updated_at || now)) / (1000 * 60 * 60);
      return age > 2;
    });
    if (staleMRs.length > 0) {
      const names = [...new Set(staleMRs.map(t => t.assignee).filter(Boolean))];
      const mrLinks = staleMRs.slice(0, 3).map(t =>
        t.url ? `<a href="${esc(t.url)}" target="_blank" class="sug-link">${esc(truncate(t.title, 40))}</a>` : esc(truncate(t.title, 40))
      ).join('、');
      suggestions.push({
        priority: 'high',
        icon: '🔀',
        html: `${staleMRs.length} 个 MR 等待 review：${mrLinks}`,
        reason: names.length > 0 ? `负责人: ${names.join(', ')}` : 'Review SLA: 2h 响应',
        score: 100
      });
    }

    // Rule 2: Stale issues (> 72h no activity)
    const openIssues = openTasks.filter(t => t.type === 'issue' && t.state === 'opened');
    const staleIssues = openIssues.filter(t => {
      const lastUpdate = t.updated_at || t.created_at || now;
      return (now - lastUpdate) / (1000 * 60 * 60) > 72;
    });
    if (staleIssues.length > 0) {
      for (const issue of staleIssues.slice(0, 2)) {
        const hours = Math.round((now - (issue.updated_at || issue.created_at || now)) / (1000 * 60 * 60));
        const link = issue.url
          ? `<a href="${esc(issue.url)}" target="_blank" class="sug-link">${esc(truncate(issue.title, 40))}</a>`
          : esc(truncate(issue.title, 40));
        suggestions.push({
          priority: 'high',
          icon: '⏰',
          html: `${link} 停滞 ${hours}h，考虑重新分配`,
          reason: issue.assignee ? `当前负责: ${esc(issue.assignee)}` : '未分配',
          score: 90
        });
      }
    }

    // Rule 3: Idle agents (online, no open tasks assigned)
    const idleAgents = agents.filter(a => {
      if (!a.online) return false;
      const ws = a.work_status || 'idle';
      return ws === 'idle' && (a.stats?.open_tasks || 0) === 0;
    });
    if (idleAgents.length > 0) {
      const names = idleAgents.map(a => esc(a.name)).join('、');
      suggestions.push({
        priority: 'medium',
        icon: '💤',
        html: `${names} 空闲中，可以分配新任务`,
        reason: `${idleAgents.length} 个成员没有进行中的工作`,
        score: 70
      });
    }

    // Rule 4: Overloaded agents (> 4 open tasks)
    const overloaded = agents.filter(a => {
      const cap = a.capacity || { current: 0, max: 5 };
      return cap.current > 4;
    });
    for (const agent of overloaded) {
      const cap = agent.capacity || { current: 0, max: 5 };
      suggestions.push({
        priority: 'medium',
        icon: '🔥',
        html: `${esc(agent.name)} 负载过高 (${cap.current}/${cap.max})，不要再 assign`,
        reason: '考虑将部分任务转给空闲成员',
        score: 65
      });
    }

    // Rule 5: Unassigned open issues
    const unassigned = openIssues.filter(t => !t.assignee);
    if (unassigned.length > 0) {
      suggestions.push({
        priority: 'low',
        icon: '📋',
        html: `${unassigned.length} 个 issue 未分配`,
        reason: '及时分配避免成为卡点',
        score: 50
      });
    }

    // ── Phase 2: Metrics-threshold rules (#62) ───────────────────
    const m = this.metricsData;
    if (m && m.team) {
      const team = m.team;

      // Rule 6: High idle rate (>= 70% idle) with unassigned or backlog issues
      if (team.idle_pct >= 70 && unassigned.length > 0) {
        suggestions.push({
          priority: 'medium',
          icon: '📊',
          html: `团队 ${team.idle_pct}% 成员空闲，还有 ${unassigned.length} 个 issue 未分配`,
          reason: '利用率偏低——建议立即分配积压任务',
          score: 75
        });
      }

      // Rule 7: Throughput drop (this week closed < last week by > 30%)
      const weekly = team.weekly_closed || [];
      if (weekly.length >= 2) {
        const thisWeek = weekly[weekly.length - 1];
        const lastWeek = weekly[weekly.length - 2];
        const lastTotal = (lastWeek.issues_closed || 0) + (lastWeek.mrs_merged || 0);
        const thisTotal = (thisWeek.issues_closed || 0) + (thisWeek.mrs_merged || 0);
        if (lastTotal > 0 && thisTotal < lastTotal * 0.7) {
          const drop = Math.round((1 - thisTotal / lastTotal) * 100);
          suggestions.push({
            priority: 'high',
            icon: '📉',
            html: `本周产出较上周下降 ${drop}%（${thisTotal} vs ${lastTotal} 个任务）`,
            reason: '检查是否有阻塞项或团队负载不均',
            score: 85
          });
        }
      }

      // Rule 8: Long cycle time (median > 48h)
      if (team.cycle_time_median_hours !== null && team.cycle_time_median_hours > 48) {
        const days = (team.cycle_time_median_hours / 24).toFixed(1);
        suggestions.push({
          priority: 'medium',
          icon: '🐢',
          html: `issue 平均周期时间 ${days} 天（中位数），偏长`,
          reason: '考虑拆解大 issue 或清除阻塞项，目标 < 2 天',
          score: 60
        });
      }
    }
    // ─────────────────────────────────────────────────────────────

    // Sort by score desc
    suggestions.sort((a, b) => b.score - a.score);
    return suggestions;
  }
};
