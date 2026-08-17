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

test('godLine carries the HUMAN-CARD REFERENCE rule (no duplicate cards)', () => {
  // Card agent-harness-human-task-mail--2026-08-17: the tasks-tab assign flow
  // mails god a 'Task from the human' that now references its kanban card
  // (cardId field + body line) — god must enrich and assign THAT card, never
  // mint a twin (live incident: human-kampa-ticket-3216-2026-08-17 got a
  // god-made duplicate, since deleted).
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(
    /Task from the human.{0,400}cardId/.test(p),
    'god briefing must tie human task mail to its cardId',
  );
  assert.ok(
    /NEVER create a duplicate/.test(p) || /never mint a duplicate/.test(p),
    'must forbid duplicate cards for a referenced human card',
  );
  assert.ok(/hive-card update/.test(p), 'must name the enrichment tool (hive-card update)');
});

test('godLine carries the ENGAGEMENT-AWARE CARD FLIPS rule', () => {
  // Card agent-harness-engagement-aware-2026-08-17: --adopt for connected/
  // running engagements, fresh default, idle-gated clears, every card carries
  // a session. Root incident: a connected card's fresh flip wiped a working
  // pane (Kevin, 17:36).
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/ENGAGEMENT-AWARE CARD FLIPS:/.test(p), 'the rule must be named');
  assert.ok(
    /pass THROUGH doing/.test(p),
    'flips pass through doing so every card carries a session',
  );
  assert.ok(/todo->done|todo→done/.test(p), 'todo->done stays legal for externally-resolved cards');
  assert.ok(/--fresh/.test(p), 'names the fresh default');
  assert.ok(/--adopt/.test(p), 'names the adopt flag');
  assert.ok(
    /connected to the agent's CURRENT/.test(p) || /CONNECTED/.test(p),
    'defines when to adopt: a connected/running engagement',
  );
  assert.ok(/hive-card status <id> doing --adopt/.test(p), 'gives the exact command');
  assert.ok(
    /never fires the clear at a busy pane|never fire .{0,30}busy pane/.test(p),
    'states the idle-gated clear',
  );
  assert.ok(/NO clear|no clear/.test(p), "adopt keeps the pane's conversation");
});

test('godLine carries the ROUTING-MISMATCH CHALLENGE rule', () => {
  // Card agent-harness-godline-rule-cha-2026-08-17: before executing a
  // routing/assignment order, check the named agent against the target's
  // project/customer (registry cwd, card content); on mismatch ASK in plain
  // prose instead of silently complying. Root incident: the cover-abort
  // discussion was routed to Creed (HPT) though the finding was Stanley's
  // (Kampa). Operator directive: 'Please correct me next time if I mix up
  // the names.'
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/ROUTING-MISMATCH CHALLENGE:/.test(p), 'the rule must be named');
  assert.ok(/routing or assignment order/.test(p), 'covers routing and assignment orders');
  assert.ok(/registry\.json cwd/.test(p), 'names the evidence source (registry cwd)');
  assert.ok(/project\/customer/.test(p), "checks against the target's project/customer");
  assert.ok(/ASK in plain prose/.test(p), 'the mismatch response is a plain question');
  assert.ok(/instead of silently complying|rather than silently complying/.test(p));
  assert.ok(/Stanley/.test(p) || /instead\?/.test(p), 'shows the ask shape (name the right agent)');
});

test('godLine carries the PARALLEL-DISPATCH + FLOOR-CAP policy', () => {
  // Cards agent-harness-parallel-dispatc-2026-08-17 +
  // agent-harness-floormaxagents-s-2026-08-17: god's briefing must fan
  // independent cards out in parallel, treat interns as overflow (not a last
  // resort), serialize only on real dependencies, keep "one capable owner"
  // per-card, and know the floor cap that refuses over-cap spawns.
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/PARALLEL BY DEFAULT/.test(p), 'dispatch defaults to parallel');
  assert.ok(/AREA FAN-OUT/.test(p), 'must name the area fan-out rule');
  assert.ok(/one owner per card, parallel across cards/.test(p));
  assert.ok(/sequential ONLY on real ticket dependencies/.test(p));
  assert.ok(/INTERNS ARE THE OVERFLOW/.test(p), 'interns are overflow, not last resort');
  assert.ok(/overflow capacity, NOT a last resort/.test(p));
  assert.ok(
    /"One capable owner beats a duplicate" is PER-CARD ONLY/.test(p),
    'one-owner rule keeps only its per-card meaning',
  );
  assert.ok(/config floorMaxAgents/.test(p), 'rule text references the floorMaxAgents config');
  assert.ok(/REFUSES any spawn past the cap/.test(p), 'god knows the cap is enforced');
  assert.ok(/fleet\.json's floor block/.test(p), 'god is pointed at the live seat count');
});
