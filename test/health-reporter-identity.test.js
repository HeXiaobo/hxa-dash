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

  it('does not leak prose words after a bare "agent" mention (yaya 404 regression)', () => {
    // Greedy regex used to match "agent from" -> "from" -> POST /from -> 404.
    const content = [
      'I am Yaya.',
      'I am a distinct agent from Mylos, not just a tool.',
    ].join('\n');
    expect(extractIdentityBotName(content)).toBe('yaya');
  });

  it('returns null on pure prose with no real identity declaration', () => {
    expect(
      extractIdentityBotName('I am a distinct agent from Mylos, not a tool.'),
    ).toBeNull();
  });

  it('still matches a real key:value declaration with a delimiter', () => {
    expect(extractIdentityBotName('bot_name: hongshu')).toBe('hongshu');
    expect(extractIdentityBotName('agent = chengzi')).toBe('chengzi');
  });
});
