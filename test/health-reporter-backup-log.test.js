import { describe, expect, it } from 'vitest';
import { classifyBackupLogLines, isBackupSuccessLine } from '../scripts/health-reporter.mjs';

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

    expect(result.status).toBe('warning');
    expect(result.reason).toBe('failure_after_last_success');
  });
});
