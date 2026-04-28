import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tokenRoute = require('../src/routes/tokens.js');
const { buildObservedUsageFromHistory } = tokenRoute.__private;

function healthRow({ name = 'agent-a', reportedAt, session = 'session-a', input = 0, output = 0, cacheRead = 0, total = null, cost = null }) {
  return {
    name,
    reported_at: reportedAt,
    runtime: { type: 'claude_code', version: '2.1.119', status: 'running' },
    usage: {
      claude_code: {
        supported: true,
        source: 'transcript',
        sampled_at: reportedAt,
        session_id: session,
        model: 'claude-opus-4-6',
        session_tokens: {
          input,
          output,
          cache_read: cacheRead,
          total: total == null ? input + output + cacheRead : total,
        },
        session_cost_usd: cost,
        estimated_cost: cost != null,
      },
    },
  };
}

describe('observed token deltas', () => {
  const window = { start_ms: 1000, end_ms: 5000 };

  it('uses cumulative snapshot differences inside the selected window', () => {
    const result = buildObservedUsageFromHistory([
      healthRow({ reportedAt: 900, input: 70, output: 10, cacheRead: 20, cost: 1 }),
      healthRow({ reportedAt: 2000, input: 100, output: 20, cacheRead: 40, cost: 1.5 }),
      healthRow({ reportedAt: 4000, input: 130, output: 30, cacheRead: 60, cost: 2 }),
    ], window);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'agent-a',
      input: 60,
      output: 20,
      cache_read: 40,
      total: 120,
      cost_usd: 1,
      partial_baseline: false,
    });
  });

  it('does not treat the first in-window snapshot as new usage when no baseline exists', () => {
    const result = buildObservedUsageFromHistory([
      healthRow({ name: 'agent-b', reportedAt: 2000, input: 300, output: 50, cacheRead: 150 }),
      healthRow({ name: 'agent-b', reportedAt: 3500, input: 360, output: 70, cacheRead: 220 }),
    ], window);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'agent-b',
      input: 60,
      output: 20,
      cache_read: 70,
      total: 150,
      partial_baseline: true,
    });
  });

  it('keeps prior session deltas when a new session becomes latest', () => {
    const result = buildObservedUsageFromHistory([
      healthRow({ reportedAt: 900, session: 'old', input: 80, output: 20, total: 100 }),
      healthRow({ reportedAt: 2000, session: 'old', input: 140, output: 40, total: 180 }),
      healthRow({ reportedAt: 3000, session: 'new', input: 15, output: 5, total: 20 }),
      healthRow({ reportedAt: 4500, session: 'new', input: 55, output: 15, total: 70 }),
    ], window);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'agent-a',
      input: 100,
      output: 30,
      total: 130,
      partial_baseline: true,
    });
  });
});
