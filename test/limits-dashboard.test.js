import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

function loadLimitsDashboard() {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'public/js/components/limits-dashboard.js'),
    'utf8'
  );
  const context = {};
  vm.runInNewContext(`${source}\nglobalThis.__limitsDashboard = LimitsDashboard;`, context);
  return context.__limitsDashboard;
}

describe('limits dashboard quota labels', () => {
  const dashboard = loadLimitsDashboard();

  it('labels unavailable third-party quota windows as temporarily unsupported', () => {
    expect(dashboard._formatQuotaText({
      supported: false,
      reason: 'no machine-readable Claude quota snapshot found',
    })).toBe('暂不支持');
  });

  it('keeps genuinely missing reporter data distinct from unsupported quota', () => {
    expect(dashboard._formatQuotaText({
      supported: false,
      reason: 'not_reported',
    })).toBe('未提供');
  });
});
