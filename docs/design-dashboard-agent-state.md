# Dashboard Agent State Ingest Design

Status: draft implementation ready for review (not deployed)  
Date: 2026-07-16  
Scope: near-real-time, read-only aggregation of minimized Zylos Dashboard state

## Context

The existing `POST /api/agent-health/:name` contract is a ten-minute system
health report. It overwrites the latest health record and carries quota, usage,
PM2, backup, disk, and memory data. Posting a second Dashboard-shaped document
to that route would either discard the Dashboard fields or erase useful legacy
health fields.

This design adds a separate storage and HTTP seam. The existing health reporter
remains unchanged and continues to be the fallback visibility path.

This change set covers the central repository implementation and tests only.
No deployment, production key creation, service restart, or production release
is part of this change set.

## Requested behavior

- Accept authenticated, minimized agent-state snapshots from a local bridge.
- Bind every snapshot to a canonical agent identity.
- Reconstruct stored data from a strict allowlist; never store prompts,
  messages, tool details, raw telemetry, API keys, or session tokens.
- Keep source, status, observation time, freshness, and degradation explicit.
- Recalculate freshness on read so old data cannot continue to look live.
- Treat node-reported routing eligibility as non-authoritative visibility data.
- Store Dashboard state separately from `agent_health` and its history.
- Preserve the existing health reporter and its data unchanged.

## Module and seam

The module is exposed through one HTTP interface:

- `POST /api/agent-state/:name` ingests the latest minimized snapshot.
- `GET /api/agent-state/:name` reads one agent's latest state.
- `GET /api/agent-state` reads all stored agent states.

The route is the external seam used by both callers and acceptance tests. The
module hides authentication, identity validation, allowlisting, freshness
invariants, persistence, and stale presentation behind that small interface.

The storage adapter adds only three database functions:

- `upsertAgentDashboardState(name, state, observedAt, receivedAt)`
- `getAgentDashboardState(name)`
- `getAllAgentDashboardStates()`

These functions use a dedicated `agent_dashboard_state` table in the existing
SQLite file. They do not read or write `agent_health` or
`agent_health_history`.

## Authentication and identity

`POST /api/agent-state/:name` is treated as a machine-ingest request by the
global browser-auth policy, then protected by route-local API-key middleware.
The central service reads `DASHBOARD_STATE_INGEST_KEYS_JSON`, a map of
canonical agent name to dedicated key. Each key is accepted only on the route
for its mapped agent and arrives through `Authorization: Bearer` or
`X-API-Key`. This prevents one fleet node from submitting visibility state for
another. A single-agent compatibility form requires both
`DASHBOARD_STATE_INGEST_AGENT_NAME` and `DASHBOARD_STATE_INGEST_API_KEY`, and
keeps the same route binding. The middleware fails closed:

- no configured key: `403 dashboard_state_ingest_not_configured`
- missing or incorrect key: `401 Unauthorized`

Malformed or empty maps are treated as unconfigured. A configured map without
an entry for the requested route returns `401` without revealing another
agent's key. The route parameter is the canonical identity. The name must already exist in
the entity registry or current agent roster. The body must include
`agent_name`, and it must equal the route parameter exactly. An authenticated
Dashboard snapshot must also contain the same `payload.agent.name`.

Aliases and case variants are not silently rewritten. The configured key-map
name, route parameter, body `agent_name`, payload `agent.name`, and canonical
roster name must agree byte-for-byte. This prevents a case-insensitive roster
lookup from creating a parallel record for one agent.

## Ingest contract

Example:

```json
{
  "agent_name": "yueran",
  "source": "dashboard_api",
  "status": "fresh",
  "used_for_routing": true,
  "observed_at": "2026-07-16T01:00:00.000Z",
  "freshness_ms": 5000,
  "degraded": false,
  "payload": {
    "schema_version": 1,
    "dashboard": { "version": "0.5.3" },
    "agent": {
      "name": "yueran",
      "state": "BUSY",
      "confidence": "HIGH",
      "reason": "Executing a tool",
      "active_subagent_count": 1
    },
    "runtime": {
      "type": "codex",
      "model": "gpt-5",
      "effort": "high",
      "version": "1.0.0",
      "pending_restart": false
    },
    "capacity": {
      "context_pct": 41,
      "rate_limit_pct": 22,
      "rate_limit_7d_pct": 33
    },
    "system": { "cpu_pct": 12, "mem_pct": 34, "disk_pct": 56 }
  }
}
```

