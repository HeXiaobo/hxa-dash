import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const db = require('../src/db');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const persistentFiles = ['health.db', 'health.db-wal', 'health.db-shm']
  .map(name => path.join(root, name));

function snapshotPersistentFiles() {
  return persistentFiles.map(file => {
    if (!existsSync(file)) return null;
    const stat = statSync(file);
    return {
      path: file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    };
  });
}

describe('test database isolation', () => {
  it('keeps health writes out of the persistent worktree database', () => {
    expect(process.env.NODE_ENV).toBe('test');
    const before = snapshotPersistentFiles();
    const name = `db-isolation-${process.pid}-${Date.now()}`;

    db.upsertAgentHealth(name, {
      disk: { pct: 10, status: 'ok' },
      memory: { pct: 20, status: 'ok' },
    });

    expect(db.getAgentHealth(name)).toMatchObject({
      disk: { pct: 10, status: 'ok' },
      memory: { pct: 20, status: 'ok' },
    });
    expect(snapshotPersistentFiles()).toEqual(before);
  });
});
