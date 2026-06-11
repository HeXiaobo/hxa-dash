import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const limitsRoute = require('../src/routes/limits.js');
const { QUOTA_STALE_MS, enrichQuota } = limitsRoute.__private;

describe('limits quota freshness', () => {
  const nowMs = 1_781_142_900_000;

  it('marks supported quota with recent sampled_at as fresh', () => {
    const now = nowMs;
    const quota = enrichQuota({
      supported: true,
      sampled_at: now - 60_000,
      primary: { used_percent: 12 },
      secondary: { used_percent: 30 },
    }, null, now);

    expect(quota.sampled_at).toBe(now - 60_000);
    expect(quota.freshness).toMatchObject({
      status: 'fresh',
      sampled_at: now - 60_000,
      age_ms: 60_000,
      stale_after_ms: QUOTA_STALE_MS,
    });
  });

  it('falls back to the heartbeat timestamp when sampled_at is missing', () => {
    const now = nowMs;
    const heartbeatAt = now - 120_000;
    const quota = enrichQuota({
      supported: true,
      sampled_at: null,
      primary: { used_percent: 12 },
    }, heartbeatAt, now);

    expect(quota.sampled_at).toBe(heartbeatAt);
    expect(quota.freshness.status).toBe('fresh');
  });

  it('normalizes second-epoch sampled_at values to milliseconds', () => {
    const now = nowMs;
    const sampledAtSec = Math.floor((now - 60_000) / 1000);
    const quota = enrichQuota({
      supported: true,
      sampled_at: sampledAtSec,
      primary: { used_percent: 12 },
    }, null, now);

    expect(quota.sampled_at).toBe(sampledAtSec * 1000);
    expect(quota.freshness.status).toBe('fresh');
    expect(quota.freshness.age_ms).toBe(now - sampledAtSec * 1000);
  });

  it('marks old supported quota as stale', () => {
    const now = nowMs;
    const sampledAt = now - QUOTA_STALE_MS - 1;
    const quota = enrichQuota({
      supported: true,
      sampled_at: sampledAt,
      primary: { used_percent: 12 },
    }, null, now);

    expect(quota.sampled_at).toBe(sampledAt);
    expect(quota.freshness.status).toBe('stale');
    expect(quota.freshness.age_ms).toBe(QUOTA_STALE_MS + 1);
  });
});
