'use strict';

// Restore-team regression 2026-08-16: the "restore team" button spawned nothing.
//
// Cause: useRestoreTeam refused any agent whose registry entry read
// `archived: true`. But `archived` is a LIVENESS flag — archiveOrphanedAgents
// (src/main/index.ts) sets it on every PTY-less agent at boot, and a restorable
// agent is by definition one whose terminal died with the last session. The
// guard therefore rejected 100% of restores.
//
// Retirement is now tracked where it is actually known: archiving an agent drops
// it from the restorable list. These tests pin that, including the case the old
// guard was really aimed at — a fire-request for an agent whose terminal was
// already gone, so there is no floor card to remove.

const test = require('node:test');
const assert = require('node:assert/strict');

// store.ts reads window/localStorage at module load, so shim before requiring it.
const memoryStorage = {
  data: {},
  getItem(k) { return  Object.hasOwn(this.data, k) ? this.data[k] : null; },
  setItem(k, v) { this.data[k] = String(v); },
  removeItem(k) { delete this.data[k]; }
};
globalThis.localStorage = memoryStorage;
globalThis.window = { localStorage: memoryStorage, addEventListener() {}, setTimeout, clearTimeout };

const loadTs = require('./load-ts.cjs');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const agent = (id, extra = {}) => ({
  id, name: id, character: 'jim', accent: 'coral', description: '',
  project: 'p', tmuxTarget: '', cwd: '/tmp', command: 'claude',
  status: 'idle', action: 'idle', progress: 0, ...extra
});

const restorableIds = () => useStore.getState().restorableAgents.map((a) => a.id);

test('archiving an agent with no floor card still ends its restorability', () => {
  useStore.setState({
    agents: [], archivedAgents: [],
    restorableAgents: [agent('intern-fired'), agent('intern-keep')]
  });

  // The fire-while-dead path: main archives the registry entry and broadcasts
  // hive:agentArchived; the renderer has no live agent to remove.
  useStore.getState().archiveAgent('intern-fired');

  assert.deepEqual(restorableIds(), ['intern-keep'],
    'a fired agent must not stay on the restorable list — that is what brought it back');
  assert.deepEqual(
    JSON.parse(memoryStorage.getItem('cth.restorableAgents')).map((a) => a.id),
    ['intern-keep'],
    'and the drop must be persisted, or it returns on the next reload');
});

test('archiving a live agent moves it off the floor into the archive', () => {
  useStore.setState({
    agents: [agent('pam-1', { ptyId: 'pty-pam-1' })], archivedAgents: [],
    restorableAgents: []
  });

  useStore.getState().archiveAgent('pam-1');

  const s = useStore.getState();
  assert.deepEqual(s.agents.map((a) => a.id), [], 'card leaves the floor');
  assert.deepEqual(s.archivedAgents.map((a) => a.id), ['pam-1'], 'and is retained as archived');
});

// Fire-card leak, live repro 2026-08-16 (intern-erin): the fire-request path
// killed her PTY and set registry `archived:true`, but nothing told the floor —
// so her card stayed in persisted `cth.agents` and Ctrl+R respawned her from it
// (archive @1786893363362, spawn @1786893581579), flipping `archived` back.
// Main now broadcasts hive:agentArchived on every fire; this pins the renderer
// half — that the broadcast actually removes the intern's card AND the persisted
// copy a reload would respawn from, despite the intern branch below it.
test('archiving an intern clears the persisted floor card a reload respawns from', () => {
  memoryStorage.data = {};
  useStore.setState({
    agents: [agent('intern-erin', { ptyId: 'intern-erin' }), agent('pam-1')],
    archivedAgents: [], restorableAgents: []
  });

  useStore.getState().archiveAgent('intern-erin');

  const s = useStore.getState();
  assert.deepEqual(s.agents.map((a) => a.id), ['pam-1'], 'card leaves the floor');
  assert.deepEqual(s.archivedAgents, [], 'interns leave no archived entry (d56bc65)');
  assert.deepEqual(
    JSON.parse(memoryStorage.getItem('cth.agents')).map((a) => a.id),
    ['pam-1'],
    'and the removal is persisted — a surviving card is what the reload respawns');
});

test('archiving an unknown id changes nothing', () => {
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [agent('keep')] });
  const before = useStore.getState().restorableAgents;
  useStore.getState().archiveAgent('never-existed');
  assert.equal(useStore.getState().restorableAgents, before, 'no-op keeps the same array identity');
});
