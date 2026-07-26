import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

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

  it('keeps unknown counts and a missing upstream out of the healthy state', () => {
    const backup = sanitizeBackup({
      supported: true,
      status: 'unknown',
      reason: 'no_upstream',
      repos: [{
        path: '/Users/example/repo',
        remote: 'https://github.com/acme/repo.git',
        upstream: null,
        ahead: null,
        behind: null,
        dirty: 0,
        untracked: 0,
        status: 'unknown',
        reason: 'no_upstream',
      }],
    });
    const summary = buildBackupSummary(backup);

    expect(backup.repos[0]).toMatchObject({ upstream: null, ahead: null, behind: null, status: 'unknown' });
    expect(summary).toMatchObject({ status: 'unknown', reason: 'no_upstream', ok: 0, unknown: 1 });
  });

  it('renders unknown backup state as waiting instead of healthy', () => {
    const appSource = fs.readFileSync(path.join(process.cwd(), 'public/js/app.js'), 'utf8');

    expect(appSource).toContain("if (raw === 'unknown')");
    expect(appSource).toContain("key: 'waiting'");
    expect(appSource).toContain("label: '备份待确认'");
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

  it('warns when the last successful backup is past the freshness window', () => {
    const now = Date.parse('2026-06-12T01:20:00.000Z');
    const summary = buildBackupSummary({
      supported: true,
      cron: {
        supported: true,
        status: 'ok',
        last_success_at: '2026-06-10T09:19:00.000Z',
      },
      repos: [
        { remote: 'https://github.com/acme/clean.git', ahead: 0, behind: 0, dirty: 0, untracked: 0 },
      ],
    }, null, undefined, now);

    expect(summary.status).toBe('warning');
    expect(summary.reason).toBe('backup_success_stale');
    expect(summary.cron_status).toBe('warning');
  });

  it('marks stale successful backups unhealthy even when the reporter still says ok', () => {
    const now = Date.parse('2026-06-12T01:20:00.000Z');
    const summary = buildBackupSummary({
      supported: true,
      cron: {
        supported: true,
        status: 'ok',
        last_success_at: '2026-06-08T01:19:00.000Z',
      },
      repos: [
        { remote: 'https://github.com/acme/clean.git', ahead: 0, behind: 0, dirty: 0, untracked: 0 },
      ],
    }, null, undefined, now);

    expect(summary.status).toBe('critical');
    expect(summary.reason).toBe('backup_success_too_old');
    expect(summary.cron_status).toBe('critical');
    expect(summary.ok).toBe(1);
  });

  it('uses explicit expected backup repo aliases', () => {
    expect(expectedBackupRepo('mylos').url).toBe('https://github.com/with3ai/Mylos-workspace');
    expect(expectedBackupRepo('wanyanshu').url).toBe('https://github.com/zhi-wai/maxiaozhuo-workspace');
    expect(expectedBackupRepo('veda').url).toBe('https://github.com/with3ai/veda-workspace');
    expect(expectedBackupRepo('wenwen')).toMatchObject({
      required: true,
      url: 'https://github.com/zhi-wai/wenwen-workspace',
    });
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
    expect(summary.expected_remote).toBe('https://github.com/with3ai/Mylos-workspace');
    expect(summary.expected_match).toBe(false);
  });

  it('marks retired and shared-host agents as exempt with an explicit reason', () => {
    expect(expectedBackupRepo('chengzi')).toEqual({
      required: false,
      url: null,
      reason: '已退役，无需独立 GitHub 备份',
    });
    expect(expectedBackupRepo('ss-client')).toEqual({
      required: false,
      url: null,
      reason: '随宿主 ss 共用备份',
    });
    expect(expectedBackupRepo('mylos-tech')).toEqual({
      required: false,
      url: null,
      reason: '随宿主 mylos 共用备份',
    });
  });

  it('omits backup-exempt agents from the backup list and summary', () => {
    const payload = buildBackupsPayload(
      [
        { name: 'chengzi', online: false },
        { name: 'mylos-tech', online: true },
        { name: 'active-agent', online: true },
      ],
      {
        'active-agent': {
          backup: {
            supported: true,
            repos: [{
              path: '/home/cocoai/zylos/workspace/active-agent-workspace',
              remote: 'https://github.com/zhi-wai/active-agent-workspace.git',
              ahead: 0,
              behind: 0,
            }],
          },
        },
      }
    );

    expect(payload.agents.map(agent => agent.name)).toEqual(['active-agent']);
    expect(payload.summary).toMatchObject({
      total_agents: 1,
      repos: 1,
      ok: 1,
      warning: 0,
      critical: 0,
      unsupported: 0,
    });
  });

  it('shows the configured exemption reason instead of a generic employee label', () => {
    const appSource = fs.readFileSync(path.join(process.cwd(), 'public/js/app.js'), 'utf8');

    expect(appSource).toContain("summary.expected_reason || this._backupReasonText('backup_not_required')");
    expect(appSource).toContain("record.summary.expected_reason || '无需独立 GitHub 备份'");
    expect(appSource).not.toContain('非 AI 员工，无需 GitHub 仓库');
  });

  it('filters backup-exempt rows defensively in the browser', () => {
    const appSource = fs.readFileSync(path.join(process.cwd(), 'public/js/app.js'), 'utf8');

    expect(appSource).toContain('record?.summary?.backup_required !== false');
    expect(appSource).toContain('const totalAgents = records.length');
    expect(appSource).toContain('const repoCount = this._backupRepoCount(records)');
  });

  it('requires wenwen backup reporting through the default expected repo', () => {
    const summary = buildBackupSummary(null, 'wenwen');

    expect(summary.status).toBe('unsupported');
    expect(summary.reason).toBe('not_reported');
    expect(summary.backup_required).toBe(true);
    expect(summary.expected_remote).toBe('https://github.com/zhi-wai/wenwen-workspace');
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
