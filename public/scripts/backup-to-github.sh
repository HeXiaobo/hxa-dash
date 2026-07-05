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

# --- Pre-commit secret scan (TWO-TIER, fail-closed on MATCH and on SCANNER ERROR) ---
# Structure adopted from SS's Tier1/Tier2 design to kill the false-positive class where a broad
# case-insensitive `token=value{16,}` heuristic mis-flags Feishu doc/base resource IDs (which are
# LOCATORS requiring app auth to use, NOT credentials) — the same FP class as the "AKIA" word hit.
#   Tier1 — hard credential formats. CASE-SENSITIVE (no -i), prefix + fixed charset. Match -> abort.
#   Tier2 — fuzzy key=value heuristic. Case-insensitive, THEN filtered through an allowlist
#           (placeholders, env references, and Feishu resource IDs). Survivors -> abort.
# Exit-code contract preserved (never swallowed with a blanket `|| true`):
#   match found  -> abort;   no match -> continue;   scanner run error (rc>1) -> abort fail-closed.
# Tier1: strict — real credentials only match these exact prefix+charset shapes.
_t1_patterns=(
  -e 'sk-[A-Za-z0-9_-]{20,}'
  -e 'gh[pousr]_[A-Za-z0-9_]{20,}'
  -e 'github_pat_[A-Za-z0-9_]{20,}'
  -e 'xox[baprs]-[A-Za-z0-9-]{10,}'
  -e 'AKIA[0-9A-Z]{16}'
  -e '-----BEGIN[A-Z ]*PRIVATE KEY'
)
# Tier2: fuzzy key=value (matched case-insensitively).
_t2_kv='(api[_-]?key|token|secret|password)[[:space:]]*[:=][[:space:]]*["'\'']?[A-Za-z0-9_./+=-]{16,}'
# Tier2 allowlist (case-insensitive). Placeholders / env references / ellipsis, PLUS Feishu resource
# identifiers: <resource>_token|_id locators (doc/base/wiki/sheet/...) which need app auth to be
# useful and are NOT credentials. Real Feishu auth (app_secret) is deliberately NOT allowlisted and
# still trips Tier2; hard tokens still trip Tier1 regardless — allowlist only relaxes the kv layer.
# The allowlist is applied per-line by the loop below with the DANGER guard checked FIRST, so a
# benign/resource word elsewhere on the line can NEVER rescue a real secret (closes veda ③ AND the
# danger-vs-benign ordering hole): a secret/password/api_key line is acquitted ONLY when THAT key's
# OWN value is a benign form; a token-family line may be acquitted by its own benign value or by a
# Feishu resource-id key name. Hard tokens still trip Tier1 regardless — this only relaxes the kv layer.
# _t2_vb = benign VALUE forms: env refs (incl. destructured `env.X`), fn-call values, placeholders.
#   (Deliberately NO bare property-access `a.b.c` — it collides with dotted secrets such as JWTs.)
_t2_vb='(process\.env|env\.|getenv|environ|\$\{|:-|[A-Za-z_][A-Za-z0-9_.]*\(|["'\'']?(example|placeholder|your[_-]|xxx+|redact|dummy|sample|changeme)|\.\.\.)'
_t2_danger='(secret|passwd|password|api[_-]?key)[[:space:]]*[:=][[:space:]]*["'\'']?[A-Za-z0-9_./+=-]{16,}'   # danger key + literal value present
_t2_danger_ok='(secret|passwd|password|api[_-]?key)[[:space:]]*[:=][[:space:]]*'"$_t2_vb"                     # danger key whose OWN value is benign -> acquit
_t2_tok_ok='token[[:space:]]*[:=][[:space:]]*'"$_t2_vb"                                                        # token-family key whose OWN value is benign -> acquit
_t2_wl_res='(doc|docx|wiki|space|base|bitable|sheet|spreadsheet|app|obj|node|folder|file|record|table|view|block|image|media|msg|message|chat|thread|calendar|event|task|approval|instance|minute|drive|receive|parent|root|open|union)_?(token|id)'
secret_matches="$(mktemp "${TMPDIR:-/tmp}/backup-secret-scan.XXXXXX")"

