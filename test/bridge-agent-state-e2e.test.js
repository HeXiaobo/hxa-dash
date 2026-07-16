import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import agentStateRoutes from '../src/routes/agent-state.js';

const require = createRequire(import.meta.url);
const express = require('express');

async function startCentral(routes) {
  const app = express();
  app.use(express.json());
  app.use('/api/agent-state', routes);
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

async function postBridgeContractSnapshot({
  centralBaseUrl,
  centralIngestKey,
  agentName,
  snapshot,
}) {
  const response = await fetch(`${centralBaseUrl}/api/agent-state/${encodeURIComponent(agentName)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${centralIngestKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ agent_name: agentName, ...snapshot }),
  });
  if (!response.ok) throw new Error(`central_http_${response.status}`);
  return {
    ok: true,
    agent_name: agentName,
    source: snapshot.source,
    status: snapshot.status,
    observed_at: snapshot.observed_at,
  };
}

describe('Dashboard bridge to central agent-state contract', () => {
  it('moves a minimized authenticated bridge snapshot across the real central HTTP and router seams', async () => {
    const now = Date.parse('2026-07-16T02:00:05.000Z');
    const agentName = 'yueran';
    const ingestKey = 'fake-yueran-ingest-key';
    let stored = null;
    const stateDb = {
      getAgent: () => null,
      upsertAgentDashboardState(name, state, observedAt, receivedAt) {
        stored = { name, ...state, observed_at: observedAt, received_at: receivedAt };
      },
      getAgentDashboardState: name => (stored?.name === name ? stored : null),
      getAllAgentDashboardStates: () => (stored ? [stored] : []),
    };
    const entityStore = {
      get: name => (name === agentName ? { name } : null),
    };
    process.env.DASHBOARD_STATE_INGEST_KEYS_JSON = JSON.stringify({
      [agentName]: ingestKey,
    });

    const routes = agentStateRoutes.createAgentStateRouter({
      stateDb,
      entityStore,
      now: () => now,
    });
    const central = await startCentral(routes);

    try {
      const pushed = await postBridgeContractSnapshot({
        centralBaseUrl: central.baseUrl,
        centralIngestKey: ingestKey,
        agentName,
        snapshot: {
          source: 'dashboard_api',
          status: 'fresh',
          used_for_routing: true,
          observed_at: '2026-07-16T02:00:00.000Z',
          freshness_ms: 5_000,
          degraded: false,
          payload: {
            schema_version: 1,
            dashboard: { version: '0.5.3' },
            agent: {
              name: agentName,
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
            capacity: { context_pct: 41, rate_limit_pct: 22, rate_limit_7d_pct: 33 },
            system: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 },
            last_prompt: { summary: 'private prompt must not cross the seam' },
            running_tools: [{ detail: 'private tool data must not cross the seam' }],
          },
        },
      });
      expect(pushed).toMatchObject({
        ok: true,
        agent_name: agentName,
        source: 'dashboard_api',
        status: 'fresh',
      });

      const response = await fetch(`${central.baseUrl}/api/agent-state/${agentName}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.state).toMatchObject({
        source: 'dashboard_api',
        status: 'fresh',
        used_for_routing: true,
        freshness_ms: 5_000,
        payload: {
          agent: { name: agentName, state: 'BUSY', confidence: 'HIGH' },
          runtime: { type: 'codex', model: 'gpt-5', effort: 'high' },
        },
      });
      expect(JSON.stringify(body)).not.toMatch(/private prompt|private tool|zylos_(?:ak|st)_/i);
    } finally {
      delete process.env.DASHBOARD_STATE_INGEST_KEYS_JSON;
      await central.close();
    }
  });
});
