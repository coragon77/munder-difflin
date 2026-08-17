'use strict';

/**
 * Card agent-harness-worktree-creatio-2026-08-17 — worktrees ship without
 * node_modules, and until now every worker hand-symlinked the live checkout's
 * node_modules in (e.g. /opt/munder-difflin/node_modules). The provisioning
 * now lives in the worktree-CREATION path:
 *  - linkNodeModules (git.ts) — best-effort symlink wt/node_modules →
 *    <main checkout>/node_modules; never clobbers an existing entry, never
 *    leaves a dangling link when the main checkout has no node_modules
 *  - addWorktree (git.ts) — calls it after a successful `git worktree add`,
 *    resolved via mainRepoRoot (the live checkout of the family)
 *
 * The integration test builds a REAL git repo in a temp dir and runs the full
 * addWorktree path — a freshly created worktree must have working node_modules
 * with zero manual steps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, symlinkSync, readlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { addWorktree, linkNodeModules } = loadTs('src/main/git.ts');

/** A temp dir with a real git repo (one commit on main) + node_modules/marker. */
function makeRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-nm-'));
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-b', 'main', '-q']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t.local', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init', '-q']);
  mkdirSync(join(repo, 'node_modules'));
  writeFileSync(join(repo, 'node_modules', 'marker'), 'live');
  return { tmp, repo };
}

test.after(() => {
  // tmp dirs are reclaimed by the OS; nothing to do, placeholder for symmetry
});

// ── integration: the full creation path ────────────────────────────────────

test('a freshly created worktree gets a working node_modules symlink (zero manual steps)', async () => {
  const { tmp, repo } = makeRepo();
  try {
    const wtPath = join(tmp, 'worktrees', 'agent-x');
    mkdirSync(dirname(wtPath), { recursive: true });
    const res = await addWorktree(repo, wtPath, 'main');
    assert.equal(res.ok, true, `addWorktree must succeed: ${res.error ?? ''}`);
    const st = lstatSync(join(wtPath, 'node_modules'));
    assert.equal(st.isSymbolicLink(), true, 'node_modules must be a symlink');
    assert.equal(readlinkSync(join(wtPath, 'node_modules')), join(repo, 'node_modules'), 'must point at the main checkout');
    assert.equal(readFileSync(join(wtPath, 'node_modules', 'marker'), 'utf8'), 'live', 'modules readable through the link');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('addWorktree still succeeds when the main checkout has no node_modules (no dangling link)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-nm-'));
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-b', 'main', '-q']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t.local', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init', '-q']);
  try {
    const wtPath = join(tmp, 'worktrees', 'agent-y');
    mkdirSync(dirname(wtPath), { recursive: true });
    const res = await addWorktree(repo, wtPath, 'main');
    assert.equal(res.ok, true, 'spawn-blocking would regress provisioning to a hard dependency');
    const entries = lstatSync(join(wtPath, 'node_modules'));
    assert.ok(false, `node_modules must not exist: ${entries}`);
  } catch (e) {
    assert.match(e.code ?? '', /ENOENT/, 'expected ENOENT — no node_modules entry at all');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── linkNodeModules unit behavior ──────────────────────────────────────────

test('never clobbers an existing node_modules (pre-linked worktree or own install)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-nm-'));
  try {
    const mainRoot = join(tmp, 'main');
    const wt = join(tmp, 'wt');
    mkdirSync(join(mainRoot, 'node_modules'), { recursive: true });
    mkdirSync(join(wt, 'node_modules'), { recursive: true });
    writeFileSync(join(wt, 'node_modules', 'own'), 'mine');
    const res = await linkNodeModules(wt, mainRoot);
    assert.equal(res.linked, false, 'must skip, not replace');
    assert.equal(readFileSync(join(wt, 'node_modules', 'own'), 'utf8'), 'mine', 'own install untouched');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('skips (ok, unlinked) when the main checkout has no node_modules', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-nm-'));
  try {
    const mainRoot = join(tmp, 'main');
    const wt = join(tmp, 'wt');
    mkdirSync(mainRoot, { recursive: true });
    mkdirSync(wt, { recursive: true });
    const res = await linkNodeModules(wt, mainRoot);
    assert.equal(res.linked, false);
    let saw = true;
    try {
      lstatSync(join(wt, 'node_modules'));
    } catch {
      saw = false;
    }
    assert.equal(saw, false, 'no entry — no dangling symlink');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('leaves an already-provisioned symlink alone (idempotent re-run)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-nm-'));
  try {
    const mainRoot = join(tmp, 'main');
    const wt = join(tmp, 'wt');
    mkdirSync(join(mainRoot, 'node_modules'), { recursive: true });
    mkdirSync(wt, { recursive: true });
    symlinkSync(join(mainRoot, 'node_modules'), join(wt, 'node_modules'));
    const res = await linkNodeModules(wt, mainRoot);
    assert.equal(res.linked, false, 'existing link is not replaced');
    assert.equal(readlinkSync(join(wt, 'node_modules')), join(mainRoot, 'node_modules'), 'original target kept');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
