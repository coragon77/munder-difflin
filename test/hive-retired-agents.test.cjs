'use strict';

/**
 * A fired intern came back from the dead. Observed 2026-08-16 with
 * intern-intern-restore-team: fire → PTY closed, registry `archived:true`; app
 * restart → the agent was re-registered with `archived:false` and a fresh floor
 * row, and god started handing it work again.
 *
 * Cause: retirement was not persisted anywhere. It existed only as a DROP from
 * the renderer's localStorage `restorableAgents` list, so anything that restored
 * or re-registered from the registry — a restart, restore-team, a localStorage
 * wipe — never learned the agent had been fired. `archived` could not carry it
 * either: that flag is pure liveness and archiveOrphanedAgents sets it on every
 * PTY-less agent at boot (44df562), so "archived" says "no terminal right now".
 *
 * `retired` is the separate, persistent flag. These tests pin that it survives,
 * that a re-registration cannot lift it, and that it keeps the agent off the
 * roster the fleet snapshot is built from.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-retired-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hive: new HiveManager(() => home) };
}

/** Main's writeFleetSnapshot roster filter, mirrored (see src/main/index.ts). */
const activeIds = (hive) => Object.entries(hive.registry().agents)
  .filter(([, a]) => !a.archived && !a.retired)
  .map(([id]) => id);

test('firing persists retirement in the registry, not just liveness', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({ id: 'intern-doomed', name: 'Ryan', provider: 'claude', role: 'intern' });

  hive.setRetired('intern-doomed', true);

  const entry = hive.registry().agents['intern-doomed'];
  assert.equal(entry.retired, true);
  assert.equal(entry.archived, true, 'a fired agent is off the floor too');
  assert.equal(hive.isRetired('intern-doomed'), true);

  // The registry is the thing that survives a restart — a fresh manager over the
  // same home is exactly what boot sees.
  assert.equal(new HiveManager(() => home).isRetired('intern-doomed'), true,
    'retirement must outlive the process, or the restart resurrects them');
});

test('re-registering a fired agent cannot bring it back to life', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'intern-doomed', name: 'Ryan', provider: 'claude', role: 'intern' });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude' });
  hive.setRetired('intern-doomed', true);

  // The resurrection path: restore-team / boot re-registers from a remembered
  // roster. ensureAgent normally clears `archived` — the whole floor row came
  // back through that line.
  await hive.ensureAgent({ id: 'intern-doomed', name: 'Ryan', provider: 'claude', role: 'intern' });

  const entry = hive.registry().agents['intern-doomed'];
  assert.equal(entry.retired, true, 'a respawn must not silently un-fire anyone');
  assert.equal(entry.archived, true, 'and must not put them back on the floor');
  assert.deepEqual(activeIds(hive), ['pam-1'], 'fired agent must not be listed as floor capacity');
});

test('reinstating is deliberate, and only then does a spawn revive them', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'intern-doomed', name: 'Ryan', provider: 'claude', role: 'intern' });
  hive.setRetired('intern-doomed', true);

  hive.setRetired('intern-doomed', false);
  assert.equal(hive.isRetired('intern-doomed'), false);
  // Reinstating lifts the refusal but does NOT itself put them back on the floor;
  // they return the normal way, by being spawned.
  assert.equal(hive.registry().agents['intern-doomed'].archived, true);

  await hive.ensureAgent({ id: 'intern-doomed', name: 'Ryan', provider: 'claude', role: 'intern' });
  assert.deepEqual(activeIds(hive), ['intern-doomed']);
});

test('a fired agent\'s swept folder stays swept', async (t) => {
  const { home, hive } = floor(t);
  const agents = path.join(home, 'hive', 'agents');
  await hive.ensureAgent({ id: 'intern-doomed', name: 'Ryan', provider: 'claude', role: 'intern' });
  hive.setRetired('intern-doomed', true);

  // Operator sweeps the fired intern into agents/archive/<id>, as they do.
  fs.mkdirSync(path.join(agents, 'archive'), { recursive: true });
  fs.renameSync(path.join(agents, 'intern-doomed'), path.join(agents, 'archive', 'intern-doomed'));

  // The archive-restore added for the OTHER defect must not become a back door:
  // pulling the folder back would make a retired agent look present on disk.
  await hive.ensureAgent({ id: 'intern-doomed', name: 'Ryan', provider: 'claude', role: 'intern' });

  assert.ok(fs.existsSync(path.join(agents, 'archive', 'intern-doomed')), 'must stay swept');
  assert.equal(hive.registry().agents['intern-doomed'].retired, true);
});

test('a fresh spawn refreshes the roster too, not just an archive', async (t) => {
  const { hive } = floor(t);
  const seen = [];
  hive.onRosterChange = () => { seen.push(activeIds(hive).join(',')); };

  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude' });

  assert.equal(seen.length, 1, 'a new hire must hit the roster without waiting for the beat');
  assert.equal(seen[0], 'pam-1', 'and the snapshot is taken AFTER the registry write');
});

test('retiring refreshes the roster snapshot and survives a broken writer', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude' });

  let calls = 0;
  hive.onRosterChange = () => { calls++; throw new Error('snapshot exploded'); };

  hive.setRetired('jim-1', true);
  hive.setRetired('jim-1', true);      // already retired — nothing changed
  hive.setRetired('nobody-1', true);   // not registered at all

  assert.equal(calls, 1, 'only a real flip rebuilds the snapshot');
  assert.equal(hive.registry().agents['jim-1'].retired, true,
    'a throwing snapshot writer must not roll back or crash the fire');
});
