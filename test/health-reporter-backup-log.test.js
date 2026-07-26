import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  classifyBackupLogLines,
  collectGitRepoBackup,
  isBackupSuccessLine,
} from '../scripts/health-reporter.mjs';

describe('health reporter backup log parser', () => {
  it('treats git ref update output as a successful backup signal', () => {
    const mtime = Date.parse('2026-05-16T04:30:00.000Z');
    const result = classifyBackupLogLines([
      'fatal: unable to access github',
      '8b96318..e348164  main -> main',
    ], mtime, mtime);

    expect(isBackupSuccessLine('8b96318..e348164  main -> main')).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.reason).toBeNull();
    expect(result.last_success_at).toBe('2026-05-16T04:30:00.000Z');
  });

  it('still flags an untimestamped failure after the latest success', () => {
    const mtime = Date.parse('2026-05-16T04:30:00.000Z');
    const result = classifyBackupLogLines([
      'backup completed',
      'fatal: unable to access github',
    ], mtime, mtime);

    expect(result.status).toBe('critical');
    expect(result.reason).toBe('failure_after_last_success');
  });

  it('keeps repository sync unknown when a real branch has no upstream', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-backup-no-upstream-'));
    try {
      execFileSync('git', ['init', '-b', 'main', repoPath]);
      execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'HXA Test']);
      execFileSync('git', ['-C', repoPath, 'config', 'user.email', 'hxa-test@example.invalid']);
      fs.writeFileSync(path.join(repoPath, 'README.md'), '# backup test\n');
      execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
      execFileSync('git', ['-C', repoPath, 'commit', '-m', 'test backup']);
      execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://github.com/example/backup.git']);

      expect(collectGitRepoBackup(repoPath)).toMatchObject({
        upstream: null,
        ahead: null,
        behind: null,
        status: 'unknown',
        reason: 'no_upstream',
      });
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
