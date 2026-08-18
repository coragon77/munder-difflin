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

test('godLine keeps one renderer watcher armed from the first verified branch', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/KEEP ONE ARMED: whenever ANY verified renderer\/preload branch is unmerged/.test(p));
  assert.ok(/arm on the first one; do not wait for the batch to feel complete/.test(p));
  assert.ok(/An unarmed window means a restart lands NOTHING/.test(p));
  assert.ok(
    /early arming is free because the watcher fires only when the harness process disappears/.test(
      p,
    ),
  );
});

test('godLine gives the renderer watcher retarget procedure', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/new main-bound work joins the ARMED watcher's batch/.test(p));
  assert.ok(/rebase\/cherry-pick onto the batch tip, re-gate, rewrite TARGET/.test(p));
  assert.ok(
    /kill the old PID \(verify with ps -p; pgrep -f self-matches the querying shell\)/.test(p),
  );
  assert.ok(/relaunch with setsid/.test(p));
  assert.ok(/NEVER advance main under an armed ff-watcher/.test(p));
});

test('godLine teaches renderer watcher refusal modes and recovery', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/WATCHER CAN REFUSE:/.test(p));
  assert.ok(/dirty tracked worktree/.test(p));
  assert.ok(/HEAD is not on main/.test(p));
  assert.ok(/TARGET is not a fast-forward/.test(p));
  assert.ok(/window missed.{0,40}<2s process blip/.test(p));
  assert.ok(
    /ALWAYS read restart-merge\.log after reboot before reporting anything as landed/.test(p),
  );
  assert.ok(/re-arm if it refused/.test(p));
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

test('godLine carries the INTERN SPRITES name->sprite rule', () => {
  // Card agent-harness-gendered-intern--2026-08-17 introduced gendered intern
  // sprites; card agent-harness-intern-portrait--2026-08-17 replaced the
  // Angela/Jim mapping with a pool hash: a FEMALE-coded name hashes onto the
  // female intern pool, any other name onto the male pool — name-stable, and
  // an intern never wears a hire-cast face by default. Harness rules live in
  // the harness: the rule must ride the shipped god briefing.
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/INTERN SPRITES/.test(p), 'the rule must be named');
  assert.ok(/hashes onto the female intern pool/.test(p), 'female-coded -> female pool');
  assert.ok(/onto the male pool/.test(p), 'every other name -> male pool');
  assert.ok(/same name always wears the same face/.test(p), 'the hash is name-stable');
  assert.ok(/never wears a hire-cast face/.test(p), 'interns get intern-only faces');
  assert.ok(/FEMALE_CODED_NAMES/.test(p), 'names the list constant');
  assert.ok(/INTERN_FEMALE_POOL/.test(p), 'names the pool constants');
  assert.ok(
    /src\/renderer\/src\/scene\/office\/spawnIdentity\.ts/.test(p),
    'points god at the source of the name list',
  );
  assert.ok(
    /pick the NAME of each intern to match the sprite/.test(p),
    'god picks the name to match the sprite he wants',
  );
  assert.ok(/All 25 faces/.test(p), 'the picker lists hires + interns');
  assert.ok(
    /registry-saved or operator icon pick always beats the mapping/.test(p),
    'operator pick still wins',
  );
  assert.ok(/always beats the mapping/.test(p), 'an explicit saved/operator pick wins');
});

// ── INBOX WAKE monitor command: seed + debounce + bundle ──────────────────
// (card agent-waiting-vs-idle-display--2026-08-17, operator addendum). The
// command every monitor-capable agent arms must (1) SEED prev with the
// current inbox listing BEFORE the loop — arming starts silent, killing the
// once-per-restart replay burst (pre-arm mail stays covered by the typed
// nudge), (2) DEBOUNCE — sleep 3 + rescan when new files appear so a
// near-simultaneous burst lands as ONE wake, (3) BUNDLE — one summary line
// 'new hive mail (N): <names>' per burst instead of a line per file. The
// system-FYI filter (inform from system senders never wakes anyone) must
// survive the rewrite. Source pin — the shell itself was verified live
// against a temp inbox (burst + straggler + FYI → exactly one bundled line).

const MONITOR_CMD_RE = /INBOX WAKE — .*\n\s+(.+)\n/s;

