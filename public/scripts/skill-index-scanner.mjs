#!/usr/bin/env node
// skill-index-scanner.mjs — Scan and compare skill-index.json across agents
// Usage:
//   node skill-index-scanner.mjs scan              # Scan local agent's skill-index
//   node skill-index-scanner.mjs compare <dir>     # Compare all skill-index.json files in <dir>
//   node skill-index-scanner.mjs baseline          # Show baseline coverage for local agent
//   node skill-index-scanner.mjs generate          # Auto-generate skill-index.json from installed skills

import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const ZYLOS_DIR = path.join(HOME, 'zylos');
const INDEX_PATH = path.join(ZYLOS_DIR, 'skill-index.json');

function loadIndex(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function scanLocal() {
  const index = loadIndex(INDEX_PATH);
  if (!index) {
    console.log('[scanner] No skill-index.json found. Run "generate" to create one.');
    return;
  }

  const skills = index.skills || {};
  const byPool = {};
  const byRole = {};
  const byStatus = {};

  for (const [name, meta] of Object.entries(skills)) {
    const pool = meta.pool || 'unknown';
    const role = meta.role || 'unclassified';
    const status = meta.status || 'unknown';

    byPool[pool] = (byPool[pool] || 0) + 1;
    byRole[role] = (byRole[role] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  console.log(`\n[${index.agent}] Skill Index Summary`);
  console.log(`  Total skills: ${Object.keys(skills).length}`);
  console.log(`  Updated: ${index.updated_at}`);
  console.log(`\n  By pool:`);
  for (const [k, v] of Object.entries(byPool)) console.log(`    ${k}: ${v}`);
  console.log(`\n  By role:`);
  for (const [k, v] of Object.entries(byRole)) console.log(`    ${k}: ${v}`);
  console.log(`\n  By status:`);
  for (const [k, v] of Object.entries(byStatus)) console.log(`    ${k}: ${v}`);

  return index;
}

function compareIndices(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const indices = [];

  for (const f of files) {
    const idx = loadIndex(path.join(dir, f));
    if (idx && idx.skills) {
      idx._file = f;
      indices.push(idx);
    }
  }

  if (indices.length < 2) {
    console.log('[scanner] Need at least 2 skill-index files to compare.');
    return;
  }

  // Build skill→agents map
  const skillAgents = {};
  for (const idx of indices) {
    const agent = idx.agent || idx._file;
    for (const [name, meta] of Object.entries(idx.skills)) {
      if (!skillAgents[name]) skillAgents[name] = [];
      skillAgents[name].push({ agent, ...meta });
    }
  }

  // Find overlaps (same skill, 2+ agents)
  const overlaps = Object.entries(skillAgents)
    .filter(([, agents]) => agents.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  // Find unique skills (only 1 agent)
  const unique = Object.entries(skillAgents)
    .filter(([, agents]) => agents.length === 1);

  // Find divergences (same skill, different pools or statuses)
  const divergences = overlaps.filter(([, agents]) => {
    const pools = new Set(agents.map(a => a.pool));
    return pools.size > 1;
  });

  console.log(`\n[scanner] Comparison: ${indices.length} agents`);
  console.log(`  Agents: ${indices.map(i => i.agent || i._file).join(', ')}`);
  console.log(`  Total unique skills: ${Object.keys(skillAgents).length}`);

  console.log(`\n  Shared skills (${overlaps.length}):`);
  for (const [name, agents] of overlaps.slice(0, 20)) {
    const who = agents.map(a => a.agent).join(', ');
    console.log(`    ${name} — ${agents.length} agents (${who})`);
  }

  if (divergences.length) {
    console.log(`\n  Divergences (same skill, different sources — ${divergences.length}):`);
    for (const [name, agents] of divergences) {
      for (const a of agents) {
        console.log(`    ${name} @ ${a.agent}: pool=${a.pool} status=${a.status}`);
      }
    }
  }

  if (unique.length) {
    console.log(`\n  Unique skills (only 1 agent — ${unique.length}):`);
    for (const [name, agents] of unique.slice(0, 20)) {
      console.log(`    ${name} — ${agents[0].agent} (${agents[0].pool})`);
    }
    if (unique.length > 20) console.log(`    ... and ${unique.length - 20} more`);
  }
}

function showBaseline() {
  const index = loadIndex(INDEX_PATH);
  if (!index) {
    console.log('[scanner] No skill-index.json found.');
    return;
  }

  const baseline = index.baseline || {};
  const installed = new Set(Object.keys(index.skills || {}));

  console.log(`\n[${index.agent}] Baseline Coverage`);
  for (const [category, skills] of Object.entries(baseline)) {
    if (category === 'description') continue;
    const covered = skills.filter(s => installed.has(s));
    const missing = skills.filter(s => !installed.has(s));
    console.log(`\n  ${category}: ${covered.length}/${skills.length}`);
    if (missing.length) {
      console.log(`    Missing: ${missing.join(', ')}`);
    }
  }
}

function generate() {
  const localSkillDirs = [
    path.join(ZYLOS_DIR, '.claude', 'skills'),
    path.join(HOME, '.claude', 'skills'),
  ];
  const skills = {};

  for (const skillsDir of localSkillDirs) {
    if (fs.existsSync(skillsDir)) {
      for (const name of fs.readdirSync(skillsDir)) {
        const skillPath = path.join(skillsDir, name);
        if (fs.statSync(skillPath).isDirectory() && !skills[name]) {
          skills[name] = { pool: 'local', status: 'active', role: 'unclassified' };
        }
      }
    }
  }

  // Check shared pools
  const sharedPools = [
    { name: '3ai', path: path.join(ZYLOS_DIR, 'workspace', 'skills', 'plugins') },
    { name: 'zhiwai', path: path.join(ZYLOS_DIR, 'workspace', 'zhiwai-shared', 'skills') },
  ];

  for (const pool of sharedPools) {
    if (fs.existsSync(pool.path)) {
      for (const name of fs.readdirSync(pool.path)) {
        const sp = path.join(pool.path, name);
        if (fs.statSync(sp).isDirectory()) {
          skills[name] = { pool: pool.name, status: 'available', role: 'unclassified' };
        }
      }
    }
  }

  const botName = detectBotName();
  const index = {
    version: '1.0',
    agent: botName,
    updated_at: new Date().toISOString().split('T')[0],
    pools: {
      local: { path: '~/.claude/skills', description: 'Agent-local skills' },
      '3ai': { repo: 'with3ai/skills', path: '~/zylos/workspace/skills', description: '3AI shared skills' },
      zhiwai: { repo: 'zhi-wai/zhiwai-shared', path: '~/zylos/workspace/zhiwai-shared/skills', description: '知外共享技能' },
    },
    skills,
    baseline: {
      description: 'Recommended starting set for new agents',
      system: ['comm-bridge', 'feishu', 'hxa-connect', 'scheduler', 'health-check', 'new-session', 'zylos-memory', 'web-access'],
      productivity: ['comm-adapter', 'meeting-notes-processor'],
      knowledge: ['knowledge-compile'],
    },
  };

  const outPath = path.join(ZYLOS_DIR, 'skill-index.json');
  fs.writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n');
  console.log(`[scanner] Generated ${outPath} with ${Object.keys(skills).length} skills`);

  return index;
}

function detectBotName() {
  try {
    const identity = fs.readFileSync(path.join(ZYLOS_DIR, 'memory', 'identity.md'), 'utf-8');
    // Try HXA-Connect name first (most reliable for bot identity)
    const hxaMatch = identity.match(/HXA-Connect:\s*(\w+)/i);
    if (hxaMatch) return hxaMatch[1].toLowerCase();
    // Try "I am <Name>." pattern but skip generic "Zylos"
    const nameMatches = [...identity.matchAll(/I am (\w+)/gi)].map(m => m[1].toLowerCase());
    const filtered = nameMatches.filter(n => n !== 'zylos' && n !== 'an');
    if (filtered.length) return filtered[0];
    if (nameMatches.length) return nameMatches[0];
  } catch {}
  // Fall back to --name arg or system username
  const nameArg = process.argv.indexOf('--name');
  if (nameArg >= 0 && process.argv[nameArg + 1]) return process.argv[nameArg + 1];
  return os.userInfo().username;
}

// CLI
const cmd = process.argv[2] || 'scan';

switch (cmd) {
  case 'scan': scanLocal(); break;
  case 'compare': compareIndices(process.argv[3] || '.'); break;
  case 'baseline': showBaseline(); break;
  case 'generate': generate(); break;
  default: console.log('Usage: skill-index-scanner.mjs [scan|compare <dir>|baseline|generate]');
}