# ---- Tier1 (case-sensitive hard block) ----
t1_rc=0
if command -v rg >/dev/null 2>&1; then
  rg -I -l --hidden --glob '!.git/**' "${_t1_patterns[@]}" . >"$secret_matches" || t1_rc=$?
else
  # busybox/non-GNU compatible: prune .git via `find`, grep each file so per-scan rc stays clean.
  t1_rc=1
  while IFS= read -r -d '' f; do
    if grep -IqE "${_t1_patterns[@]}" -- "$f" 2>/dev/null; then
      printf '%s\n' "$f" >>"$secret_matches"; t1_rc=0
    else
      grc=$?; if [[ $grc -gt 1 ]]; then t1_rc=$grc; break; fi
    fi
  done < <(find . -name .git -prune -o -type f -print0)
fi
if [[ $t1_rc -eq 0 ]]; then
  { echo "🚨 TIER1 hard-credential match:"; sed 's#^\./##' "$secret_matches"; } >&2
  rm -f "$secret_matches"; fail "secret scan (Tier1) found credentials; backup aborted before commit"
elif [[ $t1_rc -gt 1 ]]; then
  rm -f "$secret_matches"; fail "secret scan (Tier1) FAILED to run (rc=$t1_rc) — aborting fail-closed (not treating as clean)"
fi

# ---- Tier2 (case-insensitive kv, minus allowlist) ----
# Collect matching LINES (not just filenames) so the allowlist can be applied per-line.
t2raw="$(mktemp "${TMPDIR:-/tmp}/backup-secret-t2.XXXXXX")"
t2_err=0
if command -v rg >/dev/null 2>&1; then
  rg -nI --hidden --glob '!.git/**' -i -e "$_t2_kv" . >"$t2raw" || { rc=$?; [[ $rc -gt 1 ]] && t2_err=$rc; }
else
  while IFS= read -r -d '' f; do
    if out="$(grep -nIiE -e "$_t2_kv" -- "$f" 2>/dev/null)"; then
      printf '%s\n' "$out" | sed "s#^#${f#./}:#" >>"$t2raw"
    else
      grc=$?; if [[ $grc -gt 1 ]]; then t2_err=$grc; break; fi
    fi
  done < <(find . -name .git -prune -o -type f -print0)
fi
if [[ $t2_err -gt 1 ]]; then
  rm -f "$secret_matches" "$t2raw"; fail "secret scan (Tier2) FAILED to run (rc=$t2_err) — aborting fail-closed (not treating as clean)"
fi
: >"$secret_matches"
# Per-line adjudication (order matters — DANGER is checked first, acquittal is anchored to the
# matched key's OWN value so nothing else on the line can rescue a real secret):
#   1) danger key (secret/password/api_key) + literal value -> acquit ONLY if its own value is
#      benign; else SURVIVOR
#   2) token-family key -> acquit if its own value is benign, or the key is a Feishu resource-id
#   3) otherwise -> SURVIVOR
while IFS= read -r _line; do
  [[ -n "$_line" ]] || continue
  # 1) DANGER FIRST: a secret/password/api_key with a literal value. Acquit ONLY if THAT key's own
  #    value is benign (env ref / fn call / placeholder); otherwise it is a survivor. No other word
  #    on the line can rescue it.
  if printf '%s' "$_line" | grep -qiE -e "$_t2_danger"; then
    if printf '%s' "$_line" | grep -qiE -e "$_t2_danger_ok"; then continue; fi
    printf '%s\n' "$_line" >>"$secret_matches"; continue
  fi
  # 2) token-family line: acquit if its own value is benign, or the key is a Feishu resource-id.
  if printf '%s' "$_line" | grep -qiE -e "$_t2_tok_ok"; then continue; fi
  if printf '%s' "$_line" | grep -qiE -e "$_t2_wl_res"; then continue; fi
  # 3) otherwise -> survivor
  printf '%s\n' "$_line" >>"$secret_matches"
done <"$t2raw"
if [[ -s "$secret_matches" ]]; then
  { echo "⚠️ TIER2 secret-like value survived allowlist (triage):"; sed 's#^\./##' "$secret_matches"; } >&2
  rm -f "$secret_matches" "$t2raw"; fail "secret scan (Tier2) found non-allowlisted secret-like values; backup aborted before commit"
fi
rm -f "$secret_matches" "$t2raw"

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
