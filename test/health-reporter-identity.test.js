import { describe, expect, it } from 'vitest';
import {
  extractIdentityBotName,
  isGenericRuntimeAgentName,
} from '../scripts/health-reporter.mjs';

describe('health reporter identity detection (#16)', () => {
  it('does not treat runtime names as agent identities', () => {
    expect(isGenericRuntimeAgentName('codex')).toBe(true);
    expect(isGenericRuntimeAgentName('Claude Code')).toBe(true);
    expect(isGenericRuntimeAgentName('wenwen')).toBe(false);
  });

  it('prefers explicit HxA identity over generic runtime prose', () => {
    const content = [
      'I am Codex CLI.',
      'HXA ID: wenwen',
    ].join('\n');

    expect(extractIdentityBotName(content)).toBe('wenwen');
  });

  it('ignores identity prose that only names the runtime', () => {
    expect(extractIdentityBotName('I am Codex CLI.')).toBeNull();
  });
});
