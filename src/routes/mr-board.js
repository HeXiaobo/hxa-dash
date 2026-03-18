// MR Pipeline Board + Review Bottleneck Alert (#109 + #110)
const { Router } = require('express');
const db = require('../db');
const entity = require('../entity');

const router = Router();

let gitlabConfig = null;
let apiFetchFn = null;

function init(config) {
  gitlabConfig = config.gitlab;
  // Build an apiFetch using the same pattern as gitlab fetcher
  const https = require('https');
  const http = require('http');
  apiFetchFn = (endpoint) => {
    const url = `${gitlabConfig.url}/api/v4${endpoint}`;
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, {
        headers: { 'PRIVATE-TOKEN': gitlabConfig.token }
      }, (res) => {
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
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  };
}

function mapUsername(gitlabUsername) {
  return entity.resolve('gitlab', gitlabUsername);
}

// GET /api/mr-board — live MR pipeline board with bottleneck alerts
// Query params:
//   project_id - filter MRs to a specific GitLab project (recommended)
router.get('/', async (req, res) => {
  if (!gitlabConfig || !apiFetchFn) {
    return res.status(503).json({ error: 'GitLab not configured' });
  }

  try {
    const now = Date.now();
    const agents = db.getAllAgents();
    const agentMap = new Map(agents.map(a => [a.name, a]));

    // Fetch open MRs from GitLab (live, not cached)
    let mrEndpoint = `/groups/${gitlabConfig.group_id}/merge_requests?state=opened&per_page=50&order_by=updated_at&sort=desc`;

    // Filter by project_id if provided — prevents cross-project MR mixing
    const projectIdFilter = req.query.project_id;
    if (projectIdFilter) {
      const pid = parseInt(projectIdFilter, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        return res.status(400).json({ error: 'Invalid project_id: must be a positive integer' });
      }
      // Use project-level endpoint instead of group-level
      mrEndpoint = `/projects/${pid}/merge_requests?state=opened&per_page=50&order_by=updated_at&sort=desc`;
    }

    const mrsRaw = await apiFetchFn(mrEndpoint);
    // Double-check state — GitLab API may return stale merged/closed MRs
    const mrs = mrsRaw.filter(mr => mr.state === 'opened');

    // Fetch pipeline status for each MR in parallel
    const enriched = await Promise.all(mrs.map(async (mr) => {
      let pipelineStatus = 'unknown';
      let pipelineUrl = null;
      try {
        const pipelines = await apiFetchFn(
          `/projects/${mr.project_id}/merge_requests/${mr.iid}/pipelines`
        );
        if (pipelines.length > 0) {
          pipelineStatus = pipelines[0].status; // success, failed, running, pending, canceled
          pipelineUrl = pipelines[0].web_url || null;
        } else {
          pipelineStatus = 'none';
        }
      } catch {
        pipelineStatus = 'error';
      }

      const author = mr.author ? mapUsername(mr.author.username) : null;
      const reviewers = (mr.reviewers || []).map(r => mapUsername(r.username));
      const assignees = (mr.assignees || []).map(a => mapUsername(a.username));
      const project = mr.references?.full?.split('!')[0]?.replace(/\/$/, '')?.split('/')?.pop() || 'unknown';

      const createdAt = new Date(mr.created_at).getTime();
      const updatedAt = new Date(mr.updated_at).getTime();
      const waitMinutes = Math.floor((now - createdAt) / 60000);
      const idleMinutes = Math.floor((now - updatedAt) / 60000);

      // Bottleneck detection (#110)
      let bottleneck = null;
      if (reviewers.length === 0 && assignees.length === 0) {
        bottleneck = { level: idleMinutes >= 60 ? 'critical' : 'warning', reason: 'no_reviewer' };
      } else if (idleMinutes >= 60) {
        bottleneck = { level: 'critical', reason: 'idle_60m' };
      } else if (idleMinutes >= 30) {
        bottleneck = { level: 'warning', reason: 'idle_30m' };
      }

      // Suggest alternative reviewers (#110)
      let suggestedReviewers = [];
      if (bottleneck && bottleneck.level) {
        const currentReviewerSet = new Set([...reviewers, author]);
        suggestedReviewers = agents
          .filter(a => a.online && !currentReviewerSet.has(a.name))
          .map(a => a.name)
          .slice(0, 3);
      }

      return {
        iid: mr.iid,
        title: mr.title,
        url: mr.web_url,
        project,
        projectId: mr.project_id,
        author,
        reviewers,
        assignees,
        pipeline: {
          status: pipelineStatus,
          url: pipelineUrl
        },
        createdAt,
        updatedAt,
        waitMinutes,
        idleMinutes,
        bottleneck: bottleneck?.level ? bottleneck : null,
        suggestedReviewers,
        sourceBranch: mr.source_branch,
        labels: mr.labels || [],
        hasConflicts: mr.has_conflicts || false,
        draft: mr.draft || mr.work_in_progress || false
      };
    }));

    // Sort: bottleneck critical first, then warning, then by idle time desc
    enriched.sort((a, b) => {
      const levelOrder = { critical: 0, warning: 1 };
      const la = a.bottleneck ? (levelOrder[a.bottleneck.level] ?? 2) : 2;
      const lb = b.bottleneck ? (levelOrder[b.bottleneck.level] ?? 2) : 2;
      if (la !== lb) return la - lb;
      return b.idleMinutes - a.idleMinutes;
    });

    // Summary
    const pipelineCounts = { success: 0, failed: 0, running: 0, pending: 0, none: 0, other: 0 };
    for (const mr of enriched) {
      const s = mr.pipeline.status;
      if (pipelineCounts[s] !== undefined) pipelineCounts[s]++;
      else pipelineCounts.other++;
    }

    const bottleneckCount = enriched.filter(m => m.bottleneck).length;

    res.json({
      mrs: enriched,
      summary: {
        total: enriched.length,
        pipeline: pipelineCounts,
        bottlenecks: bottleneckCount,
        critical: enriched.filter(m => m.bottleneck?.level === 'critical').length,
        warning: enriched.filter(m => m.bottleneck?.level === 'warning').length
      },
      timestamp: now
    });
  } catch (err) {
    console.error('[MR Board] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.init = init;
