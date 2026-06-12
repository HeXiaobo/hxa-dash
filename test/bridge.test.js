import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeConfig, DEFAULT_CONFIG } = require('../src/bridge/config.js');
const { parseCommand } = require('../src/bridge/parser.js');
const { shouldIgnoreSender, evaluatePolicy } = require('../src/bridge/policy.js');
const { BridgeAuditStore } = require('../src/bridge/audit-store.js');
const { handleBridgeEvent } = require('../src/bridge/handler.js');

let tmp;
let store;

function config(overrides = {}) {
  return mergeConfig(DEFAULT_CONFIG, {
    enabled: true,
    dry_run: true,
    feishu: {
      allowed_chat_ids: ['oc_allowed'],
      allowed_sender_ids: ['ou_owner'],
      command_allowed_sender_ids: {
        issue: ['ou_owner'],
        comment: ['ou_owner'],
        codex: ['ou_owner'],
      },
    },
    ...overrides,
  });
}

function event(overrides = {}) {
  return {
    chat_id: 'oc_allowed',
    message_id: 'om_1',
    sender_id: 'ou_owner',
    sender_type: 'user',
    sender_name: 'Owner',
    content: '/issue Test title\nTest body',
    created_at: 1781147600000,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hxa-bridge-'));
  store = new BridgeAuditStore(join(tmp, 'bridge.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('bridge command parser', () => {
  it('parses issue, comment, and codex commands', () => {
    expect(parseCommand('/issue Fix thing\nMore context')).toMatchObject({
      name: 'issue',
      title: 'Fix thing',
      body: 'More context',
    });
    expect(parseCommand('/comment #42 looks good')).toMatchObject({
      name: 'comment',
      issueNumber: 42,
      body: 'looks good',
    });
    expect(parseCommand('/codex Build bridge\nAcceptance')).toMatchObject({
      name: 'codex',
      title: 'Build bridge',
      body: 'Acceptance',
    });
  });
});

describe('bridge policy', () => {
  it('ignores self and app/bot senders before command parsing', () => {
    const cfg = config({ feishu: { bridge_bot_sender_ids: ['cli_bridge'] } });
    expect(shouldIgnoreSender(event({ sender_id: 'cli_bridge' }), cfg)).toMatchObject({ ignored: true });
    expect(shouldIgnoreSender(event({ sender_type: 'app' }), cfg)).toMatchObject({ ignored: true });
    expect(shouldIgnoreSender(event(), cfg)).toMatchObject({ ignored: false });
  });

  it('requires command-level sender allowlists', () => {
    const cfg = config();
    const command = parseCommand('/codex Build bridge\nShip it');
    expect(evaluatePolicy(event(), command, cfg)).toMatchObject({ ok: true });
    expect(evaluatePolicy(event({ sender_id: 'ou_other' }), command, cfg)).toMatchObject({
      ok: false,
      reason: 'sender_not_allowed',
    });
  });
});

describe('bridge handler', () => {
  it('reserves message_id before dry-run completion', async () => {
    const result = await handleBridgeEvent(event(), {
      config: config(),
      store,
      writer: {},
      now: () => 1000,
    });

    expect(result.action).toBe('dry_run');
    expect(store.get('om_1')).toMatchObject({
      message_id: 'om_1',
      status: 'dry_run',
      command: 'issue',
    });
  });

  it('does not create duplicate GitHub writes for duplicate events', async () => {
    const cfg = config({ dry_run: false });
    const writer = {
      calls: 0,
      async createIssue() {
        this.calls += 1;
        return { number: 123, html_url: 'https://github.example/issues/123' };
      },
    };

    const first = await handleBridgeEvent(event(), { config: cfg, store, writer, now: () => 1000 });
    const second = await handleBridgeEvent(event(), { config: cfg, store, writer, now: () => 2000 });

    expect(first.action).toBe('created_issue');
    expect(second.action).toBe('duplicate');
    expect(writer.calls).toBe(1);
    expect(second.ack).toContain('#123');
  });

  it('does not acknowledge bot-originated messages', async () => {
    const result = await handleBridgeEvent(event({ sender_type: 'bot' }), {
      config: config(),
      store,
      writer: {},
    });

    expect(result).toMatchObject({
      action: 'ignored',
      acknowledge: false,
    });
  });
});
