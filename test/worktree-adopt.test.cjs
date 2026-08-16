'use strict';

/**
 * worktree-adopt (card vacation-worktree-leak-20260816).
 *
 * Live bug: parking an agent deliberately drops its worktreePaths/
 * worktreeOrigins entries (9d4c5ee — teardownPty's force-remove must not
 * delete a parked agent's worktree, the work IS the state). But the RECALL
 * re-enters the worktree by spawning isolate:false with cwd = the worktree
 * path, and spawnAgentCore only ever registers a worktree in its
 * isolate:true fresh-spawn branch. So after park→recall the worktree is
 * untracked forever: no later archive/kill/exit can remove it — the
 * directory plus its `git worktree` registration leak on disk until someone
 * prunes by hand (recoverable, but nothing GCs it). The same hole exists for
 * the post-restart restore and un-archive flows, which also spawn
 * isolate:false into the existing worktree.
 *
 * The fix: spawnAgentCore ADOPTS a re-entered worktree back into the maps —
 * a hive spawn whose cwd is a direct child of the harness worktrees root
 * gets re-registered, so park→recall→archive cleans up exactly like a
 * never-parked agent. The pure decision lives in worktreeAdopt.ts because
 * index.ts is the Electron main entry and untestable from this harness
 * (same extraction pattern as vacationBusy, parkedAgentIds).
 *
 * The chain test below runs the REAL git primitives the lifecycle uses
 * (addWorktree / mainRepoRoot / removeWorktree, from git.ts) — pinning that
 * the adopted origin is one from which teardown's removal actually works.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { shouldAdoptWorktree } = loadTs('src/main/worktreeAdopt.ts');
const { addWorktree, mainRepoRoot, removeWorktree, listWorktrees } = loadTs('src/main/git.ts');

// ——— the adoption decision (pure) ————————————————————————————————————————

test('isolate:true never adopts — the fresh-spawn branch owns worktree creation', () => {
  // Fresh spawns rewrite cwd to the worktree and register it themselves;
  // adopting here would double-register (or worse). Semantics unchanged.
  const wtRoot = resolve('/h/worktrees');
  assert.equal(shouldAdoptWorktree(true, join(wtRoot, 'ada'), wtRoot), false);
});

test('the recall/restore shape: isolate false + cwd directly under the worktrees root → adopt', () => {
  const wtRoot = resolve('/h/worktrees');
  assert.equal(shouldAdoptWorktree(false, join(wtRoot, 'ada'), wtRoot), true);
  // The pty:spawn default is opt-out, so recall-style explicit false and an
  // undefined flag behave the same for re-entry callers.
  assert.equal(shouldAdoptWorktree(undefined, join(wtRoot, 'ada'), wtRoot), true);
});

test("a cwd outside the worktrees root is never adopted — not the harness's worktree", () => {
  const wtRoot = resolve('/h/worktrees');
  assert.equal(shouldAdoptWorktree(false, resolve('/other/project'), wtRoot), false);
  assert.equal(shouldAdoptWorktree(false, resolve('/h/elsewhere'), wtRoot), false);
  // A different worktrees root (e.g. harnessHome moved) must not adopt either.
  assert.equal(shouldAdoptWorktree(false, join(wtRoot, 'ada'), resolve('/h2/worktrees')), false);
});

test('only DIRECT children match — the exact shape the fresh branch creates', () => {
  const wtRoot = resolve('/h/worktrees');
  // Nested deeper: an agent's cwd inside a worktree subdir is not the worktree.
  assert.equal(shouldAdoptWorktree(false, join(wtRoot, 'ada', 'src'), wtRoot), false);
  // The root itself is not a worktree.
  assert.equal(shouldAdoptWorktree(false, wtRoot, wtRoot), false);
});

test('path normalization: trailing separators and relative segments do not defeat the check', () => {
  const wtRoot = resolve('/h/worktrees');
  assert.equal(shouldAdoptWorktree(false, join(wtRoot, 'ada') + '/', wtRoot), true);
  assert.equal(shouldAdoptWorktree(false, join(wtRoot, '.', 'ada'), wtRoot), true);
});

// ——— the park → recall → archive chain, against real git ————————————————
// Uses the exact primitives the lifecycle uses: addWorktree (fresh spawn),
// mainRepoRoot (the origin adoption registers), removeWorktree (teardown's
// removal). Proves the adopted entry removes the worktree — and leaves no
// dangling `git worktree` registration behind.

function git(cwd, ...args) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('park→recall→archive: the adopted entry removes the worktree exactly like a never-parked agent', async () => {
  const base = mkdtempSync(join(tmpdir(), 'wtleak-base-'));
  const home = mkdtempSync(join(tmpdir(), 'wtleak-home-'));
  try {
    // Fresh spawn equivalent: a real repo with a real isolated worktree under
    // <harnessHome>/worktrees/<id>.
    git(base, 'init', '-b', 'main');
    writeFileSync(join(base, 'a.txt'), 'x');
    git(base, 'add', 'a.txt');
    git(base, 'commit', '-m', 'init');
    const wtRoot = join(home, 'worktrees');
    mkdirSync(wtRoot);
    const wtPath = join(wtRoot, 'ada');
    assert.ok((await addWorktree(base, wtPath, 'main')).ok, 'worktree provisioned');

    // PARK dropped the map entries (deliberate, 9d4c5ee) — nothing to test
    // there; the worktree must simply survive on disk.
    assert.ok(existsSync(wtPath), 'parked worktree survives');

    // RECALL: spawnAgentCore sees isolate:false + cwd = the worktree. The
    // adoption decision fires and the registered origin must be the MAIN
    // repo — the cwd from which `git worktree remove` actually works — not
    // the worktree itself.
    assert.equal(shouldAdoptWorktree(false, wtPath, wtRoot), true, 'recall re-entry adopts');
    const origin = await mainRepoRoot(wtPath);
    assert.ok(origin, 'mainRepoRoot resolves');
    assert.equal(resolve(origin), resolve(base), 'origin is the base repo, not the worktree');

    // ARCHIVE: teardown's removal with the adopted origin+path.
    const removed = await removeWorktree(origin, wtPath);
    assert.ok(removed.ok, `removeWorktree failed: ${removed.ok ? '' : removed.error}`);
    assert.equal(existsSync(wtPath), false, 'worktree directory is gone');
    const listed = await listWorktrees(base);
    assert.ok(Array.isArray(listed), `listWorktrees failed: ${JSON.stringify(listed)}`);
    assert.equal(
      listed.some((w) => resolve(w.path) === resolve(wtPath)),
      false,
      'no dangling git worktree registration',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
