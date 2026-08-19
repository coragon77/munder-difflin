'use strict';

/**
 * Auto-park (card agent-auto-park-idle-agents-th-2026-08-19).
 *
 * Live bug: the auto-park rule existed only as PROSE in god's instructions —
 * it ran when god remembered. Kelly reported done at 18:25, her branch landed
 * at 18:32, and she held a floor seat for ~4h until the operator asked. Worse,
 * the standup SKIPS ITSELF on a quiet floor — quiet being exactly the state
 * idle agents accumulate in — so any standup-hosted check inherits the hole.
 *
 * The fix: a stateless sweep inside the ephemeral-worker watcher tick (the
 * 1.5s always-on loop that processes spawn/fire/vacation requests — it has NO
 * quiet predicate), gated by the EVIDENCE RULE: idle time alone never parks.
 * The machine-readable done-report is the DONE CARD — the agent's own flip of
 * its engagement card to done through the sanctioned primitive — made
 * STRICTER than the prose rule (an assigned todo also blocks: parking an
 * agent god just carded only to auto-recall it on dispatch is churn).
 *
 * The pure decision lives here (vacationBusy precedent — index.ts is the
 * Electron main entry and untestable from this harness). The wiring half is
 * pinned by source regexes below: the heartbeat card (agent-delete-the-floor-
 * heartbeat) deleted a configured mechanism that never fired — a sweep that
 * silently loses its tick call is exactly that shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  autoParkDecisions,
  autoParkReason,
  cardsByAssignee,
  evidencePruned,
  AUTO_PARK_IDLE_MS,
  AUTO_PARK_SWEEP_MS,
  AUTO_PARK_DONE_RECENT_MS,
} = loadTs('src/main/autoPark.ts');

// doneAt stamped 5 minutes ago: comfortably inside idle+slack for every
// test that expects a park (the freshness rule, god amendment 1).
const done = (id, ageMs = 5 * 60_000) => ({
  id,
  status: 'done',
  doneAt: new Date(Date.now() - ageMs).toISOString(),
});
const idle = (over) => AUTO_PARK_IDLE_MS + over;
/** The provably-clean counts — explicit 0s, because the hardened gate reads
 *  an ABSENT count as unknown (fail closed), not as zero. */
const DRAINED = { inboxBacklog: 0, pendingBackgroundWork: 0 };

test('the horizons: 1h idle to park, 60s sweep cadence', () => {
  assert.equal(AUTO_PARK_IDLE_MS, 3_600_000);
  assert.equal(AUTO_PARK_SWEEP_MS, 60_000);
});

