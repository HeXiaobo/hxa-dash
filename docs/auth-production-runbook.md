# Feishu auth production runbook (#4)

This runbook is the production checklist for enabling the reviewed Feishu auth
boundary without interrupting hxa-dash ingest.

## Safety rules

- Codex owns execution, coding, PRs, testing, and deployment.
- Mylos provides review and production context only.
- Do not deploy from an uncommitted production working tree.
- Post the pinned deploy commit and rollback commit on #4 before changing PM2.
- Keep `HXA_AUTH_ENABLED=false` until all machine reporters and webhooks are
  confirmed to send their required server-to-server secret.
- Codex owns reporter distribution and the auth flip. Mylos reviews and provides
  fleet context only.

## Required production configuration

Set these on the PM2 service host before enabling auth:

| Variable or config | Required value |
|---|---|
| `HXA_AUTH_ENABLED` | Start with `false`; flip to `true` only after reporter rollout. |
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
ingest uses server-to-server secrets. These endpoints must be ready before the
auth flip:

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

Use the checked-in distribution helper before flipping auth:

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
`--api-key` from the secure local key source before the auth flip.

## Pre-deploy checklist

1. Confirm PR #8 is reviewed and merged.
2. Confirm production WIP is preserved by the existing WIP branches listed on #4.
3. Confirm `HXA_AUTH_ENABLED=false` is present in persistent PM2 env.
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

3. Reload PM2 with auth still disabled:

   ```bash
   HXA_AUTH_ENABLED=false pm2 reload hxa-dash --update-env
   ```

4. Smoke test the no-auth flip-safe state:

   ```bash
   curl -fsS https://hxa.zhiw.ai/api/health
   curl -fsS https://hxa.zhiw.ai/api/about
   ```

5. Verify machine ingest with a key:

   ```bash
   SMOKE_NAME="deploy-smoke-$(date +%Y%m%d%H%M%S)"
   curl -fsS -X POST https://hxa.zhiw.ai/api/report \
     -H "Content-Type: application/json" \
     -H "X-API-Key: $HXA_INGEST_API_KEY" \
     -d "{\"name\":\"${SMOKE_NAME}\",\"status\":\"smoke\"}"
   ```

6. Flip auth:

   ```bash
   HXA_AUTH_ENABLED=true pm2 reload hxa-dash --update-env
   ```

7. Smoke test the auth boundary:

   ```bash
   curl -fsS https://hxa.zhiw.ai/api/health
   curl -i https://hxa.zhiw.ai/api/team
   SMOKE_NAME="deploy-smoke-$(date +%Y%m%d%H%M%S)"
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
- Browser visit to `https://hxa.zhiw.ai/#limits` redirects through Feishu login and returns to the dashboard.
- `/ws` only connects after the browser has a valid `hxa_token` cookie.
- Any smoke agent rows are named with `deploy-smoke-<timestamp>` and should be
  cleaned from SQLite after the deploy if they interfere with dashboards.

## Rollback

If auth config is wrong but the code is otherwise healthy:

```bash
HXA_AUTH_ENABLED=false pm2 reload hxa-dash --update-env
```

If the deployed code is unhealthy:

```bash
git fetch origin
git checkout <rollback-commit>
pm2 reload hxa-dash --update-env
```

After rollback, verify `/api/about`, `/api/health`, the dashboard page, reporter
ingest, and PM2 status. Post the rollback evidence on #4.
