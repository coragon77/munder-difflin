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

const { autoParkDecisions, autoParkReason, AUTO_PARK_IDLE_MS, AUTO_PARK_SWEEP_MS } =
  loadTs('src/main/autoPark.ts');

const done = (id) => ({ id, status: 'done' });
const idle = (over) => AUTO_PARK_IDLE_MS + over;

test('the horizons: 1h idle to park, 60s sweep cadence', () => {
  assert.equal(AUTO_PARK_IDLE_MS, 3_600_000);
  assert.equal(AUTO_PARK_SWEEP_MS, 60_000);
});

test('parks the Kelly shape: done evidence + long idle + drained + quiet', () => {
  const out = autoParkDecisions([
    {
      id: 'kelly',
      telemetryAgeMs: 4 * 3_600_000,
      inboxBacklog: 0,
      pendingBackgroundWork: 0,
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
  const mk = (age) => [{ id: 'a', telemetryAgeMs: age, cards: [done('c')] }];
  assert.equal(autoParkDecisions(mk(AUTO_PARK_IDLE_MS)).length, 1);
  assert.equal(autoParkDecisions(mk(AUTO_PARK_IDLE_MS - 1)).length, 0);
});

test('EVIDENCE GATE — idle time alone never parks: no card, no park', () => {
  assert.equal(
    autoParkDecisions([{ id: 'a', telemetryAgeMs: idle(0) }]).length,
    0,
    'no cards at all → no positive done evidence',
  );
  assert.equal(
    autoParkDecisions([{ id: 'a', telemetryAgeMs: idle(0), cards: [] }]).length,
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
        cards: [done('c1'), { id: 'c2', status }],
      },
    ]);
    assert.equal(out.length, 0, `a ${status} card must block the auto-park`);
  }
});

test('no telemetry row → cannot prove idle → no park (absence is ambiguous)', () => {
  assert.equal(
    autoParkDecisions([{ id: 'a', telemetryAgeMs: undefined, cards: [done('c')] }]).length,
    0,
  );
});

test('waiting ≠ idle: pending background work blocks', () => {
  const out = autoParkDecisions([
    { id: 'a', telemetryAgeMs: idle(0), pendingBackgroundWork: 1, cards: [done('c')] },
  ]);
  assert.equal(out.length, 0);
});

test('undrained inbox blocks (mail may be a dispatch god already dropped)', () => {
  const out = autoParkDecisions([
    { id: 'a', telemetryAgeMs: idle(0), inboxBacklog: 1, cards: [done('c')] },
  ]);
  assert.equal(out.length, 0);
});

test('never parked: god, intern, pinned, archived, vacation, retired', () => {
  const base = { telemetryAgeMs: idle(0), cards: [done('c')] };
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

test('mixed floor: only qualifying agents come back, in registry order', () => {
  const out = autoParkDecisions([
    { id: 'busy', telemetryAgeMs: 5_000, cards: [done('c')] }, // working now
    { id: 'kelly', telemetryAgeMs: idle(0), cards: [done('c')] },
    { id: 'pinned', telemetryAgeMs: idle(0), pinned: true, cards: [done('c')] },
    { id: 'todo-holder', telemetryAgeMs: idle(0), cards: [{ id: 'c', status: 'todo' }] },
    { id: 'ada', telemetryAgeMs: idle(0), cards: [done('c1'), done('c2')] },
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
  const tick = src.slice(src.indexOf('async function ephemeralWorkerTick'));
  assert.match(tick, /autoParkSweep\(\)/, 'the tick calls the sweep');
  assert.match(
    src,
    /AUTO_PARK_SWEEP_MS/,
    'the sweep is throttled by the exported cadence constant',
  );
});

test('WIRING: the sweep parks through parkAgent with the auto origin and informs god', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const sweep = src.slice(src.indexOf('function autoParkSweep'));
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
});

test('WIRING: autoParkIdle defaults ON for existing installs too', () => {
  // DEFAULTS is module-private; the heartbeat test pins config the same way.
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'config.ts'), 'utf8');
  const defaults = src.slice(src.indexOf('const DEFAULTS'));
  assert.match(defaults, /autoParkIdle: true/, 'DEFAULTS carries autoParkIdle: true');
});

test('WIRING: ParkOrigin carries the auto member (shared refusal ladder, honest logs)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'vacationFlow.ts'), 'utf8');
  assert.match(src, /'operator' \| 'request' \| 'auto'/);
});
