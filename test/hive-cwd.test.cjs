'use strict';

/**
 * Ingestion guarantee: whatever the user types, the hive registry stores an
 * ABSOLUTE cwd. A `~/…` entry used to land verbatim and then read
 * "not absolute" / cwdValid:false forever, so the agent could never spawn.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-cwd-'));
}

function registryOf(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8'));
}

test('a "~/…" cwd is expanded before it reaches the registry', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: '~' });

  const agent = registryOf(home).agents.a1;
  assert.equal(agent.cwd, os.homedir(), 'the registry must hold the resolved path');
  assert.equal(path.isAbsolute(agent.cwd), true);
  assert.equal(agent.cwdValid, true, 'the raw "~" is what made this false');
});

test('an absolute cwd is unchanged', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });

  const agent = registryOf(home).agents.a1;
  assert.equal(agent.cwd, home);
  assert.equal(agent.cwdValid, true);
});

test('cwdValidity repairs a "~" left in an older registry', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  // Entries written before the fix are still on disk; reading one must not
  // report it as permanently invalid.
  assert.equal(hive.cwdValidity('~').valid, true);
  assert.equal(
    hive.cwdValidity(path.join('~', 'definitely-not-here-xyz')).valid,
    false,
    'expansion must not paper over a genuinely missing directory',
  );
  assert.equal(
    hive.cwdValidity('relative/path').valid,
    false,
    'a relative path is still an error, not silently resolved',
  );
});

// ── role is identity: a respawn preserves the hired role ────────────────────
// Live defect 2026-08-16 (intern-chip-test): respawn paths echoed the renderer
// `description` (a live STATUS field — usePtyParser rewrites it to 'on standby')
// into the registry role, so a hired 'intern' became 'on standby' and the
// intern-scoped fire gate rejected him. ensureAgent must keep the prior role
// whenever the spawn meta carries none.

test('a respawn without a role preserves the hired role', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({
    id: 'intern-x',
    name: 'X',
    provider: 'claude',
    cwd: home,
    role: 'intern',
  });
  // Respawn with NO role (the restore path after the fix) — same identity.
  await hive.ensureAgent({ id: 'intern-x', name: 'X', provider: 'claude', cwd: home });

  const agent = registryOf(home).agents['intern-x'];
  assert.equal(agent.role, 'intern', 'role is identity — never defaulted over on respawn');
  assert.equal(agent.archived, false, 'a successful respawn still un-archives');
});

test('an explicit role still wins (re-hire can upgrade/set the role)', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'w1', name: 'W', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'w1', name: 'W', provider: 'claude', cwd: home, role: 'worker' });

  assert.equal(registryOf(home).agents.w1.role, 'worker');
});

test('a fresh agent with no role still defaults to agent', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'w2', name: 'W2', provider: 'claude', cwd: home });

  assert.equal(registryOf(home).agents.w2.role, 'agent');
});
