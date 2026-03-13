// Skill-based task recommendation engine (#74)
// Matches issue content (labels, title keywords) to agent skills,
// combined with workload scoring for assignment recommendations.

const db = require('./db');
const entity = require('./entity');

// Keyword → skill mapping for issue content analysis
const KEYWORD_SKILLS = {
  // Frontend
  'ui': 'frontend', 'ux': 'ux', 'frontend': 'frontend', 'css': 'frontend',
  'layout': 'frontend', 'component': 'frontend', 'responsive': 'frontend',
  'mobile': 'mobile', 'capacitor': 'capacitor', 'react': 'react',
  'next.js': 'frontend', 'tailwind': 'frontend',
  // Backend
  'api': 'api', 'backend': 'backend', 'endpoint': 'api', 'database': 'database',
  'db': 'database', 'schema': 'database', 'orm': 'orm', 'fastify': 'backend',
  'drizzle': 'orm', 'auth': 'auth', 'jwt': 'auth', 'oauth': 'auth',
  // DevOps / Infra
  'deploy': 'devops', 'ci': 'ci', 'pipeline': 'ci', 'infra': 'infra',
  'webhook': 'webhook', 'pm2': 'devops', 'caddy': 'devops', 'docker': 'devops',
  'runner': 'ci',
  // Security
  'security': 'security', 'xss': 'security', 'injection': 'security',
  'privacy': 'privacy', 'encryption': 'security', 'vulnerability': 'security',
  // Design / Docs
  'design': 'design', 'prototype': 'prototype', 'docs': 'docs',
  'documentation': 'docs', 'readme': 'docs', 'architecture': 'architecture',
  // Agent / Template
  'agent': 'agent', 'template': 'template', 'bot': 'agent',
  // Social
  'social': 'social', 'chat': 'social', 'im': 'social',
  // Testing
  'test': 'testing', 'testing': 'testing', 'e2e': 'testing', 'vitest': 'testing',
  // Review
  'review': 'review', 'code review': 'review',
};

/**
 * Extract skill signals from an issue's title and labels.
 * Returns a Set of matched skill tags.
 */
function extractSkills(issue) {
  const skills = new Set();
  const text = `${issue.title || ''} ${issue.labels || ''}`.toLowerCase();

  for (const [keyword, skill] of Object.entries(KEYWORD_SKILLS)) {
    if (text.includes(keyword)) {
      skills.add(skill);
    }
  }
  return skills;
}

/**
 * Score an agent for a given issue.
 * Higher score = better match.
 *
 * Factors:
 * - Skill match (0-100): % of issue skills that the agent has
 * - Workload penalty (0-50): fewer open tasks = higher score
 * - Online bonus (0-20): online agents preferred
 * - Human penalty (-30): prefer assigning to AI agents over humans
 */
function scoreAgent(agentId, issueSkills, now) {
  const agentSkills = entity.getSkills(agentId);
  const agentData = db.getAgent(agentId);
  if (!agentData) return { score: 0, breakdown: {} };

  const OFFLINE_MS = 30 * 60 * 1000;
  const e = entity.get(agentId);

  // Skill match score (0-100)
  let skillScore = 0;
  const issueSkillArr = [...issueSkills];
  if (issueSkillArr.length > 0 && agentSkills.length > 0) {
    const matched = issueSkillArr.filter(s => agentSkills.includes(s)).length;
    skillScore = Math.round((matched / issueSkillArr.length) * 100);
  } else if (issueSkillArr.length === 0) {
    // No skill signals in issue — all agents equally valid
    skillScore = 50;
  }

  // Workload score (0-50): fewer open tasks = higher
  const openTasks = db.getTasksForAgent(agentId, { assigneeOnly: true })
    .filter(t => t.state === 'opened').length;
  const workloadScore = Math.max(0, 50 - openTasks * 10);

  // Online bonus (0-20)
  let onlineScore = 0;
  if (agentData.online) {
    const isStale = agentData.last_seen_at && (now - agentData.last_seen_at) > OFFLINE_MS;
    onlineScore = isStale ? 5 : 20;
  }

  // Human penalty: prefer AI agents
  const humanPenalty = (e?.meta?.kind === 'human') ? -30 : 0;

  const total = skillScore + workloadScore + onlineScore + humanPenalty;

  return {
    score: total,
    breakdown: {
      skill: skillScore,
      workload: workloadScore,
      online: onlineScore,
      human_penalty: humanPenalty,
      open_tasks: openTasks,
      matched_skills: agentSkills.filter(s => issueSkills.has(s)),
    }
  };
}

/**
 * Recommend assignees for an issue, ranked by score.
 * Returns top N candidates with scores.
 */
function recommend(issue, { topN = 3, excludeHumans = false } = {}) {
  const issueSkills = extractSkills(issue);
  const now = Date.now();

  const allEntities = entity.getAll();
  const candidates = allEntities
    .filter(e => {
      if (excludeHumans && e.meta?.kind === 'human') return false;
      // Must have a db agent record (known to the system)
      return db.getAgent(e.id) !== null;
    })
    .map(e => {
      const { score, breakdown } = scoreAgent(e.id, issueSkills, now);
      return {
        agent: e.id,
        display_name: e.display_name,
        score,
        breakdown,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return {
    issue_skills: [...issueSkills],
    candidates,
  };
}

/**
 * Get all unassigned issues with recommendations.
 */
function getUnassignedWithRecommendations() {
  const unassigned = db.getUnassignedIssues();
  return unassigned.map(issue => ({
    ...issue,
    recommendation: recommend(issue),
  }));
}

module.exports = { extractSkills, scoreAgent, recommend, getUnassignedWithRecommendations };
