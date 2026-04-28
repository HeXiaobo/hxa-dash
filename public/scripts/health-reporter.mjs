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

const EXTRA_PATH_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  '/usr/local/bin',
  path.join(os.homedir(), '.nvm', 'versions', 'node'),
].filter(d => fs.existsSync(d));

if (EXTRA_PATH_DIRS.length) {
  const nvmDir = EXTRA_PATH_DIRS.find(d => d.includes('.nvm'));
  if (nvmDir) {
    try {
      const versions = fs.readdirSync(nvmDir).filter(v => v.startsWith('v')).sort().reverse();
      if (versions.length) EXTRA_PATH_DIRS.push(path.join(nvmDir, versions[0], 'bin'));
    } catch {}
  }
  process.env.PATH = [...EXTRA_PATH_DIRS, process.env.PATH].join(path.delimiter);
}

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
const RUNTIME_CONFIG_CANDIDATES = [
  path.join(ZYLOS_DIR, 'runtime.json'),
  path.join(ZYLOS_DIR, '.runtime.json'),
  path.join(os.homedir(), '.config', 'hxa-dash', 'runtime.json'),
  path.join(os.homedir(), '.config', 'hxa', 'runtime.json'),
  path.join(os.homedir(), '.hxa-runtime.json'),
];

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

function listProcessCommands() {
  const commands = new Set();

  const pm2Probe = runCommand('pm2', ['jlist'], 6000);
  if (pm2Probe.ok) {
    const services = safeJsonParse(pm2Probe.stdout);
    if (Array.isArray(services)) {
      for (const svc of services) {
        const script = svc?.pm2_env?.pm_exec_path || svc?.pm2_env?.script || '';
        const name = svc?.name || '';
        const args = Array.isArray(svc?.pm2_env?.args) ? svc.pm2_env.args.join(' ') : '';
        const combined = `${name} ${script} ${args}`.trim().toLowerCase();
        if (combined) commands.add(combined);
      }
    }
  }

  const psProbe = runCommand('ps', ['-axo', 'command='], 6000);
  if (psProbe.ok) {
    for (const line of psProbe.stdout.split(/\r?\n/)) {
      const text = String(line || '').trim().toLowerCase();
      if (text) commands.add(text);
    }
  }

  return [...commands];
}

