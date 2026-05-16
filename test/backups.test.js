import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const backupRoute = require('../src/routes/backups');
const agentHealthRoute = require('../src/routes/agent-health');

const { buildBackupSummary, buildBackupsPayload, expectedBackupRepo, githubSlug } = backupRoute.__private;
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

  it('summarizes repo backup status by GitHub remote and sync state', () => {
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

  it('requires a GitHub backup repo even when backup cron is fresh', () => {
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

    expect(summary.status).toBe('critical');
    expect(summary.reason).toBe('no_github_backup_repo');
    expect(summary.last_success_at).toBe('2026-04-29T04:27:00.000Z');
    expect(summary.total).toBe(0);
    expect(summary.critical).toBe(1);
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

  it('uses explicit expected backup repo aliases', () => {
    expect(expectedBackupRepo('mylos').url).toBe('https://github.com/with3ai/zylos-workspace');
    expect(expectedBackupRepo('wanyanshu').url).toBe('https://github.com/zhi-wai/maxiaozhuo-workspace');
    expect(expectedBackupRepo('hongshu').url).toBe('https://github.com/with3ai/hongshu-workspace');
    expect(expectedBackupRepo('veda').url).toBe('https://github.com/with3ai/veda-workspace');
    expect(expectedBackupRepo('wenwen').required).toBe(false);
    expect(githubSlug('git@github.com:with3ai/zylos-workspace.git')).toBe('with3ai/zylos-workspace');
  });

  it('flags a repo that does not match the expected agent repository', () => {
    const summary = buildBackupSummary({
      supported: true,
      repos: [
        { remote: 'https://github.com/zhi-wai/mylos-workspace.git', ahead: 0, behind: 0, dirty: 0, untracked: 0 },
      ],
    }, 'mylos');

    expect(summary.status).toBe('critical');
    expect(summary.reason).toBe('github_repo_mismatch');
    expect(summary.expected_remote).toBe('https://github.com/with3ai/zylos-workspace');
    expect(summary.expected_match).toBe(false);
  });

  it('treats exempt non-AI staff as not requiring a backup repo', () => {
    const summary = buildBackupSummary(null, 'wenwen');

    expect(summary.status).toBe('ok');
    expect(summary.reason).toBe('backup_not_required');
    expect(summary.backup_required).toBe(false);
  });

  it('deduplicates multiple local clones of the same expected GitHub repo', () => {
    const payload = buildBackupsPayload(
      [{ name: 'xiaozhang', online: true }],
      {
        xiaozhang: {
          backup: {
            supported: true,
            repos: [
              { path: '/home/cocoai/zylos/workspace/backup-staging', remote: 'https://github.com/zhi-wai/xiaozhang-workspace.git' },
              { path: '/home/cocoai/zylos/workspace/xiaozhang-workspace', remote: 'https://github.com/zhi-wai/xiaozhang-workspace.git' },
            ],
          },
        },
      }
    );

    expect(payload.agents[0].summary.total).toBe(1);
    expect(payload.agents[0].repos).toHaveLength(1);
    expect(payload.agents[0].repos[0].path).toBe('/home/cocoai/zylos/workspace/xiaozhang-workspace');
  });

  it('keeps local worktree changes informational when GitHub is synced', () => {
    const payload = buildBackupsPayload(
      [{ name: 'xiaochuaner', online: true }],
      {
        xiaochuaner: {
          backup: {
            supported: true,
            reason: 'backup_log_not_found',
            cron: { supported: false, status: 'unsupported', reason: 'backup_log_not_found' },
            repos: [
              {
                path: '/home/cocoai/zylos/workspace/xiaochuaner-workspace',
                remote: 'https://github.com/zhi-wai/xiaochuaner-workspace.git',
                dirty: 317,
                status: 'warning',
                reason: 'dirty_worktree',
              },
            ],
          },
        },
      }
    );

    const agent = payload.agents[0];
    expect(agent.summary.status).toBe('ok');
    expect(agent.summary.reason).toBeNull();
    expect(agent.summary.dirty).toBe(317);
    expect(agent.summary.warning).toBe(0);
    expect(agent.summary.ok).toBe(1);
    expect(agent.repos[0].status).toBe('ok');
    expect(agent.repos[0].reason).toBeNull();
  });

  it('sorts backup agents with critical and warning first', () => {
    const payload = buildBackupsPayload(
      [
        { name: 'ok-agent', online: true },
        { name: 'warn-agent', online: true },
        { name: 'crit-agent', online: true },
      ],
      {
        'ok-agent': { backup: { supported: true, repos: [{ path: '/ok', remote: 'https://github.com/zhi-wai/ok-agent-workspace.git' }] } },
        'warn-agent': { backup: { supported: true, repos: [{ path: '/warn', remote: 'https://github.com/zhi-wai/warn-agent-workspace.git', ahead: 1 }] } },
        'crit-agent': { backup: { supported: true, repos: [{ path: '/crit', remote: null }] } },
      }
    );

    expect(payload.agents.map(agent => agent.name)).toEqual(['crit-agent', 'warn-agent', 'ok-agent']);
    expect(payload.summary.critical).toBe(1);
    expect(payload.summary.warning).toBe(1);
    expect(payload.summary.ok).toBe(1);
  });
});
