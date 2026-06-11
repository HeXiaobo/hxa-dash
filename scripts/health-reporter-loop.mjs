#!/usr/bin/env node
// health-reporter-loop.mjs — PM2-managed wrapper that runs health-reporter on interval.
// Replaces crontab-based scheduling to avoid PATH/environment issues.
//
// Usage: node health-reporter-loop.mjs [--interval SECONDS] [-- <health-reporter args>]
// Default interval: 600 seconds (10 minutes)

import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTER_SCRIPT = path.join(__dirname, 'health-reporter.mjs');

const args = process.argv.slice(2);
const separatorIdx = args.indexOf('--');
const loopArgs = separatorIdx >= 0 ? args.slice(0, separatorIdx) : args;
const reporterArgs = separatorIdx >= 0 ? args.slice(separatorIdx + 1) : [];

let interval = 600;
const intervalIdx = loopArgs.indexOf('--interval');
if (intervalIdx >= 0 && loopArgs[intervalIdx + 1]) {
  interval = parseInt(loopArgs[intervalIdx + 1], 10) || 600;
}

function runReport() {
  const start = Date.now();
  execFile(process.execPath, [REPORTER_SCRIPT, ...reporterArgs], {
    timeout: 60000,
    env: process.env,
  }, (err, stdout, stderr) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (err) {
      console.error(`[health-reporter-loop] Report failed after ${elapsed}s: ${err.message}`);
    } else {
      console.log(`[health-reporter-loop] Report completed in ${elapsed}s`);
    }
  });
}

// Run immediately on start, then on interval
runReport();
setInterval(runReport, interval * 1000);

console.log(`[health-reporter-loop] Started — reporting every ${interval}s`);
