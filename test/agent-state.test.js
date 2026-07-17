import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import agentStateRoutes from '../src/routes/agent-state.js';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../src/db.js');
const entity = require('../src/entity.js');
const agentHealthRoutes = require('../src/routes/agent-health.js');

async function startApi(stateRoutes = agentStateRoutes) {
  const app = express();
  app.use(express.json());
  app.use('/api/agent-state', stateRoutes);
  app.use('/api/agent-health', agentHealthRoutes);
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

function freshSnapshot(name, overrides = {}) {
  return {
    agent_name: name,
    source: 'dashboard_api',
    status: 'fresh',
    used_for_routing: true,
    observed_at: new Date(Date.now() - 1000).toISOString(),
    freshness_ms: 1000,
    degraded: false,
    payload: {
      schema_version: 1,
      dashboard: { version: '0.5.3' },
      agent: {
        name,
        state: 'IDLE',
        confidence: 'MEDIUM',
        reason: 'No active task',
        active_subagent_count: 0,
      },
      runtime: {},
      capacity: {},
      system: {},
    },
    ...overrides,
  };
}

function clearIngestKeys() {
  delete process.env.DASHBOARD_STATE_INGEST_API_KEY;
  delete process.env.DASHBOARD_STATE_INGEST_AGENT_NAME;
  delete process.env.DASHBOARD_STATE_INGEST_KEYS_JSON;
}

function configureIngestKey(name, key) {
  clearIngestKeys();
  process.env.DASHBOARD_STATE_INGEST_KEYS_JSON = JSON.stringify({ [name]: key });
}

function configureIngestKeys(keys) {
  clearIngestKeys();
  process.env.DASHBOARD_STATE_INGEST_KEYS_JSON = JSON.stringify(keys);
}

describe('Agent state HTTP interface', () => {
  it('fails closed when the dedicated ingest key is absent or incorrect', async () => {
    const name = 'dashboard-state-auth';
    clearIngestKeys();
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const unconfigured = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(unconfigured.status).toBe(403);
      expect(await unconfigured.json()).toEqual({ error: 'dashboard_state_ingest_not_configured' });

      configureIngestKey(name, 'right-key');
      const unauthorized = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('requires the route, body, payload, and canonical roster identity to agree', async () => {
    const name = 'dashboard-state-identity';
    const key = 'dashboard-state-identity-key';
    configureIngestKeys({ [name]: key, 'not-canonical': key });
    entity.register(name, { connect: name });
    const api = await startApi();
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

    try {
      const wrongEnvelope = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(freshSnapshot(name, { agent_name: 'another-agent' })),
      });
      expect(wrongEnvelope.status).toBe(400);

      const wrongPayload = freshSnapshot(name);
      wrongPayload.payload.agent.name = 'another-agent';
      const mismatchedPayload = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(wrongPayload),
      });
      expect(mismatchedPayload.status).toBe(400);

      const unknown = await fetch(`${api.baseUrl}/api/agent-state/not-canonical`, {
        method: 'POST',
        headers,
        body: JSON.stringify(freshSnapshot('not-canonical')),
      });
      expect(unknown.status).toBe(404);

      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      const body = await get.json();
      expect(body.state).toBeNull();
      expect(body.stale).toBe(true);
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('rejects a case-variant identity even when its URL, key binding, envelope, and payload agree', async () => {
    const canonicalName = `dashboard-state-case-${process.pid}-${Date.now()}`;
    const caseVariant = canonicalName.toUpperCase();
    const key = 'dashboard-state-case-variant-key';
    configureIngestKeys({ [caseVariant]: key });
    entity.register(canonicalName, { connect: canonicalName });
    db.upsertAgent({ name: canonicalName, online: true });
    const api = await startApi();

    try {
      const response = await fetch(`${api.baseUrl}/api/agent-state/${caseVariant}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(freshSnapshot(caseVariant)),
      });
      expect(response.status).toBe(404);

      const canonical = await fetch(`${api.baseUrl}/api/agent-state/${canonicalName}`);
      expect((await canonical.json()).state).toBeNull();
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('binds each ingest key to one canonical agent identity', async () => {
    const agentA = `dashboard-state-key-a-${process.pid}-${Date.now()}`;
    const agentB = `dashboard-state-key-b-${process.pid}-${Date.now()}`;
    const keyA = 'dashboard-state-agent-a-key';
    const keyB = 'dashboard-state-agent-b-key';
    configureIngestKeys({
      [agentA]: keyA,
      [agentB]: keyB,
    });
    entity.register(agentA, { connect: agentA });
    entity.register(agentB, { connect: agentB });
    const api = await startApi();

    try {
      const impersonation = await fetch(`${api.baseUrl}/api/agent-state/${agentB}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${keyA}`, 'content-type': 'application/json' },
        body: JSON.stringify(freshSnapshot(agentB)),
      });
      expect(impersonation.status).toBe(401);

      const ownIdentity = await fetch(`${api.baseUrl}/api/agent-state/${agentB}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${keyB}`, 'content-type': 'application/json' },
        body: JSON.stringify(freshSnapshot(agentB)),
      });
      expect(ownIdentity.status).toBe(200);
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('uses central time and rejects a materially inconsistent freshness claim', async () => {
    const name = `dashboard-state-freshness-claim-${process.pid}-${Date.now()}`;
    const key = 'dashboard-state-freshness-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const payload = freshSnapshot(name, {
        observed_at: new Date(Date.now() - 20_000).toISOString(),
        freshness_ms: 0,
      });
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(post.status).toBe(400);

      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      expect((await get.json()).state).toBeNull();
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('does not let an older observation overwrite a newer stored state', async () => {
    const name = `dashboard-state-ordering-${process.pid}-${Date.now()}`;
    const key = 'dashboard-state-ordering-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    const newerObservedAt = new Date(Date.now() - 1_000).toISOString();
    const olderObservedAt = new Date(Date.now() - 10_000).toISOString();

    try {
      const newer = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(freshSnapshot(name, {
          observed_at: newerObservedAt,
          freshness_ms: 1_000,
        })),
      });
      expect(newer.status).toBe(200);

      const delayedOlder = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(freshSnapshot(name, {
          observed_at: olderObservedAt,
          freshness_ms: 10_000,
        })),
      });
      expect(delayedOlder.status).toBe(200);

      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      const body = await get.json();
      expect(body.state.observed_at).toBe(newerObservedAt);
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('visibly ages a once-fresh snapshot out of routing eligibility', async () => {
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    const name = `dashboard-state-central-stale-${process.pid}-${clock}`;
    const key = 'dashboard-state-central-stale-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(freshSnapshot(name, {
          observed_at: new Date(clock - 1000).toISOString(),
          freshness_ms: 1000,
        })),
      });
      expect(post.status).toBe(200);

      clock += 31_000;
      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      const body = await get.json();
      expect(body.state).toMatchObject({
        status: 'stale',
        used_for_routing: false,
        stale: true,
        degraded: true,
        degraded_reason: 'central_state_stale',
      });
      expect(body.state.freshness_ms).toBe(32_000);
    } finally {
      Date.now = realNow;
      clearIngestKeys();
      await api.close();
    }
  });

  it('keeps Dashboard state storage separate from legacy agent health', async () => {
    const name = `dashboard-state-isolation-${process.pid}-${Date.now()}`;
    const key = 'dashboard-state-isolation-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    db.upsertAgent({ name, online: true });
    db.upsertAgentHealth(name, {
      hostname: 'legacy-health-host',
      disk: { pct: 73, status: 'ok' },
      memory: { pct: 61, status: 'ok' },
    });
    const api = await startApi();

    try {
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(freshSnapshot(name)),
      });
      expect(post.status).toBe(200);

      const legacy = await fetch(`${api.baseUrl}/api/agent-health/${name}`);
      const legacyBody = await legacy.json();
      expect(legacyBody.health).toMatchObject({
        hostname: 'legacy-health-host',
        disk: { pct: 73 },
        memory: { pct: 61 },
      });
      expect(legacyBody.health).not.toHaveProperty('source');

      const state = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      expect((await state.json()).state.source).toBe('dashboard_api');
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('rejects a stale label when both source and central clocks say fresh', async () => {
    const name = `dashboard-state-false-stale-${process.pid}-${Date.now()}`;
    const key = 'dashboard-state-false-stale-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const payload = freshSnapshot(name, {
        status: 'stale',
        used_for_routing: false,
        degraded: true,
        degraded_reason: 'dashboard_state_stale',
      });
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(post.status).toBe(400);
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('returns a structured server error when state persistence fails', async () => {
    const name = `dashboard-state-store-failure-${process.pid}-${Date.now()}`;
    const key = 'dashboard-state-store-failure-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const failingDb = {
      ...db,
      upsertAgentDashboardState() {
        throw new Error('simulated write failure');
      },
    };
    const routes = agentStateRoutes.createAgentStateRouter({ stateDb: failingDb, entityStore: entity });
    const api = await startApi(routes);

    try {
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(freshSnapshot(name)),
      });
      expect(post.status).toBe(500);
      expect(post.headers.get('content-type')).toContain('application/json');
      expect(await post.json()).toEqual({ error: 'agent_state_store_failed' });
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('rejects an authenticated Dashboard payload with invalid state enums', async () => {
    const name = `dashboard-state-invalid-enum-${process.pid}-${Date.now()}`;
    const key = 'dashboard-state-invalid-enum-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const payload = freshSnapshot(name);
      payload.payload.agent.state = 'PRIVATE PROMPT CONTENT';
      payload.payload.agent.confidence = 'VERY_SURE';
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(post.status).toBe(400);
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('drops secret-like values even when they occupy allowed string fields', async () => {
    const name = `dashboard-state-secret-slot-${process.pid}-${Date.now()}`;
    const key = 'dashboard-state-secret-slot-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const payload = freshSnapshot(name);
      payload.payload.dashboard.version = 'AKIAIOSFODNN7EXAMPLE';
      payload.payload.runtime.type = 'AKIAIOSFODNN7EXAMPLE';
      payload.payload.runtime.model = 'AKIAIOSFODNN7EXAMPLE';
      payload.payload.runtime.effort = 'AKIAIOSFODNN7EXAMPLE';
      payload.payload.runtime.version = '0123456789abcdef0123456789abcdef0123456789abcdef';
      payload.payload.agent.reason = 'private customer prompt';
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(post.status).toBe(200);

      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      const body = await get.json();
      expect(body.state.payload.dashboard.version).toBeNull();
      expect(body.state.payload.runtime.type).toBeNull();
      expect(body.state.payload.runtime.model).toBeNull();
      expect(body.state.payload.runtime.effort).toBeNull();
      expect(body.state.payload.runtime.version).toBeNull();
      expect(body.state.payload.agent.reason).toBeNull();
      expect(JSON.stringify(body)).not.toMatch(/AKIAIOSFODNN7EXAMPLE|0123456789abcdef|private customer/i);
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('accepts an authenticated fresh snapshot without granting node-controlled routing eligibility', async () => {
    const name = 'dashboard-state-tracer';
    const key = 'dashboard-state-test-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    db.upsertAgent({ name, online: true });
    const api = await startApi();
    const observedAt = new Date(Date.now() - 1000).toISOString();

    try {
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          agent_name: name,
          source: 'dashboard_api',
          status: 'fresh',
          used_for_routing: true,
          observed_at: observedAt,
          freshness_ms: 1000,
          degraded: false,
          payload: {
            schema_version: 1,
            dashboard: { version: '0.5.3' },
            agent: {
              name,
              state: 'BUSY',
              confidence: 'HIGH',
              reason: 'Executing exec_command (5s)',
              active_subagent_count: 1,
            },
            runtime: {
              type: 'codex',
              model: 'gpt-5',
              effort: 'high',
              version: '1.0.0',
              pending_restart: false,
            },
            capacity: {
              context_pct: 41,
              rate_limit_pct: 22,
              rate_limit_7d_pct: 33,
            },
            system: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 },
          },
        }),
      });

      const postBody = await post.json();
      expect(post.status, JSON.stringify(postBody)).toBe(200);
      expect(postBody).toEqual({ ok: true });

      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      expect(get.status).toBe(200);
      const body = await get.json();
      expect(body.name).toBe(name);
      expect(body.state).toMatchObject({
        source: 'dashboard_api',
        status: 'fresh',
        used_for_routing: false,
        stale: false,
        degraded: false,
        payload: {
          agent: { name, state: 'BUSY', confidence: 'HIGH' },
        },
      });
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('returns canonical collection records in deterministic order with the single-record shape', async () => {
    const readAt = Date.parse('2026-07-16T02:00:00.000Z');
    const makeStored = (name, source, observedOffsetMs) => ({
      name,
      source,
      status: source === 'dashboard_api' ? 'fresh' : 'degraded',
      used_for_routing: source === 'dashboard_api',
      observed_at: readAt - observedOffsetMs,
      received_at: readAt - 500,
      degraded: source !== 'dashboard_api',
      ...(source === 'dashboard_api' ? {} : { degraded_reason: 'read_key_missing' }),
      payload: source === 'dashboard_api'
        ? { schema_version: 1, agent: { name } }
        : { schema_version: 1, dashboard: { ok: true, service: 'zylos-dashboard' } },
    });
    const stateDb = {
      getAgent: () => null,
      getAllAgentDashboardStates: () => [
        makeStored('zeta', 'dashboard_api', 1_000),
        makeStored('orphan', 'dashboard_api', 1_000),
        makeStored('alpha', 'dashboard_health', 2_000),
      ],
    };
    const entityStore = {
      get: name => (name === 'alpha' || name === 'zeta' ? { name } : null),
    };
    const routes = agentStateRoutes.createAgentStateRouter({
      stateDb,
      entityStore,
      now: () => readAt,
    });
    const api = await startApi(routes);

    try {
      const response = await fetch(`${api.baseUrl}/api/agent-state`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.timestamp).toBe('2026-07-16T02:00:00.000Z');
      expect(body.states.map(record => record.name)).toEqual(['alpha', 'zeta']);
      expect(body.states.every(record => Object.keys(record).sort().join(',') === 'name,state')).toBe(true);
      expect(body.states[0].state).toMatchObject({
        source: 'dashboard_health',
        used_for_routing: false,
        freshness_ms: 2_000,
      });
      expect(body.states[1].state).toMatchObject({
        source: 'dashboard_api',
        used_for_routing: false,
        freshness_ms: 1_000,
      });
    } finally {
      await api.close();
    }
  });

  it('returns structured JSON when the collection store cannot be read', async () => {
    const routes = agentStateRoutes.createAgentStateRouter({
      stateDb: {
        getAllAgentDashboardStates() {
          throw new Error('simulated read failure');
        },
      },
      entityStore: { get: () => null },
    });
    const api = await startApi(routes);

    try {
      const response = await fetch(`${api.baseUrl}/api/agent-state`);
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ error: 'agent_state_read_failed' });
    } finally {
      await api.close();
    }
  });

  it('keeps the full allowlist and drops private or secret fields', async () => {
    const name = 'dashboard-state-allowlist';
    const key = 'dashboard-state-allowlist-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_name: name,
          source: 'dashboard_api',
          status: 'fresh',
          used_for_routing: true,
          observed_at: new Date(Date.now() - 1000).toISOString(),
          freshness_ms: 0,
          degraded: false,
          api_key: 'central-secret-must-not-store',
          last_prompt: 'private prompt must not store',
          payload: {
            schema_version: 1,
            dashboard: { version: '0.5.3', raw_telemetry: 'private raw telemetry' },
            agent: {
              name,
              state: 'BUSY',
              confidence: 'HIGH',
              reason: 'Executing exec_command (5s)',
              active_subagent_count: 2,
              last_message: 'private message must not store',
            },
            runtime: {
              type: 'codex',
              model: 'gpt-5',
              effort: 'high',
              version: '1.0.0',
              pending_restart: false,
              session_token: 'zylos_st_must_not_store',
            },
            capacity: { context_pct: 41, rate_limit_pct: 22, rate_limit_7d_pct: 33 },
            system: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 },
            running_tools: [{ detail: 'private tool detail' }],
          },
        }),
      });
      expect(post.status).toBe(200);

      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      const body = await get.json();
      expect(body.state.payload).toEqual({
        schema_version: 1,
        dashboard: { version: '0.5.3' },
        agent: {
          name,
          state: 'BUSY',
          confidence: 'HIGH',
          reason: 'Executing exec_command (5s)',
          active_subagent_count: 2,
        },
        runtime: {
          type: 'codex',
          model: 'gpt-5',
          effort: 'high',
          version: '1.0.0',
          pending_restart: false,
        },
        capacity: { context_pct: 41, rate_limit_pct: 22, rate_limit_7d_pct: 33 },
        system: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 },
      });
      expect(JSON.stringify(body)).not.toMatch(/secret|private|zylos_st_/i);
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('stores health-only visibility as degraded and never routing-capable', async () => {
    const name = 'dashboard-state-health-only';
    const key = 'dashboard-state-health-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_name: name,
          source: 'dashboard_health',
          status: 'degraded',
          used_for_routing: false,
          observed_at: new Date().toISOString(),
          freshness_ms: 0,
          degraded: true,
          degraded_reason: 'read_key_missing',
          payload: {
            schema_version: 1,
            dashboard: {
              ok: true,
              service: 'zylos-dashboard',
              uptime_seconds: 321,
              event_loop: { private_detail: 'must not store' },
            },
          },
        }),
      });
      expect(post.status).toBe(200);

      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      const body = await get.json();
      expect(body.state).toMatchObject({
        source: 'dashboard_health',
        status: 'degraded',
        used_for_routing: false,
        stale: false,
        degraded: true,
        degraded_reason: 'read_key_missing',
        payload: {
          schema_version: 1,
          dashboard: { ok: true, service: 'zylos-dashboard', uptime_seconds: 321 },
        },
      });
      expect(JSON.stringify(body)).not.toContain('private_detail');
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('preserves the fixed invalid-timestamp degradation reason from the adapter', async () => {
    const name = `dashboard-state-invalid-timestamp-${process.pid}-${Date.now()}`;
    const key = 'dashboard-state-invalid-timestamp-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_name: name,
          source: 'dashboard_health',
          status: 'degraded',
          used_for_routing: false,
          observed_at: new Date().toISOString(),
          freshness_ms: 0,
          degraded: true,
          degraded_reason: 'state_timestamp_invalid',
          payload: {
            schema_version: 1,
            dashboard: { ok: true, service: 'zylos-dashboard', uptime_seconds: 1 },
          },
        }),
      });
      expect(post.status).toBe(200);

      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      expect((await get.json()).state.degraded_reason).toBe('state_timestamp_invalid');
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('stores an unavailable observation without inventing freshness', async () => {
    const name = 'dashboard-state-unavailable';
    const key = 'dashboard-state-unavailable-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_name: name,
          source: 'none',
          status: 'unavailable',
          used_for_routing: false,
          observed_at: null,
          freshness_ms: null,
          degraded: true,
          degraded_reason: 'dashboard_unreachable',
          payload: null,
        }),
      });
      expect(post.status).toBe(200);

      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      const body = await get.json();
      expect(body.state).toMatchObject({
        source: 'none',
        status: 'unavailable',
        used_for_routing: false,
        observed_at: null,
        freshness_ms: null,
        stale: true,
        degraded: true,
        degraded_reason: 'dashboard_unreachable',
        payload: null,
      });
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });

  it('accepts an explicitly stale Dashboard snapshot only for visibility', async () => {
    const name = 'dashboard-state-source-stale';
    const key = 'dashboard-state-stale-key';
    configureIngestKey(name, key);
    entity.register(name, { connect: name });
    const api = await startApi();

    try {
      const post = await fetch(`${api.baseUrl}/api/agent-state/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_name: name,
          source: 'dashboard_api',
          status: 'stale',
          used_for_routing: false,
          observed_at: new Date(Date.now() - 31_000).toISOString(),
          freshness_ms: 31_000,
          degraded: true,
          degraded_reason: 'dashboard_state_stale',
          payload: {
            schema_version: 1,
            dashboard: { version: '0.5.3' },
            agent: {
              name,
              state: 'IDLE',
              confidence: 'MEDIUM',
              reason: 'No active task',
              active_subagent_count: 0,
            },
            runtime: {},
            capacity: {},
            system: {},
          },
        }),
      });
      expect(post.status).toBe(200);

      const get = await fetch(`${api.baseUrl}/api/agent-state/${name}`);
      const body = await get.json();
      expect(body.state).toMatchObject({
        source: 'dashboard_api',
        status: 'stale',
        used_for_routing: false,
        stale: true,
        degraded: true,
        degraded_reason: 'dashboard_state_stale',
      });
    } finally {
      clearIngestKeys();
      await api.close();
    }
  });
});