test('parks the Kelly shape: done evidence + long idle + drained + quiet', () => {
  const out = autoParkDecisions([
    {
      id: 'kelly',
      telemetryAgeMs: 4 * 3_600_000,
      ...DRAINED,
      cards: [done('c-branch-landed')],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'kelly');
  assert.equal(out[0].idleMs, 4 * 3_600_000);
});

test('evidence names the done cards; the reason states every gate input', () => {
  const [d] = autoParkDecisions([
    {
      id: 'kelly',
      telemetryAgeMs: idle(1000),
      ...DRAINED,
      cards: [done('c1'), done('c2')],
    },
  ]);
  assert.match(d.evidence, /\bc1\b/);
  assert.match(d.evidence, /\bc2\b/);
  const r = autoParkReason(d);
  assert.match(r, /auto-park/);
  assert.match(r, /idle \d+m/);
  assert.match(r, /c1.*c2|c2.*c1/s);
  assert.match(r, /inbox drained/);
});

test('the idle edge: exactly 1h parks, one ms less does not', () => {
  const mk = (age) => [{ id: 'a', telemetryAgeMs: age, ...DRAINED, cards: [done('c')] }];
  assert.equal(autoParkDecisions(mk(AUTO_PARK_IDLE_MS)).length, 1);
  assert.equal(autoParkDecisions(mk(AUTO_PARK_IDLE_MS - 1)).length, 0);
});

test('EVIDENCE GATE — idle time alone never parks: no card, no park', () => {
  assert.equal(
    autoParkDecisions([{ id: 'a', telemetryAgeMs: idle(0), ...DRAINED }]).length,
    0,
    'no cards at all → no positive done evidence',
  );
  assert.equal(
    autoParkDecisions([{ id: 'a', telemetryAgeMs: idle(0), ...DRAINED, cards: [] }]).length,
    0,
    'empty card list → no evidence',
  );
});

test('any NON-done assigned card blocks (stronger than the prose doing/blocked rule)', () => {
  for (const status of ['doing', 'blocked', 'todo']) {
    const out = autoParkDecisions([
      {
        id: 'a',
        telemetryAgeMs: idle(0),
        ...DRAINED,
        cards: [done('c1'), { id: 'c2', status }],
      },
    ]);
    assert.equal(out.length, 0, `a ${status} card must block the auto-park`);
  }
});

test('no telemetry row → cannot prove idle → no park (absence is ambiguous)', () => {
  assert.equal(
    autoParkDecisions([{ id: 'a', telemetryAgeMs: undefined, ...DRAINED, cards: [done('c')] }])
      .length,
    0,
  );
});

test('waiting ≠ idle: pending background work blocks', () => {
  const out = autoParkDecisions([
    {
      id: 'a',
      telemetryAgeMs: idle(0),
      ...DRAINED,
      pendingBackgroundWork: 1,
      cards: [done('c')],
    },
  ]);
  assert.equal(out.length, 0);
});

test('undrained inbox blocks (mail may be a dispatch god already dropped)', () => {
  const out = autoParkDecisions([
    { id: 'a', telemetryAgeMs: idle(0), ...DRAINED, inboxBacklog: 1, cards: [done('c')] },
  ]);
  assert.equal(out.length, 0);
});

test('never parked: god, intern, pinned, archived, vacation, retired', () => {
  const base = { telemetryAgeMs: idle(0), ...DRAINED, cards: [done('c')] };
  const cases = [
    { isGod: true },
    { role: 'intern' },
    { pinned: true },
    { archived: true },
    { vacation: true },
    { retired: true },
  ];
  for (const extra of cases) {
    assert.equal(autoParkDecisions([{ id: 'a', ...base, ...extra }]).length, 0);
  }
});

test('RECENCY (god amendment 1): a done card from hours before uncarded work is NOT evidence', () => {
  // The exact scenario god named: done flip at 10:00, uncarded discussion all
  // evening, idle 1h — the flip is 12h old, far outside idle+slack.
  const stale = [
    { id: 'a', telemetryAgeMs: idle(0), ...DRAINED, cards: [done('c', 12 * 3_600_000)] },
  ];
  assert.equal(autoParkDecisions(stale).length, 0, 'a 12h-old done flip must not park');
  // The Kelly shape: flip 10min before idle started — inside idle+slack.
  const fresh = [{ id: 'a', telemetryAgeMs: idle(0), ...DRAINED, cards: [done('c', 3_700_000)] }];
  assert.equal(autoParkDecisions(fresh).length, 1, 'a flip ~1h before the sweep parks');
  // The edge: flip exactly at idle+slack old still parks; one ms older does
  // not — the window is idleMs + AUTO_PARK_DONE_RECENT_MS (2h for a 1h idle).
  const WINDOW = AUTO_PARK_IDLE_MS + AUTO_PARK_DONE_RECENT_MS;
  const edge = (over) => [
    { id: 'a', telemetryAgeMs: idle(0), ...DRAINED, cards: [done('c', WINDOW + over)] },
  ];
  assert.equal(autoParkDecisions(edge(1)).length, 0);
  assert.equal(autoParkDecisions(edge(0)).length, 1);
  // A MISSING doneAt (cards done before the stamp existed) = UNKNOWN flip
  // time: fails closed — the rule reads exactly as strong as it is.
  const unstamped = [
    { id: 'a', telemetryAgeMs: idle(0), ...DRAINED, cards: [{ id: 'c', status: 'done' }] },
  ];
  assert.equal(autoParkDecisions(unstamped).length, 0, 'unstamped done cards are not evidence');
  // Unparseable doneAt is the same as missing.
  const junk = [
    {
      id: 'a',
      telemetryAgeMs: idle(0),
      ...DRAINED,
      cards: [{ id: 'c', status: 'done', doneAt: 'garbage' }],
    },
  ];
  assert.equal(autoParkDecisions(junk).length, 0);
  // Mixed: an old unstamped card + a fresh stamped one — the freshest wins.
  const mixed = [
    {
      id: 'a',
      telemetryAgeMs: idle(0),
      ...DRAINED,
      cards: [{ id: 'old', status: 'done' }, done('new', 3_700_000)],
    },
  ];
  assert.equal(autoParkDecisions(mixed).length, 1);
});

test('POST-PRUNE sentinel (god amendment 2): the gate says so when it can never fire', () => {
  const parkable = { id: 'a', telemetryAgeMs: idle(0), ...DRAINED, cards: [] };
  // No done cards anywhere + an otherwise-parkable agent => pruned signature.
  assert.equal(evidencePruned([parkable], []), true);
  // A done card ANYWHERE on the floor means evidence CAN exist => not pruned.
  assert.equal(evidencePruned([parkable, { ...parkable, id: 'b', cards: [done('c')] }], []), false);
  // A park landed => the gate works => never say pruned.
  assert.equal(evidencePruned([parkable], [{ id: 'a', idleMs: 1, evidence: 'c' }]), false);
  // Nobody otherwise-parkable (all busy/pinned/backlogged) => quiet, not pruned.
  assert.equal(
    evidencePruned([{ id: 'a', telemetryAgeMs: 5_000, ...DRAINED, cards: [] }], []),
    false,
  );
  assert.equal(evidencePruned([{ ...parkable, pinned: true }], []), false);
  assert.equal(evidencePruned([{ ...parkable, inboxBacklog: 2 }], []), false);
});

test('malformed input fails CLOSED (review finding 2) — junk never parks', () => {
  const base = { ...DRAINED, cards: [done('c')] };
  // NaN / Infinity / negative idle ages are UNKNOWN, not ancient
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(
      autoParkDecisions([{ id: 'a', ...base, telemetryAgeMs: bad }]).length,
      0,
      `telemetryAgeMs ${bad} must not park`,
    );
  }
  // junk backlog / pending-work counts are unknown ≠ drained/idle
  for (const bad of [Number.NaN, -1, 2.5]) {
    assert.equal(
      autoParkDecisions([{ id: 'a', ...base, telemetryAgeMs: idle(0), inboxBacklog: bad }]).length,
      0,
    );
    assert.equal(
      autoParkDecisions([{ id: 'a', ...base, telemetryAgeMs: idle(0), pendingBackgroundWork: bad }])
        .length,
      0,
    );
  }
  // a non-array card list is no evidence, never a crash
  assert.equal(
    autoParkDecisions([{ id: 'a', telemetryAgeMs: idle(0), cards: { length: 1 } }]).length,
    0,
  );
});

test('mixed floor: only qualifying agents come back, in registry order', () => {
  const out = autoParkDecisions([
    { id: 'busy', telemetryAgeMs: 5_000, ...DRAINED, cards: [done('c')] }, // working now
    { id: 'kelly', telemetryAgeMs: idle(0), ...DRAINED, cards: [done('c')] },
    { id: 'pinned', telemetryAgeMs: idle(0), ...DRAINED, pinned: true, cards: [done('c')] },
    {
      id: 'todo-holder',
      telemetryAgeMs: idle(0),
      ...DRAINED,
      cards: [{ id: 'c', status: 'todo' }],
    },
    { id: 'ada', telemetryAgeMs: idle(0), ...DRAINED, cards: [done('c1'), done('c2')] },
  ]);
  assert.deepEqual(
    out.map((d) => d.id),
    ['kelly', 'ada'],
  );
});

// ---------------------------------------------------------------------------
// Wiring pins — the anti-heartbeat half. index.ts cannot be loaded from this
// harness, so the source is asserted directly (focused-list precedent for
// source-scraping pins): a sweep that lost its tick call, its 'auto' origin,
// or its default-on config is the "configured mechanism that never fires"
// shape the heartbeat died of.
// ---------------------------------------------------------------------------

test('WIRING: the sweep is called from the always-on worker tick, throttled', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const tick = sliceFn(src, 'async function ephemeralWorkerTick');
  assert.match(tick, /autoParkSweep\(\)/, 'the tick calls the sweep');
  assert.match(
    src,
    /AUTO_PARK_SWEEP_MS/,
    'the sweep is throttled by the exported cadence constant',
  );
  // The tick itself must be BOOTED (review finding 4): the watcher start call
  // exists in the boot path, so the sweep cannot die with the machinery alive
  // but unwired (the heartbeat shape — configured, never firing).
  assert.match(
    src,
    /startEphemeralWorkerWatcher\(\);/,
    'the worker watcher (which owns the tick) is started at boot',
  );
});

