'use strict';

/**
 * Card agent-one-agent-per-directory--2026-08-19 — the one-agent-per-directory
 * guard must read WORKTREE STATE, not cwd string equality. The resolution
 * layer (physicalCheckout, git.ts) answers "which PHYSICAL CHECKOUT does this
 * seat belong to":
 *  - a seat at a SUBDIRECTORY of a checkout occupies the whole checkout (one
 *    working tree, one index — spawn cwd depth is not isolation),
 *  - a linked worktree is its OWN physical checkout (each worktree has its own
 *    working tree — the legitimate parallel case that must NOT be refused),
 *  - symlink aliases collapse onto the real checkout,
 *  - non-repo dirs fall back to realpath, nonexistent paths to the input.
 * Source-of-truth choice: git/fs read AT GUARD TIME (cannot go stale) — not
 * the registry isolate/worktree fields (nothing ever populates them; the
 * RegistryAgent type does not even declare them) and not `git worktree list`
 * (enumerates ONE repo's registrations, prune-stale entries included, while
 * the guard compares seats across many repos — show-toplevel gives each
 * seat's physical identity directly).
 *
 * Both god-mandated directions are pinned here at the decision-input level
 * (spawnAgentCore itself is not loadable outside Electron — floor-cap test
 * pattern): two seats in one checkout → findCheckoutOccupant refuses; a seat
 * in its own worktree → nobody blocks the base checkout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { physicalCheckout } = loadTs('src/main/git.ts');
const { findCheckoutOccupant, oneAgentPerDirectoryRefusal } = loadTs('src/main/hive.ts');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd }).toString();
}

/** A committed repo on `main` plus one linked worktree `wt/` and a subdirectory
 *  `backend/` inside the checkout — the three seat shapes the guard must tell
 *  apart. */
function makeRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'one-agent-'));
  const repo = join(tmp, 'repo');
  git(tmp, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, '-c', 'user.email=t@t.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'A');
  const wt = join(tmp, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/wt', wt, 'main');
  mkdirSync(join(repo, 'backend'));
  return { tmp, repo, wt };
}

test('a subdirectory seat occupies the WHOLE checkout', async (t) => {
  const { tmp, repo } = makeRepo();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  assert.equal(
    await physicalCheckout(join(repo, 'backend')),
    realpathSync(repo),
    'subdir seat must resolve to the checkout root',
  );
});

test('a linked worktree is its OWN physical checkout — the legitimate parallel case', async (t) => {
  const { tmp, repo, wt } = makeRepo();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  assert.equal(await physicalCheckout(wt), realpathSync(wt));
  assert.notEqual(
    await physicalCheckout(wt),
    await physicalCheckout(repo),
    'a worktree seat must NOT be the base checkout',
  );
});

test('a symlink alias collapses onto the real checkout', async (t) => {
  const { tmp, repo } = makeRepo();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const alias = join(tmp, 'repo-alias');
  symlinkSync(repo, alias);
  assert.equal(await physicalCheckout(alias), await physicalCheckout(repo));
});

test('non-repo falls back to realpath; a nonexistent path to the resolved input', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'one-agent-plain-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  assert.equal(await physicalCheckout(tmp), realpathSync(tmp));
  const gone = join(tmp, 'no', 'such', 'dir');
  assert.equal(await physicalCheckout(gone), gone);
});

// ── both directions at guard-decision level ──────────────────────────────

test('REFUSES: two seats in one physical checkout (subdir included)', async (t) => {
  const { tmp, repo } = makeRepo();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // jan in the checkout root, andy recalled into repo/backend — one working
  // tree between them. Seats normalized to their physical checkout, then the
  // guard's own pure comparison decides.
  const dirs = new Map([
    ['jan-1', await physicalCheckout(repo)],
    ['andy-1', await physicalCheckout(join(repo, 'backend'))],
  ]);
  assert.equal(
    findCheckoutOccupant(dirs, await physicalCheckout(repo), 'andy-1'),
    'jan-1',
    'a second non-isolated agent in the same checkout must find the holder',
  );
});

test('ALLOWS: an agent in its own worktree does NOT block the same project', async (t) => {
  const { tmp, repo, wt } = makeRepo();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dirs = new Map([['kevin-1', await physicalCheckout(wt)]]);
  assert.equal(
    findCheckoutOccupant(dirs, await physicalCheckout(repo)),
    null,
    'the base checkout is free when the only occupant sits in a worktree',
  );
  const dirs2 = new Map([['jan-1', await physicalCheckout(repo)]]);
  assert.equal(
    findCheckoutOccupant(dirs2, await physicalCheckout(wt)),
    null,
    'a worktree seat is free even when the base checkout is occupied',
  );
});

// ── the refusal names the holder and the way out ─────────────────────────

test('the refusal names holder, physical checkout, worktree escape and override', () => {
  const msg = oneAgentPerDirectoryRefusal(
    'jan-mszysp6k',
    '/opt/django/projects/diva',
    '/opt/django/projects/diva',
  );
  assert.match(msg, /jan-mszysp6k/, 'must name the holding agent');
  assert.match(msg, /\/opt\/django\/projects\/diva/, 'must name the physical checkout');
  assert.match(msg, /"isolate":\s*true/, 'must name the worktree escape');
  assert.match(msg, /allowSharedCwd/, 'must name the override');
  assert.match(msg, /ONLY on explicit operator instruction/, 'override stays operator-only');
  assert.match(msg, /park/i, 'must name freeing the holder (the recall-path escape)');
});
