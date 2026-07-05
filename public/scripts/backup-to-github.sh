#!/usr/bin/env bash
# AI Assistant GitHub Backup Script  (canonical / fleet-wide)
# Usage: ./backup-to-github.sh [--dry-run]
#
# Base = yueran's hardened superset (2026-07-05); canonicalized for the whole fleet by veda:
#   [mylos]   push exit-code gate + post-push remote==local verify (no false-green)
#   [mylos]   startup `git fsck --connectivity-only` self-heal (re-clone on object corruption)
#   [veda]    fail-closed: BACKUP_DIR must be persistent + under SOURCE_BASE/workspace (no /tmp)
#   [yueran]  token via ephemeral GIT_ASKPASS (never persisted in .git/config)
#   [yueran]  allowlist-narrowed scope; skill backup = SKILL.md/CHANGELOG only (NOT config.json → no creds)
#   [yueran]  pre-commit secret scan (fail-closed) — blocks credentials from ever entering the repo
# Canonicalization vs yueran's per-bot version (Mylos review):
#   ① workspace allowlist is parameterized (WORKSPACE_BACKUP_DIRS env), not hardcoded per-bot
#   ② self-path resolved from ${BASH_SOURCE} (no hardcoded $SOURCE_BASE/bin path assumption)
#   ③ secret scan uses ripgrep if present, else falls back to grep (rg not installed fleet-wide)

set -euo pipefail

BACKUP_REPO_URL="${BACKUP_REPO_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-}"
ASSISTANT_NAME="${ASSISTANT_NAME:-zylos}"
SOURCE_BASE="${SOURCE_BASE:-${HOME}/zylos}"
GIT_TOKEN="${GIT_TOKEN:-}"
GIT_USERNAME="${GIT_USERNAME:-x-access-token}"
# ① Parameterized workspace allowlist (space-separated subdirs of $SOURCE_BASE/workspace).
#    REQUIRED — validated up front in the Validate block (no default; a misconfig fails closed
#    before any network/filesystem side-effect). Explicit allowlist only — no implicit default.
WORKSPACE_BACKUP_DIRS="${WORKSPACE_BACKUP_DIRS:-}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

