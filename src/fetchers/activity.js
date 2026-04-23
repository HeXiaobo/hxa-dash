// Activity Fetcher — Non-code activity sources for agent activity tracking
// Sources: HXA-Connect messages, Scheduler tasks, C4 messages (Feishu/Telegram)
//
// These sources complement GitLab events so that agents who don't write code
// (operations, content, communication work) still show as active on the dashboard.

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const entity = require('../entity');

const POLL_WINDOW_MS = 5 * 60 * 1000; // Look back 5 minutes each poll cycle
const INITIAL_WINDOW_MS = 6 * 60 * 60 * 1000; // First poll looks back 6 hours for initial data

// Track last poll timestamps per source to avoid re-processing
const lastPoll = {
  hxa: 0,
  scheduler: 0,
  c4: 0
};

// ---------------------------------------------------------------------------
// Source 1: HXA-Connect thread messages
// Polls the hub's /api/threads endpoint for recently-updated threads,
// then counts messages per bot in the recent window.
// ---------------------------------------------------------------------------
async function fetchHxaActivity(hubUrl, token) {
  if (!hubUrl || !token) return [];

  const events = [];
  const since = lastPoll.hxa || (Date.now() - INITIAL_WINDOW_MS);
  const now = Date.now();

  try {
    const headers = { 'Authorization': `Bearer ${token}` };

    // Build bot ID → name mapping from /api/bots
    const bots = await httpGet(`${hubUrl}/api/bots`, headers);
    const idToName = {};
    for (const bot of (Array.isArray(bots) ? bots : [])) {
      if (bot.id && bot.name) idToName[bot.id] = bot.name;
    }

    const threadsResp = await httpGet(`${hubUrl}/api/threads?limit=20`, headers);
    const items = threadsResp.items || (Array.isArray(threadsResp) ? threadsResp : []);

    for (const thread of items) {
      if (!thread.id) continue;
      const updatedAt = thread.updated_at || 0;
      if (updatedAt < since) continue;

      try {
        const msgs = await httpGet(
          `${hubUrl}/api/threads/${thread.id}/messages?limit=50`,
          headers
        );
        // API returns flat array
        const messages = Array.isArray(msgs) ? msgs : (msgs.items || []);

        const perBot = {};
        for (const msg of messages) {
          // Messages use sender_id (UUID), resolve to name
          const senderId = msg.sender_id || msg.sender || msg.author;
          if (!senderId) continue;
          const botName = idToName[senderId] || senderId;
          const ts = msg.created_at || msg.timestamp || now;
          if (ts < since) continue;
          if (!perBot[botName]) perBot[botName] = { count: 0, lastTs: 0 };
          perBot[botName].count++;
          if (ts > perBot[botName].lastTs) perBot[botName].lastTs = ts;
        }

        for (const [botName, data] of Object.entries(perBot)) {
          const agent = entity.resolve('connect', botName) || botName;
          events.push({
            timestamp: data.lastTs || now,
            agent,
            action: 'hxa_message',
            target_type: 'hxa-thread',
            target_title: `${data.count} message(s) in "${(thread.topic || 'thread').slice(0, 60)}"`,
            project: null,
            url: null,
            is_collab: 1,
            external_id: `hxa-msg:${botName}:${thread.id}:${Math.floor(data.lastTs / 60000)}`
          });
        }
      } catch (err) {
        // Thread messages fetch failed — skip this thread
      }
    }
  } catch (err) {
    console.error('[ActivityFetcher] HXA threads error:', err.message);
  }

  lastPoll.hxa = now;
  return events;
}

