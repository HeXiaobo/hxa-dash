import { describe, it, expect } from 'vitest';

const teamRoute = require('../src/routes/team');
const { runtimeEvidenceLevel, buildRuntimeSummary } = teamRoute.__private;

describe('team runtime evidence', () => {
  it('treats process/config/env detections as strong evidence', () => {
    const health = {
      runtime: {
        type: 'codex',
        status: 'offline',
        source: 'codex version',
        detection_source: 'process',
      },
      reported_at: Date.now(),
    };

    expect(runtimeEvidenceLevel(health, 'codex')).toBe('strong');
  });

  it('treats profile-only detection as weak evidence', () => {
    const health = {
      runtime: {
        type: 'claude_code',
        status: 'offline',
        source: 'claude version',
        detection_source: 'profile',
      },
      reported_at: Date.now(),
    };

    expect(runtimeEvidenceLevel(health, 'claude_code')).toBe('weak');
  });

  it('keeps weak offline evidence as offline instead of degraded', () => {
    const now = Date.now();
    const health = {
      reported_at: now,
      runtime: {
        type: 'claude_code',
        status: 'offline',
        source: 'claude version',
        detection_source: 'profile',
      },
      disk: { status: 'ok' },
      memory: { status: 'ok' },
    };

    const summary = buildRuntimeSummary({ online: true }, health, now);
    expect(summary.status).toBe('offline');
  });

  it('upgrades strong offline evidence to degraded for fresh heartbeats', () => {
    const now = Date.now();
    const health = {
      reported_at: now,
      runtime: {
        type: 'codex',
        status: 'offline',
        source: 'codex version',
        detection_source: 'process',
      },
      disk: { status: 'ok' },
      memory: { status: 'ok' },
    };

    const summary = buildRuntimeSummary({ online: true }, health, now);
    expect(summary.status).toBe('degraded');
  });
});
