#!/usr/bin/env node
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRuntimeEnv } = require('../src/env.js');
const { loadBridgeConfig } = require('../src/bridge/config.js');
const { BridgeAuditStore } = require('../src/bridge/audit-store.js');
const { GitHubWriter } = require('../src/bridge/github-writer.js');
const { handleBridgeEvent } = require('../src/bridge/handler.js');

loadRuntimeEnv();

function parseContent(raw) {
  if (!raw) return '';
  if (typeof raw !== 'string') return String(raw);
  try {
    const parsed = JSON.parse(raw);
    return parsed.text || parsed.content || raw;
  } catch (_) {
    return raw;
  }
}

function normalizeFeishuEvent(raw) {
  const event = raw.event || raw;
  const message = event.message || event;
  const sender = event.sender || message.sender || {};
  return {
    chat_id: message.chat_id || event.chat_id,
    message_id: message.message_id || event.message_id,
    sender_id: sender.sender_id?.open_id || sender.id || event.sender_id || message.sender_id,
    sender_type: sender.sender_type || event.sender_type || 'user',
    sender_name: sender.name || sender.sender_name || event.sender_name || '',
    message_type: message.message_type || message.msg_type || event.message_type || 'text',
    content: parseContent(message.content || event.content),
    message_link: message.message_link || event.message_link || '',
    created_at: Number(message.create_time || event.create_time || Date.now()),
  };
}

async function sendAck(event, text) {
  if (!text || !event.chat_id) return;
  await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', [
      'im',
      '+messages-send',
      '--chat-id',
      event.chat_id,
      '--text',
      text,
      '--idempotency-key',
      `hxa-bridge-ack-${event.message_id}`,
      '--format',
      'json',
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`lark-cli ack exited ${code}`))));
    child.on('error', reject);
  });
}

async function processStream(stream, context) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const event = normalizeFeishuEvent(JSON.parse(line));
      const result = await handleBridgeEvent(event, context);
      if (result.acknowledge) await sendAck(event, result.ack);
      console.log(JSON.stringify({ ok: true, action: result.action, message_id: event.message_id }));
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: err.message }));
    }
  }
}

async function main() {
  const config = loadBridgeConfig();
  const store = new BridgeAuditStore(process.env.HXA_BRIDGE_DB_PATH);
  const writer = new GitHubWriter(config);
  const context = { config, store, writer };

  if (process.argv.includes('--stdin')) {
    await processStream(process.stdin, context);
    store.close();
    return;
  }

  const child = spawn('lark-cli', ['event', 'consume', 'im.message.receive_v1'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await processStream(child.stdout, context);
  store.close();
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 1;
});
