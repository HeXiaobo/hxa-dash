// issue #25 P2 §2/§4 — `__verify__` prefix exclusion from the liveness JUDGMENT
// layer (not just rendering), plus the permanent verification canary.
//
// SCOPE NOTE (deliberate, not an oversight): this file covers the POSITIVE
// examples only — a record whose name carries the `__verify__` prefix must
// not be counted by any of the three aggregation sites. Per the issue #25 P2
// task split, the NEGATIVE example ("an unprefixed real agent must still
// appear" — the most dangerous failure mode is over-exclusion, which silently
// drops a real agent out of liveness stats while looking like "no alert") is
// Veda's to write, specifically because the author of the exclusion logic
// should not be the one certifying it doesn't over-exclude.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const db = require('../src/db');
const watchdog = require('../src/health-watchdog');
const autoAssign = require('../src/auto-assign-engine');
const { computeOfflineAgents, computeIdleAgents } = autoAssign.__private;

describe('issue #25 P2 — canary/`__verify__` exclusion is enforced in the judgment layer', () => {
  // -------------------------------------------------------------------------
  // Site 1/3 & 2/3 — src/auto-assign-engine.js (offline reassignment pools)
  // -------------------------------------------------------------------------
  it('auto-assign-engine: a canary-prefixed offline agent is excluded from the offline pool', () => {
    const now = Date.now();
    db.upsertAgent({ name: '__verify__offline-canary', online: false, last_seen_at: now - 60 * 60 * 1000 });
    db.upsertAgent({ name: 'real-offline-agent-A', online: false, last_seen_at: now - 60 * 60 * 1000 });

    const offline = computeOfflineAgents(db.getAllAgents(), now);
    const names = offline.map(a => a.name);
    expect(names).not.toContain('__verify__offline-canary');
    // sanity: the mechanism actually works on real records (not a no-op filter)
    expect(names).toContain('real-offline-agent-A');
  });

  it('auto-assign-engine: a canary-prefixed idle agent is excluded from the reassignment TARGET pool', () => {
    // This is the dangerous direction: if the canary leaked into idleAgents it
    // could be picked as `targetAgent`, silently routing a real issue's
    // reassignment to a name nothing real is running.
    const now = Date.now();
    db.upsertAgent({ name: '__verify__idle-canary', online: true, last_seen_at: now });
    db.upsertAgent({ name: 'real-idle-agent-A', online: true, last_seen_at: now });

    const idle = computeIdleAgents(db.getAllAgents(), now);
    const names = idle.map(a => a.name);
    expect(names).not.toContain('__verify__idle-canary');
    expect(names).toContain('real-idle-agent-A');
  });

  // -------------------------------------------------------------------------
  // Site 3/3(a) — src/health-watchdog.js getAlerts() (API-facing aggregate)
  // -------------------------------------------------------------------------
  it('health-watchdog getAlerts(): a canary-prefixed agent produces zero alert entries even when every alert condition is met', () => {
    const now = Date.now();
    // Meets: offline-with-tasks AND would meet output-stall/no-health if online.
    db.upsertAgent({ name: '__verify__watchdog-canary', online: false, last_seen_at: now - 2 * 60 * 60 * 1000 });
    db.upsertTask({
      id: 'issue-25-9001',
      type: 'issue',
      state: 'opened',
      assignee: '__verify__watchdog-canary',
      title: 'canary-owned task (should never exist for real, but prove exclusion anyway)',
      updated_at: now,
    });

    const result = watchdog.getAlerts();
    const canaryAlerts = result.alerts.filter(a => a.name === '__verify__watchdog-canary');
    expect(canaryAlerts.length).toBe(0);
  });

  it('health-watchdog getAlerts(): a canary-prefixed agent with critical system health still produces zero alerts', () => {
    const now = Date.now();
    db.upsertAgent({ name: '__verify__crit-canary', online: true, last_seen_at: now });
    db.upsertAgentHealth('__verify__crit-canary', {
      disk: { pct: 99, status: 'critical' },
      memory: { pct: 40, status: 'ok' },
    });
    db.insertEvent({
      timestamp: now - 60000,
      agent: '__verify__crit-canary',
      action: 'pushed to',
      target_title: 'irrelevant',
      target_type: 'push',
    });

    const result = watchdog.getAlerts();
    const canaryAlerts = result.alerts.filter(a => a.name === '__verify__crit-canary');
    expect(canaryAlerts.length).toBe(0);
    // sanity: the same fixture shape DOES alert for a non-canary name (reuses
    // the existing crit-bot pattern from test/health-watchdog.test.js).
    db.upsertAgent({ name: 'real-crit-agent-A', online: true, last_seen_at: now });
    db.upsertAgentHealth('real-crit-agent-A', {
      disk: { pct: 99, status: 'critical' },
      memory: { pct: 40, status: 'ok' },
    });
    db.insertEvent({
      timestamp: now - 60000,
      agent: 'real-crit-agent-A',
      action: 'pushed to',
      target_title: 'irrelevant',
      target_type: 'push',
    });
    const result2 = watchdog.getAlerts();
    expect(result2.alerts.filter(a => a.name === 'real-crit-agent-A').length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Site 3/3(b) — src/db.js getIdleAgents() (the aggregation function itself,
  // not only the route/dashboard that later renders it)
  // -------------------------------------------------------------------------
  it('db.getIdleAgents(): a long-offline canary is excluded from the idle-agent aggregate', () => {
    const now = Date.now();
    const longAgo = now - 10 * 24 * 60 * 60 * 1000; // 10 days
    db.upsertAgent({ name: '__verify__idle-agg-canary', online: false, last_seen_at: longAgo });
    db.upsertAgent({ name: 'real-idle-agg-agent-A', online: false, last_seen_at: longAgo });

    const idle = db.getIdleAgents(now, 24 * 60 * 60 * 1000); // 1 day threshold
    const names = idle.map(a => a.name);
    expect(names).not.toContain('__verify__idle-agg-canary');
    expect(names).toContain('real-idle-agg-agent-A');
  });

  // -------------------------------------------------------------------------
  // Item 4 — permanent canary registration (pre-registered, never created-
  // then-deleted)
  // -------------------------------------------------------------------------
  it('db.ensureCanaryAgent(): registers the canary once and is idempotent (no reset on repeat calls)', () => {
    const first = db.ensureCanaryAgent();
    expect(first.name).toBe(db.CANARY_AGENT_NAME);
    expect(db.isCanaryName(first.name)).toBe(true);

    // Simulate the canary having accrued some state since registration.
    db.upsertAgent({ ...db.getAgent(db.CANARY_AGENT_NAME), online: true, last_seen_at: 12345 });
    const second = db.ensureCanaryAgent();
    // Idempotent: an existing record is left alone, not overwritten back to
    // the "just registered" defaults.
    expect(second.online).toBe(true);
    expect(second.last_seen_at).toBe(12345);
  });

  it('the permanent canary itself is excluded from every judgment-layer site', () => {
    const now = Date.now();
    db.ensureCanaryAgent();
    db.upsertAgent({ ...db.getAgent(db.CANARY_AGENT_NAME), online: false, last_seen_at: now - 999 * 60 * 60 * 1000 });

    expect(computeOfflineAgents(db.getAllAgents(), now).map(a => a.name)).not.toContain(db.CANARY_AGENT_NAME);
    expect(db.getIdleAgents(now, 60 * 60 * 1000).map(a => a.name)).not.toContain(db.CANARY_AGENT_NAME);
    expect(watchdog.getAlerts().alerts.filter(a => a.name === db.CANARY_AGENT_NAME).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Documentation ↔ code marker consistency (issue #25 P2 item 3③) — asserts
  // the marker the runbook actually tells an operator to type is the SAME
  // prefix the code excludes, so the two cannot silently drift apart again
  // (this is exactly how BLOCKER 6 / the deploy-smoke-vs-__verify__ mismatch
  // happened: criteria said one string, the checklist used another).
  // -------------------------------------------------------------------------
  it('doc↔code consistency: the runbook smoke-test marker uses the exact prefix db.js excludes', () => {
    const runbookPath = path.join(__dirname, '..', 'docs', 'auth-production-runbook.md');
    const runbook = fs.readFileSync(runbookPath, 'utf8');
    const match = runbook.match(/SMOKE_NAME="(\S+?)-\$\(date/);
    expect(match, 'runbook must define SMOKE_NAME as "<prefix>-$(date ...)"').not.toBeNull();
    const docPrefix = match[1];
    expect(docPrefix.startsWith(db.CANARY_PREFIX)).toBe(true);
    expect(db.isCanaryName(docPrefix + '-20260101000000')).toBe(true);
  });

  it('doc↔code consistency: the checklist references the same marker prefix as the runbook', () => {
    const checklistPath = path.join(__dirname, '..', 'docs', 'go-live-checklist-issue-25.md');
    const checklist = fs.readFileSync(checklistPath, 'utf8');
    expect(checklist).toContain('`' + db.CANARY_PREFIX);
  });
});
