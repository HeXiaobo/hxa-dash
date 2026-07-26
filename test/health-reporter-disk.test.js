import { execSync } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDiskInfo } from '../scripts/health-reporter.mjs';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

describe('health reporter disk collector', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  it('reports an unknown percentage when disk collection fails', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('df unavailable');
    });

    const disk = getDiskInfo();

    expect(disk).toEqual({
      total: null,
      used: null,
      pct: null,
    });
  });

  it('preserves a collected disk percentage', () => {
    vi.mocked(execSync).mockReturnValue(
      'Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s1 100G 57G 43G 57% /\n'
    );

    const disk = getDiskInfo();

    expect(disk).toEqual({
      total: '100G',
      used: '57G',
      pct: 57,
    });
  });
});
