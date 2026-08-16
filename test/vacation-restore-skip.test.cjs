'use strict';

// Boot-respawn skip, 2026-08-16: restore-team must NOT walk a vacationer back
// onto the floor. The check lives inline in useRestoreTeam's restoreTeam(), which
// is a React hook and can't be mounted from this .cjs harness — so the ONE
// registry-reading expression it depends on is pulled out into `parkedAgentIds`
// (useRestoreTeam.ts) and pinned here instead. Behavior is unchanged; this only
// makes the "who gets skipped" rule independently testable.
//
// NOT covered here: the hook's fail-safe abort when `hiveRegistry()` itself
// throws (restoring=false, a "couldn't verify vacation status" note, and no
// spawns at all). That path needs the hook mounted with a fake IPC bridge and
// the store wired up — not reachable from this harness. See useRestoreTeam.ts:89-98.

const test = require('node:test');
const assert = require('node:assert/strict');

// useRestoreTeam.ts pulls in react + the store, which read window/localStorage
// at module load — same shim other store-backed tests use.
const memoryStorage = {
  data: {},
  getItem(k) {
    return Object.hasOwn(this.data, k) ? this.data[k] : null;
  },
  setItem(k, v) {
    this.data[k] = String(v);
  },
  removeItem(k) {
    delete this.data[k];
  },
};
globalThis.localStorage = memoryStorage;
globalThis.window = {
  localStorage: memoryStorage,
  addEventListener() {},
  setTimeout,
  clearTimeout,
};

const loadTs = require('./load-ts.cjs');
const { parkedAgentIds } = loadTs('src/renderer/src/hooks/useRestoreTeam.ts');

test('a vacationer is in the parked set', () => {
  const reg = { agents: { 'pam-1': { vacation: true } } };
  assert.deepEqual([...parkedAgentIds(reg)], ['pam-1']);
});

test('a plain archived agent is not in the parked set', () => {
  const reg = { agents: { 'dwight-1': { archived: true } } };
  assert.deepEqual([...parkedAgentIds(reg)], []);
});

test('a retired agent is not in the parked set', () => {
  const reg = { agents: { 'jim-1': { retired: true } } };
  assert.deepEqual([...parkedAgentIds(reg)], []);
});

test('an empty registry yields an empty set', () => {
  assert.deepEqual([...parkedAgentIds({ agents: {} })], []);
});

test('filtering a restorable list by the parked set drops the vacationer and keeps everyone else', () => {
  const reg = { agents: { 'pam-1': { vacation: true }, 'dwight-1': {}, 'jim-1': {} } };
  const parked = parkedAgentIds(reg);
  const restorable = [{ id: 'pam-1' }, { id: 'dwight-1' }, { id: 'jim-1' }];
  const survivors = restorable.filter((a) => !parked.has(a.id));
  assert.deepEqual(
    survivors.map((a) => a.id),
    ['dwight-1', 'jim-1'],
  );
});
