'use strict';

/**
 * whenQuiet parks — hold instead of reject (card agent-harness-park-when-quiet-2026-08-17).
 *
 * Before: a vacation-request naming an agent that is actively working was
 * REJECTED outright (mail to god's inbox, file archived to .failed) and god had
 * to retry later — four reject+retry loops in a single evening. Now a park
 * carrying `"whenQuiet": true` is HELD instead: the request file stays in
 * vacation-requests/ and the watcher retries it on every tick until the SAME
 * busy gate clears, then parks for real.
 *
 * The three pieces pinned here (index.ts's watcher is not loadable from this
 * harness — the reason vacationFlow.ts exists at all):
 *
 *   • parkAgentCore's busy rung now carries a `busy: true` discriminator, so the
 *     caller can tell "actively working" apart from every other refusal WITHOUT
 *     matching on the error prose.
 *   • vacationRequestTarget parses `whenQuiet` (strict true; anything else is
 *     false — backward compatible: a request without the flag is unchanged).
 *   • shouldHoldPark — the hold decision itself: park verb + flag + busy refusal.
 *
 * RESTART SAFETY: there is no new persistence layer. The watcher's state IS the
 * unarchived request file, so a held park survives an app restart for free (the
 * boot tick rescans vacation-requests/). See processVacationRequest in index.ts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parkAgentCore, vacationRequestTarget, shouldHoldPark } = loadTs('src/main/vacationFlow.ts');

// ─── harness (same shape as vacation-flow.test.cjs) ─────────────────────────

function parkDeps(over = {}) {
  const reg = {
    godId: 'michael',
    agents: {
      bob: {
        id: 'bob',
        name: 'Bob',
        status: 'idle',
        lastSeen: 0,
        cwd: '/floor/bob',
        role: 'worker',
        ...(over.bob ?? {}),
      },
    },
  };
  return {
    hiveEnabled: () => true,
    registry: () => reg,
    ptyForAgent: () => over.ptyId,
    busy: () => over.busy === true,
    dropWorktree: () => {},
    killPty: () => {},
    teardownPty: () => {},
    setVacation: () => true,
    appendLog: () => {},
    notifyVacationed: () => {},
    log: () => {},
    error: () => {},
  };
}

// ─── the busy discriminator ─────────────────────────────────────────────────

test('park: the busy refusal carries busy:true — callers need not match the prose', () => {
  const res = parkAgentCore(parkDeps({ ptyId: 'pty1', busy: true }), 'bob');
  assert.equal(res.ok, false);
  assert.equal(res.busy, true);
  // The message stays exactly what god has always read.
  assert.equal(res.error, '"bob" is actively working — park it when it goes quiet');
});

test('park: NO other refusal carries busy — only the busy rung is holdable', () => {
  // A held park must never mask a permanent refusal: pinned/intern/god/retired
  // stay immediate rejections no matter what flag the request carries.
  const cases = [
    parkDeps({ bob: { pinned: true }, ptyId: 'pty1', busy: true }),
    parkDeps({ bob: { role: 'intern' } }),
    parkDeps({ bob: { isGod: true } }),
    parkDeps({ bob: { retired: true } }),
    parkDeps({ bob: { vacation: true } }),
  ];
  for (const deps of cases) {
    const res = parkAgentCore(deps, 'bob');
    assert.equal(res.ok, false);
    assert.equal(res.busy, undefined, `refusal must not look busy: ${res.error}`);
  }
  // Unknown agent + hive disabled land before the registry lookup.
  assert.equal(parkAgentCore(parkDeps(), 'nobody').busy, undefined);
});

test('park: a successful park reports no busy field', () => {
  assert.deepEqual(parkAgentCore(parkDeps({ ptyId: 'pty1', busy: false }), 'bob'), { ok: true });
});

// ─── parsing whenQuiet ──────────────────────────────────────────────────────

test('request: whenQuiet parses as strict true; everything else is false', () => {
  assert.equal(vacationRequestTarget({ agentId: 'bob', whenQuiet: true }).whenQuiet, true);
  // Backward compatible: no flag = the old reject-immediately behavior.
  assert.equal(vacationRequestTarget({ agentId: 'bob' }).whenQuiet, false);
  assert.equal(vacationRequestTarget({ agentId: 'bob', whenQuiet: false }).whenQuiet, false);
  // Truthy-but-not-true stays false — a held park is an explicit opt-in, and
  // "true"/1 in hand-written JSON is likelier a mistake than an intent.
  assert.equal(vacationRequestTarget({ agentId: 'bob', whenQuiet: 'true' }).whenQuiet, false);
  assert.equal(vacationRequestTarget({ agentId: 'bob', whenQuiet: 1 }).whenQuiet, false);
});

test('request: whenQuiet rides alongside the existing fields, breaking none', () => {
  assert.deepEqual(vacationRequestTarget({ id: '  bob  ', reason: 'done', whenQuiet: true }), {
    ok: true,
    agentId: 'bob',
    recall: false,
    reason: 'done',
    whenQuiet: true,
  });
});

// ─── the hold decision ──────────────────────────────────────────────────────

test('hold: park + whenQuiet + busy refusal → HELD', () => {
  assert.equal(
    shouldHoldPark({ recall: false, whenQuiet: true }, { ok: false, error: 'busy', busy: true }),
    true,
  );
});

test('hold: without the flag a busy park is rejected exactly as before', () => {
  assert.equal(
    shouldHoldPark({ recall: false, whenQuiet: false }, { ok: false, error: 'busy', busy: true }),
    false,
  );
});

test('hold: never for a non-busy refusal, a success, or a recall', () => {
  const flagged = { recall: false, whenQuiet: true };
  // Permanent refusal (pinned, intern, unknown id…) — reject now, don't retry forever.
  assert.equal(shouldHoldPark(flagged, { ok: false, error: 'pinned' }), false);
  assert.equal(shouldHoldPark(flagged, { ok: true }), false);
  // Recall never reports busy, but the verb is guarded anyway: a recall must
  // always archive, never sit in the queue retrying.
  assert.equal(
    shouldHoldPark({ recall: true, whenQuiet: true }, { ok: false, error: 'busy', busy: true }),
    false,
  );
});
