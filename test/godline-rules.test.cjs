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
 *    named plus the detached alternative); a restart-window merge runs via
 *    the harness-generated detached CLI armed BEFORE the close (god's pane
 *    dies with the harness), verified by log/state after reboot;
 *    main-process/test-only branches merge immediately; push+restart together
 *    (hardened by card agent-lean-mode-worker-pushes--2026-08-18).
 *  - DISPATCH INTERFACE — god uses hive-dispatch for guarded card creation
 *    or adoption, assignment, recall, doing flip, and contract mail; the
 *    hand-primitives are only the documented fallback.
 *  - INBOX INTERFACE — god uses hive-inbox drain to print and archive mail
 *    in one pass; hand-moving JSON to inbox/.done/ is only the documented
 *    fallback. The card/board carry work state, not the inbox file.
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

const { HiveManager, hiveRootAgentsMd } = loadTs('src/main/hive.ts');

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
  assert.ok(/detached watcher BEFORE the close/.test(p));
  assert.ok(/hive-restart-window/.test(p), 'must name the durable harness-owned CLI');
  assert.ok(/fast-forwards the clean live checkout to origin\/main first/.test(p));
  assert.ok(/REFUSES a target that went stale/.test(p), 'silent divergence becomes a refusal');
  assert.ok(/restart-merge\.log/.test(p));
  assert.ok(/status/.test(p), 'published restart-window state is inspectable');
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
  assert.ok(/rebase\/cherry-pick onto the batch tip and re-gate/.test(p));
  assert.ok(/hive-restart-window.{0,100}retarget <target-sha>/.test(p));
  assert.ok(/stops only the recorded PID and relaunches its replacement/.test(p));
  assert.ok(/never use ps, pgrep, pkill, or a hand-written script/.test(p));
  assert.ok(/Worker pushes MAY advance origin\/main while a watcher is armed/.test(p));
});

test('godLine teaches renderer watcher refusal modes and recovery', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/WATCHER CAN REFUSE:/.test(p));
  assert.ok(/dirty tracked worktree/.test(p));
  assert.ok(/HEAD is not on main/.test(p));
  assert.ok(/TARGET stopped containing origin\/main/.test(p));
  assert.ok(/window missed.{0,40}<2s process blip/.test(p));
  assert.ok(
    /ALWAYS read restart-merge\.log or run the CLI with `status` after reboot before reporting anything as landed/.test(
      p,
    ),
  );
  assert.ok(/re-arm if it refused/.test(p));
});

test('godLine teaches hive-dispatch as the guarded dispatch interface', () => {
  const prompt = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/DISPATCH INTERFACE:/.test(prompt), 'the guarded dispatch interface is named');
  assert.ok(/\$HIVE_ROOT\/bin\/hive-dispatch/.test(prompt), 'names the dispatch CLI');
  assert.ok(
    /give exactly one of --card <existing-id> or --title <new-title>/.test(prompt),
    'requires exactly one card selector',
  );
  assert.ok(/--assignee/.test(prompt), 'names the assignee flag');
  assert.ok(/--adopt/.test(prompt), 'names the connected-engagement flag');
  assert.ok(/--body[^.]+stdin/.test(prompt), 'accepts the contract by flag or stdin');
  assert.ok(
    /\(1\) OBJECTIVE[\s\S]{0,3000}\(2\) OUTPUT[\s\S]{0,3000}\(3\) TOOLS[\s\S]{0,3000}\(4\) BOUNDARIES/.test(
      prompt,
    ),
    'preserves the 4-part dispatch contract without owning the TOOLS wording',
  );
  assert.ok(
    /creates or adopts and assigns the card, recalls a parked assignee, flips it to doing, and mails the contract/.test(
      prompt,
    ),
    'teaches the guarded create/adopt, assign, recall, doing, and mail flow',
  );
  assert.ok(
    /REFUSES[^.]+DIFFERENT[^.]+doing\/blocked card/.test(prompt),
    'teaches the conflicting-card guard',
  );
  assert.ok(
    /vacation-requests\/, hive-card, and hive-mail[^.]+FALLBACK/.test(prompt),
    'manual dispatch primitives are demoted to fallback',
  );
  assert.ok(
    !/hive-card status <id> doing/.test(prompt),
    'the old manual doing-flip command is gone',
  );
});

