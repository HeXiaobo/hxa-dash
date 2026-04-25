import { describe, it, expect } from 'vitest';

const teamRoute = require('../src/routes/team');
const { runtimeEvidenceLevel, buildRuntimeSummary, selectQuotaForRuntime } = teamRoute.__private;

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

  it('keeps unconfirmed strong offline evidence degraded for fresh heartbeats', () => {
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

  it('treats confirmed runtime evidence as running even when an older status was degraded', () => {
    const now = Date.now();
    const health = {
      reported_at: now,
      runtime: {
        type: 'claude_code',
        status: 'degraded',
        version: '2.1.109',
        source: 'claude version',
        detection_source: 'process',
      },
      disk: { status: 'ok' },
      memory: { status: 'ok' },
      quota: {
        claude_code: { supported: true, primary: { used_percent: 3 } },
      },
    };

    const summary = buildRuntimeSummary({ online: true }, health, now);
    expect(summary.status).toBe('running');
  });

  it('does not expose quota as supported without used quota windows', () => {
    const health = {
      quota: {
        codex: {
          supported: true,
          source: '/Users/example/.codex/sessions/latest.jsonl',
          sampled_at: new Date().toISOString(),
          primary: null,
          secondary: null,
        },
      },
    };

    const quota = selectQuotaForRuntime(health, 'codex');
    expect(quota.supported).toBe(false);
    expect(quota.reason).toBe('no_used_quota_window');
  });
});
