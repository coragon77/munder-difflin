'use strict';

/**
 * ORPHAN SWEEP (card agent-app-start-archives-the-e-2026-08-18).
 *
 * Incident 2026-08-18 ~15:17: app start with zero live PTYs ran the boot
 * migration, which treated "no live PTY" as evidence of orphanhood and archived
 * every `archived:false` entry — 43 agents, the entire vacation pool included.
 * But `ptyToAgent` is process-local and populated only at spawn, so at boot NO
 * agent can have a PTY: zero PTYs means "nothing is running yet", never
 * "everyone is dead". And a parked agent's protection rested only on the
 * side-invariant `park ⇒ archived:true`; any state divergence
 * (`vacation:true, archived:false` — possible under pre-M2 unarchive paths)
 * fed the pool straight into the sweep.
 *
 * The decision core lives in src/main/orphanSweep.ts (pure, deps-free) so the
 * two incident behaviors are pinnable:
 *   1. zero live PTYs → the sweep archives NOBODY, parked or not;
 *   2. a parked agent (vacation:true) survives any sweep, even divergent ones
 *      where archived:false;
 * while the migration keeps its reason: with at least one live PTY in the
 * process (the config:changeHome recover-in-place re-bootstrap), a PTY-less,
 * non-parked, non-archived entry is a genuine orphan and is still swept.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { orphanedAgentIds } = loadTs('src/main/orphanSweep.ts');

/** Minimal registry shape — structural subset of HiveManager's Registry. */
const reg = (agents, godId = 'god') => ({ godId, agents });

test('zero live PTYs archives nobody — that state means nothing is running yet', () => {
  const r = reg({
    god: { name: 'Michael', isGod: true },
    active: { name: 'Pam', archived: false }, // stale from a crashed session
    parked: { name: 'Angela', archived: true, vacation: true },
    divergentParked: { name: 'Dwight', archived: false, vacation: true },
    plainArchived: { name: 'Kevin', archived: true },
  });
  assert.deepEqual(orphanedAgentIds(r, new Set()), []);
});

test('a parked agent survives a sweep even in the divergent archived:false state', () => {
  const r = reg({
    liveone: { name: 'Pam', archived: false },
    divergentParked: { name: 'Dwight', archived: false, vacation: true },
    parkedProper: { name: 'Angela', archived: true, vacation: true },
  });
  const swept = orphanedAgentIds(r, new Set(['liveone']));
  assert.ok(!swept.includes('divergentParked'), `divergent vacationer swept: ${swept}`);
  assert.ok(!swept.includes('parkedProper'), `parked vacationer swept: ${swept}`);
});

test('a genuinely orphaned non-parked agent is still archived when a live PTY exists', () => {
  const r = reg({
    liveone: { name: 'Pam', archived: false },
    orphan: { name: 'Creed', archived: false }, // no PTY while a sibling runs → dead
    plainArchived: { name: 'Kevin', archived: true },
  });
  assert.deepEqual(orphanedAgentIds(r, new Set(['liveone'])), ['orphan']);
});

test('god is never archived, even with zero other survivors', () => {
  const r = reg({ god: { name: 'Michael', isGod: true, archived: false } }, 'god');
  assert.deepEqual(orphanedAgentIds(r, new Set(['someoneelse'])), []);
});

test('an intern follows the same rule as a hire — swept when genuinely orphaned', () => {
  const r = reg({
    liveone: { name: 'Pam', archived: false },
    internOrphan: { name: 'Ryan', archived: false, role: 'intern' },
  });
  assert.deepEqual(orphanedAgentIds(r, new Set(['liveone'])), ['internOrphan']);
});

test('a parked intern survives too — vacation outranks disposability', () => {
  const r = reg({
    liveone: { name: 'Pam', archived: false },
    internParked: { name: 'Ryan', archived: false, role: 'intern', vacation: true },
  });
  assert.deepEqual(orphanedAgentIds(r, new Set(['liveone'])), []);
});
