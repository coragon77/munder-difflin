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
      role: a.role ?? 'role: unknown',
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

test('parking leaves the role byte-identical (registry-role-overwrite incident 2026-08-19)', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({
    id: 'ryan-1',
    name: 'Ryan',
    provider: 'claude',
    role: 'Owns merlin_oegb',
    cwd: '/tmp',
  });
  const before = hive.registry().agents['ryan-1'].role;

  hive.setVacation('ryan-1', true);

  // A wipe that read "on standby" on the roster line misrouted Ryan's customer
  // onto a harness card and destroyed his pane — park/recall may NEVER touch
  // the role. Assert the persisted file, not just the in-memory copy.
  assert.equal(hive.registry().agents['ryan-1'].role, before);
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8'));
  assert.equal(onDisk.agents['ryan-1'].role, before, 'the persisted role survives a park');
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

// ─── vacation review findings M2–M4 (card vacation-review-bundle-20260816) ──

test('M2: an unarchive cannot silently end a vacation — the flag guards setArchived', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });
  hive.setVacation('pam-1', true);

  // The sanctioned way back is a RECALL (respawn). A plain unarchive would
  // strand the agent at archived:false + vacation:true — on the floor by
  // liveness but skipped by every vacation-aware sweep — or silently demote
  // it, un-protected and un-announced. The registry guard closes both.
  hive.setArchived('pam-1', false);

  const entry = hive.registry().agents['pam-1'];
  assert.equal(entry.vacation, true, 'the vacation flag survives an unarchive attempt');
  assert.equal(entry.archived, true, 'a vacationer stays off the floor');
  assert.equal(hive.isOnVacation('pam-1'), true);
});

test('M3: setVacation reports whether the registry state actually landed', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });
  await hive.ensureAgent({ id: 'ryan-1', name: 'Ryan', provider: 'claude', cwd: '/tmp' });
  hive.setRetired('ryan-1', true);

  assert.equal(hive.setVacation('pam-1', true), true, 'a successful park reports true');
  assert.equal(hive.setVacation('pam-1', true), true, 'an idempotent re-park is still true');
  assert.equal(hive.setVacation('pam-1', false), true, 'ending the vacation reports true');
  assert.equal(
    hive.setVacation('ryan-1', true),
    false,
    'a refusal (retired) reports false — it did not happen',
  );

  // The write-failure half: parkAgent reports ok today even when this write
  // dies, promising deletion-protection the registry never got. A read-only
  // hive root breaks only the WRITE (tmp-file creation) — the read still
  // works, so this exercises the exact swallowed-error path.
  const hiveRoot = path.join(home, 'hive');
  fs.chmodSync(hiveRoot, 0o555);
  try {
    assert.equal(
      hive.setVacation('pam-1', true),
      false,
      'a failed registry write must report false',
    );
  } finally {
    // Restore BEFORE floor()'s rmSync after-hook (registration order) so a
    // failure in the assertion can't also break the tempdir cleanup.
    fs.chmodSync(hiveRoot, 0o755);
  }
});

test('M4: retiring a vacationer ends the vacation — retired means gone, not resting', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });
  hive.setVacation('pam-1', true);

  hive.setRetired('pam-1', true);

  const entry = hive.registry().agents['pam-1'];
  assert.equal(entry.retired, true);
  assert.equal(!!entry.vacation, false, 'vacation and retired are mutually exclusive');
  assert.equal(entry.vacationSince, undefined, 'the parked-at stamp goes with it');
  assert.equal(entry.archived, true, 'retiring still archives');
  assert.deepEqual(vacationPool(hive), [], 'a fired agent leaves the fetchable pool');
});
