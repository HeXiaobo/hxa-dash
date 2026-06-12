const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  dry_run: true,
  github: {
    owner: 'HeXiaobo',
    repo: 'hxa-dash',
    token_env: 'HXA_BRIDGE_GITHUB_TOKEN',
    api_base: 'https://api.github.com',
  },
  feishu: {
    mode: 'lark-cli',
    bridge_bot_sender_ids: [],
    ignored_sender_types: ['app', 'bot'],
    allowed_chat_ids: [],
    allowed_sender_ids: [],
    command_allowed_sender_ids: {
      issue: [],
      comment: [],
      codex: [],
    },
  },
  commands: {
    issue: true,
    comment: true,
    codex: true,
  },
});

function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return base;
  const merged = { ...base, ...override };
  merged.github = { ...base.github, ...(override.github || {}) };
  merged.feishu = { ...base.feishu, ...(override.feishu || {}) };
  merged.feishu.command_allowed_sender_ids = {
    ...base.feishu.command_allowed_sender_ids,
    ...(override.feishu?.command_allowed_sender_ids || {}),
  };
  merged.commands = { ...base.commands, ...(override.commands || {}) };
  return merged;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadBridgeConfig(options = {}) {
  const configPath = options.path || process.env.HXA_BRIDGE_CONFIG || path.join(__dirname, '..', '..', 'config', 'bridge.json');
  const base = mergeConfig(DEFAULT_CONFIG, {});
  if (!fs.existsSync(configPath)) return base;
  return mergeConfig(base, readJson(configPath));
}

module.exports = {
  DEFAULT_CONFIG,
  loadBridgeConfig,
  mergeConfig,
};
