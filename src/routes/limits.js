const { Router } = require('express');
const { buildAgents } = require('./team');

const router = Router();

function nextResetAt(agents) {
  const timestamps = agents.flatMap(agent => [
    agent.quota?.primary?.resets_at || null,
    agent.quota?.secondary?.resets_at || null,
  ].filter(Boolean));
  if (timestamps.length === 0) return null;
  return Math.min(...timestamps);
}

router.get('/', (req, res) => {
  const agents = buildAgents().map(agent => ({
    name: agent.name,
    role: agent.role || '',
    work_state: agent.work_state,
    runtime_status: agent.runtime_status,
    runtime: agent.runtime,
    quota: agent.quota,
    usage: agent.usage,
    last_active_at: agent.last_active_at,
    last_heartbeat_at: agent.last_heartbeat_at,
  }));

  const supported = agents.filter(agent => agent.quota?.supported);
  const usageTracked = agents.filter(agent => agent.usage?.supported);
  const warningCount = supported.filter(agent => {
    const primary = agent.quota?.primary?.used_percent || 0;
    const secondary = agent.quota?.secondary?.used_percent || 0;
    return primary >= 80 || secondary >= 80;
  }).length;

  res.json({
    timestamp: Date.now(),
    team: {
      total: agents.length,
      tracked: supported.length,
      unsupported: agents.length - supported.length,
      usage_tracked: usageTracked.length,
      warning_count: warningCount,
      next_reset_at: nextResetAt(agents),
      runtime_distribution: agents.reduce((acc, agent) => {
        const type = agent.runtime?.type || 'unknown';
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {}),
    },
    agents,
  });
});

module.exports = router;
