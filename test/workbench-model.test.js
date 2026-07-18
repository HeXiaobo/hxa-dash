import { describe, expect, it } from 'vitest';
import { buildWorkbenchModel } from '../public/js/workbench-model.js';

const SYNTHETIC_SAMPLED_AT = Date.parse('2040-01-15T12:00:00.000Z');
const SYNTHETIC_WINDOW = Object.freeze({
  start_date: '2040-01-09',
  end_date: '2040-01-15',
  timezone: 'Asia/Shanghai',
});

describe('central AI employee workbench model', () => {
  it('maps normalized node observability into employee detail without mixing metric scopes', () => {
    const sampledAt = SYNTHETIC_SAMPLED_AT;
    const model = buildWorkbenchModel({
      now: sampledAt + 1_000,
      team: {
        agents: [{
          name: 'yueran',
          work_state: 'working',
          runtime_status: 'running',
          observability: {
            schema_version: 1,
            sampled_at: sampledAt,
            runtime: {
              availability: 'available',
              type: 'codex',
              version: '9.9.1-fixture',
              source: 'agent_health',
              sampled_at: sampledAt,
              pending_restart: null,
              pending_restart_availability: 'unavailable',
              pending_restart_unavailable_reason: 'no_authoritative_field',
            },
            model: {
              availability: 'available',
              value: 'codex-fixture-alpha',
              source: 'codex',
              sampled_at: sampledAt,
              unavailable_reason: null,
            },
            context: {
              availability: 'available',
              used_percent: 61.2,
              remaining_percent: 38.8,
              total_tokens: 120_000,
              plan_type: 'synthetic-pro',
              source: 'statusline_roster',
              sampled_at: sampledAt,
              unavailable_reason: null,
            },
            quota: {
              source: 'codex',
              sampled_at: sampledAt,
              five_hour: {
                availability: 'unavailable',
                used_percent: null,
                resets_at: null,
                unavailable_reason: 'window_not_reported',
              },
              seven_day: {
                availability: 'available',
                used_percent: 23,
                resets_at: sampledAt + 86_400_000,
                unavailable_reason: null,
              },
            },
            session_tokens: {
              availability: 'available',
              scope: 'single_session',
              total: 321_000,
              source: 'codex',
              sampled_at: sampledAt,
              partial: false,
              unavailable_reason: null,
            },
            cost: {
              availability: 'unavailable',
              scope: 'single_session_cumulative',
              currency: 'USD',
              total: null,
              source: 'codex',
              sampled_at: sampledAt,
              estimated: null,
              unavailable_reason: 'not_reported',
            },
            backup: {
              availability: 'unavailable',
              status: null,
              scope: 'local_health',
              source: 'agent_health',
              sampled_at: null,
              last_success_at: null,
              last_success_availability: 'unavailable',
              remote_match: null,
              remote_match_availability: 'unavailable',
              restore_drill: { status: 'unavailable', evidence_at: null },
              unavailable_reason: 'not_reported',
            },
            activity: {
              availability: 'available',
              state: 'idle',
              health: 'ok',
              source: 'activity_monitor_fallback',
              sampled_at: sampledAt,
              used_for_routing: false,
              unavailable_reason: null,
            },
          },
        }],
      },
      tokens: {
        observed: {
          supported: true,
          comparable: true,
          comparability: 'history_last_turns',
          sampled_at: sampledAt,
          observed_at: sampledAt,
          unavailable_reason: null,
          window: SYNTHETIC_WINDOW,
          agents: [{
            name: 'yueran',
            total: 4_200,
            sampled_at: sampledAt,
            reported_at: sampledAt,
            partial_baseline: false,
          }],
        },
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({ q5: null, q7: 23, tokens: 4_200 });
    expect(yueran.observability).toMatchObject({
      sampledAt: '2040-01-15T12:00:00.000Z',
      runtime: {
        availability: 'available',
        type: 'codex',
        version: '9.9.1-fixture',
        pendingRestart: null,
        pendingRestartAvailability: 'unavailable',
        pendingRestartUnavailableReason: 'no_authoritative_field',
      },
      model: {
        availability: 'available',
        value: 'codex-fixture-alpha',
        source: 'codex',
      },
      context: {
        availability: 'available',
        usedPercent: 61.2,
        remainingPercent: 38.8,
        totalTokens: 120_000,
        planType: 'synthetic-pro',
      },
      quota: {
        fiveHour: { availability: 'unavailable', unavailableReason: 'window_not_reported' },
        sevenDay: { availability: 'available', usedPercent: 23 },
      },
      sessionTokens: {
        availability: 'available',
        scope: 'single_session',
        total: 321_000,
      },
      cost: {
        availability: 'unavailable',
        scope: 'single_session_cumulative',
        currency: 'USD',
        total: null,
        unavailableReason: 'not_reported',
      },
      activity: {
        availability: 'available',
        source: 'activity_monitor_fallback',
        usedForRouting: false,
      },
    });
    expect(yueran.observability.sessionTokens.total).not.toBe(yueran.tokens);
  });

  it('expires stale observability evidence without leaking backup proofs or falling back to legacy quota', () => {
    const sampledAt = SYNTHETIC_SAMPLED_AT;
    const model = buildWorkbenchModel({
      now: sampledAt + 10 * 60 * 1000 + 1,
      team: {
        agents: [{
          name: 'yueran',
          observability: {
            schema_version: 1,
            sampled_at: sampledAt,
            runtime: {
              availability: 'available',
              type: 'codex',
              version: '9.9.1-fixture',
              source: 'agent_health',
              sampled_at: sampledAt,
              pending_restart: false,
              pending_restart_availability: 'available',
            },
            context: {
              availability: 'available',
              used_percent: 63,
              source: 'statusline_roster',
              sampled_at: sampledAt,
            },
            quota: {
              source: 'codex',
              sampled_at: sampledAt,
              five_hour: { availability: 'available', used_percent: 5 },
              seven_day: { availability: 'available', used_percent: 18 },
            },
            session_tokens: {
              availability: 'available',
              scope: 'single_session',
              total: 321_000,
              source: 'codex',
              sampled_at: sampledAt,
              partial: false,
            },
            cost: {
              availability: 'available',
              scope: 'single_session_cumulative',
              currency: 'USD',
              total: 12.34,
              source: 'statusline',
              sampled_at: sampledAt,
              estimated: true,
            },
            backup: {
              availability: 'available',
              status: 'ok',
              scope: 'local_health',
              source: 'agent_health',
              sampled_at: sampledAt,
              last_success_at: sampledAt - 1_000,
              last_success_availability: 'available',
              remote_match: true,
              remote_match_availability: 'available',
              restore_drill: { status: 'verified', evidence_at: sampledAt - 2_000 },
            },
            activity: {
              availability: 'available',
              state: 'idle',
              health: 'ok',
              source: 'activity_monitor_fallback',
              sampled_at: sampledAt,
              used_for_routing: false,
            },
          },
        }],
      },
      limits: {
        agents: [{
          name: 'yueran',
          quota: {
            supported: true,
            freshness: { status: 'fresh' },
            primary: { window_minutes: 300, used_percent: 99 },
            secondary: { window_minutes: 10080, used_percent: 99 },
          },
        }],
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({ q5: null, q7: null });
    expect(yueran.observability).toMatchObject({
      runtime: { availability: 'unavailable', unavailableReason: 'stale_sample' },
      context: { availability: 'unavailable', unavailableReason: 'stale_sample' },
      quota: {
        fiveHour: { availability: 'unavailable', unavailableReason: 'stale_sample' },
        sevenDay: { availability: 'unavailable', unavailableReason: 'stale_sample' },
      },
      sessionTokens: { availability: 'unavailable', total: null, unavailableReason: 'stale_sample' },
      cost: { availability: 'unavailable', total: null, unavailableReason: 'stale_sample' },
      backup: {
        availability: 'unavailable',
        status: null,
        unavailableReason: 'stale_sample',
        lastSuccessAt: null,
        lastSuccessAvailability: 'unavailable',
        remoteMatch: null,
        remoteMatchAvailability: 'unavailable',
        restoreDrill: { status: 'unavailable', evidenceAt: null },
      },
      activity: { availability: 'unavailable', unavailableReason: 'stale_sample' },
    });
  });

  it('does not display stale raw runtime data from a real /api/team envelope shape', () => {
    const model = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT + 10 * 60 * 1000 + 1,
      team: {
        agents: [{
          name: 'yueran',
          runtime_status: 'running',
          runtime: {
            type: 'codex',
            label: 'Codex',
            version: '7.7.7-stale-raw-fixture',
          },
          observability: {
            schema_version: 1,
            sampled_at: SYNTHETIC_SAMPLED_AT,
            runtime: {
              availability: 'available',
              type: 'codex',
              version: '9.9.1-fixture',
              source: 'agent_health',
              sampled_at: SYNTHETIC_SAMPLED_AT,
              pending_restart: false,
              pending_restart_availability: 'available',
            },
          },
        }],
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({ runtime: '—', version: '—' });
    expect(yueran.observability.runtime).toMatchObject({
      availability: 'unavailable',
      type: null,
      version: null,
      unavailableReason: 'stale_sample',
    });
    expect(`${yueran.runtime} ${yueran.version}`).not.toContain('7.7.7-stale-raw-fixture');
  });

  it('does not leak backup subproof values that are explicitly unavailable', () => {
    const sampledAt = SYNTHETIC_SAMPLED_AT;
    const model = buildWorkbenchModel({
      now: sampledAt + 1_000,
      team: {
        agents: [{
          name: 'mylos',
          observability: {
            schema_version: 1,
            sampled_at: sampledAt,
            backup: {
              availability: 'available',
              status: 'ok',
              scope: 'local_health',
              source: 'agent_health',
              sampled_at: sampledAt,
              last_success_at: sampledAt - 1_000,
              last_success_availability: 'unavailable',
              remote_match: false,
              remote_match_availability: 'unavailable',
              restore_drill: { status: 'unavailable', evidence_at: sampledAt - 2_000 },
            },
          },
        }],
      },
    });

    const backup = model.employees.find(employee => employee.id === 'mylos').observability.backup;
    expect(backup).toMatchObject({
      availability: 'available',
      status: 'ok',
      lastSuccessAt: null,
      lastSuccessAvailability: 'unavailable',
      remoteMatch: null,
      remoteMatchAvailability: 'unavailable',
      restoreDrill: { status: 'unavailable', evidenceAt: null },
    });
  });

  it('does not expose a backup detail success time later than its source sample', () => {
    const sampledAt = SYNTHETIC_SAMPLED_AT;
    const backup = buildWorkbenchModel({
      now: sampledAt + 1_000,
      team: {
        agents: [{
          name: 'mylos',
          observability: {
            schema_version: 1,
            sampled_at: sampledAt,
            backup: {
              availability: 'available',
              status: 'ok',
              scope: 'local_health',
              source: 'agent_health',
              sampled_at: sampledAt,
              last_success_at: sampledAt + 1,
              last_success_availability: 'available',
            },
          },
        }],
      },
    }).employees.find(employee => employee.id === 'mylos').observability.backup;

    expect(backup).toMatchObject({
      availability: 'available',
      status: 'ok',
      lastSuccessAt: null,
      lastSuccessAvailability: 'unavailable',
    });
  });

  it('fails a malformed observability envelope closed instead of reviving legacy quota values', () => {
    const model = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT + 60_000,
      team: {
        agents: [{
          name: 'yueran',
          observability: {
            schema_version: true,
            quota: {
              sampled_at: SYNTHETIC_SAMPLED_AT,
              five_hour: { availability: 'available', used_percent: false },
              seven_day: { availability: 'available', used_percent: null },
            },
          },
        }],
      },
      limits: {
        agents: [{
          name: 'yueran',
          quota: {
            supported: true,
            freshness: { status: 'fresh' },
            primary: { window_minutes: 300, used_percent: 77 },
            secondary: { window_minutes: 10080, used_percent: 66 },
          },
        }],
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({ q5: null, q7: null });
    expect(yueran.observability).toMatchObject({
      schemaVersion: null,
      quota: {
        fiveHour: { availability: 'unavailable', usedPercent: null },
        sevenDay: { availability: 'unavailable', usedPercent: null },
      },
    });
  });

  it('accepts Activity Monitor only as exact non-routing display evidence', () => {
    const sampledAt = SYNTHETIC_SAMPLED_AT;
    const activity = overrides => ({
      availability: 'available',
      state: 'idle',
      health: 'ok',
      source: 'activity_monitor_fallback',
      sampled_at: sampledAt,
      used_for_routing: false,
      ...overrides,
    });
    const model = buildWorkbenchModel({
      now: sampledAt + 1_000,
      team: {
        agents: [
          {
            name: 'yueran',
            observability: {
              schema_version: 1,
              sampled_at: sampledAt,
              activity: activity({ source: 'untrusted_monitor' }),
            },
          },
          {
            name: 'mylos',
            observability: {
              schema_version: 1,
              sampled_at: sampledAt,
              activity: activity({ used_for_routing: true }),
            },
          },
        ],
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    const mylos = model.employees.find(employee => employee.id === 'mylos');
    expect(yueran.observability.activity).toMatchObject({
      availability: 'unavailable',
      state: null,
      health: null,
      unavailableReason: 'activity_monitor_unavailable',
      usedForRouting: false,
    });
    expect(mylos.observability.activity).toMatchObject({
      availability: 'unavailable',
      state: null,
      health: null,
      unavailableReason: 'activity_monitor_unavailable',
      usedForRouting: false,
    });
  });

  it('rejects fresh-looking values whose provenance is not allowlisted', () => {
    const sampledAt = SYNTHETIC_SAMPLED_AT;
    const model = buildWorkbenchModel({
      now: sampledAt + 1_000,
      team: {
        agents: [{
          name: 'yueran',
          observability: {
            schema_version: 1,
            sampled_at: sampledAt,
            runtime: {
              availability: 'available',
              type: 'codex',
              source: 'browser_guess',
              sampled_at: sampledAt,
              pending_restart: false,
              pending_restart_availability: 'available',
            },
            context: {
              availability: 'available',
              used_percent: 63,
              source: 'browser_guess',
              sampled_at: sampledAt,
            },
            quota: {
              source: 'browser_guess',
              sampled_at: sampledAt,
              five_hour: { availability: 'available', used_percent: 5 },
              seven_day: { availability: 'available', used_percent: 18 },
            },
            session_tokens: {
              availability: 'available',
              scope: 'single_session',
              total: 321_000,
              source: 'browser_guess',
              sampled_at: sampledAt,
              partial: false,
            },
            cost: {
              availability: 'available',
              scope: 'single_session_cumulative',
              currency: 'USD',
              total: 12.34,
              source: 'browser_guess',
              sampled_at: sampledAt,
              estimated: true,
            },
            backup: {
              availability: 'available',
              status: 'ok',
              scope: 'local_health',
              source: 'browser_guess',
              sampled_at: sampledAt,
            },
          },
        }],
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({ q5: null, q7: null });
    for (const field of ['runtime', 'context', 'sessionTokens', 'cost', 'backup']) {
      expect(yueran.observability[field]).toMatchObject({ availability: 'unavailable', source: null });
    }
    expect(yueran.observability.runtime).toMatchObject({
      pendingRestart: null,
      pendingRestartAvailability: 'unavailable',
    });
    expect(yueran.observability.quota).toMatchObject({
      source: null,
      fiveHour: { availability: 'unavailable', usedPercent: null },
      sevenDay: { availability: 'unavailable', usedPercent: null },
    });
  });

  it('rejects known but incompatible field sources and relabeled scopes', () => {
    const sampledAt = SYNTHETIC_SAMPLED_AT;
    const model = buildWorkbenchModel({
      now: sampledAt + 1_000,
      team: {
        agents: [{
          name: 'yueran',
          observability: {
            schema_version: 1,
            sampled_at: sampledAt,
            model: {
              availability: 'available',
              value: 'codex-fixture-alpha',
              source: 'agent_health',
              sampled_at: sampledAt,
            },
            session_tokens: {
              availability: 'available',
              scope: 'seven_day',
              total: 100,
              source: 'activity_monitor_fallback',
              sampled_at: sampledAt,
              partial: false,
            },
            cost: {
              availability: 'available',
              scope: 'billing_month',
              currency: 'USD',
              total: 3.5,
              source: 'transcript',
              sampled_at: sampledAt,
              estimated: true,
            },
            backup: {
              availability: 'available',
              scope: 'remote_restore',
              status: 'ok',
              source: 'transcript',
              sampled_at: sampledAt,
            },
          },
        }],
      },
    });

    const observability = model.employees.find(employee => employee.id === 'yueran').observability;
    expect(observability.model).toMatchObject({
      availability: 'unavailable',
      source: null,
      unavailableReason: 'invalid_value',
    });
    for (const field of ['sessionTokens', 'cost', 'backup']) {
      expect(observability[field]).toMatchObject({
        availability: 'unavailable',
        source: null,
        unavailableReason: 'invalid_value',
      });
    }
  });

  it('keeps blank, boolean, and null observability fields unavailable', () => {
    const sampledAt = SYNTHETIC_SAMPLED_AT;
    const model = buildWorkbenchModel({
      now: sampledAt + 1_000,
      team: {
        agents: [{
          name: 'yueran',
          observability: {
            schema_version: 1,
            sampled_at: sampledAt,
            runtime: {
              availability: 'available',
              type: ' ',
              version: '',
              model: '',
              source: 'agent_health',
              sampled_at: sampledAt,
            },
            context: {
              availability: 'available',
              used_percent: false,
              remaining_percent: null,
              source: 'statusline_roster',
              sampled_at: sampledAt,
            },
            quota: {
              source: 'codex',
              sampled_at: sampledAt,
              five_hour: { availability: 'available', used_percent: false },
              seven_day: { availability: 'available', used_percent: null },
            },
            session_tokens: {
              availability: 'available',
              scope: 'single_session',
              total: false,
              source: 'codex',
              sampled_at: sampledAt,
              partial: false,
            },
            cost: {
              availability: 'available',
              scope: 'single_session_cumulative',
              currency: 'USD',
              total: null,
              source: 'statusline',
              sampled_at: sampledAt,
              estimated: true,
            },
            backup: {
              availability: 'available',
              status: false,
              scope: 'local_health',
              source: 'agent_health',
              sampled_at: sampledAt,
            },
          },
        }],
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({ q5: null, q7: null });
    expect(yueran.observability.runtime).toMatchObject({
      availability: 'unavailable',
      type: null,
      version: null,
    });
    expect(yueran.observability.model).toMatchObject({ availability: 'unavailable', value: null });
    expect(yueran.observability.context).toMatchObject({ availability: 'unavailable', usedPercent: null });
    expect(yueran.observability.sessionTokens).toMatchObject({ availability: 'unavailable', total: null });
    expect(yueran.observability.cost).toMatchObject({ availability: 'unavailable', total: null });
    expect(yueran.observability.backup).toMatchObject({ availability: 'unavailable', status: null });
  });

  it('marks values with no field sample time explicitly unavailable', () => {
    const now = SYNTHETIC_SAMPLED_AT + 60_000;
    const model = buildWorkbenchModel({
      now,
      team: {
        agents: [{
          name: 'yueran',
          observability: {
            schema_version: 1,
            sampled_at: now,
            runtime: { availability: 'available', type: 'codex', source: 'agent_health' },
            context: { availability: 'available', used_percent: 63, source: 'statusline_roster' },
            quota: {
              source: 'codex',
              five_hour: { availability: 'available', used_percent: 5 },
              seven_day: { availability: 'available', used_percent: 18 },
            },
            session_tokens: { availability: 'available', scope: 'single_session', total: 321_000, source: 'codex', partial: false },
            cost: { availability: 'available', scope: 'single_session_cumulative', currency: 'USD', total: 12.34, source: 'statusline', estimated: true },
            backup: { availability: 'available', scope: 'local_health', status: 'ok', source: 'agent_health' },
            activity: {
              availability: 'available',
              state: 'idle',
              health: 'ok',
              source: 'activity_monitor_fallback',
              used_for_routing: false,
            },
          },
        }],
      },
    });

    const observability = model.employees.find(employee => employee.id === 'yueran').observability;
    for (const field of ['runtime', 'context', 'sessionTokens', 'cost', 'backup', 'activity']) {
      expect(observability[field]).toMatchObject({
        availability: 'unavailable',
        sampledAt: null,
        unavailableReason: 'sample_time_unavailable',
      });
    }
    expect(observability.quota).toMatchObject({
      sampledAt: null,
      fiveHour: { availability: 'unavailable', unavailableReason: 'sample_time_unavailable' },
      sevenDay: { availability: 'unavailable', unavailableReason: 'sample_time_unavailable' },
    });
  });

  it('combines fresh central evidence without inventing missing employee data', () => {
    const model = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT + 15_000,
      team: {
        agents: [
          {
            name: 'yueran',
            display_name: '玥然',
            role: '日常工作助理',
            work_state: 'working',
            runtime_status: 'running',
            runtime: { type: 'codex', label: 'Codex', version: '9.9.1-fixture' },
            current_tasks: [{ title: '合成客户交付任务', project: 'fixture-delivery' }],
            last_active_at: SYNTHETIC_SAMPLED_AT,
          },
          {
            name: 'mylos',
            role: '首席 AI 运营官',
            work_state: 'standby',
            runtime_status: 'running',
            runtime: { type: 'claude_code', label: 'Claude Code', version: '8.8.2-fixture' },
            current_tasks: [],
            last_active_at: SYNTHETIC_SAMPLED_AT - 100_000,
          },
        ],
      },
      limits: {
        timestamp: SYNTHETIC_SAMPLED_AT + 10_000,
        agents: [
          {
            name: 'yueran',
            quota: {
              supported: true,
              freshness: { status: 'fresh' },
              primary: { window_minutes: 300, used_percent: 64, resets_at: SYNTHETIC_SAMPLED_AT + 480_000 },
              secondary: { window_minutes: 10080, used_percent: 37, resets_at: SYNTHETIC_SAMPLED_AT + 432_000_000 },
            },
          },
        ],
      },
      tokens: {
        observed: {
          supported: true,
          comparable: true,
          comparability: 'history_last_turns',
          sampled_at: SYNTHETIC_SAMPLED_AT + 10_000,
          observed_at: SYNTHETIC_SAMPLED_AT + 11_000,
          unavailable_reason: null,
          window: {
            start_ms: Date.parse('2040-01-09T00:00:00.000Z'),
            end_ms: Date.parse('2040-01-16T00:00:00.000Z'),
            ...SYNTHETIC_WINDOW,
          },
          agents: [
            {
              name: 'yueran',
              total: 4200,
              sampled_at: SYNTHETIC_SAMPLED_AT + 9_000,
              reported_at: SYNTHETIC_SAMPLED_AT + 10_000,
              partial_baseline: false,
            },
            {
              name: 'mylos',
              total: 2100,
              sampled_at: SYNTHETIC_SAMPLED_AT + 10_000,
              reported_at: SYNTHETIC_SAMPLED_AT + 11_000,
              partial_baseline: false,
            },
          ],
        },
      },
      backups: {
        timestamp: SYNTHETIC_SAMPLED_AT + 20_000,
        agents: [
          {
            name: 'yueran',
            reported_at: SYNTHETIC_SAMPLED_AT + 12_000,
            summary: {
              supported: true,
              status: 'ok',
              sampled_at: SYNTHETIC_SAMPLED_AT + 12_000,
              last_success_at: SYNTHETIC_SAMPLED_AT - 3_600_000,
              expected_match: true,
              counter_evidence_complete: true,
              ahead: 0,
              behind: 0,
              dirty: 0,
              untracked: 0,
            },
          },
        ],
      },
      agentStates: {
        timestamp: SYNTHETIC_SAMPLED_AT + 15_000,
        states: [
          {
            name: 'yueran',
            state: {
              source: 'dashboard_api',
              status: 'fresh',
              observed_at: SYNTHETIC_SAMPLED_AT + 14_000,
              freshness_ms: 1_000,
              stale: false,
              payload: { agent: { state: 'BUSY' } },
            },
          },
        ],
      },
    });

    expect(model.employees).toHaveLength(22);
    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({
      name: '玥然',
      state: '工作中',
      task: '业务任务源待接入',
      q5: 64,
      q7: 37,
      tokens: 4200,
      rank: 1,
      runtime: 'Codex',
      version: 'Codex 9.9.1-fixture',
      observed: true,
    });
    expect(yueran.q5Reset).toBe('2040-01-15T12:08:00.000Z');

    const mylos = model.employees.find(employee => employee.id === 'mylos');
    expect(mylos).toMatchObject({ state: '待命', q5: null, q7: null, tokens: 2100, rank: 2 });

    const hongshu = model.employees.find(employee => employee.id === 'hongshu');
    expect(hongshu).toMatchObject({ state: '暂不可用', q5: null, tokens: null, observed: false });
    expect(model.coverage).toEqual({ quota: 1, tokens: 2, total: 22 });
    expect(model.tokenPeriod).toEqual({
      startDate: '2040-01-09',
      endDate: '2040-01-15',
      timezone: 'Asia/Shanghai',
    });
    expect(model.tasks).toEqual([]);
    expect(model.backup).toMatchObject({
      covered: 1,
      healthy: 1,
      synchronized: 1,
      restoreStatus: 'unverified',
    });
  });

  it('ages a once-fresh agent state by its observation time on the client', () => {
    const readAt = Date.parse('2040-01-15T02:00:00.000Z');
    const model = buildWorkbenchModel({
      now: readAt + 31_001,
      team: {
        agents: [{ name: 'yueran', work_state: 'standby', runtime_status: 'running' }],
      },
      agentStates: {
        timestamp: new Date(readAt).toISOString(),
        states: [{
          name: 'yueran',
          state: {
            status: 'fresh',
            observed_at: new Date(readAt - 1_000).toISOString(),
            freshness_ms: 1_000,
            stale: false,
            payload: { agent: { state: 'BUSY' } },
          },
        }],
      },
    });

    expect(model.employees.find(employee => employee.id === 'yueran')?.state)
      .toBe('待命');
  });

  it('rejects stale quota, estimated activity tokens, partial baselines, and maintenance tasks', () => {
    const model = buildWorkbenchModel({
      team: {
        agents: [{
          name: 'yueran',
          work_state: 'working',
          runtime_status: 'running',
          runtime: { type: 'codex', label: 'Codex', version: '9.9.1-fixture' },
          current_tasks: [
            { title: '合成内部维护任务', project: 'fixture-maintenance' },
            { title: '合成客户案例任务', project: 'fixture-delivery' },
          ],
        }],
      },
      limits: {
        agents: [{
          name: 'yueran',
          quota: {
            supported: true,
            freshness: { status: 'stale' },
            primary: { window_minutes: 300, used_percent: 99 },
          },
        }],
      },
      tokens: {
        estimated: true,
        agents: [{ name: 'yueran', total: 999999 }],
        observed: {
          supported: true,
          agents: [{ name: 'yueran', total: 1234, partial_baseline: true }],
        },
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran.q5).toBeNull();
    expect(yueran.tokens).toBeNull();
    expect(yueran.rank).toBeNull();
    expect(yueran.task).toBe('业务任务源待接入');
    expect(model.coverage).toEqual({ quota: 0, tokens: 0, total: 22 });
  });

  it('never treats a current-session fallback or a future window boundary as fresh 7-day evidence', () => {
    const sampledAt = SYNTHETIC_SAMPLED_AT;
    const futureWindowEnd = sampledAt + 9 * 60 * 60 * 1000;
    const fallback = buildWorkbenchModel({
      now: sampledAt + 1_000,
      tokens: {
        observed: {
          supported: true,
          comparable: false,
          comparability: 'single_session_snapshot',
          sampled_at: sampledAt,
          unavailable_reason: 'single_session_snapshot_not_comparable',
          window: {
            ...SYNTHETIC_WINDOW,
            end_ms: futureWindowEnd,
          },
          agents: [{ name: 'yueran', total: 321_000, partial_baseline: true }],
        },
      },
    });
    const yueran = fallback.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({
      tokens: null,
      rank: null,
      tokenSampledAt: null,
      tokenUnavailableReason: 'single_session_snapshot_not_comparable',
    });
    expect(yueran.tokenObservedAt).toBeNull();

    const stale = buildWorkbenchModel({
      now: sampledAt + 10 * 60 * 1000 + 1,
      tokens: {
        observed: {
          supported: true,
          comparable: true,
          comparability: 'history_last_turns',
          sampled_at: sampledAt,
          observed_at: sampledAt,
          unavailable_reason: null,
          window: SYNTHETIC_WINDOW,
          agents: [{ name: 'yueran', total: 4_200, partial_baseline: false }],
        },
      },
    }).employees.find(employee => employee.id === 'yueran');
    expect(stale).toMatchObject({ tokens: null, rank: null, tokenUnavailableReason: 'stale_sample' });
  });

  it('uses the central observation time for rank freshness while preserving the source sample time', () => {
    const sourceSampleAt = SYNTHETIC_SAMPLED_AT - 9 * 60 * 1000;
    const observedAt = SYNTHETIC_SAMPLED_AT - 1_000;
    const employee = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT,
      tokens: {
        observed: {
          supported: true,
          comparable: true,
          comparability: 'history_last_turns',
          sampled_at: sourceSampleAt,
          observed_at: observedAt,
          unavailable_reason: null,
          window: SYNTHETIC_WINDOW,
          agents: [{
            name: 'yueran',
            total: 4_200,
            sampled_at: sourceSampleAt,
            reported_at: observedAt,
            partial_baseline: false,
          }],
        },
      },
    }).employees.find(item => item.id === 'yueran');

    expect(employee).toMatchObject({
      tokens: 4_200,
      tokenSampledAt: new Date(sourceSampleAt).toISOString(),
      tokenObservedAt: new Date(observedAt).toISOString(),
      tokenUnavailableReason: null,
    });
  });

  it('preserves each employee Token sample and observation time instead of copying the latest agent time', () => {
    const yueranSampledAt = SYNTHETIC_SAMPLED_AT - 9 * 60 * 1000;
    const yueranObservedAt = SYNTHETIC_SAMPLED_AT - 8 * 60 * 1000 - 59_000;
    const mylosSampledAt = SYNTHETIC_SAMPLED_AT - 2_000;
    const mylosObservedAt = SYNTHETIC_SAMPLED_AT - 1_000;
    const employees = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT,
      tokens: {
        observed: {
          supported: true,
          comparable: true,
          comparability: 'history_last_turns',
          sampled_at: mylosSampledAt,
          observed_at: mylosObservedAt,
          unavailable_reason: null,
          window: SYNTHETIC_WINDOW,
          agents: [
            {
              name: 'yueran',
              total: 4_200,
              sampled_at: yueranSampledAt,
              reported_at: yueranObservedAt,
              partial_baseline: false,
            },
            {
              name: 'mylos',
              total: 2_100,
              sampled_at: mylosSampledAt,
              reported_at: mylosObservedAt,
              partial_baseline: false,
            },
          ],
        },
      },
    }).employees;

    expect(employees.find(employee => employee.id === 'yueran')).toMatchObject({
      tokens: 4_200,
      tokenSampledAt: new Date(yueranSampledAt).toISOString(),
      tokenObservedAt: new Date(yueranObservedAt).toISOString(),
    });
    expect(employees.find(employee => employee.id === 'mylos')).toMatchObject({
      tokens: 2_100,
      tokenSampledAt: new Date(mylosSampledAt).toISOString(),
      tokenObservedAt: new Date(mylosObservedAt).toISOString(),
    });
  });

  it('fails each employee Token row closed when its own times are missing, stale, future, or inconsistent', () => {
    const employees = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT,
      tokens: {
        observed: {
          supported: true,
          comparable: true,
          comparability: 'history_last_turns',
          sampled_at: SYNTHETIC_SAMPLED_AT - 1_000,
          observed_at: SYNTHETIC_SAMPLED_AT - 500,
          unavailable_reason: null,
          window: SYNTHETIC_WINDOW,
          agents: [
            { name: 'yueran', total: 4_200, partial_baseline: false },
            {
              name: 'mylos',
              total: 2_100,
              sampled_at: SYNTHETIC_SAMPLED_AT - 10 * 60 * 1000 - 1,
              reported_at: SYNTHETIC_SAMPLED_AT - 1_000,
              partial_baseline: false,
            },
            {
              name: 'ss',
              total: 1_500,
              sampled_at: SYNTHETIC_SAMPLED_AT + 5_001,
              reported_at: SYNTHETIC_SAMPLED_AT - 1_000,
              partial_baseline: false,
            },
            {
              name: 'veda',
              total: 900,
              sampled_at: SYNTHETIC_SAMPLED_AT - 1_000,
              reported_at: SYNTHETIC_SAMPLED_AT - 7_000,
              partial_baseline: false,
            },
          ],
        },
      },
    }).employees;

    expect(employees.find(employee => employee.id === 'yueran')).toMatchObject({
      tokens: null,
      tokenSampledAt: null,
      tokenObservedAt: null,
      tokenUnavailableReason: 'sample_time_unavailable',
    });
    for (const id of ['mylos', 'ss', 'veda']) {
      expect(employees.find(employee => employee.id === id)).toMatchObject({
        tokens: null,
        tokenSampledAt: null,
        tokenObservedAt: null,
        tokenUnavailableReason: 'stale_sample',
      });
    }
  });

  it('keeps Token rank unavailable when central observation time is missing', () => {
    const employee = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT,
      tokens: {
        observed: {
          supported: true,
          comparable: true,
          comparability: 'history_last_turns',
          sampled_at: SYNTHETIC_SAMPLED_AT - 2_000,
          observed_at: null,
          unavailable_reason: null,
          window: SYNTHETIC_WINDOW,
          agents: [{ name: 'yueran', total: 4_200, partial_baseline: false }],
        },
      },
    }).employees.find(item => item.id === 'yueran');

    expect(employee).toMatchObject({
      tokens: null,
      rank: null,
      tokenUnavailableReason: 'sample_time_unavailable',
    });
  });

  it('rejects Token source time later than central observation beyond clock skew', () => {
    const employee = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT,
      tokens: {
        observed: {
          supported: true,
          comparable: true,
          comparability: 'history_last_turns',
          sampled_at: SYNTHETIC_SAMPLED_AT - 1_000,
          observed_at: SYNTHETIC_SAMPLED_AT - 6_001,
          unavailable_reason: null,
          window: SYNTHETIC_WINDOW,
          agents: [{ name: 'yueran', total: 4_200, partial_baseline: false }],
        },
      },
    }).employees.find(item => item.id === 'yueran');

    expect(employee).toMatchObject({
      tokens: null,
      rank: null,
      tokenUnavailableReason: 'stale_sample',
    });
  });

  it('rejects a future Token source time even when the central observation is fresh', () => {
    const employee = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT,
      tokens: {
        observed: {
          supported: true,
          comparable: true,
          comparability: 'history_last_turns',
          sampled_at: SYNTHETIC_SAMPLED_AT + 5_001,
          observed_at: SYNTHETIC_SAMPLED_AT - 1_000,
          unavailable_reason: null,
          window: SYNTHETIC_WINDOW,
          agents: [{ name: 'yueran', total: 4_200, partial_baseline: false }],
        },
      },
    }).employees.find(item => item.id === 'yueran');

    expect(employee).toMatchObject({
      tokens: null,
      rank: null,
      tokenUnavailableReason: 'stale_sample',
    });
  });

  it('counts only fresh /api/backups records and requires complete counters for synchronization', () => {
    const summary = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT,
      backups: {
        timestamp: SYNTHETIC_SAMPLED_AT,
        agents: [
          {
            name: 'yueran',
            reported_at: SYNTHETIC_SAMPLED_AT - 10 * 60 * 1000 - 1,
            summary: {
              supported: true,
              status: 'ok',
              sampled_at: SYNTHETIC_SAMPLED_AT - 1_000,
              expected_match: true,
              counter_evidence_complete: true,
              ahead: 0,
              behind: 0,
              dirty: 0,
              untracked: 0,
            },
          },
          {
            name: 'mylos',
            reported_at: SYNTHETIC_SAMPLED_AT + 5_001,
            summary: {
              supported: true,
              status: 'ok',
              sampled_at: SYNTHETIC_SAMPLED_AT - 1_000,
              expected_match: true,
              counter_evidence_complete: true,
              ahead: 0,
              behind: 0,
              dirty: 0,
              untracked: 0,
            },
          },
          {
            name: 'ss',
            reported_at: SYNTHETIC_SAMPLED_AT - 1_000,
            summary: {
              supported: true,
              status: 'ok',
              sampled_at: SYNTHETIC_SAMPLED_AT - 1_000,
              last_success_at: SYNTHETIC_SAMPLED_AT - 2_000,
              expected_match: true,
              counter_evidence_complete: true,
              ahead: 0,
              behind: 0,
              dirty: 0,
              untracked: 0,
            },
          },
          {
            name: 'veda',
            reported_at: SYNTHETIC_SAMPLED_AT - 2_000,
            summary: {
              supported: true,
              status: 'ok',
              sampled_at: SYNTHETIC_SAMPLED_AT - 2_000,
              expected_match: true,
              ahead: 0,
              behind: 0,
              dirty: 0,
              untracked: 0,
            },
          },
          {
            name: 'aqi',
            reported_at: SYNTHETIC_SAMPLED_AT - 1_000,
            summary: {
              supported: true,
              status: 'ok',
              sampled_at: SYNTHETIC_SAMPLED_AT - 10 * 60 * 1000 - 1,
              expected_match: true,
              counter_evidence_complete: true,
              ahead: 0,
              behind: 0,
              dirty: 0,
              untracked: 0,
            },
          },
          {
            name: 'xinghang',
            reported_at: SYNTHETIC_SAMPLED_AT - 1_000,
            summary: {
              supported: true,
              status: 'ok',
              sampled_at: SYNTHETIC_SAMPLED_AT + 5_001,
              expected_match: true,
              counter_evidence_complete: true,
              ahead: 0,
              behind: 0,
              dirty: 0,
              untracked: 0,
            },
          },
        ],
      },
    }).backup;

    expect(summary).toEqual({
      covered: 2,
      healthy: 2,
      synchronized: 1,
      latestSuccessAt: '2040-01-15T11:59:58.000Z',
      restoreStatus: 'unverified',
    });
  });

  it('does not expose a backup success time later than its sample or the current clock', () => {
    const summary = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT,
      backups: {
        agents: [{
          name: 'yueran',
          reported_at: SYNTHETIC_SAMPLED_AT - 1_000,
          summary: {
            supported: true,
            status: 'ok',
            sampled_at: SYNTHETIC_SAMPLED_AT - 1_000,
            last_success_at: SYNTHETIC_SAMPLED_AT + 5_001,
            expected_match: true,
            counter_evidence_complete: true,
            ahead: 0,
            behind: 0,
            dirty: 0,
            untracked: 0,
          },
        }],
      },
    }).backup;

    expect(summary).toMatchObject({
      covered: 1,
      healthy: 1,
      latestSuccessAt: null,
    });
  });

  it('keeps null, blank, and boolean evidence unavailable instead of coercing it to zero', () => {
    const model = buildWorkbenchModel({
      team: { agents: [{ name: 'yueran', work_state: 'standby' }] },
      limits: {
        agents: [{
          name: 'yueran',
          quota: {
            supported: true,
            freshness: { status: 'fresh' },
            primary: { window_minutes: 300, used_percent: 25 },
            secondary: { window_minutes: 10080, used_percent: false },
          },
        }],
      },
      tokens: {
        observed: {
          supported: true,
          window: SYNTHETIC_WINDOW,
          agents: [{ name: 'yueran', total: ' ' }],
        },
      },
      backups: {
        agents: [{
          name: 'yueran',
          summary: {
            supported: true,
            status: 'ok',
            expected_match: true,
            ahead: null,
            behind: 0,
            dirty: 0,
            untracked: 0,
          },
        }],
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({ q5: 25, q7: null, tokens: null });
    expect(model.coverage).toEqual({ quota: 1, tokens: 0, total: 22 });
    expect(model.backup.synchronized).toBe(0);
  });

  it('rejects fractional Token totals at the browser contract instead of rounding them', () => {
    const employee = buildWorkbenchModel({
      now: SYNTHETIC_SAMPLED_AT,
      team: {
        agents: [{
          name: 'yueran',
          observability: {
            schema_version: 1,
            sampled_at: SYNTHETIC_SAMPLED_AT - 1_000,
            session_tokens: {
              availability: 'available',
              scope: 'single_session',
              total: 10.5,
              source: 'codex',
              sampled_at: SYNTHETIC_SAMPLED_AT - 1_000,
              partial: false,
            },
          },
        }],
      },
      tokens: {
        observed: {
          supported: true,
          comparable: true,
          comparability: 'history_last_turns',
          sampled_at: SYNTHETIC_SAMPLED_AT - 2_000,
          observed_at: SYNTHETIC_SAMPLED_AT - 1_000,
          window: SYNTHETIC_WINDOW,
          agents: [{ name: 'yueran', total: 4.5, partial_baseline: false }],
        },
      },
    }).employees.find(item => item.id === 'yueran');

    expect(employee).toMatchObject({ tokens: null, rank: null });
    expect(employee.observability.sessionTokens).toMatchObject({
      availability: 'unavailable',
      total: null,
      unavailableReason: 'invalid_value',
    });
  });
});
