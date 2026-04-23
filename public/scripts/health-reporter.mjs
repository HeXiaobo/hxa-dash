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
import { execSync, spawnSync } from 'child_process';

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
const runtimeOverride = normalizeRuntimeType(
  getArg('--runtime-type', getArg('--runtime', process.env.HEALTH_RUNTIME_TYPE || process.env.RUNTIME_TYPE || null))
);
const runtimeVersionOverride = getArg('--runtime-version', process.env.HEALTH_RUNTIME_VERSION || null);
const runtimeStatusOverride = normalizeRuntimeStatus(
  getArg('--runtime-status', process.env.HEALTH_RUNTIME_STATUS || null)
);

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

function normalizeRuntimeType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'unknown';
  if (['claude', 'claude_code', 'claude-code', 'claude code', 'claude-code-cli'].includes(text)) return 'claude_code';
  if (['codex', 'codex-cli', 'codex cli'].includes(text)) return 'codex';
  if (['openclaw', 'open-claw'].includes(text)) return 'openclaw';
  return text;
}

function normalizeRuntimeStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'unknown';
  if (['running', 'online', 'healthy', 'ok', 'active'].includes(text)) return 'running';
  if (['degraded', 'warn', 'warning'].includes(text)) return 'degraded';
  if (['offline', 'stopped', 'down'].includes(text)) return 'offline';
  return text;
}

function commandAvailable(command) {
  const res = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 2500,
    maxBuffer: 1024 * 1024,
  });
  return !res.error && res.status === 0;
}

function runCommand(command, args = [], timeoutMs = 4000) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return {
    ok: !res.error && res.status === 0,
    stdout: typeof res.stdout === 'string' ? res.stdout.trim() : '',
    stderr: typeof res.stderr === 'string' ? res.stderr.trim() : '',
    status: res.status,
    signal: res.signal,
    error: res.error ? res.error.message : null,
  };
}

function parseVersionText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const firstLine = raw.split(/\r?\n/).find(Boolean) || raw;
  const matches = firstLine.match(/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/);
  return matches ? matches[0] : firstLine;
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readFileTail(filePath, maxBytes = 256 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = stat.size;
      const readBytes = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(fd, buffer, 0, readBytes, size - readBytes);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function walkFiles(rootDir, predicate = () => true) {
  const results = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      if (predicate(current, stat)) results.push({ path: current, stat });
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      stack.push(path.join(current, entry.name));
    }
  }
  return results;
}

function collectLatestRateLimitSnapshot(rootDir) {
  const candidates = walkFiles(rootDir, (filePath, stat) => stat.isFile() && filePath.endsWith('.jsonl'));
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  for (const candidate of candidates.slice(0, 10)) {
    const tail = readFileTail(candidate.path);
    if (!tail) continue;
    const lines = tail.split(/\r?\n/).filter(Boolean);
    let latest = null;
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const rateLimits = parsed?.rate_limits || parsed?.payload?.rate_limits;
      if (!rateLimits) continue;
      latest = {
        rate_limits: rateLimits,
        timestamp: parsed.timestamp || parsed?.payload?.timestamp || null,
        type: parsed.type || parsed?.payload?.type || null,
      };
    }
    if (latest) {
      return {
        source: candidate.path,
        snapshot: latest,
      };
    }
  }

  return null;
}

function normalizeQuotaWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const usedPercent = Number(window.used_percent);
  const resetsAt = window.resets_at;
  const resetsAtEpoch = Number.isFinite(Number(resetsAt)) ? Number(resetsAt) : null;
  return {
    used_percent: Number.isFinite(usedPercent) ? usedPercent : null,
    window_minutes: Number.isFinite(Number(window.window_minutes)) ? Number(window.window_minutes) : null,
    resets_at: resetsAtEpoch ? new Date(resetsAtEpoch * 1000).toISOString() : null,
    resets_at_epoch: resetsAtEpoch,
  };
}

function buildQuotaPayload({ supported, source, reason = null, snapshot = null, extra = {} }) {
  if (!supported) {
    return {
      supported: false,
      source,
      reason,
      ...extra,
    };
  }

  const rateLimits = snapshot?.rate_limits || null;
  const primary = normalizeQuotaWindow(rateLimits?.primary);
  const secondary = normalizeQuotaWindow(rateLimits?.secondary);
  const credits = rateLimits?.credits && typeof rateLimits.credits === 'object' ? rateLimits.credits : null;

  return {
    supported: true,
    source,
    sampled_at: snapshot?.timestamp || null,
    primary,
    secondary,
    credits,
    ...extra,
  };
}

