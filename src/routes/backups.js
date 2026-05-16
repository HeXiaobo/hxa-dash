const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const router = Router();

const STATUS_RANK = {
  critical: 0,
  warning: 1,
  unsupported: 2,
  ok: 3,
  unknown: 4,
};

const EXPECTED_BACKUP_REPOS_PATH = path.join(__dirname, '..', '..', 'config', 'expected-backup-repos.json');

function loadExpectedBackupRepos() {
  try {
    if (fs.existsSync(EXPECTED_BACKUP_REPOS_PATH)) {
      return JSON.parse(fs.readFileSync(EXPECTED_BACKUP_REPOS_PATH, 'utf8'));
    }
  } catch { /* ignore config errors */ }
  return { default_owner: 'zhi-wai', default_repo_template: '{agent}-workspace', aliases: {}, exempt: {} };
}

function githubSlug(remoteUrl) {
  const raw = String(remoteUrl || '').trim().replace(/\/$/, '').replace(/\.git$/i, '');
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() === 'github.com') {
      const [owner, repo] = parsed.pathname.replace(/^\/+/, '').split('/');
      if (owner && repo) return `${owner.toLowerCase()}/${repo.toLowerCase().replace(/\.git$/i, '')}`;
    }
  } catch {}

  const scp = raw.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].toLowerCase().replace(/\.git$/i, '')}`;
  const ssh = raw.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/i);
  if (ssh) return `${ssh[1].toLowerCase()}/${ssh[2].toLowerCase().replace(/\.git$/i, '')}`;
  return null;
}

function repoMatchesExpected(repo, expected) {
  const actual = githubSlug(repo?.remote);
  const wanted = githubSlug(expected?.url);
  return Boolean(actual && wanted && actual === wanted);
}

function hasGithubRemote(repo) {
  return /(^|[/:@])github\.com[/:]/i.test(String(repo?.remote || ''));
}

function repoDedupeKey(repo) {
  return githubSlug(repo?.remote) || `path:${String(repo?.path || '').toLowerCase()}`;
}

function repoPreferenceScore(repo, expected = null) {
  const repoPath = String(repo?.path || '').toLowerCase();
  const base = path.basename(repoPath);
  const expectedName = githubSlug(expected?.url)?.split('/')[1] || '';
  let score = 0;
  if (expectedName && base === expectedName) score += 100;
  if (expectedName && repoPath.endsWith(`/${expectedName}`)) score += 50;
  if (repoPath.includes('/backup-staging') || base.includes('backup') || base.includes('staging')) score -= 50;
  return score;
}

function dedupeBackupRepos(repos, expected = null) {
  const byKey = new Map();
  for (const repo of Array.isArray(repos) ? repos : []) {
    const key = repoDedupeKey(repo);
    if (!key) continue;
    const current = byKey.get(key);
    if (!current || repoPreferenceScore(repo, expected) > repoPreferenceScore(current, expected)) {
      byKey.set(key, repo);
    }
  }
  return [...byKey.values()];
}

function expectedBackupRepo(agentName, registry = loadExpectedBackupRepos()) {
  const name = String(agentName || '').trim().toLowerCase();
  if (!name) return { required: true, url: null, reason: null };

  const exempt = registry.exempt || {};
  if (Object.prototype.hasOwnProperty.call(exempt, name)) {
    return { required: false, url: null, reason: String(exempt[name] || '无需 GitHub 备份仓库') };
  }

  const aliases = registry.aliases || {};
  const alias = aliases[name];
  if (typeof alias === 'string' && alias.trim()) return { required: true, url: alias.trim(), reason: null };
  if (alias && typeof alias === 'object') {
    return {
      required: alias.required !== false,
      url: alias.url || null,
      reason: alias.reason || null,
    };
  }

  const owner = String(registry.default_owner || 'zhi-wai').trim();
  const template = String(registry.default_repo_template || '{agent}-workspace');
  const repo = template.replace(/\{agent\}/g, name);
  return { required: true, url: owner && repo ? `https://github.com/${owner}/${repo}` : null, reason: null };
}

function statusFromRepo(repo, expected = null, anyExpectedMatch = null) {
  if (!repo || typeof repo !== 'object') return 'critical';
  if (repo.status === 'unsupported') return 'unsupported';
  if (repo.status === 'critical' || repo.reason === 'collection_failed') return 'critical';
  if (!hasGithubRemote(repo)) return 'critical';
  if (expected?.required && expected.url && anyExpectedMatch === false && !repoMatchesExpected(repo, expected)) return 'critical';
  if ((repo.ahead || 0) > 0 || (repo.behind || 0) > 0) return 'warning';
  return 'ok';
}

