'use strict';

/**
 * Recall focus steal — card agent-recall-focus-steal-god-i-2026-08-17.
 *
 * A god-initiated recall (vacation-request file) restores the agent's pane in
 * the BACKGROUND: no selection change, no window/tab focus steal — the
 * operator keeps typing where they were. An operator-clicked recall in the UI
 * keeps its explicit switch to the recalled agent.
 *
 * The steal mechanism is store.addAgent setting selectedId = new agent, which
 * every spawn broadcast flows through. Pinned here:
 *  - addAgent(agent, { select: false }) leaves the current selection AND its
 *    persistence untouched (the background recall)
 *  - addAgent(agent) default behavior is unchanged (UI paths still switch)
 *  - index.ts distinguishes the initiator AT THE SOURCE: the vacation-request
 *    path passes a background marker into recallAgent, which stamps
 *    `select: false` onto the hive:agentSpawned broadcast; the hive:recall
 *    IPC (UI click) passes no marker (source pins — index.ts is not loadable
 *    outside Electron; same pattern as worker-intern-switches)
 *  - the renderer hands the marker through to addAgent (useHive source pin)
 *  - the preload payload type carries the marker (preload source pin)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

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

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

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

// ── store: the selection pin ───────────────────────────────────────────────

test('background addAgent ({ select: false }) does not change the selected pane', () => {
  memoryStorage.data = {};
  useStore.setState({
    agents: [agent('pam-1', { ptyId: 'pty-pam-1' })],
    archivedAgents: [],
    restorableAgents: [],
    selectedId: 'pam-1',
    feeds: { 'pam-1': [] },
  });
  memoryStorage.setItem('cth.selectedId', 'pam-1');

  // The recalled vacationer lands on the floor...
  useStore.getState().addAgent(agent('ada-1', { ptyId: 'pty-ada-1' }), { select: false });

  const s = useStore.getState();
  assert.deepEqual(
    s.agents.map((a) => a.id),
    ['pam-1', 'ada-1'],
    'card lands on the floor',
  );
  assert.equal(s.selectedId, 'pam-1', 'selection stays where the operator was');
  assert.equal(memoryStorage.getItem('cth.selectedId'), 'pam-1', 'persisted selection untouched');
  assert.ok(Array.isArray(s.feeds['ada-1']), 'recalled agent still gets a feed');
});

test('default addAgent still selects the new agent (UI paths unchanged)', () => {
  memoryStorage.data = {};
  useStore.setState({
    agents: [agent('pam-1', { ptyId: 'pty-pam-1' })],
    archivedAgents: [],
    restorableAgents: [],
    selectedId: 'pam-1',
    feeds: { 'pam-1': [] },
  });

  useStore.getState().addAgent(agent('jim-1', { ptyId: 'pty-jim-1' }));

  const s = useStore.getState();
  assert.equal(s.selectedId, 'jim-1', 'no opts ⇒ select as before');
  assert.equal(memoryStorage.getItem('cth.selectedId'), 'jim-1', 'persisted too');
});

// ── index.ts: initiator distinguished at the source ────────────────────────

test('the vacation-request path recalls in the background; the UI IPC does not', () => {
  const src = read('src/main/index.ts');

  // recallAgent accepts the background marker and stamps it onto the
  // hive:agentSpawned broadcast.
  assert.match(
    src,
    /function recallAgent\(\s*agentId: string,\s*opts\?: \{ background\?: boolean \},?\s*\)/,
    'recallAgent takes the background marker',
  );
  assert.match(
    src,
    /notifySpawned: \(e\) =>\s*liveWebContents\(\)\?\.send\(\s*'hive:agentSpawned',\s*opts\?\.background \? \{ \.\.\.e, select: false \} : e,?\s*\)/,
    'background recall broadcasts select:false',
  );

  // The request-file path passes the marker...
  assert.match(
    src,
    /res = recall\s*\?\s*await recallAgent\(agentId, \{ background: true \}\)\s*: parkAgent\(agentId, plan\.reason\)/,
    'processVacationRequest recalls with background:true',
  );

  // ...the UI IPC path does not (explicit switch preserved).
  assert.match(
    src,
    /ipcMain\.handle\('hive:recall', \(_e, id: unknown\) => \{\s*if \(typeof id !== 'string'\) return \{ ok: false, error: 'invalid id' \};\s*return recallAgent\(id\);\s*\}\)/,
    'hive:recall (UI click) passes no background marker',
  );
});

// ── renderer + preload wiring ──────────────────────────────────────────────

test('useHive hands the marker through to addAgent', () => {
  const src = read('src/renderer/src/hooks/useHive.ts');
  assert.match(
    src,
    /addAgent\(agent, \{ select: rec\.select !== false \}\)/,
    '5b spawns select unless the broadcast says background',
  );
});

test('preload payload type carries the select marker', () => {
  const src = read('src/preload/index.ts');
  assert.match(src, /select\?: boolean;/, 'onHiveAgentSpawned payload types select');
});
