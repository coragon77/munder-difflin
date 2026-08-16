'use strict';

// Vacation renderer follow-up (M5): a HEADLESS park (god vacation-request with
// no window open) misses the hive:agentVacationed broadcast, so the next boot's
// reconcileWithLivePtys files the parked agent under restorableAgents (a phantom
// restore card) and the VACATION shelf stays empty.
//
// The fix is the renderer boot reconcile: on registry fetch, archiveAgent is
// re-invoked with {vacation} for every registry vacationer — which requires
// archiveAgent's no-floor-card path to PROMOTE a restorable entry into
// archivedAgents(vacation) instead of silently dropping it.

const test = require('node:test');
const assert = require('node:assert/strict');

// store.ts reads window/localStorage at module load, so shim before requiring it.
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
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const agent = (id, extra = {}) => ({
  id,
  name: id,
  character: 'jim',
  accent: 'coral',
  description: '',
  project: 'p',
  tmuxTarget: '',
  cwd: '/tmp',
  command: 'claude',
  status: 'idle',
  action: 'idle',
  progress: 0,
  ...extra,
});

test('headless park: pty reconcile files the vacationer restorable, boot reconcile moves it to VACATION', () => {
  // Boot state after a park nobody watched: the floor card survived in
  // localStorage, its PTY is gone (main tore it down at park time).
  useStore.setState({
    agents: [agent('kevin', { ptyId: 'pty-kevin' })],
    archivedAgents: [],
    restorableAgents: [],
  });

  // Step 1 — the existing boot reconcile: dead PTY → restorable (the phantom).
  useStore.getState().reconcileWithLivePtys(['pty-someone-else']);
  assert.deepEqual(
    useStore.getState().restorableAgents.map((a) => a.id),
    ['kevin'],
    'precondition: pty reconcile files the parked agent as restorable',
  );

  // Step 2 — the boot vacation reconcile (registry says kevin is parked).
  useStore.getState().archiveAgent('kevin', { vacation: true, vacationSince: 1234 });

  const s = useStore.getState();
  assert.deepEqual(s.restorableAgents, [], 'no phantom restorable card');
  const shelf = s.archivedAgents.find((a) => a.id === 'kevin');
  assert.ok(shelf, 'entry exists for the VACATION shelf');
  assert.equal(shelf.vacation, true);
  assert.equal(shelf.vacationSince, 1234);
  // and it must be persisted, or the next reload resurrects the phantom
  assert.equal(
    JSON.parse(memoryStorage.getItem('cth.restorableAgents')).length,
    0,
    'restorable drop persisted',
  );
});

test('boot reconcile alone (no pty reconcile first) also lands the vacationer on the shelf', () => {
  // Order must not matter: window restored, directory fetched before listPtys.
  useStore.setState({
    agents: [agent('kevin', { ptyId: 'pty-kevin' })],
    archivedAgents: [],
    restorableAgents: [],
  });
  useStore.getState().archiveAgent('kevin', { vacation: true, vacationSince: 42 });
  const s = useStore.getState();
  assert.deepEqual(s.agents, [], 'floor card gone');
  assert.ok(s.archivedAgents.some((a) => a.id === 'kevin' && a.vacation));
  assert.deepEqual(s.restorableAgents, []);
});

test('re-promoting an already-parked entry is idempotent and keeps vacationSince', () => {
  useStore.setState({
    agents: [],
    archivedAgents: [agent('kevin', { archived: true, vacation: true, vacationSince: 42 })],
    restorableAgents: [],
  });
  useStore.getState().archiveAgent('kevin', { vacation: true, vacationSince: 42 });
  const shelf = useStore.getState().archivedAgents.find((a) => a.id === 'kevin');
  assert.equal(shelf.vacationSince, 42);
});

test('plain (non-vacation) archive still just ends restorability — no shelf entry', () => {
  useStore.setState({
    agents: [],
    archivedAgents: [],
    restorableAgents: [agent('intern-fired')],
  });
  useStore.getState().archiveAgent('intern-fired');
  const s = useStore.getState();
  assert.deepEqual(s.restorableAgents, []);
  assert.deepEqual(s.archivedAgents, [], 'no vacation flag, no shelf entry');
});
