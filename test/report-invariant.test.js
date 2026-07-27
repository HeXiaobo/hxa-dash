// issue #25 P2 item 7 (Veda proposed·SS implements): make the report.js
// db-write-boundary invariant a vitest assertion instead of a comment saying
// "please remember". The invariant, stated in src/routes/report.js's own
// header comment: there is no bare `db.insert*`/`db.upsert*` call in that
// file outside the four `safeXxx` wrappers (safeUpsertAgent, safeInsertEvent,
// safeUpsertTask, safeUpsertEdge) — every write must go through the
// credential guard. No CI config change needed; this is self-contained.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPORT_JS_PATH = path.join(__dirname, '..', 'src', 'routes', 'report.js');
const WRAPPER_NAMES = ['safeUpsertAgent', 'safeInsertEvent', 'safeUpsertTask', 'safeUpsertEdge'];

// The file's own header comment illustrates the invariant in prose — e.g.
// `("no bare db.upsert/db.insert in report.js")` — which would otherwise
// false-trigger the assertion below on the comment text itself, not on code.
// Verified there are no `//` sequences inside string/URL literals in this
// file (checked at authoring time), so line-comment stripping is safe here.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function stripWrapperBodies(source) {
  // Each wrapper is a single-line-body function declaration:
  //   function safeXxx(arg) {\n  db.xxx(...);\n}
  // No nested braces inside any of the four, so a non-greedy `[^}]*` safely
  // spans exactly one function body per wrapper.
  const re = new RegExp(
    `function (?:${WRAPPER_NAMES.join('|')})\\([^)]*\\)\\s*{[^}]*}`,
    'g'
  );
  return stripComments(source).replace(re, '');
}

describe('issue #25 P2 item 7 — report.js db-write boundary invariant (CI-assertable)', () => {
  it('all four safeXxx wrappers are present (sanity: the strip below must actually remove something)', () => {
    const source = fs.readFileSync(REPORT_JS_PATH, 'utf8');
    for (const name of WRAPPER_NAMES) {
      expect(source, `expected function ${name} to exist in report.js`).toContain(`function ${name}(`);
    }
  });

  it('report.js contains zero bare db.insert*/db.upsert* calls outside the four safe wrappers', () => {
    const source = fs.readFileSync(REPORT_JS_PATH, 'utf8');
    const stripped = stripWrapperBodies(source);
    const hits = stripped.match(/db\.(upsert|insert)\w*/g) || [];
    expect(hits, `found bare db.* write(s) outside safeXxx wrappers: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('the strip actually removes the four wrapped db.* calls (proves the regex targets the right text, not an accidental no-op)', () => {
    const source = fs.readFileSync(REPORT_JS_PATH, 'utf8');
    const before = (source.match(/db\.(upsert|insert)\w*/g) || []).length;
    const after = (stripWrapperBodies(source).match(/db\.(upsert|insert)\w*/g) || []).length;
    expect(before).toBeGreaterThan(after);
    expect(after).toBe(0);
  });
});