test('INBOX WAKE command seeds prev with the current listing before the loop', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  const cmd = MONITOR_CMD_RE.exec(p)?.[1] ?? '';
  assert.ok(cmd, 'the monitor command must be extractable from the briefing');
  assert.match(cmd, /prev=\$\(ls [^)]*inbox\/\*\.json 2>\/dev\/null\)/, 'prev is SEEDED');
  assert.doesNotMatch(cmd, /prev=""/, 'the unseeded empty-prev variant must be gone');
  // seed must precede the loop: index(order) in the one-liner
  assert.ok(
    cmd.indexOf('prev=$(ls') < cmd.indexOf('while true'),
    'seed happens BEFORE the poll loop starts',
  );
});

test('INBOX WAKE command debounces: sleep 3 + rescan before emitting', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  const cmd = MONITOR_CMD_RE.exec(p)?.[1] ?? '';
  assert.ok(cmd);
  assert.match(cmd, /sleep 3/, 'the debounce window exists');
  // the rescan (ls) between detection and emit: a second scan call
  assert.match(cmd, /scan; \[ -n "\$news" \] && \{ sleep 3; cur=\$\(ls/, 'rescan after the sleep');
});

test('INBOX WAKE command bundles: one summary line with count + names', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  const cmd = MONITOR_CMD_RE.exec(p)?.[1] ?? '';
  assert.ok(cmd);
  assert.match(cmd, /echo "new hive mail \(\$#\): \$news"/, 'count + names in ONE line');
  assert.doesNotMatch(cmd, /echo "new hive mail: /, 'per-file lines are gone');
  // exactly one mail echo in the whole command — a burst is never split
  // (the other `echo`s are the process-substitution feeds for comm, not output)
  assert.equal((cmd.match(/echo "new hive mail/g) ?? []).length, 1);
});

test('INBOX WAKE keeps the system-FYI filter across the rewrite', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  const cmd = MONITOR_CMD_RE.exec(p)?.[1] ?? '';
  assert.ok(cmd);
  assert.match(cmd, /'"act": \*"inform"'/, 'act-inform check survives');
  assert.match(
    cmd,
    /ephemeral-worker\|scheduler\|heartbeat\|breaker\|system/,
    'the system-sender list survives',
  );
  assert.match(p, /System FYI notices are skipped on purpose/, 'prose keeps the filter note');
});

// TOOLS clause of the 4-part dispatch contract (card
// agent-godline-tools-clause-inv-2026-08-18). Root incident: the old
// wording — "what to use or avoid, and any references to read instead of
// re-deriving" — invited god to list FILE PATHS, his own traversal; an
// expensive advisor then re-walked that path for 2.43M tokens while a
// graphify-out/ knowledge graph answered it with one query. The clause must
// name the objective + available INDEXES and leave the traversal to the
// worker — WITHOUT overcorrecting into "always graphify": graphs go stale,
// so line-precise cited claims still get a targeted read.
test('godLine TOOLS clause names INDEXES, not a reading list', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(
    /TOOLS — the objective's constraints and the INDEXES available/.test(p),
    'clause names the objective + the indexes instead of "what to use or avoid"',
  );
  assert.ok(/graphify-out\/ knowledge graph/.test(p), 'names the knowledge-graph index');
  assert.ok(/not a reading list/, 'says explicitly it is not a reading list');
  assert.ok(
    /let the worker pick the cheapest path to it/.test(p),
    'traversal choice belongs to the worker',
  );
  assert.ok(
    !/what to use or avoid, and any references to read instead of re-deriving/.test(p),
    'the path-prescribing wording is gone',
  );
});

test('godLine TOOLS clause keeps the graphify calibration', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/a graphify query beats a grep sweep/.test(p), 'index-over-sweep nudge');
  assert.ok(
    /re-walk a path you already paid for/.test(p),
    'names the double-cost anti-pattern (paying for exploration twice)',
  );
  // do not overcorrect into "always graphify": graphs are for orientation and
  // can be stale — line-precise cited claims still need a targeted read
  assert.ok(/ORIENTATION \(architecture, file relationships/.test(p), 'graph = orientation');
  assert.ok(/a graph can be stale/.test(p), 'staleness warning survives');
  assert.ok(
    /verify only the specific lines to be cited/.test(p),
    'correct dispatch shape: orient via graphify, then verify the cited lines',
  );
  assert.ok(
    /reserve file:line pointers for claims the worker must cite precisely/.test(p),
    'file:line pointers remain legal for precise citations',
  );
});
