# Runtime Monitoring Homepage Design

Status: approved for implementation

Date: 2026-07-26

Issue: [#25](https://github.com/HeXiaobo/hxa-dash/issues/25)

Owner / approver: Mylos (COO / Infra Owner)
Scope: read-only monitoring homepage, backup continuity, and Three AI brand alignment

## Decision summary

The release stays intentionally small:

1. Reuse the existing `health-reporter -> POST /api/agent-health/:name ->
   /api/team` path. Do not introduce another collector, database, or homepage
   request.
2. Make the first viewport answer one operating question: which AI employee
   needs attention, and what observed fact proves it?
3. Keep backup as a separate first-class page. Its existing route and stored
   data remain compatible.
4. Treat collection health, work activity, and capacity as separate concepts.
   A binary or PM2 process being present never proves that an employee is
   working.
5. Use the canonical Three AI brand source from
   `with3ai/knowledge-base/brand/DESIGN.md`, not an invented dashboard palette.
6. V1 remains read-only. Restart, remote control, and configuration changes are
   explicitly out of scope.

Mylos confirmed decisions 2, 3, 4, and 6 in Feishu on 2026-07-25. The exact
brand source and production route were also confirmed:

- canonical brand: `with3ai/knowledge-base/brand/DESIGN.md`
- production: `https://hxa.zhiw.ai`
- service: PM2 `hxa-dash`, port `3479`

## Current-state findings

Most requested facts are already collected:

- disk, memory, CPU, hostname, and PM2 services
- runtime type and version
- per-runtime 5-hour and 7-day quota windows
- session and last-turn token usage
- backup repository and cron state
- `roster.context_used_pct`, `roster.context_total_tokens`,
  `roster.rate_limits`, model, plan, and statusline version

The missing work is aggregation and presentation, not a new monitoring system.

Three correctness gaps must be closed:

1. `health.roster` is currently persisted as an arbitrary object. It must be
   reconstructed from a strict allowlist before storage.
2. `/api/team` does not expose context occupancy or the two quota windows as
   separate values.
3. Runtime detection can currently promote an installed binary or fresh quota
   sample to "running". Installation, collection freshness, process health,
   and work activity must stay distinct.

`/api/agent-state` remains a separate, not-yet-deployed near-real-time seam. It
is not a dependency for this release.

## Read model

No new endpoint is added. Each existing `/api/team` agent receives one
`monitoring` object derived from the sanitized latest health report:

```json
{
  "monitoring": {
    "observed_at": 1785000000000,
    "freshness": "fresh",
    "age_ms": 42000,
    "collection": {
      "status": "ok",
      "reason_codes": []
    },
    "system": {
      "cpu_pct": 18,
      "memory_pct": 42,
      "disk_pct": 57,
      "pm2_online": 3,
      "pm2_total": 3
    },
    "capacity": {
      "context_pct": 61,
      "context_tokens": 122000,
      "five_hour_pct": 34,
      "five_hour_resets_at": 1785003600000,
      "seven_day_pct": 71,
      "seven_day_resets_at": 1785600000000
    },
    "tokens": {
      "session_total": 125400,
      "last_turn_total": 8200,
      "cost_usd": 1.24
    },
    "versions": [
      { "component": "runtime", "label": "Claude Code", "version": "1.0.90" },
      { "component": "statusline", "label": "Statusline", "version": "0.4.2" }
    ],
    "backup": {
      "status": "ok",
      "last_success_at": 1784999000000
    },
    "anomaly": {
      "severity": "ok",
      "reason_codes": []
    }
  }
}
```

All properties are nullable. Absence is shown as "未采集", never as zero,
healthy, offline, or working.

### Source precedence

- `observed_at`: `health.reported_at`
- system and PM2: sanitized `health.cpu`, `health.memory`, `health.disk`,
  `health.pm2`
- context and statusline version: sanitized `health.roster`
- 5h / 7d: selected runtime quota first, then sanitized roster rate limits
- token totals: selected runtime usage first, then roster context tokens
- runtime version: canonical `health.runtime`
- backup: existing sanitized backup summary

The fallback is per field; a missing context sample must not erase a valid
system sample.

## Collection, work, and anomaly semantics

### Collection status

- `ok`: report age is at most 15 minutes and required disk/memory facts exist
- `warning`: fresh report with a partial PM2 set or one resource at warning
  threshold
- `critical`: fresh report with disk, memory, or CPU at least 90%, or every reported
  PM2 service offline
- `stale`: report is older than 15 minutes
- `unknown`: no report

The reporter cadence remains 10 minutes. The 15-minute threshold is a
Mylos-approved 1.5x jitter allowance. A stale or missing collection is rendered
as "采集迟滞 / 未采集" with warning severity; it never proves employee offline
or not working. If every rostered employee becomes stale together, the fleet
summary emits one `ingest_chain_suspected` warning instead of presenting the
condition as independent employee failures.

### Work activity

Work activity uses only work evidence (recent Git events, messages, task
events, or a future fresh Dashboard state). These are not work evidence:

- installed runtime version
- an online PM2 process
- a fresh quota/usage sample
- the presence of an assigned but untouched task

The homepage labels collection and work separately so operators do not read
"telemetry online" as "employee is working".

### Anomaly reasons

Anomaly text is generated from fixed reason codes, not free-form health
payloads:

- `report_missing`, `report_stale`
- `disk_warning`, `disk_critical`
- `memory_warning`, `memory_critical`
- `cpu_warning`, `cpu_critical`
- `pm2_partial`, `pm2_offline`
- `context_high` (>= 80%), `context_critical` (>= 95%)
- `quota_5h_high`, `quota_5h_critical`
- `quota_7d_high`, `quota_7d_critical`
- `backup_warning`, `backup_critical`, `backup_stale`

Quota warning / critical thresholds are 80% / 95%. Backup health is anchored
to the timestamp and exit result of the latest successful backup, not the
presence of a cron entry or a last-run timestamp. The UI does not reinterpret
repository facts.
Multiple reasons may be shown. Missing facts produce "未采集", not an alarm.

## Homepage hierarchy

### Global header

- Three AI Global Lockup (44px mark container + "三个智能")
- two primary destinations: `监控` and `备份`
- connection state, last update, and manual refresh
- legacy analysis pages remain reachable from a secondary "更多" menu during
  the migration; they are not presented as equal monitoring destinations

### Monitor first viewport

1. fleet status strip: employees observed, fresh collection, work evidence,
   anomalies
2. exception list, ordered critical -> warning -> stale
3. compact employee rows:
   `状态 | CPU / 内存 / 磁盘 | Context / Token | 5h | 7d | Runtime / 版本`

Each row is a real keyboard-operable button. It opens a labelled detail dialog
with timestamps, source facts, PM2 services, token breakdown, and backup
summary. The dialog is placed outside `<main>` so the sticky header cannot
cover it.

Recent activity is secondary and moves below the monitoring table. Backup
remains a separate page; on narrow screens each backup row becomes a readable
stack rather than an eight-column overflow.

## Brand implementation

Canonical source:

- `with3ai/knowledge-base/brand/DESIGN.md`
- source blob: `5950bdbe591426d43ebd6262c3757582a4ca1ab6`
- asset manifest: `brand/assets/README.md`
- mark asset: `brand/assets/favicon-512.svg`

The release commits:

- a generated CSS token file with source path, blob SHA, and generation date
- the exact canonical mark asset, preserving its source SHA
- a repeatable sync/check script so future changes are compared to the source

The UI follows the 90% neutral / 10% Jade Ink rule:

- primary `#0D9488`
- primary dark `#0F766E`
- ink `#0F172A`
- muted `#475569`
- line `#E2E8F0`
- background `#F8FAFC`
- surface `#FFFFFF`

Cards and controls use the canonical 8px radius. Existing yellow, GitHub blue,
purple, and legacy dark-theme literals used in monitoring surfaces are mapped
to semantic brand tokens. Charts outside the v1 monitoring flow are not
redesigned unless a conflicting color makes their current page unreadable.

## Accessibility and interaction requirements

- skip link and visible `:focus-visible`
- semantic buttons for employee rows
- labelled form controls and icon-only controls
- `aria-current` for the active page and `aria-live` for connection updates
- detail dialog with label, focus entry/trap/restore, Escape close, body scroll
  lock, and background inert state
- minimum 44px touch targets on mobile
- reduced-motion fallback
- no `transition: all`
- no unconditional interception of modified link clicks

## Compatibility

- Existing health reporter payloads continue to work.
- `/api/team` additions are additive.
- Existing `runtime`, `quota`, `usage`, `backup`, and `hardware` fields remain.
- `/api/backups` and its stored data are unchanged.
- the existing bare WebSocket server continues to broadcast the same agent
  collection, now with the additive `monitoring` object
- polling and WebSocket broadcasts call the same `buildAgents()` function, so they cannot
  diverge by construction.

## Test plan

Backend:

- roster allowlist and secret/tag stripping
- context and 5h / 7d mapping, including per-field fallback
- missing / stale / warning / critical anomaly semantics
- installed binary does not prove a runtime is running
- open assigned task without a recent work signal does not prove "working"
- `/api/team` remains backwards compatible
- `/api/backups` regression coverage

Reporter:

- fixture coverage for context, quota windows, and versions
- `npm run check:health-reporter`

Browser:

- desktop and 390px mobile screenshots
- monitor and backup navigation
- employee dialog keyboard/focus/Escape behavior
- manual refresh and automatic polling return equivalent render data
- WebSocket update changes the same row without a full-page error
- zero uncaught console errors

Release:

- use `docs/auth-production-runbook.md`, not legacy `deploy/deploy.sh`
- deploy only a clean pinned reviewed commit
- verify `/api/about` commit, auth-off smoke, auth-on 401/API-key/Feishu flow,
  WebSocket updates, reporter freshness, and backup page
- send one authenticated canary health report and verify that the stored
  `reported_at` / last-seen fact advances; process health alone is insufficient
- rollback by the prior pinned commit and re-run the same probes

## Review record

- 2026-07-25: Mylos approved the read-only v1 scope, one-screen hierarchy,
  evidence-based anomalies, separate backup page, canonical brand source, and
  canonical production target in Feishu.
- 2026-07-26 00:09: Mylos explicitly approved implementation in Feishu
  (`om_x100b6979b5cf04a0b4c2971a49340f8`) with five required refinements:
  stale is never offline, backup is success-anchored, WebSocket terminology is
  exact, go-live includes a real ingest write/read check, and fleet-wide stale
  becomes one suspected ingest-chain warning. He approved the 15-minute stale
  threshold and assigned Veda as primary peer reviewer with SS as security
  reviewer.