Allowed top-level values:

- `source`: `dashboard_api`, `dashboard_health`, or `none`
- `status`: `fresh`, `stale`, `degraded`, or `unavailable`
- `observed_at`: ISO timestamp for Dashboard observations; `null` only when
  source is `none`
- `freshness_ms`: non-negative finite number for observed sources; `null` only
  when source is `none`
- `degraded_reason`: short allowlisted string value when degraded

Accepted client degradation reasons are limited to the adapter's fixed codes:
`read_key_missing`, `auth_failed`, `token_exchange_unreachable`,
`token_exchange_failed`, `state_unreachable`, `state_unavailable`,
`identity_mismatch`, `state_timestamp_invalid`, `dashboard_state_stale`,
`dashboard_unreachable`, and `invalid_base_url`. Any other value is stored as
`unclassified_degradation`, never as caller-supplied text.

Invariants:

- For bridge compatibility, only `dashboard_api` with `status=fresh` may submit
  `used_for_routing=true`. The central module never treats that claim as an
  authorization decision: it persists and presents `used_for_routing=false`
  until a separate central routing policy exists.
- A fresh observation must be at most 30 seconds old at central receipt time.
- Every non-fresh state must set `used_for_routing=false`, `degraded=true`, and
  a non-empty degradation reason.
- `source=none` requires `status=unavailable`, `payload=null`, and no
  observation timestamp.
- A future timestamp beyond five seconds of clock skew is rejected.
- Unknown fields are ignored, not persisted. Invalid required fields or
  inconsistent invariants return `400 invalid_agent_state`.

The server treats client `freshness_ms` as a contract-consistency signal, not
as truth. It derives ingest age from its own clock and `observed_at`, uses that
derived age for the 30-second check, and persists the derived value. A client
cannot make old data fresh by posting `freshness_ms=0`.

## Strict payload allowlist

The stored payload is rebuilt from these fields only:

- `schema_version` (must equal `1`)
- `dashboard.version`, or for health-only state:
  `dashboard.ok`, `dashboard.service`, `dashboard.uptime_seconds`
- `agent.name`, `agent.state`, `agent.confidence`, `agent.reason`,
  `agent.active_subagent_count`
- `runtime.type`, `runtime.model`, `runtime.effort`, `runtime.version`,
  `runtime.pending_restart`
- `capacity.context_pct`, `capacity.rate_limit_pct`,
  `capacity.rate_limit_7d_pct`
- `system.cpu_pct`, `system.mem_pct`, `system.disk_pct`

Strings are tag-stripped and length-limited. Dashboard and runtime versions
must be semantic-version forms; runtime type and effort are enums; model names
must match known model-family prefixes. Common API-key prefixes, AWS access-key
forms, and long hexadecimal values become `null` even in an otherwise allowed
slot. Percentages are clamped to
`0..100`; counts are non-negative integers. No recursive or arbitrary object
copy is used. State and confidence are enums. Runtime/model/version/tool names
accept only short identifier characters. `agent.reason` is kept only when it
matches a known Dashboard operational-reason form (fixed liveness text, or a
tool/turn state plus numeric duration); arbitrary caller text becomes `null`.
This prevents an authenticated but buggy bridge from smuggling prompts or
secrets through an otherwise allowed string field.

## Read semantics

Every read derives presentation fields using the central clock:

- `freshness_ms = now - observed_at`
- `stale = freshness_ms > 30000`, or true when no usable observation exists
- a stored `fresh` snapshot that has aged past 30 seconds is returned as
  `status=stale`, `used_for_routing=false`, `degraded=true`, and
  `degraded_reason=central_state_stale`
- fresh Dashboard observations also return `used_for_routing=false`; freshness
  is visibility evidence, not node-controlled routing authorization