function reasonFromRepo(repo, status, expected = null, anyExpectedMatch = null) {
  if (status === 'critical' && repo?.reason === 'collection_failed') return repo.reason;
  if (status === 'critical' && !hasGithubRemote(repo)) return 'no_github_remote';
  if (status === 'critical' && expected?.required && expected.url && anyExpectedMatch === false) return 'github_repo_mismatch';
  if (status === 'warning') {
    if ((repo.ahead || 0) > 0) return 'ahead_of_upstream';
    if ((repo.behind || 0) > 0) return 'behind_upstream';
  }
  if (status === 'unsupported') return repo?.reason || null;
  return null;
}

function statusFromCron(cron) {
  if (!cron || typeof cron !== 'object' || cron.supported === false) return 'unsupported';
  if (['ok', 'warning', 'critical'].includes(cron.status)) return cron.status;
  return 'warning';
}

function combineStatuses(statuses) {
  const real = statuses.filter(status => status && status !== 'unsupported');
  if (real.includes('critical')) return 'critical';
  if (real.includes('warning')) return 'warning';
  if (real.includes('ok')) return 'ok';
  return 'unsupported';
}

function normalizeCron(cron) {
  if (!cron || typeof cron !== 'object') return null;
  return {
    supported: !!cron.supported,
    status: statusFromCron(cron),
    reason: cron.reason || null,
    log_path: cron.log_path || null,
    last_success_at: cron.last_success_at || null,
    last_run_at: cron.last_run_at || null,
    latest_line: cron.latest_line || null,
  };
}

function buildBackupSummary(backup, agentName = null, registry = loadExpectedBackupRepos()) {
  const expected = expectedBackupRepo(agentName, registry);
  const expectedFields = {
    backup_required: expected.required,
    expected_remote: expected.url,
    expected_match: null,
    expected_reason: expected.reason,
  };

  if (expected.required === false) {
    return {
      supported: true,
      status: 'ok',
      reason: 'backup_not_required',
      total: 0,
      ok: 0,
      warning: 0,
      critical: 0,
      unsupported: 0,
      ahead: 0,
      behind: 0,
      dirty: 0,
      untracked: 0,
      github_remotes: 0,
      cron_status: null,
      last_success_at: null,
      last_run_at: null,
      log_path: null,
      sampled_at: backup?.sampled_at || null,
      ...expectedFields,
    };
  }

  if (!backup || typeof backup !== 'object') {
    return {
      supported: false,
      status: 'unsupported',
      reason: 'not_reported',
      total: 0,
      ok: 0,
      warning: 0,
      critical: 0,
      unsupported: 0,
      ahead: 0,
      behind: 0,
      dirty: 0,
      untracked: 0,
      github_remotes: 0,
      cron_status: null,
      last_success_at: null,
      last_run_at: null,
      log_path: null,
      sampled_at: null,
      ...expectedFields,
    };
  }

  const cron = normalizeCron(backup.cron);
  const repos = dedupeBackupRepos(backup.repos, expected);

  if ((backup.supported === false || backup.status === 'unsupported') && !cron?.supported && repos.length === 0 && backup.reason === 'not_reported') {
    return {
      supported: false,
      status: 'unsupported',
      reason: backup.reason || 'unsupported',
      total: 0,
      ok: 0,
      warning: 0,
      critical: 0,
      unsupported: 1,
      ahead: 0,
      behind: 0,
      dirty: 0,
      untracked: 0,
      github_remotes: 0,
      cron_status: null,
      last_success_at: null,
      last_run_at: null,
      log_path: null,
      sampled_at: backup.sampled_at || null,
      ...expectedFields,
    };
  }

  const anyExpectedMatch = expected.url ? repos.some(repo => repoMatchesExpected(repo, expected)) : null;
  const summary = {
    supported: true,
    status: 'ok',
    reason: null,
    total: repos.length,
    ok: 0,
    warning: 0,
    critical: 0,
    unsupported: 0,
    ahead: 0,
    behind: 0,
    dirty: 0,
    untracked: 0,
    github_remotes: 0,
    cron_status: cron?.status || null,
    last_success_at: cron?.last_success_at || null,
    last_run_at: cron?.last_run_at || null,
    log_path: cron?.log_path || null,
    sampled_at: backup.sampled_at || null,
    ...expectedFields,
    expected_match: anyExpectedMatch,
  };

  if (repos.length === 0) {
    summary.status = 'critical';
    summary.reason = backup.reason === 'git_not_available' ? 'git_not_available' : 'no_github_backup_repo';
    summary.critical = 1;
    return summary;
  }

  for (const repo of repos) {
    const status = statusFromRepo(repo, expected, anyExpectedMatch);
    summary[status] += 1;
    summary.ahead += repo.ahead || 0;
    summary.behind += repo.behind || 0;
    summary.dirty += repo.dirty || 0;
    summary.untracked += repo.untracked || 0;
    if (/(^|[/:@])github\.com[/:]/i.test(String(repo.remote || ''))) summary.github_remotes += 1;
  }

  const repoStatus = summary.critical > 0 ? 'critical'
    : summary.warning > 0 ? 'warning'
      : summary.unsupported > 0 ? 'unsupported' : 'ok';
  summary.status = combineStatuses([repoStatus, cron?.status]);
  const repoReason = repos.map(repo => {
    const status = statusFromRepo(repo, expected, anyExpectedMatch);
    return reasonFromRepo(repo, status, expected, anyExpectedMatch);
  }).find(Boolean) || null;
  const cronReason = cron?.status && !['ok', 'unsupported'].includes(cron.status) ? cron.reason : null;
  const rawReason = backup.reason && backup.reason !== 'backup_log_not_found' ? backup.reason : null;
  if (repoStatus === 'critical') summary.reason = repoReason || rawReason || cronReason;
  else if (cron?.status === 'critical') summary.reason = cronReason || rawReason || repoReason;
  else if (repoStatus === 'warning') summary.reason = repoReason || cronReason || rawReason;
  else if (cron?.status === 'warning') summary.reason = cronReason || rawReason || repoReason;
  else summary.reason = rawReason || repoReason || cronReason;
  return summary;
}

