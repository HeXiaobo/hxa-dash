import { describe, it, expect } from 'vitest';

const teamRoute = require('../src/routes/team');
const {
  runtimeEvidenceLevel,
  buildRuntimeSummary,
  selectQuotaForRuntime,
  selectUsageForRuntime,
} = teamRoute.__private;

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

  it('keeps an explicitly observed offline runtime offline', () => {
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
    expect(summary.status).toBe('offline');
  });

  it('does not promote an installed runtime or quota sample to running', () => {
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
    expect(summary.status).toBe('degraded');
    expect(summary.installed).toBe(true);
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

  it('uses inclusive 80/90 thresholds for runtime system health', () => {
    const now = Date.now();
    const warning = buildRuntimeSummary({}, {
      reported_at: now,
      disk: { pct: 80, status: 'ok' },
      memory: { pct: 20, status: 'ok' },
      runtime: { type: 'codex', status: 'unknown' },
    }, now);
    const critical = buildRuntimeSummary({}, {
      reported_at: now,
      disk: { pct: 20, status: 'ok' },
      memory: { pct: 90, status: 'ok' },
      runtime: { type: 'codex', status: 'unknown' },
    }, now);

    expect(warning.system_health).toBe('warning');
    expect(critical.system_health).toBe('critical');
  });

  it('only converts plausible epoch-second usage timestamps to milliseconds', () => {
    const usageAtSmallClock = selectUsageForRuntime({
      usage: {
        codex: {
          supported: true,
          sampled_at: 2000,
          session_tokens: { total: 1 },
        },
      },
    }, 'codex');
    const usageAtEpochSeconds = selectUsageForRuntime({
      usage: {
        codex: {
          supported: true,
          sampled_at: 1_785_003_600,
          session_tokens: { total: 1 },
        },
      },
    }, 'codex');

    expect(usageAtSmallClock.sampled_at).toBe(2000);
    expect(usageAtEpochSeconds.sampled_at).toBe(1_785_003_600_000);
  });
});
