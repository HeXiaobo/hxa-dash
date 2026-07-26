import { describe, expect, it } from 'vitest';

const agentHealthRoute = require('../src/routes/agent-health');
const {
  sanitizeBackup,
  sanitizeRoster,
  sanitizeRuntime,
  resourceStatus,
  overallHealthStatus,
  STALE_THRESHOLD_MS,
} = agentHealthRoute.__private;

describe('agent health allowlists', () => {
  it('reconstructs roster telemetry and drops arbitrary or secret fields', () => {
    const roster = sanitizeRoster({
      session_id: '<b>session-a</b>',
      model: 'claude-opus-4',
      model_display: 'Claude Opus',
      version: '0.4.2',
      runtime_type: 'claude_code',
      cost_usd: 1.234,
      lines_added: 12,
      lines_removed: 3,
      context_used_pct: 61.23,
      context_total_tokens: 122000,
      rate_limits: {
        five_hour: { used_pct: 34, resets_at: 1_785_003_600 },
        seven_day: { used_percentage: 71, resets_at: '2026-07-31T00:00:00Z' },
        hidden_window: { api_key: 'secret' },
      },
      plan_type: 'max',
      sampled_at: '2026-07-26T00:00:00Z',
      api_key: 'top-secret',
      nested: { access_token: 'also-secret' },
      tags: ['not', 'allowed'],
    });

    expect(roster).toEqual({
      model: 'claude-opus-4',
      model_display: 'Claude Opus',
      version: '0.4.2',
      runtime_type: 'claude_code',
      cost_usd: 1.2,
      lines_added: 12,
      lines_removed: 3,
      context_used_pct: 61.2,
      context_total_tokens: 122000,
      rate_limits: {
        five_hour: { used_pct: 34, resets_at: 1_785_003_600_000 },
        seven_day: { used_pct: 71, resets_at: Date.parse('2026-07-31T00:00:00Z') },
      },
      plan_type: 'max',
      sampled_at: Date.parse('2026-07-26T00:00:00Z'),
    });
    expect(JSON.stringify(roster)).not.toContain('secret');
    expect(roster).not.toHaveProperty('session_id');
    expect(roster).not.toHaveProperty('tags');
    expect(roster.rate_limits).not.toHaveProperty('hidden_window');
  });

  it('removes credentials and token query parameters from backup remotes', () => {
    const backup = sanitizeBackup({
      repos: [{
        remote: 'https://user:password@github.com/org/repo.git?private_token=secret&api_key=also-secret&pat=third-secret',
        status: 'ok',
      }],
    });

    expect(backup.repos[0].remote).toBe('https://github.com/org/repo.git');
    expect(backup.repos[0].remote).not.toContain('secret');
  });

  it('does not manufacture runtime timestamps or running status', () => {
    expect(sanitizeRuntime({
      type: 'codex',
      version: '0.42.0',
      status: 'not-a-status',
    })).toMatchObject({
      type: 'codex',
      version: '0.42.0',
      installed: true,
      status: 'unknown',
      status_source: 'unknown',
      checked_at: null,
    });
    expect(STALE_THRESHOLD_MS).toBe(15 * 60 * 1000);
  });

  it('uses inclusive warning and critical resource thresholds', () => {
    expect(resourceStatus(79.9)).toBe('ok');
    expect(resourceStatus(80)).toBe('warning');
    expect(resourceStatus(89.9)).toBe('warning');
    expect(resourceStatus(90)).toBe('critical');
  });

  it('keeps missing resources unknown and includes CPU in overall health', () => {
    expect(overallHealthStatus({
      disk: { status: 'unknown' },
      memory: { status: 'unknown' },
    }, true, false)).toBe('unknown');
    expect(overallHealthStatus({
      disk: { status: 'ok' },
      memory: { status: 'ok' },
      cpu: { pct: 80, status: 'warning' },
    }, true, false)).toBe('warning');
    expect(overallHealthStatus({
      disk: { status: 'ok' },
      memory: { status: 'ok' },
      cpu: { pct: 90, status: 'critical' },
    }, true, false)).toBe('critical');
  });

  it('only converts plausible epoch-second timestamps to milliseconds', () => {
    expect(sanitizeRuntime({ type: 'codex', checked_at: 2000 }).checked_at).toBe(2000);
    expect(sanitizeRuntime({
      type: 'codex',
      checked_at: 1_785_003_600,
    }).checked_at).toBe(1_785_003_600_000);
  });
});