log()  { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M')" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }

for cmd in git rsync mktemp; do require_cmd "$cmd"; done   # ③ rg NOT hard-required (grep fallback below)

# --- Validate (fail-closed) ---
[[ -n "$BACKUP_REPO_URL" ]] || fail "BACKUP_REPO_URL must be set"
# Reject credentials embedded in the URL (e.g. https://token@host): `git clone` / `git remote
# set-url` would persist them into .git/config. Token must arrive ONLY via GIT_TOKEN/askpass. [yueran #1]
[[ "$BACKUP_REPO_URL" != *"@"* ]] || fail "BACKUP_REPO_URL must NOT embed credentials (no 'user:token@host'); pass the token via GIT_TOKEN only"
[[ -n "$GIT_TOKEN" ]] || fail "GIT_TOKEN must be set"
[[ -n "$BACKUP_DIR" ]] || fail "BACKUP_DIR must be set to an explicit persistent path (no default; /tmp is volatile)"
[[ -d "$SOURCE_BASE" ]] || fail "SOURCE_BASE does not exist: $SOURCE_BASE"
[[ "$BACKUP_DIR" != /tmp/* && "$BACKUP_DIR" != /tmp && "$BACKUP_DIR" != /var/tmp/* && "$BACKUP_DIR" != /dev/shm/* ]] || fail "BACKUP_DIR must not be on a volatile/tmp filesystem (lost on reboot)"
[[ "$BACKUP_DIR" == "$SOURCE_BASE"/workspace/* ]] || fail "BACKUP_DIR must stay under SOURCE_BASE/workspace"
[[ "$BACKUP_DIR" != "$SOURCE_BASE" && "$BACKUP_DIR" != "${HOME}" && "$BACKUP_DIR" != "/" ]] || fail "unsafe BACKUP_DIR"
# Workspace allowlist: validate UP FRONT (before any network/filesystem side-effect) so a
# misconfig (unset, or a bad entry) aborts with zero clone/reset/rsync impact. [yueran review]
[[ -n "${WORKSPACE_BACKUP_DIRS// }" ]] || fail "WORKSPACE_BACKUP_DIRS must be set (explicit allowlist of workspace subdirs); refusing a broad default backup surface"
_ws_real="$(readlink -f "$SOURCE_BASE/workspace" 2>/dev/null || true)"
[[ -n "$_ws_real" ]] || fail "cannot resolve $SOURCE_BASE/workspace"
for rel in $WORKSPACE_BACKUP_DIRS; do
  case "$rel" in
    ""|/*|*..*|*'*'*|*'?'*|*'['*|*']'*) fail "invalid WORKSPACE_BACKUP_DIRS entry '$rel' (no empty, absolute, '..', or glob-metacharacter entries)" ;;
  esac
  # Symlink-escape guard: if the entry exists, its PHYSICAL path must stay under workspace —
  # else `rsync "$src/"` would follow a symlink out and pull external private content in. [yueran]
  src="$SOURCE_BASE/workspace/$rel"
  if [[ -e "$src" ]]; then
    _rel_real="$(readlink -f "$src" 2>/dev/null || true)"
    [[ -n "$_rel_real" && ( "$_rel_real" == "$_ws_real" || "$_rel_real" == "$_ws_real"/* ) ]] \
      || fail "WORKSPACE_BACKUP_DIRS entry '$rel' resolves outside workspace (symlink escape) -> ${_rel_real:-unresolved}"
  fi
done

# --- Auth: token via ephemeral GIT_ASKPASS, never persisted in .git/config [yueran] ---
export GIT_TERMINAL_PROMPT=0
ASKPASS_FILE=""
cleanup() { [[ -n "$ASKPASS_FILE" && -f "$ASKPASS_FILE" ]] && rm -f "$ASKPASS_FILE"; }
trap cleanup EXIT
if [[ -n "$GIT_TOKEN" ]]; then
  ASKPASS_FILE="$(mktemp "${TMPDIR:-/tmp}/git-askpass.XXXXXX")"
  cat >"$ASKPASS_FILE" <<'ASKPASS'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' "${GIT_USERNAME:-x-access-token}" ;;
  *Password*) printf '%s\n' "$GIT_TOKEN" ;;
  *) printf '\n' ;;
esac
ASKPASS
  chmod 700 "$ASKPASS_FILE"
  export GIT_ASKPASS="$ASKPASS_FILE"
fi

mkdir -p "$(dirname "$BACKUP_DIR")"

# --- Clone / pull (integrity self-heal) ---
if [[ -d "$BACKUP_DIR/.git" ]]; then
  cd "$BACKUP_DIR"
  # NOTE: this fleet's git does NOT support `fsck --quiet` — do not add that flag.
  if ! git fsck --connectivity-only >/dev/null 2>&1 || ! git rev-parse --verify -q 'HEAD^{tree}' >/dev/null 2>&1; then
    log "WARN: local backup clone corrupt; re-cloning"
    cd "$SOURCE_BASE"; rm -rf "$BACKUP_DIR"
    git clone --quiet --depth 1 "$BACKUP_REPO_URL" "$BACKUP_DIR"; cd "$BACKUP_DIR"
  else
    git remote set-url origin "$BACKUP_REPO_URL"
    git pull --quiet origin main 2>/dev/null || true
  fi
else
  rm -rf "$BACKUP_DIR"
  git clone --quiet --depth 1 "$BACKUP_REPO_URL" "$BACKUP_DIR"; cd "$BACKUP_DIR"
fi

git remote set-url origin "$BACKUP_REPO_URL"   # ensure remote stays token-free
git config user.email "${ASSISTANT_NAME}@with3ai.com"
git config user.name "$ASSISTANT_NAME"

# Reset backup tree to the current allowlist (history stays recoverable in Git).
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

rsync_common=(-a --safe-links --delete --exclude='.git' --exclude='.DS_Store' --exclude='node_modules'
  --exclude='.cache' --exclude='*.log' --exclude='*.tmp' --exclude='tmp/'
  --exclude='.env' --exclude='.env.*' --exclude='*.pem' --exclude='*.key'
  --exclude='id_rsa*' --exclude='id_ed25519*' --exclude='*.token'
  --exclude='*credentials*' --exclude='auth.json' --exclude='.git-credentials')

# Memory: active memory + reference, not cold archives or session logs.
mkdir -p "$BACKUP_DIR/memory"
rsync "${rsync_common[@]}" --exclude='archive/' --exclude='sessions/' "$SOURCE_BASE/memory/" "$BACKUP_DIR/memory/"

# Skill instructions only. NOT config.json — it may contain credentials.
rm -rf "$BACKUP_DIR/skills"; mkdir -p "$BACKUP_DIR/skills"
for skill_dir in "$SOURCE_BASE/.claude/skills"/*/; do
  [[ -d "$skill_dir" ]] || continue
  skill_name="$(basename "$skill_dir")"
  mkdir -p "$BACKUP_DIR/skills/$skill_name"
  [[ -f "$skill_dir/SKILL.md" ]] && cp "$skill_dir/SKILL.md" "$BACKUP_DIR/skills/$skill_name/"
  [[ -f "$skill_dir/CHANGELOG.md" ]] && cp "$skill_dir/CHANGELOG.md" "$BACKUP_DIR/skills/$skill_name/"
done

# Workspace deliverables/sedimentation — explicit allowlist (already validated up front).
rm -rf "$BACKUP_DIR/workspace"; mkdir -p "$BACKUP_DIR/workspace"
for rel in $WORKSPACE_BACKUP_DIRS; do
  src="$SOURCE_BASE/workspace/$rel"
  [[ -d "$src" ]] || continue
  mkdir -p "$BACKUP_DIR/workspace/$rel"
  rsync "${rsync_common[@]}" "$src/" "$BACKUP_DIR/workspace/$rel/"
done

# ② Include this backup script itself for operational review (self-path, no hardcoded assumption).
SELF_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/$(basename "${BASH_SOURCE[0]}")"
mkdir -p "$BACKUP_DIR/ops"
[[ -f "$SELF_PATH" ]] && cp "$SELF_PATH" "$BACKUP_DIR/ops/backup-to-github.sh" || log "WARN: could not resolve self path; skipping ops/ copy"

cat >"$BACKUP_DIR/BACKUP_MANIFEST.md" <<MANIFEST
# ${ASSISTANT_NAME} workspace backup

- Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')
- Source base: $SOURCE_BASE
- Scope: memory (no archive/sessions), skill instructions, workspace deliverables
- Excluded: secrets/env, config.json, runtime logs, caches, node_modules, tmp, cloned repos
MANIFEST

cd "$BACKUP_DIR"

# --- Pre-commit secret scan (fail-closed on MATCH and on SCANNER ERROR) [yueran review #4/#5] ---
# Exit-code contract (never swallowed with `|| true`):
#   0 = credential match found     -> abort
#   1 = no match                   -> continue
#  >1 = scanner failed (bad regex / perms / missing flag) -> abort fail-closed (NOT "clean")
_secret_patterns=(
  -e 'sk-[A-Za-z0-9_-]{20,}'
  -e 'gh[pousr]_[A-Za-z0-9_]{20,}'
  -e 'xox[baprs]-[A-Za-z0-9-]+'
  -e 'AKIA[0-9A-Z]{16}'
)
_secret_kv='(api[_-]?key|token|secret|password)[[:space:]]*[:=][[:space:]]*["'\'']?[A-Za-z0-9_./+=-]{16,}'
secret_matches="$(mktemp "${TMPDIR:-/tmp}/backup-secret-scan.XXXXXX")"
scan_rc=0
if command -v rg >/dev/null 2>&1; then
  rg -I -l --hidden --glob '!.git/**' "${_secret_patterns[@]}" \
     -e '(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*["'\'']?[A-Za-z0-9_./+=-]{16,}' \
     . >"$secret_matches" || scan_rc=$?
else
  # busybox/non-GNU compatible: prune .git via `find` (no GNU-only --exclude-dir), grep each
  # file individually so we keep clean per-scan exit codes (xargs would remap grep's rc).
  scan_rc=1
  while IFS= read -r -d '' f; do
    if grep -IqE -i "${_secret_patterns[@]}" -e "$_secret_kv" -- "$f" 2>/dev/null; then
      printf '%s\n' "$f" >>"$secret_matches"; scan_rc=0
    else
      grc=$?
      if [[ $grc -gt 1 ]]; then scan_rc=$grc; break; fi
    fi
  done < <(find . -name .git -prune -o -type f -print0)
fi
if [[ $scan_rc -eq 0 ]]; then
  sed 's#^\./##' "$secret_matches" >&2; rm -f "$secret_matches"
  fail "secret scan found potential credentials; backup aborted before commit"
elif [[ $scan_rc -gt 1 ]]; then
  rm -f "$secret_matches"
  fail "secret scan FAILED to run (rc=$scan_rc) — aborting fail-closed (not treating as clean)"
fi
rm -f "$secret_matches"

git add -A
if git diff --cached --quiet; then log "No changes to backup"; exit 0; fi

timestamp="$(date '+%Y-%m-%d %H:%M')"
changed="$(git diff --cached --stat | tail -1)"
if $DRY_RUN; then
  log "[DRY RUN] Would commit: backup ${timestamp} (${changed})"
  git diff --cached --stat
  exit 0
fi

git commit -m "backup ${timestamp}

${changed}" --quiet

# --- Push with hard exit-code guard + remote==local verify (no false-green) [mylos] ---
if ! git push --quiet origin main; then fail "git push failed; backup not saved to GitHub"; fi
local_head="$(git rev-parse HEAD)"
remote_head="$(git ls-remote origin refs/heads/main 2>/dev/null | cut -f1)"
if [[ -z "$remote_head" || "$remote_head" != "$local_head" ]]; then
  fail "push verify failed (local=${local_head:0:8} remote=${remote_head:0:8}); backup not confirmed"
fi

log "Backup complete (${changed}); remote=${remote_head:0:8}"
