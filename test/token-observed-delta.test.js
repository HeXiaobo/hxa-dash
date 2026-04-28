import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tokenRoute = require('../src/routes/tokens.js');
const { buildObservedUsageFromHistory } = tokenRoute.__private;

function healthRow({ name = 'agent-a', reportedAt, sampledAt = reportedAt, session = 'session-a', input = 0, output = 0, cacheRead = 0, total = null }) {
  const tokens = {
    input,
    output,
    cache_read: cacheRead,
    total: total == null ? input + output + cacheRead : total,
  };
  return {
    name,
    reported_at: reportedAt,
    runtime: { type: 'claude_code', version: '2.1.119', status: 'running' },
    usage: {
      claude_code: {
        supported: true,
        source: 'transcript',
        sampled_at: sampledAt,
        session_id: session,
        model: 'claude-opus-4-6',
        session_tokens: tokens,
        last_turn_tokens: tokens,
        estimated_cost: true,
      },
    },
  };
}

describe('observed last-turn token usage', () => {
  const window = { start_ms: 1000, end_ms: 5000 };

  it('sums unique last-turn samples inside the selected window', () => {
    const result = buildObservedUsageFromHistory([
      healthRow({ reportedAt: 900, input: 70, output: 10, cacheRead: 20 }),
      healthRow({ reportedAt: 2000, input: 100, output: 20, cacheRead: 40 }),
      healthRow({ reportedAt: 4000, input: 130, output: 30, cacheRead: 60 }),
    ], window);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'agent-a',
      input: 230,
      output: 50,
      cache_read: 100,
      total: 380,
      partial_baseline: false,
      turn_count: 2,
    });
  });

  it('deduplicates repeated health reports for the same last turn', () => {
    const result = buildObservedUsageFromHistory([
      healthRow({ name: 'agent-b', reportedAt: 2000, sampledAt: 1800, input: 300, output: 50, cacheRead: 150 }),
      healthRow({ name: 'agent-b', reportedAt: 2600, sampledAt: 1800, input: 300, output: 50, cacheRead: 150 }),
      healthRow({ name: 'agent-b', reportedAt: 3500, sampledAt: 3400, input: 60, output: 20, cacheRead: 70 }),
    ], window);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'agent-b',
      input: 360,
      output: 70,
      cache_read: 220,
      total: 650,
      turn_count: 2,
    });
  });

  it('keeps usage from multiple sessions for the same agent', () => {
    const result = buildObservedUsageFromHistory([
      healthRow({ reportedAt: 900, session: 'old', input: 80, output: 20, total: 100 }),
      healthRow({ reportedAt: 2000, session: 'old', input: 140, output: 40, total: 180 }),
      healthRow({ reportedAt: 3000, session: 'new', input: 15, output: 5, total: 20 }),
      healthRow({ reportedAt: 4500, session: 'new', input: 55, output: 15, total: 70 }),
    ], window);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'agent-a',
      input: 210,
      output: 60,
      total: 270,
      turn_count: 3,
    });
  });

  it('is unaffected by non-monotonic session counters', () => {
    const result = buildObservedUsageFromHistory([
      healthRow({ name: 'agent-c', reportedAt: 2000, session: null, input: 160, output: 40, total: 200 }),
      healthRow({ name: 'agent-c', reportedAt: 3000, session: null, input: 96, output: 24, total: 120 }),
      healthRow({ name: 'agent-c', reportedAt: 4500, session: null, input: 176, output: 44, total: 220 }),
    ], window);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'agent-c',
      input: 432,
      output: 108,
      total: 540,
      turn_count: 3,
    });
  });
});
