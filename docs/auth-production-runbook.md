# Feishu auth production runbook (#4)

This runbook is the production checklist for enabling the reviewed Feishu auth
boundary without interrupting hxa-dash ingest.

## Safety rules

- Codex owns coding, PRs, and pre-production verification.
- For issue #25, Mylos owns release decisions. Codex executes production work
  only through a host-local Codex task or an explicitly approved, restricted
  access path to `cocoai-3ai-1b`.
- Do not deploy from an uncommitted production working tree.
- Post the pinned deploy commit and rollback commit on #4 before changing PM2.
- The public Cloudflare route must never serve hxa-dash with
  `HXA_AUTH_ENABLED=false`. If auth cannot be verified, keep the release on
  hold or stop `cloudflared-hxa`; do not expose an auth-disabled candidate.
- `HEALTH_API_KEY` must be configured and verified before the production
  reload. Secrets stay on the production host and evidence reports only
  boolean configuration state.

## Required production configuration

Set these on the PM2 service host before any public production reload:

| Variable or config | Required value |
|---|---|
| `HXA_AUTH_ENABLED` | `true`. Never expose the Cloudflare route while this is `false`. |
| `HXA_AUTH_SECRET` | Strong random HMAC secret, persisted in PM2 ecosystem/env. Rotating it logs everyone out. |
| `FEISHU_APP_ID` | Feishu app id used for dashboard login. |
| `FEISHU_APP_SECRET` | Feishu app secret. |
| `FEISHU_TENANT_KEY` | Zhiwai tenant key. |
| `HXA_PUBLIC_BASE_URL` | `https://hxa.zhiw.ai` in production. |
| `HXA_COOKIE_SECURE` | `true` in production because the public URL is HTTPS. |
| `HEALTH_API_KEY` | Existing health reporter key. |
| `HXA_INGEST_API_KEY` | Set to the same value as `HEALTH_API_KEY` for the first rollout. Confirm the fleet health reporters use the same shared key. |
| `HXA_CONNECT_WEBHOOK_PUBLIC` | Optional temporary fallback. Default `false`; set `true` only if the central HXA Connect producer cannot send an ingest key before the auth flip. |
| `webhooks.gitlab_secret` | GitLab webhook secret in `config/sources.json`. |

`src/server.js` loads the app root `.env` at startup with override enabled, so
the checked deployment directory's `.env` is the authoritative source when PM2
or a parent shell contains stale or blank values for the same keys.

In the Feishu developer console, register this redirect URI before the flip:

```text
https://hxa.zhiw.ai/auth/callback
```

The app also needs the OIDC/authen scopes required by the Feishu login API.

## Reporter and webhook key rollout

When `HXA_AUTH_ENABLED=true`, browser traffic uses the Feishu cookie and machine
ingest uses server-to-server secrets. The health reporter key is a release gate;
other reporter distribution may fast-follow only when Mylos records that it
does not block this release:

| Endpoint | Producer | Required production action |
|---|---|---|
| `POST /api/agent-health/:name` | health reporter | Already supports `X-API-Key`; ensure every host has `HEALTH_API_KEY`. |
| `POST /api/report/activity` | activity reporter | Deploy the updated reporter or pass `--api-key`; it reads `HXA_INGEST_API_KEY` or `HEALTH_API_KEY`. Old reporter copies ignore `--api-key`, so code distribution must happen before the auth flip. |
| `POST /api/report/activity` | OpenClaw activity reporter | Deploy `activity-reporter-openclaw.mjs` next to `activity-reporter.mjs`; it reuses the same implementation and key behavior. |
| `POST /api/report` | legacy heartbeat clients | Add `X-API-Key: $HXA_INGEST_API_KEY` or `Authorization: Bearer $HXA_INGEST_API_KEY`. |
| `POST /api/webhook/connect` | HXA Connect callback | Add `X-API-Key: $HXA_INGEST_API_KEY` or `Authorization: Bearer $HXA_INGEST_API_KEY` on the central HXA Connect producer, not on per-bot reporter scripts. If platform support is not ready, set `HXA_CONNECT_WEBHOOK_PUBLIC=true` as a documented temporary fallback so online/offline status keeps updating after the auth flip. |
| `POST /api/webhook/gitlab` | GitLab webhook | Configure `webhooks.gitlab_secret` and set the same secret in GitLab. GitLab should use `X-GitLab-Token`, not `X-API-Key`. |

The server accepts both `HXA_INGEST_API_KEY` and `HEALTH_API_KEY` for ingest
compatibility. Setting `HXA_INGEST_API_KEY` to the existing `HEALTH_API_KEY`
value lets the fleet migrate one producer at a time.

Use the checked-in distribution helper when rolling out activity reporter keys:

