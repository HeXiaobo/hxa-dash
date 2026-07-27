import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../src/db.js');
const agentHealthRoutes = require('../src/routes/agent-health.js');

async function startApi() {
  const app = express();
  app.use(express.json());
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

describe('Agent health canonical name interface (#37)', () => {
  it('stores a lowercase Max report under the registered canonical name', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    process.env.HEALTH_API_KEY = 'agent-health-case-test-key';
    db.upsertAgent({ name: 'Max', online: true });
    const api = await startApi();

    try {
      const response = await fetch(`${api.baseUrl}/api/agent-health/max`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          hostname: 'max-case-host',
          disk: { pct: 41, used: '41G', total: '100G' },
          memory: { pct: 37, used_gb: 3.7, total_gb: 10 },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(db.getAgentHealth('Max')).toMatchObject({
        hostname: 'max-case-host',
        disk: { pct: 41 },
        memory: { pct: 37 },
      });
      expect(db.getAgentHealth('max')).toBeNull();
    } finally {
      db.removeAgent('Max');
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      await api.close();
    }
  });

  it('reads the same canonical Max health through either request spelling', async () => {
    const previousKey = process.env.HEALTH_API_KEY;
    process.env.HEALTH_API_KEY = 'agent-health-case-test-key';
    db.upsertAgent({ name: 'Max', online: true });
    const api = await startApi();

    try {
      const post = await fetch(`${api.baseUrl}/api/agent-health/Max`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.HEALTH_API_KEY,
        },
        body: JSON.stringify({
          hostname: 'max-case-read-host',
          disk: { pct: 29, used: '29G', total: '100G' },
          memory: { pct: 31, used_gb: 3.1, total_gb: 10 },
        }),
      });
      expect(post.status).toBe(200);

      const exactResponse = await fetch(`${api.baseUrl}/api/agent-health/Max`);
      const lowercaseResponse = await fetch(`${api.baseUrl}/api/agent-health/max`);
      expect(exactResponse.status).toBe(200);
      expect(lowercaseResponse.status).toBe(200);

      const exactBody = await exactResponse.json();
      const lowercaseBody = await lowercaseResponse.json();
      expect(exactBody).toMatchObject({
        name: 'Max',
        health: {
          hostname: 'max-case-read-host',
          disk: { pct: 29 },
          memory: { pct: 31 },
        },
      });
      expect(lowercaseBody).toMatchObject({
        name: 'Max',
        stale: exactBody.stale,
        health: exactBody.health,
      });
    } finally {
      db.removeAgent('Max');
      if (previousKey === undefined) delete process.env.HEALTH_API_KEY;
      else process.env.HEALTH_API_KEY = previousKey;
      await api.close();
    }
  });
});
