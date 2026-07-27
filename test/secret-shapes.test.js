import { describe, expect, it } from 'vitest';

const { matchSecretShape, redactSecretShaped, redactSecretShapedDeep, REDACTED } = require('../src/secret-shapes');
const agentHealthRoute = require('../src/routes/agent-health');

const { sanitizeRoster, sanitizeRuntime, sanitizeBackupRepo, sanitizeBackupCron } = agentHealthRoute.__private;

// ⚠️ ALL credential-shaped strings below are SYNTHETIC FIXTURES, never real keys:
// repeated A/B filler + the public jwt.io sample token. A secret-detection test
// cannot exist without secret-shaped input, so a secret-scanner WILL flag this
// file — that is expected and must not be read as a leak. (Same pattern already
// present in test/backups.test.js.)
//
// Provenance: issue #25 security review (SS 2026-07-26). The field-level
// allowlists already drop unknown fields; this suite covers the gap they cannot
// close — a credential arriving inside an ALLOWED field.
describe('secret value-shape detection', () => {
  it('detects each credential family required by anomaly-criteria-v1', () => {
    const cases = [
      ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', 'openai/anthropic-style'],
      ['ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'github-token'],
      ['AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'google-api-key'],
      ['xoxb-1234567890-ABCDEFGHIJ', 'slack-token'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'jwt'],
      ['-----BEGIN RSA PRIVATE KEY-----', 'pem-block'],
    ];
    for (const [value, expected] of cases) {
      expect(matchSecretShape(value), value).toBe(expected);
      expect(redactSecretShaped(value)).toBe(REDACTED);
    }
  });

  // 🔴 The point of this block: a false block is worse than a miss here, because
  // legitimate telemetry silently turning into [redacted] is itself a data defect.
  it('does NOT redact legitimate short descriptive values', () => {
    const legit = [
      'claude-opus-4',
      'Claude Opus 4.1',
      'codex',
      '0.4.2',
      'max',
      'hxa-mac-mini.local',
      'claude_code',
      // 40-char lowercase hex sha: inside the base64 alphabet but no mixed case
      'd54946d0c6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      // long snake_case identifier: no digits + no uppercase
      'a_very_long_but_perfectly_legitimate_identifier_name',
    ];
    for (const value of legit) {
      expect(matchSecretShape(value), value).toBeNull();
      expect(redactSecretShaped(value)).toBe(value);
    }
  });

  it('redacts a secret hidden inside an ALLOWED roster field (the real gap)', () => {
    const roster = sanitizeRoster({
      model: 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB',
      model_display: 'Claude Opus',
      version: 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      runtime_type: 'claude_code',
      plan_type: 'max',
      sampled_at: '2026-07-26T00:00:00Z',
    });
    expect(roster.model).toBe(REDACTED);
    expect(roster.version).toBe(REDACTED);
    // whole-object assertion: no credential fragment survives anywhere
    const serialized = JSON.stringify(roster);
    expect(serialized).not.toContain('sk-ant');
    expect(serialized).not.toContain('ghp_');
    // untouched legitimate fields still pass through
    expect(roster.model_display).toBe('Claude Opus');
    expect(roster.plan_type).toBe('max');
  });

  it('redacts credential-shaped runtime version strings too', () => {
    const runtime = sanitizeRuntime({
      type: 'codex',
      version: 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    });
    expect(runtime.version).toBe(REDACTED);
    expect(JSON.stringify(runtime)).not.toContain('AIza');
  });

  // 🔴 REGRESSION FENCE for a false-positive bug that 61a763f/db33482 shipped.
  // The generic long-base64 rule was NOT whole-value anchored, and the base64
  // alphabet contains `/` — so any sufficiently long path or URL carrying an
  // uppercase letter and a digit matched. Mylos scanned the production DB and
  // found 315 such hits (e.g. a backup cron line with `${KIMI_API_KEY:-}` in it).
  // Every value below is legitimate operational text and MUST pass through.
  // ⚠️ FIXTURE REQUIREMENT, learned the hard way: every value here must contain a
  // run of >=40 consecutive base64-alphabet chars (so NO dots, dashes or
  // underscores inside the path segment) with mixed case and a digit. A first
  // draft of this block used realistic paths like `/tmp/zylos-Backup-2026/...`,
  // whose `-` and `.` break the run — those passed under the OLD regex too, so
  // the block was fake-green: it asserted nothing. Verified by mutation: with the
  // anchors removed, all three values below match and this test fails.
  it('does NOT redact long paths, URLs or command lines (the 315-hit false positive)', () => {
    const legitOperational = [
      // Shape of the real kimi backup cron line Mylos verified against: long
      // dotless path + an unexpanded env-var reference. (Shape reconstruction —
      // the exact production string lives in his scan output, not in this repo.)
      '0 3 * * * /usr/local/bin/backup.sh --out /tmp/zylosBackup2026/Snapshots/AgentHealth7/latestLine "${KIMI_API_KEY:-}"',
      'wrote /tmp/zylosBackup2026/Snapshots/AgentHealth7/latestLine.txt',
      'https://storage.example.com/zylosBackup2026/Snapshots/AgentHealth7/latestLine?v=1',
    ];
    for (const value of legitOperational) {
      expect(matchSecretShape(value), value).toBeNull();
      expect(redactSecretShaped(value)).toBe(value);
    }
  });

  // Mylos's terminal-signature requirement: the anchoring changed "whole value
  // only", which changes redactSecretShapedDeep's behaviour on NESTED values as
  // well as top-level strings — and the two were never verified together.
  it('applies the anchored rule consistently inside nested structures (both directions)', () => {
    const preserved = redactSecretShapedDeep({
      meta: { nested: { path: 'wrote /tmp/zylosBackup2026/Snapshots/AgentHealth7/latestLine.txt' } },
    });
    expect(preserved.meta.nested.path)
      .toBe('wrote /tmp/zylosBackup2026/Snapshots/AgentHealth7/latestLine.txt');

    const redacted = redactSecretShapedDeep({
      meta: { nested: { key: 'QWxhZGRpbjpvcGVuU2VzYW1lMTIzNDU2Nzg5MEFCQ0RFRkdI=' } },
    });
    expect(redacted.meta.nested.key).toBe(REDACTED);
  });

  it('still catches a whole-value base64 blob after the anchoring fix', () => {
    // The anchoring must not turn the generic rule into a no-op.
    expect(matchSecretShape('QWxhZGRpbjpvcGVuU2VzYW1lMTIzNDU2Nzg5MEFCQ0RFRkdI='))
      .toBe('long-base64-blob');
  });

  it('still catches the specific provider formats EMBEDDED in a longer string', () => {
    // Only the generic rule is anchored; the six specific rules stay unanchored,
    // which is where identifiable leaked credentials actually get caught.
    expect(matchSecretShape('current model is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA today'))
      .toBe('openai/anthropic-style');
    expect(matchSecretShape('cloned with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ok'))
      .toBe('github-token');
  });

  it('replaces the whole value, never a partial remainder', () => {
    // A substring-only redaction would leave the tail readable.
    const mixed = 'prefix sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCC suffix';
    expect(redactSecretShaped(mixed)).toBe(REDACTED);
    expect(redactSecretShaped(mixed)).not.toContain('CCCC');
  });

  // ---------------------------------------------------------------------
  // KNOWN RESIDUAL — issue #25 P2 item 6 (Veda's precise four-condition
  // restatement, 2026-07-26): the generic long-base64 rule still
  // false-positives when a value satisfies ALL FOUR simultaneously:
  //   ① length >= 40  ② charset is only [A-Za-z0-9/] (any . - _ breaks it)
  //   ③ contains lowercase  ④ contains uppercase AND a digit.
  // A separator-free path like the one below satisfies all four.
  // ---------------------------------------------------------------------
  it('KNOWN RESIDUAL still reproduces without the field-aware fix: a dot-less path matches the generic rule', () => {
    const dotlessPath = '/home/User1/Workspace/AgentHealth/Snapshots/Backup7/LatestLine';
    expect(dotlessPath.length).toBeGreaterThanOrEqual(40);
    // Proves the four conditions are what triggers it, not "no dot" folklore:
    // a value with a `.` anywhere does NOT match, confirming condition ②.
    expect(matchSecretShape(dotlessPath + '.')).toBeNull();
    // The bare (unqualified) matcher still matches on the residual shape —
    // this is the gap the field-aware `skipGeneric` option exists to close.
    expect(matchSecretShape(dotlessPath)).toBe('long-base64-blob');
  });

  it('field-aware fix: `skipGeneric` passes the same dot-less path through untouched', () => {
    const dotlessPath = '/home/User1/Workspace/AgentHealth/Snapshots/Backup7/LatestLine';
    expect(matchSecretShape(dotlessPath, { skipGeneric: true })).toBeNull();
    expect(redactSecretShaped(dotlessPath, { skipGeneric: true })).toBe(dotlessPath);
  });

  it('field-aware fix does NOT weaken the vendor-specific rules: a real key shape embedded in a path field is still caught', () => {
    const pathWithEmbeddedKey = '/home/user/.config/backup-ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.bak';
    expect(matchSecretShape(pathWithEmbeddedKey, { skipGeneric: true })).toBe('github-token');
    expect(redactSecretShaped(pathWithEmbeddedKey, { skipGeneric: true })).toBe(REDACTED);
  });

  it('agent-health.js wires skipGeneric into the two known path fields (repo.path, cron.log_path)', () => {
    const repo = sanitizeBackupRepo({
      path: '/home/User1/Workspace/AgentHealth/Snapshots/Backup7/LatestLine',
      branch: 'main',
      status: 'ok',
    });
    expect(repo.path).toBe('/home/User1/Workspace/AgentHealth/Snapshots/Backup7/LatestLine');

    const cron = sanitizeBackupCron({
      supported: true,
      status: 'ok',
      log_path: '/home/User1/Workspace/AgentHealth/Snapshots/Backup7/LatestLine',
    });
    expect(cron.log_path).toBe('/home/User1/Workspace/AgentHealth/Snapshots/Backup7/LatestLine');

    // Negative control on the SAME two fields: a real vendor-shaped secret must
    // still be caught there — skipGeneric only exempts the generic rule.
    const repoLeaked = sanitizeBackupRepo({
      path: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      branch: 'main',
      status: 'ok',
    });
    expect(repoLeaked.path).toBe(REDACTED);
  });
});
