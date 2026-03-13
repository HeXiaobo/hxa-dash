const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/stats/timeline
// Agent activity histogram over time.
// Query params:
//   agent      - filter by agent name (optional)
//   days       - lookback window in days (default: 7)
//   granularity - 'hour' | 'day' (default: 'day')
router.get('/timeline', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  const granularity = req.query.granularity === 'hour' ? 'hour' : 'day';
  const agent = req.query.agent || null;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const buckets = db.buildTimeline(sinceMs, agent, granularity);
  res.json({ agent, days, granularity, buckets });
});

// GET /api/stats/trends
// Team productivity trends over time.
// Query params:
//   days - lookback window in days (default: 7, max: 30)
router.get('/trends', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  const { buckets, agents } = db.buildTrends(days);
  res.json({ days, buckets, agents });
});

// GET /api/stats/agents
// Per-agent detailed stats snapshot (30-day window).
router.get('/agents', (req, res) => {
  res.json({ agents: db.getAgentStats() });
});

module.exports = router;
