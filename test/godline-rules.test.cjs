'use strict';

/**
 * God-briefing rules (card godline-renderer-merge-rule-20260816).
 *
 * Two god-behavior rules must live in the SHIPPED harness briefing (the
 * godLine constant in src/main/hive.ts), not only in god's memory —
 * harness rules live in the harness:
 *  - RENDERER-MERGE BATCHING — god QAs branches anytime, but ff-merges
 *    renderer/preload-touching branches ONLY in restart/reload windows,
 *    batched; NEVER live (HMR reload of store/hook modules can
 *    white-screen the floor — an operator merge-now request gets the risk
 *    named plus the detached alternative); a restart-window merge runs as
 *    a DETACHED setsid process armed BEFORE the close (god's pane dies
 *    with the harness), verified by log after reboot; main-process/
 *    test-only branches merge immediately; push+restart together
 *    (hardened by card godline-renderer-merge-mechanism-20260817).
 *  - ARCHIVE-ON-READ — god moves a read inbox mail to inbox/.done/
 *    IMMEDIATELY before acting, so the typed-nudge fallback stands down
 *    inside its grace window; the card/board carry work state, not the
 *    inbox file.
 *  - ATOMIC JSON WRITES — every direct god write to tasks.json (or any
 *    shared hive JSON) goes through a tempfile in the same directory plus
 *    os.replace() onto the target, so a crash mid-write cannot corrupt the
 *    kanban and a stale read-modify-write cannot clobber a landing stamp
 *    (card godline-atomic-taskfile-writes-20260816).
 *
 * Same pattern as the SKILL-DRIVEN WORK amendment (session-naming card).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

// TS `private` is compile-time only — erased by transpile, reachable at runtime.
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const GOD = { id: 'god', name: 'God', role: 'god', cwd: '/w', isGod: true };

test('godLine carries the RENDERER-MERGE BATCHING rule', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(
    /RENDERER-MERGE BATCHING:/.test(p),
    'god briefing must carry the RENDERER-MERGE BATCHING rule',
  );
  assert.ok(/QA branches anytime/.test(p));
  assert.ok(/renderer\/preload-touching branches ONLY in restart\/reload windows, batched/.test(p));
  assert.ok(/main-process\/test-only branches merge immediately/.test(p));
  assert.ok(/push and restart\/reload together/.test(p));
  // hardening (card godline-renderer-merge-mechanism-20260817)
  assert.ok(/NEVER while the app RUNS/.test(p), 'must forbid live merges while the app runs');
  assert.ok(
    /hot-reloads the working tree/.test(p),
    'must say why: dev server hot-reloads the tree',
  );
  assert.ok(/HMR reload of store\/hook modules can white-screen the floor/.test(p));
  assert.ok(
    /name that risk and offer the detached merge/.test(p),
    'operator merge-now requests get the risk named + detached alternative',
  );
  assert.ok(/your pane dies with the harness/.test(p), 'god cannot act while the harness is down');
  assert.ok(/DETACHED process BEFORE the close/.test(p));
  assert.ok(/setsid script that polls for the harness process to disappear/.test(p));
  assert.ok(/verify the log after reboot/.test(p));
});

test('godLine carries the ARCHIVE-ON-READ rule', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/ARCHIVE-ON-READ:/.test(p), 'god briefing must carry the ARCHIVE-ON-READ rule');
  assert.ok(/to inbox\/\.done\/ IMMEDIATELY, before acting/.test(p));
  assert.ok(/stands down inside its grace window/.test(p));
  assert.ok(/card\/board carry the work state, not the inbox file/.test(p));
});

test('godLine carries the ATOMIC JSON WRITES rule', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/ATOMIC JSON WRITES:/.test(p), 'god briefing must carry the ATOMIC JSON WRITES rule');
  assert.ok(/direct writes to tasks\.json \(or any other shared hive JSON/.test(p));
  assert.ok(/tempfile in the SAME directory/.test(p));
  assert.ok(/os\.replace\(\)/.test(p));
});
