'use strict';

// Vacation shelf, renderer half, 2026-08-16.
//
// `vacation` is a flag layered on `archived` (see hive-vacation.test.cjs for the
// registry half): a parked agent lives in `archivedAgents` same as a plain
// archive, but flagged, so `vacationAgents`/`archivedOnlyAgents` can split one
// list into two shelves without ever falling out of step with each other.
//
// The point of this file is the delete guard: `removeArchivedAgent` refuses
// while `vacation` is set, and the flag now only clears through the real
// flows — recall (respawn) or main's registry verbs. A test that only pinned
// the refusal would also pass against a store that can never delete anything,
// so the recall-then-plain-archive re-enable is covered too.
// (remove-end-vacation-button-20260816: the demote-without-respawn button is
// gone — Stefan's flow is Recall, then the agent pane's Archive button.)

const test = require('node:test');
const assert = require('node:assert/strict');

// store.ts reads window/localStorage at module load, so shim before requiring it.
const memoryStorage = {
  data: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
  setItem(k, v) { this.data[k] = String(v); },
  removeItem(k) { delete this.data[k]; }
};
globalThis.localStorage = memoryStorage;
globalThis.window = { localStorage: memoryStorage, addEventListener() {}, setTimeout, clearTimeout };

const loadTs = require('./load-ts.cjs');
const { useStore, vacationAgents, archivedOnlyAgents } = loadTs('src/renderer/src/store/store.ts');

const agent = (id, extra = {}) => ({
  id, name: id, character: 'jim', accent: 'coral', description: '',
  project: 'p', tmuxTarget: '', cwd: '/tmp', command: 'claude',
  status: 'idle', action: 'idle', progress: 0, ...extra
});

test('parking moves the floor card to archivedAgents flagged vacation, off restorable, and persists both', () => {
  useStore.setState({
    agents: [agent('pam-1', { ptyId: 'pty-pam-1' })],
    archivedAgents: [],
    restorableAgents: [agent('pam-1')]
  });

  const before = Date.now();
  useStore.getState().archiveAgent('pam-1', { vacation: true });

  const s = useStore.getState();
  assert.deepEqual(s.agents.map((a) => a.id), [], 'card leaves the floor');
  assert.equal(s.archivedAgents.length, 1);
  assert.equal(s.archivedAgents[0].vacation, true, 'flagged vacation, not plain archived');
  assert.equal(s.archivedAgents[0].archived, true, 'still archived — same shelf, extra flag');
  assert.ok(s.archivedAgents[0].vacationSince >= before, 'parked-at stamp defaults to now');
  assert.deepEqual(s.restorableAgents, [], 'a parked agent is not also a restore candidate');

  const persistedArchived = JSON.parse(memoryStorage.getItem('cth.archivedAgents'));
  assert.equal(persistedArchived[0].vacation, true, 'vacation flag is persisted');
  const persistedRestorable = JSON.parse(memoryStorage.getItem('cth.restorableAgents'));
  assert.deepEqual(persistedRestorable, [], 'restorable drop is persisted too');
});

test('vacationAgents holds a parked agent, archivedOnlyAgents does not', () => {
  useStore.setState({
    agents: [],
    archivedAgents: [agent('pam-1', { archived: true, vacation: true }), agent('dwight-1', { archived: true })],
    restorableAgents: []
  });

  const s = useStore.getState();
  assert.deepEqual(vacationAgents(s).map((a) => a.id), ['pam-1']);
  assert.deepEqual(archivedOnlyAgents(s).map((a) => a.id), ['dwight-1']);
});

test('removeArchivedAgent refuses while parked; recall + plain archive re-enables delete', () => {
  useStore.setState({
    agents: [],
    archivedAgents: [agent('pam-1', { archived: true, vacation: true, vacationSince: 123 })],
    restorableAgents: []
  });

  // Half 1: the delete guard refuses outright — a vacationer is undeletable.
  useStore.getState().removeArchivedAgent('pam-1');
  assert.equal(useStore.getState().archivedAgents.length, 1, 'a vacationer survives the delete call');

  // Half 2: no demote-without-respawn exists any more — the path is Recall
  // (the respawn drops the vacation shelf) then the agent pane's plain Archive.
  useStore.getState().addAgent(agent('pam-1', { ptyId: 'pty-pam-1' }));
  useStore.getState().archiveAgent('pam-1');
  useStore.getState().removeArchivedAgent('pam-1');
  assert.deepEqual(useStore.getState().archivedAgents, [], 'delete succeeds after recall + plain archive');
});

// The `!target` branch: main parked an agent whose terminal was already closed,
// so there is no floor card to move — only an existing archived entry to flag.
test('parking an agent with no floor card flags its existing archived entry in place', () => {
  useStore.setState({
    agents: [],
    archivedAgents: [agent('pam-1', { archived: true })],
    restorableAgents: [agent('pam-1')]
  });

  useStore.getState().archiveAgent('pam-1', { vacation: true, vacationSince: 999 });

  const s = useStore.getState();
  assert.equal(s.archivedAgents.length, 1);
  assert.equal(s.archivedAgents[0].vacation, true, 'existing archived entry gets flagged');
  assert.equal(s.archivedAgents[0].vacationSince, 999);
  assert.deepEqual(s.restorableAgents, [], 'still ends restorability, same as a plain archive');
});

test('a respawn removes the parked entry from the archived list', () => {
  useStore.setState({
    agents: [],
    archivedAgents: [agent('pam-1', { archived: true, vacation: true, vacationSince: 1 })],
    restorableAgents: []
  });

  useStore.getState().addAgent(agent('pam-1', { ptyId: 'pty-pam-1' }));

  const s = useStore.getState();
  assert.deepEqual(s.agents.map((a) => a.id), ['pam-1'], 'card is back on the floor');
  assert.deepEqual(s.archivedAgents, [], 'no longer on the vacation shelf');
});
