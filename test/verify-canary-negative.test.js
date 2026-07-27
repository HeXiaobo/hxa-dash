// issue #25 P2 — NEGATIVE / boundary examples for the `__verify__` exclusion.
// Written by Veda (non-author) per the task split: the author of the exclusion
// must not be the one certifying it does not OVER-exclude.
//
// Failure mode under test is silent by construction: an over-excluded real
// agent does not raise an alert, it disappears from the population that
// alerts are computed over. So every assertion below binds to the NAME LIST,
// never to a count.
import { describe, expect, it } from 'vitest';

const db = require('../src/db');
const watchdog = require('../src/health-watchdog');
const autoAssign = require('../src/auto-assign-engine');
const { computeOfflineAgents, computeIdleAgents } = autoAssign.__private;
const { buildAgents } = require('../src/routes/team');

const OLD = Date.now() - 60 * 60 * 1000;

describe('P2 negative — prefix must be ANCHORED, not merely contained', () => {
  it('a real agent whose name CONTAINS __verify__ (not at position 0) is NOT excluded', () => {
    const now = Date.now();
    const victims = [
      'agent-__verify__-prod',      // infix
      'x__verify__',                // suffix-ish, one char before
      ' __verify__leading-space',   // leading space => not position 0
      'real-bot',                   // control
    ];
    victims.forEach(name => db.upsertAgent({ name, online: false, last_seen_at: OLD }));

    const names = computeOfflineAgents(db.getAllAgents(), now).map(a => a.name);
    victims.forEach(name => expect(names, `over-excluded: ${name}`).toContain(name));
  });

  it('isCanaryName is anchored and total (no throw on non-strings)', () => {
    expect(db.isCanaryName('__verify__x')).toBe(true);
    expect(db.isCanaryName('a__verify__x')).toBe(false);
    expect(db.isCanaryName('')).toBe(false);
    expect(db.isCanaryName(null)).toBe(false);
    expect(db.isCanaryName(undefined)).toBe(false);
    expect(db.isCanaryName(123)).toBe(false);
    expect(db.isCanaryName({ startsWith: () => true })).toBe(false); // duck-typing must not pass
  });

  it('CASE VARIANTS are NOT excluded — documents actual behaviour (fail-loud, acceptable)', () => {
    const now = Date.now();
    ['__VERIFY__c', '__Verify__c'].forEach(name =>
      db.upsertAgent({ name, online: false, last_seen_at: OLD }));
    const names = computeOfflineAgents(db.getAllAgents(), now).map(a => a.name);
    // A mis-cased canary stays visible => it would alert. Noisy, not silent. OK.
    expect(names).toContain('__VERIFY__c');
    expect(names).toContain('__Verify__c');
  });

  it('a very long unprefixed name survives; a very long PREFIXED name is excluded', () => {
    const now = Date.now();
    const longReal = 'r'.repeat(4096);
    const longCanary = '__verify__' + 'c'.repeat(4096);
    db.upsertAgent({ name: longReal, online: false, last_seen_at: OLD });
    db.upsertAgent({ name: longCanary, online: false, last_seen_at: OLD });
    const names = computeOfflineAgents(db.getAllAgents(), now).map(a => a.name);
    expect(names).toContain(longReal);
    expect(names).not.toContain(longCanary);
  });
});

describe('P2 negative — SQUATTING: the prefix is an unreserved namespace', () => {
  it('a REAL agent that claims the __verify__ prefix vanishes from EVERY judgment site', async () => {
    const now = Date.now();
    const squatter = '__verify__totally-real-bot';
    db.upsertAgent({ name: squatter, online: false, last_seen_at: OLD });
    db.upsertTask({
      id: 'issue-25-negative-1', type: 'issue', state: 'opened',
      assignee: squatter, title: 'open task on a squatting agent',
    });

    expect(computeOfflineAgents(db.getAllAgents(), now).map(a => a.name)).not.toContain(squatter);
    const alerts = await watchdog.getAlerts();
    const alertNames = JSON.stringify(alerts);
    expect(alertNames).not.toContain(squatter);
    expect(db.getIdleAgents(1).map(a => a.name)).not.toContain(squatter);
  });
});

describe('P2 gap probe — dashboard liveness AGGREGATES still include the canary', () => {
  it('buildAgents() (source array for /api/team + /api/overview stats) contains the canary', () => {
    db.ensureCanaryAgent();
    const names = buildAgents().map(a => a.name);
    // This is the probe, not a demand: if P2 means "out of every aggregate",
    // this must eventually be false. Recorded as observed behaviour.
    expect(names).toContain(db.CANARY_AGENT_NAME);
  });
});