function processCommandTokens(command) {
  return String(command || '')
    .split(/\s+/)
    .map(part => path.basename(part).toLowerCase().replace(/^["']+|["',;]+$/g, ''))
    .filter(Boolean);
}

function matchRuntimeFromProcesses(commands) {
  const matchers = [
    { type: 'openclaw', tokens: ['openclaw'] },
    { type: 'codex', tokens: ['codex', 'codex-cli'] },
    { type: 'claude_code', tokens: ['claude', 'claude-code', 'claude-code-cli'] },
  ];

  const matches = [];
  for (const { type, tokens } of matchers) {
    const matched = commands.some(cmd => processCommandTokens(cmd).some(part =>
      tokens.some(token => part === token || part.startsWith(`${token}-`) || part.startsWith(`${token}.`))
    ));
    if (matched) matches.push(type);
  }

  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length === 1) {
    return { type: uniqueMatches[0], source: 'process' };
  }
  if (uniqueMatches.length > 1) {
    return { type: 'unknown', source: 'process_conflict', matches: uniqueMatches };
  }

  return null;
}

function readRuntimeTypeFromEnv() {
  if (process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_CONFIG_PATH || process.env.OPENCLAW_CONTAINER || process.env.OPENCLAW_PROFILE) {
    return { type: 'openclaw', source: 'env' };
  }
  if (process.env.CLAUDE_CODE_SIMPLE || process.env.CLAUDE_CODE || process.env.CLAUDE_SESSION_ID || process.env.ANTHROPIC_API_KEY) {
    return { type: 'claude_code', source: 'env' };
  }
  if (process.env.CODEX_HOME || process.env.CODEX_CONFIG_PATH || process.env.CODEX_SESSION_ID) {
    return { type: 'codex', source: 'env' };
  }
  return null;
}

function readRuntimeTypeFromConfig() {
  for (const filePath of RUNTIME_CONFIG_CANDIDATES) {
    if (!fs.existsSync(filePath)) continue;
    const parsed = safeJsonParse(fs.readFileSync(filePath, 'utf8'));
    const value = normalizeRuntimeType(
      parsed?.runtime?.type ||
      parsed?.runtime_type ||
      parsed?.runtimeType ||
      parsed?.type ||
      parsed?.runtime ||
      null
    );
    if (value && value !== 'unknown') {
      return { type: value, source: 'config', path: filePath };
    }
  }
  return null;
}

function detectRuntimeFromProfiles() {
  const matches = [];
  if (fs.existsSync(path.join(os.homedir(), '.openclaw'))) matches.push('openclaw');
  if (fs.existsSync(path.join(os.homedir(), '.claude'))) matches.push('claude_code');
  if (fs.existsSync(path.join(os.homedir(), '.codex'))) matches.push('codex');

  if (matches.length === 1) return { type: matches[0], source: 'profile' };
  if (matches.length > 1) return { type: 'unknown', source: 'profile_conflict' };
  return null;
}

function detectRuntimeFromBinaries() {
  const matches = [];
  if (commandAvailable('openclaw')) matches.push('openclaw');
  if (commandAvailable('claude')) matches.push('claude_code');
  if (commandAvailable('codex')) matches.push('codex');

  if (matches.length === 1) return { type: matches[0], source: 'binary' };
  if (matches.length > 1) return { type: 'unknown', source: 'binary_conflict' };
  return null;
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

function readFileCapped(filePath, maxBytes = 8 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) {
      return { text: fs.readFileSync(filePath, 'utf8'), partial: false, size: stat.size };
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
      return { text: buffer.toString('utf8'), partial: true, size: stat.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', partial: false, size: 0 };
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

function latestFiles(rootDir, predicate, limit = 20) {
  if (!fs.existsSync(rootDir)) return [];
  const files = walkFiles(rootDir, predicate);
  return files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, limit);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tokenOrNull(value) {
  const n = numberOrNull(value);
  return n == null || n < 0 ? null : Math.round(n);
}

function normalizeUsageTokens(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const tokens = {
    input: tokenOrNull(raw.input_tokens ?? raw.input ?? raw.total_input_tokens ?? raw.prompt_tokens),
    output: tokenOrNull(raw.output_tokens ?? raw.output ?? raw.total_output_tokens ?? raw.completion_tokens),
    cache_creation: tokenOrNull(
      raw.cache_creation_input_tokens ??
      raw.cache_creation_tokens ??
      raw.cache_write_input_tokens ??
      raw.cache_write_tokens
    ),
    cache_read: tokenOrNull(
      raw.cache_read_input_tokens ??
      raw.cache_read_tokens
    ),
    cached_input: tokenOrNull(
      raw.cached_input_tokens ??
      raw.cached_input
    ),
    reasoning: tokenOrNull(
      raw.reasoning_output_tokens ??
      raw.reasoning_tokens
    ),
    total: tokenOrNull(raw.total_tokens ?? raw.total),
  };

  if (tokens.total == null) {
    const addends = [
      tokens.input,
      tokens.output,
      tokens.cache_creation,
      tokens.cache_read,
    ].filter(v => v != null);
    tokens.total = addends.length ? addends.reduce((sum, v) => sum + v, 0) : null;
  }

  return Object.values(tokens).some(v => v != null && v > 0) ? tokens : null;
}

function addUsageTokens(total, next) {
  if (!next) return total;
  const out = total || {
    input: 0,
    output: 0,
    cache_creation: 0,
    cache_read: 0,
    cached_input: 0,
    reasoning: 0,
    total: 0,
  };
  for (const key of Object.keys(out)) {
    if (next[key] != null) out[key] += next[key];
  }
  return out;
}

function buildUsagePayload({
  supported,
  source,
  reason = null,
  sampled_at = null,
  session_tokens = null,
  last_turn_tokens = null,
  session_id = null,
  thread_id = null,
  model = null,
  plan_type = null,
  session_cost_usd = null,
  estimated_cost = false,
  turns = null,
  partial = false,
  extra = {},
}) {
  if (!supported) {
    return {
      supported: false,
      source,
      reason,
      ...extra,
    };
  }

  return {
    supported: true,
    source,
    sampled_at,
    session_id,
    thread_id,
    model,
    plan_type,
    session_tokens,
    last_turn_tokens,
    session_cost_usd,
    estimated_cost: Boolean(estimated_cost),
    turns,
    partial: Boolean(partial),
    ...extra,
  };
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
  const hasUsedQuotaWindow = [primary, secondary].some(window => typeof window?.used_percent === 'number');

  return {
    supported: hasUsedQuotaWindow,
    source,
    reason: hasUsedQuotaWindow ? null : (reason || 'no_used_quota_window'),
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

  const configMatch = readRuntimeTypeFromConfig();
  if (configMatch) return configMatch;

  const envMatch = readRuntimeTypeFromEnv();
  if (envMatch) return envMatch;

  const processMatch = matchRuntimeFromProcesses(listProcessCommands());
  if (processMatch) return processMatch;

  const profileMatch = detectRuntimeFromProfiles();
  if (profileMatch) return profileMatch;

  const binaryMatch = detectRuntimeFromBinaries();
  if (binaryMatch) return binaryMatch;

  return { type: 'unknown', source: 'unknown' };
}

function isStrongDetectionSource(source) {
  return ['override', 'process', 'config', 'env'].includes(String(source || '').toLowerCase());
}

function probeRuntimeDetails(runtimeProbe) {
  const type = runtimeProbe?.type || 'unknown';
  const detectionSource = runtimeProbe?.source || 'unknown';
  const strongDetection = isStrongDetectionSource(detectionSource);

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
      detection_source: detectionSource,
      checked_at: new Date().toISOString(),
    };
  }

  if (type === 'claude_code') {
    const versionProbe = runCommand('claude', ['--version'], 2500);
    const version = runtimeVersionOverride || parseVersionText(versionProbe.stdout);
    const status = runtimeStatusOverride !== 'unknown'
      ? runtimeStatusOverride
      : (version ? 'running' : (strongDetection ? 'degraded' : 'offline'));

    return {
      type,
      version,
      status,
      source: 'claude version',
      detection_source: detectionSource,
      checked_at: new Date().toISOString(),
    };
  }

  if (type === 'codex') {
    const versionProbe = runCommand('codex', ['--version'], 2500);
    const version = runtimeVersionOverride || parseVersionText(versionProbe.stdout);
    const status = runtimeStatusOverride !== 'unknown'
      ? runtimeStatusOverride
      : (version ? 'running' : (strongDetection ? 'degraded' : 'offline'));

    return {
      type,
      version,
      status,
      source: 'codex version',
      detection_source: detectionSource,
      checked_at: new Date().toISOString(),
    };
  }

  return {
    type: type || 'unknown',
    version: runtimeVersionOverride || null,
    status: runtimeStatusOverride !== 'unknown' ? runtimeStatusOverride : 'unknown',
    source: 'unknown',
    detection_source: detectionSource,
    checked_at: new Date().toISOString(),
  };
}

function collectClaudeQuota() {
  const home = os.homedir();

  // Zylos statusline.json — written by context-monitor after every turn, contains live rate_limits
  const statuslinePaths = [
    path.join(ZYLOS_DIR, 'activity-monitor', 'statusline.json'),
  ];
  for (const slPath of statuslinePaths) {
    if (!fs.existsSync(slPath)) continue;
    const parsed = safeJsonParse(fs.readFileSync(slPath, 'utf8'));
    const rl = parsed?.rate_limits;
    if (!rl) continue;
    const mapped = {
      primary: {
        used_percent: rl.five_hour?.used_percentage ?? rl.five_hour?.used_percent ?? null,
        resets_at: rl.five_hour?.resets_at ?? null,
        label: '5h',
      },
      secondary: {
        used_percent: rl.seven_day?.used_percentage ?? rl.seven_day?.used_percent ?? null,
        resets_at: rl.seven_day?.resets_at ?? null,
        label: '7d',
      },
    };
    return buildQuotaPayload({
      supported: true,
      source: slPath,
      snapshot: { rate_limits: mapped, timestamp: parsed.timestamp || null },
    });
  }

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

function fetchCodexQuotaViaAPI() {
  const authFile = path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(authFile)) return Promise.resolve(null);
  let auth;
  try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return Promise.resolve(null); }
  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) return Promise.resolve(null);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/backend-api/codex/usage',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function collectCodexQuota() {
  const apiResult = await fetchCodexQuotaViaAPI();
  if (apiResult && (apiResult.primary || apiResult.secondary)) {
    return buildQuotaPayload({
      supported: true,
      source: 'codex-api',
      snapshot: { rate_limits: apiResult, timestamp: Date.now() },
    });
  }

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
    source: apiResult ? 'codex-api' : sessionRoot,
    reason: apiResult ? 'api returned no quota windows' : 'no machine-readable Codex quota snapshot found',
  });
}