/** Slice a function's source with an END bound at the next top-level
 *  declaration — an unbounded slice to EOF lets a finding anywhere downstream
 *  satisfy a pin meant for one function (review finding 4). */
function sliceFn(src, marker) {
  const start = src.indexOf(marker);
  const rest = src.indexOf('\nfunction ', start + marker.length);
  return src.slice(start, rest === -1 ? undefined : rest);
}

test('WIRING: the sweep parks through parkAgent with the auto origin and informs god', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const sweep = sliceFn(src, 'function autoParkSweep');
  assert.ok(sweep.length > 0, 'autoParkSweep found in index.ts');
  assert.match(sweep, /parkAgent\(/, 'parks through the shared parkAgent ladder');
  assert.match(sweep, /'auto'/, 'the park carries the auto origin');
  assert.match(sweep, /informGod\(/, 'god is informed on success (observability)');
  assert.match(sweep, /appendLog\(/, 'the park lands in log.jsonl');
  assert.match(sweep, /autoParkIdle === false/, 'config kill-switch, default-on');
  assert.match(
    sweep,
    /withLedgerLock/,
    'evidence read + park run inside the ledger lock — a doing-flip cannot interleave',
  );
  // The blocker's backstop (review finding 1): even a lock stolen mid-park
  // must not leave a doing/blocked holder parked — the sweep re-reads the
  // ledger after a park and recalls on a violation.
  assert.match(sweep, /auto_park_undone/, 'a raced park is logged as undone');
  assert.match(sweep, /recallAgent\(/, 'the raced agent is recalled immediately');
});

test('WIRING: autoParkIdle defaults ON for existing installs too', () => {
  // DEFAULTS is module-private; the heartbeat test pins config the same way.
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'config.ts'), 'utf8');
  const defaults = src.slice(src.indexOf('const DEFAULTS'));
  assert.match(defaults, /autoParkIdle: true/, 'DEFAULTS carries autoParkIdle: true');
});

test('WIRING: hive-dispatch re-reads vacation AFTER its doing-flip (the round-2 residual race)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  // The dispatch CLI must not trust its PRE-LOCK registry snapshot at the
  // recall decision point: a park that interleaved with the flip is only
  // visible in a fresh disk read. Without this, a doing holder can stay
  // parked with no recall — the exact hole review round 2 closed.
  // The pin proves ORDERING inside the DISPATCH template only (round 4:
  // a file-wide indexOf('writeLedger(data)') matched the FIRST call at
  // hive.ts:5970, not the dispatch write — a vacuous ordering proof).
  // Slice to the dispatch CLI's own source first, then compare indexes.
  const cli = src.slice(src.indexOf('const HIVE_DISPATCH_CLI'));
  const iFlip = cli.indexOf('writeLedger(data)');
  const iReread = cli.indexOf('const parkedNow =');
  assert.ok(iFlip >= 0, 'the dispatch template contains its ledger write');
  assert.ok(iReread > iFlip, 'the vacation re-read follows the doing-flip write');
  assert.match(
    src,
    /const reread = readRegistry\(\);\s*\n.*const parkedNow = \(\(reread && reread\.agents\[assignee\]\) \|\| entry\)\.vacation === true;/,
    'the re-read is null-guarded (readRegistry answers null on failure)',
  );
});

