#!/usr/bin/env node
// health-reporter.mjs — Lightweight system health reporter for hxa-dash
// Zero npm dependencies — uses native Node.js + shell commands.
//
// Usage: node health-reporter.mjs [--dashboard-url URL] [--name BOT_NAME] [--api-key KEY]
//
// Auto-detects bot name from ~/zylos/memory/identity.md or system username.
// Reports to: https://hxa.zhiw.ai/api/agent-health/:name (default)

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import { execSync } from 'child_process';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DEFAULT_DASHBOARD = 'https://hxa.zhiw.ai';

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
const dashboardUrl = getArg('--dashboard-url', DEFAULT_DASHBOARD);
const overrideName = getArg('--name', null);
const apiKey = getArg('--api-key', process.env.HEALTH_API_KEY || null);

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

function getDiskInfo() {
  try {
    const out = execSync('df -h / 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const lines = out.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      return {
        total: parts[1] || null,
        used: parts[2] || null,
        pct: parseInt(parts[4], 10) || 0,
      };
    }
  } catch {}
  return { total: null, used: null, pct: 0 };
}

function getMemoryInfo() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return {
    total_gb: Math.round(totalBytes / 1073741824 * 10) / 10,
    used_gb: Math.round(usedBytes / 1073741824 * 10) / 10,
    pct: Math.round((usedBytes / totalBytes) * 100),
  };
}

function getCpuInfo() {
  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  const cores = cpus.length || 1;
  const pct = Math.min(100, Math.round((loadAvg[0] / cores) * 100));
  return {
    pct,
    load_avg: loadAvg.map(v => Math.round(v * 100) / 100),
    cores,
  };
}

function getPm2Info() {
  try {
    const out = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 10000 });
    const data = JSON.parse(out || '[]');
    if (!Array.isArray(data) || data.length === 0) return null;
    const services = data.map(svc => ({
      name: svc.name,
      status: svc.pm2_env?.status || 'unknown',
      memory: svc.monit?.memory || null,
      cpu: svc.monit?.cpu || null,
    }));
    const online = services.filter(s => s.status === 'online').length;
    return { online, total: services.length, services };
  } catch {
    return null;
  }
}

function postHealth(name, payload) {
  return new Promise((resolve, reject) => {
    const url = `${dashboardUrl}/api/agent-health/${encodeURIComponent(name)}`;
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (apiKey) headers['X-API-Key'] = apiKey;

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers,
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

  if (!apiKey) {
    console.error(`[health-reporter] ${botName}: ERROR — no API key. Use --api-key or set HEALTH_API_KEY env var.`);
    process.exit(1);
  }

  const disk = getDiskInfo();
  const memory = getMemoryInfo();
  const cpu = getCpuInfo();
  const pm2 = getPm2Info();

  const payload = {
    hostname: os.hostname(),
    disk,
    memory,
    cpu,
    ...(pm2 ? { pm2 } : {}),
  };

  console.log(`[health-reporter] ${botName}: disk=${disk.pct}% mem=${memory.pct}% cpu=${cpu.pct}%${pm2 ? ` pm2=${pm2.online}/${pm2.total}` : ''}`);

  try {
    const result = await postHealth(botName, payload);
    console.log(`[health-reporter] ${botName}: reported OK`);
  } catch (err) {
    console.error(`[health-reporter] ${botName}: POST failed: ${err.message}`);
    process.exit(1);
  }
}

main();
