// Team Capacity Overview Component (#45)
const TeamCapacity = {
  containerId: 'team-capacity',

  render(agents) {
    const container = document.getElementById(this.containerId);
    if (!container) return;

    const online = agents.filter(a => a.online);
    const totalOpen = agents.reduce((sum, a) => sum + (a.stats?.open_tasks || 0), 0);
    const totalCapacity = agents.reduce((sum, a) => sum + (a.capacity?.max || 5), 0);
    const busyAgents = online.filter(a => (a.stats?.open_tasks || 0) > 0);
    const utilPct = online.length > 0 ? Math.round((busyAgents.length / online.length) * 100) : 0;

    // Completed this week (7d)
    const completedThisWeek = agents.reduce((sum, a) => sum + (a.stats?.closed_last_7d || 0), 0);

    // Bottleneck: agent with most open tasks
    let bottleneck = null;
    let maxOpen = 0;
    for (const a of agents) {
      const open = a.stats?.open_tasks || 0;
      if (open > maxOpen) { bottleneck = a.name; maxOpen = open; }
    }

    const utilClass = utilPct > 80 ? 'util-high' : utilPct > 50 ? 'util-mid' : 'util-low';

    container.innerHTML = `
      <div class="team-capacity-grid">
        <div class="tc-stat-box">
          <div class="tc-stat-num">${totalOpen}</div>
          <div class="tc-stat-label">进行中任务</div>
        </div>
        <div class="tc-stat-box">
          <div class="tc-stat-num">${completedThisWeek}</div>
          <div class="tc-stat-label">本周完成</div>
        </div>
        <div class="tc-stat-box">
          <div class="tc-stat-num">${online.length}/${agents.length}</div>
          <div class="tc-stat-label">在线 Agent</div>
        </div>
        <div class="tc-stat-box">
          <div class="tc-stat-num ${utilPct > 80 ? 'tc-danger' : utilPct > 50 ? 'tc-warn' : ''}">${utilPct}%</div>
          <div class="tc-stat-label">团队利用率</div>
        </div>
      </div>
      <div class="tc-utilization-bar">
        <div class="tc-util-header">
          <span>总负载: ${totalOpen}/${totalCapacity}</span>
          <span>${utilPct}% 利用率</span>
        </div>
        <div class="tc-util-track">
          <div class="tc-util-fill ${utilClass}" style="width:${Math.min(100, Math.round((totalOpen / totalCapacity) * 100))}%"></div>
        </div>
      </div>
      ${bottleneck && maxOpen >= 3 ? `
        <div class="tc-bottleneck">
          <span>⚠️ 瓶颈检测: ${esc(bottleneck)} 有 ${maxOpen} 个进行中任务</span>
        </div>
      ` : ''}
    `;
  }
};
