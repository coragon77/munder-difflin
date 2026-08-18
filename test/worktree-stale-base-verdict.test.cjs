'use strict';

/**
 * Card agent-fired-worker-worktree-pr-2026-08-18 — the fired-worker worktree
 * verdicts (preserve-at-teardown, GC-after-integration) used to compare HEAD
 * against the LOCAL base branch. Under integrationMode workers/lean the live
 * checkout's branch is systematically stale, and the verdict is wrong in BOTH
 * directions:
 *  - stale-behind: work already merged + pushed to origin/main still measures
 *    ahead of the local branch → false "unintegrated" preserve (the observed
 *    incident: every lean-mode worker looked unintegrated),
 *  - stale-ahead: a local-only (un-pushed) merge measures ahead=0 against the
 *    local branch → false "integrated" remove/GC, hiding real loss.
 * The verdict now measures against origin/<base> (best-effort fetch first,
 * fall back to the local branch only when no remote-tracking ref exists).
 * This test covers BOTH directions plus the no-remote fallback.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { worktreeHasUnintegratedWork, worktreeIsGcSafe } = loadTs('src/main/git.ts');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd }).toString();
}
function gitId(cwd, ...args) {
  // identity-bearing git for commit-ish commands
  return git(cwd, '-c', 'user.email=t@t.local', '-c', 'user.name=t', ...args);
}
function commit(cwd, file, msg) {
  writeFileSync(join(cwd, file), `${msg} ${Math.random()}\n`);
  git(cwd, 'add', file);
  gitId(cwd, 'commit', '-q', '-m', msg);
}

/** bare origin.git + one "live checkout" repo with commit A on main, pushed. */
function makeNet() {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-stale-'));
  const origin = join(tmp, 'origin.git');
  const live = join(tmp, 'live');
  git(tmp, 'init', '--bare', '-q', '-b', 'main', origin);
  git(tmp, 'init', '-q', '-b', 'main', live);
  commit(live, 'a.txt', 'A');
  git(live, 'remote', 'add', 'origin', origin);
  git(live, 'push', '-q', 'origin', 'main');
  return { tmp, origin, live };
}

test('stale-behind local main: pushed work is NOT reported unintegrated', async (t) => {
  const { tmp, live } = makeNet();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // Worker worktree off main, one worker commit, merged + pushed to origin/main
  // FROM THE WORKTREE (the lean-mode flow) — the live checkout's local main
  // never advances and stays one commit behind.
  const wt = join(tmp, 'wt-behind');
  git(live, 'worktree', 'add', '-q', '-b', 'agent/behind', wt, 'main');
  commit(wt, 'work.txt', 'B');
  git(wt, 'push', '-q', 'origin', 'agent/behind:main'); // origin/main=B, local main=A
  assert.notEqual(
    git(live, 'rev-parse', 'main').trim(),
    git(live, 'rev-parse', 'origin/main').trim(),
    'precondition: local main is stale-behind origin/main',
  );

  const keep = await worktreeHasUnintegratedWork(wt, 'main');
  assert.equal(keep.keep, false, `integrated work must not be preserved (${keep.detail})`);
  const gc = await worktreeIsGcSafe(wt, 'main');
  assert.equal(gc.gc, true, `integrated work must be GC-safe (${gc.detail})`);
});

test('stale-ahead local main: un-pushed work IS reported unintegrated', async (t) => {
  const { tmp, live } = makeNet();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // Worker commit merged into LOCAL main but never pushed: origin/main lags.
  // The work exists ONLY in the live checkout — discarding it on a verdict of
  // "integrated" would lose it the moment that checkout is reset/lost.
  const wt = join(tmp, 'wt-ahead');
  git(live, 'worktree', 'add', '-q', '-b', 'agent/ahead', wt, 'main');
  commit(wt, 'work.txt', 'W');
  gitId(live, 'merge', '-q', 'agent/ahead'); // local main = A+W, origin/main = A
  assert.notEqual(
    git(live, 'rev-parse', 'main').trim(),
    git(live, 'rev-parse', 'origin/main').trim(),
    'precondition: local main is stale-ahead of origin/main',
  );

  const keep = await worktreeHasUnintegratedWork(wt, 'main');
  assert.equal(keep.keep, true, `un-pushed work must be preserved (${keep.detail})`);
  const gc = await worktreeIsGcSafe(wt, 'main');
  assert.equal(gc.gc, false, `un-pushed work must not be GC-safe (${gc.detail})`);
});

test('no remote: falls back to the local base branch (status quo)', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-stale-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const live = join(tmp, 'live');
  git(tmp, 'init', '-q', '-b', 'main', live);
  commit(live, 'a.txt', 'A');
  const wt = join(tmp, 'wt-local');
  git(live, 'worktree', 'add', '-q', '-b', 'agent/local', wt, 'main');
  commit(wt, 'work.txt', 'W');
  // Unmerged against the local base → keep.
  const before = await worktreeHasUnintegratedWork(wt, 'main');
  assert.equal(before.keep, true, before.detail);
  // Merged into the local base → integrated, GC-safe.
  gitId(live, 'merge', '-q', 'agent/local');
  const after = await worktreeHasUnintegratedWork(wt, 'main');
  assert.equal(after.keep, false, after.detail);
  const gc = await worktreeIsGcSafe(wt, 'main');
  assert.equal(gc.gc, true, gc.detail);
});
