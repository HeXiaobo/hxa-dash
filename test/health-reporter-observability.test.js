import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildClaudeUsageEvidence,
  buildRosterPayload,
  collectGitRepoBackup,
  getDiskInfo,
  mapClaudeStatuslineRateLimits,
  normalizeQuotaWindow,
  normalizeUsageTokens,
  numberOrNull,
  sanitizeRemoteUrl,
  summarizeBackupRepos,
} from '../scripts/health-reporter.mjs';

describe('health reporter observability evidence', () => {
  it('keeps disk collection failures unavailable instead of reporting a healthy zero', () => {
    const failedCommand = () => {
      throw new Error('synthetic disk collection failure');
    };

    expect(getDiskInfo(failedCommand)).toEqual({
      total: null,
      used: null,
      pct: null,
      unavailable_reason: 'collection_failed',
    });
  });

  it('does not coerce boolean or out-of-range quota values into plausible percentages', () => {
    expect(normalizeQuotaWindow({ used_percent: false })).toMatchObject({ used_percent: null });
    expect(normalizeQuotaWindow({ used_percent: -1 })).toMatchObject({ used_percent: null });
    expect(normalizeQuotaWindow({ used_percent: 101 })).toMatchObject({ used_percent: null });
    expect(normalizeQuotaWindow({ used_percent: 49 })).toMatchObject({ used_percent: 49 });
  });

  it('keeps model, session-token, and cost provenance separate for Claude evidence', () => {
    const result = buildClaudeUsageEvidence({
      transcript: {
        sampled_at: 1000,
        session_id: 'synthetic-session-a',
        model: 'claude-fixture-beta',
        session_tokens: { total: 100 },
        last_turn_tokens: { total: 10 },
      },
      statusline: {
        sampled_at: 2000,
        session_id: 'synthetic-session-a',
        model: 'claude-fixture-beta-statusline',
        session_cost_usd: 3.5,
        estimated_cost: true,
      },
    });

    expect(result).toMatchObject({
      source: 'transcript',
      sampled_at: 1000,
      model: 'claude-fixture-beta-statusline',
      model_source: 'statusline',
      model_sampled_at: 2000,
      cost_source: 'statusline',
      cost_sampled_at: 2000,
      session_cost_usd: 3.5,
      estimated_cost: true,
    });
  });

  it('does not borrow statusline time for transcript Token evidence', () => {
    const result = buildClaudeUsageEvidence({
      transcript: {
        sampled_at: null,
        session_id: 'synthetic-session-a',
        session_tokens: { total: 100 },
        last_turn_tokens: { total: 10 },
      },
      statusline: {
        sampled_at: 2_000,
        session_id: 'synthetic-session-a',
        model: 'claude-fixture-statusline',
        session_cost_usd: 3.5,
        estimated_cost: true,
      },
    });

    expect(result).toMatchObject({
      source: 'transcript',
      sampled_at: null,
      session_tokens: { total: 100 },
      session_cost_usd: null,
      cost_source: null,
      cost_sampled_at: null,
    });
  });

  it('does not mix statusline model or cost into transcript evidence from another or causally older session snapshot', () => {
    const transcriptAt = 1_800_000_000_000;
    const cases = [
      {
        label: 'different session',
        statusline: {
          sampled_at: transcriptAt + 1000,
          session_id: 'synthetic-session-b',
        },
      },
      {
        label: 'older snapshot',
        statusline: {
          sampled_at: transcriptAt - 5001,
          session_id: 'synthetic-session-a',
        },
      },
    ];

    for (const item of cases) {
      const result = buildClaudeUsageEvidence({
        transcript: {
          sampled_at: transcriptAt,
          session_id: 'synthetic-session-a',
          model: 'synthetic-transcript-model',
          session_tokens: { total: 100 },
          last_turn_tokens: { total: 10 },
          partial: false,
        },
        statusline: {
          ...item.statusline,
          model: `synthetic-statusline-model-${item.label}`,
          session_cost_usd: 3.5,
          estimated_cost: true,
        },
      });

      expect(result).toMatchObject({
        source: 'transcript',
        sampled_at: transcriptAt,
        session_id: 'synthetic-session-a',
        model: 'synthetic-transcript-model',
        model_source: 'transcript',
        session_tokens: { total: 100 },
        session_cost_usd: null,
        cost_source: null,
        cost_sampled_at: null,
        estimated_cost: false,
      });
    }
  });

  it('maps statusline quota names onto exact five-hour and seven-day windows', () => {
    expect(mapClaudeStatuslineRateLimits({
      five_hour: { used_percentage: 2, resets_at: 1_700_000_000 },
      seven_day: { used_percentage: 48, resets_at: 1_700_100_000 },
    })).toMatchObject({
      primary: { used_percent: 2, window_minutes: 300 },
      secondary: { used_percent: 48, window_minutes: 10_080 },
    });
  });

  it('uses the statusline source time for roster evidence instead of the collection clock', () => {
    const sourceTime = '2026-01-02T03:04:05.000Z';
    expect(buildRosterPayload({
      timestamp: sourceTime,
      context_window: { used_percentage: 25 },
    }, 1_800_000_000_000)).toMatchObject({
      context_used_pct: 25,
      sampled_at: Date.parse(sourceTime),
    });
    expect(buildRosterPayload({ context_window: { used_percentage: 25 } }, 1_700_000_000_000))
      .toMatchObject({ sampled_at: 1_700_000_000_000 });
  });

  it('rejects boolean, blank, fractional, and mixed malformed usage values instead of making zero', () => {
    expect(numberOrNull(false)).toBeNull();
    expect(numberOrNull(null)).toBeNull();
    expect(numberOrNull(' ')).toBeNull();
    expect(numberOrNull('12.5')).toBe(12.5);
    expect(normalizeUsageTokens({ total_tokens: false })).toBeNull();
    expect(normalizeUsageTokens({ input_tokens: 10, output_tokens: false })).toBeNull();
    expect(normalizeUsageTokens({ total_tokens: 10.5 })).toBeNull();
    expect(normalizeUsageTokens({ total_tokens: 10 })).toMatchObject({ total: 10 });
  });

  it('removes credentials, query parameters, and fragments before a remote URL leaves the node', () => {
    expect(sanitizeRemoteUrl('https://user:pass@github.com/example/repo.git?token=synthetic-secret#private'))
      .toBe('https://github.com/example/repo.git');
    expect(sanitizeRemoteUrl('SYNTHETIC_CREDENTIAL@github.com:example/repo.git'))
      .toBe('git@github.com:example/repo.git');
    expect(sanitizeRemoteUrl('user:SYNTHETIC_CREDENTIAL@host.example:repo.git')).toBeNull();
    expect(sanitizeRemoteUrl('https://github.com/example/token=SYNTHETIC_CREDENTIAL/repo.git')).toBeNull();
    expect(sanitizeRemoteUrl('https://github.com/example/token%3DSYNTHETIC_CREDENTIAL/repo.git')).toBeNull();
  });

  it('rejects password and secret hints in HTTP, SCP, encoded, and opaque remote paths', () => {
    for (const remote of [
      'https://github.com/synthetic/password=SYNTHETIC_CREDENTIAL/repo.git',
      'git@github.com:synthetic/secret=SYNTHETIC_CREDENTIAL/repo.git',
      'https://github.com/synthetic/client_secret%3DSYNTHETIC_CREDENTIAL/repo.git',
      'https://github.com/synthetic/password%25253DSYNTHETIC_CREDENTIAL/repo.git',
      'https://github.com/synthetic/password%ZZSYNTHETIC_CREDENTIAL/repo.git',
      'https://github.com/synthetic/repo.git%3Ftoken%3DSYNTHETIC_CREDENTIAL',
      'https://github.com/synthetic/repo.git%253Ftoken%253DSYNTHETIC_CREDENTIAL',
      'https://github.com/synthetic/repo.git%23password%3DSYNTHETIC_CREDENTIAL',
      'https://github.com/synthetic/repo.git%26api_key%3DSYNTHETIC_CREDENTIAL',
      'git@github.com:synthetic/repo.git%3Fclient_secret%3DSYNTHETIC_CREDENTIAL',
      'opaque.example:synthetic/client-secret=SYNTHETIC_CREDENTIAL/repo.git',
    ]) {
      expect(sanitizeRemoteUrl(remote)).toBeNull();
    }
  });

  it('rejects credential keys after any non-identifier delimiter without rejecting safe names', () => {
    for (const remote of [
      'git@github.com:synthetic/repo.git\\password=SYNTHETIC_CREDENTIAL',
      'git@github.com:synthetic/repo.git%5Cpassword%3DSYNTHETIC_CREDENTIAL',
      'ssh://git@github.com/synthetic/repo.git@token=SYNTHETIC_CREDENTIAL',
      'ssh://git@github.com/synthetic/repo.git%40token%3DSYNTHETIC_CREDENTIAL',
      'https://github.com/synthetic/repo.git|client_secret=SYNTHETIC_CREDENTIAL',
      'https://github.com/synthetic/repo.git%7Cclient_secret%3DSYNTHETIC_CREDENTIAL',
      'https://github.com/synthetic/token|SYNTHETIC_CREDENTIAL/repo.git',
      'https://github.com/synthetic/token%7CSYNTHETIC_CREDENTIAL/repo.git',
    ]) {
      expect(sanitizeRemoteUrl(remote)).toBeNull();
    }

    expect(sanitizeRemoteUrl('https://github.com/synthetic/tokenizer/repo.git'))
      .toBe('https://github.com/synthetic/tokenizer/repo.git');
    expect(sanitizeRemoteUrl('git@github.com:synthetic/secret-sauce/repo.git'))
      .toBe('git@github.com:synthetic/secret-sauce/repo.git');
  });

  it('keeps Git synchronization counters unavailable when no upstream evidence exists', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-synthetic-git-evidence-'));
    const git = args => spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' });
    try {
      expect(git(['init']).status).toBe(0);
      expect(git(['config', 'user.name', 'Synthetic Fixture']).status).toBe(0);
      expect(git(['config', 'user.email', 'fixture@example.invalid']).status).toBe(0);
      fs.writeFileSync(path.join(repoPath, 'fixture.txt'), 'synthetic\n');
      expect(git(['add', 'fixture.txt']).status).toBe(0);
      expect(git(['commit', '-m', 'synthetic fixture']).status).toBe(0);
      expect(git(['remote', 'add', 'origin', 'https://github.com/synthetic/example.git']).status).toBe(0);

      const repo = collectGitRepoBackup(repoPath);
      expect(repo).toMatchObject({
        status: 'critical',
        reason: 'upstream_unavailable',
        ahead: null,
        behind: null,
        dirty: 0,
        untracked: 0,
      });
      expect(summarizeBackupRepos([repo])).toMatchObject({
        ahead: null,
        behind: null,
        dirty: null,
        untracked: null,
      });
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
