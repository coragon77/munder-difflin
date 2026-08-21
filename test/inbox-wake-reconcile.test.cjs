'use strict';

/**
 * Nudge reconciler (card agent-nudge-is-edge-triggered--2026-08-21).
 *
 * The old nudge was edge-triggered: `nudged` advanced at ENQUEUE and reset
 * only when the inbox read empty, so any queue exit that never reached the
 * pane (3 failed pty writes, clear-queue, delivered-but-swallowed) silenced
 * the agent forever — the 57-minute Robert incident. The reconciler decides
 * from observable state every tick: mail still in inbox/, a nudge in the
 * queue, or a DELIVERED nudge inside the TTL. Pins:
 *   1. strand-and-recover: after an unsafe exit (no delivery recorded, queue
 *      empty, mail still there) the next tick re-enqueues — forever, until
 *      delivery or drain;
 *   2. drained inbox stops re-nudging and clears state;
 *   3. a delivered nudge suppresses re-nudge inside the TTL and re-nudges the
 *      SAME id past it (Cause A: ack is not receipt) WITHOUT a fresh grace;
 *   4. grace stays keyed to first-seen of a NEW id (monitor head start);
 *   5. one nudge in flight at a time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { decideInboxWake, RENUDGE_TTL_MS } = loadTs('src/shared/inboxWake.ts');

const T0 = 1_000_000_000_000;
const MAIL = '2026-08-21T11-00-00-000Z-abc123';

// — strand and recover —

test('unsafe exit then next tick: mail still unread, nothing delivered -> re-enqueue', () => {
  // Tick N enqueued a nudge; it then died in an unsafe exit (3 failed pty
  // writes / clear-queue / swallowed): no delivery record, queue empty again,
  // mail still in inbox/. The OLD edge-trigger never fired again here.
  const wakeSeen = { id: MAIL, since: T0 };
  for (const now of [T0 + 60_000, T0 + 120_000, T0 + 10 * 60_000]) {
    const d = decideInboxWake({
      newest: MAIL,
      nudgeInQueue: false,
      graceMs: 45_000,
      now,
      lastDelivery: undefined,
      wakeSeen,
    });
    assert.equal(d.enqueue, true, `tick at +${now - T0}ms must re-enqueue`);
    assert.equal(d.reason, 'unread');
  }
});

test('a NEWER mail id also breaks the strand (fresh id path)', () => {
  const newer = '2026-08-21T12-00-00-000Z-def456';
  const d = decideInboxWake({
    newest: newer,
    nudgeInQueue: false,
    graceMs: 0, // provider without a monitor
    now: T0 + 60_000,
    lastDelivery: { id: MAIL, at: T0 },
    wakeSeen: { id: MAIL, since: T0 },
  });
  assert.equal(d.enqueue, true);
  assert.equal(d.wakeSeen.id, newer, 'grace clock restarts for the new id');
});

// — drained inbox stops re-nudging —

test('inbox drained: no enqueue, wakeSeen cleared, delivery record irrelevant', () => {
  const d = decideInboxWake({
    newest: '',
    nudgeInQueue: false,
    graceMs: 45_000,
    now: T0 + 60_000,
    lastDelivery: { id: MAIL, at: T0 },
    wakeSeen: { id: MAIL, since: T0 },
  });
  assert.equal(d.enqueue, false);
  assert.equal(d.reason, 'empty');
  assert.equal(d.wakeSeen, undefined, 'caller clears first-seen state');
});

// — delivered within TTL stays quiet; past TTL re-nudges the SAME id —

test('delivered nudge suppresses re-nudge inside the TTL', () => {
  const d = decideInboxWake({
    newest: MAIL,
    nudgeInQueue: false,
    graceMs: 45_000,
    now: T0 + RENUDGE_TTL_MS - 1_000,
    lastDelivery: { id: MAIL, at: T0 },
    wakeSeen: { id: MAIL, since: T0 - 45_000 },
  });
  assert.equal(d.enqueue, false);
  assert.equal(d.reason, 'recently-delivered');
});

test('past the TTL the SAME unread id re-nudges WITHOUT a fresh grace (Cause A)', () => {
  const d = decideInboxWake({
    newest: MAIL,
    nudgeInQueue: false,
    graceMs: 45_000, // monitor provider — but grace must NOT apply to a TTL re-nudge
    now: T0 + RENUDGE_TTL_MS + 1_000,
    lastDelivery: { id: MAIL, at: T0 },
    wakeSeen: { id: MAIL, since: T0 - 45_000 },
  });
  assert.equal(d.enqueue, true, 'swallowed delivery self-heals after the TTL');
  assert.equal(d.reason, 'unread');
});

test('TTL is in the 5-10 min band Mose specified', () => {
  assert.ok(RENUDGE_TTL_MS >= 5 * 60_000 && RENUDGE_TTL_MS <= 10 * 60_000);
});

// — grace stays keyed to first-seen of a NEW id —

test('fresh id inside grace: hold, and first-seen is recorded for the caller', () => {
  const d = decideInboxWake({
    newest: MAIL,
    nudgeInQueue: false,
    graceMs: 45_000,
    now: T0,
    lastDelivery: undefined,
    wakeSeen: undefined,
  });
  assert.equal(d.enqueue, false);
  assert.equal(d.reason, 'grace');
  assert.deepEqual(d.wakeSeen, { id: MAIL, since: T0 });
});

test('fresh id past grace enqueues; grace is NOT re-armed on later ticks for the same id', () => {
  const seen = { id: MAIL, since: T0 };
  const d1 = decideInboxWake({
    newest: MAIL,
    nudgeInQueue: false,
    graceMs: 45_000,
    now: T0 + 45_001,
    wakeSeen: seen,
  });
  assert.equal(d1.enqueue, true);
  // Still no delivery (busy pane), later tick: no second grace window.
  const d2 = decideInboxWake({
    newest: MAIL,
    nudgeInQueue: false,
    graceMs: 45_000,
    now: T0 + 46_000,
    wakeSeen: d1.wakeSeen,
  });
  assert.equal(d2.enqueue, true);
});

// — one nudge in flight —

test('a nudge already in the queue blocks a duplicate enqueue', () => {
  const d = decideInboxWake({
    newest: MAIL,
    nudgeInQueue: true,
    graceMs: 0,
    now: T0 + 60_000,
    wakeSeen: { id: MAIL, since: T0 },
  });
  assert.equal(d.enqueue, false);
  assert.equal(d.reason, 'in-flight');
});

// — reviewer round: two pins the first pass missed —

test('a NEWER id inside the delivered-TTL still gets the fresh-id monitor grace', () => {
  const newer = '2026-08-21T12-00-00-000Z-def456';
  const d = decideInboxWake({
    newest: newer,
    nudgeInQueue: false,
    graceMs: 45_000,
    now: T0 + 10_000, // well inside the TTL of the older delivery
    lastDelivery: { id: MAIL, at: T0 },
    wakeSeen: { id: MAIL, since: T0 - 45_000 },
  });
  assert.equal(d.enqueue, false, 'new id is fresh, monitor gets its head start');
  assert.equal(d.reason, 'grace');
  assert.deepEqual(d.wakeSeen, { id: newer, since: T0 + 10_000 });
});

test('in-flight hold preserves the first-seen wakeSeen object', () => {
  const seen = { id: MAIL, since: T0 };
  const d = decideInboxWake({
    newest: MAIL,
    nudgeInQueue: true,
    graceMs: 0,
    now: T0 + 60_000,
    wakeSeen: seen,
  });
  assert.equal(d.enqueue, false);
  assert.equal(d.reason, 'in-flight');
  assert.equal(d.wakeSeen, seen, 'first-seen clock must not restart while queued');
});

// — wiring pin: the hook actually runs the reconciler —

const fs = require('node:fs');
const path = require('node:path');
const hookSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src/renderer/src/hooks/useHive.ts'),
  'utf8',
);

test('effect #3 decides via decideInboxWake and no longer advances `nudged` at enqueue', () => {
  assert.ok(hookSrc.includes('decideInboxWake('), 'reconciler must drive the nudge tick');
  assert.ok(!hookSrc.includes('nudged.current[a.id] = newest'), 'enqueue-time advance is gone');
  assert.ok(!/nudged\.current\[a\.id\] = ''/.test(hookSrc), 'string reset is gone');
});

test('effect #4 records the delivery in the ack path and logs the lifecycle', () => {
  assert.ok(/nudged\.current\[target\.id\] = \{ id: next\.inboxFor/.test(hookSrc));
  for (const kind of ['nudge_enqueued', 'nudge_delivered', 'nudge_dropped']) {
    assert.ok(hookSrc.includes(kind), `${kind} lifecycle log missing`);
  }
});