function probeRuntimeType() {
  if (runtimeOverride && runtimeOverride !== 'unknown') {
    return { type: runtimeOverride, source: 'override' };
  }

  if (process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_CONFIG_PATH || process.env.OPENCLAW_CONTAINER || process.env.OPENCLAW_PROFILE) {
    return { type: 'openclaw', source: 'env' };
  }
  if (process.env.CLAUDE_CODE_SIMPLE || process.env.CLAUDE_CODE || process.env.CLAUDE_SESSION_ID || process.env.ANTHROPIC_API_KEY) {
    return { type: 'claude_code', source: 'env' };
  }
  if (process.env.CODEX_HOME || process.env.CODEX_CONFIG_PATH || process.env.CODEX_SESSION_ID) {
    return { type: 'codex', source: 'env' };
  }

  if (fs.existsSync(path.join(os.homedir(), '.openclaw'))) return { type: 'openclaw', source: 'profile' };
  if (fs.existsSync(path.join(os.homedir(), '.claude'))) return { type: 'claude_code', source: 'profile' };
  if (fs.existsSync(path.join(os.homedir(), '.codex'))) return { type: 'codex', source: 'profile' };

  if (commandAvailable('openclaw')) return { type: 'openclaw', source: 'binary' };
  if (commandAvailable('claude')) return { type: 'claude_code', source: 'binary' };
  if (commandAvailable('codex')) return { type: 'codex', source: 'binary' };

  return { type: 'unknown', source: 'unknown' };
}

function probeRuntimeDetails(type) {
  if (type === 'openclaw') {
    const versionProbe = runCommand('openclaw', ['--version'], 2500);
    const healthProbe = runCommand('openclaw', ['health', '--json', '--timeout', '3000'], 5000);
    const statusProbe = healthProbe.ok ? healthProbe : runCommand('openclaw', ['status', '--json', '--timeout', '3000'], 5000);
    const statusJson = safeJsonParse(statusProbe.stdout);
    const running = Boolean(statusJson?.ok) && !statusProbe.error;
    const version = runtimeVersionOverride || parseVersionText(versionProbe.stdout);
    const status = runtimeStatusOverride !== 'unknown'
      ? runtimeStatusOverride
      : (running ? 'running' : version ? 'degraded' : 'offline');

    return {
      type,
      version,
      status,
      source: 'openclaw status',
      checked_at: new Date().toISOString(),
    };
  }

  if (type === 'claude_code') {
    const versionProbe = runCommand('claude', ['--version'], 2500);
    const authProbe = runCommand('claude', ['auth', 'status'], 4000);
    const authJson = safeJsonParse(authProbe.stdout);
    const loggedIn = authJson?.loggedIn === true;
    const version = runtimeVersionOverride || parseVersionText(versionProbe.stdout);
    const status = runtimeStatusOverride !== 'unknown'
      ? runtimeStatusOverride
      : (version && loggedIn ? 'running' : version ? 'degraded' : 'offline');

    return {
      type,
      version,
      status,
      source: 'claude auth status',
      checked_at: new Date().toISOString(),
    };
  }

  if (type === 'codex') {
    const versionProbe = runCommand('codex', ['--version'], 2500);
    const loginProbe = runCommand('codex', ['login', 'status'], 4000);
    const loggedIn = /logged in/i.test(`${loginProbe.stdout}\n${loginProbe.stderr}`);
    const version = runtimeVersionOverride || parseVersionText(versionProbe.stdout);
    const status = runtimeStatusOverride !== 'unknown'
      ? runtimeStatusOverride
      : (version && loggedIn ? 'running' : version ? 'degraded' : 'offline');

    return {
      type,
      version,
      status,
      source: 'codex login status',
      checked_at: new Date().toISOString(),
    };
  }

  return {
    type: type || 'unknown',
    version: runtimeVersionOverride || null,
    status: runtimeStatusOverride !== 'unknown' ? runtimeStatusOverride : 'unknown',
    source: 'unknown',
    checked_at: new Date().toISOString(),
  };
}

