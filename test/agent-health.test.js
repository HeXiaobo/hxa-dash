// Agent Health API tests (#115)
import { describe, it, expect } from 'vitest';

const express = require('express');
const db = require('../src/db');
const agentHealthRoute = require('../src/routes/agent-health');
const teamRoute = require('../src/routes/team');
const { sanitizeRuntime } = agentHealthRoute.__private;

async function startApi() {
  const app = express();
  app.use(express.json());
  app.use('/api/agent-health', agentHealthRoute);
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

describe('Agent Health Store (#115)', () => {
  it('suppresses stale backup proof from both public health reads', async () => {
    const realNow = Date.now;
    const now = 1_800_000_000_000;
    const name = `stale-backup-read-${process.pid}-${realNow()}`;
    const staleAt = now - 10 * 60 * 1000 - 1;
    const marker = 'synthetic-stale-private-marker';
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => staleAt;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
        backup: {
          supported: true,
          status: 'ok',
          sampled_at: staleAt,
          cron: {
            supported: true,
            status: 'ok',
            log_path: `/synthetic/${marker}/backup.log`,
            last_success_at: staleAt - 1000,
          },
          repos: [{
            path: `/synthetic/${marker}/repo`,
            remote: `https://github.com/synthetic/${marker}.git`,
            ahead: 0,
            behind: 0,
            dirty: 0,
            untracked: 0,
          }],
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const body of [collectionAgent, single]) {
        expect(body).toMatchObject({
          stale: true,
          health: {
            backup: {
              supported: false,
              status: 'unsupported',
              reason: 'stale_sample',
              sampled_at: null,
              cron: null,
              repos: [],
            },
          },
        });
        expect(JSON.stringify(body)).not.toContain(marker);
      }
      expect(collectionAgent.backup).toEqual(collectionAgent.health.backup);
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('suppresses required hardware evidence when the central report time is stale or future', async () => {
    const realNow = Date.now;
    const now = 1_800_000_050_000;
    const fixtureId = realNow();
    const marker = 'synthetic-stale-hardware-marker';
    const cases = [
      {
        name: `stale-hardware-read-${process.pid}-${fixtureId}`,
        reportedAt: now - 10 * 60 * 1000 - 1,
      },
      {
        name: `future-hardware-read-${process.pid}-${fixtureId}`,
        reportedAt: now + 5_001,
      },
    ];
    let api;

    try {
      for (const item of cases) {
        db.upsertAgent({ name: item.name, online: true });
        Date.now = () => item.reportedAt;
        db.upsertAgentHealth(item.name, {
          disk: {
            pct: 10,
            used: `${marker}-disk-used`,
            total: `${marker}-disk-total`,
            status: 'ok',
          },
          memory: {
            pct: 20,
            used_gb: 2,
            total_gb: 10,
            status: 'ok',
          },
        });
      }

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());

      for (const item of cases) {
        const collectionAgent = collection.agents.find(agent => agent.name === item.name);
        const single = await fetch(`${api.baseUrl}/api/agent-health/${item.name}`).then(response => response.json());
        expect(collectionAgent.overall).toBe('unknown');
        for (const body of [collectionAgent, single]) {
          expect(body.stale).toBe(true);
          expect(body.health.disk).toMatchObject({
            pct: null,
            status: 'unknown',
            used: null,
            total: null,
            reason: 'stale_sample',
          });
          expect(body.health.memory).toMatchObject({
            pct: null,
            status: 'unknown',
            used_gb: null,
            total_gb: null,
            reason: 'stale_sample',
          });
          expect(JSON.stringify(body)).not.toContain(marker);
        }
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('suppresses backup proof when its source time is missing', async () => {
    const realNow = Date.now;
    const now = 1_800_000_100_000;
    const name = `missing-backup-time-${process.pid}-${realNow()}`;
    const marker = 'synthetic-missing-time-marker';
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
        backup: {
          supported: true,
          status: 'ok',
          sampled_at: null,
          cron: { supported: true, status: 'ok', log_path: `/synthetic/${marker}/backup.log` },
          repos: [{ path: `/synthetic/${marker}/repo`, remote: `https://github.com/synthetic/${marker}.git` }],
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const body of [collectionAgent, single]) {
        expect(body.health.backup).toMatchObject({
          supported: false,
          reason: 'sample_time_unavailable',
          sampled_at: null,
          cron: null,
          repos: [],
        });
        expect(JSON.stringify(body)).not.toContain(marker);
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('suppresses backup proof when the stored central report time is missing', async () => {
    const realNow = Date.now;
    const now = 1_800_000_150_000;
    const name = `missing-report-time-${process.pid}-${realNow()}`;
    const marker = 'synthetic-missing-report-marker';
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
        backup: {
          supported: true,
          status: 'ok',
          sampled_at: now - 1000,
          cron: { supported: true, status: 'ok', log_path: `/synthetic/${marker}/backup.log` },
          repos: [{ path: `/synthetic/${marker}/repo`, remote: `https://github.com/synthetic/${marker}.git` }],
        },
      });
      delete db.getAgentHealth(name).reported_at;

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const body of [collectionAgent, single]) {
        expect(body.stale).toBe(true);
        expect(body.health.backup).toMatchObject({
          supported: false,
          reason: 'sample_time_unavailable',
          cron: null,
          repos: [],
        });
        expect(JSON.stringify(body)).not.toContain(marker);
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('suppresses stale source proof even when the central report is fresh', async () => {
    const realNow = Date.now;
    const now = 1_800_000_175_000;
    const name = `stale-source-time-${process.pid}-${realNow()}`;
    const marker = 'synthetic-stale-source-marker';
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
        backup: {
          supported: true,
          status: 'ok',
          sampled_at: now - 10 * 60 * 1000 - 1,
          cron: { supported: true, status: 'ok', log_path: `/synthetic/${marker}/backup.log` },
          repos: [{ path: `/synthetic/${marker}/repo`, remote: `https://github.com/synthetic/${marker}.git` }],
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const body of [collectionAgent, single]) {
        expect(body.stale).toBe(false);
        expect(body.health.backup).toMatchObject({
          supported: false,
          reason: 'stale_sample',
          cron: null,
          repos: [],
        });
        expect(JSON.stringify(body)).not.toContain(marker);
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('suppresses stale usage and cost proof even when the central report is fresh', async () => {
    const realNow = Date.now;
    const now = 1_800_000_190_000;
    const name = `stale-usage-time-${process.pid}-${realNow()}`;
    const staleAt = now - 10 * 60 * 1000 - 1;
    const marker = 'synthetic-stale-usage-private-marker';
    let api;

    try {
      db.upsertAgent({ name, online: true });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10, status: 'ok' },
        memory: { pct: 20, status: 'ok' },
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
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const body of [collectionAgent, single]) {
        expect(body.stale).toBe(false);
        expect(body.health.usage.codex).toMatchObject({
          supported: false,
          reason: 'stale_sample',
          sampled_at: null,
          session_tokens: null,
          last_turn_tokens: null,
          session_cost_usd: null,
          cost_sampled_at: null,
        });
        expect(JSON.stringify(body)).not.toContain(marker);
      }
      expect(collectionAgent.usage).toEqual(collectionAgent.health.usage);
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('suppresses stale quota proof from both public health reads', async () => {
    const realNow = Date.now;
    const now = 1_800_000_275_000;
    const staleAt = now - 10 * 60 * 1000 - 1;
    const name = `stale-quota-${process.pid}-${realNow()}`;
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
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      for (const body of [collectionAgent, single]) {
        expect(body.health.quota.codex).toMatchObject({
          supported: false,
          reason: 'stale_sample',
          sampled_at: null,
          primary: null,
          secondary: null,
        });
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('suppresses backup proof when the report or source clock is more than five seconds ahead', async () => {
    const realNow = Date.now;
    const now = 1_800_000_200_000;
    const marker = 'synthetic-future-time-marker';
    const cases = [
      { name: `future-report-${process.pid}-${realNow()}`, reportedAt: now + 5001, sampledAt: now - 1000, stale: true },
      { name: `future-source-${process.pid}-${realNow()}`, reportedAt: now - 1000, sampledAt: now + 5001, stale: false },
    ];
    let api;

    try {
      for (const item of cases) {
        db.upsertAgent({ name: item.name, online: true });
        Date.now = () => item.reportedAt;
        db.upsertAgentHealth(item.name, {
          disk: { pct: 10, status: 'ok' },
          memory: { pct: 20, status: 'ok' },
          backup: {
            supported: true,
            status: 'ok',
            sampled_at: item.sampledAt,
            cron: { supported: true, status: 'ok', log_path: `/synthetic/${marker}/backup.log` },
            repos: [{ path: `/synthetic/${marker}/repo`, remote: `https://github.com/synthetic/${marker}.git` }],
          },
        });
      }

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());

      for (const item of cases) {
        const collectionAgent = collection.agents.find(agent => agent.name === item.name);
        const single = await fetch(`${api.baseUrl}/api/agent-health/${item.name}`).then(response => response.json());
        for (const body of [collectionAgent, single]) {
          expect(body.stale).toBe(item.stale);
          expect(body.health.backup).toMatchObject({
            supported: false,
            reason: 'stale_sample',
            sampled_at: null,
            cron: null,
            repos: [],
          });
          expect(JSON.stringify(body)).not.toContain(marker);
        }
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('preserves only an explicit runtime source time instead of substituting collector time', () => {
    expect(sanitizeRuntime({
      type: 'codex',
      status: 'running',
      version: '9.9.9-fixture',
    })).toMatchObject({ checked_at: null });

    expect(sanitizeRuntime({
      type: 'codex',
      status: 'running',
      checked_at: 1_700_000_000_000,
    })).toMatchObject({ checked_at: 1_700_000_000_000 });
  });

  it('suppresses stale runtime, roster, and display-only activity proof from every public health read', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const realNow = Date.now;
    const now = 1_800_000_410_000;
    const staleAt = now - 10 * 60 * 1000 - 1;
    const name = `stale-public-health-fields-${process.pid}-${realNow()}`;
    const marker = 'synthetic-stale-public-health-marker';
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: now - 1000 });
      Date.now = () => now;
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          disk: { pct: 10 },
          memory: { pct: 20 },
          runtime: {
            type: 'codex',
            version: marker,
            status: 'running',
            source: 'codex version',
            detection_source: 'process',
            checked_at: staleAt,
          },
          roster: {
            session_id: marker,
            model: marker,
            context_used_pct: 42,
            context_used_tokens: 42_000,
            context_total_tokens: 100_000,
            plan_type: marker,
            sampled_at: staleAt,
          },
          activity_monitor: {
            state: 'busy',
            health: 'ok',
            source: 'activity_monitor_fallback',
            observed_at: staleAt,
            used_for_routing: false,
          },
        }),
      });
      expect(posted.status).toBe(200);

      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const roster = await fetch(`${api.baseUrl}/api/agent-health/roster`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);
      const rosterAgent = roster.agents.find(agent => agent.name === name);

      for (const health of [collectionAgent.health, single.health]) {
        expect(health.runtime).toMatchObject({
          type: null,
          version: null,
          status: null,
          source: null,
          detection_source: null,
          checked_at: null,
          reason: 'stale_sample',
        });
        expect(health.roster).toMatchObject({
          context_used_pct: null,
          context_used_tokens: null,
          context_total_tokens: null,
          sampled_at: null,
          reason: 'stale_sample',
        });
        expect(health.activity_monitor).toMatchObject({
          state: null,
          health: null,
          source: null,
          observed_at: null,
          used_for_routing: false,
          reason: 'stale_sample',
        });
        expect(JSON.stringify(health)).not.toContain(marker);
      }
      expect(collectionAgent.runtime).toEqual(collectionAgent.health.runtime);
      expect(rosterAgent).toMatchObject({
        stale: false,
        runtime_type: null,
        runtime_version: null,
        runtime_status: null,
        roster: {
          context_used_pct: null,
          sampled_at: null,
          reason: 'stale_sample',
        },
      });
      expect(JSON.stringify(rosterAgent)).not.toContain(marker);
    } finally {
      Date.now = realNow;
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('allowlists roster fields on authenticated POST and every public health read', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const realNow = Date.now;
    const now = 1_800_000_420_000;
    const name = `roster-allowlist-${process.pid}-${realNow()}`;
    const marker = 'SYNTHETIC_ROSTER_SECRET';
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: now - 1000 });
      Date.now = () => now;
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          disk: { pct: 10 },
          memory: { pct: 20 },
          roster: {
            session_id: 'synthetic-session',
            model: 'synthetic-model',
            model_display: 'Synthetic Model',
            version: '9.9.9-fixture',
            runtime_type: 'codex',
            cost_usd: 1.23,
            lines_added: 12,
            lines_removed: 3,
            context_used_pct: 25,
            context_used_tokens: 25_000,
            context_total_tokens: 100_000,
            rate_limits: {
              five_hour: { used_pct: 12, resets_at: now + 60_000, api_key: marker },
              seven_day: { used_pct: 34, resets_at: now + 120_000, secret: marker },
              arbitrary_window: { api_key: marker },
            },
            plan_type: 'synthetic-plan',
            sampled_at: now - 1000,
            api_key: marker,
            arbitrary: { secret: marker },
          },
        }),
      });
      expect(posted.status).toBe(200);

      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const roster = await fetch(`${api.baseUrl}/api/agent-health/roster`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);
      const rosterAgent = roster.agents.find(agent => agent.name === name);
      const expectedRoster = {
        session_id: 'synthetic-session',
        model: 'synthetic-model',
        model_display: 'Synthetic Model',
        version: '9.9.9-fixture',
        runtime_type: 'codex',
        cost_usd: 1.23,
        lines_added: 12,
        lines_removed: 3,
        context_used_pct: 25,
        context_used_tokens: 25_000,
        context_total_tokens: 100_000,
        rate_limits: {
          five_hour: { used_pct: 12, resets_at: now + 60_000 },
          seven_day: { used_pct: 34, resets_at: now + 120_000 },
        },
        plan_type: 'synthetic-plan',
        sampled_at: now - 1000,
        reason: null,
      };

      expect(collectionAgent.health.roster).toEqual(expectedRoster);
      expect(single.health.roster).toEqual(expectedRoster);
      expect(rosterAgent.roster).toEqual(expectedRoster);
      for (const body of [collectionAgent, single, rosterAgent]) {
        expect(JSON.stringify(body)).not.toContain(marker);
      }
    } finally {
      Date.now = realNow;
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('defensively normalizes legacy roster rows before every public health read', async () => {
    const realNow = Date.now;
    const now = 1_800_000_425_000;
    const name = `legacy-roster-allowlist-${process.pid}-${realNow()}`;
    const marker = 'SYNTHETIC_LEGACY_ROSTER_SECRET';
    let api;

    try {
      db.upsertAgent({ name, online: true, last_seen_at: now - 1000 });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10 },
        memory: { pct: 20 },
        roster: {
          context_used_pct: 25,
          sampled_at: now - 1000,
          api_key: marker,
          rate_limits: {
            five_hour: { used_pct: 12, api_key: marker },
            arbitrary_window: { secret: marker },
          },
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const roster = await fetch(`${api.baseUrl}/api/agent-health/roster`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);
      const rosterAgent = roster.agents.find(agent => agent.name === name);

      for (const value of [collectionAgent.health.roster, single.health.roster, rosterAgent.roster]) {
        expect(value).toMatchObject({
          context_used_pct: 25,
          rate_limits: {
            five_hour: { used_pct: 12 },
            seven_day: null,
          },
          sampled_at: now - 1000,
          reason: null,
        });
        expect(JSON.stringify(value)).not.toContain(marker);
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('rejects missing required metric percentages without creating healthy evidence', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const name = `missing-required-metrics-${process.pid}-${Date.now()}`;
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: Date.now() });
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({ disk: {}, memory: {} }),
      });
      expect(posted.status).toBe(400);

      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      expect(collection.agents.find(agent => agent.name === name)).toMatchObject({
        overall: 'unknown',
        health: null,
      });
      expect(single.health).toBeNull();
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('keeps invalid optional hardware and PM2 evidence unavailable after authenticated POST', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const name = `invalid-optional-hardware-${process.pid}-${Date.now()}`;
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: Date.now() });
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          disk: { pct: 10 },
          memory: { pct: 20, used_gb: -4, total_gb: 100_000 },
          cpu: { pct: -1, load_avg: [-1, 0.5, 10_000], cores: 1.5 },
          pm2: {
            online: 1_000,
            total: 1_000,
            services: [{
              name: 'synthetic-service',
              status: 'online',
              memory: -1,
              cpu: 101,
            }],
          },
        }),
      });
      expect(posted.status).toBe(200);

      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      expect(collectionAgent.overall).toBe('unknown');
      for (const health of [collectionAgent.health, single.health]) {
        expect(health.memory).toMatchObject({
          pct: 20,
          used_gb: null,
          total_gb: null,
          capacity_reason: 'invalid_value',
        });
        expect(health.cpu).toEqual({
          pct: null,
          load_avg: null,
          cores: null,
          reason: 'invalid_value',
        });
        expect(health.pm2).toMatchObject({
          online: null,
          total: null,
          reason: 'invalid_value',
          services: [{
            name: 'synthetic-service',
            status: 'online',
            memory: null,
            cpu: null,
          }],
        });
      }
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('keeps wrong-type optional evidence invalid across health and team reads', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const name = `wrong-type-optional-hardware-${process.pid}-${Date.now()}`;
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: Date.now() });
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          disk: { pct: 10 },
          memory: { pct: 20, used_gb: 'invalid-capacity', total_gb: 8 },
          cpu: 'invalid-cpu',
          pm2: false,
        }),
      });
      expect(posted.status).toBe(200);

      const healthCollection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const healthSingle = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const teamCollection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const teamDetail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionHealth = healthCollection.agents.find(agent => agent.name === name);
      const collectionTeam = teamCollection.agents.find(agent => agent.name === name);

      expect(collectionHealth.overall).toBe('unknown');
      for (const health of [collectionHealth.health, healthSingle.health]) {
        expect(health.memory).toMatchObject({
          pct: 20,
          used_gb: null,
          total_gb: null,
          capacity_reason: 'invalid_value',
        });
        expect(health.cpu).toEqual({
          pct: null,
          load_avg: null,
          cores: null,
          reason: 'invalid_value',
        });
        expect(health.pm2).toEqual({
          online: null,
          total: null,
          services: [],
          reason: 'invalid_value',
        });
      }

      for (const agent of [collectionTeam, teamDetail.agent]) {
        expect(agent.runtime.system_health).toBe('unknown');
        expect(agent.hardware).toMatchObject({
          mem_pct: 20,
          cpu_pct: null,
          pm2_online: null,
          pm2_total: null,
          system_health: 'unknown',
        });
      }
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('keeps an explicitly reported empty CPU sample unavailable across health and team reads', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const name = `empty-cpu-sample-${process.pid}-${Date.now()}`;
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: Date.now() });
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          disk: { pct: 10 },
          memory: { pct: 20 },
          cpu: {},
        }),
      });
      expect(posted.status).toBe(200);

      const healthCollection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const healthSingle = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const teamCollection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const teamDetail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionHealth = healthCollection.agents.find(agent => agent.name === name);
      const collectionTeam = teamCollection.agents.find(agent => agent.name === name);

      expect(collectionHealth.overall).toBe('unknown');
      for (const health of [collectionHealth.health, healthSingle.health]) {
        expect(health.cpu).toEqual({
          pct: null,
          load_avg: null,
          cores: null,
          reason: 'invalid_value',
        });
      }
      for (const agent of [collectionTeam, teamDetail.agent]) {
        expect(agent.runtime.system_health).toBe('unknown');
        expect(agent.hardware).toMatchObject({
          cpu_pct: null,
          system_health: 'unknown',
        });
      }
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('preserves an explicit CPU collection failure across health and team reads', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const name = `failed-cpu-collection-${process.pid}-${Date.now()}`;
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: Date.now() });
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          disk: { pct: 10 },
          memory: { pct: 20 },
          cpu: { reason: 'collection_failed' },
        }),
      });
      expect(posted.status).toBe(200);

      const healthCollection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const healthSingle = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const teamCollection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const teamDetail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionHealth = healthCollection.agents.find(agent => agent.name === name);
      const collectionTeam = teamCollection.agents.find(agent => agent.name === name);

      expect(collectionHealth.overall).toBe('unknown');
      for (const health of [collectionHealth.health, healthSingle.health]) {
        expect(health.cpu).toEqual({
          pct: null,
          load_avg: null,
          cores: null,
          reason: 'collection_failed',
        });
      }
      for (const agent of [collectionTeam, teamDetail.agent]) {
        expect(agent.runtime.system_health).toBe('unknown');
        expect(agent.hardware).toMatchObject({
          cpu_pct: null,
          system_health: 'unknown',
        });
      }
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('preserves an explicit PM2 collection failure across health and team reads', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const name = `failed-pm2-collection-${process.pid}-${Date.now()}`;
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: Date.now() });
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          disk: { pct: 10 },
          memory: { pct: 20 },
          pm2: {
            online: 1,
            total: 1,
            services: [],
            reason: 'collection_failed',
          },
        }),
      });
      expect(posted.status).toBe(200);

      const healthCollection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const healthSingle = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const teamCollection = await fetch(`${api.baseUrl}/api/team`).then(response => response.json());
      const teamDetail = await fetch(`${api.baseUrl}/api/team/${encodeURIComponent(name)}`).then(response => response.json());
      const collectionHealth = healthCollection.agents.find(agent => agent.name === name);
      const collectionTeam = teamCollection.agents.find(agent => agent.name === name);

      expect(collectionHealth.overall).toBe('unknown');
      for (const health of [collectionHealth.health, healthSingle.health]) {
        expect(health.pm2).toEqual({
          online: null,
          total: null,
          services: [],
          reason: 'collection_failed',
        });
      }
      for (const agent of [collectionTeam, teamDetail.agent]) {
        expect(agent.runtime.system_health).toBe('unknown');
        expect(agent.hardware).toMatchObject({
          pm2_online: null,
          pm2_total: null,
          system_health: 'unknown',
        });
      }
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('fails invalid PM2 count invariants closed on public POST-to-GET reads', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const nonce = `${process.pid}-${Date.now()}`;
    const cases = [
      { suffix: 'fractional', online: 1.5, total: 2 },
      { suffix: 'unsafe', online: 1, total: Number.MAX_SAFE_INTEGER + 1 },
      { suffix: 'negative', online: -1, total: 2 },
      { suffix: 'out-of-range', online: 1, total: 1_000 },
      { suffix: 'online-over-total', online: 2, total: 1 },
    ];
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      for (const item of cases) {
        item.name = `invalid-pm2-${item.suffix}-${nonce}`;
        db.upsertAgent({ name: item.name, online: true, last_seen_at: Date.now() });
      }
      api = await startApi();

      for (const item of cases) {
        const posted = await fetch(`${api.baseUrl}/api/agent-health/${item.name}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': process.env.HEALTH_API_KEY,
          },
          body: JSON.stringify({
            disk: { pct: 10 },
            memory: { pct: 20 },
            pm2: { online: item.online, total: item.total, services: [] },
          }),
        });
        expect(posted.status).toBe(200);
      }

      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      for (const item of cases) {
        const collectionAgent = collection.agents.find(agent => agent.name === item.name);
        const single = await fetch(`${api.baseUrl}/api/agent-health/${item.name}`).then(response => response.json());
        expect(collectionAgent.overall).toBe('unknown');
        for (const health of [collectionAgent.health, single.health]) {
          expect(health.pm2).toEqual({
            online: null,
            total: null,
            services: [],
            reason: 'invalid_value',
          });
        }
      }
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('preserves valid optional hardware and PM2 evidence on public reads', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const name = `valid-optional-hardware-${process.pid}-${Date.now()}`;
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: Date.now() });
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          disk: { pct: 10 },
          memory: { pct: 20, used_gb: 3.25, total_gb: 8.75 },
          cpu: { pct: 30.25, load_avg: [0.12, 0.34, 0.56], cores: 8 },
          pm2: {
            online: 2,
            total: 3,
            services: [{
              name: 'synthetic-service',
              status: 'online',
              memory: 1_048_576,
              cpu: 0.25,
            }],
          },
        }),
      });
      expect(posted.status).toBe(200);

      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      expect(collectionAgent.overall).toBe('warning');
      for (const health of [collectionAgent.health, single.health]) {
        expect(health.memory).toMatchObject({
          pct: 20,
          used_gb: 3.3,
          total_gb: 8.8,
          capacity_reason: null,
        });
        expect(health.cpu).toEqual({
          pct: 30.3,
          load_avg: [0.1, 0.3, 0.6],
          cores: 8,
          reason: null,
        });
        expect(health.pm2).toEqual({
          online: 2,
          total: 3,
          reason: null,
          services: [{
            name: 'synthetic-service',
            status: 'online',
            memory: 1_048_576,
            cpu: 0.3,
            reason: null,
          }],
        });
      }
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('keeps an oversized CPU load sample unavailable instead of truncating it', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const name = `oversized-cpu-load-${process.pid}-${Date.now()}`;
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: Date.now() });
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          disk: { pct: 10 },
          memory: { pct: 20 },
          cpu: { pct: 30, load_avg: [0.1, 0.2, 0.3, 0.4], cores: 4 },
        }),
      });
      expect(posted.status).toBe(200);

      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      expect(collectionAgent.overall).toBe('unknown');
      for (const health of [collectionAgent.health, single.health]) {
        expect(health.cpu).toEqual({
          pct: 30,
          load_avg: null,
          cores: 4,
          reason: 'invalid_value',
        });
      }
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('sanitizes invalid optional hardware and PM2 fields in legacy stored rows', async () => {
    const realNow = Date.now;
    const now = 1_800_000_430_000;
    const name = `legacy-invalid-optional-hardware-${process.pid}-${realNow()}`;
    let api;

    try {
      db.upsertAgent({ name, online: true, last_seen_at: now - 1000 });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, {
        disk: { pct: 10 },
        memory: { pct: 20, used_gb: 9, total_gb: 8 },
        cpu: { pct: 101, load_avg: [0.1, -1, 0.2], cores: 4.5 },
        pm2: {
          online: 3,
          total: 2,
          services: [{
            name: 'legacy-synthetic-service',
            status: 'online',
            memory: -1,
            cpu: 101,
          }],
        },
      });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      const collectionAgent = collection.agents.find(agent => agent.name === name);

      expect(collectionAgent.overall).toBe('unknown');
      for (const health of [collectionAgent.health, single.health]) {
        expect(health.memory).toMatchObject({
          pct: 20,
          used_gb: null,
          total_gb: null,
          capacity_reason: 'invalid_value',
        });
        expect(health.cpu).toEqual({
          pct: null,
          load_avg: null,
          cores: null,
          reason: 'invalid_value',
        });
        expect(health.pm2).toMatchObject({
          online: null,
          total: null,
          reason: 'invalid_value',
          services: [{
            name: 'legacy-synthetic-service',
            status: 'online',
            memory: null,
            cpu: null,
            reason: 'invalid_value',
          }],
        });
      }
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('rejects out-of-range required metric percentages without creating healthy evidence', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const nonce = `${process.pid}-${Date.now()}`;
    const cases = [
      {
        name: `negative-required-metric-${nonce}`,
        disk: { pct: -1 },
        memory: { pct: 20 },
      },
      {
        name: `oversized-required-metric-${nonce}`,
        disk: { pct: 10 },
        memory: { pct: 101 },
      },
    ];
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      for (const item of cases) {
        db.upsertAgent({ name: item.name, online: true, last_seen_at: Date.now() });
      }
      api = await startApi();

      for (const item of cases) {
        const posted = await fetch(`${api.baseUrl}/api/agent-health/${item.name}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': process.env.HEALTH_API_KEY,
          },
          body: JSON.stringify({ disk: item.disk, memory: item.memory }),
        });
        expect(posted.status).toBe(400);
      }

      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      for (const item of cases) {
        const single = await fetch(`${api.baseUrl}/api/agent-health/${item.name}`).then(response => response.json());
        expect(collection.agents.find(agent => agent.name === item.name)).toMatchObject({
          overall: 'unknown',
          health: null,
        });
        expect(single.health).toBeNull();
      }
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('keeps legacy null required metrics unknown on collection read', async () => {
    const realNow = Date.now;
    const now = 1_800_000_425_000;
    const name = `legacy-null-required-metrics-${process.pid}-${realNow()}`;
    let api;

    try {
      db.upsertAgent({ name, online: true, last_seen_at: now - 1000 });
      Date.now = () => now - 1000;
      db.upsertAgentHealth(name, { disk: {}, memory: {} });

      Date.now = () => now;
      api = await startApi();
      const collection = await fetch(`${api.baseUrl}/api/agent-health`).then(response => response.json());
      expect(collection.agents.find(agent => agent.name === name)).toMatchObject({
        overall: 'unknown',
        stale: false,
        health: {
          disk: { pct: null, status: 'unknown' },
          memory: { pct: null, status: 'unknown' },
        },
      });
    } finally {
      Date.now = realNow;
      if (api) await api.close();
    }
  });

  it('rejects encoded arbitrary-delimiter credential markers through POST and readback', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    const name = `credential-remote-${process.pid}-${Date.now()}`;
    const marker = 'SYNTHETIC_CREDENTIAL';
    let api;

    try {
      process.env.HEALTH_API_KEY = 'synthetic-health-key';
      db.upsertAgent({ name, online: true, last_seen_at: Date.now() });
      api = await startApi();

      const posted = await fetch(`${api.baseUrl}/api/agent-health/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          disk: { pct: 10 },
          memory: { pct: 20 },
          backup: {
            supported: true,
            status: 'ok',
            sampled_at: Date.now(),
            repos: [
              {
                path: '/synthetic/repo',
                remote: `https://github.com/acme/token%7C${marker}/repo.git`,
                ahead: 0,
                behind: 0,
                dirty: 0,
                untracked: 0,
                status: 'ok',
              },
              {
                path: '/synthetic/tokenizer',
                remote: 'https://github.com/acme/tokenizer.git',
                ahead: 0,
                behind: 0,
                dirty: 0,
                untracked: 0,
                status: 'ok',
              },
              {
                path: '/synthetic/my-token-repo',
                remote: 'https://github.com/acme/my-token-repo.git',
                ahead: 0,
                behind: 0,
                dirty: 0,
                untracked: 0,
                status: 'ok',
              },
            ],
          },
        }),
      });
      expect(posted.status).toBe(200);

      const single = await fetch(`${api.baseUrl}/api/agent-health/${name}`).then(response => response.json());
      expect(single.health.backup.repos[0].remote).toBeNull();
      expect(single.health.backup.repos[1].remote).toBe('https://github.com/acme/tokenizer.git');
      expect(single.health.backup.repos[2].remote).toBe('https://github.com/acme/my-token-repo.git');
      expect(JSON.stringify(single)).not.toContain(marker);
    } finally {
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      if (api) await api.close();
    }
  });

  it('stores and retrieves agent health data', () => {
    db.upsertAgent({ name: 'test-agent', online: true, last_seen_at: Date.now() });

    const health = {
      hostname: 'test-host',
      disk: { pct: 75, used: '15G', total: '20G', status: 'ok' },
      memory: { pct: 60, used_gb: 3, total_gb: 5, status: 'ok' },
      cpu: { pct: 30, load_avg: [0.5, 0.3, 0.2], cores: 4 },
      pm2: { online: 3, total: 3, services: [] },
    };

    db.upsertAgentHealth('test-agent', health);
    const stored = db.getAgentHealth('test-agent');

    expect(stored).toBeTruthy();
    expect(stored.disk.pct).toBe(75);
    expect(stored.memory.pct).toBe(60);
    expect(stored.hostname).toBe('test-host');
    expect(stored.reported_at).toBeTruthy();
    expect(stored.reported_at).toBeLessThanOrEqual(Date.now());
  });

  it('returns null for unknown agent', () => {
    expect(db.getAgentHealth('nonexistent')).toBeNull();
  });

  it('getAllAgentHealth returns all stored health', () => {
    db.upsertAgent({ name: 'agent-a', online: true });
    db.upsertAgent({ name: 'agent-b', online: true });

    db.upsertAgentHealth('agent-a', {
      disk: { pct: 50, status: 'ok' },
      memory: { pct: 40, status: 'ok' },
    });
    db.upsertAgentHealth('agent-b', {
      disk: { pct: 95, status: 'critical' },
      memory: { pct: 85, status: 'warning' },
    });

    const all = db.getAllAgentHealth();
    expect(all['agent-a']).toBeTruthy();
    expect(all['agent-b']).toBeTruthy();
    expect(all['agent-b'].disk.pct).toBe(95);
  });

  it('overwrites previous health data on update', () => {
    db.upsertAgent({ name: 'test-agent', online: true });

    db.upsertAgentHealth('test-agent', {
      disk: { pct: 50, status: 'ok' },
      memory: { pct: 40, status: 'ok' },
    });
    db.upsertAgentHealth('test-agent', {
      disk: { pct: 92, status: 'critical' },
      memory: { pct: 88, status: 'warning' },
    });

    const stored = db.getAgentHealth('test-agent');
    expect(stored.disk.pct).toBe(92);
    expect(stored.memory.pct).toBe(88);
  });
});
