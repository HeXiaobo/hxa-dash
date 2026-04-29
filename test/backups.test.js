import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const backupRoute = require('../src/routes/backups');
const agentHealthRoute = require('../src/routes/agent-health');

const { buildBackupSummary, buildBackupsPayload } = backupRoute.__private;
const { sanitizeBackup } = agentHealthRoute.__private;

describe('backup health helpers', () => {
  it('redacts credential-bearing remote urls during health sanitization', () => {
    const backup = sanitizeBackup({
      supported: true,
      status: 'ok',
      sampled_at: new Date().toISOString(),
      repos: [{
        path: '/Users/example/repo',
        remote: 'https://ghp_secret123@github.com/example/repo.git',
        branch: 'main',
        head: 'abc123',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        dirty: 0,
        untracked: 0,
        status: 'ok',
      }],
    });

    expect(backup.repos[0].remote).toBe('https://github.com/example/repo.git');
    expect(backup.repos[0].remote).not.toContain('ghp_secret123');
  });

  it('summarizes repo backup status by GitHub remote and worktree state', () => {
    const summary = buildBackupSummary({
      supported: true,
      repos: [
        { remote: 'https://github.com/acme/clean.git', ahead: 0, behind: 0, dirty: 0, untracked: 0 },
        { remote: 'git@github.com:acme/ahead.git', ahead: 2, behind: 0, dirty: 0, untracked: 0 },
        { remote: 'https://gitlab.example/acme/mirror.git', ahead: 0, behind: 0, dirty: 0, untracked: 0 },
      ],
    });

    expect(summary.status).toBe('critical');
    expect(summary.ok).toBe(1);
    expect(summary.warning).toBe(1);
    expect(summary.critical).toBe(1);
    expect(summary.ahead).toBe(2);
    expect(summary.reason).toBe('ahead_of_upstream');
  });

  it('treats a fresh backup cron success as healthy even before repo status is reported', () => {
    const summary = buildBackupSummary({
      supported: true,
      status: 'ok',
      sampled_at: new Date().toISOString(),
      cron: {
        supported: true,
        status: 'ok',
        last_success_at: '2026-04-29T04:27:00.000Z',
        last_run_at: '2026-04-29T04:27:00.000Z',
        log_path: '/Users/example/zylos/workspace/scripts/backup.log',
      },
      repos: [],
    });

    expect(summary.status).toBe('ok');
    expect(summary.reason).toBe(null);
    expect(summary.last_success_at).toBe('2026-04-29T04:27:00.000Z');
    expect(summary.total).toBe(0);
  });

  it('lets stale backup cron status override a clean repo', () => {
    const summary = buildBackupSummary({
      supported: true,
      cron: {
        supported: true,
        status: 'critical',
        reason: 'backup_success_too_old',
        last_success_at: '2026-04-20T04:27:00.000Z',
      },
      repos: [
        { remote: 'https://github.com/acme/clean.git', ahead: 0, behind: 0, dirty: 0, untracked: 0 },
      ],
    });

    expect(summary.status).toBe('critical');
    expect(summary.reason).toBe('backup_success_too_old');
  });

  it('sorts backup agents with critical and warning first', () => {
    const payload = buildBackupsPayload(
      [
        { name: 'ok-agent', online: true },
        { name: 'warn-agent', online: true },
        { name: 'crit-agent', online: true },
      ],
      {
        'ok-agent': { backup: { supported: true, repos: [{ path: '/ok', remote: 'https://github.com/acme/ok.git' }] } },
        'warn-agent': { backup: { supported: true, repos: [{ path: '/warn', remote: 'https://github.com/acme/warn.git', dirty: 1 }] } },
        'crit-agent': { backup: { supported: true, repos: [{ path: '/crit', remote: null }] } },
      }
    );

    expect(payload.agents.map(agent => agent.name)).toEqual(['crit-agent', 'warn-agent', 'ok-agent']);
    expect(payload.summary.critical).toBe(1);
    expect(payload.summary.warning).toBe(1);
    expect(payload.summary.ok).toBe(1);
  });
});
