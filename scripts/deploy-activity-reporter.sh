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
REPORTER_DIR="\$HOME/hxa-dash/scripts"
HEALTH_ENV_FILE="\$HOME/hxa-dash/scripts/health-reporter.env"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[DRY RUN] Will print messages without sending"
fi

# Mirrors the health reporter rollout list. Keep explicit until ownership
# metadata is source-controlled.
BOTS=(afu aqi chengzi hongshu kimi lingling linlin siyue ss veda wanyanshu wenwen xiaochuaner xiaodao xiaolv xiaonuo xiaoyou xiaoz xiaozhang xinghang yaya zhugeliang)

SENT=0
FAILED=0

for BOT in "${BOTS[@]}"; do
  MSG="HxA Dash activity reporter auth update (#4)

Before hxa-dash flips HXA_AUTH_ENABLED=true, every bot must replace old activity reporter copies. Old copies ignore --api-key and will keep posting without X-API-Key.

Step 1: download the current reporters
\`\`\`
mkdir -p ${REPORTER_DIR}
curl -fsSL -o ${REPORTER_DIR}/activity-reporter.mjs ${REPORTER_URL}
curl -fsSL -o ${REPORTER_DIR}/activity-reporter-openclaw.mjs ${OPENCLAW_REPORTER_URL}
chmod 700 ${REPORTER_DIR}
chmod 755 ${REPORTER_DIR}/activity-reporter.mjs ${REPORTER_DIR}/activity-reporter-openclaw.mjs
\`\`\`

If curl fails, use wget:
\`\`\`
mkdir -p ${REPORTER_DIR}
wget -q -O ${REPORTER_DIR}/activity-reporter.mjs ${REPORTER_URL}
wget -q -O ${REPORTER_DIR}/activity-reporter-openclaw.mjs ${OPENCLAW_REPORTER_URL}
chmod 700 ${REPORTER_DIR}
chmod 755 ${REPORTER_DIR}/activity-reporter.mjs ${REPORTER_DIR}/activity-reporter-openclaw.mjs
\`\`\`

Step 2: reuse the existing health reporter key

The new activity reporter reads HXA_INGEST_API_KEY first, then HEALTH_API_KEY. If health-reporter is already working, load the same env file in the activity reporter cron:
\`\`\`
test -f ${HEALTH_ENV_FILE} && grep -q '^HEALTH_API_KEY=' ${HEALTH_ENV_FILE}
\`\`\`

If the health key is missing, get the shared hxa-dash reporter key through the secure channel before continuing.

Step 3: test the normal reporter
\`\`\`
set -a; . ${HEALTH_ENV_FILE}; set +a
node ${REPORTER_DIR}/activity-reporter.mjs --name ${BOT}
\`\`\`

OpenClaw hosts that currently run activity-reporter-openclaw.mjs should also test:
\`\`\`
set -a; . ${HEALTH_ENV_FILE}; set +a
node ${REPORTER_DIR}/activity-reporter-openclaw.mjs --name ${BOT}
\`\`\`

Step 4: update existing cron or launchd commands

Keep your current schedule, but make sure the command loads ${HEALTH_ENV_FILE} before running the reporter. Example cron:
\`\`\`
NODE_PATH=\$(which node)
(crontab -l 2>/dev/null | grep -Ev 'activity-reporter(-openclaw)?\\.mjs'; echo \"*/10 * * * * . ${HEALTH_ENV_FILE}; \${NODE_PATH} ${REPORTER_DIR}/activity-reporter.mjs --name ${BOT} >> ${REPORTER_DIR}/activity-reporter.log 2>&1\") | crontab -
\`\`\`

If this host currently runs the OpenClaw variant, keep that entrypoint:
\`\`\`
NODE_PATH=\$(which node)
(crontab -l 2>/dev/null | grep -Ev 'activity-reporter(-openclaw)?\\.mjs'; echo \"*/10 * * * * . ${HEALTH_ENV_FILE}; \${NODE_PATH} ${REPORTER_DIR}/activity-reporter-openclaw.mjs --name ${BOT} >> ${REPORTER_DIR}/activity-reporter-openclaw.log 2>&1\") | crontab -
\`\`\`

Reply when the updated reporter is installed and the test command succeeds. Do not change hxa-dash production auth yourself; Codex owns the flip."

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
