#!/usr/bin/env node
// activity-reporter-openclaw.mjs — Activity reporter for OpenClaw agents
// Reads from OpenClaw delivery-queue and task runs instead of C4/scheduler databases.
// Zero npm dependencies.
//
// Usage: node activity-reporter-openclaw.mjs [--dashboard-url URL] [--window-minutes N] [--name BOT_NAME]

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import { execSync } from 'child_process';

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DEFAULT_DASHBOARD = 'https://hxa.zhiw.ai';
const DEFAULT_WINDOW_MIN = 15;

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
const dashboardUrl = getArg('--dashboard-url', DEFAULT_DASHBOARD);
const windowMin = parseInt(getArg('--window-minutes', String(DEFAULT_WINDOW_MIN)));
const overrideName = getArg('--name', null);

function detectBotName() {
  if (overrideName) return overrideName;
  const candidates = [
    path.join(ZYLOS_DIR, 'memory', 'identity.md'),
    path.join(OPENCLAW_DIR, 'identity', 'identity.md'),
  ];
  for (const idPath of candidates) {
    try {
      if (!fs.existsSync(idPath)) continue;
      const content = fs.readFileSync(idPath, 'utf8').slice(0, 500);
      const match = content.match(/I am (\w+)/i);
      if (match) return match[1].toLowerCase();
    } catch {}
  }
  return os.userInfo().username || os.hostname();
}

function readDeliveryQueueActivity(sinceMs) {
  const events = [];
  const queueDir = path.join(OPENCLAW_DIR, 'delivery-queue');
  if (!fs.existsSync(queueDir)) return events;

  let files;
  try {
    files = fs.readdirSync(queueDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const fullPath = path.join(queueDir, f);
        try {
          const stat = fs.statSync(fullPath);
          return { path: fullPath, name: f, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter(f => f && f.mtime >= sinceMs)
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return events; }

  const channelLabels = {
    'hxa-connect': 'HXA',
    'feishu': 'Feishu',
    'lark': 'Feishu',
    'telegram': 'Telegram',
    'web': 'Web',
  };

  const channelCounts = {};

  for (const file of files.slice(0, 100)) {
    try {
      const data = JSON.parse(fs.readFileSync(file.path, 'utf8'));
      const channel = data.channel || 'unknown';
      const ts = data.enqueuedAt || file.mtime;

      if (!channelCounts[channel]) {
        channelCounts[channel] = { count: 0, lastTs: 0 };
      }
      channelCounts[channel].count++;
      if (ts > channelCounts[channel].lastTs) {
        channelCounts[channel].lastTs = ts;
      }
    } catch { continue; }
  }

  for (const [channel, info] of Object.entries(channelCounts)) {
    const label = channelLabels[channel] || channel;
    events.push({
      action: 'sent_message',
      target_type: channel,
      target_title: `sent ${info.count} ${label} message(s)`,
      timestamp: info.lastTs,
      external_id: `ocdq:${channel}:${Math.floor(Date.now() / 60000)}`,
    });
  }

  return events;
}

function readTaskRunsActivity(sinceMs) {
  const events = [];
  const dbPath = path.join(OPENCLAW_DIR, 'tasks', 'runs.sqlite');
  if (!fs.existsSync(dbPath)) return events;

  const sinceSec = Math.floor(sinceMs / 1000);
  try {
    const pythonScript = `import sqlite3,json;c=sqlite3.connect('${dbPath}');c.row_factory=sqlite3.Row;rows=c.execute("SELECT task_id,label,status,created_at,ended_at,last_event_at FROM task_runs WHERE last_event_at>${sinceSec} ORDER BY last_event_at DESC LIMIT 20").fetchall();print(json.dumps([dict(r) for r in rows]))`;
    const out = execSync(`python3 -c "${pythonScript}"`, {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rows = JSON.parse(out || '[]');
    for (const row of rows) {
      events.push({
        action: `task_${row.status || 'unknown'}`,
        target_type: 'openclaw-task',
        target_title: `${row.label || row.task_id} (${row.status})`,
        timestamp: (row.ended_at || row.last_event_at || row.created_at) * 1000,
        external_id: `octr:${row.task_id}:${row.last_event_at}`,
      });
    }
  } catch {}

  return events;
}

function postActivity(agent, events) {
  return new Promise((resolve, reject) => {
    const url = `${dashboardUrl}/api/report/activity`;
    const body = JSON.stringify({ agent, events });
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        else try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const botName = detectBotName();
  const now = Date.now();
  const sinceMs = now - windowMin * 60 * 1000;

  const deliveryEvents = readDeliveryQueueActivity(sinceMs);
  const taskEvents = readTaskRunsActivity(sinceMs);
  const allEvents = [...deliveryEvents, ...taskEvents];

  if (allEvents.length === 0) {
    console.log(`[activity-reporter-oc] ${botName}: no activity in last ${windowMin}min`);
    return;
  }

  console.log(`[activity-reporter-oc] ${botName}: delivery=${deliveryEvents.length} tasks=${taskEvents.length}`);

  try {
    const result = await postActivity(botName, allEvents);
    console.log(`[activity-reporter-oc] ${botName}: reported ${result.inserted || 0} events`);
  } catch (err) {
    console.error(`[activity-reporter-oc] ${botName}: POST failed: ${err.message}`);
    process.exit(1);
  }
}

main();