- an already degraded or unavailable state remains non-routing even when it
  was received recently

Responses include `received_at` separately from `observed_at`, making network
delay and stale source data visible. The server never upgrades a degraded
client report to fresh.

Single-agent response shape:

```json
{
  "name": "yueran",
  "state": {
    "source": "dashboard_api",
    "status": "fresh",
    "used_for_routing": false,
    "observed_at": "2026-07-16T01:00:00.000Z",
    "received_at": "2026-07-16T01:00:05.000Z",
    "freshness_ms": 5000,
    "stale": false,
    "degraded": false,
    "payload": {}
  },
  "timestamp": "2026-07-16T01:00:05.000Z"
}
```

The collection endpoint returns `{ states: [{ name, state }, ...], timestamp }`
using the same per-agent state representation, filtered to current canonical
identities and sorted by name. A known agent without a record returns
`state: null` and top-level `stale: true`; collection results include stored
canonical records only.

## Storage

```sql
CREATE TABLE IF NOT EXISTS agent_dashboard_state (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  observed_at INTEGER,
  received_at INTEGER NOT NULL
)
```

The table stores latest state only. An upsert compares
`COALESCE(observed_at, received_at)` and ignores a delayed observation older
than the stored one, so network reordering cannot roll an agent backward. This avoids writing a high-frequency
history stream into the legacy health database. Timestamped history can be a
separate future design if a retention use case appears.

## Failure behavior

- Authentication and identity failures do not write.
- Invalid payloads do not write.
- Database write failures return `500 agent_state_store_failed` and are not
  swallowed.
- Missing canonical agent: `404 Agent not found`.
- Known agent with no state: `200` with `state: null`, `stale: true`, and the
  response timestamp, matching the visibility style of the health endpoint.

## Acceptance checks

Tests exercise the HTTP interface with the real router and real SQLite-backed
store:

1. A valid authenticated snapshot is accepted and then readable.
2. Missing configuration, missing key, and incorrect key fail closed.
3. Unknown agents and identity mismatches are rejected without writes.
4. Extra prompt, message, tool, token, and raw-telemetry fields never appear in
   the read response.
5. A fresh node snapshot is persisted and presented as non-routing; it then
   becomes visibly stale after 30 seconds.
6. Health-only and unavailable snapshots can be stored for visibility but
   never become routing input.
7. Inconsistent source/status/freshness combinations are rejected.
8. Posting Dashboard state does not change the same agent's legacy health
   record.
9. Existing auth, agent-health, router, and local Dashboard adapter tests stay
   green.
10. A key bound to one agent cannot write another agent's route, and coordinated
    case variants of URL, key binding, envelope, and payload are rejected.
11. Delayed older observations do not overwrite newer state.
12. Collection reads use the single-record shape, deterministic ordering, and
    canonical filtering, with structured JSON on storage failure.
13. A minimized snapshot in the bridge's published contract crosses the real
    central HTTP and router seams without schema drift or private-field
    leakage. The fleet package tests the real collector and bridge separately,
    keeping this repository's CI self-contained instead of importing a sibling
    workspace that will not exist in a normal checkout.

## Rollback

Before deployment, rollback consists of removing the route registration,
route module, new database functions, auth-policy entry, tests, and design
document. The unused `agent_dashboard_state` table may remain safely; dropping
it is destructive and is not part of automatic rollback. The legacy reporter
and its tables are untouched throughout.

## Review record

Reviewed locally on 2026-07-16 under the owner's instruction to keep design,
integration, and verification root-owned without a Mylos review gate.

The review added three controls before implementation:

- central time, not caller-provided freshness, decides whether data is fresh;
- degradation reasons are fixed codes, not arbitrary caller text;
- free-form operational reason text is dropped unless it matches a known safe
  Dashboard form.

The release hardening review added two more controls: node freshness claims
cannot self-authorize routing, and canonical identity matching is case-exact
across the complete ingest contract.

No remaining blocker was found for local test-driven implementation. Live
keys, service changes, deployment, production release, and fleet rollout remain
outside this approval. Publishing a draft review branch and draft pull request
was authorized separately after the local package gate was prepared.