function buildBackupAgent(agent, health, registry = loadExpectedBackupRepos()) {
  const backup = health?.backup || null;
  const expected = expectedBackupRepo(agent.name, registry);
  const rawRepos = Array.isArray(backup?.repos) ? backup.repos : [];
  const dedupedRepos = dedupeBackupRepos(rawRepos, expected);
  const anyExpectedMatch = expected.url
    ? dedupedRepos.some(repo => repoMatchesExpected(repo, expected))
    : null;
  const summary = buildBackupSummary(backup, agent.name, registry);
  const repos = dedupedRepos.length
    ? dedupedRepos
        .map(repo => {
          const status = statusFromRepo(repo, expected, anyExpectedMatch);
          return { ...repo, status, reason: reasonFromRepo(repo, status, expected, anyExpectedMatch) };
        })
        .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || String(a.path || '').localeCompare(String(b.path || '')))
    : [];

  return {
    name: agent.name,
    online: !!agent.online,
    hostname: health?.hostname || null,
    reported_at: health?.reported_at || null,
    summary,
    cron: health?.backup?.cron || null,
    repos,
  };
}

function buildBackupsPayload(agents, allHealth) {
  const registry = loadExpectedBackupRepos();
  const items = agents
    .map(agent => buildBackupAgent(agent, allHealth[agent.name], registry))
    .sort((a, b) => (STATUS_RANK[a.summary.status] ?? 9) - (STATUS_RANK[b.summary.status] ?? 9) || a.name.localeCompare(b.name));

  const summary = {
    total_agents: items.length,
    ok: items.filter(item => item.summary.status === 'ok').length,
    warning: items.filter(item => item.summary.status === 'warning').length,
    critical: items.filter(item => item.summary.status === 'critical').length,
    unsupported: items.filter(item => item.summary.status === 'unsupported').length,
    repos: items.reduce((sum, item) => sum + item.summary.total, 0),
    ahead: items.reduce((sum, item) => sum + item.summary.ahead, 0),
    behind: items.reduce((sum, item) => sum + item.summary.behind, 0),
    dirty: items.reduce((sum, item) => sum + item.summary.dirty, 0),
    untracked: items.reduce((sum, item) => sum + item.summary.untracked, 0),
  };

  return {
    summary,
    agents: items,
    timestamp: Date.now(),
  };
}

router.get('/', (req, res) => {
  res.json(buildBackupsPayload(db.getAllAgents(), db.getAllAgentHealth()));
});

module.exports = router;
module.exports.__private = { buildBackupSummary, buildBackupsPayload, statusFromRepo, expectedBackupRepo, githubSlug };
