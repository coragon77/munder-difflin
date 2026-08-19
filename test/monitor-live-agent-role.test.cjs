'use strict';

// LIVE FLOOR ROWS NEVER GOT THE REGISTRY ROLE
// (card agent-active-floor-agents-rend-2026-08-19)
//
// The boot stamp (useHive 5b') is ONE-SHOT: it fires when config loads and
// patches the rows that exist AT THAT MOMENT. But at every boot the live rows
// are RE-CREATED AFTER it — reconcileWithLivePtys drops pty rows whose
// terminals have not spawned yet (roster-backups, 2026-08-19T17:58: live []
// restorable 2), restoreTeam re-cards them from the restorable shelf, the god
// bootstrap deletes + rebuilds god's row — and each producer built its row
// from a payload that does not carry the registry role. Result, on disk: live
// rows role=null, archived rows role set (the shelf is never re-carded, so the
// stamp's archived-branch patch survives) — the exact asymmetry Stefan saw:
// VACATION shelf correct, ACTIVE floor reading "role: unknown".
//
// This file pins the fix: every producer of a live Agent row resolves
// identity from the REGISTRY — the same source the parked shelf resolves from
// — and rows with genuinely no role keep rendering the shared UNKNOWN_ROLE.
//
// Producers:
//  1. god bootstrap (useHive) — rebuilt row had NO role field at all;
//  2. restoreTeam (useRestoreTeam) — spread the stale role-less restorable
//     row while ALREADY holding the registry entry for the sprite;
//  3. spawn broadcast handler (useHive) — copies rec.role, but main's
//     spawnAgent broadcast sent `role: o.hive?.role` (undefined for restores/
//     restarts/revives) and the voice-unarchive broadcast sent no role;
//  4. AddAgentModal — correct already (role from the hire input); pinned so
//     it cannot regress silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

// ─── producer 1: the god bootstrap row ─────────────────────────────────────

test('god bootstrap: the rebuilt god Agent row carries the role (boot rebuild drops the stamped one)', () => {
  const src = read('src/renderer/src/hooks/useHive.ts');
  // Anchor to the boot god row: removeAgent(GOD_ID) clears the stamped row,
  // this object literal is the replacement that lands after the spawn.
  const m = src.match(/const god: Agent = \{([\s\S]*?)\n      \};/);
  assert.ok(m, 'god bootstrap row literal not found');
  assert.match(
    m[1],
    /role:\s*'orchestrator \(god\)'/,
    'god row must set its role — the boot rebuild runs AFTER the one-shot stamp, nothing else stamps it',
  );
});

// ─── producer 2: restoreTeam's restored row ────────────────────────────────

test('restoreTeam: the restored row takes its role from the registry entry, not the stale restorable row', () => {
  const src = read('src/renderer/src/hooks/useRestoreTeam.ts');
  // The spawn-success return object: {...a, character: …, accent: …, …}.
  const m = src.match(/return \{\s*\.\.\.a,([\s\S]*?)\n              \};/);
  assert.ok(m, 'restoreTeam restored-row literal not found');
  assert.match(
    m[1],
    /role:\s*entry\?\.role \?\? a\.role/,
    'restored row must resolve role from the registry entry (identity) with the row value as fallback',
  );
});

// ─── producer 3: main's spawn broadcasts ───────────────────────────────────

test('spawnAgent broadcast: role resolves registry-first, not from the spawn meta alone', () => {
  const src = read('src/main/index.ts');
  // The spawnAgent IPC handler broadcast. savedId is the registry entry read
  // just above it for the sprite — the registry is the durable identity the
  // parked shelf and the boot stamp resolve from.
  const m = src.match(/hive:agentSpawned', \{\s*\n\s*id: o\.id,([\s\S]*?)\n\s*\}\);/);
  assert.ok(m, 'spawnAgent broadcast not found');
  assert.match(
    m[1],
    /role:\s*savedId\?\.role \?\? o\.hive\?\.role/,
    'spawnAgent broadcast must carry the REGISTRY role (restores/restarts/revives send no meta role)',
  );
});

test('voice unarchive broadcast: the re-carded agent carries its registry role', () => {
  const src = read('src/main/index.ts');
  const m = src.match(
    /send\(archived \? 'hive:agentArchived' : 'hive:agentSpawned', \{([\s\S]*?)\n\s*\}\);/,
  );
  assert.ok(m, 'unarchive broadcast not found');
  assert.match(
    m[1],
    /role:\s*savedId\?\.role/,
    'unarchive re-card broadcast must carry the registry role (its payload had none)',
  );
});

// ─── producer 4: the UI hire already carries the typed role ────────────────

test('AddAgentModal hire row: role comes from the hire input (empty stays undefined → UNKNOWN_ROLE)', () => {
  const src = read('src/renderer/src/components/AddAgentModal.tsx');
  const m = src.match(/const agent: Agent = \{([\s\S]*?)\n\s*\};/);
  assert.ok(m, 'AddAgentModal hire row literal not found');
  assert.match(m[1], /role:\s*description\.trim\(\) \|\| undefined/);
});

// ─── the live/parked symmetry at store level (behavioral) ─────────────────

// store.ts reads window/localStorage at module load, so shim before requiring.
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
const { UNKNOWN_ROLE } = loadTs('src/shared/agentRole.ts');

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

test('live and parked rows resolve identity the same way: the stamp reaches both', () => {
  useStore.setState({
    agents: [agent('pam', { ptyId: 'pty-pam' })],
    archivedAgents: [agent('kevin')],
    restorableAgents: [],
  });
  const s = useStore.getState();
  // The boot stamp's exact calls: archive vacationers, then updateAgent(role)
  // for EVERY directory row — live rows via agents, parked rows via the
  // archived branch.
  s.updateAgent('pam', { role: 'Harness worker' });
  s.updateAgent('kevin', { role: 'Handles the merlin_tenant branch' });
  const after = useStore.getState();
  assert.equal(after.agents.find((a) => a.id === 'pam')?.role, 'Harness worker');
  assert.equal(
    after.archivedAgents.find((a) => a.id === 'kevin')?.role,
    'Handles the merlin_tenant branch',
  );
});

test('a row with genuinely no role keeps rendering the shared UNKNOWN_ROLE constant', () => {
  // The monitor identity line is `a.role?.trim() || UNKNOWN_ROLE` — pinned in
  // monitor-role-status.test.cjs. What can never happen: a producer INVENTING
  // a placeholder role. The store stamp writes exactly what the registry gave
  // it, and undefined stays undefined.
  useStore.setState({ agents: [agent('nobody')], archivedAgents: [], restorableAgents: [] });
  useStore.getState().updateAgent('nobody', { role: undefined });
  const row = useStore.getState().agents[0];
  assert.equal(row.role?.trim() || UNKNOWN_ROLE, UNKNOWN_ROLE);
});
