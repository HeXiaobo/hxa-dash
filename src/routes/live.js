const { Router } = require('express');
const db = require('../db');

const router = Router();

// GET /api/live — real-time agent work dashboard (#95)
router.get('/', (req, res) => {
  const agents = db.getAllAgents();
  const now = Date.now();

  const liveAgents = agents.map(a => {
    const name = a.name || a.id;
    const allTasks = db.getTasksForAgent(name, { assigneeOnly: true });
    const openTasks = allTasks.filter(t => t.state === 'opened');
    const allEvents = db.getEventsForAgent(name, 50);

    const oneHourAgo = now - 3600000;
    const thirtyMinAgo = now - 1800000;
    const recentEvents = allEvents.filter(e => e.timestamp && e.timestamp > oneHourAgo);
    const activityIntensity = allEvents.filter(e => e.timestamp && e.timestamp > thirtyMinAgo).length;

    const lastEvent = allEvents[0] || null;
    const lastActiveMs = lastEvent?.timestamp ? (now - lastEvent.timestamp) : null;

    // Derive effective status from online + work signals
    let effectiveStatus = 'offline';
    if (a.online) {
      if (a.work_status === 'busy' || openTasks.length > 0) effectiveStatus = 'working';
      else if (activityIntensity > 0) effectiveStatus = 'active';
      else effectiveStatus = 'idle';
    }

    // 3-tier status (#136): active (GitLab 30min) / online (Connect) / offline
    const hasRecentGitLab = allEvents.some(e => e.timestamp && e.timestamp > thirtyMinAgo);
    const tierStatus = hasRecentGitLab ? 'active' : a.online ? 'online' : 'offline';

    return {
      name,
      displayName: a.display_name || name,
      role: a.role || '',
      online: !!a.online,
      workStatus: a.work_status || 'unknown',
      effectiveStatus,
      tierStatus,
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
      activeProjects: a.active_projects || []
    };
  });

  // Sort: working > active > idle > offline
  const statusOrder = { working: 0, active: 1, idle: 2, offline: 3 };
  liveAgents.sort((a, b) => (statusOrder[a.effectiveStatus] ?? 9) - (statusOrder[b.effectiveStatus] ?? 9));

  const summary = {
    total: liveAgents.length,
    working: liveAgents.filter(a => a.effectiveStatus === 'working').length,
    active: liveAgents.filter(a => a.effectiveStatus === 'active').length,
    idle: liveAgents.filter(a => a.effectiveStatus === 'idle').length,
    offline: liveAgents.filter(a => a.effectiveStatus === 'offline').length,
    tier: {
      active: liveAgents.filter(a => a.tierStatus === 'active').length,
      online: liveAgents.filter(a => a.tierStatus === 'online').length,
      offline: liveAgents.filter(a => a.tierStatus === 'offline').length,
    }
  };

  res.json({ agents: liveAgents, summary, timestamp: now });
});

module.exports = router;
