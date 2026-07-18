import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildAgentObservability, evidenceTimeForRead, quotaForRead } = require('../src/agent-observability.js');
const SYNTHETIC_SAMPLE_AT = Date.parse('2040-01-15T12:00:00.000Z');
const SYNTHETIC_NEWER_SAMPLE_AT = SYNTHETIC_SAMPLE_AT + 20_000;

describe('AI employee observability summary', () => {
  it('permanently rejects source samples more than five seconds after their central report', () => {
    const reportedAt = SYNTHETIC_SAMPLE_AT;
    const inconsistentAt = reportedAt + 9 * 60 * 1000;

    expect(evidenceTimeForRead(inconsistentAt, { reportedAt, now: reportedAt })).toEqual({
      sampledAt: null,
      reason: 'stale_sample',
    });
    expect(evidenceTimeForRead(inconsistentAt, { reportedAt, now: inconsistentAt })).toEqual({
      sampledAt: null,
      reason: 'stale_sample',
    });
    expect(evidenceTimeForRead(reportedAt + 5_000, { reportedAt, now: reportedAt + 5_000 })).toEqual({
      sampledAt: reportedAt + 5_000,
      reason: null,
    });
    expect(evidenceTimeForRead(reportedAt + 5_001, { reportedAt, now: reportedAt + 5_001 })).toEqual({
      sampledAt: null,
      reason: 'stale_sample',
    });
  });

  it('keeps fresh quota evidence and fails stale, future, or untimed evidence closed', () => {
    const now = SYNTHETIC_SAMPLE_AT;
    const fresh = {
      supported: true,
      source: 'codex',
      sampled_at: now - 1000,
      primary: { label: '5h', window_minutes: 300, used_percent: 12 },
      secondary: null,
      credits: null,
    };

    expect(quotaForRead(fresh, { now, reportedAt: now - 500 })).toBe(fresh);
    expect(quotaForRead({ supported: false, reason: 'not_reported' }, { now }))
      .toEqual({ supported: false, reason: 'not_reported' });

    for (const [quota, reportedAt, reason] of [
      [{ ...fresh, sampled_at: null }, now - 500, 'sample_time_unavailable'],
      [{ ...fresh, sampled_at: now - 10 * 60 * 1000 - 1 }, now - 500, 'stale_sample'],
      [{ ...fresh, sampled_at: now + 5001 }, now - 500, 'stale_sample'],
      [fresh, null, 'sample_time_unavailable'],
      [fresh, now - 10 * 60 * 1000 - 1, 'stale_sample'],
    ]) {
      expect(quotaForRead(quota, { now, reportedAt })).toEqual({
        supported: false,
        source: null,
        reason,
        sampled_at: null,
        primary: null,
        secondary: null,
        credits: null,
      });
    }
  });

  it('preserves two synthetic node samples without relabeling or inventing missing values', () => {
    const mylos = buildAgentObservability({
      now: SYNTHETIC_NEWER_SAMPLE_AT,
      runtime: {
        type: 'claude_code',
        version: '8.8.2-fixture',
        source: 'agent_health',
        checked_at: SYNTHETIC_SAMPLE_AT,
      },
      quota: {
        supported: true,
        source: 'statusline',
        sampled_at: SYNTHETIC_SAMPLE_AT + 500,
        primary: { label: '5h', window_minutes: 300, used_percent: 7, resets_at: SYNTHETIC_SAMPLE_AT + 16_200_000 },
        secondary: { label: '7d', window_minutes: 10_080, used_percent: 41, resets_at: SYNTHETIC_SAMPLE_AT + 256_386_000 },
      },
      usage: {
        supported: true,
        source: 'transcript',
        sampled_at: SYNTHETIC_SAMPLE_AT,
        partial: false,
        model: 'claude-fixture-beta',
        model_source: 'transcript',
        model_sampled_at: SYNTHETIC_SAMPLE_AT,
        session_tokens: {
          input: 100,
          output: 20_000,
          cache_creation: 30_000,
          cache_read: 600_000,
        },
        session_cost_usd: 12.34,
        cost_source: 'statusline',
        cost_sampled_at: SYNTHETIC_SAMPLE_AT + 500,
        estimated_cost: true,
      },
      backup: {
        supported: true,
        status: 'ok',
        sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        cron_status: 'ok',
      },
      roster: {
        context_used_pct: 27.5,
        sampled_at: SYNTHETIC_SAMPLE_AT + 500,
        plan_type: 'synthetic-max',
      },
    });

    expect(mylos).toMatchObject({
      source: 'agent_health',
      sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
      runtime: {
        type: 'claude_code',
        version: '8.8.2-fixture',
        pending_restart: null,
        pending_restart_availability: 'unavailable',
      },
      model: {
        availability: 'available',
        value: 'claude-fixture-beta',
        source: 'transcript',
        sampled_at: SYNTHETIC_SAMPLE_AT,
      },
      context: { availability: 'available', used_percent: 27.5, remaining_percent: 72.5 },
      quota: {
        five_hour: { availability: 'available', used_percent: 7, resets_at: SYNTHETIC_SAMPLE_AT + 16_200_000 },
        seven_day: { availability: 'available', used_percent: 41, resets_at: SYNTHETIC_SAMPLE_AT + 256_386_000 },
      },
      session_tokens: {
        availability: 'available',
        scope: 'single_session',
        total: 650_100,
      },
      cost: {
        availability: 'available',
        currency: 'USD',
        total: 12.34,
        source: 'statusline',
        sampled_at: SYNTHETIC_SAMPLE_AT + 500,
        estimated: true,
      },
      backup: {
        availability: 'available',
        status: 'ok',
        scope: 'local_health',
        three_evidence_availability: 'unavailable',
      },
    });

    const yueran = buildAgentObservability({
      now: SYNTHETIC_NEWER_SAMPLE_AT,
      runtime: {
        type: 'codex',
        version: '9.9.1-fixture',
        source: 'agent_health',
        checked_at: SYNTHETIC_SAMPLE_AT - 60_000,
      },
      quota: {
        supported: true,
        source: 'codex',
        sampled_at: SYNTHETIC_SAMPLE_AT - 60_000,
        primary: { label: '5h', window_minutes: 10_080, used_percent: 23, resets_at: SYNTHETIC_SAMPLE_AT + 86_400_000 },
        secondary: null,
      },
      usage: {
        supported: true,
        source: 'codex',
        sampled_at: SYNTHETIC_SAMPLE_AT - 60_000,
        partial: false,
        model: 'codex-fixture-alpha',
        model_source: 'codex',
        model_sampled_at: SYNTHETIC_SAMPLE_AT - 60_000,
        plan_type: 'synthetic-pro',
        session_tokens: { input: 300_000, output: 21_000 },
        session_cost_usd: false,
      },
      backup: {
        supported: false,
        status: 'unsupported',
        reason: 'not_reported',
        sampled_at: null,
      },
      roster: {
        context_used_pct: 61.2,
        context_total_tokens: 120_000,
        sampled_at: SYNTHETIC_SAMPLE_AT - 60_000,
        plan_type: 'synthetic-pro',
      },
    });

    expect(yueran.quota).toMatchObject({
      source: 'codex',
      sampled_at: SYNTHETIC_SAMPLE_AT - 60_000,
    });
    expect(yueran.quota.five_hour).toMatchObject({
      availability: 'unavailable',
      used_percent: null,
      resets_at: null,
      unavailable_reason: 'window_not_reported',
    });
    expect(yueran.quota.seven_day).toMatchObject({
      availability: 'available',
      used_percent: 23,
      resets_at: SYNTHETIC_SAMPLE_AT + 86_400_000,
    });
    expect(yueran.session_tokens).toMatchObject({
      availability: 'available',
      scope: 'single_session',
      total: 321_000,
      source: 'codex',
      sampled_at: SYNTHETIC_SAMPLE_AT - 60_000,
    });
    expect(yueran.cost).toMatchObject({
      availability: 'unavailable',
      currency: 'USD',
      total: null,
      unavailable_reason: 'not_reported',
    });
    expect(yueran.backup).toMatchObject({
      availability: 'unavailable',
      status: null,
      unavailable_reason: 'not_reported',
    });
  });

  it('labels Activity Monitor as a display-only fallback and never as routing evidence', () => {
    const summary = buildAgentObservability({
      now: SYNTHETIC_NEWER_SAMPLE_AT,
      activity: {
        state: 'idle',
        health: 'ok',
        observed_at: SYNTHETIC_NEWER_SAMPLE_AT,
        source: 'activity_monitor_fallback',
        used_for_routing: false,
      },
    });

    expect(summary.activity).toEqual({
      availability: 'available',
      state: 'idle',
      health: 'ok',
      source: 'activity_monitor_fallback',
      sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
      used_for_routing: false,
      unavailable_reason: null,
    });
  });

  it.each([
    ['missing', undefined],
    ['routing', true],
  ])('rejects Activity Monitor evidence when used_for_routing is %s', (_label, usedForRouting) => {
    const activity = {
      state: 'idle',
      health: 'ok',
      observed_at: SYNTHETIC_NEWER_SAMPLE_AT,
      source: 'activity_monitor_fallback',
    };
    if (usedForRouting !== undefined) activity.used_for_routing = usedForRouting;

    expect(buildAgentObservability({ activity }).activity).toMatchObject({
      availability: 'unavailable',
      state: null,
      health: null,
      used_for_routing: false,
      unavailable_reason: 'activity_monitor_unavailable',
    });
  });

  it('rejects an Activity Monitor payload that disguises an untrusted source', () => {
    const summary = buildAgentObservability({
      activity: {
        state: 'idle',
        health: 'ok',
        observed_at: SYNTHETIC_NEWER_SAMPLE_AT,
        source: 'untrusted_monitor',
      },
    });

    expect(summary.activity).toEqual({
      availability: 'unavailable',
      state: null,
      health: null,
      source: null,
      sampled_at: null,
      used_for_routing: false,
      unavailable_reason: 'activity_monitor_unavailable',
    });
  });

  it('keeps boolean, blank, and malformed evidence unavailable instead of coercing it to zero', () => {
    const summary = buildAgentObservability({
      quota: {
        supported: true,
        source: 'codex',
        sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        primary: { window_minutes: 300, used_percent: false, resets_at: null },
      },
      usage: {
        supported: true,
        source: 'codex',
        sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        session_tokens: { input: false, output: null, total: ' ' },
        session_cost_usd: false,
      },
      roster: { context_used_pct: false, sampled_at: SYNTHETIC_NEWER_SAMPLE_AT },
    });

    expect(summary.quota.five_hour).toMatchObject({ availability: 'unavailable', used_percent: null });
    expect(summary.session_tokens).toMatchObject({ availability: 'unavailable', total: null });
    expect(summary.cost).toMatchObject({ availability: 'unavailable', total: null });
    expect(summary.context).toMatchObject({ availability: 'unavailable', used_percent: null });
  });

  it('rejects fractional Token counts instead of rounding them into plausible evidence', () => {
    const summary = buildAgentObservability({
      usage: {
        supported: true,
        source: 'codex',
        sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        partial: false,
        session_tokens: { input: 10, output: 2.5 },
      },
    });

    expect(summary.session_tokens).toMatchObject({
      availability: 'unavailable',
      total: null,
      unavailable_reason: 'invalid_value',
    });
  });

  it('fails known but incompatible field sources closed instead of laundering them', () => {
    const summary = buildAgentObservability({
      runtime: { type: 'codex', version: '9.9.1-fixture', source: 'transcript', checked_at: SYNTHETIC_NEWER_SAMPLE_AT },
      quota: {
        supported: true,
        source: 'activity_monitor_fallback',
        sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        primary: { window_minutes: 300, used_percent: 5 },
      },
      usage: {
        supported: true,
        source: 'activity_monitor_fallback',
        sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        partial: false,
        model: 'codex-fixture-alpha',
        model_source: 'agent_health',
        model_sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        session_tokens: { total: 100 },
        session_cost_usd: 1.5,
        cost_source: 'transcript',
        cost_sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        estimated_cost: true,
      },
    });

    expect(summary.runtime).toMatchObject({ availability: 'unavailable', source: null });
    expect(summary.model).toMatchObject({ availability: 'unavailable', source: null });
    expect(summary.quota).toMatchObject({ source: null });
    expect(summary.quota.five_hour).toMatchObject({ availability: 'unavailable' });
    expect(summary.session_tokens).toMatchObject({ availability: 'unavailable', source: null });
    expect(summary.cost).toMatchObject({ availability: 'unavailable', source: null });
  });

  it('calls an expected remote synchronized only when complete repo counters all agree', () => {
    const summary = buildAgentObservability({
      backup: {
        supported: true,
        status: 'ok',
        sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        expected_match: true,
        counter_evidence_complete: true,
        ahead: 0,
        behind: 0,
        dirty: 0,
        untracked: 0,
      },
    });

    expect(summary.backup).toMatchObject({
      remote_match: true,
      remote_match_availability: 'available',
    });
  });

  it('does not call an expected remote synchronized when complete repo counters disagree', () => {
    const summary = buildAgentObservability({
      backup: {
        supported: true,
        status: 'warning',
        sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        expected_match: true,
        counter_evidence_complete: true,
        ahead: 1,
        behind: 0,
        dirty: 0,
        untracked: 0,
      },
    });

    expect(summary.backup).toMatchObject({
      remote_match: false,
      remote_match_availability: 'available',
    });
  });

  it('keeps remote match unavailable when the counter completeness marker is missing', () => {
    const summary = buildAgentObservability({
      backup: {
        supported: true,
        status: 'ok',
        sampled_at: SYNTHETIC_NEWER_SAMPLE_AT,
        expected_match: true,
        ahead: 0,
        behind: 0,
        dirty: 0,
        untracked: 0,
      },
    });

    expect(summary.backup).toMatchObject({
      remote_match: null,
      remote_match_availability: 'unavailable',
    });
  });
});
