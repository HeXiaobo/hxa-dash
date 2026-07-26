import { describe, expect, it } from 'vitest';

const teamRoute = require('../src/routes/team');
const {
  HEALTH_STALE_MS,
  buildRuntimeSummary,
  buildMonitoringSummary,
  buildFleetMonitoringSummary,
  deriveWorkState,
} = teamRoute.__private;
const db = require('../src/db');

function fixtures(now) {
  const health = {
    reported_at: now - 42_000,
    hostname: 'agent-host',
    disk: { pct: 57, status: 'ok' },
    memory: { pct: 42, status: 'ok' },
    cpu: { pct: 18 },
    pm2: { online: 3, total: 3 },
    runtime: {
      type: 'claude_code',
      version: '1.0.90',
      installed: true,
      status: 'running',
      status_source: 'process',
      source: 'claude process',
      detection_source: 'process',
      checked_at: now - 45_000,
    },
    roster: {
      version: '0.4.2',
      context_used_pct: 61,
      context_total_tokens: 122000,
      cost_usd: 1.24,
      sampled_at: now - 60_000,
      rate_limits: {
        five_hour: { used_pct: 35, resets_at: now + 3_600_000 },
        seven_day: { used_pct: 72, resets_at: now + 7 * 86_400_000 },
      },
    },
  };
  const runtime = buildRuntimeSummary({}, health, now);
  const quota = {
    supported: true,
    sampled_at: now - 50_000,
    primary: { used_percent: 34, resets_at: now + 3_000_000 },
    secondary: null,
  };
  const usage = {
    supported: true,
    sampled_at: now - 50_000,
    session_tokens: { total: 125400 },
    last_turn_tokens: { total: 8200 },
    session_cost_usd: null,
  };
  const backup = {
    status: 'ok',
    reason: null,
    last_success_at: now - 100_000,
  };
  return { health, runtime, quota, usage, backup };
}

