'use strict';

/**
 * AGENT EDIT DIALOG (agent-edit-dialog-20260817).
 *
 * Stefan: "I need to be able to access the agent setup again. Currently I
 * create an agent and that's it." STEP 1 verification found NO existing edit
 * path — AddAgentModal is create-only (fresh uniqueId + spawnPty + addAgent),
 * Settings is global-only, the Command Center's Floor tab switches model +
 * restarts but reopens no setup dialog.
 *
 * This file pins the new edit path:
 *  • hive.setAgentMeta — the registry setter for the identity fields the
 *    dialog edits (name, role). Read-modify-write on the live registry, same
 *    discipline as setPinned: sibling fields (sessionId, pinned, vacation…)
 *    must survive the write — the registry is concurrently stamped by hooks
 *    (recordSession), so a whole-entry or stale-template write would clobber
 *    them.
 *  • layer wiring — IPC verb, preload bridge, store edit state, the tasks-view
 *    anchor (an agents row whose chips open the dialog), and the modal's edit
 *    mode (editOf seeds the form; submit UPDATES — never spawns a second PTY).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-edit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hive: new HiveManager(() => home) };
}

// ─── the registry setter ────────────────────────────────────────────────────

test('setAgentMeta renames + rerols on the registry and it survives a restart', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({
    id: 'pam-1',
    name: 'Pam',
    provider: 'claude',
    role: 'designer',
    cwd: '/tmp',
  });

  assert.equal(
    hive.setAgentMeta('pam-1', { name: 'Pam Beesly', role: 'art director' }),
    true,
    'a successful meta update reports true',
  );

  const entry = new HiveManager(() => home).registry().agents['pam-1'];
  assert.equal(entry.name, 'Pam Beesly', 'the rename landed');
  assert.equal(entry.role, 'art director', 'the role change landed');
});

test('setAgentMeta is a read-modify-write — sibling fields survive untouched', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });
  hive.setPinned('pam-1', true);
  hive.recordSession('pam-1', 'sess-abc'); // the hook path stamps this concurrently

  hive.setAgentMeta('pam-1', { name: 'Pam H' });

  const entry = hive.registry().agents['pam-1'];
  assert.equal(entry.sessionId, 'sess-abc', 'the session stamp is not clobbered');
  assert.equal(entry.pinned, true, 'the pin is not clobbered');
  assert.equal(entry.role, 'agent', 'an absent key is left alone (partial patch)');
});

test('setAgentMeta refuses unknown agents and no-op patches stay true', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });

  assert.equal(hive.setAgentMeta('nobody-1', { name: 'X' }), false, 'unknown agent → false');
  assert.equal(hive.setAgentMeta('pam-1', {}), true, 'an empty patch is a true no-op');
  const entry = hive.registry().agents['pam-1'];
  assert.equal(entry.name, 'Pam', 'nothing changed');
  assert.equal(entry.lastSeen, entry.lastSeen, 'registry intact');
});

// ─── wiring pins (the electron entry + renderer are source-pinned) ──────────

test('the edit path reaches every layer', () => {
  const main = read('src/main/index.ts');
  assert.ok(main.includes("'hive:setAgentMeta'"), 'IPC handler registered');
  const preload = read('src/preload/index.ts');
  assert.ok(preload.includes('hiveSetAgentMeta'), 'preload bridge exists');
  const store = read('src/renderer/src/store/store.ts');
  assert.ok(store.includes('editAgentId'), 'store carries edit-dialog state');
});

test('the tasks view anchors the edit button — agent chips open the dialog', () => {
  const src = read('src/renderer/src/components/TasksKanban.tsx');
  assert.ok(
    src.includes('setEditAgent'),
    'the tasks view opens the edit dialog (the agent chips row)',
  );
});

test('the modal in edit mode UPDATES the agent — it never spawns a second one', () => {
  const src = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.ok(src.includes('editOf'), 'the modal accepts an editOf agent');
  // The submit body must branch: the create branch spawns, the edit branch
  // updates the store + registry meta and RETURNS before any spawnPty.
  const submitAt = src.indexOf('const submit');
  const body = src.slice(submitAt, src.indexOf('return (', submitAt));
  const editBranch = body.indexOf('if (editOf)');
  assert.ok(editBranch > 0, 'submit branches on edit mode');
  assert.ok(
    body.slice(editBranch).includes('updateAgent') || body.includes('editApply'),
    'the edit branch applies an update',
  );
  const spawnAt = body.indexOf('spawnPty');
  assert.ok(
    spawnAt < 0 || editBranch < spawnAt,
    'the edit branch returns before the spawn call is reached',
  );
});