```bash
bash scripts/deploy-activity-reporter.sh --dry-run
bash scripts/deploy-activity-reporter.sh
```

The helper sends update instructions to bot owners; it does not SSH or mutate
production hosts directly. The instructions detect the actual reporter file
paths from crontab, PM2, running processes, and known fallback locations, then
replace those files in place. This matters because fleet hosts may run reporters
from `~/hxa-dash/scripts/`, `~/zylos/workspace/hxa-dash/scripts/`, or the
main fleet path `~/zylos/workspace/hxa-dash-reporter/`. For C5 interval tasks,
confirm the command inherits `HEALTH_API_KEY` / `HXA_INGEST_API_KEY` or includes
`--api-key` from the secure local key source.

Do not run `scripts/deploy-health-reporter.sh` for issue #25. The reviewed health
reporter is distributed separately after release without weakening public auth.

## Pre-deploy checklist

1. Confirm PR #8 is reviewed and merged.
2. Confirm production WIP is preserved by the existing WIP branches listed on #4.
3. Confirm the release `.env` resolves `HXA_AUTH_ENABLED=true` and a non-empty
   `HEALTH_API_KEY` without printing the key.
4. Confirm all required Feishu, cookie, base URL, and ingest env vars are present.
5. Confirm Feishu redirect URI is registered.
6. Confirm GitLab webhook secret is configured on both sides.
7. Confirm `HEALTH_API_KEY` is the shared key currently accepted by production.
8. Confirm activity reporters and OpenClaw activity reporters are distributed and tested, including the main `~/zylos/workspace/hxa-dash-reporter/` path and C5 interval key source.
9. Confirm the central HXA Connect callback producer sends the ingest key, or explicitly set `HXA_CONNECT_WEBHOOK_PUBLIC=true` as a temporary fallback and record the risk on #4.
10. Post deploy commit, rollback commit, and this checklist result on #4.

## Deploy sequence

1. Fetch and check out the pinned commit:

   ```bash
   git fetch origin
   git checkout <pinned-deploy-commit>
   ```

2. Install dependencies only if the lockfile changed:

   ```bash
   npm ci --omit=dev
   ```

3. Verify auth and the health ingest key without printing secrets, then reload
   PM2 with auth enabled:

   ```bash
   node -e "require('dotenv').config({ override: true }); const ok = process.env.HXA_AUTH_ENABLED === 'true' && !!process.env.HEALTH_API_KEY; console.log(JSON.stringify({ auth_enabled: process.env.HXA_AUTH_ENABLED === 'true', health_api_key_configured: !!process.env.HEALTH_API_KEY })); process.exit(ok ? 0 : 1)"
   HXA_AUTH_ENABLED=true pm2 reload hxa-dash --update-env
   ```

4. Smoke test the public health endpoints and confirm a protected API remains
   closed without a login cookie:

   ```bash
   curl -fsS https://hxa.zhiw.ai/api/health
   curl -fsS https://hxa.zhiw.ai/api/about
   test "$(curl -sS -o /dev/null -w '%{http_code}' https://hxa.zhiw.ai/api/team)" = "401"
   ```

5. Verify both activity ingest and the monitoring-health write/read path with
   machine keys:

   ```bash
   SMOKE_NAME="__verify__deploy-smoke-$(date +%Y%m%d%H%M%S)"
   HXA_SMOKE_TOKEN="$(
     node -e "require('dotenv').config({ override: true }); const { signToken } = require('./src/auth/token'); const tenantKey = process.env.FEISHU_TENANT_KEY; if (!tenantKey) process.exit(1); process.stdout.write(signToken({ openId: '__verify__deploy-smoke', unionId: '', name: 'Deploy Smoke', avatarUrl: '', tenantKey }));"
   )"
   HXA_SMOKE_COOKIE="hxa_token=${HXA_SMOKE_TOKEN}"

   curl -fsS -X POST https://hxa.zhiw.ai/api/report \
     -H "Content-Type: application/json" \
     -H "X-API-Key: $HXA_INGEST_API_KEY" \
     -d "{\"name\":\"${SMOKE_NAME}\",\"status\":\"smoke\"}"
   curl -fsS https://hxa.zhiw.ai/api/team \
     -H "Cookie: $HXA_SMOKE_COOKIE" \
     | jq -e --arg name "$SMOKE_NAME" \
       '.agents[] | select(.name == $name) | .last_seen_at > 0'

   HEALTH_CANARY_KEY="${HEALTH_API_KEY:-$HXA_INGEST_API_KEY}"
   HEALTH_SMOKE_PATH="$(jq -nr --arg name "$SMOKE_NAME" '$name | @uri')"
   HEALTH_BEFORE_AT="$(curl -fsS \
     "https://hxa.zhiw.ai/api/agent-health/${HEALTH_SMOKE_PATH}" \
     -H "Cookie: $HXA_SMOKE_COOKIE" \
     | jq -r '.health.reported_at // 0')"
   HEALTH_PAYLOAD='{"hostname":"__verify__deploy-smoke","disk":{"pct":null},"memory":{"pct":null}}'

   curl -fsS -X POST \
     "https://hxa.zhiw.ai/api/agent-health/${HEALTH_SMOKE_PATH}" \
     -H "Content-Type: application/json" \
     -H "X-API-Key: $HEALTH_CANARY_KEY" \
     -d "$HEALTH_PAYLOAD"
   curl -fsS "https://hxa.zhiw.ai/api/agent-health/${HEALTH_SMOKE_PATH}" \
     -H "Cookie: $HXA_SMOKE_COOKIE" \
     | jq -e --argjson before "$HEALTH_BEFORE_AT" \
       '(.health.reported_at // 0) > $before'
   curl -fsS https://hxa.zhiw.ai/api/team \
     -H "Cookie: $HXA_SMOKE_COOKIE" \
     | jq -e --arg name "$SMOKE_NAME" \
       --argjson before "$HEALTH_BEFORE_AT" \
       '.agents[] | select(.name == $name)
        | (.monitoring.observed_at // 0) > $before'
   unset HXA_SMOKE_TOKEN HXA_SMOKE_COOKIE HEALTH_CANARY_KEY
   ```

   Each POST and its stored timestamp read-back are one gate. A 200 from
   `/api/health`, or even a 200 from either POST without a later persisted
   timestamp, does not prove that ingest works. The temporary smoke token is
   generated on the production host from the persisted auth secret, is never
   printed, and is removed from the shell immediately after the protected
   read-back checks.

