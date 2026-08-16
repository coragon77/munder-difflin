'use strict';

/**
 * ON VACATION — the third resting place for a human-created agent: off the floor
 * at zero cost, individually recallable, and PROTECTED FROM DELETION.
 *
 * `vacation` is a flag layered on `archived`, exactly as `retired` is (445d135),
 * and for the same reason: `archived` is pure liveness — archiveOrphanedAgents
 * flips it on every PTY-less agent at boot (44df562), so it can only ever mean
 * "no terminal right now", never "parked" or "gone for good". A vacationer
 * genuinely has no PTY, so the boot sweep, broadcast fan-out, heartbeat roster
 * and nudge poller skip it with no new exemptions.
 *
 * These tests pin the registry half: that parking survives a restart, that a
 * respawn IS the recall (and clears the flag), that ending a vacation demotes to
 * plain ARCHIVED rather than reviving anyone, that the retired/god refusals hold,
 * and that a parked agent leaves the active roster for the fetchable pool.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vacation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hive: new HiveManager(() => home) };
}

/** Main's writeFleetSnapshot roster filter, mirrored (see src/main/index.ts).
 *  A vacationer is `archived`, so it drops out here for free — that is the whole
 *  point of layering the flag rather than inventing a fourth liveness state. */
const activeIds = (hive) =>
  Object.entries(hive.registry().agents)
    .filter(([, a]) => !a.archived && !a.retired)
    .map(([id]) => id);

/** Main's writeFleetSnapshot vacation pool, mirrored (see src/main/index.ts). */
const vacationPool = (hive) =>
  Object.entries(hive.registry().agents)
    .filter(([, a]) => !!a.vacation && !a.retired)
    .map(([id, a]) => ({
      id,
      name: a.name,
      role: a.role ?? 'agent',
      cwd: a.cwd,
      parkedAt: a.vacationSince ?? null,
    }));

test('parking sets archived + vacation and outlives the process', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });

  const before = Date.now();
  hive.setVacation('pam-1', true);

  const entry = hive.registry().agents['pam-1'];
  assert.equal(entry.vacation, true);
  assert.equal(entry.archived, true, 'a vacationer is off the floor too');
  assert.ok(entry.vacationSince >= before, 'parked-at stamp drives the "parked 2h ago" line');
  assert.equal(hive.isOnVacation('pam-1'), true);

  // The registry is what a restart reads — a fresh manager over the same home is
  // exactly what boot sees. Without this, every restart would walk the whole
  // parked pool back onto the floor.
  assert.equal(
    new HiveManager(() => home).isOnVacation('pam-1'),
    true,
    'vacation must outlive the process, or the restart un-parks everyone',
  );
});

test('a respawn IS the recall — it clears the flag and keeps the role', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({
    id: 'pam-1',
    name: 'Pam',
    provider: 'claude',
    role: 'designer',
    cwd: '/tmp',
  });
  hive.setVacation('pam-1', true);

  // The recall path: spawnAgentCore → ensureAgent. Unlike `retired` (which must
  // survive re-registration), `vacation` is DESIGNED to clear here — a live PTY
  // means the agent is back.
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });

  const entry = hive.registry().agents['pam-1'];
  assert.equal(!!entry.vacation, false, 'coming back to the floor ends the vacation');
  assert.equal(entry.vacationSince, undefined, 'and clears the parked-at stamp');
  assert.equal(entry.archived, false, 'a respawn means a live terminal');
  assert.equal(entry.role, 'designer', 'ROLE IS IDENTITY — a recall is the same person');
  assert.deepEqual(activeIds(hive), ['pam-1']);
  assert.deepEqual(vacationPool(hive), [], 'and the agent leaves the fetchable pool');
});

test('ending a vacation demotes to ARCHIVED — it never revives anyone', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });
  hive.setVacation('pam-1', true);

  hive.setVacation('pam-1', false);

  const entry = hive.registry().agents['pam-1'];
  assert.equal(!!entry.vacation, false);
  assert.equal(entry.vacationSince, undefined);
  // This is the first half of the two-step deletion: plain ARCHIVED, still off
  // the floor. Coming back is a respawn, not this.
  assert.equal(entry.archived, true, 'ending a vacation must not put anyone back on the floor');
  assert.deepEqual(activeIds(hive), []);
});

test('the retired and god are refused — vacation is for the living and the led', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({
    id: 'intern-doomed',
    name: 'Ryan',
    provider: 'claude',
    role: 'intern',
    cwd: '/tmp',
  });
  await hive.ensureAgent({
    id: 'michael',
    name: 'Michael',
    provider: 'claude',
    isGod: true,
    cwd: '/tmp',
  });
  hive.setRetired('intern-doomed', true);

  hive.setVacation('intern-doomed', true);
  hive.setVacation('michael', true);

  assert.equal(
    !!hive.registry().agents['intern-doomed'].vacation,
    false,
    'retired and vacation are mutually exclusive — a fired agent is gone, not resting',
  );
  assert.equal(hive.registry().agents['intern-doomed'].retired, true, 'and the fire still stands');
  assert.equal(
    !!hive.registry().agents['michael'].vacation,
    false,
    'god runs the floor; god does not go on vacation',
  );
});

test('a parked agent leaves the active roster for the fetchable pool', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({
    id: 'pam-1',
    name: 'Pam',
    provider: 'claude',
    role: 'designer',
    cwd: '/repo',
  });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: '/repo' });

  hive.setVacation('pam-1', true);

  assert.deepEqual(activeIds(hive), ['jim-1'], 'a vacationer is not floor capacity');
  const pool = vacationPool(hive);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].id, 'pam-1');
  assert.equal(
    pool[0].role,
    'designer',
    'god picks a fetchable by role, so it has to be in the pool',
  );
  assert.equal(typeof pool[0].parkedAt, 'number');
});

test('only a real flip rebuilds the roster, and a broken writer cannot roll it back', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });

  let calls = 0;
  hive.onRosterChange = () => {
    calls++;
    throw new Error('snapshot exploded');
  };

  hive.setVacation('pam-1', true);
  hive.setVacation('pam-1', true); // already parked — nothing changed
  hive.setVacation('nobody-1', true); // not registered at all

  assert.equal(calls, 1, 'only a real flip rebuilds the snapshot');
  assert.equal(
    hive.registry().agents['pam-1'].vacation,
    true,
    'a throwing snapshot writer must not roll back or crash the park',
  );
});
