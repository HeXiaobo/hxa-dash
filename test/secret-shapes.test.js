import { describe, expect, it } from 'vitest';

const { matchSecretShape, redactSecretShaped, REDACTED } = require('../src/secret-shapes');
const agentHealthRoute = require('../src/routes/agent-health');

const { sanitizeRoster, sanitizeRuntime } = agentHealthRoute.__private;

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

  it('replaces the whole value, never a partial remainder', () => {
    // A substring-only redaction would leave the tail readable.
    const mixed = 'prefix sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCC suffix';
    expect(redactSecretShaped(mixed)).toBe(REDACTED);
    expect(redactSecretShaped(mixed)).not.toContain('CCCC');
  });
});
