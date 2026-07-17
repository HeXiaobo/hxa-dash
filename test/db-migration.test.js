import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { initializeHealthSchema } = require('../src/health-schema.js');

describe('health database additive migration', () => {
  it('adds Dashboard state storage without changing legacy health data or rollback reads', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE agent_health (
        name TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        reported_at INTEGER NOT NULL
      );
      CREATE TABLE agent_health_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    database.prepare('INSERT INTO agent_health (name, data, reported_at) VALUES (?, ?, ?)')
      .run('legacy-agent', '{"status":"ok"}', 123);

    initializeHealthSchema(database);

    expect(database.prepare('SELECT * FROM agent_health WHERE name = ?').get('legacy-agent')).toEqual({
      name: 'legacy-agent',
      data: '{"status":"ok"}',
      reported_at: 123,
    });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_dashboard_state'").get())
      .toEqual({ name: 'agent_dashboard_state' });

    database.prepare(`
      INSERT INTO agent_dashboard_state (name, data, observed_at, received_at)
      VALUES (?, ?, ?, ?)
    `).run('legacy-agent', '{"status":"fresh"}', 120, 123);

    // The rollback version only reads legacy tables; the additive table can
    // remain without changing its query result.
    expect(database.prepare('SELECT data, reported_at FROM agent_health WHERE name = ?').get('legacy-agent'))
      .toEqual({ data: '{"status":"ok"}', reported_at: 123 });
    expect(() => initializeHealthSchema(database)).not.toThrow();
    database.close();
  });
});
