'use strict';

/**
 * God's LIVE ROSTER is injected from `fleet.json`, which main otherwise rebuilds
 * only on an 8s beat (and not at all while the machine is suspended). So a fired
 * intern kept showing up as ACTIVE after its PTY was gone and its registry entry
 * said archived — and god routes work to a dead inbox on the strength of it.
 *
 * The fix is a seam: `setArchived` tells its owner the active set changed, and
 * main rebuilds the snapshot right there instead of waiting for the beat.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fleet-archive-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hive: new HiveManager(() => home) };
}

/** Stand-in for main's writeFleetSnapshot: same source (the registry) and the
 *  same `!archived` filter, so the test exercises the wiring, not the formatting. */
function snapshotWriter(hive, home) {
  const file = path.join(home, 'hive', 'fleet.json');
  const write = () => {
    const reg = hive.registry();
    const agents = Object.entries(reg.agents)
      .filter(([, a]) => !a.archived && !a.retired)
      .map(([id]) => ({ id }));
    fs.writeFileSync(file, JSON.stringify({ ts: 1, agents }), 'utf8');
  };
  const ids = () => new Set(JSON.parse(fs.readFileSync(file, 'utf8')).agents.map((a) => a.id));
  return { write, ids };
}

test('archiving an agent refreshes the fleet snapshot immediately', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', isGod: true });
  await hive.ensureAgent({ id: 'intern-doomed', name: 'Ryan', provider: 'claude', role: 'intern' });

  const fleet = snapshotWriter(hive, home);
  hive.onRosterChange = fleet.write;
  fleet.write(); // the beat that ran before the fire
  assert.ok(fleet.ids().has('intern-doomed'), 'precondition: on the floor');

  hive.setArchived('intern-doomed', true);

  // No timer advanced, no restart — the snapshot on disk is already correct.
  assert.equal(fleet.ids().has('intern-doomed'), false, 'fired intern still listed as ACTIVE');
  assert.ok(fleet.ids().has('god-1'), 'the rest of the floor survives');
});

test('unarchiving puts the agent back without waiting for the beat', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude' });
  const fleet = snapshotWriter(hive, home);
  hive.onRosterChange = fleet.write;

  hive.setArchived('pam-1', true);
  assert.equal(fleet.ids().has('pam-1'), false);
  hive.setArchived('pam-1', false);
  assert.ok(fleet.ids().has('pam-1'));
});

test('a no-op flip does not rebuild, and a broken writer cannot break archiving', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude' });

  let calls = 0;
  hive.onRosterChange = () => {
    calls++;
    throw new Error('snapshot exploded');
  };

  hive.setArchived('jim-1', true);
  hive.setArchived('jim-1', true); // already archived — nothing changed
  hive.setArchived('ghost-1', true); // not registered at all

  assert.equal(calls, 1, 'only a real flip rebuilds the snapshot');
  assert.equal(
    hive.registry().agents['jim-1'].archived,
    true,
    'a throwing snapshot writer must not roll back or crash the archive',
  );
});
