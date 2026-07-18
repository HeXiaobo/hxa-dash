import { describe, expect, it, vi } from 'vitest';
import {
  applyWorkbenchModel,
  applyEmployeeDetail,
  buildEmployeeDetailPresentation,
  buildWorkbenchPresentation,
  classicRedirectForHash,
  createWorkbenchRefreshController,
  createWorkbenchSnapshotPresenter,
  fetchWorkbenchSnapshot,
  formatTokenPeriod,
  mergeWorkbenchSnapshots,
  modelFromSnapshot,
  scheduleWorkbenchRefresh,
} from '../public/js/workbench-live.js';
import {
  TWO_NODE_SAMPLED_AT,
  twoNodeWorkbenchSnapshot,
} from './fixtures/workbench-two-node.js';

describe('central workbench live adapter', () => {
  it('reads only authenticated central endpoints under the browser base path', async () => {
    const calls = [];
    const payloads = new Map([
      ['/hxa-dash/api/team', { agents: [] }],
      ['/hxa-dash/api/limits', { agents: [] }],
      ['/hxa-dash/api/tokens?days=7', { observed: { supported: false, agents: [] } }],
      ['/hxa-dash/api/backups', { agents: [] }],
      ['/hxa-dash/api/agent-state', { states: [] }],
      ['/hxa-dash/api/about', { version: '0.1.0' }],
    ]);
    const fakeFetch = async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => payloads.get(url) };
    };

    const snapshot = await fetchWorkbenchSnapshot(fakeFetch, '/hxa-dash');

    expect(calls.map(call => call.url)).toEqual([...payloads.keys()]);
    expect(calls.every(call => call.options.method === 'GET')).toBe(true);
    expect(calls.every(call => call.options.credentials === 'same-origin')).toBe(true);
    expect(calls.every(call => call.options.cache === 'no-store')).toBe(true);
    expect(calls.every(call => !/\/(?:auth|report|webhook|auto-assign)(?:\/|$)/.test(call.url))).toBe(true);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.team).toEqual({ agents: [] });
    expect(modelFromSnapshot(snapshot).employees).toHaveLength(22);
  });

  it('keeps two-node detail evidence and seven-day ranking visibly separate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(TWO_NODE_SAMPLED_AT + 1_000);
    try {
      const model = modelFromSnapshot(twoNodeWorkbenchSnapshot());
      const yueran = buildEmployeeDetailPresentation(
        model.employees.find(employee => employee.id === 'yueran'),
      );
      const mylos = buildEmployeeDetailPresentation(
        model.employees.find(employee => employee.id === 'mylos'),
      );

      expect(yueran).toMatchObject({
        runtime: { value: 'Codex 9.9.1-fixture' },
        model: { value: 'codex-fixture-alpha' },
        pendingRestart: { value: '暂不可用' },
        context: { value: '已用 61.2% · 剩余 38.8% · 当前上下文 120,000 Token' },
        quotaFiveHour: { value: '暂不可用' },
        quotaSevenDay: { value: '已用 23%' },
        sessionTokens: { value: '321,000 Token（单次会话累计）' },
        cumulativeCost: { value: '暂不可用' },
        comparableTokenRank: { value: '第 1 名 · 4,200 Token（7 天可比口径）' },
        backupStatus: { value: '暂不可用' },
        activity: { value: '暂不可用' },
      });
      expect(yueran.quotaFiveHour.meta).toContain('不可用原因：对应额度窗口未上报');
      expect(yueran.cumulativeCost.meta).toContain('不可用原因：未上报');
      expect(yueran.sessionTokens.meta).toContain('来源：Codex 本机记录（codex）');
      expect(yueran.comparableTokenRank.meta).toContain('中央确认：');

      expect(mylos).toMatchObject({
        runtime: { value: 'Claude Code 8.8.2-fixture' },
        model: { value: 'claude-fixture-beta' },
        pendingRestart: { value: '暂不可用' },
        context: { value: '已用 27.5% · 剩余 72.5%' },
        quotaFiveHour: { value: '已用 7%' },
        quotaSevenDay: { value: '已用 41%' },
        sessionTokens: { value: '650,100 Token（单次会话累计）' },
        cumulativeCost: { value: 'US$12.34（单次会话累计，估算）' },
        comparableTokenRank: { value: '第 2 名 · 2,100 Token（7 天可比口径）' },
        backupStatus: { value: '本机备份记录正常' },
        backupLastSuccess: { value: '暂不可用' },
        backupRemoteMatch: { value: '暂不可用' },
        backupRestoreDrill: { value: '暂不可用' },
        activity: { value: '待命 · 健康正常 · 仅展示，不参与调度' },
      });
      expect(mylos.activity.meta).toContain('来源：活跃度监控补充（activity_monitor_fallback）');
      expect(mylos.activity.meta).toContain('不可用原因：无');
      expect(mylos.backupRestoreDrill.meta).toContain('不可用原因：三项备份证据未齐');
      expect(mylos.sessionTokens.value).not.toContain('2,100');
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes both nodes into the employee-detail DOM with provenance and unavailable reasons', () => {
    vi.useFakeTimers();
    vi.setSystemTime(TWO_NODE_SAMPLED_AT + 1_000);
    const detailKeys = [
      'quotaFiveHour',
      'quotaSevenDay',
      'comparableTokenRank',
      'context',
      'sessionTokens',
      'cumulativeCost',
      'runtime',
      'model',
      'pendingRestart',
      'backupStatus',
      'backupLastSuccess',
      'backupRemoteMatch',
      'backupRestoreDrill',
      'activity',
    ];
    const idForKey = {
      quotaFiveHour: 'detail-5h',
      quotaSevenDay: 'detail-7d',
      comparableTokenRank: 'detail-rank',
      context: 'detail-context',
      sessionTokens: 'detail-session-tokens',
      cumulativeCost: 'detail-cost',
      runtime: 'detail-runtime-evidence',
      model: 'detail-model',
      pendingRestart: 'detail-pending-restart',
      backupStatus: 'detail-backup-status',
      backupLastSuccess: 'detail-backup-last-success',
      backupRemoteMatch: 'detail-backup-remote',
      backupRestoreDrill: 'detail-backup-restore',
      activity: 'detail-activity',
    };
    const nodes = {};
    for (const key of detailKeys) {
      const id = idForKey[key];
      nodes[id] = { textContent: '' };
      nodes[`${id}-meta`] = { textContent: '' };
    }
    const documentRef = { getElementById: id => nodes[id] || null };

    try {
      const model = modelFromSnapshot(twoNodeWorkbenchSnapshot());
      const yueran = model.employees.find(employee => employee.id === 'yueran');
      const mylos = model.employees.find(employee => employee.id === 'mylos');

      applyEmployeeDetail(documentRef, yueran);
      expect(nodes['detail-5h'].textContent).toBe('暂不可用');
      expect(nodes['detail-5h-meta'].textContent).toContain('不可用原因：对应额度窗口未上报');
      expect(nodes['detail-session-tokens'].textContent).toBe('321,000 Token（单次会话累计）');
      expect(nodes['detail-rank'].textContent).toBe('第 1 名 · 4,200 Token（7 天可比口径）');
      expect(nodes['detail-cost-meta'].textContent).toContain('不可用原因：未上报');

      applyEmployeeDetail(documentRef, mylos);
      expect(nodes['detail-5h'].textContent).toBe('已用 7%');
      expect(nodes['detail-session-tokens'].textContent).toBe('650,100 Token（单次会话累计）');
      expect(nodes['detail-rank'].textContent).toBe('第 2 名 · 2,100 Token（7 天可比口径）');
      expect(nodes['detail-cost'].textContent).toBe('US$12.34（单次会话累计，估算）');
      expect(nodes['detail-activity'].textContent).toContain('仅展示，不参与调度');
      expect(nodes['detail-activity-meta'].textContent).toContain('不可用原因：无');
      expect(nodes['detail-backup-restore-meta'].textContent).toContain('不可用原因：三项备份证据未齐');
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains that a single-session snapshot cannot be used for the seven-day rank', () => {
    vi.useFakeTimers();
    vi.setSystemTime(TWO_NODE_SAMPLED_AT + 1_000);
    try {
      const snapshot = twoNodeWorkbenchSnapshot();
      snapshot.tokens.observed = {
        ...snapshot.tokens.observed,
        comparable: false,
        comparability: 'single_session_snapshot',
        unavailable_reason: 'single_session_snapshot_not_comparable',
        agents: snapshot.tokens.observed.agents.map(agent => ({
          ...agent,
          partial_baseline: true,
        })),
      };

      const yueran = buildEmployeeDetailPresentation(
        modelFromSnapshot(snapshot).employees.find(employee => employee.id === 'yueran'),
      );

      expect(yueran.comparableTokenRank.value).toBe('暂不可用');
      expect(yueran.comparableTokenRank.meta)
        .toContain('不可用原因：仅有单会话快照，不能用于 7 天排行');
    } finally {
      vi.useRealTimers();
    }
  });

  it('presents backup evidence separately from restore readiness and uses date-window Token copy', () => {
    const presentation = buildWorkbenchPresentation({
      employees: [],
      coverage: { total: 22 },
      backup: {
        covered: 4,
        healthy: 3,
        synchronized: 2,
        latestSuccessAt: '2040-01-15T03:20:00.000Z',
        restoreStatus: 'unverified',
      },
    });

    expect(presentation.backup).toMatchObject({
      covered: 4,
      healthy: 3,
      synchronized: 2,
      restoreLabel: '待验证',
    });
    expect(formatTokenPeriod({
      startDate: '2040-01-09',
      endDate: '2040-01-15',
      timezone: 'Asia/Shanghai',
    })).toBe('统计时段 2040-01-09 至 2040-01-15（Asia/Shanghai）');
    expect(formatTokenPeriod(null)).toBe('统计时段暂不可用');
  });

  it('refreshes live state every 30 seconds without rescanning seven-day Token history', () => {
    const scheduled = [];
    const refreshes = [];
    const fakeSetInterval = (callback, intervalMs) => {
      scheduled.push({ callback, intervalMs });
      return scheduled.length;
    };

    scheduleWorkbenchRefresh(fakeSetInterval, keys => refreshes.push(keys));

    expect(scheduled.map(item => item.intervalMs)).toEqual([30_000, 60_000, 300_000]);
    scheduled.forEach(item => item.callback());
    expect(refreshes).toEqual([
      ['agentStates'],
      ['team', 'limits'],
      ['tokens', 'backups', 'about'],
    ]);
  });

  it('invalidates a requested source when its refresh fails instead of presenting the old value as current', () => {
    const previous = {
      agentStates: {
        states: [{ name: 'yueran', state: { status: 'fresh', payload: { agent: { state: 'BUSY' } } } }],
      },
      team: { agents: [{ name: 'yueran' }] },
      errors: [],
    };

    const snapshot = mergeWorkbenchSnapshots(previous, {
      errors: [{ source: 'agentStates', reason: 'timeout' }],
    }, ['agentStates']);

    expect(snapshot).not.toHaveProperty('agentStates');
    expect(snapshot.team).toEqual(previous.team);
    expect(snapshot.errors).toEqual([{ source: 'agentStates', reason: 'timeout' }]);
    expect(modelFromSnapshot(snapshot).employees.find(employee => employee.id === 'yueran')?.state)
      .toBe('暂不可用');
  });

  it('bounds a hung endpoint request and aborts it visibly', async () => {
    vi.useFakeTimers();
    let requestSignal;
    const hungFetch = (_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };

    try {
      const pending = fetchWorkbenchSnapshot(hungFetch, '', ['agentStates']);
      await vi.advanceTimersByTimeAsync(10_000);
      const snapshot = await pending;

      expect(requestSignal?.aborted).toBe(true);
      expect(snapshot).toEqual({
        errors: [{ source: 'agentStates', reason: 'timeout' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds response body parsing after the endpoint has returned headers', async () => {
    vi.useFakeTimers();
    let requestSignal;
    let snapshot;
    const stalledBodyFetch = (_url, options) => {
      requestSignal = options.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      });
    };

    try {
      fetchWorkbenchSnapshot(stalledBodyFetch, '', ['agentStates'])
        .then(value => { snapshot = value; });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(requestSignal?.aborted).toBe(true);
      expect(snapshot).toEqual({
        errors: [{ source: 'agentStates', reason: 'timeout' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a successful source when another endpoint in the same group times out', async () => {
    vi.useFakeTimers();
    const fakeFetch = url => {
      if (url === '/api/team') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [{ name: 'yueran' }] }) });
      }
      return new Promise(() => {});
    };

    try {
      const pending = fetchWorkbenchSnapshot(fakeFetch, '', ['team', 'limits']);
      await vi.advanceTimersByTimeAsync(10_000);
      const snapshot = await pending;

      expect(snapshot.team).toEqual({ agents: [{ name: 'yueran' }] });
      expect(snapshot).not.toHaveProperty('limits');
      expect(snapshot.errors).toEqual([{ source: 'limits', reason: 'timeout' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets one refresh group complete while another group is still waiting', async () => {
    let finishAgentStates;
    const calls = [];
    const fakeFetch = url => {
      calls.push(url);
      if (url === '/api/agent-state') {
        return new Promise(resolve => {
          finishAgentStates = () => resolve({
            ok: true,
            status: 200,
            json: async () => ({ states: [] }),
          });
        });
      }
      const payload = url === '/api/team' ? { agents: [{ name: 'yueran' }] } : { agents: [] };
      return Promise.resolve({ ok: true, status: 200, json: async () => payload });
    };
    const controller = createWorkbenchRefreshController({ fetchImpl: fakeFetch });

    const slowRefresh = controller.refresh(['agentStates']);
    const fastSnapshot = await controller.refresh(['team', 'limits']);

    expect(calls).toEqual(['/api/agent-state', '/api/team', '/api/limits']);
    expect(fastSnapshot.team).toEqual({ agents: [{ name: 'yueran' }] });
    expect(fastSnapshot.limits).toEqual({ agents: [] });
    expect(fastSnapshot).not.toHaveProperty('agentStates');

    finishAgentStates();
    const completeSnapshot = await slowRefresh;
    expect(completeSnapshot).toMatchObject({ team: fastSnapshot.team, limits: fastSnapshot.limits, agentStates: { states: [] } });
  });

  it('coalesces overlapping refreshes for the same source group', async () => {
    let finish;
    let calls = 0;
    const controller = createWorkbenchRefreshController({
      fetchImpl: () => {
        calls += 1;
        return new Promise(resolve => {
          finish = () => resolve({ ok: true, status: 200, json: async () => ({ states: [] }) });
        });
      },
    });

    const first = controller.refresh(['agentStates']);
    const second = controller.refresh(['agentStates']);

    expect(second).toBe(first);
    expect(calls).toBe(1);
    finish();
    await first;
  });

  it('does not let a late overlapping group overwrite a newer source value', async () => {
    let finishTokens;
    let agentStateCalls = 0;
    const response = payload => ({ ok: true, status: 200, json: async () => payload });
    const controller = createWorkbenchRefreshController({
      fetchImpl: url => {
        if (url === '/api/agent-state') {
          agentStateCalls += 1;
          return Promise.resolve(response({ states: [{ name: agentStateCalls === 1 ? 'old' : 'new' }] }));
        }
        return new Promise(resolve => {
          finishTokens = () => resolve(response({ observed: { supported: false, agents: [] } }));
        });
      },
    });

    const olderGroup = controller.refresh(['agentStates', 'tokens']);
    const newerSnapshot = await controller.refresh(['agentStates']);
    expect(newerSnapshot.agentStates.states).toEqual([{ name: 'new' }]);

    finishTokens();
    const completedSnapshot = await olderGroup;
    expect(completedSnapshot.agentStates.states).toEqual([{ name: 'new' }]);
    expect(completedSnapshot.tokens).toEqual({ observed: { supported: false, agents: [] } });
  });

  it('renders a timed-out source as unavailable and clears the error after recovery', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    let timedOutSignal;
    const rendered = [];
    const controller = createWorkbenchRefreshController({
      initialSnapshot: {
        agentStates: { states: [{ name: 'old' }] },
        errors: [],
      },
      fetchImpl: (_url, options) => {
        attempt += 1;
        if (attempt === 1) {
          timedOutSignal = options.signal;
          return new Promise(() => {});
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ states: [{ name: 'recovered' }] }),
        });
      },
      onSnapshot: snapshot => rendered.push(snapshot),
    });

    try {
      const pending = controller.refresh(['agentStates']);
      await vi.advanceTimersByTimeAsync(10_000);
      const degraded = await pending;
      expect(timedOutSignal?.aborted).toBe(true);
      expect(degraded).not.toHaveProperty('agentStates');
      expect(degraded.errors).toEqual([{ source: 'agentStates', reason: 'timeout' }]);

      const recovered = await controller.refresh(['agentStates']);
      expect(recovered.agentStates.states).toEqual([{ name: 'recovered' }]);
      expect(recovered.errors).toEqual([]);
      expect(rendered).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-presents a snapshot when fresh agent state reaches its local expiry', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2040-01-15T02:00:00.000Z');
    vi.setSystemTime(now);
    const states = [];
    const presenter = createWorkbenchSnapshotPresenter({
      renderSnapshot(snapshot) {
        states.push(modelFromSnapshot(snapshot).employees.find(employee => employee.id === 'yueran')?.state);
      },
    });
    const snapshot = {
      team: { agents: [{ name: 'yueran', work_state: 'standby' }] },
      agentStates: {
        states: [{
          name: 'yueran',
          state: {
            status: 'fresh',
            observed_at: new Date(now - 29_500).toISOString(),
            freshness_ms: 29_500,
            stale: false,
            payload: { agent: { state: 'BUSY' } },
          },
        }],
      },
      errors: [],
    };

    try {
      presenter.present(snapshot);
      expect(states).toEqual(['工作中']);

      await vi.advanceTimersByTimeAsync(501);
      expect(states).toEqual(['工作中', '待命']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes an expired login from a forbidden tenant or identity', () => {
    const renderStatus = reason => {
      const status = { dataset: {}, textContent: '' };
      const main = { textContent: '' };
      const detail = { textContent: '' };
      const message = {
        querySelector(selector) {
          return selector === 'span' ? main : selector === 'small' ? detail : null;
        },
      };
      const documentRef = {
        getElementById(id) {
          if (id === 'workbench-live-status') return status;
          if (id === 'workbench-live-message') return message;
          return null;
        },
      };
      const snapshot = { errors: [{ source: 'team', reason }] };
      applyWorkbenchModel(documentRef, snapshot, modelFromSnapshot(snapshot));
      return { status, main };
    };

    const unauthorized = renderStatus('http_401');
    expect(unauthorized.status.textContent).toBe('登录已失效');
    expect(unauthorized.main.textContent).toContain('请重新登录');

    const forbidden = renderStatus('http_403');
    expect(forbidden.status.textContent).toBe('无权访问');
    expect(forbidden.main.textContent).toContain('租户或权限不匹配');
  });

  it('preserves legacy Dashboard hash links through the classic view', () => {
    expect(classicRedirectForHash('#limits')).toBe('/classic#limits');
    expect(classicRedirectForHash('#analysis/tokens', '/hxa-dash/')).toBe('/hxa-dash/classic#analysis/tokens');
    expect(classicRedirectForHash('')).toBeNull();
    expect(classicRedirectForHash('#')).toBeNull();
  });
});
