import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const tokenRoute = require('../src/routes/tokens.js');
const { buildObservedUsage, buildObservedUsageFromHistory } = tokenRoute.__private;

function loadClassicTokenDashboard(document) {
  const source = fs.readFileSync(
    new URL('../public/js/components/token-dashboard.js', import.meta.url),
    'utf8',
  );
  const context = vm.createContext({ document, globalThis: null });
  context.globalThis = context;
  vm.runInContext(`${source}\n;globalThis.__tokenDashboard = TokenDashboard;`, context);
  return context.__tokenDashboard;
}

function healthRow({ name = 'agent-a', reportedAt, sampledAt = reportedAt, session = 'session-a', source = 'transcript', model = 'synthetic-model-a', planType = 'test-plan', input = 0, output = 0, cacheRead = 0, total = null }) {
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
        source,
        sampled_at: sampledAt,
        session_id: session,
        model,
        plan_type: planType,
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

  it('does not duplicate a turn when later reports only enrich model or plan metadata', () => {
    const result = buildObservedUsageFromHistory([
      healthRow({ reportedAt: 2000, sampledAt: 1800, model: null, planType: null, input: 30, output: 10 }),
      healthRow({ reportedAt: 2600, sampledAt: 1800, model: 'synthetic-model-b', planType: 'test-plan-plus', input: 30, output: 10 }),
    ], window);

    expect(result.agents[0]).toMatchObject({ total: 40, turn_count: 1 });
  });

  it('rejects history rows without a genuine usage time or allowlisted source', () => {
    const result = buildObservedUsage(window, {
      historyRows: [
        healthRow({ reportedAt: 2000, sampledAt: null, input: 100 }),
        healthRow({ reportedAt: 2600, sampledAt: null, input: 100 }),
        healthRow({ reportedAt: 3000, source: 'browser_guess', input: 200 }),
      ],
      currentAgents: [],
    });

    expect(result).toMatchObject({
      supported: false,
      comparable: false,
      comparability: 'unavailable',
      sampled_at: null,
      unavailable_reason: 'not_reported',
    });
    expect(result.agents).toEqual([]);
  });

  it('rejects source samples that are materially later than their central observation', () => {
    const futureWindow = { start_ms: 1000, end_ms: 10_000 };
    const result = buildObservedUsage(futureWindow, {
      historyRows: [
        healthRow({ reportedAt: 2000, sampledAt: 7001, input: 100 }),
      ],
      currentAgents: [{
        name: 'agent-current',
        last_heartbeat_at: 3000,
        runtime: { type: 'codex' },
        usage: {
          supported: true,
          source: 'codex',
          sampled_at: 8001,
          session_tokens: { total: 100 },
        },
      }],
    });

    expect(result).toMatchObject({
      supported: false,
      comparable: false,
      sampled_at: null,
      observed_at: null,
      unavailable_reason: 'not_reported',
    });
    expect(result.agents).toEqual([]);
  });

  it('rejects history rows with invalid central observation times', () => {
    for (const reportedAt of ['3000', false, 0, -1, Number.NaN]) {
      const result = buildObservedUsage(window, {
        historyRows: [
          healthRow({ reportedAt, sampledAt: 3000, input: 1 }),
        ],
        currentAgents: [],
      });

      expect(result).toMatchObject({
        supported: false,
        comparable: false,
        comparability: 'unavailable',
        sampled_at: null,
        observed_at: null,
        unavailable_reason: 'not_reported',
      });
      expect(result.agents).toEqual([]);
    }
  });

  it('accepts lazy history iterables without materializing all rows', () => {
    function* rows() {
      yield healthRow({ name: 'agent-lazy', reportedAt: 2000, input: 90, output: 10, cacheRead: 20 });
      yield healthRow({ name: 'agent-lazy', reportedAt: 3000, input: 40, output: 20, cacheRead: 30 });
    }

    const result = buildObservedUsageFromHistory(rows(), window);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'agent-lazy',
      input: 130,
      output: 30,
      cache_read: 50,
      total: 210,
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

  it('marks history-backed aggregates comparable and exposes the latest accepted source sample time', () => {
    const result = buildObservedUsage(window, {
      historyRows: [
        healthRow({ name: 'agent-a', reportedAt: 2000, sampledAt: 1800, input: 100 }),
        healthRow({ name: 'agent-b', reportedAt: 4200, sampledAt: 4000, output: 50 }),
      ],
      currentAgents: [],
    });

    expect(result).toMatchObject({
      supported: true,
      comparable: true,
      comparability: 'history_last_turns',
      sampled_at: 4000,
      observed_at: 4200,
      unavailable_reason: null,
    });
    expect(result.agents.every(agent => agent.partial_baseline === false)).toBe(true);
  });

  it('rejects current samples when central observed_at is missing or null', () => {
    const currentAgent = {
      name: 'yueran',
      runtime: { type: 'codex' },
      usage: {
        supported: true,
        source: 'codex',
        sampled_at: 3000,
        session_tokens: { input: 80, output: 20, total: 100 },
      },
    };

    for (const agent of [currentAgent, { ...currentAgent, last_heartbeat_at: null }]) {
      const result = buildObservedUsage(window, { historyRows: [], currentAgents: [agent] });
      expect(result).toMatchObject({
        supported: false,
        comparable: false,
        comparability: 'unavailable',
        sampled_at: null,
        observed_at: null,
        unavailable_reason: 'not_reported',
        agents: [],
      });
    }
  });

  it('keeps the no-history session snapshot visible to legacy consumers but explicitly non-comparable', () => {
    const result = buildObservedUsage(window, {
      historyRows: [],
      currentAgents: [{
        name: 'yueran',
        last_heartbeat_at: 3200,
        runtime: { type: 'codex' },
        usage: {
          supported: true,
          source: 'codex',
          sampled_at: 3000,
          session_tokens: { input: 80, output: 20, total: 100 },
        },
      }],
    });

    expect(result).toMatchObject({
      supported: true,
      comparable: false,
      comparability: 'single_session_snapshot',
      sampled_at: 3000,
      observed_at: 3200,
      unavailable_reason: 'single_session_snapshot_not_comparable',
    });
    expect(result.agents[0]).toMatchObject({
      name: 'yueran',
      total: 100,
      partial_baseline: true,
    });
  });

  it('keeps a non-comparable current-session fallback out of classic totals, distribution, and ranking', () => {
    const observed = buildObservedUsage(window, {
      historyRows: [],
      currentAgents: [{
        name: 'yueran',
        last_heartbeat_at: 3200,
        runtime: { type: 'codex' },
        usage: {
          supported: true,
          source: 'codex',
          sampled_at: 3000,
          session_tokens: { input: 80, output: 20, total: 100 },
        },
      }],
    });
    const elements = Object.fromEntries([
      'token-summary',
      'token-chart',
      'token-agent-table',
      'token-cost-pie',
    ].map(id => [id, {
      innerHTML: '',
      clientWidth: 200,
      querySelector: () => null,
      appendChild(node) { this.appended = node; },
    }]));
    const document = {
      getElementById: id => elements[id] || null,
      createElement: () => ({
        getContext: () => ({
          clearRect() {}, beginPath() {}, arc() {}, closePath() {}, fill() {}, fillText() {},
        }),
      }),
    };
    const dashboard = loadClassicTokenDashboard(document);
    dashboard._data = { observed };

    expect(dashboard._hasObserved()).toBe(false);
    dashboard._renderSummary();
    dashboard._renderChart();
    dashboard._renderAgentTable();
    dashboard._renderCostPie();

    for (const element of Object.values(elements)) {
      expect(element.innerHTML).toContain('单次会话快照');
      expect(element.innerHTML).toContain('不可用于时间段汇总或排名');
      expect(element.innerHTML).not.toContain('yueran');
      expect(element.appended).toBeUndefined();
    }
  });
});
