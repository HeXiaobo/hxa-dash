import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../src/db.js');
const reportRoutes = require('../src/routes/report.js');
const {
  REDACTED,
  MAX_DEPTH,
  redactSecretShapedDeep,
} = require('../src/secret-shapes.js');

// ⚠️ Every credential-shaped string below is a SYNTHETIC FIXTURE (repeated
// filler + the public jwt.io sample), never a real key. A secret scanner WILL
// flag this file; that is expected and is not a leak. Same convention as
// test/secret-shapes.test.js and test/backups.test.js.
//
// PROVENANCE: P1 (61a763f) wired the credential guard into agent-health and
// agent-state only. Veda's re-verification refused to sign it because report.js
// — /api/report, /api/report/activity, /api/webhook/connect — was not wired at
// all, so those three bodies were stored verbatim and rendered on the homepage.
// This suite is the regression fence for that gap: it must fail if any of the
// three entry points loses its guard.
const SK = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA';
const GHP = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const AIZA = 'AIzaSyCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PEM = '-----BEGIN RSA PRIVATE KEY-----';

// Fragments that must never appear in stored state, whatever the shape of the
// payload that carried them.
const FRAGMENTS = ['sk-ant', 'ghp_', 'AIza', 'eyJhbGciOi', 'BEGIN RSA'];

async function startApi() {
  const app = express();
  app.use(express.json());
  app.use('/api', reportRoutes.router);
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    }),
  };
}

function post(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The homepage renders agents + timeline, so "did anything leak" is answered by
// serializing everything a viewer could see.
function visibleState() {
  return JSON.stringify({
    agents: db.getAllAgents(),
    timeline: db.getTimeline(500),
    board: db.getTasksByState(),
  });
}

function expectNoFragments(serialized) {
  for (const fragment of FRAGMENTS) {
    expect(serialized, `leaked fragment: ${fragment}`).not.toContain(fragment);
  }
}

let api;

beforeEach(async () => {
  // Ingest auth is off by default; assert that rather than depend on load order.
  delete process.env.HXA_AUTH_ENABLED;
  api = await startApi();
});

afterEach(async () => {
  await api.close();
  vi.restoreAllMocks();
});

describe('POST /api/report — credential guard', () => {
  it('redacts status, current_task and the agent name itself', async () => {
    const res = await post(api.baseUrl, '/api/report', {
      name: 'report-guard-1',
      status: SK,
      current_task: GHP,
    });
    expect(res.status).toBe(200);

    const agent = db.getAgent('report-guard-1');
    expect(agent.status).toBe(REDACTED);
    expect(agent.current_task).toBe(REDACTED);
    // current_task is copied into the timeline entry title — the homepage path.
    const event = db.getTimeline(500).find(e => e.agent === 'report-guard-1');
    expect(event.target_title).toBe(REDACTED);
    expectNoFragments(visibleState());
  });

  it('redacts a credential-shaped name into the marker instead of storing it', async () => {
    const res = await post(api.baseUrl, '/api/report', { name: AIZA, status: 'idle' });
    expect(res.status).toBe(200);
    expect(db.getAgent(AIZA)).toBeNull();
    expect(db.getAgent(REDACTED)).not.toBeNull();
    expectNoFragments(visibleState());
  });

  it('recurses into metadata and keeps legitimate sibling fields', async () => {
    await post(api.baseUrl, '/api/report', {
      name: 'report-guard-meta',
      metadata: {
        model: 'claude-opus-5',
        creds: { anthropic: SK, nested: { deeper: JWT } },
        history: ['0.4.2', PEM],
        [GHP]: 'value-under-a-secret-shaped-key',
      },
    });

    const metadata = JSON.parse(db.getAgent('report-guard-meta').metadata);
    // The whole blob is NOT voided — only the offending leaves are.
    expect(metadata.model).toBe('claude-opus-5');
    expect(metadata.creds.anthropic).toBe(REDACTED);
    expect(metadata.creds.nested.deeper).toBe(REDACTED);
    expect(metadata.history[0]).toBe('0.4.2');
    expect(metadata.history[1]).toBe(REDACTED);
    // A secret-shaped KEY is serialized and rendered exactly like a value.
    expect(Object.keys(metadata)).toContain(REDACTED);
    expect(Object.keys(metadata)).not.toContain(GHP);
    expectNoFragments(visibleState());
  });
});

describe('POST /api/webhook/connect — credential guard', () => {
  it('redacts role, bio, name and individual tags', async () => {
    const res = await post(api.baseUrl, '/api/webhook/connect', {
      event: 'bot.online',
      bot: {
        name: 'connect-guard-1',
        role: SK,
        bio: JWT,
        tags: ['ops', GHP, 'delivery'],
      },
    });
    expect(res.status).toBe(200);

    const agent = db.getAgent('connect-guard-1');
    expect(agent.role).toBe(REDACTED);
    expect(agent.bio).toBe(REDACTED);
    // One bad tag must not void the legitimate ones.
    expect(JSON.parse(agent.tags)).toEqual(['ops', REDACTED, 'delivery']);
    expectNoFragments(visibleState());
  });

  it('keeps the credential out of the log line too (canonical: 日志同样过净化)', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await post(api.baseUrl, '/api/webhook/connect', {
      event: 'bot.online',
      bot: { name: AIZA },
    });
    const output = logged.mock.calls.map(args => args.join(' ')).join('\n');
    expect(output).toContain('[Webhook/Connect]');
    expectNoFragments(output);
  });
});

