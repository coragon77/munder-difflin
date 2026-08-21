'use strict';

/**
 * hive-retarget (card agent-no-primitive-can-change--2026-08-21): the ONLY
 * writer of an agent's registry cwd. Before it, no primitive could change a
 * registered cwd — a mis-registered agent (Robert/Mose both registered on the
 * physical checkout instead of their worktrees) stayed mis-registered forever,
 * and a recall of either hit the one-agent-per-directory refusal.
 *
 * Shape decided on the card (god's open questions, answered):
 *  (a) PARKED-ONLY — a live pane keeps working in its old cwd; rewriting the
 *      registry under it makes the registry lie about where the live agent
 *      actually is, and the spawn guard would stop seeing the real conflict.
 *  (b) target must be an ABSOLUTE EXISTING DIRECTORY, and must not belong to
 *      another LIVE agent's PHYSICAL CHECKOUT — the same identity the spawn
 *      guard compares (subdir/symlink alias of a live seat = same conflict,
 *      refused NOW instead of at recall time).
 *  (c) POINTER-ONLY — the CLI never creates a worktree; god creates it.
 *
 * Everything is exercised by RUNNING the emitted script against a fixture
 * HIVE_ROOT (FIXTURES ONLY — never the live floor's registry).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const POSIX = process.platform !== 'win32';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-retarget-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const cli = path.join(home, 'hive', 'bin', 'hive-retarget');
  const registryPath = path.join(home, 'hive', 'registry.json');
  const env = { ...process.env, HIVE_ROOT: path.join(home, 'hive') };
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const runFail = (...args) => {
    try {
      run(...args);
      return { code: 0, stderr: '' };
    } catch (e) {
      return { code: e.status ?? -1, stderr: String(e.stderr ?? '') };
    }
  };
  const registry = () => JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const seed = (id, fields) => {
    const reg = registry();
    reg.agents[id] = {
      id,
      name: id,
      role: 'worker',
      status: 'idle',
      lastSeen: 0,
      cwd: fields.cwd,
      ...fields,
    };
    fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  };
  return { home, hive, cli, registryPath, env, run, runFail, registry, seed };
}

test('ensureHive ships an executable hive-retarget in hive/bin', { skip: !POSIX }, (t) => {
  const s = setup(t);
  assert.ok(fs.existsSync(s.cli), 'hive-retarget exists in <hive>/bin');
  assert.equal(fs.statSync(s.cli).mode & 0o777, 0o755, 'it is executable');
});

test("happy path: a parked agent's cwd changes and cwdValid is stamped", { skip: !POSIX }, (t) => {
  const s = setup(t);
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-old-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-new-'));
  s.seed('robert-1', { cwd: dirA, vacation: true, archived: true, vacationSince: 1 });

  const out = s.run('robert-1', dirB);
  const entry = s.registry().agents['robert-1'];
  assert.equal(entry.cwd, dirB, 'registry cwd is the new directory');
  assert.equal(entry.cwdValid, true, 'cwdValid reflects the validated target');
  assert.match(out, /robert-1/, 'receipt names the agent');
  assert.match(
    out,
    new RegExp(dirA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'receipt shows the old cwd',
  );
  assert.match(out, /hive-recall/, 'receipt points at the recall');
});

test('refusal: unknown agent id', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-dir-'));
  const r = s.runFail('ghost-1', dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no agent "ghost-1"/);
});

test('refusal: a non-parked (live) agent is never retargeted', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-b-'));
  s.seed('mose-1', { cwd: dirA }); // live: no vacation flag
  const r = s.runFail('mose-1', dirB);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not parked/, 'names the parked-only rule');
  assert.match(r.stderr, /hive-park/, 'names the escape: park first');
  assert.equal(s.registry().agents['mose-1'].cwd, dirA, 'refusal wrote nothing');
});

test('refusal: a retired (fired) agent is never retargeted', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-b-'));
  s.seed('intern-1', { cwd: dirA, retired: true, role: 'intern' });
  const r = s.runFail('intern-1', dirB);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /fired|retired/);
});

test('refusal: a relative path is not absolute', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-a-'));
  s.seed('robert-1', { cwd: dir, vacation: true, archived: true });
  const r = s.runFail('robert-1', 'some/relative/dir');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /absolute/);
});

test('refusal: a path that does not exist (pointer-only primitive)', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-a-'));
  const missing = path.join(dir, 'worktrees', 'not-created-yet');
  s.seed('robert-1', { cwd: dir, vacation: true, archived: true });
  const r = s.runFail('robert-1', missing);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /does not exist/, 'names the missing directory');
  assert.match(r.stderr, /pointer-only|create/, 'says the CLI does not create it');
});

test('refusal: a path that is a file, not a directory', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-a-'));
  const file = path.join(dir, 'a-file.txt');
  fs.writeFileSync(file, 'x', 'utf8');
  s.seed('robert-1', { cwd: dir, vacation: true, archived: true });
  const r = s.runFail('robert-1', file);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not a directory/);
});

test('refusal: a live agent occupies the target physical checkout (subdir seat)', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-old-'));
  // A real git repo with a subdirectory: physicalCheckout collapses the subdir
  // onto the repo root — the same identity the spawn guard compares.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-repo-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init'], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  s.seed('holder-1', { cwd: repo }); // LIVE agent seated in the repo checkout
  s.seed('mose-1', { cwd: oldDir, vacation: true, archived: true });

  const r = s.runFail('mose-1', path.join(repo, 'src'));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /one agent per directory/, 'reuses the invariant vocabulary');
  assert.match(r.stderr, /holder-1/, 'names the occupying agent');
  assert.equal(s.registry().agents['mose-1'].cwd, oldDir, 'refusal wrote nothing');
});

test("occupied-check uses LIVE agents only: a parked agent's seat does not block", {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-old-'));
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-shared-'));
  s.seed('parked-holder', { cwd: shared, vacation: true, archived: true });
  s.seed('mose-1', { cwd: oldDir, vacation: true, archived: true });
  const out = s.run('mose-1', shared);
  assert.equal(s.registry().agents['mose-1'].cwd, shared, 'retarget lands');
  assert.match(out, /retargeted/);
});

test('idempotent: already registered at the target is a no-op success', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-a-'));
  s.seed('robert-1', { cwd: dir, vacation: true, archived: true });
  const out = s.run('robert-1', dir);
  assert.match(out, /already/);
  assert.equal(s.registry().agents['robert-1'].cwd, dir);
});

test("a worktree target beside a live agent's checkout is ALLOWED (the Robert/Mose fix)", {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  // Reproduce the observable: a live agent wrongly registered on the physical
  // checkout, a second parked agent that should live in its own worktree.
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-checkout-'));
  execFileSync('git', ['-C', checkout, 'init', '-q']);
  execFileSync('git', ['-C', checkout, 'commit', '--allow-empty', '-q', '-m', 'init'], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  const worktree = path.join(os.tmpdir(), `md-rt-wt-${Date.now()}-${process.pid}`);
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '--detach', worktree]);
  t.after(() => {
    try {
      execFileSync('git', ['-C', checkout, 'worktree', 'remove', '--force', worktree]);
    } catch {
      /* best-effort cleanup */
    }
  });
  s.seed('robert-1', { cwd: checkout }); // live, seated in the checkout
  s.seed('mose-1', { cwd: checkout, vacation: true, archived: true }); // parked, mis-registered

  s.run('mose-1', worktree);
  assert.equal(s.registry().agents['mose-1'].cwd, worktree, 'pointer moves to the worktree');
  assert.equal(s.registry().agents['robert-1'].cwd, checkout, 'the live agent is untouched');
});

test('the write preserves sibling registry entries and stays JSON-atomic', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rt-b-'));
  s.seed('bystander-1', { cwd: dirA, sessionId: 'keep-me' });
  s.seed('robert-1', { cwd: dirA, vacation: true, archived: true });

  s.run('robert-1', dirB);
  const reg = s.registry();
  assert.equal(
    reg.agents['bystander-1'].sessionId,
    'keep-me',
    'sibling entries survive the read-modify-write',
  );
  assert.equal(Object.keys(reg.agents).length, 2, 'no phantom entries');
});

test('usage: wrong arity is refused', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const r = s.runFail('only-one-arg');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage/);
});
