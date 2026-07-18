import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const backupRoute = require('../src/routes/backups');
const agentHealthRoute = require('../src/routes/agent-health');
const { buildAgentObservability } = require('../src/agent-observability');

const { buildBackupSummary, buildBackupsPayload, expectedBackupRepo, githubSlug } = backupRoute.__private;
const {
  sanitizeActivityMonitor,
  sanitizeBackup,
  sanitizeQuotaWindow,
  sanitizeUsageShape,
} = agentHealthRoute.__private;
const SYNTHETIC_SAMPLE_AT = Date.parse('2040-01-15T12:00:00.000Z');

describe('backup health helpers', () => {
  it('keeps invalid quota and Activity Monitor values from entering central health', () => {
    expect(sanitizeQuotaWindow({ used_percent: false })).toBeNull();
    expect(sanitizeQuotaWindow({ used_percent: -1 })).toBeNull();
    expect(sanitizeQuotaWindow({ used_percent: 101 })).toBeNull();
    expect(sanitizeQuotaWindow({ used_percent: 49 })).toMatchObject({ used_percent: 49 });

    const safeActivity = {
      source: 'activity_monitor_fallback',
      state: 'idle',
      health: 'ok',
      observed_at: SYNTHETIC_SAMPLE_AT,
      used_for_routing: false,
    };
    expect(sanitizeActivityMonitor(safeActivity)).toEqual(safeActivity);
    expect(sanitizeActivityMonitor({ ...safeActivity, used_for_routing: true })).toBeNull();
    const { used_for_routing: _omitted, ...missingFlag } = safeActivity;
    expect(sanitizeActivityMonitor(missingFlag)).toBeNull();
  });

  it('preserves per-field usage provenance and does not invent an estimated-cost flag', () => {
    expect(sanitizeUsageShape({
      supported: true,
      source: 'transcript',
      sampled_at: 1000,
      model: 'claude-fixture-beta',
      model_source: 'statusline',
      model_sampled_at: 2000,
      session_tokens: { total: 100 },
      session_cost_usd: 3.5,
      cost_source: 'statusline',
      cost_sampled_at: 2000,
      estimated_cost: true,
      partial: false,
    })).toMatchObject({
      model_source: 'statusline',
      model_sampled_at: 2000,
      cost_source: 'statusline',
      cost_sampled_at: 2000,
      estimated_cost: true,
      partial: false,
    });
    const incompleteEvidence = sanitizeUsageShape({ supported: true, session_cost_usd: 3.5 });
    expect(incompleteEvidence.estimated_cost).toBeNull();
    expect(incompleteEvidence.partial).toBeNull();

    const malformedTokens = sanitizeUsageShape({
      supported: true,
      source: 'codex',
      sampled_at: 1_700_000_000_000,
      session_tokens: { input: 10, output: false },
      partial: false,
    });
    expect(malformedTokens.session_tokens).toBeNull();
    expect(malformedTokens.reason).toBe('invalid_value');
  });

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

    const queryRedacted = sanitizeBackup({
      supported: true,
      repos: [{
        remote: 'https://github.com/example/repo.git?token=synthetic-secret-marker#private',
        ahead: 0,
        behind: 0,
        dirty: 0,
        untracked: 0,
      }],
    });
    expect(queryRedacted.repos[0].remote).toBe('https://github.com/example/repo.git');

    const nonHttpRedacted = sanitizeBackup({
      supported: true,
      repos: [
        { remote: 'SYNTHETIC_CREDENTIAL@github.com:example/repo.git' },
        { remote: 'user:SYNTHETIC_CREDENTIAL@host.example:repo.git' },
        { remote: 'https://github.com/example/token=SYNTHETIC_CREDENTIAL/repo.git' },
        { remote: 'https://github.com/example/token%3DSYNTHETIC_CREDENTIAL/repo.git' },
      ],
    });
    expect(nonHttpRedacted.repos.map(repo => repo.remote)).toEqual([
      'git@github.com:example/repo.git',
      null,
      null,
      null,
    ]);
  });

  it('rejects password and secret hints again at the central health boundary', () => {
    const sanitized = sanitizeBackup({
      supported: true,
      repos: [
        { remote: 'https://github.com/synthetic/password=SYNTHETIC_CREDENTIAL/repo.git' },
        { remote: 'git@github.com:synthetic/secret=SYNTHETIC_CREDENTIAL/repo.git' },
        { remote: 'https://github.com/synthetic/client_secret%3DSYNTHETIC_CREDENTIAL/repo.git' },
        { remote: 'https://github.com/synthetic/password%25253DSYNTHETIC_CREDENTIAL/repo.git' },
        { remote: 'https://github.com/synthetic/password%ZZSYNTHETIC_CREDENTIAL/repo.git' },
        { remote: 'https://github.com/synthetic/repo.git%3Ftoken%3DSYNTHETIC_CREDENTIAL' },
        { remote: 'https://github.com/synthetic/repo.git%253Ftoken%253DSYNTHETIC_CREDENTIAL' },
        { remote: 'https://github.com/synthetic/repo.git%23password%3DSYNTHETIC_CREDENTIAL' },
        { remote: 'https://github.com/synthetic/repo.git%26api_key%3DSYNTHETIC_CREDENTIAL' },
        { remote: 'git@github.com:synthetic/repo.git%3Fclient_secret%3DSYNTHETIC_CREDENTIAL' },
        { remote: 'opaque.example:synthetic/client-secret=SYNTHETIC_CREDENTIAL/repo.git' },
      ],
    });

    expect(sanitized.repos.map(repo => repo.remote)).toEqual([
      null, null, null, null, null, null, null, null, null, null, null,
    ]);
  });

  it('rejects credential keys after any non-identifier delimiter at the central boundary', () => {
    const sanitized = sanitizeBackup({
      supported: true,
      repos: [
        { remote: 'git@github.com:synthetic/repo.git\\password=SYNTHETIC_CREDENTIAL' },
        { remote: 'git@github.com:synthetic/repo.git%5Cpassword%3DSYNTHETIC_CREDENTIAL' },
        { remote: 'ssh://git@github.com/synthetic/repo.git@token=SYNTHETIC_CREDENTIAL' },
        { remote: 'ssh://git@github.com/synthetic/repo.git%40token%3DSYNTHETIC_CREDENTIAL' },
        { remote: 'https://github.com/synthetic/repo.git|client_secret=SYNTHETIC_CREDENTIAL' },
        { remote: 'https://github.com/synthetic/repo.git%7Cclient_secret%3DSYNTHETIC_CREDENTIAL' },
        { remote: 'https://github.com/synthetic/tokenizer/repo.git' },
        { remote: 'git@github.com:synthetic/secret-sauce/repo.git' },
      ],
    });

    expect(sanitized.repos.map(repo => repo.remote)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      'https://github.com/synthetic/tokenizer/repo.git',
      'git@github.com:synthetic/secret-sauce/repo.git',
    ]);
  });

  it('requires explicit repo counter evidence before calling the expected remote synchronized', () => {
    const sanitized = sanitizeBackup({
      supported: true,
      status: 'ok',
      sampled_at: 1_700_000_000_000,
      repos: [{ remote: 'https://github.com/with3ai/Mylos-workspace.git', status: 'ok' }],
    });
    const summary = buildBackupSummary(sanitized, 'mylos');
    expect(summary).toMatchObject({
      expected_match: true,
      counter_evidence_complete: false,
      ahead: null,
      behind: null,
      dirty: null,
      untracked: null,
    });

    const observability = buildAgentObservability({ backup: summary });
    expect(observability.backup).toMatchObject({
      remote_match: null,
      remote_match_availability: 'unavailable',
    });

    const now = 1_700_000_000_000;
    const payload = buildBackupsPayload(
      [{ name: 'mylos', online: true }],
      {
        mylos: {
          reported_at: now - 1_000,
          backup: { ...sanitized, sampled_at: now - 1_000 },
        },
      },
      now,
    );
    expect(payload.agents[0].summary).toMatchObject({
      counter_evidence_complete: false,
      ahead: null,
      behind: null,
      dirty: null,
      untracked: null,
    });
    expect(payload.summary).toMatchObject({
      counter_evidence_complete: false,
      ahead: null,
      behind: null,
      dirty: null,
      untracked: null,
    });
  });

  it('does not let reporter summary zeroes upgrade missing repository counters', () => {
    const sanitized = sanitizeBackup({
      supported: true,
      status: 'ok',
      sampled_at: SYNTHETIC_SAMPLE_AT,
      summary: {
        ahead: 0,
        behind: 0,
        dirty: 0,
        untracked: 0,
      },
      repos: [{
        remote: 'https://github.com/with3ai/Mylos-workspace.git',
        status: 'ok',
      }],
    });

    expect(sanitized.summary).toMatchObject({
      counter_evidence_complete: false,
      ahead: null,
      behind: null,
      dirty: null,
      untracked: null,
    });
  });

  it('checks counter completeness across the same repositories it aggregates', () => {
    const now = SYNTHETIC_SAMPLE_AT;
    const payload = buildBackupsPayload(
      [{ name: 'mylos', online: true }],
      {
        mylos: {
          reported_at: now - 1_000,
          backup: {
            supported: true,
            sampled_at: now - 1_000,
            repos: [
              {
                remote: 'https://github.com/with3ai/Mylos-workspace.git',
                ahead: 0,
                behind: 0,
                dirty: 0,
                untracked: 0,
              },
              {
                remote: 'https://github.com/synthetic/secondary.git',
                ahead: null,
                behind: null,
                dirty: null,
                untracked: null,
              },
            ],
          },
        },
      },
      now,
    );

    expect(payload.agents[0].summary).toMatchObject({
      expected_match: true,
      counter_evidence_complete: false,
      ahead: null,
      behind: null,
      dirty: null,
      untracked: null,
    });
    expect(payload.summary).toMatchObject({
      counter_evidence_complete: false,
      ahead: null,
      behind: null,
      dirty: null,
      untracked: null,
    });
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

  it('rejects a backup success time later than its sample or the current clock', () => {
    const now = SYNTHETIC_SAMPLE_AT;
    const summary = buildBackupSummary({
      supported: true,
      sampled_at: now - 1_000,
      cron: {
        supported: true,
        status: 'ok',
        last_success_at: now + 5_001,
      },
      repos: [
        { remote: 'https://github.com/acme/clean.git', ahead: 0, behind: 0, dirty: 0, untracked: 0 },
      ],
    }, null, undefined, now);

    expect(summary).toMatchObject({
      status: 'critical',
      reason: 'backup_success_in_future',
      cron_status: 'critical',
      last_success_at: null,
    });

    const afterSample = buildBackupSummary({
      supported: true,
      sampled_at: now - 1_000,
      cron: {
        supported: true,
        status: 'ok',
        last_success_at: now - 999,
      },
      repos: [
        { remote: 'https://github.com/acme/clean.git', ahead: 0, behind: 0, dirty: 0, untracked: 0 },
      ],
    }, null, undefined, now);
    expect(afterSample).toMatchObject({
      status: 'critical',
      reason: 'backup_success_in_future',
      last_success_at: null,
    });

    const payload = buildBackupsPayload(
      [{ name: 'mylos', online: true }],
      {
        mylos: {
          reported_at: now - 1_000,
          backup: {
            supported: true,
            sampled_at: now - 1_000,
            cron: {
              supported: true,
              status: 'ok',
              last_success_at: now + 5_001,
            },
            repos: [{
              remote: 'https://github.com/with3ai/Mylos-workspace.git',
              ahead: 0,
              behind: 0,
              dirty: 0,
              untracked: 0,
            }],
          },
        },
      },
      now,
    );
    expect(payload.agents[0].cron?.last_success_at).toBeNull();
  });

  it('uses explicit expected backup repo aliases', () => {
    expect(expectedBackupRepo('mylos').url).toBe('https://github.com/with3ai/Mylos-workspace');
    expect(expectedBackupRepo('wanyanshu').url).toBe('https://github.com/zhi-wai/maxiaozhuo-workspace');
    expect(expectedBackupRepo('hongshu').url).toBe('https://github.com/with3ai/hongshu-workspace');
    expect(expectedBackupRepo('veda').url).toBe('https://github.com/with3ai/veda-workspace');
    expect(expectedBackupRepo('wenwen')).toMatchObject({
      required: true,
      url: 'https://github.com/zhi-wai/wenwen-workspace',
    });
    expect(githubSlug('git@github.com:with3ai/Mylos-workspace.git')).toBe('with3ai/mylos-workspace');
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
          reported_at: Date.now(),
          backup: {
            supported: true,
            sampled_at: Date.now(),
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
          reported_at: Date.now(),
          backup: {
            supported: true,
            sampled_at: Date.now(),
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
        'ok-agent': { reported_at: Date.now(), backup: { supported: true, sampled_at: Date.now(), repos: [{ path: '/ok', remote: 'https://github.com/zhi-wai/ok-agent-workspace.git' }] } },
        'warn-agent': { reported_at: Date.now(), backup: { supported: true, sampled_at: Date.now(), repos: [{ path: '/warn', remote: 'https://github.com/zhi-wai/warn-agent-workspace.git', ahead: 1 }] } },
        'crit-agent': { reported_at: Date.now(), backup: { supported: true, sampled_at: Date.now(), repos: [{ path: '/crit', remote: null }] } },
      }
    );

    expect(payload.agents.map(agent => agent.name)).toEqual(['crit-agent', 'warn-agent', 'ok-agent']);
    expect(payload.summary.critical).toBe(1);
    expect(payload.summary.warning).toBe(1);
    expect(payload.summary.ok).toBe(1);
  });

  it('fails stale, missing, and future health reports closed in the backups API', () => {
    const now = 1_700_000_000_000;
    const backup = {
      supported: true,
      status: 'ok',
      sampled_at: now - 1_000,
      repos: [{
        remote: 'https://github.com/with3ai/Mylos-workspace.git',
        ahead: 0,
        behind: 0,
        dirty: 0,
        untracked: 0,
      }],
    };
    const payload = reported_at => buildBackupsPayload(
      [{ name: 'mylos', online: true }],
      { mylos: { reported_at, backup } },
      now,
    );

    expect(payload(now - 1_000).agents[0].summary).toMatchObject({
      supported: true,
      counter_evidence_complete: true,
    });
    expect(payload(now - 10 * 60 * 1000 - 1).agents[0].summary).toMatchObject({
      supported: false,
      status: 'unsupported',
      reason: 'stale_sample',
    });
    expect(payload(now + 5_001).agents[0].summary).toMatchObject({
      supported: false,
      reason: 'stale_sample',
    });
    expect(payload(null).agents[0].summary).toMatchObject({
      supported: false,
      reason: 'sample_time_unavailable',
    });
  });

  it('fails stale, missing, and future backup samples closed even when the health report is fresh', () => {
    const now = 1_700_000_000_000;
    const payload = sampledAt => buildBackupsPayload(
      [{ name: 'mylos', online: true }],
      {
        mylos: {
          reported_at: now - 1_000,
          backup: {
            supported: true,
            status: 'ok',
            sampled_at: sampledAt,
            repos: [{
              remote: 'https://github.com/with3ai/Mylos-workspace.git',
              ahead: 0,
              behind: 0,
              dirty: 0,
              untracked: 0,
            }],
          },
        },
      },
      now,
    );

    expect(payload(now - 1_000).agents[0].summary).toMatchObject({
      supported: true,
      counter_evidence_complete: true,
    });
    expect(payload(now - 10 * 60 * 1000 - 1).agents[0].summary).toMatchObject({
      supported: false,
      status: 'unsupported',
      reason: 'stale_sample',
      expected_match: null,
      counter_evidence_complete: false,
    });
    expect(payload(now + 5_001).agents[0].summary).toMatchObject({
      supported: false,
      reason: 'stale_sample',
    });
    expect(payload(null).agents[0].summary).toMatchObject({
      supported: false,
      reason: 'sample_time_unavailable',
    });
  });

  it('does not return stale repository or cron evidence after downgrading a backup sample', () => {
    const now = SYNTHETIC_SAMPLE_AT;
    const payload = buildBackupsPayload(
      [{ name: 'mylos', online: true }],
      {
        mylos: {
          reported_at: now - 1_000,
          backup: {
            supported: true,
            status: 'ok',
            sampled_at: now - 10 * 60 * 1000 - 1,
            cron: {
              supported: true,
              status: 'ok',
              last_success_at: now - 20_000,
              last_run_at: now - 10_000,
              log_path: '/synthetic/private/backup.log',
            },
            repos: [{
              path: '/synthetic/private/repo',
              remote: 'https://github.com/with3ai/Mylos-workspace.git',
              ahead: 0,
              behind: 0,
              dirty: 0,
              untracked: 0,
            }],
          },
        },
      },
      now,
    );

    expect(payload.agents[0]).toMatchObject({
      stale: true,
      cron: null,
      repos: [],
      summary: {
        supported: false,
        last_success_at: null,
        last_run_at: null,
        log_path: null,
        total: null,
        ok: null,
        github_remotes: null,
      },
    });
    expect(payload.summary.repos).toBeNull();
    expect(JSON.stringify(payload.agents[0])).not.toContain('/synthetic/private/');
  });
});
