import { describe, expect, it } from 'vitest';
import { buildRosterSnapshot } from '../scripts/health-reporter.mjs';

describe('health reporter roster snapshot', () => {
  const statusline = {
    session_id: 'session-a',
    version: '0.4.2',
    model: { id: 'claude-opus-4', display_name: 'Claude Opus' },
    context_window: {
      used_percentage: 61,
      total_input_tokens: 120000,
      total_output_tokens: 2000,
    },
    rate_limits: {
      five_hour: { used_percentage: 34, resets_at: 1_785_003_600 },
      seven_day: { used_percent: 71, resets_at: 1_785_600_000 },
    },
  };

  it('uses the source statusline timestamp instead of report time', () => {
    const snapshot = buildRosterSnapshot({
      ...statusline,
      timestamp: '2026-07-25T15:59:00.000Z',
    }, Date.parse('2026-07-25T16:00:00.000Z'));

    expect(snapshot.sampled_at).toBe(Date.parse('2026-07-25T15:59:00.000Z'));
    expect(snapshot).not.toHaveProperty('session_id');
    expect(snapshot.context_total_tokens).toBe(122000);
    expect(snapshot.rate_limits).toMatchObject({
      five_hour: { used_pct: 34 },
      seven_day: { used_pct: 71 },
    });
  });

  it('falls back to file mtime when the statusline has no source timestamp', () => {
    const sourceMtime = Date.parse('2026-07-25T16:00:00.000Z');
    expect(buildRosterSnapshot(statusline, sourceMtime).sampled_at).toBe(sourceMtime);
  });

  it('keeps small millisecond clocks and converts plausible epoch seconds', () => {
    expect(buildRosterSnapshot({ ...statusline, timestamp: 2000 }).sampled_at).toBe(2000);
    expect(buildRosterSnapshot({
      ...statusline,
      timestamp: 1_785_003_600,
    }).sampled_at).toBe(1_785_003_600_000);
  });
});
