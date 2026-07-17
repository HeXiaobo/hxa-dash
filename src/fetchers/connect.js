const https = require('https');
const http = require('http');
const db = require('../db');
const entity = require('../entity');

let config = null;

function init(cfg) {
  config = cfg.connect;
}

async function fetch(url, headers = {}) {
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
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchAgents() {
  const url = `${config.hub_url}/api/bots`;
  const headers = { 'Authorization': `Bearer ${config.agent_token}` };

  try {
    const bots = await fetch(url, headers);
    const now = Date.now();
    const changes = [];

    for (const bot of bots) {
      // Auto-register unknown Connect bots (#131 — allow all Connect agents)
      entity.ensureFromConnect(bot.name);
      const ent = entity.get(bot.name);

      // Use entity meta as fallback for missing role/bio
      const entMeta = ent?.meta || {};

      const prev = db.getAgent(bot.name);
      const agent = {
        name: bot.name,
        display_name: ent?.display_name || bot.name,
        role: bot.role || entMeta.role || '',
        bio: bot.bio || entMeta.bio || '',
        tags: JSON.stringify(bot.tags || []),
        kind: entMeta.kind || 'agent', // HxA Friendly #58: 'human' | 'agent'
        online: bot.online ? 1 : 0,
        last_seen_at: bot.last_seen_at ? new Date(bot.last_seen_at).getTime() : null,
        updated_at: now
      };

      if (!prev || prev.online !== agent.online || prev.role !== agent.role) {
        changes.push(agent);
      }
      db.upsertAgent(agent);
    }

    // Purge agents no longer in Connect (#131 — use Connect as source of truth)
    const connectBotNames = new Set(bots.map(b => b.name));
    for (const agent of db.getAllAgents()) {
      if (!agent.scope && !connectBotNames.has(agent.name)) {
        db.removeAgent(agent.name);
      }
    }

    return { agents: db.getAllAgents(), changes };
  } catch (err) {
    console.error('[ConnectFetcher] Error:', err.message);
    return { agents: db.getAllAgents(), changes: [] };
  }
}

// Factory: create independent fetcher instance per scope (#100)
function create(connectConfig, scopeId) {
  if (!connectConfig || !connectConfig.hub_url || !connectConfig.agent_token) {
    const scope = scopeId || 'default';
    console.warn(`[ConnectFetcher:${scope}] Missing hub_url or agent_token — skipping`);
    return { fetchAgents: async () => ({ agents: [], changes: [] }) };
  }
  const scopeConf = connectConfig;
  const scope = scopeId || 'default';

  async function scopedFetchAgents() {
    const url = `${scopeConf.hub_url}/api/bots`;
    const headers = { 'Authorization': `Bearer ${scopeConf.agent_token}` };

    try {
      const bots = await fetch(url, headers);
      const now = Date.now();
      const changes = [];

      for (const bot of bots) {
        // Auto-register unknown Connect bots (#131)
        entity.ensureFromConnect(bot.name);
        const ent = entity.get(bot.name);
        const entMeta = ent?.meta || {};

        const prev = db.getAgent(bot.name);
        const agent = {
          name: bot.name,
          display_name: ent?.display_name || bot.name,
          role: bot.role || entMeta.role || '',
          bio: bot.bio || entMeta.bio || '',
          tags: JSON.stringify(bot.tags || []),
          kind: entMeta.kind || 'agent',
          online: bot.online ? 1 : 0,
          last_seen_at: bot.last_seen_at ? new Date(bot.last_seen_at).getTime() : null,
          updated_at: now,
          scope
        };

        if (!prev || prev.online !== agent.online || prev.role !== agent.role) {
          changes.push(agent);
        }
        db.upsertAgent(agent);
      }

      // Purge agents no longer in Connect — only within this scope (#131)
      const connectBotNames = new Set(bots.map(b => b.name));
      for (const agent of db.getAllAgents()) {
        if (agent.scope === scope && !connectBotNames.has(agent.name)) {
          db.removeAgent(agent.name);
        }
      }

      return { agents: db.getAllAgents().filter(a => a.scope === scope), changes };
    } catch (err) {
      console.error(`[ConnectFetcher:${scope}] Error:`, err.message);
      return { agents: db.getAllAgents().filter(a => a.scope === scope), changes: [] };
    }
  }

  return { fetchAgents: scopedFetchAgents };
}

module.exports = { init, fetchAgents, create };