6. Smoke test the auth boundary:

   ```bash
   curl -fsS https://hxa.zhiw.ai/api/health
   curl -i https://hxa.zhiw.ai/api/team
   SMOKE_NAME="__verify__deploy-smoke-$(date +%Y%m%d%H%M%S)"
   curl -i -X POST https://hxa.zhiw.ai/api/report \
     -H "Content-Type: application/json" \
     -d "{\"name\":\"${SMOKE_NAME}\"}"
   curl -fsS -X POST https://hxa.zhiw.ai/api/report \
     -H "Content-Type: application/json" \
     -H "X-API-Key: $HXA_INGEST_API_KEY" \
     -d "{\"name\":\"${SMOKE_NAME}\",\"status\":\"auth-smoke\"}"
   ```

Expected results:

- `/api/health` stays public and returns 200.
- `/api/team` without a cookie returns 401 JSON.
- `/api/report` without a key returns 401 JSON.
- `/api/report` with the ingest key returns 200.
- The smoke employee appears in `/api/team` with a new non-zero
  `last_seen_at`, proving the write was persisted and read back.
- The synthetic health canary updates only the `__verify__deploy-smoke-<timestamp>` row.
- Without posting or replaying any real employee payload, wait for one real
  reporter to advance `health.reported_at` naturally and verify `/api/team`
  exposes the same later value as `monitoring.observed_at`.
- Browser visit to `https://hxa.zhiw.ai/#limits` redirects through Feishu login and returns to the dashboard.
- `/ws` only connects after the browser has a valid `hxa_token` cookie.
- Any smoke agent rows are named with `__verify__deploy-smoke-<timestamp>`
  (kept under the canonical `__verify__` prefix so criteria's liveness
  aggregation — auto-assign reassignment pools, health-watchdog alerts,
  idle-agent stats — skips them; see `src/db.js` `isCanaryName()`). They are
  therefore no longer required to be cleaned up to avoid polluting dashboards;
  cleanup is optional housekeeping only.
- The permanent verification canary (`src/db.js` `CANARY_AGENT_NAME`,
  `__verify__canary`) is pre-registered automatically on every server start
  (`db.ensureCanaryAgent()`, idempotent) — it should never be created-then-
  deleted for a smoke test. Confirm it is retained but excluded: it should
  never appear in `GET /api/health-watchdog/alerts` output, and
  `src/db.js`'s `getIdleAgents()` must never include it, regardless of how
  long it stays offline.

## Rollback

If auth config is wrong, stop the public tunnel before diagnosis. Do not disable
auth while the public route is connected:

```bash
pm2 stop cloudflared-hxa
```

If the deployed code is unhealthy:

```bash
git fetch origin
git checkout <rollback-commit>
HXA_AUTH_ENABLED=true pm2 reload hxa-dash --update-env
```

After rollback, verify `/api/about`, `/api/health`, the dashboard page, a
write/read reporter-ingest canary, the bare WebSocket update path, backup
freshness, and PM2 status. Restart `cloudflared-hxa` only after the boolean auth
and health-key check passes. Post the rollback evidence on the active release
issue.
