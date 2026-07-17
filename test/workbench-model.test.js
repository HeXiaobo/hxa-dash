import { describe, expect, it } from 'vitest';
import { buildWorkbenchModel } from '../public/js/workbench-model.js';

describe('central AI employee workbench model', () => {
  it('combines fresh central evidence without inventing missing employee data', () => {
    const model = buildWorkbenchModel({
      now: 1_784_280_015_000,
      team: {
        agents: [
          {
            name: 'yueran',
            display_name: '玥然',
            role: '日常工作助理',
            work_state: 'working',
            runtime_status: 'running',
            runtime: { type: 'codex', label: 'Codex', version: '0.144.5' },
            current_tasks: [{ title: '客户交付：三个智能工作台', project: 'delivery' }],
            last_active_at: 1_784_280_000_000,
          },
          {
            name: 'mylos',
            role: '首席 AI 运营官',
            work_state: 'standby',
            runtime_status: 'running',
            runtime: { type: 'claude_code', label: 'Claude Code', version: '2.1.209' },
            current_tasks: [],
            last_active_at: 1_784_279_900_000,
          },
        ],
      },
      limits: {
        timestamp: 1_784_280_010_000,
        agents: [
          {
            name: 'yueran',
            quota: {
              supported: true,
              freshness: { status: 'fresh' },
              primary: { window_minutes: 300, used_percent: 82, resets_at: 1_784_288_000_000 },
              secondary: { window_minutes: 10080, used_percent: 47, resets_at: 1_784_720_000_000 },
            },
          },
        ],
      },
      tokens: {
        observed: {
          supported: true,
          window: {
            start_ms: 1_784_246_400_000,
            end_ms: 1_784_332_800_000,
            start_date: '2026-07-11',
            end_date: '2026-07-17',
            timezone: 'Asia/Shanghai',
          },
          agents: [
            { name: 'yueran', total: 1500, partial_baseline: false },
            { name: 'mylos', total: 900, partial_baseline: false },
          ],
        },
      },
      backups: {
        timestamp: 1_784_280_020_000,
        agents: [
          { name: 'yueran', summary: { supported: true, status: 'ok', last_success_at: 1_784_276_400_000, expected_match: true, ahead: 0, behind: 0, dirty: 0, untracked: 0 } },
        ],
      },
      agentStates: {
        timestamp: 1_784_280_015_000,
        states: [
          {
            name: 'yueran',
            state: {
              source: 'dashboard_api',
              status: 'fresh',
              observed_at: 1_784_280_014_000,
              freshness_ms: 1_000,
              stale: false,
              payload: { agent: { state: 'BUSY' } },
            },
          },
        ],
      },
    });

    expect(model.employees).toHaveLength(22);
    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({
      name: '玥然',
      state: '工作中',
      task: '业务任务源待接入',
      q5: 82,
      q7: 47,
      tokens: 1500,
      rank: 1,
      runtime: 'Codex',
      version: 'Codex 0.144.5',
      observed: true,
    });
    expect(yueran.q5Reset).toBe('2026-07-17T11:33:20.000Z');

    const mylos = model.employees.find(employee => employee.id === 'mylos');
    expect(mylos).toMatchObject({ state: '待命', q5: null, q7: null, tokens: 900, rank: 2 });

    const hongshu = model.employees.find(employee => employee.id === 'hongshu');
    expect(hongshu).toMatchObject({ state: '暂不可用', q5: null, tokens: null, observed: false });
    expect(model.coverage).toEqual({ quota: 1, tokens: 2, total: 22 });
    expect(model.tokenPeriod).toEqual({
      startDate: '2026-07-11',
      endDate: '2026-07-17',
      timezone: 'Asia/Shanghai',
    });
    expect(model.tasks).toEqual([]);
    expect(model.backup).toMatchObject({ covered: 1, healthy: 1, restoreStatus: 'unverified' });
  });

  it('ages a once-fresh agent state by its observation time on the client', () => {
    const readAt = Date.parse('2026-07-17T02:00:00.000Z');
    const model = buildWorkbenchModel({
      now: readAt + 31_001,
      team: {
        agents: [{ name: 'yueran', work_state: 'standby', runtime_status: 'running' }],
      },
      agentStates: {
        timestamp: new Date(readAt).toISOString(),
        states: [{
          name: 'yueran',
          state: {
            status: 'fresh',
            observed_at: new Date(readAt - 1_000).toISOString(),
            freshness_ms: 1_000,
            stale: false,
            payload: { agent: { state: 'BUSY' } },
          },
        }],
      },
    });

    expect(model.employees.find(employee => employee.id === 'yueran')?.state)
      .toBe('待命');
  });

  it('rejects stale quota, estimated activity tokens, partial baselines, and maintenance tasks', () => {
    const model = buildWorkbenchModel({
      team: {
        agents: [{
          name: 'yueran',
          work_state: 'working',
          runtime_status: 'running',
          runtime: { type: 'codex', label: 'Codex', version: '0.144.5' },
          current_tasks: [
            { title: '部署 Dashboard 并重启服务', project: 'internal-maintenance' },
            { title: '客户案例交付', project: 'delivery' },
          ],
        }],
      },
      limits: {
        agents: [{
          name: 'yueran',
          quota: {
            supported: true,
            freshness: { status: 'stale' },
            primary: { window_minutes: 300, used_percent: 99 },
          },
        }],
      },
      tokens: {
        estimated: true,
        agents: [{ name: 'yueran', total: 999999 }],
        observed: {
          supported: true,
          agents: [{ name: 'yueran', total: 1234, partial_baseline: true }],
        },
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran.q5).toBeNull();
    expect(yueran.tokens).toBeNull();
    expect(yueran.rank).toBeNull();
    expect(yueran.task).toBe('业务任务源待接入');
    expect(model.coverage).toEqual({ quota: 0, tokens: 0, total: 22 });
  });

  it('keeps null, blank, and boolean evidence unavailable instead of coercing it to zero', () => {
    const model = buildWorkbenchModel({
      team: { agents: [{ name: 'yueran', work_state: 'standby' }] },
      limits: {
        agents: [{
          name: 'yueran',
          quota: {
            supported: true,
            freshness: { status: 'fresh' },
            primary: { window_minutes: 300, used_percent: 25 },
            secondary: { window_minutes: 10080, used_percent: false },
          },
        }],
      },
      tokens: {
        observed: {
          supported: true,
          window: { start_date: '2026-07-11', end_date: '2026-07-17', timezone: 'Asia/Shanghai' },
          agents: [{ name: 'yueran', total: ' ' }],
        },
      },
      backups: {
        agents: [{
          name: 'yueran',
          summary: {
            supported: true,
            status: 'ok',
            expected_match: true,
            ahead: null,
            behind: 0,
            dirty: 0,
            untracked: 0,
          },
        }],
      },
    });

    const yueran = model.employees.find(employee => employee.id === 'yueran');
    expect(yueran).toMatchObject({ q5: 25, q7: null, tokens: null });
    expect(model.coverage).toEqual({ quota: 1, tokens: 0, total: 22 });
    expect(model.backup.synchronized).toBe(0);
  });
});
