// Agent Health API tests (#115)
import { describe, it, expect, beforeEach } from 'vitest';

let db;

beforeEach(async () => {
  // Fresh module — vitest handles module cache
  db = await import('../src/db.js').then(m => m.default || m);
});

describe('Agent Health Store (#115)', () => {
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
