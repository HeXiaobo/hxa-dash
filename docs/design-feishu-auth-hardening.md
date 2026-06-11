# Feishu auth hardening for reproducible deploy (#4)

## Context

Production `hxa-dash` currently runs from a dirty working tree. Mylos' deployment snapshot shows the live tree includes an unreviewed Feishu auth WIP that protects dashboard pages, while `main` does not. Directly switching production to a clean pinned `main` commit would remove that page-level login gate.

This design makes Feishu auth a reviewed, reproducible prerequisite for #4 before any pinned-commit PM2 reload.

## Goals

- Keep the public dashboard behind Feishu login before switching production to a clean GitHub commit.
- Protect dashboard JSON APIs, not just HTML/static files.
- Protect WebSocket snapshots, since the initial socket payload contains the same sensitive dashboard data.
- Preserve machine-to-machine ingest routes needed by reporters and webhooks.
- Avoid adding runtime npm dependencies for auth.
- Keep deployment reversible with a pinned previous commit and PM2 reload rollback.

## Non-goals

- Per-user RBAC.
- Feishu Bitable/user-directory authorization.
- Automatic Codex or bridge worker deployment.
- Token-grouped UI changes from `wip/token-grouped-views`.

## Proposed route policy

Auth middleware should run after request body parsing and `/auth/*` routes, but before static assets and API routes.

The boundary is intentionally split into three zones:

- Browser UI + read APIs: Feishu login.
- Machine ingest: `X-API-Key` server-to-server auth.
- WebSocket snapshot stream: same browser auth as the UI.

Public routes:

| Route | Method | Reason | Protection |
|---|---:|---|---|
| `/auth/login` | GET | OAuth entry | signed OAuth state |
| `/auth/callback` | GET | OAuth callback | signed OAuth state + Feishu code exchange |
| `/auth/logout` | GET | clear cookie | no data exposure |
| `/auth/denied` | GET | error page | escaped output |
| `/api/about` | GET | deploy verification | public, no sensitive data beyond version/commit |
| `/api/health` | GET | liveness check | public, keep payload minimal if changed later |
| `/api/webhook/gitlab` | POST | GitLab webhook | existing GitLab secret, fail closed when configured |
| `/api/agent-health/:name` | POST | health reporter ingest | shared `X-API-Key` ingest guard |
| `/api/report` | POST | legacy agent heartbeat ingest | shared `X-API-Key` ingest guard |
| `/api/report/activity` | POST | external activity ingest | shared `X-API-Key` ingest guard |
| `/api/webhook/connect` | POST | Connect callbacks | shared `X-API-Key` ingest guard by default; temporary `HXA_CONNECT_WEBHOOK_PUBLIC=true` fallback if the central Connect producer cannot add a key before flip |

All other `/api/*`, HTML, JS, CSS, and static assets require a valid `hxa_token` browser cookie.

Mylos confirmed the five machine POST routes above are active production data paths for health reporters, activity reporters, agent heartbeats, HXA Connect callbacks, and GitLab events. They must not be protected with Feishu browser login, or the fleet will stop reporting.

## WebSocket policy

The current WebSocket server sends a full dashboard snapshot when a client connects. That makes WebSocket auth part of the same access boundary as HTML and JSON APIs.

Proposed behavior:

- Reject WebSocket upgrade/connection attempts without a valid `hxa_token` cookie when `HXA_AUTH_ENABLED=true`.
- Reuse the same token verifier and tenant check as HTTP auth.
- Do not accept tokens in query strings.
- In local development/test, keep WebSocket auth disabled when `HXA_AUTH_ENABLED=false`.
- Add a test that unauthenticated WebSocket clients do not receive the initial snapshot, while authenticated clients do.

## Token and OAuth design

- Cookie name: `hxa_token`.
- Cookie flags: `httpOnly`, `sameSite=lax`, `secure` in production, path `/`, 30-day max age.
- Signing: local HS256-style HMAC using Node `crypto`, not `jsonwebtoken`.
- Secret: `HXA_AUTH_SECRET` preferred; `JWT_SECRET` may be accepted as a temporary compatibility alias.
- Issuer: `hxa-dash`.
- Tenant check: `FEISHU_TENANT_KEY` must match the Feishu user `tenant_key` when configured.
- OAuth state: signed state containing `return_to` and nonce/iat. Unsigned base64 state is not acceptable.
- Return paths must be same-origin relative paths beginning with `/` and not `//`.

## Configuration

Required for production auth:

- `HXA_AUTH_ENABLED=true`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_TENANT_KEY`
- `HXA_AUTH_SECRET`

Machine ingest:

- Existing: `HEALTH_API_KEY`
- Proposed: `HXA_INGEST_API_KEY` for report/connect ingest routes that do not currently have their own secret.
- Header: reuse the existing `X-API-Key` convention. Accept `HEALTH_API_KEY` as a compatibility key for `/api/agent-health/:name`; prefer `HXA_INGEST_API_KEY` for the broader ingest surface once clients are configured.

Behavior:

- In production, auth should fail closed when enabled but required config is missing.
- In local development/test, auth may be disabled with `HXA_AUTH_ENABLED=false` to keep current developer workflow.

## Implementation plan

1. Add auth modules under `src/auth/`:
   - Feishu OAuth client.
   - signed token helper.
   - cookie parser helper.
   - route policy and middleware.
2. Add `src/routes/auth.js` for login/callback/logout/denied.
3. Mount auth in `src/server.js`:
   - `express.json()`
   - `/auth`
   - auth middleware
   - static files
   - API routes
4. Add API ingest key checks for legacy unauthenticated POST routes or gate them through the auth policy:
   - `/api/agent-health/:name`
   - `/api/report`
   - `/api/report/activity`
   - `/api/webhook/connect`
   - `/api/webhook/gitlab`
5. Add WebSocket auth checks before sending snapshots.
6. Add tests for:
   - route policy: protected API reads vs public health/about/webhook/ingest routes.
   - valid token allows protected pages and APIs.
   - missing/invalid token redirects HTML and returns 401 JSON for API.
   - tenant mismatch clears cookie and denies access.
   - signed OAuth state rejects tampering.
   - unauthenticated WebSocket clients are rejected before receiving snapshots.
7. Open a code PR linked to #4 after this design is reviewed.

## Deployment plan

1. Merge auth hardening to `main`.
2. Confirm production env has required Feishu and auth secrets.
3. Post the exact pinned commit and rollback commit on #4.
4. On production host:
   - fetch GitHub.
   - verify current dirty tree is preserved by the WIP branches.
   - checkout the pinned commit.
   - install dependencies only if lockfile changed.
   - reload PM2 `hxa-dash`.
5. Verify:
   - `GET /api/about` shows the pinned commit.
   - unauthenticated `/` redirects to `/auth/login`.
   - unauthenticated sensitive `/api/*` returns 401 JSON.
   - unauthenticated WebSocket clients cannot receive the snapshot.
   - authenticated Feishu user can open `/#limits`.
   - reporter/webhook ingest still succeeds with its key.

## Rollback

Rollback is a pinned commit switch plus PM2 reload:

1. `git fetch origin`
2. `git checkout <previous-known-good-commit>`
3. `pm2 reload hxa-dash`
4. Verify `/api/about` and page access behavior.

If auth config is wrong but the code is healthy, rollback may also be done by restoring the previous PM2 env and reloading.

## Review questions

- Should `GET /api/health` stay public, or should it become a minimal liveness-only response when unauthenticated?
- Which legacy ingest routes are still actively used: `/api/report`, `/api/report/activity`, `/api/webhook/connect`?
- Is `HXA_INGEST_API_KEY` acceptable for those legacy machine routes, or should each source get its own scoped key?
- Should WebSocket auth reject during HTTP upgrade or accept then immediately close with a policy code for better diagnostics?

## Review decisions

- Mylos confirmed `/api/report`, `/api/report/activity`, `/api/webhook/connect`, `/api/webhook/gitlab`, and `/api/agent-health/:name` are all active production ingest paths.
- Use the existing `X-API-Key` style for machine ingest.
- Keep code and deployment execution owned by Codex; Mylos remains reviewer/context provider.
- Post-review deployment boundary: set `HXA_INGEST_API_KEY` to the existing `HEALTH_API_KEY` value for the first rollout, patch the previously open activity/report/connect producers to send `X-API-Key`, and configure GitLab with `webhooks.gitlab_secret` plus `X-GitLab-Token`.
- Production runbook: see `docs/auth-production-runbook.md`.
- Final runbook review added two rollout gates: the OpenClaw activity reporter variant must be distributed with the same key behavior, and per-bot reporter copies plus the central HXA Connect producer must be updated before `HXA_AUTH_ENABLED=true`.
- Later gate review found the central Connect producer is platform-owned. If it cannot send the ingest key before the auth flip, production may temporarily set `HXA_CONNECT_WEBHOOK_PUBLIC=true` so online/offline callbacks keep working while the platform header support is scheduled.
