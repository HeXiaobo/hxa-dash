// Health Watchdog (#129)
// Runs every 5 minutes. Monitors agents for:
// 1. Stale health reports (no system health update >10 min)
// 2. Output stall (no git push/MR/commit activity >30 min while online)
// 3. Offline agents with open tasks
// Sends alerts to HxA Connect when thresholds exceeded.

const { execSync } = require('child_process');
const db = require('./db');

const INTERVAL_MS = 5 * 60 * 1000;           // 5 minutes
const HEALTH_STALE_MS = 10 * 60 * 1000;      // 10 min — health report considered stale
const OUTPUT_STALL_MS = 30 * 60 * 1000;      // 30 min — no git activity threshold
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;    // 30 min — don't re-alert for same agent

// Track last alert time per agent to avoid spam
const lastAlerted = new Map();

let wsModule = null;

function init(ws) {
  if (ws) wsModule = ws;
}

// Send alert to HxA-Team-K thread
function notify(message) {
  const threadTarget = 'org:coco|thread:ae51e0c1-275e-4411-9aac-c44d70262725';
  const scriptPath = '/home/cocoai/zylos/.claude/skills/comm-bridge/scripts/c4-send.js';
  try {
    execSync(`node ${scriptPath} "hxa-connect" "${threadTarget}" ${JSON.stringify(message)}`, {
      timeout: 10000,
      stdio: 'ignore',
    });
  } catch (err) {
    console.error('[HealthWatchdog] Notify error:', err.message);
  }
}

// Check if we should alert for this agent (cooldown check)
function shouldAlert(agentName, alertType) {
  const key = `${agentName}:${alertType}`;
  const last = lastAlerted.get(key);
  if (last && Date.now() - last < ALERT_COOLDOWN_MS) return false;
  lastAlerted.set(key, Date.now());
  return true;
}

function runOnce() {
  try {
    const now = Date.now();
    const agents = db.getAllAgents();
    const allHealth = db.getAllAgentHealth();
    const alerts = [];

    for (const agent of agents) {
      // Skip agents that are known offline and have no open tasks
      const tasks = db.getTasksForAgent(agent.name, { assigneeOnly: true });
      const openTasks = tasks.filter(t => t.state === 'opened');

      // 1. Check health report staleness (only for online agents)
      if (agent.online) {
        const health = allHealth[agent.name];
        if (!health) {
          if (shouldAlert(agent.name, 'no-health')) {
            alerts.push(`⚠️ **${agent.name}**: Online but no health reports received`);
          }
        } else if (now - health.reported_at > HEALTH_STALE_MS) {
          const staleMin = Math.round((now - health.reported_at) / 60000);
          if (shouldAlert(agent.name, 'stale-health')) {
            alerts.push(`⚠️ **${agent.name}**: Health report stale (${staleMin}min ago)`);
          }
        }
      }

      // 2. Check output stall (no recent git activity while online)
      if (agent.online) {
        const events = db.getEventsForAgent(agent.name, 5);
        const lastEvent = events[0] || null;
        const lastActive = lastEvent?.timestamp || agent.last_seen_at || null;

        if (lastActive && (now - lastActive) > OUTPUT_STALL_MS) {
          const stallMin = Math.round((now - lastActive) / 60000);
          if (shouldAlert(agent.name, 'output-stall')) {
            alerts.push(`🔇 **${agent.name}**: No git activity for ${stallMin}min (last: ${lastEvent?.action || 'unknown'} on ${lastEvent?.target_title?.slice(0, 40) || 'N/A'})`);
          }
        }
      }

      // 3. Check offline agents with open tasks (may indicate plan limit / crash)
      if (!agent.online && openTasks.length > 0) {
        const lastSeen = agent.last_seen_at;
        const offlineMin = lastSeen ? Math.round((now - lastSeen) / 60000) : '?';
        if (shouldAlert(agent.name, 'offline-with-tasks')) {
          alerts.push(`🔴 **${agent.name}**: Offline (${offlineMin}min) with ${openTasks.length} open task(s) — possible plan limit or crash`);
        }
      }

      // 4. Check system health critical status
      if (agent.online) {
        const health = allHealth[agent.name];
        if (health && (now - health.reported_at < HEALTH_STALE_MS)) {
          const criticals = [];
          if (health.cpu?.pct > 90) criticals.push(`cpu ${health.cpu.pct}%`);
          if (health.disk?.status === 'critical') criticals.push(`disk ${health.disk.pct}%`);
          if (health.memory?.status === 'critical') criticals.push(`memory ${health.memory.pct}%`);
          if (health.pm2 && health.pm2.online === 0) criticals.push('all PM2 services down');
          if (criticals.length > 0 && shouldAlert(agent.name, 'system-critical')) {
            alerts.push(`🚨 **${agent.name}**: System critical — ${criticals.join(', ')}`);
          }
        }
      }
    }

    if (alerts.length > 0) {
      const message = `🏥 [Health Watchdog] ${alerts.length} alert(s):\n\n${alerts.join('\n')}`;
      notify(message);
      console.log(`[HealthWatchdog] Sent ${alerts.length} alert(s)`);

      // Broadcast to dashboard clients
      if (wsModule) {
        wsModule.broadcast('health:alerts', { alerts, timestamp: now });
      }
    }
  } catch (err) {
    console.error('[HealthWatchdog] Error:', err.message);
  }
}

function start() {
  console.log('[HealthWatchdog] Started (interval: 5 min, thresholds: health=10min, stall=30min)');
  // Delay start to let initial data load
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, INTERVAL_MS);
  }, 90000); // 90s after startup
}

// Export getAlerts for API access
function getAlerts() {
  const now = Date.now();
  const agents = db.getAllAgents();
  const allHealth = db.getAllAgentHealth();
  const alerts = [];

  for (const agent of agents) {
    const tasks = db.getTasksForAgent(agent.name, { assigneeOnly: true });
    const openTasks = tasks.filter(t => t.state === 'opened');
    const health = allHealth[agent.name];
    const events = db.getEventsForAgent(agent.name, 5);
    const lastEvent = events[0] || null;
    const lastActive = lastEvent?.timestamp || agent.last_seen_at || null;

    const agentAlert = {
      name: agent.name,
      online: agent.online,
      open_tasks: openTasks.length,
      last_active: lastActive,
      health_stale: health ? (now - health.reported_at > HEALTH_STALE_MS) : true,
      output_stall: agent.online && lastActive ? (now - lastActive > OUTPUT_STALL_MS) : false,
      system_critical: false,
      issues: [],
    };

    if (!agent.online && openTasks.length > 0) {
      agentAlert.issues.push('offline_with_tasks');
    }
    if (agent.online && !health) {
      agentAlert.issues.push('no_health_report');
    }
    if (agentAlert.health_stale && agent.online) {
      agentAlert.issues.push('stale_health');
    }
    if (agentAlert.output_stall) {
      agentAlert.issues.push('output_stall');
    }
    if (health && (now - health.reported_at < HEALTH_STALE_MS)) {
      if (health.cpu?.pct > 90 || health.disk?.status === 'critical' || health.memory?.status === 'critical' ||
          (health.pm2 && health.pm2.online === 0)) {
        agentAlert.system_critical = true;
        agentAlert.issues.push('system_critical');
      }
    }

    if (agentAlert.issues.length > 0) {
      alerts.push(agentAlert);
    }
  }

  return { alerts, timestamp: now };
}

module.exports = { init, start, runOnce, getAlerts };
