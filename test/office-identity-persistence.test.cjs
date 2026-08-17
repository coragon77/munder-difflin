'use strict';

/**
 * Agent icon persistence, registry half (card agent-icon-persistence-20260817).
 *
 * An agent's office identity (floor sprite + accent) used to live ONLY in the
 * renderer: the store row and its localStorage/roster.json mirrors. Recall
 * broadcasts carried no identity, so whenever the renderer had no shelf row
 * for the id (headless park, origin mismatch, stale mirror), the card was
 * re-DERIVED from the name — "ada" matches no cast member → the default jim.
 * Ada wore Jim's sprite. The registry is the durable home every spawn path
 * already reads; these tests pin its half:
 *
 *   • saveOfficeIdentity persists officeCharacter/officeAccent and the value
 *     survives a restart (a fresh HiveManager over the same home).
 *   • FIRST WRITE WINS — backfill-on-sight means the write-back only fills an
 *     EMPTY slot. A second assignment (a live agent's icon, a later hire's
 *     pick) must never overwrite what's saved: that is exactly the "never
 *     change a live agent's icon as a side effect" rule.
 *   • Unknown ids are refused, not thrown.
 *   • recallAgentCore's spawn broadcast carries the saved identity so the
 *     renderer can prefer it (see spawn-identity.test.cjs for the renderer
 *     half of the ladder).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { recallAgentCore } = loadTs('src/main/vacationFlow.ts');

// Store half — addAgent's backfill-on-sight write-back. store.ts reads
// window/localStorage at module load, so shim before requiring it (same
// pattern as vacation-store.test.cjs).
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
const cthCalls = [];
globalThis.localStorage = memoryStorage;
globalThis.window = {
  localStorage: memoryStorage,
  addEventListener() {},
  setTimeout,
  clearTimeout,
  cth: {
    hiveSaveOfficeIdentity: (id, character, accent) => {
      cthCalls.push([id, character, accent]);
      return Promise.resolve(true);
    },
  },
};
const { useStore } = loadTs('src/renderer/src/store/store.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-office-id-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hive: new HiveManager(() => home) };
}

test('saveOfficeIdentity persists and survives a restart', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({ id: 'ada-1', name: 'Ada', provider: 'claude', cwd: '/tmp' });

  assert.equal(hive.saveOfficeIdentity('ada-1', 'angela', 'sky'), true, 'first write lands');

  const entry = hive.registry().agents['ada-1'];
  assert.equal(entry.officeCharacter, 'angela');
  assert.equal(entry.officeAccent, 'sky');

  // A fresh manager over the same home is exactly what boot sees.
  const rebooted = new HiveManager(() => home);
  assert.equal(rebooted.registry().agents['ada-1'].officeCharacter, 'angela');
  assert.equal(rebooted.registry().agents['ada-1'].officeAccent, 'sky');
});

test('first write wins — backfill never overwrites a saved identity', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'ada-1', name: 'Ada', provider: 'claude', cwd: '/tmp' });

  assert.equal(hive.saveOfficeIdentity('ada-1', 'angela', 'sky'), true);
  // A later write-back (e.g. a recall that derived a fallback) must NOT
  // clobber the hire-time pick. This is the "never change a live agent's
  // icon as a side effect" rule, enforced at the single write point.
  assert.equal(hive.saveOfficeIdentity('ada-1', 'jim', 'lemon'), false, 'second write refused');
  assert.equal(hive.registry().agents['ada-1'].officeCharacter, 'angela');
  assert.equal(hive.registry().agents['ada-1'].officeAccent, 'sky');
});

test('unknown agent id is refused, not thrown', async (t) => {
  const { hive } = floor(t);
  assert.equal(hive.saveOfficeIdentity('ghost-1', 'angela', 'sky'), false);
});

test('carding an agent backfills its identity to the registry (write-back on sight)', () => {
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  cthCalls.length = 0;
  const { addAgent } = useStore.getState();
  addAgent({
    id: 'ada-1',
    name: 'Ada',
    character: 'angela',
    accent: 'sky',
    description: '',
    project: 'p',
    tmuxTarget: '',
    cwd: '/tmp',
    command: 'claude',
    status: 'idle',
    action: 'idle',
    progress: 0,
  });
  assert.deepEqual(
    cthCalls,
    [['ada-1', 'angela', 'sky']],
    'every carding (hire, recall, restore) offers its identity to the registry',
  );
  // Idempotent re-add must not double-fire: addAgent ignores known ids.
  addAgent({
    id: 'ada-1',
    name: 'Ada',
    character: 'angela',
    accent: 'sky',
    description: '',
    project: 'p',
    tmuxTarget: '',
    cwd: '/tmp',
    command: 'claude',
    status: 'idle',
    action: 'idle',
    progress: 0,
  });
  assert.equal(cthCalls.length, 1, 'duplicate carding is a no-op, not a second write-back');
});

test('recall broadcast carries the registry-saved identity', async () => {
  // recallAgentCore's deps harness, same shape as vacation-flow.test.cjs but
  // minimal for the one assertion that matters: notifySpawned's payload.
  let broadcast = null;
  const reg = {
    godId: 'michael',
    agents: {
      'vic-1': {
        id: 'vic-1',
        name: 'Vic',
        status: 'idle',
        lastSeen: 0,
        cwd: '/wt/vic',
        role: 'worker',
        vacation: true,
        officeCharacter: 'angela',
        officeAccent: 'sky',
      },
    },
  };
  const deps = {
    hiveEnabled: () => true,
    registry: () => reg,
    isOnVacation: () => true,
    ptyForAgent: () => undefined,
    recipe: { command: 'claude', cwd: '/wt/vic' },
    commandAvailable: () => true,
    pathExists: () => true,
    spawn: async () => ({ ok: true }),
    setVacation: () => true,
    setArchived: () => {},
    appendLog: () => {},
    notifySpawned: (e) => {
      broadcast = e;
    },
    log: () => {},
  };

  const res = await recallAgentCore(deps, 'vic-1');
  assert.equal(res.ok, true);
  assert.equal(broadcast.character, 'angela', 'saved sprite rides the recall broadcast');
  assert.equal(broadcast.accent, 'sky', 'saved accent rides the recall broadcast');
});

test('recall broadcast without a saved identity omits the fields', async () => {
  let broadcast = null;
  const reg = {
    godId: 'michael',
    agents: {
      'vic-1': {
        id: 'vic-1',
        name: 'Vic',
        status: 'idle',
        lastSeen: 0,
        cwd: '/wt/vic',
        vacation: true,
      },
    },
  };
  const deps = {
    hiveEnabled: () => true,
    registry: () => reg,
    isOnVacation: () => true,
    ptyForAgent: () => undefined,
    recipe: { command: 'claude', cwd: '/wt/vic' },
    commandAvailable: () => true,
    pathExists: () => true,
    spawn: async () => ({ ok: true }),
    setVacation: () => true,
    setArchived: () => {},
    appendLog: () => {},
    notifySpawned: (e) => {
      broadcast = e;
    },
    log: () => {},
  };

  await recallAgentCore(deps, 'vic-1');
  // Fields are undefined (absent), so the renderer's spawnIdentity falls
  // through to prior-row/derivation exactly as before.
  assert.equal(broadcast.character, undefined);
  assert.equal(broadcast.accent, undefined);
});
