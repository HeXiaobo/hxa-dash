// Health Watchdog tests (#129)
import { describe, it, expect } from 'vitest';

// Use require() to match what health-watchdog.js uses internally — ensures same db instance
const db = require('../src/db');
const watchdog = require('../src/health-watchdog');

describe('Health Watchdog — getAlerts (#129)', () => {
  it('returns no alerts when all agents are healthy and active', () => {
    const now = Date.now();
    db.upsertAgent({ name: 'healthy-bot', online: true, last_seen_at: now });
    db.upsertAgentHealth('healthy-bot', {
      disk: { pct: 50, status: 'ok' },
      memory: { pct: 40, status: 'ok' },
      pm2: { online: 3, total: 3, services: [] },
    });
    // Add a recent event
    db.insertEvent({
      timestamp: now - 60000, // 1 min ago
      agent: 'healthy-bot',
      action: 'pushed to',
      target_title: 'feat/something',
      target_type: 'push',
    });

    const result = watchdog.getAlerts();
    const botAlerts = result.alerts.filter(a => a.name === 'healthy-bot');
    expect(botAlerts.length).toBe(0);
  });

  it('detects offline agent with open tasks', () => {
    db.upsertAgent({ name: 'offline-bot', online: false, last_seen_at: Date.now() - 60 * 60 * 1000 });
    db.upsertTask({
      id: 'issue-9-999',
      type: 'issue',
      state: 'opened',
      assignee: 'offline-bot',
      title: 'Test issue',
      updated_at: Date.now(),
    });

    const result = watchdog.getAlerts();
    const botAlerts = result.alerts.filter(a => a.name === 'offline-bot');
    expect(botAlerts.length).toBe(1);
    expect(botAlerts[0].issues).toContain('offline_with_tasks');
  });

  it('detects output stall for online agent', () => {
    const now = Date.now();
    db.upsertAgent({ name: 'stall-bot', online: true, last_seen_at: now - 45 * 60 * 1000 });
    // Old event (40 min ago)
    db.insertEvent({
      timestamp: now - 40 * 60 * 1000,
      agent: 'stall-bot',
      action: 'pushed to',
      target_title: 'some-branch',
      target_type: 'push',
    });
    db.upsertAgentHealth('stall-bot', {
      disk: { pct: 50, status: 'ok' },
      memory: { pct: 40, status: 'ok' },
    });

    const result = watchdog.getAlerts();
    const botAlerts = result.alerts.filter(a => a.name === 'stall-bot');
    expect(botAlerts.length).toBe(1);
    expect(botAlerts[0].output_stall).toBe(true);
    expect(botAlerts[0].issues).toContain('output_stall');
  });

  it('detects system critical health', () => {
    const now = Date.now();
    db.upsertAgent({ name: 'crit-bot', online: true, last_seen_at: now });
    db.upsertAgentHealth('crit-bot', {
      disk: { pct: 95, status: 'critical' },
      memory: { pct: 40, status: 'ok' },
    });
    db.insertEvent({
      timestamp: now - 60000,
      agent: 'crit-bot',
      action: 'pushed to',
      target_title: 'feat/something',
      target_type: 'push',
    });

    const result = watchdog.getAlerts();
    const botAlerts = result.alerts.filter(a => a.name === 'crit-bot');
    expect(botAlerts.length).toBe(1);
    expect(botAlerts[0].system_critical).toBe(true);
    expect(botAlerts[0].issues).toContain('system_critical');
  });

  it('detects missing health report for online agent', () => {
    db.upsertAgent({ name: 'no-health-bot', online: true, last_seen_at: Date.now() });
    // No health report upserted
    db.insertEvent({
      timestamp: Date.now() - 60000,
      agent: 'no-health-bot',
      action: 'pushed to',
      target_title: 'feat/something',
      target_type: 'push',
    });

    const result = watchdog.getAlerts();
    const botAlerts = result.alerts.filter(a => a.name === 'no-health-bot');
    expect(botAlerts.length).toBe(1);
    expect(botAlerts[0].issues).toContain('no_health_report');
  });
});

describe('Health Watchdog — lastActive derivation bug fix (issue #25 P2 item 5)', () => {
  // Bug: `lastEvent?.timestamp || agent.last_seen_at` treats a falsy-but-
  // present timestamp (e.g. `0`, epoch) the same as "no event at all" and
  // silently substitutes last_seen_at — a heartbeat, not git activity, which
  // is what the output-stall check exists to measure. A real stall (event
  // recorded at time 0) would be masked by a recent heartbeat.
  it('an event with timestamp 0 is NOT treated as "no event" — it still drives the stall check', () => {
    const now = Date.now();
    db.upsertAgent({ name: 'zero-ts-bot', online: true, last_seen_at: now }); // recent heartbeat
    db.insertEvent({
      timestamp: 0, // falsy but a real, very old timestamp
      agent: 'zero-ts-bot',
      action: 'pushed to',
      target_title: 'ancient-branch',
      target_type: 'push',
    });
    db.upsertAgentHealth('zero-ts-bot', {
      disk: { pct: 50, status: 'ok' },
      memory: { pct: 40, status: 'ok' },
    });

    const result = watchdog.getAlerts();
    const alert = result.alerts.find(a => a.name === 'zero-ts-bot');
    // Old (buggy) behaviour would fall back to last_seen_at (= now), so
    // last_active would read ~now and output_stall would be false — masking
    // a genuinely 0-timestamp last event. Fixed behaviour uses the event's
    // own timestamp (0) since it IS present, so the stall fires.
    expect(alert, 'expected an alert — the fallback bug would otherwise mask this').toBeDefined();
    expect(alert.last_active).toBe(0);
    expect(alert.output_stall).toBe(true);
  });

  it('an agent with NO event at all still falls back to last_seen_at (unchanged, intentionally preserved fallback)', () => {
    const now = Date.now();
    // Online recently, zero events ever recorded — should NOT be flagged as
    // stalled purely from having no git history yet (grace period).
    db.upsertAgent({ name: 'no-events-bot', online: true, last_seen_at: now });
    db.upsertAgentHealth('no-events-bot', {
      disk: { pct: 50, status: 'ok' },
      memory: { pct: 40, status: 'ok' },
    });

    const result = watchdog.getAlerts();
    const alert = result.alerts.find(a => a.name === 'no-events-bot');
    // No alert-worthy issue at all in this case (recent last_seen_at, no
    // stale health since it was just reported, no open tasks).
    expect(alert).toBeUndefined();
  });
});