test('WIRING: benign-recall idempotence matches EXACT strings, not substrings (round 4)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  // The already-achieved check must be an exact equality against
  // recallAgentCore's own refusal strings — a substring regex would archive
  // any spawn error that happens to contain the phrase as a success.
  assert.match(
    src,
    /res\.error === `"\$\{agentId\}" is not on vacation — nothing to recall`/,
    'exact match: the not-on-vacation refusal',
  );
  assert.match(
    src,
    /res\.error === `"\$\{agentId\}" is already on the floor`/,
    'exact match: the already-on-floor refusal',
  );
  assert.doesNotMatch(
    src,
    /\/not on vacation\|already on the floor\//,
    'the loose substring regex is gone',
  );
});

test('WIRING: ParkOrigin carries the auto member (shared refusal ladder, honest logs)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'vacationFlow.ts'), 'utf8');
  assert.match(src, /'operator' \| 'request' \| 'auto'/);
});

test('cardsByAssignee reads BOTH ledger shapes and NEVER throws on junk (round 3)', () => {
  // The live round-2 bug: withLedgerLock's callback receives the task ARRAY,
  // but the sweep's inline helper read `.tasks` off it — undefined → zero
  // cards → no evidence → nobody EVER parked (dead mechanism, caught only by
  // review). This pin makes the shape contract executable; the junk cases pin
  // round 3's finding that `{tasks:{}}` threw at the for...of.
  const cards = [
    { id: 'c1', assignee: 'kelly', status: 'done' },
    { id: 'c2', assignee: 'kelly', status: 'doing' },
    { id: 'c3', assignee: 'ada', status: 'done' },
    { id: 'c4', status: 'todo' }, // unassigned — indexed nowhere
  ];
  // BARE array (withLedgerLock callback shape) and WRAPPER (hive.tasks())
  const fromArray = cardsByAssignee(cards);
  const fromWrapper = cardsByAssignee({ tasks: cards });
  for (const m of [fromArray, fromWrapper]) {
    // doneAt rides along (absent on these fixtures -> undefined own-property)
    assert.deepEqual(m.get('kelly'), [
      { id: 'c1', status: 'done', doneAt: undefined },
      { id: 'c2', status: 'doing', doneAt: undefined },
    ]);
    assert.deepEqual(m.get('ada'), [{ id: 'c3', status: 'done', doneAt: undefined }]);
    assert.equal(m.has('c4'), false);
  }
  // junk wrappers/rows are safely empty or skipped — never a throw
  assert.equal(cardsByAssignee(null).size, 0);
  assert.equal(cardsByAssignee({ tasks: {} }).size, 0);
  assert.equal(cardsByAssignee({ tasks: 'nope' }).size, 0);
  const junkRows = cardsByAssignee([
    { id: 'j1', assignee: 42, status: 'done' }, // non-string assignee
    'not-a-card',
    null,
    { id: 'j2', assignee: 'real', status: 'done' },
  ]);
  assert.deepEqual(junkRows.get('real'), [{ id: 'j2', status: 'done', doneAt: undefined }]);
  assert.equal(junkRows.size, 1);
});