describe('POST /api/report/activity — credential guard', () => {
  it('redacts every free-text event field', async () => {
    const res = await post(api.baseUrl, '/api/report/activity', {
      agent: 'activity-guard-1',
      events: [{
        action: 'message_sent',
        target_type: SK,
        target_title: GHP,
        project: AIZA,
        url: `https://example.com/callback?key=${AIZA}`,
        external_id: `ext:${JWT}`,
      }],
    });
    expect(res.status).toBe(200);

    const event = db.getTimeline(500).find(e => e.agent === 'activity-guard-1');
    expect(event.action).toBe('message_sent');
    expect(event.target_type).toBe(REDACTED);
    expect(event.target_title).toBe(REDACTED);
    expect(event.project).toBe(REDACTED);
    expect(event.url).toBe(REDACTED);
    expect(event.external_id).toBe(REDACTED);
    expectNoFragments(visibleState());
  });

  it('does not leak the agent name or action through the composed external_id', async () => {
    // The fallback external_id interpolates agent + action, so redacting only at
    // the write boundary would have voided the whole id instead of the field.
    await post(api.baseUrl, '/api/report/activity', {
      agent: SK,
      events: [{ action: 'heartbeat' }],
    });
    const event = db.getTimeline(500).find(e => e.action === 'heartbeat' && e.agent === REDACTED);
    expect(event).toBeDefined();
    expect(event.external_id).toMatch(/^ext:\[redacted:secret-shape\]:heartbeat:\d+$/);
    expectNoFragments(visibleState());
  });

  // 🔴 NEGATIVE CASE — the guard turning legitimate telemetry into [redacted] is
  // itself a data defect, and a redaction bug that over-matches would otherwise
  // still pass every assertion above.
  it('leaves a fully legitimate activity payload byte-identical', async () => {
    const legit = {
      action: 'pushed',
      target_type: 'commit',
      target_title: 'fix(security): wire report.js into the credential guard',
      project: 'hxa-dash',
      url: 'https://github.com/HeXiaobo/hxa-dash/pull/27',
      external_id: 'commit:d54946d0c6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    await post(api.baseUrl, '/api/report/activity', {
      agent: 'activity-legit',
      events: [legit],
    });

    const event = db.getTimeline(500).find(e => e.agent === 'activity-legit');
    expect(event.action).toBe(legit.action);
    expect(event.target_type).toBe(legit.target_type);
    expect(event.target_title).toBe(legit.target_title);
    expect(event.project).toBe(legit.project);
    expect(event.url).toBe(legit.url);
    // 40-char lowercase hex sha: inside the base64 alphabet, deliberately NOT matched.
    expect(event.external_id).toBe(legit.external_id);
  });

  it('leaves a legitimate /api/report body untouched', async () => {
    await post(api.baseUrl, '/api/report', {
      name: 'report-legit',
      status: 'working',
      current_task: 'reviewing PR #27',
      metadata: { model: 'claude-opus-5', runtime: 'claude_code', version: '0.4.2' },
    });
    const agent = db.getAgent('report-legit');
    expect(agent.status).toBe('working');
    expect(agent.current_task).toBe('reviewing PR #27');
    expect(JSON.parse(agent.metadata)).toEqual({
      model: 'claude-opus-5',
      runtime: 'claude_code',
      version: '0.4.2',
    });
  });
});

describe('redactSecretShapedDeep', () => {
  it('is idempotent — re-redacting stored state is a no-op', () => {
    const once = redactSecretShapedDeep({ a: SK, b: 'fine' });
    expect(redactSecretShapedDeep(once)).toEqual(once);
  });

  it('passes non-string scalars through untouched', () => {
    expect(redactSecretShapedDeep({ n: 1, b: true, z: null, u: undefined }))
      .toEqual({ n: 1, b: true, z: null, u: undefined });
  });

  it('drops below the depth cap rather than passing a value through unredacted', () => {
    // Build a chain deeper than MAX_DEPTH with a secret at the very bottom.
    let deep = SK;
    for (let i = 0; i <= MAX_DEPTH; i += 1) deep = { next: deep };
    expectNoFragments(JSON.stringify(redactSecretShapedDeep(deep)));
  });
});
