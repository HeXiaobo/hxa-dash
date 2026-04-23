const { Router } = require('express');
const { buildAgents } = require('./team');

const router = Router();

// GET /api/live — real-time agent work dashboard (#95)
router.get('/', (req, res) => {
  const agents = buildAgents();
  const now = Date.now();

  const liveAgents = agents.map(a => {
    const name = a.name || a.id;
    const openTasks = a.current_tasks || [];
    const recentSignal = a.recent_work_signal || a.latest_event || null;
    const recentEvents = [recentSignal].filter(Boolean);
    const lastActiveMs = a.last_active_at ? (now - a.last_active_at) : null;
    const activityIntensity = a.events_7d || 0;

    return {
      name,
      displayName: a.display_name || name,
      role: a.role || '',
      online: !!a.online,
      workStatus: a.work_state || 'offline',
      effectiveStatus: a.work_state || 'offline',
      runtimeStatus: a.runtime_status || 'offline',
      runtime: a.runtime || null,
      healthScore: a.health_score ?? null,
      currentTasks: openTasks.slice(0, 5).map(t => ({
        title: t.title,
        type: t.type || 'issue',
        url: t.url || '',
        project: t.project || ''
      })),
      recentEvents: recentEvents.slice(0, 8).map(e => ({
        action: e.action,
        targetTitle: e.target_title,
        targetType: e.target_type,
        project: e.project,
        timestamp: e.timestamp
      })),
      lastActiveMs,
      activityIntensity,
      activeProjects: a.active_projects || [],
      quota: a.quota || null,
    };
  });

  // Sort: working > standby > offline
  const statusOrder = { working: 0, standby: 1, offline: 2 };
  liveAgents.sort((a, b) => (statusOrder[a.effectiveStatus] ?? 9) - (statusOrder[b.effectiveStatus] ?? 9));

  const summary = {
    total: liveAgents.length,
    working: liveAgents.filter(a => a.effectiveStatus === 'working').length,
    standby: liveAgents.filter(a => a.effectiveStatus === 'standby').length,
    offline: liveAgents.filter(a => a.effectiveStatus === 'offline').length,
    runtime: {
      running: liveAgents.filter(a => a.runtimeStatus === 'running').length,
      degraded: liveAgents.filter(a => a.runtimeStatus === 'degraded').length,
      offline: liveAgents.filter(a => a.runtimeStatus === 'offline').length,
    },
  };

  res.json({ agents: liveAgents, summary, timestamp: now });
});

module.exports = router;
