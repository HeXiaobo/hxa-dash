import { describe, it, expect, beforeEach } from 'vitest';

// Test the logic of /api/my/:name directly by importing db and the route logic
// We test the db query functions that the route relies on

// Reset module state between tests by re-requiring
let db;

beforeEach(async () => {
  // Fresh module state for each test
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  // Clear module cache to get fresh store
  delete require.cache[require.resolve('../src/db.js')];
  db = require('../src/db.js');
});

describe('GET /api/my/:name — data logic', () => {
  it('returns todos: only open issues assigned to the agent', () => {
    db.upsertAgent({ name: 'lova', role: 'backend', online: true });
    db.upsertTask({ id: 'i1', state: 'opened', assignee: 'lova', type: 'issue', title: 'Task A', url: '/issues/1', project: 'hxa-link', created_at: 1000, updated_at: Date.now() });
    db.upsertTask({ id: 'i2', state: 'opened', assignee: 'lova', type: 'mr', title: 'MR A', url: '/mrs/1', project: 'hxa-link', created_at: 1000, updated_at: Date.now() });
    db.upsertTask({ id: 'i3', state: 'closed', assignee: 'lova', type: 'issue', title: 'Done', url: '/issues/2', project: 'hxa-link', created_at: 1000, updated_at: Date.now() });
    db.upsertTask({ id: 'i4', state: 'opened', assignee: 'boot', type: 'issue', title: 'Boot task', url: '/issues/3', project: 'hxa-link', created_at: 1000, updated_at: Date.now() });

    const all = db.getAllTasks();
    const todos = all.filter(t => t.assignee === 'lova' && t.state === 'opened' && t.type === 'issue');
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe('i1');
  });

  it('returns pending_reviews: only open MRs where agent is reviewer', () => {
    db.upsertAgent({ name: 'lova', role: 'backend', online: true });
    db.upsertTask({ id: 'm1', state: 'opened', assignee: 'boot', reviewer: 'lova', type: 'mr', title: 'MR for review', url: '/mrs/2', project: 'hxa-link', created_at: 1000, updated_at: Date.now() });
    db.upsertTask({ id: 'm2', state: 'merged', assignee: 'boot', reviewer: 'lova', type: 'mr', title: 'Merged MR', url: '/mrs/3', project: 'hxa-link', created_at: 1000, updated_at: Date.now() });
    db.upsertTask({ id: 'm3', state: 'opened', assignee: 'boot', reviewer: 'vila', type: 'mr', title: 'Other MR', url: '/mrs/4', project: 'hxa-link', created_at: 1000, updated_at: Date.now() });

    const all = db.getAllTasks();
    const pending = all.filter(t =>
      t.state === 'opened' && t.type === 'mr' &&
      t.reviewer && t.reviewer.split(',').map(r => r.trim()).includes('lova')
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('m1');
  });

  it('returns active_projects from open assigned tasks only', () => {
    db.upsertAgent({ name: 'lova', role: 'backend', online: true });
    db.upsertTask({ id: 'p1', state: 'opened', assignee: 'lova', type: 'issue', project: 'hxa-link', created_at: 1000, updated_at: Date.now() });
    db.upsertTask({ id: 'p2', state: 'opened', assignee: 'lova', type: 'issue', project: 'hxa-dash', created_at: 1000, updated_at: Date.now() });
    db.upsertTask({ id: 'p3', state: 'closed', assignee: 'lova', type: 'issue', project: 'old-project', created_at: 1000, updated_at: Date.now() });

    const all = db.getAllTasks();
    const active_projects = [...new Set(
      all.filter(t => t.assignee === 'lova' && t.state === 'opened' && t.project).map(t => t.project)
    )].sort();
    expect(active_projects).toEqual(['hxa-dash', 'hxa-link']);
  });

  it('returns blockers: stale open tasks in active projects not assigned to the agent', () => {
    const staleTime = Date.now() - 72 * 60 * 60 * 1000; // 72h ago
    db.upsertAgent({ name: 'lova', role: 'backend', online: true });
    db.upsertTask({ id: 'a1', state: 'opened', assignee: 'lova', type: 'issue', project: 'hxa-link', created_at: 1000, updated_at: Date.now() });
    // stale task in same project, not assigned to lova
    db.upsertTask({ id: 'b1', state: 'opened', assignee: 'boot', type: 'issue', title: 'Stale', url: '/i/5', project: 'hxa-link', created_at: 1000, updated_at: staleTime });
    // fresh task (not a blocker)
    db.upsertTask({ id: 'b2', state: 'opened', assignee: 'boot', type: 'issue', title: 'Fresh', url: '/i/6', project: 'hxa-link', created_at: 1000, updated_at: Date.now() });
    // stale but in different project
    db.upsertTask({ id: 'b3', state: 'opened', assignee: 'boot', type: 'issue', title: 'Other', url: '/i/7', project: 'other', created_at: 1000, updated_at: staleTime });

    const all = db.getAllTasks();
    const active_projects = new Set(['hxa-link']);
    const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;
    const now = Date.now();
    const blockers = all.filter(t =>
      t.state === 'opened' &&
      t.project && active_projects.has(t.project) &&
      t.assignee !== 'lova' &&
      (now - t.updated_at) >= STALE_THRESHOLD_MS
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0].id).toBe('b1');
  });

  it('returns 404 for unknown agent', () => {
    const agent = db.getAgent('nonexistent');
    expect(agent).toBeNull();
  });
});