function collectOpenClawQuota() {
  return buildQuotaPayload({
    supported: false,
    source: 'openclaw',
    reason: 'unsupported_for_now',
  });
}

function extractClaudeUsage(record) {
  const candidates = [
    record?.message?.usage,
    record?.usage,
    record?.payload?.message?.usage,
    record?.payload?.usage,
    record?.result?.message?.usage,
  ];
  return candidates.find(item => normalizeUsageTokens(item)) || null;
}

function collectClaudeTranscriptUsage(claudeDir) {
  const candidates = latestFiles(
    claudeDir,
    (filePath, stat) => stat.isFile() && filePath.endsWith('.jsonl'),
    20
  );

  for (const candidate of candidates) {
    const { text, partial } = readFileCapped(candidate.path);
    if (!text) continue;

    let totals = null;
    let lastTurn = null;
    let turns = 0;
    let sampledAt = null;
    let sessionId = null;
    let model = null;

    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const usage = extractClaudeUsage(parsed);
      const tokens = normalizeUsageTokens(usage);
      if (!tokens) continue;

      turns += 1;
      totals = addUsageTokens(totals, tokens);
      lastTurn = tokens;
      sampledAt = parsed.timestamp || parsed.created_at || parsed.createdAt || sampledAt;
      sessionId = parsed.session_id || parsed.sessionId || parsed.conversation_id || sessionId;
      model = parsed.message?.model || parsed.model || parsed.payload?.message?.model || model;
    }

    if (totals) {
      return {
        source: candidate.path,
        sampled_at: sampledAt,
        session_id: sessionId,
        model,
        session_tokens: totals,
        last_turn_tokens: lastTurn,
        turns,
        partial,
      };
    }
  }

  return null;
}

