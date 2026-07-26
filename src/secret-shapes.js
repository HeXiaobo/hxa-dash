'use strict';

// Secret value-shape detection (canonical requirement).
//
// WHY: `wiki/procedures/hxa-dash-anomaly-criteria-v1.md` requires
// "secret 值形态检测（sk-/ghp_/AIza/JWT/BEGIN）+ 日志与错误路径同样过净化".
// The existing field-level allowlists (sanitizeRoster / sanitizeBackup /
// sanitizeRuntime) drop *unknown fields*, but they cannot stop a secret that
// arrives INSIDE an allowed field — e.g. `model: "sk-ant-..."` was previously
// only length-clamped, then stored and rendered on the homepage.
// Found by SS during the issue #25 security review (2026-07-26); Mylos rated
// it P1 because it touches the credential red line.
//
// DESIGN CHOICE (flagged for reviewer): a match is replaced with a visible
// marker rather than silently dropped. A silent drop hides a misconfigured
// reporter — you cannot tell afterwards that anything was scrubbed. The marker
// keeps the event observable while never storing the secret itself.
const REDACTED = '[redacted:secret-shape]';

// Specific, high-confidence provider prefixes. These are the primary defense.
const SECRET_SHAPE_PATTERNS = [
  { name: 'openai/anthropic-style', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{20,}/ },
  { name: 'slack-token', re: /xox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'pem-block', re: /-----BEGIN [A-Z0-9 ]*-----/ },
  // Generic long base64-ish blob. Deliberately guarded to avoid false
  // positives: requires >=40 chars AND mixed case AND a digit, so a 40-char
  // lowercase hex sha / a long snake_case identifier does NOT match.
  // Rationale: every field routed through the sanitizers is a short descriptive
  // value (model / version / plan_type / hostname), so a blob like this is not
  // a legitimate value there. A false block here is worse than a miss, because
  // the specific rules above already cover the known credential formats.
  {
    name: 'long-base64-blob',
    re: /(?=[A-Za-z0-9+/]{40,}={0,2})(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*[0-9])[A-Za-z0-9+/]{40,}={0,2}/,
  },
];

// Returns the matching pattern name, or null.
function matchSecretShape(value) {
  if (typeof value !== 'string' || !value) return null;
  for (const { name, re } of SECRET_SHAPE_PATTERNS) {
    if (re.test(value)) return name;
  }
  return null;
}

// Replace the whole value when it looks like a credential.
// Whole-value (not substring) replacement is intentional: a partially redacted
// string can still leak the sensitive remainder.
function redactSecretShaped(value) {
  return matchSecretShape(value) ? REDACTED : value;
}

// Depth cap for the recursive walker. A hostile or accidentally self-referential
// payload must not be able to blow the stack inside an ingest handler.
const MAX_DEPTH = 8;

// Recursive redaction for structured payloads.
//
// WHY this exists alongside the scalar version: the report.js ingest points
// accept free-form nested bodies — `metadata` (arbitrary object) on
// /api/report, `tags` (array) on /api/webhook/connect, per-event objects on
// /api/report/activity. Those have no field allowlist, so a fixed list of field
// names can neither reach into `metadata` nor survive someone adding a field
// later. Callers apply this at their db-write boundary instead.
//
// Object KEYS are redacted too: a key is serialized into the stored JSON and
// rendered on the homepage exactly like a value, so `{"sk-ant-...": 1}` would
// leak through a value-only walker.
//
// Idempotent: the REDACTED marker itself matches no pattern, so re-redacting a
// previously stored value is a no-op.
function redactSecretShapedDeep(value, depth = 0) {
  if (typeof value === 'string') return redactSecretShaped(value);
  if (value === null || typeof value !== 'object') return value;
  // Below the cap we DROP rather than pass through: an unredacted pass-through
  // is precisely the failure this module exists to prevent.
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.map(item => redactSecretShapedDeep(item, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[redactSecretShaped(key)] = redactSecretShapedDeep(item, depth + 1);
  }
  return out;
}

module.exports = {
  REDACTED,
  SECRET_SHAPE_PATTERNS,
  MAX_DEPTH,
  matchSecretShape,
  redactSecretShaped,
  redactSecretShapedDeep,
};
