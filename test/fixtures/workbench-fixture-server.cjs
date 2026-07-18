const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { hydrateFrontendDocument } = require('../../src/frontend-document.js');
const { twoNodeWorkbenchSnapshot } = require('./workbench-two-node.js');

const projectRoot = path.resolve(__dirname, '../..');
let fixtureMode = 'fresh';

function send(response, status, contentType, body) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
  });
  response.end(body);
}

function sendJson(response, value) {
  send(response, 200, 'application/json; charset=utf-8', JSON.stringify(value));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    fixtureMode = url.searchParams.get('mode') === 'stale' ? 'stale' : 'fresh';
  }
  const sampledAt = fixtureMode === 'stale'
    ? Date.now() - 10 * 60 * 1000 - 1
    : Date.now() - 1_000;
  const snapshot = twoNodeWorkbenchSnapshot({ sampledAt });
  if (url.pathname === '/') {
    const template = fs.readFileSync(path.join(projectRoot, 'public/workbench.html'), 'utf8');
    const notice = `<div id="fixture-notice" data-mode="${fixtureMode}" style="padding:10px 16px;background:#FEF3C7;color:#92400E;text-align:center;font-weight:700">隔离测试夹具：数值完全合成，仅用于页面渲染测试，不代表任何当前或历史运行状态。当前模式：${fixtureMode === 'stale' ? '过期退化' : '新鲜链路'}。</div>`;
    const html = hydrateFrontendDocument(template).replace('<body>', `<body>${notice}`);
    return send(response, 200, 'text/html; charset=utf-8', html);
  }
  if (url.pathname === '/js/workbench-live.js' || url.pathname === '/js/workbench-model.js') {
    const filePath = path.join(projectRoot, 'public', url.pathname);
    return send(response, 200, 'text/javascript; charset=utf-8', fs.readFileSync(filePath));
  }
  if (url.pathname === '/api/team') return sendJson(response, snapshot.team);
  if (url.pathname === '/api/limits') return sendJson(response, { agents: [] });
  if (url.pathname === '/api/tokens') return sendJson(response, snapshot.tokens);
  if (url.pathname === '/api/backups') return sendJson(response, { agents: [] });
  if (url.pathname === '/api/agent-state') return sendJson(response, { states: [] });
  if (url.pathname === '/api/about') return sendJson(response, { version: 'fixture-only' });
  return send(response, 404, 'text/plain; charset=utf-8', 'not found');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({
    url: `http://127.0.0.1:${address.port}/`,
    fixture: true,
  })}\n`);
});
