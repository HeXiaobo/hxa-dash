#!/bin/bash
set -euo pipefail

# deploy-activity-reporter.sh - Broadcast activity-reporter update instructions.
# Usage: bash scripts/deploy-activity-reporter.sh [--dry-run]
#
# This sends instructions only. It does not SSH into bot hosts or mutate prod.

HXA_SEND="$HOME/zylos/.claude/skills/hxa-connect/scripts/send.js"
DASHBOARD_URL="${HXA_DASH_URL:-https://hxa.zhiw.ai}"
REPORTER_URL="${DASHBOARD_URL}/scripts/activity-reporter.mjs"
OPENCLAW_REPORTER_URL="${DASHBOARD_URL}/scripts/activity-reporter-openclaw.mjs"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[DRY RUN] Will print messages without sending"
fi

# Mirrors the health reporter rollout list. Keep explicit until ownership
# metadata is source-controlled.
BOTS=(afu aqi chengzi hongdou hongshu kele kimi lingling linlin siyue ss veda wanyanshu wenwen xiaochuaner xiaodao xiaolv xiaonuo xiaoyou xiaoz xiaozhang xinghang yaya zhugeliang)

MSG_TEMPLATE=$(cat <<'MSG_EOF'
HxA Dash activity reporter auth update (#4)

Before hxa-dash flips HXA_AUTH_ENABLED=true, every bot must replace the old activity reporter code. Some hosts already pass --api-key, but old reporter copies ignore that argument and still post without X-API-Key.

Step 1: discover the reporter file paths this host actually runs, then replace those files in place.

```bash
set -euo pipefail

REPORTER_URL="__REPORTER_URL__"
OPENCLAW_REPORTER_URL="__OPENCLAW_REPORTER_URL__"

find_reporter_paths() {
  {
    crontab -l 2>/dev/null || true
    pm2 jlist 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { try { for (const p of JSON.parse(s)) { const e = p.pm2_env || {}; console.log([e.pm_exec_path, e.script, e.cwd, e.args, e.node_args].flat().filter(Boolean).join(" ")); } } catch {} });' || true
    pgrep -af "activity-reporter" || true
  } | tr ' ' '\n' | sed -n 's#.*\(/[^[:space:]]*activity-reporter\(-openclaw\)\?\.mjs\).*#\1#p'

  for candidate in \
    "$HOME/hxa-dash/scripts/activity-reporter.mjs" \
    "$HOME/hxa-dash/scripts/activity-reporter-openclaw.mjs" \
    "$HOME/zylos/workspace/hxa-dash/scripts/activity-reporter.mjs" \
    "$HOME/zylos/workspace/hxa-dash/scripts/activity-reporter-openclaw.mjs"
  do
    [ -f "$candidate" ] && printf '%s\n' "$candidate"
  done
}

REPORTER_PATHS="$(find_reporter_paths | awk '!seen[$0]++')"
if [ -z "$REPORTER_PATHS" ]; then
  echo "No existing activity reporter path found. Stop here and reply with your current launch command/path."
  exit 1
fi

echo "Reporter paths to update:"
printf '%s\n' "$REPORTER_PATHS"

while IFS= read -r path; do
  case "$path" in
    *activity-reporter-openclaw.mjs) url="$OPENCLAW_REPORTER_URL" ;;
    *) url="$REPORTER_URL" ;;
  esac

  mkdir -p "$(dirname "$path")"
  tmp="${path}.tmp.$$"
  if ! curl -fsSL -o "$tmp" "$url"; then
    wget -q -O "$tmp" "$url"
  fi
  mv "$tmp" "$path"
  chmod 755 "$path"
done <<EOF
$REPORTER_PATHS
EOF

NORMAL_REPORTER="$(printf '%s\n' "$REPORTER_PATHS" | grep '/activity-reporter\.mjs$' | head -n 1 || true)"
OPENCLAW_REPORTER="$(printf '%s\n' "$REPORTER_PATHS" | grep '/activity-reporter-openclaw\.mjs$' | head -n 1 || true)"

echo "Updated normal reporter: ${NORMAL_REPORTER:-none}"
echo "Updated OpenClaw reporter: ${OPENCLAW_REPORTER:-none}"
```

Step 2: reuse the existing health reporter key for the test when an env file exists.

Run this in the same shell after Step 1:

```bash
HEALTH_ENV_FILE=""
for candidate in \
  "$(dirname "${NORMAL_REPORTER:-$HOME/hxa-dash/scripts/activity-reporter.mjs}")/health-reporter.env" \
  "$HOME/hxa-dash/scripts/health-reporter.env" \
  "$HOME/zylos/workspace/hxa-dash/scripts/health-reporter.env"
do
  if [ -f "$candidate" ] && grep -q '^HEALTH_API_KEY=' "$candidate"; then
    HEALTH_ENV_FILE="$candidate"
    break
  fi
done

if [ -n "$HEALTH_ENV_FILE" ]; then
  set -a; . "$HEALTH_ENV_FILE"; set +a
fi

if [ -n "${NORMAL_REPORTER:-}" ]; then
  node "$NORMAL_REPORTER" --name __BOT__
fi

if [ -n "${OPENCLAW_REPORTER:-}" ]; then
  node "$OPENCLAW_REPORTER" --name __BOT__
fi
```

If no health env file is found, keep the local --api-key source that your current cron or PM2 loop already uses. Do not paste the key into chat.

Step 3: keep the existing scheduler pointed at the same path.

If your current cron or PM2 loop already runs one of the paths printed in Step 1, do not change the schedule; the file was replaced in place. If Step 1 stopped because no path was found, reply with your current launch command/path and wait for the Codex rollout coordinator.

Reply when the updated reporter is installed and the test command succeeds. Do not change hxa-dash production auth yourself; Codex owns the flip.
MSG_EOF
)

SENT=0
FAILED=0

for BOT in "${BOTS[@]}"; do
  MSG="${MSG_TEMPLATE//__BOT__/${BOT}}"
  MSG="${MSG//__REPORTER_URL__/${REPORTER_URL}}"
  MSG="${MSG//__OPENCLAW_REPORTER_URL__/${OPENCLAW_REPORTER_URL}}"

  if $DRY_RUN; then
    echo "=== Would send to: ${BOT} ==="
    echo "$MSG"
    echo ""
  else
    echo -n "[deploy] Sending to ${BOT}... "
    if node "$HXA_SEND" "$BOT" "$MSG" 2>/dev/null; then
      echo "ok"
      SENT=$((SENT + 1))
    else
      echo "failed"
      FAILED=$((FAILED + 1))
    fi
    sleep 1
  fi
done

if ! $DRY_RUN; then
  echo ""
  echo "[deploy] Done. Sent: ${SENT}, Failed: ${FAILED}"
fi
