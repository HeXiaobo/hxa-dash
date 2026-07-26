import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.join(process.cwd(), 'public/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(process.cwd(), 'public/js/app.js'), 'utf8');

describe('primary navigation', () => {
  it('shows only the five requested menu entries in the requested order', () => {
    const nav = html.match(/<nav id="main-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    const labels = [...nav.matchAll(/<a [^>]*class="nav-item[^"]*"[^>]*>([^<]+)<\/a>/g)]
      .map(match => match[1].trim());

    expect(labels).toEqual(['AI 员工', '额度', 'Token 用量', '备份', '系统健康']);
    expect(nav).not.toContain('更多');
    expect(nav).not.toContain('任务');
    expect(nav).not.toContain('协作');
    expect(nav).not.toContain('我的视图');
  });

  it('routes every visible menu item directly to its intended page', () => {
    expect(html).toContain('href="#team" class="nav-item active" data-page="team" data-target="team"');
    expect(html).toContain('href="#analysis/limits" class="nav-item" data-page="analysis" data-target="limits"');
    expect(html).toContain('href="#analysis/tokens" class="nav-item" data-page="analysis" data-target="tokens"');
    expect(html).toContain('href="#backups" class="nav-item" data-page="backups" data-target="backups"');
    expect(html).toContain('href="#system" class="nav-item" data-page="system" data-target="health"');
    expect(html).not.toContain('class="sub-tabs');
  });

  it('uses AI employees as the default page and supports direct nav targets', () => {
    expect(appSource).toContain("location.hash.replace('#', '') || 'team'");
    expect(appSource).toContain('item.dataset.target || (cfg ? cfg.default : group)');
    expect(appSource).toContain('const isActive = navTarget === page');
    expect(html).toContain('<div id="page-team" class="page active">');
    expect(html).toContain('<div id="page-overview" class="page">');
  });
});
