# HxA Dash v1 factual anomaly criteria

Status: approved

Approver: Mylos

Approval message: `om_x100b6979b5cf04a0b4c2971a49340f8`
Date: 2026-07-26

## Governing rule

Every anomaly must be anchored to an observed fact produced by the monitored
system. Process presence is not work:

- PM2 `online`, an established socket, or an installed CLI does not prove that
  an AI employee is processing work.
- A command exit code of zero does not prove that its expected content exists.
- `missing`, `received and healthy`, and `received and degraded` are separate
  states.
- First observation and missing baseline are `unknown`, never assumed healthy.
- A stale collection is a collection warning, never proof that an employee is
  offline or not working.

## Collection and ingest

- reporter cadence: 10 minutes
- collection stale threshold: 15 minutes
- `report_missing`: no report exists
- `report_stale`: the latest report is older than 15 minutes
- `ingest_chain_suspected`: every rostered employee is stale or missing at the
  same time

The fleet-wide condition is shown once at the fleet level. Individual stale
rows still show their last observed time, but do not multiply the same
suspected ingest failure into offline alarms.

## Host and PM2

- disk warning / critical: `>= 80%` / `>= 90%`
- memory warning / critical: `>= 80%` / `>= 90%`
- CPU warning / critical: `>= 80%` / `>= 90%`
- `pm2_partial`: a received PM2 snapshot has some, but not all, services online
- `pm2_offline`: a received non-empty PM2 snapshot has no online service

PM2 state is collection evidence only. It does not set `work_state`.

## Capacity

- context warning / critical: `>= 80%` / `>= 95%`
- 5-hour quota warning / critical: `>= 80%` / `>= 95%`
- 7-day quota warning / critical: `>= 80%` / `>= 95%`

Capacity is evaluated only when the field has its own sample time. A stale
quota/context value is displayed with its age and is not treated as current.
Values are per machine and are never copied across employees.

## Token and context usage

Token totals are local session observations, not billing truth. Missing or
unsupported collectors are shown as `未采集`. A context percentage approaching
the window limit is a capacity risk; it is not proof of failure.

## Runtime and component versions

Reported versions are compared and displayed as governance facts. An installed
or older version can produce an informational drift hint, but never a runtime
health red light by itself.

## Backup

Backup health is anchored to the latest successful backup:

- success timestamp and successful exit/content evidence must exist
- warning: last success exceeds the warning freshness window
- critical: last success exceeds the critical freshness window, or the latest
  run failed
- cron presence or "ran at" is not success

A silent failed backup is treated as no successful backup. Repository
ahead/behind/dirty/untracked counts remain separately visible facts.

## Work activity

`working` requires a recent explicit work signal. Assigned/open tasks,
`current_task`, collection freshness, installed runtime version, PM2 state, and
socket state do not independently prove work.