describe('team monitoring read model', () => {
  it('maps context, tokens, separate quota windows, versions, and backup per field', () => {
    const now = Date.parse('2026-07-26T00:00:00Z');
    const input = fixtures(now);
    const monitoring = buildMonitoringSummary(
      input.health,
      input.runtime,
      input.quota,
      input.usage,
      input.backup,
      now
    );

    expect(monitoring).toMatchObject({
      observed_at: now - 42_000,
      freshness: 'fresh',
      age_ms: 42_000,
      collection: { status: 'ok', reason_codes: [] },
      system: {
        cpu_pct: 18,
        memory_pct: 42,
        disk_pct: 57,
        pm2_online: 3,
        pm2_total: 3,
      },
      capacity: {
        context_pct: 61,
        context_tokens: 122000,
        context_sampled_at: now - 60_000,
        five_hour_pct: 34,
        five_hour_sampled_at: now - 50_000,
        seven_day_pct: 72,
        seven_day_sampled_at: now - 60_000,
      },
      tokens: {
        session_total: 125400,
        last_turn_total: 8200,
        cost_usd: 1.24,
      },
      versions: [
        { component: 'runtime', label: 'Claude Code', version: '1.0.90' },
        { component: 'statusline', label: 'Statusline', version: '0.4.2' },
      ],
      backup: { status: 'ok', last_success_at: now - 100_000 },
      anomaly: { severity: 'ok', reason_codes: [] },
    });
  });

  it('uses only fixed reason codes for fresh threshold anomalies', () => {
    const now = Date.parse('2026-07-26T00:00:00Z');
    const input = fixtures(now);
    input.health.disk = { pct: 92, status: 'critical' };
    input.health.memory = { pct: 85, status: 'warning' };
    input.health.cpu = { pct: 91, status: 'critical' };
    input.health.pm2 = { online: 1, total: 3 };
    input.health.roster.context_used_pct = 96;
    input.quota.primary.used_percent = 97;
    input.quota.secondary = { used_percent: 82 };
    input.backup = {
      status: 'critical',
      reason: 'backup_success_too_old',
      last_success_at: now - 80 * 60 * 60 * 1000,
    };

    const monitoring = buildMonitoringSummary(
      input.health,
      input.runtime,
      input.quota,
      input.usage,
      input.backup,
      now
    );

    expect(monitoring.collection).toMatchObject({
      status: 'critical',
      reason_codes: ['disk_critical', 'memory_warning', 'cpu_critical', 'pm2_partial'],
    });
    expect(monitoring.anomaly).toEqual({
      severity: 'critical',
      reason_codes: [
        'disk_critical',
        'memory_warning',
        'cpu_critical',
        'pm2_partial',
        'context_critical',
        'quota_5h_critical',
        'quota_7d_high',
        'backup_critical',
        'backup_stale',
      ],
    });
  });

  it('uses 80/90 resource and 80/95 capacity boundaries for current samples', () => {
    const now = Date.parse('2026-07-26T00:00:00Z');
    const input = fixtures(now);
    input.health.disk = { pct: 80, status: 'ok' };
    input.health.memory = { pct: 90, status: 'ok' };
    input.health.cpu = { pct: 80, status: 'ok' };
    input.health.roster.context_used_pct = 94.9;
    input.quota.primary.used_percent = 80;
    input.quota.secondary = { used_percent: 95 };

    const monitoring = buildMonitoringSummary(
      input.health,
      input.runtime,
      input.quota,
      input.usage,
      input.backup,
      now
    );

    expect(monitoring.collection).toMatchObject({
      status: 'critical',
      reason_codes: ['disk_warning', 'memory_critical', 'cpu_warning'],
    });
    expect(monitoring.anomaly.reason_codes).toEqual([
      'disk_warning',
      'memory_critical',
      'cpu_warning',
      'context_high',
      'quota_5h_high',
      'quota_7d_critical',
    ]);
  });

  it('displays stale capacity values without raising current capacity anomalies', () => {
    const now = Date.parse('2026-07-26T00:00:00Z');
    const input = fixtures(now);
    const oldSample = now - HEALTH_STALE_MS - 1;
    input.health.roster.sampled_at = oldSample;
    input.health.roster.context_used_pct = 99;
    input.health.roster.rate_limits.seven_day.used_pct = 99;
    input.quota.sampled_at = oldSample;
    input.quota.primary.used_percent = 99;
    input.quota.secondary = null;

    const monitoring = buildMonitoringSummary(
      input.health,
      input.runtime,
      input.quota,
      input.usage,
      input.backup,
      now
    );

    expect(monitoring.capacity).toMatchObject({
      context_pct: 99,
      context_sampled_at: oldSample,
      five_hour_pct: 99,
      five_hour_sampled_at: oldSample,
      seven_day_pct: 99,
      seven_day_sampled_at: oldSample,
    });
    expect(monitoring.anomaly.reason_codes).not.toContain('context_critical');
    expect(monitoring.anomaly.reason_codes).not.toContain('quota_5h_critical');
    expect(monitoring.anomaly.reason_codes).not.toContain('quota_7d_critical');
    expect(monitoring.anomaly.severity).toBe('ok');
  });

  it('does not treat high values with missing source timestamps as current anomalies', () => {
    const now = Date.parse('2026-07-26T00:00:00Z');
    const input = fixtures(now);
    input.health.roster.sampled_at = null;
    input.health.roster.context_used_pct = 99;
    input.health.roster.rate_limits.seven_day.used_pct = 99;
    input.quota.sampled_at = null;
    input.quota.primary.used_percent = 99;
    input.quota.secondary = null;

    const monitoring = buildMonitoringSummary(
      input.health,
      input.runtime,
      input.quota,
      input.usage,
      input.backup,
      now
    );

    expect(monitoring.capacity).toMatchObject({
      context_pct: 99,
      context_sampled_at: null,
      five_hour_pct: 99,
      five_hour_sampled_at: null,
      seven_day_pct: 99,
      seven_day_sampled_at: null,
    });
    expect(monitoring.anomaly.reason_codes).toEqual([]);
  });

  it('evaluates each quota window against the timestamp of its selected source', () => {
    const now = Date.parse('2026-07-26T00:00:00Z');
    const input = fixtures(now);
    const oldRosterSample = now - HEALTH_STALE_MS - 1;
    input.health.roster.sampled_at = oldRosterSample;
    input.health.roster.rate_limits.seven_day.used_pct = 95;
    input.quota.sampled_at = now - 30_000;
    input.quota.primary.used_percent = 95;
    input.quota.secondary = null;

    const monitoring = buildMonitoringSummary(
      input.health,
      input.runtime,
      input.quota,
      input.usage,
      input.backup,
      now
    );

    expect(monitoring.capacity).toMatchObject({
      five_hour_pct: 95,
      five_hour_sampled_at: now - 30_000,
      seven_day_pct: 95,
      seven_day_sampled_at: oldRosterSample,
    });
    expect(monitoring.anomaly.reason_codes).toContain('quota_5h_critical');
    expect(monitoring.anomaly.reason_codes).not.toContain('quota_7d_critical');
  });

  it('marks delayed telemetry stale without declaring runtime or work offline', () => {
    const now = Date.parse('2026-07-26T00:00:00Z');
    const input = fixtures(now);
    input.health.reported_at = now - HEALTH_STALE_MS - 1;
    const runtime = buildRuntimeSummary({}, input.health, now);
    const monitoring = buildMonitoringSummary(
      input.health,
      runtime,
      input.quota,
      input.usage,
      input.backup,
      now
    );

    expect(runtime.status).toBe('unknown');
    expect(monitoring).toMatchObject({
      freshness: 'stale',
      collection: { status: 'stale', reason_codes: ['report_stale'] },
      anomaly: { severity: 'warning' },
    });
    expect(monitoring.anomaly.reason_codes).toContain('report_stale');
    expect(deriveWorkState(null, now)).toBe('unknown');
  });

  it('does not use an open task or current_task without a work event', () => {
    const now = Date.parse('2026-07-26T00:00:00Z');
    const taskMetadataOnly = {
      openTasks: [{ title: 'assigned but untouched' }],
      current_task: 'legacy field',
      lastWorkSignalAt: null,
    };
    expect(deriveWorkState(taskMetadataOnly.lastWorkSignalAt, now)).toBe('unknown');
    expect(deriveWorkState(now - 30 * 60 * 1000, now)).toBe('working');
  });

  it('keeps legacy team fields while ignoring task metadata as work evidence', () => {
    const name = `monitoring-task-metadata-${process.pid}`;
    db.upsertAgent({
      name,
      display_name: 'Monitoring Fixture',
      online: true,
      current_task: 'legacy current task',
      tags: '[]',
    });
    db.upsertTask({
      id: `monitoring-task-${process.pid}`,
      assignee: name,
      author: 'fixture-author',
      reviewer: null,
      state: 'opened',
      title: 'assigned but untouched',
      type: 'issue',
      project: 'fixture',
      created_at: Date.now() - 60_000,
      updated_at: Date.now() - 60_000,
    });

    try {
      const row = teamRoute.buildAgents().find(agent => agent.name === name);
      expect(row).toMatchObject({
        name,
        online: true,
        work_state: 'unknown',
        runtime_status: 'unknown',
        stats: { open_tasks: 1 },
      });
      expect(row).toHaveProperty('runtime');
      expect(row).toHaveProperty('quota');
      expect(row).toHaveProperty('usage');
      expect(row).toHaveProperty('backup');
      expect(row).toHaveProperty('hardware');
      expect(row).toHaveProperty('monitoring');
    } finally {
      db.removeAgent(name);
    }
  });

  it('emits one ingest-chain warning only when every rostered agent is stale', () => {
    const staleAgent = {
      monitoring: {
        freshness: 'stale',
        anomaly: { severity: 'warning', reason_codes: ['report_stale'] },
      },
    };
    expect(buildFleetMonitoringSummary([staleAgent, staleAgent])).toMatchObject({
      total: 2,
      fresh: 0,
      stale: 2,
      missing: 0,
      needs_attention: 1,
      anomaly: {
        severity: 'warning',
        reason_codes: ['ingest_chain_suspected'],
      },
    });

    expect(buildFleetMonitoringSummary([
      staleAgent,
      { monitoring: { freshness: 'fresh', anomaly: { severity: 'ok', reason_codes: [] } } },
    ]).anomaly.reason_codes).toEqual([]);
  });

  it('also aggregates fleet-wide missing and mixed stale/missing collection gaps', () => {
    const staleAgent = {
      monitoring: {
        freshness: 'stale',
        anomaly: { severity: 'warning', reason_codes: ['report_stale'] },
      },
    };
    const missingAgent = {
      monitoring: {
        freshness: 'missing',
        anomaly: { severity: 'warning', reason_codes: ['report_missing'] },
      },
    };

    for (const agents of [
      [missingAgent, missingAgent],
      [staleAgent, missingAgent],
    ]) {
      expect(buildFleetMonitoringSummary(agents)).toMatchObject({
        needs_attention: 1,
        anomaly: {
          severity: 'warning',
          reason_codes: ['ingest_chain_suspected'],
        },
      });
    }
  });

  it('keeps independent critical facts visible during a fleet ingest-chain warning', () => {
    const staleWithBackupFailure = {
      monitoring: {
        freshness: 'stale',
        anomaly: {
          severity: 'critical',
          reason_codes: ['report_stale', 'backup_critical'],
        },
      },
    };
    const missingAgent = {
      monitoring: {
        freshness: 'missing',
        anomaly: { severity: 'warning', reason_codes: ['report_missing'] },
      },
    };

    expect(buildFleetMonitoringSummary([staleWithBackupFailure, missingAgent])).toMatchObject({
      needs_attention: 2,
      anomaly: {
        severity: 'critical',
        reason_codes: ['ingest_chain_suspected'],
      },
    });
  });
});
