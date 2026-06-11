#!/usr/bin/env node
// activity-reporter-openclaw.mjs - OpenClaw-compatible entrypoint.
//
// Keep this wrapper next to activity-reporter.mjs. It preserves existing
// OpenClaw cron command names while reusing the reviewed reporter implementation,
// including --api-key / HXA_INGEST_API_KEY / HEALTH_API_KEY support.

import './activity-reporter.mjs';
