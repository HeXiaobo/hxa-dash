// Agent Entity Resolution Layer
// Each agent entity has a canonical ID and multiple identities from different data sources.
// All data (tasks, events, edges) reference entities by canonical ID.

const entities = new Map(); // canonical_id -> entity
const identityIndex = new Map(); // "source:identifier" -> canonical_id

/**
 * Register or update an agent entity.
 * @param {string} canonicalId - Primary identifier (usually Connect bot name)
 * @param {object} identities - { connect: 'name', gitlab: 'username', github: 'username', ... }
 * @param {object} meta - Additional metadata (display_name, role, bio, etc.)
 */
function register(canonicalId, identities = {}, meta = {}) {
  const existing = entities.get(canonicalId);
  const entity = {
    id: canonicalId,
    display_name: meta.display_name || existing?.display_name || canonicalId,
    identities: { ...(existing?.identities || {}), ...identities },
    meta: { ...(existing?.meta || {}), ...meta }
  };
  entities.set(canonicalId, entity);

  // Index all identities for reverse lookup
  for (const [source, identifier] of Object.entries(entity.identities)) {
    if (identifier) {
      identityIndex.set(`${source}:${identifier}`, canonicalId);
      // Also index lowercase variant for case-insensitive matching
      identityIndex.set(`${source}:${identifier.toLowerCase()}`, canonicalId);
    }
  }
}

/**
 * Resolve a source-specific identifier to canonical entity ID.
 * @param {string} source - Data source name ('connect', 'gitlab', 'github', etc.)
 * @param {string} identifier - The identifier in that source
 * @returns {string} Canonical entity ID, or the original identifier if no match
 */
function resolve(source, identifier) {
  if (!identifier) return identifier;
  const key = `${source}:${identifier}`;
  return identityIndex.get(key) || identityIndex.get(`${source}:${identifier.toLowerCase()}`) || identifier;
}

/**
 * Get entity by canonical ID.
 */
function get(canonicalId) {
  return entities.get(canonicalId) || null;
}

/**
 * Get all registered entities.
 */
function getAll() {
  return [...entities.values()];
}

/**
 * Load entity definitions from config.
 * Config format: { entities: [ { id, display_name, identities: { connect, gitlab, github, ... } }, ... ] }
 */
function loadFromConfig(entityConfigs) {
  if (!Array.isArray(entityConfigs)) return;
  for (const cfg of entityConfigs) {
    register(cfg.id, cfg.identities || {}, {
      display_name: cfg.display_name || cfg.id,
      role: cfg.role || '',
      bio: cfg.bio || '',
      kind: cfg.kind || '',
      skills: cfg.skills || []
    });
  }
}

/**
 * Get skills for an entity by canonical ID.
 * @returns {string[]} Array of skill tags
 */
function getSkills(canonicalId) {
  const e = entities.get(canonicalId);
  return e?.meta?.skills || [];
}

/**
 * Auto-register an entity from Connect data (if not already known).
 * Connect bot name becomes the canonical ID with connect identity.
 */
function ensureFromConnect(botName) {
  if (!entities.has(botName)) {
    register(botName, { connect: botName });
  }
  return botName;
}

module.exports = { register, resolve, get, getAll, loadFromConfig, ensureFromConnect, getSkills };
