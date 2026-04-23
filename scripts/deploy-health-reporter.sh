#!/bin/bash
# deploy-health-reporter.sh — Broadcast health-reporter setup instructions to all HXA bots
# Usage: bash deploy-health-reporter.sh [--dry-run]
#
# Sends personalized HXA messages to each bot with download, test, and cron setup instructions.

HXA_SEND="$HOME/zylos/.claude/skills/hxa-connect/scripts/send.js"
API_KEY="50df7e266bf6e68c11de90c53797f03ca7e6f96163747994"
DOWNLOAD_URL="https://hxa.zhiw.ai/scripts/health-reporter.mjs"
DRY_RUN=false

if [[ "$1" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[DRY RUN] Will print messages without sending"
fi

# All online bots (excluding mylos which is already configured, and yueran who is on leave)
BOTS=(afu aqi chengzi hongshu kimi lingling linlin siyue ss veda wanyanshu wenwen xiaochuaner xiaodao xiaolv xiaonuo xiaoyou xiaoz xiaozhang xinghang yaya zhugeliang)

SENT=0
FAILED=0

for BOT in "${BOTS[@]}"; do
  MSG="📋 系统健康上报脚本部署（波总要求）

请按以下步骤配置 health-reporter，每10分钟自动上报系统健康状态到 hxa-dash 看板：

**Step 1: 下载脚本**
\`\`\`
mkdir -p ~/hxa-dash/scripts && curl -fsSL -o ~/hxa-dash/scripts/health-reporter.mjs ${DOWNLOAD_URL}
\`\`\`

如果 curl 下载失败(403等)，用 wget 替代：
\`\`\`
mkdir -p ~/hxa-dash/scripts && wget -q -O ~/hxa-dash/scripts/health-reporter.mjs ${DOWNLOAD_URL}
\`\`\`

**Step 2: 测试运行**
\`\`\`
node ~/hxa-dash/scripts/health-reporter.mjs --name ${BOT} --api-key ${API_KEY}
\`\`\`
应该看到类似输出：\`[health-reporter] ${BOT}: disk=XX% mem=XX% cpu=XX% — reported OK\`

**Step 3: 设置定时任务（cron）**
用你系统上的 node 绝对路径，每10分钟运行：
\`\`\`
NODE_PATH=\$(which node)
(crontab -l 2>/dev/null; echo \"*/10 * * * * \${NODE_PATH} \$HOME/hxa-dash/scripts/health-reporter.mjs --name ${BOT} --api-key ${API_KEY} >> \$HOME/hxa-dash/scripts/health-reporter.log 2>&1\") | crontab -
\`\`\`

macOS 用户如果没有 crontab，可用 launchd（参考你之前 activity-reporter 的配置方式）。

完成后回复确认 ✅。如果遇到问题，告诉我具体报错。"

  if $DRY_RUN; then
    echo "=== Would send to: ${BOT} ==="
    echo "$MSG"
    echo ""
  else
    echo -n "[deploy] Sending to ${BOT}... "
    if node "$HXA_SEND" "$BOT" "$MSG" 2>/dev/null; then
      echo "✅"
      SENT=$((SENT + 1))
    else
      echo "❌"
      FAILED=$((FAILED + 1))
    fi
    sleep 1
  fi
done

if ! $DRY_RUN; then
  echo ""
  echo "[deploy] Done. Sent: ${SENT}, Failed: ${FAILED}"
fi
