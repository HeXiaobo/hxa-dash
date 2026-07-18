import { describe, it, expect } from 'vitest';

const express = require('express');
const db = require('../src/db');
const teamRoute = require('../src/routes/team');
const {
  runtimeEvidenceLevel,
  buildRuntimeSummary,
  selectQuotaForRuntime,
  selectUsageForRuntime,
} = teamRoute.__private;

async function startApi() {
  const app = express();
  app.use('/api/team', teamRoute);
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

describe('team runtime evidence', () => {
  it('treats process/config/env detections as strong evidence', () => {
    const now = Date.now();
    const health = {
      runtime: {
        type: 'codex',
        status: 'offline',
        source: 'codex version',
        detection_source: 'process',
        checked_at: now,
      },
      reported_at: now,
    };

    expect(runtimeEvidenceLevel(health, 'codex')).toBe('strong');
  });

  it('treats profile-only detection as weak evidence', () => {
    const now = Date.now();
    const health = {
      runtime: {
        type: 'claude_code',
        status: 'offline',
        source: 'claude version',
        detection_source: 'profile',
        checked_at: now,
      },
      reported_at: now,
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
        checked_at: now,
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
        checked_at: now,
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
        version: '8.8.1-fixture',
        source: 'claude version',
        detection_source: 'process',
        checked_at: now,
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

  it('fails future health and missing runtime source times closed without exposing runtime details', () => {
    const now = 1_700_000_000_000;
    const future = buildRuntimeSummary({ online: true }, {
      reported_at: now + 5_001,
      runtime: {
        type: 'codex',
        status: 'running',
        version: '9.9.9-future-fixture',
        source: 'codex version',
        detection_source: 'process',
        checked_at: now - 1_000,
      },
      disk: { status: 'ok' },
      memory: { status: 'ok' },
    }, now);
    expect(future).toMatchObject({
      type: 'unknown',
      label: 'unknown',
      version: null,
      status: 'offline',
      checked_at: null,
      stale: true,
    });

    const missingSourceTime = buildRuntimeSummary({ online: true }, {
      reported_at: now - 1_000,
      runtime: {
        type: 'codex',
        status: 'running',
        version: '9.9.9-missing-time-fixture',
        source: 'codex version',
        detection_source: 'process',
      },
      disk: { status: 'ok' },
      memory: { status: 'ok' },
    }, now);
    expect(missingSourceTime).toMatchObject({
      type: 'unknown',
      label: 'unknown',
      version: null,
      status: 'offline',
      checked_at: null,
      stale: true,
    });
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

  it('fails out-of-range quota values closed instead of clamping them to 0 or 100', () => {
    const quota = selectQuotaForRuntime({
      quota: {
        codex: {
          supported: true,
          source: 'codex-api',
          sampled_at: Date.now(),
          primary: { window_minutes: 300, used_percent: -10 },
          secondary: { window_minutes: 10080, used_percent: 120 },
        },
      },
    }, 'codex');

    expect(quota.supported).toBe(false);
    expect(quota.reason).toBe('no_used_quota_window');
    expect(quota.primary?.used_percent).toBeNull();
    expect(quota.secondary?.used_percent).toBeNull();
  });

  it('normalizes documented reporter origins without relabeling model or cost provenance', () => {
    const usage = selectUsageForRuntime({
      usage: {
        codex: {
          supported: true,
          source: 'rollout',
          sampled_at: 1000,
          model: 'codex-fixture-alpha',
          model_source: 'codex',
          model_sampled_at: 1000,
          session_tokens: { total: 100 },
          partial: false,
        },
      },
    }, 'codex');

    expect(usage).toMatchObject({
      source: 'codex',
      model_source: 'codex',
      model_sampled_at: 1000,
      partial: false,
    });
  });

  it('rejects a mixed malformed historical token row instead of preserving only its plausible fields', () => {
    const usage = selectUsageForRuntime({
      usage: {
        codex: {
          supported: true,
          source: 'codex',
          sampled_at: 1_700_000_000_000,
          session_tokens: { input: 10, output: false },
          last_turn_tokens: { input: 5, output: -1 },
          partial: false,
        },
      },
    }, 'codex');

    expect(usage).toMatchObject({
      reason: 'invalid_value',
      session_tokens: null,
      last_turn_tokens: null,
      partial: false,
    });
  });

  it('does not expose stale Token or cost evidence through either team interface', async () => {
    const realNow = Date.now;
    const now = 1_800_000_300_000;
    const staleAt = now - 10 * 60 * 1000 - 1;
    const name = `team-stale-usage-${process.pid}-${realNow()}`;
    const marker = 'synthetic-team-stale-usage-marker';
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
        runtime: {
          type: 'codex',
          status: 'running',
          source: 'codex version',
          detection_source: 'process',
          checked_at: now - 1000,
        },
        usage: {
          codex: {
            supported: true,
            source: 'codex',
            sampled_at: staleAt,
            session_id: marker,
            model: marker,
            model_source: 'codex',
            model_sampled_at: staleAt,
            session_tokens: { input: 400, output: 20, total: 420 },
            last_turn_tokens: { input: 4, output: 2, total: 6 },
            session_cost_usd: 12.34,
            cost_source: 'codex',
            cost_sampled_at: staleAt,
            estimated_cost: true,
            partial: false,
          },
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const detail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const agent of [collectionAgent, detail.agent]) {
        expect(agent.runtime.stale).toBe(false);
        expect(agent.usage).toMatchObject({
          supported: false,
          reason: 'stale_sample',
          sampled_at: null,
          session_tokens: null,
          last_turn_tokens: null,
          session_cost_usd: null,
          cost_sampled_at: null,
        });
        expect(JSON.stringify(agent)).not.toContain(marker);
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('does not treat stale usage as confirmation that an offline runtime is running', async () => {
    const realNow = Date.now;
    const now = 1_800_000_325_000;
    const staleAt = now - 10 * 60 * 1000 - 1;
    const name = `team-offline-stale-usage-${process.pid}-${realNow()}`;
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
        runtime: {
          type: 'codex',
          status: 'offline',
          source: 'codex version',
          detection_source: 'process',
          checked_at: now - 1000,
        },
        usage: {
          codex: {
            supported: true,
            source: 'codex',
            sampled_at: staleAt,
            session_tokens: { input: 400, output: 20, total: 420 },
            partial: false,
          },
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const detail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const agent of [collectionAgent, detail.agent]) {
        expect(agent.usage).toMatchObject({
          supported: false,
          reason: 'stale_sample',
          sampled_at: null,
        });
        expect(agent.runtime_status).toBe('degraded');
        expect(agent.runtime.status).toBe('degraded');
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('does not let empty, untrusted, or malformed supported evidence override an explicitly offline runtime', async () => {
    const realNow = Date.now;
    const now = 1_800_000_340_000;
    const fixtureId = realNow();
    const cases = [
      {
        name: `team-offline-empty-usage-${process.pid}-${fixtureId}`,
        evidence: {
          usage: {
            codex: {
              supported: true,
              source: 'codex',
              sampled_at: now - 1000,
              partial: false,
            },
          },
        },
      },
      {
        name: `team-offline-untrusted-usage-${process.pid}-${fixtureId}`,
        evidence: {
          usage: {
            codex: {
              supported: true,
              source: 'synthetic-untrusted-source',
              sampled_at: now - 1000,
              session_tokens: { total: 100 },
              partial: false,
            },
          },
        },
      },
      {
        name: `team-offline-malformed-usage-${process.pid}-${fixtureId}`,
        evidence: {
          usage: {
            codex: {
              supported: true,
              source: 'codex',
              sampled_at: now - 1000,
              session_tokens: { total: '100' },
              partial: false,
            },
          },
        },
      },
      {
        name: `team-offline-empty-quota-${process.pid}-${fixtureId}`,
        evidence: {
          quota: {
            codex: {
              supported: true,
              source: 'codex',
              sampled_at: now - 1000,
              primary: null,
              secondary: null,
            },
          },
        },
      },
    ];
    let api;

    try {
      Date.now = () => now - 1000;
      for (const item of cases) {
        db.upsertAgent({ name: item.name, online: true });
        db.upsertAgentHealth(item.name, {
          disk: { pct: 10, status: 'ok' },
          memory: { pct: 20, status: 'ok' },
          runtime: {
            type: 'codex',
            status: 'offline',
            source: 'codex profile',
            detection_source: 'profile',
            checked_at: now - 1000,
          },
          ...item.evidence,
        });
      }

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());

      for (const item of cases) {
        const detail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(item.name)}`).then(response => response.json());
        const collectionAgent = collection.agents.find(agent => agent.name === item.name);
        for (const agent of [collectionAgent, detail.agent]) {
          expect(agent.runtime_status).toBe('offline');
          expect(agent.runtime.status).toBe('offline');
        }
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('does not trust the agent_health transport label as quota, Token, or cost evidence', async () => {
    const realNow = Date.now;
    const now = 1_800_000_345_000;
    const name = `team-untrusted-transport-source-${process.pid}-${realNow()}`;
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
        runtime: {
          type: 'codex',
          status: 'offline',
          source: 'codex profile',
          detection_source: 'profile',
          checked_at: now - 1000,
        },
        quota: {
          supported: true,
          source: 'agent_health',
          sampled_at: now - 1000,
          primary: { label: '5h', window_minutes: 300, used_percent: 12 },
        },
        usage: {
          supported: true,
          source: 'agent_health',
          sampled_at: now - 1000,
          session_tokens: { total: 1234 },
          partial: false,
          session_cost_usd: 1.23,
          cost_source: 'agent_health',
          cost_sampled_at: now - 1000,
          estimated_cost: false,
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const detail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const agent of [collectionAgent, detail.agent]) {
        expect(agent.runtime_status).toBe('offline');
        expect(agent.runtime.status).toBe('offline');
        expect(agent.quota).toMatchObject({
          supported: false,
          source: null,
          reason: 'invalid_value',
          primary: null,
          secondary: null,
        });
        expect(agent.usage).toMatchObject({
          supported: false,
          source: null,
          reason: 'invalid_value',
          session_tokens: null,
          last_turn_tokens: null,
          session_cost_usd: null,
          cost_source: null,
        });
        expect(agent.observability.quota.five_hour.availability).toBe('unavailable');
        expect(agent.observability.session_tokens.availability).toBe('unavailable');
        expect(agent.observability.cost.availability).toBe('unavailable');
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('does not expose stale model, context, or display-only activity evidence through either team interface', async () => {
    const realNow = Date.now;
    const now = 1_800_000_350_000;
    const staleAt = now - 10 * 60 * 1000 - 1;
    const name = `team-stale-fields-${process.pid}-${realNow()}`;
    const marker = 'synthetic-team-stale-field-marker';
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
        runtime: {
          type: 'codex',
          status: 'running',
          source: 'codex version',
          detection_source: 'process',
          checked_at: now - 1000,
        },
        usage: {
          codex: {
            supported: true,
            source: 'codex',
            sampled_at: now - 1000,
            partial: false,
            session_tokens: { total: 123 },
            model: marker,
            model_source: 'codex',
            model_sampled_at: staleAt,
          },
        },
        roster: {
          context_used_pct: 42,
          sampled_at: staleAt,
        },
        activity_monitor: {
          state: 'idle',
          health: 'ok',
          source: 'activity_monitor_fallback',
          observed_at: staleAt,
          used_for_routing: false,
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const detail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const agent of [collectionAgent, detail.agent]) {
        expect(agent.observability.model).toMatchObject({
          availability: 'unavailable',
          value: null,
          source: null,
          sampled_at: null,
          unavailable_reason: 'stale_sample',
        });
        expect(agent.observability.context).toMatchObject({
          availability: 'unavailable',
          used_percent: null,
          remaining_percent: null,
          source: null,
          sampled_at: null,
          unavailable_reason: 'stale_sample',
        });
        expect(agent.observability.activity).toMatchObject({
          availability: 'unavailable',
          state: null,
          health: null,
          source: null,
          sampled_at: null,
          used_for_routing: false,
          unavailable_reason: 'stale_sample',
        });
        expect(JSON.stringify(agent)).not.toContain(marker);
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('keeps fresh legacy reports with incomplete required metrics unknown through both team interfaces', async () => {
    const realNow = Date.now;
    const now = 1_800_000_375_000;
    const name = `team-incomplete-required-metrics-${process.pid}-${realNow()}`;
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: {},
        memory: {},
        runtime: {
          type: 'codex',
          status: 'running',
          source: 'codex version',
          detection_source: 'process',
          checked_at: now - 1000,
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const detail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const agent of [collectionAgent, detail.agent]) {
        expect(agent.runtime).toMatchObject({
          stale: false,
          system_health: 'unknown',
        });
        expect(agent.hardware).toMatchObject({
          disk_pct: null,
          disk_status: 'unknown',
          disk_unavailable_reason: 'invalid_value',
          mem_pct: null,
          mem_status: 'unknown',
          mem_unavailable_reason: 'invalid_value',
          system_health: 'unknown',
          stale: false,
        });
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('fails hardware metrics closed when the central report time is missing, stale, or future', async () => {
    const realNow = Date.now;
    const now = 1_800_000_390_000;
    const cases = [
      {
        name: `team-missing-hardware-time-${process.pid}-${realNow()}`,
        reportedAt: null,
        checkedAt: now - 1000,
        unavailableReason: 'sample_time_unavailable',
      },
      {
        name: `team-stale-hardware-time-${process.pid}-${realNow()}`,
        reportedAt: now - 10 * 60 * 1000 - 1,
        checkedAt: now - 10 * 60 * 1000 - 1,
        unavailableReason: 'stale_sample',
      },
      {
        name: `team-future-hardware-time-${process.pid}-${realNow()}`,
        reportedAt: now + 60 * 1000,
        checkedAt: now + 60 * 1000,
        unavailableReason: 'stale_sample',
      },
    ];
    let api;

    try {
      for (const item of cases) {
        db.upsertAgent({ name: item.name, online: true });
        Date.now = () => item.reportedAt ?? now - 1000;
        db.upsertAgentHealth(item.name, {
          disk: { pct: 10, status: 'ok' },
          memory: { pct: 20, status: 'ok' },
          cpu: { pct: 30 },
          pm2: { online: 2, total: 2 },
          runtime: {
            type: 'codex',
            status: 'running',
            source: 'codex version',
            detection_source: 'process',
            checked_at: item.checkedAt,
          },
        });
        if (item.reportedAt == null) delete db.getAgentHealth(item.name).reported_at;
      }

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());

      for (const item of cases) {
        const detail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(item.name)}`).then(response => response.json());
        const collectionAgent = collection.agents.find(agent => agent.name === item.name);
        for (const agent of [collectionAgent, detail.agent]) {
          expect(agent.runtime).toMatchObject({ stale: true, system_health: 'unknown' });
          expect(agent.hardware).toMatchObject({
            disk_pct: null,
            disk_status: 'unknown',
            disk_unavailable_reason: item.unavailableReason,
            mem_pct: null,
            mem_status: 'unknown',
            mem_unavailable_reason: item.unavailableReason,
            cpu_pct: null,
            pm2_online: null,
            pm2_total: null,
            system_health: 'unknown',
            stale: true,
          });
        }
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('keeps nested context and activity unavailable when the parent report is stale', async () => {
    const realNow = Date.now;
    const now = 1_800_000_375_000;
    const staleAt = now - 10 * 60 * 1000 - 1;
    const name = `team-stale-parent-observability-${process.pid}-${realNow()}`;
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => staleAt;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
        runtime: {
          type: 'codex',
          status: 'running',
          source: 'codex version',
          detection_source: 'process',
          checked_at: now,
        },
        roster: {
          context_used_pct: 42,
          context_used_tokens: 4_200,
          context_total_tokens: 10_000,
          plan_type: 'synthetic-plan',
          sampled_at: now,
        },
        activity_monitor: {
          state: 'idle',
          health: 'ok',
          observed_at: now,
          source: 'activity_monitor_fallback',
          used_for_routing: false,
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const detail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const agent of [collectionAgent, detail.agent]) {
        expect(agent.runtime).toMatchObject({ stale: true, system_health: 'unknown' });
        expect(agent.observability.context).toEqual({
          availability: 'unavailable',
          used_percent: null,
          remaining_percent: null,
          total_tokens: null,
          plan_type: null,
          source: null,
          sampled_at: null,
          unavailable_reason: 'stale_sample',
        });
        expect(agent.observability.activity).toEqual({
          availability: 'unavailable',
          state: null,
          health: null,
          source: null,
          sampled_at: null,
          used_for_routing: false,
          unavailable_reason: 'stale_sample',
        });
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('does not expose a quota sampled more than ten minutes ago through either team interface', async () => {
    const realNow = Date.now;
    const now = 1_800_000_400_000;
    const staleAt = now - 10 * 60 * 1000 - 1;
    const name = `team-stale-quota-${process.pid}-${realNow()}`;
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
        runtime: {
          type: 'codex',
          status: 'running',
          source: 'codex version',
          detection_source: 'process',
          checked_at: now - 1000,
        },
        quota: {
          codex: {
            supported: true,
            source: 'codex',
            sampled_at: staleAt,
            primary: { label: '5h', window_minutes: 300, used_percent: 95 },
            secondary: { label: '7d', window_minutes: 10_080, used_percent: 40 },
          },
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const detail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const agent of [collectionAgent, detail.agent]) {
        expect(agent.runtime.stale).toBe(false);
        expect(agent.quota).toMatchObject({
          supported: false,
          reason: 'stale_sample',
          sampled_at: null,
          primary: null,
          secondary: null,
        });
        expect(agent.observability.quota).toMatchObject({
          sampled_at: null,
          five_hour: {
            availability: 'unavailable',
            used_percent: null,
            unavailable_reason: 'stale_sample',
          },
          seven_day: {
            availability: 'unavailable',
            used_percent: null,
            unavailable_reason: 'stale_sample',
          },
        });
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });
});
