# Issue #25 production go-live checklist

Status: approved release procedure

Production owner: Mylos
Target: `https://hxa.zhiw.ai` / PM2 `hxa-dash` / port `3479`

This checklist supplements `docs/auth-production-runbook.md`. The runbook is
canonical; legacy `deploy/deploy.sh` is not used for this release because the
current production release is a clean pinned detached commit and the legacy
script assumes an interactive `main` checkout.

## Before deployment

- [ ] Veda has approved collection/work/freshness semantics.
- [ ] SS has approved roster allowlisting, secret stripping, auth, and runbook.
- [ ] Record the current production commit and verify the release tree is clean.
- [ ] Record `/api/about`, PM2 restart count, and latest reporter timestamps.
- [ ] Snapshot `health.db` outside the release directory.
- [ ] Prepare a new clean release directory at the reviewed commit.
- [ ] Keep the prior clean release commit/directory as the rollback target.

## Deploy

- [ ] Install locked dependencies with `npm ci`.
- [ ] Start the candidate on the production port with auth initially disabled,
      following `docs/auth-production-runbook.md`.
- [ ] Confirm `/api/about` reports the exact reviewed commit.
- [ ] Confirm local `/api/health` and the Cloudflare public route respond.
- [ ] Enable auth and restart PM2 with the persisted environment.

## Fact-based verification

- [ ] unauthenticated protected API returns 401
- [ ] machine ingest key remains accepted
- [ ] Feishu login/callback returns to the dashboard
- [ ] `/api/team`, `/api/limits`, `/api/tokens`, and `/api/backups` return
      non-empty expected data
- [ ] the monitoring homepage and backup page render on desktop and mobile
- [ ] the browser's bare WebSocket connection is live and a pushed update
      changes the same employee row
- [ ] send one authenticated canary health report and verify its stored
      `reported_at` advances; `/api/health` alone is insufficient
- [ ] verify a real reporter timestamp advances within its reporting cadence
- [ ] verify stale data renders as collection delay, never employee offline
- [ ] verify backup status is anchored to the latest successful backup
- [ ] verify no uncaught browser console error

## Rollback

If any verification fails:

- [ ] switch PM2 back to the prior pinned clean release
- [ ] restore dependencies for that release
- [ ] restart `hxa-dash`
- [ ] repeat commit, auth, canary ingest, WebSocket, reporter freshness, and
      backup probes
- [ ] retain the failed candidate and evidence for diagnosis; do not mutate the
      rollback release
