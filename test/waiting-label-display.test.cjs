'use strict';

/**
 * waiting-label-display (card agent-waiting-vs-idle-display--2026-08-17).
 *
 * Follow-up to the busy-signal census (f7c1e4a): fleet.json carried
 * pendingBackgroundWork — god VERIFIED Kevin at 1 — but every operator-facing
 * surface still read him idle. The label derivation never consumed the field.
 *
 * This pins the DISPLAY contract per surface:
 *   - badge derivation (statusLabel.ts → office agent card + fleet tab):
 *     pending>0 upgrades idle → 'waiting (N)', never past a
 *     stronger state (working/typing/looping), waiting keeps its count;
 *   - god's injected roster line (HiveManager.rosterContext): the fleet.json
 *     census rides the LIVE ROSTER bit so god stops reading a waiting agent
 *     as plain 'active 3m ago'.
 *
 * Census semantics themselves (persistent-monitor exclusion, TTL, counting)
 * are pinned by test/waiting-busy-pending-work.test.cjs — not re-tested here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { waitingBadge } = loadTs('src/renderer/src/statusLabel.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

// ——— surface 1+2: the badge derivation (office card + fleet tab share it) ———

test('idle + pending → waiting with the count (the incident: Kevin reads waiting)', () => {
  const b = waitingBadge('idle', 1);
  assert.equal(b.status, 'waiting');
  assert.equal(b.label, 'waiting (1)');
  assert.equal(waitingBadge('idle', 3).label, 'waiting (3)');
});

test('zero/absent/garbage pending changes nothing — idle stays idle', () => {
  assert.deepEqual(waitingBadge('idle', 0), { status: 'idle' });
  assert.deepEqual(waitingBadge('idle', undefined), { status: 'idle' });
  assert.deepEqual(waitingBadge('idle', -2), { status: 'idle' });
  assert.deepEqual(waitingBadge('idle', Number.NaN), { status: 'idle' });
  assert.deepEqual(waitingBadge('idle', 2.9), {
    status: 'waiting',
    label: 'waiting (2)',
  });
});

test('stronger states win — a census never masks working/typing/looping/blocked', () => {
  for (const s of [
    'working',
    'thinking',
    'typing',
    'looping',
    'blocked',
    'compacting',
    'success',
  ]) {
    assert.deepEqual(waitingBadge(s, 4), { status: s }, `${s} must keep its badge`);
  }
});

test('an already-waiting agent gains the count on its label', () => {
  assert.deepEqual(waitingBadge('waiting', 2), {
    status: 'waiting',
    label: 'waiting (2)',
  });
  // count dropped to zero → back to the plain waiting badge (no stale count)
  assert.deepEqual(waitingBadge('waiting', 0), { status: 'waiting' });
});

// ——— surface 3: god's injected roster line —————————————————————————————

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-wait-label-'));
}

async function hiveWithFleet(t, agents) {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: home,
    isGod: true,
  });
  await hive.ensureAgent({ id: 'kevin-1', name: 'Kevin', provider: 'claude', cwd: home });
  hive.writeFleetSnapshot({
    ts: Date.now() - 4000,
    agents: [
      {
        id: 'god-1',
        name: 'Michael',
        role: 'orchestrator',
        isGod: true,
        breaker: 'ok',
        tokens: 0,
        usd: 0,
        lastActiveSecAgo: 6,
        inboxBacklog: 0,
      },
      {
        id: 'kevin-1',
        name: 'Kevin',
        role: 'agent',
        breaker: 'ok',
        tokens: 0,
        usd: 0,
        lastActiveSecAgo: 240,
        inboxBacklog: 0,
        ...agents,
      },
    ],
  });
  return hive;
}

test('the roster line says waiting (N) for a census-waiting agent', async (t) => {
  const hive = await hiveWithFleet(t, { pendingBackgroundWork: 1 });
  const line = hive.rosterContext();
  assert.match(line, /kevin-1[^;]*waiting \(1\)/, 'the bit must ride kevin');
  assert.doesNotMatch(line, /god-1[^;]*waiting/, 'god has no census here');
});

test('sits with the other per-agent bits', async (t) => {
  const hive = await hiveWithFleet(t, { pendingBackgroundWork: 2, inboxBacklog: 3 });
  const line = hive.rosterContext();
  assert.match(line, /kevin-1[^;]*waiting \(2\)/);
  assert.match(line, /kevin-1[^;]*inbox 3/);
});

test('zero or absent census adds no waiting bit (pure extension, not a fork)', async (t) => {
  for (const extra of [{}, { pendingBackgroundWork: 0 }]) {
    const hive = await hiveWithFleet(t, extra);
    assert.doesNotMatch(hive.rosterContext(), /waiting \(/);
  }
});