test('BEHAVIOR: inboxBacklogStrict — missing .staged is 0, staged mail counts, unreadable is null', (t0) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(join(os.tmpdir(), 'md-autopark-'));
  t0.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  // inboxBacklogStrict is a pure filesystem read — the agent dir needs no
  // registry entry, just the inbox path itself.
  // HiveManager.root() nests a hive/ dir under the resolver's value — fixture
  // paths must nest under it (recorded lesson from card-scoped sessions).
  const inbox = join(home, 'hive', 'agents', 'w1', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  // The COMMON case: inbox with no .staged dir must be a true 0 — returning
  // null here would block every park forever (the heartbeat shape).
  assert.equal(hive.inboxBacklogStrict('w1'), 0);
  // Staged mail (undelivered dispatch contracts) counts as pending.
  fs.mkdirSync(join(inbox, '.staged'), { recursive: true });
  fs.writeFileSync(join(inbox, '.staged', 'm1.json'), '{}');
  assert.equal(hive.inboxBacklogStrict('w1'), 1);
  // Direct + staged both count.
  fs.writeFileSync(join(inbox, 'm2.json'), '{}');
  assert.equal(hive.inboxBacklogStrict('w1'), 2);
  // No inbox dir at all = no mail ever arrived = 0 (not null).
  assert.equal(hive.inboxBacklogStrict('nobody'), 0);
  // UNREADABLE inbox = null (unknown ≠ drained). A file where the inbox dir
  // should be makes readdir fail with ENOTDIR — deterministic on every
  // platform/privilege, unlike a chmod-000 dir (root reads through those).
  const w2inbox = join(home, 'hive', 'agents', 'w2', 'inbox');
  fs.mkdirSync(join(home, 'hive', 'agents', 'w2'), { recursive: true });
  fs.writeFileSync(w2inbox, 'not a dir');
  assert.equal(hive.inboxBacklogStrict('w2'), null);
});

test('BEHAVIOR: origin auto enforces the busy gate like a request (review finding 4)', () => {
  // The one rung where origins differ is the busy gate: the operator's button
  // skips it, everything else — including 'auto' — must respect it. Pinned
  // behaviorally on parkAgentCore itself, not by source regex.
  const { parkAgentCore } = loadTs('src/main/vacationFlow.ts');
  const mkDeps = (busy) => {
    const calls = [];
    return {
      calls,
      hiveEnabled: () => true,
      registry: () => ({ godId: 'god', agents: { w: { name: 'W' } } }),
      ptyForAgent: () => 'pty-1',
      busy: () => busy,
      dropWorktree: () => calls.push('dropWorktree'),
      killPty: () => calls.push('killPty'),
      teardownPty: () => calls.push('teardownPty'),
      setVacation: () => {
        calls.push('setVacation');
        return true;
      },
      appendLog: () => {},
      notifyVacationed: () => {},
      log: () => {},
      error: () => {},
    };
  };
  const busyDeps = mkDeps(true);
  const res = parkAgentCore(busyDeps, 'w', 'r', 'auto');
  assert.equal(res.ok, false);
  assert.equal(res.busy, true, 'a busy agent refuses the auto park as temporary');
  assert.deepEqual(busyDeps.calls, [], 'a busy refusal is a strict no-op — no teardown');
  const res2 = parkAgentCore(mkDeps(false), 'w', 'r', 'auto');
  assert.equal(res2.ok, true, 'an idle agent parks under origin auto');
});
