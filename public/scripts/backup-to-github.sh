#!/bin/bash
# AI Assistant GitHub Backup Script
# Usage: ./backup-to-github.sh [--dry-run]
# Designed for daily cron execution

set -euo pipefail

# --- Config ---
BACKUP_REPO_URL="${BACKUP_REPO_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/ai-assistant-backup}"
ASSISTANT_NAME="${ASSISTANT_NAME:-zylos}"
SOURCE_BASE="${SOURCE_BASE:-$HOME/zylos}"
GIT_TOKEN="${GIT_TOKEN:-}"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# --- Validate ---
if [[ -z "$BACKUP_REPO_URL" || -z "$GIT_TOKEN" ]]; then
  echo "ERROR: BACKUP_REPO_URL and GIT_TOKEN must be set"
  exit 1
fi

# Inject token into URL for auth
AUTH_URL=$(echo "$BACKUP_REPO_URL" | sed "s|https://|https://${GIT_TOKEN}@|")

# --- Pull shared knowledge repos (best-effort) ---
SHARED_REPOS="${SHARED_REPOS:-${SOURCE_BASE}/workspace/zhiwai-shared}"
for repo_dir in $SHARED_REPOS; do
  if [[ -d "$repo_dir/.git" ]]; then
    (cd "$repo_dir" && git pull --quiet origin main 2>/dev/null) || true
  fi
done

# --- Clone/pull ---
if [[ -d "$BACKUP_DIR/.git" ]]; then
  cd "$BACKUP_DIR"
  git pull --quiet origin main 2>/dev/null || true
else
  rm -rf "$BACKUP_DIR"
  git clone --quiet "$AUTH_URL" "$BACKUP_DIR"
  cd "$BACKUP_DIR"
fi

# Set git identity
git config user.email "${ASSISTANT_NAME}@with3ai.com"
git config user.name "${ASSISTANT_NAME}"

# --- Sync backup content ---
# 1. Memory
rsync -a --delete \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='archive/' \
  "${SOURCE_BASE}/memory/" "${BACKUP_DIR}/memory/"

# 2. Skills config (SKILL.md + config files only, no node_modules or code)
mkdir -p "${BACKUP_DIR}/skills-config"
for skill_dir in "${SOURCE_BASE}/.claude/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  mkdir -p "${BACKUP_DIR}/skills-config/${skill_name}"
  # Copy SKILL.md and config files
  [[ -f "${skill_dir}/SKILL.md" ]] && cp "${skill_dir}/SKILL.md" "${BACKUP_DIR}/skills-config/${skill_name}/"
  [[ -f "${skill_dir}/config.json" ]] && cp "${skill_dir}/config.json" "${BACKUP_DIR}/skills-config/${skill_name}/"
  [[ -f "${skill_dir}/CHANGELOG.md" ]] && cp "${skill_dir}/CHANGELOG.md" "${BACKUP_DIR}/skills-config/${skill_name}/"
done

# 3. Workspace docs
if [[ -d "${SOURCE_BASE}/workspace/docs" ]]; then
  rsync -a --delete "${SOURCE_BASE}/workspace/docs/" "${BACKUP_DIR}/workspace-docs/"
fi

# 4. Workspace content (deliverables, etc.)
if [[ -d "${SOURCE_BASE}/workspace/content" ]]; then
  rsync -a --delete \
    --exclude='*.tmp' \
    "${SOURCE_BASE}/workspace/content/" "${BACKUP_DIR}/workspace-content/"
fi

# 5. Workspace projects
if [[ -d "${SOURCE_BASE}/workspace/projects" ]]; then
  rsync -a --delete --exclude='.git' --exclude='node_modules' "${SOURCE_BASE}/workspace/projects/" "${BACKUP_DIR}/workspace-projects/"
fi

# --- Commit & push ---
cd "$BACKUP_DIR"
git add -A

if git diff --cached --quiet; then
  echo "$(date '+%Y-%m-%d %H:%M') No changes to backup"
  exit 0
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
CHANGED=$(git diff --cached --stat | tail -1)

if $DRY_RUN; then
  echo "[DRY RUN] Would commit: backup ${TIMESTAMP} (${CHANGED})"
  git diff --cached --stat
  exit 0
fi

git commit -m "backup ${TIMESTAMP}

${CHANGED}" --quiet
git push --quiet origin main

echo "$(date '+%Y-%m-%d %H:%M') Backup complete (${CHANGED})"
