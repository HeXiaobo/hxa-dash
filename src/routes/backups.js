const { Router } = require('express');
const db = require('../db');

const router = Router();

const STATUS_RANK = {
  critical: 0,
  warning: 1,
  unsupported: 2,
  ok: 3,
  unknown: 4,
};

function statusFromRepo(repo) {
  if (!repo || typeof repo !== 'object') return 'critical';
  if (repo.status === 'unsupported') return 'unsupported';
  if (repo.status === 'critical' || repo.reason === 'collection_failed') return 'critical';
  if (!/(^|[/:@])github\.com[/:]/i.test(String(repo.remote || ''))) return 'critical';
  if ((repo.ahead || 0) > 0 || (repo.behind || 0) > 0 || (repo.dirty || 0) > 0 || (repo.untracked || 0) > 0) {
    return 'warning';
  }
  return 'ok';
}

function reasonFromRepo(repo, status) {
  if (repo?.reason) return repo.reason;
  if (status === 'critical' && !/(^|[/:@])github\.com[/:]/i.test(String(repo?.remote || ''))) return 'no_github_remote';
  if (status === 'warning') {
    if ((repo.ahead || 0) > 0) return 'ahead_of_upstream';
    if ((repo.dirty || 0) > 0) return 'dirty_worktree';
    if ((repo.untracked || 0) > 0) return 'untracked_files';
    if ((repo.behind || 0) > 0) return 'behind_upstream';
  }
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

function buildBackupSummary(backup) {
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
    };
  }

  const cron = normalizeCron(backup.cron);
  const repos = Array.isArray(backup.repos) ? backup.repos : [];

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
    };
  }

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
  };

  if (repos.length === 0) {
    summary.status = 'critical';
    summary.reason = backup.reason === 'git_not_available' ? 'git_not_available' : 'no_github_backup_repo';
    summary.critical = 1;
    return summary;
  }

  for (const repo of repos) {
    const status = statusFromRepo(repo);
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
  summary.reason = cron?.status && cron.status !== 'ok'
    ? cron.reason
    : backup.reason || repos.map(repo => reasonFromRepo(repo, statusFromRepo(repo))).find(Boolean) || null;
  return summary;
}

function buildBackupAgent(agent, health) {
  const backup = health?.backup || null;
  const summary = buildBackupSummary(backup);
  const repos = Array.isArray(backup?.repos)
    ? backup.repos
        .map(repo => {
          const status = statusFromRepo(repo);
          return { ...repo, status, reason: reasonFromRepo(repo, status) };
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
  const items = agents
    .map(agent => buildBackupAgent(agent, allHealth[agent.name]))
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
module.exports.__private = { buildBackupSummary, buildBackupsPayload, statusFromRepo };
