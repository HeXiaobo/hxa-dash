#!/usr/bin/env node
// activity-reporter.mjs — Lightweight activity reporter for hxa-dash
// Zero npm dependencies — uses sqlite3 CLI for database reads.
//
// Usage: node activity-reporter.mjs [--dashboard-url URL] [--window-minutes N] [--name BOT_NAME]
//
// Auto-detects bot name from ~/zylos/memory/identity.md or system username.
// Reports to: https://hxa.zhiw.ai/api/report/activity (default)

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import { execSync } from 'child_process';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DEFAULT_DASHBOARD = 'https://hxa.zhiw.ai';
const DEFAULT_WINDOW_MIN = 10;

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
  try {
    const idPath = path.join(ZYLOS_DIR, 'memory', 'identity.md');
    if (fs.existsSync(idPath)) {
      const content = fs.readFileSync(idPath, 'utf8').slice(0, 500);
      const match = content.match(/I am (\w+)/i);
      if (match) return match[1].toLowerCase();
    }
  } catch {}
  return os.userInfo().username || os.hostname();
}

function sqliteQuery(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const out = execSync(`sqlite3 -json "${dbPath}" "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    return JSON.parse(out || '[]');
  } catch {
    return [];
  }
}

function readC4Activity(sinceStr) {
  const events = [];
  const possiblePaths = [
    path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db'),
    path.join(ZYLOS_DIR, 'c4.db')
  ];
  let dbPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) { dbPath = p; break; }
  }
  if (!dbPath) return events;

  const rows = sqliteQuery(dbPath,
    `SELECT channel, direction, COUNT(*) as cnt, MAX(timestamp) as last_ts FROM conversations WHERE timestamp > '${sinceStr}' AND channel != 'system' GROUP BY channel, direction`
  );

  const labels = { feishu: 'Feishu', telegram: 'Telegram', 'hxa-connect': 'HXA', 'web-console': 'Web' };
  for (const row of rows) {
    if (!row.cnt || row.cnt === 0) continue;
    const ch = labels[row.channel] || row.channel;
    const dir = row.direction === 'out' ? 'sent' : 'received';
    events.push({
      action: row.direction === 'out' ? 'sent_message' : 'received_message',
      target_type: row.channel,
      target_title: `${dir} ${row.cnt} ${ch} message(s)`,
      timestamp: row.last_ts ? new Date(row.last_ts + 'Z').getTime() : Date.now(),
      external_id: `c4r:${row.channel}:${row.direction}:${Math.floor(Date.now() / 60000)}`
    });
  }
  return events;
}

function readSchedulerActivity(sinceMs) {
  const events = [];
  const dbPath = path.join(ZYLOS_DIR, 'scheduler', 'scheduler.db');
  if (!fs.existsSync(dbPath)) return events;

  const sinceSec = Math.floor(sinceMs / 1000);
  const rows = sqliteQuery(dbPath,
    `SELECT h.task_id, t.name, h.executed_at, h.completed_at, h.status, h.duration_ms FROM task_history h JOIN tasks t ON h.task_id=t.id WHERE h.executed_at > ${sinceSec} AND h.status IN ('success','failed','timeout') ORDER BY h.executed_at DESC LIMIT 20`
  );

  for (const row of rows) {
    const tsMs = (row.completed_at || row.executed_at) * 1000;
    events.push({
      action: 'task_' + row.status,
      target_type: 'scheduler-task',
      target_title: `${row.name} (${row.status}${row.duration_ms ? ', ' + Math.round(row.duration_ms / 1000) + 's' : ''})`,
      timestamp: tsMs,
      external_id: `sr:${row.task_id}:${row.executed_at}`
    });
  }
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
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
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
  const sinceStr = new Date(sinceMs).toISOString().replace('T', ' ').slice(0, 19);

  const c4Events = readC4Activity(sinceStr);
  const schedEvents = readSchedulerActivity(sinceMs);
  const allEvents = [...c4Events, ...schedEvents];

  if (allEvents.length === 0) {
    console.log(`[activity-reporter] ${botName}: no activity in last ${windowMin}min`);
    return;
  }

  console.log(`[activity-reporter] ${botName}: C4=${c4Events.length} Sched=${schedEvents.length}`);

  try {
    const result = await postActivity(botName, allEvents);
    console.log(`[activity-reporter] ${botName}: reported ${result.inserted || 0} events`);
  } catch (err) {
    console.error(`[activity-reporter] ${botName}: POST failed: ${err.message}`);
    process.exit(1);
  }
}

main();