function collectClaudeQuota() {
  const home = os.homedir();
  const fileCandidates = [
    path.join(home, '.claude', 'usage.jsonl'),
    path.join(home, '.claude', 'history.jsonl'),
    path.join(home, '.claude', 'status.json'),
  ];

  for (const filePath of fileCandidates) {
    if (!fs.existsSync(filePath)) continue;
    if (filePath.endsWith('.json')) {
      const parsed = safeJsonParse(fs.readFileSync(filePath, 'utf8'));
      if (parsed?.rate_limits) {
        return buildQuotaPayload({
          supported: true,
          source: filePath,
          snapshot: {
            rate_limits: parsed.rate_limits,
            timestamp: parsed.timestamp || null,
          },
        });
      }
      continue;
    }

    const tail = readFileTail(filePath);
    const lines = tail.split(/\r?\n/).filter(Boolean);
    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      try {
        const parsed = JSON.parse(lines[idx]);
        const rateLimits = parsed?.rate_limits || parsed?.payload?.rate_limits;
        if (rateLimits) {
          return buildQuotaPayload({
            supported: true,
            source: filePath,
            snapshot: {
              rate_limits: rateLimits,
              timestamp: parsed.timestamp || parsed?.payload?.timestamp || null,
            },
          });
        }
      } catch {
        continue;
      }
    }
  }

  const recursiveSnapshot = fs.existsSync(path.join(home, '.claude'))
    ? collectLatestRateLimitSnapshot(path.join(home, '.claude'))
    : null;
  if (recursiveSnapshot?.snapshot?.rate_limits) {
    return buildQuotaPayload({
      supported: true,
      source: recursiveSnapshot.source,
      snapshot: recursiveSnapshot.snapshot,
    });
  }

  return buildQuotaPayload({
    supported: false,
    source: 'local-files',
    reason: 'no machine-readable Claude quota snapshot found',
  });
}

function collectCodexQuota() {
  const home = os.homedir();
  const sessionRoot = path.join(home, '.codex', 'sessions');
  const latest = fs.existsSync(sessionRoot) ? collectLatestRateLimitSnapshot(sessionRoot) : null;
  if (latest?.snapshot?.rate_limits) {
    return buildQuotaPayload({
      supported: true,
      source: latest.source,
      snapshot: latest.snapshot,
    });
  }

  return buildQuotaPayload({
    supported: false,
    source: sessionRoot,
    reason: 'no machine-readable Codex quota snapshot found',
  });
}

function collectOpenClawQuota() {
  return buildQuotaPayload({
    supported: false,
    source: 'openclaw',
    reason: 'unsupported_for_now',
  });
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
  const runtimeType = probeRuntimeType();
  const runtime = probeRuntimeDetails(runtimeType.type);
  const quota = {
    claude_code: collectClaudeQuota(),
    codex: collectCodexQuota(),
    openclaw: collectOpenClawQuota(),
  };

  const payload = {
    hostname: os.hostname(),
    disk,
    memory,
    cpu,
    ...(pm2 ? { pm2 } : {}),
    runtime,
    quota,
  };

  const quotaSummary = [
    quota.claude_code.supported && quota.claude_code.primary
      ? `claude=${quota.claude_code.primary.used_percent ?? 'na'}%/${quota.claude_code.secondary?.used_percent ?? 'na'}%`
      : 'claude=unsupported',
    quota.codex.supported && quota.codex.primary
      ? `codex=${quota.codex.primary.used_percent ?? 'na'}%/${quota.codex.secondary?.used_percent ?? 'na'}%`
      : 'codex=unsupported',
    quota.openclaw.supported ? 'openclaw=supported' : 'openclaw=unsupported',
  ].join(' ');

  console.log(
    `[health-reporter] ${botName}: runtime=${runtime.type}@${runtime.version || 'unknown'} ${runtime.status} ` +
    `disk=${disk.pct}% mem=${memory.pct}% cpu=${cpu.pct}%` +
    `${pm2 ? ` pm2=${pm2.online}/${pm2.total}` : ''} ${quotaSummary}`
  );

  try {
    const result = await postHealth(botName, payload);
    console.log(`[health-reporter] ${botName}: reported OK`);
  } catch (err) {
    console.error(`[health-reporter] ${botName}: POST failed: ${err.message}`);
    process.exit(1);
  }
}

main();