test('godLine teaches hive-inbox drain as the archive-on-read interface', () => {
  const prompt = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/INBOX INTERFACE:/.test(prompt), 'the inbox interface is named');
  assert.ok(/\$HIVE_ROOT\/bin\/hive-inbox drain/.test(prompt), 'names the drain command');
  assert.ok(
    /prints[^.]+archives[^.]+inbox\/\.done\//.test(prompt),
    'drain prints and archives in one pass',
  );
  assert.ok(/--agent <id>/.test(prompt), 'god can target another inbox');
  assert.ok(
    /Hand-reading[\s\S]{0,200}MANUAL FALLBACK/.test(prompt),
    'hand archiving is only the fallback',
  );
  assert.ok(
    /card\/board carry the work state, not the inbox file/.test(prompt),
    'archive-on-read does not replace the work ledger',
  );
  assert.ok(!/ARCHIVE-ON-READ:/.test(prompt), 'the old hand-archive instruction is gone');
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
  assert.ok(/Fresh is the default when --adopt is omitted/.test(p), 'names the fresh default');
  assert.ok(/--adopt/.test(p), 'names the adopt flag');
  assert.ok(
    /connected to the agent's CURRENT/.test(p) || /CONNECTED/.test(p),
    'defines when to adopt: a connected/running engagement',
  );
  assert.ok(
    /hive-dispatch --card <id> --assignee <agent> --adopt --body <contract>/.test(p),
    'gives the exact guarded dispatch command',
  );
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

// ── BREADTH-FIRST FLOOR SATURATION (card agent-anchor-breadth-first-flo-2026-08-18)
//
// Operator directive 2026-08-18: floorMaxAgents is a TARGET, not a ceiling —
// fill free seats in one pass (idle floor agent → recalled vacationer →
// interns for the surplus), release aggressively (reclaim, never queue), and
// saturate ONLY the actionable pool — blocked/paused cards are the operator's
// decisions, not idle capacity. Amendment 1 names the three anti-patterns god
// committed hours before the directive; amendment 2 keeps the parking gate
// un-weakened; amendment 3 is the guard on the fill rule.

test('godLine carries the BREADTH-FIRST FLOOR SATURATION rule', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/BREADTH-FIRST FLOOR SATURATION:/.test(p), 'the rule must be named');
  assert.ok(/TARGET, not a ceiling/.test(p), 'the cap is reframed as a target');
  assert.ok(/FILL THE FREE SEATS/.test(p), 'fill, immediately');
  assert.ok(/in ONE pass/.test(p), 'one pass, not one agent at a time');
  assert.ok(/FAILURE of orchestration/.test(p), 'an under-filled floor is a failure');
  assert.ok(
    /free seats > 0.{0,200}unowned.{0,40}actionable|unowned.{0,40}actionable.{0,80}free seats/.test(
      p,
    ),
    'the standup anomaly is stated: free seats beside unowned actionable cards',
  );
  // stale FLOOR CAP tail contradicted the reclaim duty
  assert.ok(
    !/queue the card until one opens/.test(p),
    'FLOOR CAP no longer tells god to queue for a seat',
  );
});

test('saturation names the three anti-patterns and the only legitimate hold', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/RECALL-POOL-AS-CEILING/.test(p), 'anti-pattern 1: recall pool is not the ceiling');
  assert.ok(
    /SERIALIZING-FOR-CONFLICT-AVOIDANCE/.test(p),
    'anti-pattern 2: same-region edits are a rebase, not a dependency',
  );
  assert.ok(/BEST-OWNER HOARDING/.test(p), 'anti-pattern 3: no holding cards for specialists');
  assert.ok(
    /ONLY legitimate hold is a REAL ticket dependency/.test(p),
    'holds require a real dependency',
  );
  assert.ok(
    /are not dependencies/.test(p),
    '"might conflict" / "X would do it better" are refused as holds',
  );
});

test('saturation release half: RECLAIM a seat, parking gate un-weakened', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/SEAT RECLAIM:/.test(p), 'the reclaim rule must be named');
  assert.ok(/do NOT queue and wait/.test(p), 'a needed seat is reclaimed, never queued for');
  assert.ok(
    /fire an intern whose whole engagement is verifiably done/.test(p),
    'reclaim step 1: fire done interns first',
  );
  assert.ok(/park an idle human-created hire/.test(p), 'reclaim step 2: park idle hires');
  assert.ok(
    /ping the idle candidates and park on confirmation/.test(p),
    'reclaim step 3: no evidence → ping first',
  );
  assert.ok(
    /idle time alone is never sufficient/.test(p),
    'the parking gate is restated, not weakened',
  );
  assert.ok(/PINNED/.test(p) && /NEVER reclaimed/.test(p), 'pinned agents + god are exempt');
  assert.ok(
    /PROACTIVELY at every standup/.test(p),
    'release happens at standups, not only under pressure',
  );
});

test('saturation guard: ACTIONABLE pool only, blocked/paused are decisions', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/SATURATION APPLIES TO THE ACTIONABLE POOL ONLY/.test(p), 'the guard is named');
  assert.ok(
    /ACTIONABLE POOL ONLY:[\s\S]{0,600}never un-block, un-pause/.test(p),
    'the guard rides the fill rule and forbids revisiting operator decisions',
  );
  assert.ok(
    /SAY SO in one line and wait for the go|say so in one line and wait for the go/i.test(p),
    'a maybe-actionable card goes to the operator, not the floor',
  );
  assert.ok(
    /only blocked\/paused cards left is CORRECT/.test(p),
    'an empty-looking floor of blocked/paused cards needs no action',
  );
});

test('HIVE_ROOT_AGENTS_MD floor cap is a target and reclaims instead of queueing', () => {
  const md = hiveRootAgentsMd(false);
  assert.ok(/TARGET, not a ceiling/.test(md), 'the engine-neutral cap text reframes the cap');
  assert.ok(
    !/queue the card until one opens/.test(md),
    'the root AGENTS.md no longer tells god to queue for a seat',
  );
  assert.ok(/RECLAIM/.test(md), 'reclaim-on-demand is stated');
  assert.ok(
    /parking gate.{0,80}un-weakened|un-weakened.{0,80}parking gate/i.test(md),
    'the reclaim text defers to the parking gate',
  );
  assert.ok(/NOT saturation fuel/.test(md), 'blocked/paused cards are excluded from the fill pool');
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