// ---------------------------------------------------------------------------
// Source 2: Scheduler task completions
// Reads the local scheduler SQLite database for recently completed tasks.
// ---------------------------------------------------------------------------
function fetchSchedulerActivity() {
  const events = [];
  const since = lastPoll.scheduler || (Date.now() - INITIAL_WINDOW_MS);
  const now = Date.now();

  // Find scheduler DBs on this machine
  const dbPaths = findSchedulerDbs();

  for (const { dbPath, agentName } of dbPaths) {
    try {
      const Database = require('better-sqlite3');
      const sdb = new Database(dbPath, { readonly: true, fileMustExist: true });

      // Scheduler uses Unix seconds, not milliseconds
      const sinceSec = Math.floor(since / 1000);
      const rows = sdb.prepare(`
        SELECT h.task_id, t.name, h.executed_at, h.completed_at, h.status, h.duration_ms
        FROM task_history h
        JOIN tasks t ON h.task_id = t.id
        WHERE h.executed_at > ? AND h.status IN ('success', 'failed', 'timeout')
        ORDER BY h.executed_at DESC
        LIMIT 50
      `).all(sinceSec);

      for (const row of rows) {
        const agent = entity.resolve('connect', agentName) || agentName;
        const statusEmoji = row.status === 'success' ? 'completed' : row.status;
        // Scheduler stores seconds, convert to ms
        const tsMs = (row.completed_at || row.executed_at) * 1000;
        events.push({
          timestamp: tsMs,
          agent,
          action: 'task_' + row.status,
          target_type: 'scheduler-task',
          target_title: `${row.name} (${statusEmoji}${row.duration_ms ? ', ' + Math.round(row.duration_ms / 1000) + 's' : ''})`,
          project: null,
          url: null,
          is_collab: 0,
          external_id: `sched:${row.task_id}:${row.executed_at}`
        });
      }

      sdb.close();
    } catch (err) {
      // DB might be locked or missing — skip silently
    }
  }

  lastPoll.scheduler = now;
  return events;
}

