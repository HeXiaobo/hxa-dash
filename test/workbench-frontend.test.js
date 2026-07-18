import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildFrontendDocumentResponse,
  frontendDocumentForPath,
  hydrateFrontendDocument,
} = require('../src/frontend-document.js');

describe('AI employee workbench frontend contract', () => {
  it('serves the workbench at the primary entry and preserves the classic dashboard', () => {
    expect(frontendDocumentForPath('/')).toBe('workbench.html');
    expect(frontendDocumentForPath('/index.html')).toBe('workbench.html');
    expect(frontendDocumentForPath('/workbench')).toBe('workbench.html');
    expect(frontendDocumentForPath('/workbench.html')).toBe('workbench.html');
    expect(frontendDocumentForPath('/classic')).toBe('index.html');
    expect(frontendDocumentForPath('/missing')).toBeNull();

    const rendered = hydrateFrontendDocument(
      '<html data-base="__BASE_PATH__"><a href="__BASE_PATH__/classic"></a><script src="__ASSET_ROOT__/js/workbench-live.js"></script></html>',
      { browserBase: '/hxa-dash' },
    );
    expect(rendered).toContain('data-base="/hxa-dash"');
    expect(rendered).toContain('href="/hxa-dash/classic"');
    expect(rendered).toContain('src="/hxa-dash/js/workbench-live.js"');
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
  });

  it('marks every routed frontend document as non-cacheable', () => {
    const response = buildFrontendDocumentResponse(
      '/workbench',
      documentName => `<html data-document="${documentName}">__BASE_PATH__</html>`,
      { browserBase: '/hxa-dash' },
    );

    expect(response).toEqual({
      documentName: 'workbench.html',
      cacheControl: 'no-store',
      body: '<html data-document="workbench.html">/hxa-dash</html>',
    });
    expect(buildFrontendDocumentResponse('/missing', () => 'unused')).toBeNull();
  });

  it('keeps the accepted six-entry workbench navigation and a safe classic fallback', () => {
    const html = fs.readFileSync(path.resolve('public/workbench.html'), 'utf8');
    const classicApp = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
    const navigation = [...html.matchAll(/<button[^>]+data-nav="([^"]+)"/g)].map(match => match[1]);
    const views = [...html.matchAll(/<section[^>]+data-view="([^"]+)"/g)].map(match => match[1]);

    expect(navigation).toEqual(['home', 'employees', 'tasks', 'quota', 'tokens', 'backups']);
    expect(views).toEqual(['home', 'employees', 'tasks', 'quota', 'tokens', 'backups', 'detail']);
    expect(html).toContain('href="__BASE_PATH__/classic"');
    expect(html).toContain('action="__BASE_PATH__/auth/logout"');
    for (const id of [
      'backup-home-title',
      'backup-home-time',
      'backup-home-sync',
      'backup-page-latest',
      'backup-page-sync',
      'backup-page-restore',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toMatch(/低保真|示例数据|不连接真实数据/);
    expect(classicApp).toContain('counter_evidence_complete');
    expect(classicApp).toContain('同步计数暂不可用');
    expect(classicApp).toContain("backup_success_in_future: '最近成功备份时间晚于采集时间'");
    expect(classicApp).toContain('<td>${esc(this._backupLastSuccessText(r))}</td>');
    expect(classicApp).toContain("return last ? this._timeAgoText(last) : '暂不可用';");
    expect(classicApp).not.toContain('this._backupLastSuccessAt(r) || this._backupCheckedAt(r)');
    expect(classicApp).not.toContain('.filter(a => a.backup || a.github_backup || a.backups)');
  });

  it('provides one employee-detail DOM slot for every observable value and its evidence', () => {
    const html = fs.readFileSync(path.resolve('public/workbench.html'), 'utf8');
    const valueIds = [
      'detail-5h',
      'detail-7d',
      'detail-rank',
      'detail-context',
      'detail-session-tokens',
      'detail-cost',
      'detail-runtime-evidence',
      'detail-model',
      'detail-pending-restart',
      'detail-backup-status',
      'detail-backup-last-success',
      'detail-backup-remote',
      'detail-backup-restore',
      'detail-activity',
    ];

    for (const id of valueIds) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`id="${id}-meta"`);
    }
    expect(html).toContain('7 天可比 Token 排行');
    expect(html).toContain('单次会话 Token');
    expect(html).toContain('累计美元成本');
    expect(html).toContain('仅展示，不参与调度');
    expect(html).toContain('renderEmployeeDetail');
  });

  it('keeps the browser acceptance fixture explicitly synthetic', () => {
    const fixtureServer = fs.readFileSync(
      path.resolve('test/fixtures/workbench-fixture-server.cjs'),
      'utf8',
    );
    const fixture = require('./fixtures/workbench-two-node.js').twoNodeWorkbenchSnapshot();

    expect(fixtureServer).toContain('完全合成');
    expect(fixtureServer).not.toContain('历史验收样本');
    expect(fixture.fixture_notice).toContain('Synthetic');
    for (const agent of fixture.team.agents) {
      expect(agent.observability.runtime.version).toContain('fixture');
      expect(agent.observability.model.value).toContain('fixture');
      expect(agent.observability.context.plan_type).toContain('synthetic');
    }
  });

  it('keeps the browser workbench read-only and free of unsafe dynamic HTML sinks', () => {
    const html = fs.readFileSync(path.resolve('public/workbench.html'), 'utf8');
    const live = fs.readFileSync(path.resolve('public/js/workbench-live.js'), 'utf8');
    const model = fs.readFileSync(path.resolve('public/js/workbench-model.js'), 'utf8');
    const browserSurface = `${html}\n${live}\n${model}`;

    expect(browserSurface).not.toMatch(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
    expect(browserSurface).not.toMatch(/\/api\/ingest(?:\/|\b)/);
    expect(browserSurface).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\b(?:href|src|action)\s*=\s*['"]https?:\/\//i);

    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);

    const hydrated = hydrateFrontendDocument(html, { browserBase: '/hxa-dash' });
    expect(hydrated).not.toMatch(/__[A-Z_]+__/);
    expect(live).toContain('.textContent =');
  });
});