function collectClaudeStatuslineUsage() {
  const statuslinePaths = [
    process.env.CLAUDE_STATUSLINE_PATH || null,
    path.join(ZYLOS_DIR, 'activity-monitor', 'statusline.json'),
  ].filter(Boolean);

  for (const filePath of statuslinePaths) {
    if (!fs.existsSync(filePath)) continue;
    const parsed = safeJsonParse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') continue;

    const context = parsed.context_window || {};
    const sessionTokens = normalizeUsageTokens({
      input_tokens: context.total_input_tokens,
      output_tokens: context.total_output_tokens,
      cache_creation_input_tokens: context.total_cache_creation_input_tokens,
      cache_read_input_tokens: context.total_cache_read_input_tokens,
      total_tokens: context.total_tokens,
    });
    const lastTurnTokens = normalizeUsageTokens(context.current_usage || parsed.usage || null);
    if (!sessionTokens && !lastTurnTokens && parsed.cost?.total_cost_usd == null) continue;

    return {
      source: filePath,
      sampled_at: parsed.timestamp || parsed.updated_at || null,
      session_id: parsed.session_id || null,
      model: parsed.model?.id || parsed.model || null,
      session_tokens: sessionTokens,
      last_turn_tokens: lastTurnTokens,
      session_cost_usd: numberOrNull(parsed.cost?.total_cost_usd),
      estimated_cost: parsed.cost?.total_cost_usd != null,
    };
  }

  return null;
}

function collectClaudeUsage() {
  const home = os.homedir();
  const statusline = collectClaudeStatuslineUsage();
  const transcript = fs.existsSync(path.join(home, '.claude'))
    ? collectClaudeTranscriptUsage(path.join(home, '.claude'))
    : null;

  const best = transcript || statusline;
  if (!best) {
    return buildUsagePayload({
      supported: false,
      source: 'local-files',
      reason: 'no machine-readable Claude usage snapshot found',
    });
  }

  return buildUsagePayload({
    supported: true,
    source: transcript ? 'transcript' : 'statusline',
    sampled_at: best.sampled_at || statusline?.sampled_at || null,
    session_id: best.session_id || statusline?.session_id || null,
    model: best.model || statusline?.model || null,
    session_tokens: best.session_tokens || statusline?.session_tokens || null,
    last_turn_tokens: best.last_turn_tokens || statusline?.last_turn_tokens || null,
    session_cost_usd: statusline?.session_cost_usd ?? null,
    estimated_cost: statusline?.estimated_cost || false,
    turns: best.turns || null,
    partial: best.partial || false,
  });
}