// ---------------------------------------------------------------------------
// Source 3: C4 messages (Feishu / Telegram / HXA-Connect / Web Console)
// Reads the local C4 SQLite database for recent message activity.
// Generates one event per (agent, channel, direction) bucket per poll window.
// ---------------------------------------------------------------------------
function fetchC4Activity() {
  const events = [];
  const since = lastPoll.c4 || (Date.now() - INITIAL_WINDOW_MS);
  const now = Date.now();

  const dbPaths = findC4Dbs();

  for (const { dbPath, agentName } of dbPaths) {
    try {
      const Database = require('better-sqlite3');
      const cdb = new Database(dbPath, { readonly: true, fileMustExist: true });

      // C4 uses 'YYYY-MM-DD HH:MM:SS' format (UTC)
      const sinceStr = new Date(since).toISOString().replace('T', ' ').slice(0, 19);

      const rows = cdb.prepare(`
        SELECT channel, direction, COUNT(*) as cnt,
               MAX(timestamp) as last_ts
        FROM conversations
        WHERE timestamp > ?
          AND channel != 'system'
        GROUP BY channel, direction
      `).all(sinceStr);

      for (const row of rows) {
        if (row.cnt === 0) continue;
        const agent = entity.resolve('connect', agentName) || agentName;
        const channelLabel = formatChannel(row.channel);
        const dirLabel = row.direction === 'out' ? 'sent' : 'received';
        // C4 timestamps are 'YYYY-MM-DD HH:MM:SS' — append Z for UTC parse
        const lastTsMs = row.last_ts ? new Date(row.last_ts + 'Z').getTime() : now;
        events.push({
          timestamp: lastTsMs || now,
          agent,
          action: row.direction === 'out' ? 'sent_message' : 'received_message',
          target_type: row.channel,
          target_title: `${dirLabel} ${row.cnt} ${channelLabel} message(s)`,
          project: null,
          url: null,
          is_collab: row.direction === 'out' ? 1 : 0,
          external_id: `c4:${agentName}:${row.channel}:${row.direction}:${Math.floor(now / 60000)}`
        });
      }

      cdb.close();
    } catch (err) {
      // DB might be locked or missing — skip silently
    }
  }

  lastPoll.c4 = now;
  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatChannel(channel) {
  const labels = {
    'feishu': 'Feishu',
    'telegram': 'Telegram',
    'hxa-connect': 'HXA',
    'web-console': 'Web'
  };
  return labels[channel] || channel;
}

function findSchedulerDbs() {
  const results = [];
  // Known paths pattern: /home/*/zylos/scheduler/scheduler.db
  const homeDir = '/home';
  try {
    const users = fs.readdirSync(homeDir);
    for (const user of users) {
      const dbPath = path.join(homeDir, user, 'zylos', 'scheduler', 'scheduler.db');
      if (fs.existsSync(dbPath)) {
        // Derive agent name from zylos identity or use directory name
        const agentName = readAgentName(path.join(homeDir, user, 'zylos')) || user;
        results.push({ dbPath, agentName });
      }
    }
  } catch {
    // Single-user fallback
    const dbPath = path.join(process.env.HOME || '/home/cocoai', 'zylos', 'scheduler', 'scheduler.db');
    if (fs.existsSync(dbPath)) {
      results.push({ dbPath, agentName: 'mylos' });
    }
  }
  return results;
}

function findC4Dbs() {
  const results = [];
  const homeDir = '/home';
  try {
    const users = fs.readdirSync(homeDir);
    for (const user of users) {
      // Check both possible locations
      for (const rel of ['zylos/comm-bridge/c4.db', 'zylos/c4.db']) {
        const dbPath = path.join(homeDir, user, rel);
        if (fs.existsSync(dbPath)) {
          const agentName = readAgentName(path.join(homeDir, user, 'zylos')) || user;
          results.push({ dbPath, agentName });
          break; // Use first found
        }
      }
    }
  } catch {
    const base = process.env.HOME || '/home/cocoai';
    for (const rel of ['zylos/comm-bridge/c4.db', 'zylos/c4.db']) {
      const dbPath = path.join(base, rel);
      if (fs.existsSync(dbPath)) {
        results.push({ dbPath, agentName: 'mylos' });
        break;
      }
    }
  }
  return results;
}

function readAgentName(zylosDir) {
  try {
    const identityPath = path.join(zylosDir, 'memory', 'identity.md');
    if (!fs.existsSync(identityPath)) return null;
    const content = fs.readFileSync(identityPath, 'utf8').slice(0, 500);
    // Look for "I am <name>" pattern
    const match = content.match(/I am (\w+)/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

async function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Main fetch — runs all three sources and inserts events into db
// ---------------------------------------------------------------------------
async function fetchAll(hubUrl, token) {
  let totalInserted = 0;

  // Run all sources (HXA is async, others are sync)
  const [hxaEvents, schedulerEvents, c4Events] = await Promise.all([
    fetchHxaActivity(hubUrl, token).catch(err => {
      console.error('[ActivityFetcher] HXA error:', err.message);
      return [];
    }),
    Promise.resolve(fetchSchedulerActivity()),
    Promise.resolve(fetchC4Activity())
  ]);

  const allEvents = [...hxaEvents, ...schedulerEvents, ...c4Events];

  for (const event of allEvents) {
    const before = db.getTimeline(1)[0]?.timestamp;
    db.insertEvent(event);
    const after = db.getTimeline(1)[0]?.timestamp;
    if (after !== before) totalInserted++;
  }

  if (totalInserted > 0) {
    console.log(`[ActivityFetcher] Inserted ${totalInserted} events (HXA:${hxaEvents.length}, Sched:${schedulerEvents.length}, C4:${c4Events.length})`);
  }

  return { total: totalInserted, hxa: hxaEvents.length, scheduler: schedulerEvents.length, c4: c4Events.length };
}

// Factory: create fetcher instance for a scope
function create(connectConfig, scopeId) {
  const hubUrl = connectConfig?.hub_url;
  const token = connectConfig?.agent_token;

  return {
    fetchAll: () => fetchAll(hubUrl, token)
  };
}

module.exports = { create, fetchAll };