function readCodexThreadsFromSqlite(dbPath, limit = 20) {
  const query = [
    'select id,source,model_provider,coalesce(model,\'\'),tokens_used,created_at,updated_at,rollout_path',
    'from threads',
    'where rollout_path is not null and rollout_path != \'\'',
    'order by updated_at desc',
    `limit ${Number(limit) || 20};`,
  ].join(' ');

  const args = ['-readonly', '-separator', '\t', dbPath, query];
  let result = runCommand('sqlite3', args, 5000);
  if (!result.ok) {
    result = runCommand('sqlite3', ['-separator', '\t', dbPath, query], 5000);
  }
  if (!result.ok || !result.stdout) return [];

  return result.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const parts = line.split('\t');
    return {
      id: parts[0] || null,
      source: parts[1] || null,
      model_provider: parts[2] || null,
      model: parts[3] || null,
      tokens_used: tokenOrNull(parts[4]),
      created_at: numberOrNull(parts[5]),
      updated_at: numberOrNull(parts[6]),
      rollout_path: parts.slice(7).join('\t') || null,
    };
  }).filter(thread => thread.id || thread.rollout_path);
}

function codexStateDbCandidates(codexHome) {
  if (!fs.existsSync(codexHome)) return [];
  const direct = fs.readdirSync(codexHome)
    .filter(name => /^state.*\.sqlite$/.test(name))
    .map(name => path.join(codexHome, name));
  return direct
    .filter(filePath => fs.existsSync(filePath))
    .map(filePath => ({ path: filePath, stat: fs.statSync(filePath) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map(item => item.path);
}

function collectCodexTokenCountFromRollout(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const tail = readFileTail(filePath, 512 * 1024);
  if (!tail) return null;

  let latest = null;
  for (const line of tail.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type !== 'event_msg' || parsed?.payload?.type !== 'token_count') continue;
    const totalUsage = normalizeUsageTokens(parsed.payload?.info?.total_token_usage);
    const lastUsage = normalizeUsageTokens(parsed.payload?.info?.last_token_usage);
    if (!totalUsage && !lastUsage) continue;
    latest = {
      sampled_at: parsed.timestamp || null,
      session_tokens: totalUsage,
      last_turn_tokens: lastUsage,
      plan_type: parsed.payload?.rate_limits?.plan_type || null,
      rate_limits: parsed.payload?.rate_limits || null,
    };
  }

  return latest;
}

function collectCodexUsageFromSqlite(codexHome) {
  for (const dbPath of codexStateDbCandidates(codexHome)) {
    const threads = readCodexThreadsFromSqlite(dbPath);
    for (const thread of threads) {
      const snapshot = collectCodexTokenCountFromRollout(thread.rollout_path);
      if (snapshot?.session_tokens || snapshot?.last_turn_tokens) {
        return {
          source: 'rollout',
          sampled_at: snapshot.sampled_at,
          session_id: thread.id,
          thread_id: thread.id,
          model: thread.model || null,
          plan_type: snapshot.plan_type || null,
          session_tokens: snapshot.session_tokens,
          last_turn_tokens: snapshot.last_turn_tokens,
        };
      }
    }

    const fallback = threads.find(thread => thread.tokens_used != null);
    if (fallback) {
      return {
        source: 'sqlite',
        sampled_at: fallback.updated_at ? new Date(fallback.updated_at * 1000).toISOString() : null,
        session_id: fallback.id,
        thread_id: fallback.id,
        model: fallback.model || null,
        session_tokens: { input: null, output: null, cache_creation: null, cache_read: null, cached_input: null, reasoning: null, total: fallback.tokens_used },
        last_turn_tokens: null,
      };
    }
  }

  return null;
}

function collectCodexUsageFromSessions(codexHome) {
  const sessionRoot = path.join(codexHome, 'sessions');
  const candidates = latestFiles(
    sessionRoot,
    (filePath, stat) => stat.isFile() && filePath.endsWith('.jsonl'),
    30
  );

  for (const candidate of candidates) {
    const snapshot = collectCodexTokenCountFromRollout(candidate.path);
    if (snapshot?.session_tokens || snapshot?.last_turn_tokens) {
      return {
        source: 'rollout',
        sampled_at: snapshot.sampled_at,
        session_id: path.basename(candidate.path).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/)?.[1] || null,
        thread_id: null,
        model: null,
        plan_type: snapshot.plan_type || null,
        session_tokens: snapshot.session_tokens,
        last_turn_tokens: snapshot.last_turn_tokens,
      };
    }
  }

  return null;
}

function collectCodexUsage() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const usage = collectCodexUsageFromSqlite(codexHome) || collectCodexUsageFromSessions(codexHome);

  if (!usage) {
    return buildUsagePayload({
      supported: false,
      source: codexHome,
      reason: 'no machine-readable Codex usage snapshot found',
    });
  }

  return buildUsagePayload({
    supported: true,
    source: usage.source,
    sampled_at: usage.sampled_at,
    session_id: usage.session_id,
    thread_id: usage.thread_id,
    model: usage.model,
    plan_type: usage.plan_type,
    session_tokens: usage.session_tokens,
    last_turn_tokens: usage.last_turn_tokens,
  });
}

function collectOpenClawUsage() {
  return buildUsagePayload({
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

function collectRoster() {
  const statuslinePath = path.join(ZYLOS_DIR, 'activity-monitor', 'statusline.json');
  if (!fs.existsSync(statuslinePath)) return null;
  let sl;
  try { sl = JSON.parse(fs.readFileSync(statuslinePath, 'utf8')); } catch { return null; }
  return {
    session_id: sl.session_id || null,
    model: sl.model?.id || sl.model?.display_name || null,
    model_display: sl.model?.display_name || null,
    version: sl.version || null,
    runtime_type: sl.model?.id?.includes('codex') ? 'codex' : 'claude_code',
    cost_usd: typeof sl.cost?.total_cost_usd === 'number' ? Math.round(sl.cost.total_cost_usd * 100) / 100 : null,
    lines_added: sl.cost?.total_lines_added ?? null,
    lines_removed: sl.cost?.total_lines_removed ?? null,
    context_used_pct: sl.context_window?.used_percentage ?? null,
    context_total_tokens: (sl.context_window?.total_input_tokens || 0) + (sl.context_window?.total_output_tokens || 0) || null,
    rate_limits: {
      five_hour: sl.rate_limits?.five_hour ? {
        used_pct: sl.rate_limits.five_hour.used_percentage ?? null,
        resets_at: sl.rate_limits.five_hour.resets_at ?? null,
      } : null,
      seven_day: sl.rate_limits?.seven_day ? {
        used_pct: sl.rate_limits.seven_day.used_percentage ?? null,
        resets_at: sl.rate_limits.seven_day.resets_at ?? null,
      } : null,
    },
    plan_type: sl.plan_type || null,
    sampled_at: Date.now(),
  };
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
  const runtime = probeRuntimeDetails(runtimeType);
  const quota = {
    claude_code: collectClaudeQuota(),
    codex: await collectCodexQuota(),
    openclaw: collectOpenClawQuota(),
  };
  const usage = {
    claude_code: collectClaudeUsage(),
    codex: collectCodexUsage(),
    openclaw: collectOpenClawUsage(),
  };

  const roster = collectRoster();
  const payload = {
    hostname: os.hostname(),
    disk,
    memory,
    cpu,
    ...(pm2 ? { pm2 } : {}),
    runtime,
    quota,
    usage,
    ...(roster ? { roster } : {}),
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
  const usageSummary = [
    usage.claude_code.supported && usage.claude_code.session_tokens?.total != null
      ? `claude_tokens=${usage.claude_code.session_tokens.total}`
      : 'claude_tokens=unsupported',
    usage.codex.supported && usage.codex.session_tokens?.total != null
      ? `codex_tokens=${usage.codex.session_tokens.total}`
      : 'codex_tokens=unsupported',
  ].join(' ');

  console.log(
    `[health-reporter] ${botName}: runtime=${runtime.type}@${runtime.version || 'unknown'} ${runtime.status} ` +
    `disk=${disk.pct}% mem=${memory.pct}% cpu=${cpu.pct}%` +
    `${pm2 ? ` pm2=${pm2.online}/${pm2.total}` : ''} ${quotaSummary} ${usageSummary}`
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
