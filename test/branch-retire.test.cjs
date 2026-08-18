'use strict';

/**
 * Card agent-archive-tag-the-5-delete-2026-08-18 — automatic branch retirement
 * at app start. Cherry-pick batches leave source branches forever-unmerged in
 * ref terms; retireLandedBranches (src/main/branchRetire.ts) retires a branch
 * ONLY on an exact proof (P1 tree-equality / P2 reverse-apply against a temp
 * index), archive-tag-FIRST (no delete before the recovery tag is pushed),
 * never a worktree-held tip, never main, never a merged-tip ancestor branch,
 * and LEAVES + SAYS anything unproven. These tests build REAL scratch repos
 * (bare origin + clone, real fetch/merge-base/diff/tag) and only the PUSHES
 * are recorded, never executed — deleting test remotes proves nothing.
 *
 * The manual sweep this automates (card agent-clean-up-stale-origin-br-2026-08-18)
 * is the spec: patch-id lied both directions, so the refusal paths below are
 * the point of the module, not its edge cases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { retireLandedBranches, archiveTagFor } = loadTs('src/main/branchRetire.ts');

// ── scratch repo helpers (real git; only pushes are recorded) ───────────────

function git(repo, ...args) {
  const env =
    args.length && args[args.length - 1] instanceof Object && !Array.isArray(args[args.length - 1])
      ? args.pop()
      : undefined;
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
}

/** Bare origin + clone whose `origin` remote is that bare repo. */
function makeRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'branch-retire-'));
  const origin = join(tmp, 'origin.git');
  const work = join(tmp, 'work');
  mkdirSync(origin);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, work);
  git(work, 'config', 'user.email', 'test@harness');
  git(work, 'config', 'user.name', 'test');
  return { tmp, origin, work };
}

function commitFile(repo, path, content, message, env = {}) {
  const full = join(repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(repo, 'add', path);
  git(repo, 'commit', '-qm', message, env);
}

/** Push `ref` and update the remote-tracking refs the module reads. */
function pushRef(repo, ref) {
  git(repo, 'push', '-q', 'origin', ref);
  git(repo, 'fetch', '-q', 'origin');
}

/** The module's real git runner, plus a recorder for every push. */
function makeDeps() {
  const pushes = [];
  const deps = {
    today: '2026-08-18',
    push: async (_cwd, _args) => {
      pushes.push(_args);
      return { ok: true, stdout: '' };
    },
  };
  return { deps, pushes };
}

/** A landing on main whose commit sha differs from the branch's (different
 *  parent or committer date) while its content matches — the exact shape of a
 *  cherry-pick batch landing. Tests construct these explicitly: cherry-picking
 *  onto an UNMOVED merge-base reproduces the identical sha, which turns the
 *  branch into a plain ancestor (mergedTips) and retires nothing. */

// ── the refusal cases (the point of the module) ─────────────────────────────

test('WEAK SIGNAL: branch with unique content is left alone — no tag, no delete, reason stated', async () => {
  const { work } = makeRepo();
  commitFile(work, 'f.txt', 'base\n', 'base');
  pushRef(work, 'main');
  git(work, 'checkout', '-qb', 'feat/unique');
  commitFile(work, 'unique.txt', 'genuinely new work\n', 'unique');
  pushRef(work, 'feat/unique');
  git(work, 'checkout', '-q', 'main'); // leave no worktree on the branch tip

  const { deps, pushes } = makeDeps();
  const res = await retireLandedBranches(work, deps);

  assert.equal(res.ran, true);
  assert.equal(res.retired.length, 0, 'nothing may be retired on unproven content');
  assert.equal(pushes.length, 0, 'no push of any kind — no tag, no delete');
  assert.equal(res.heldWorktree.length, 0, 'no worktree holds it — it is UNPROVEN, not held');
  assert.ok(res.unproven.some((u) => u.branch === 'feat/unique' && /not proven/.test(u.reason)));
  let threw = false;
  try {
    git(work, 'rev-parse', '-q', '--verify', 'refs/tags/archive/feat/unique');
  } catch {
    threw = true; // rev-parse exits nonzero when the tag does not exist
  }
  assert.ok(threw, 'no archive tag may be created for unproven content');
});

test('DRIFTED CHERRY-PICK (the 907/911 case): landed-but-rewritten content → left, not deleted', async () => {
  const { work } = makeRepo();
  commitFile(work, 'f.txt', 'base\n', 'base');
  pushRef(work, 'main');
  // Branch appends three lines…
  git(work, 'branch', 'feat/drifted', 'main');
  git(work, 'checkout', '-q', 'feat/drifted');
  commitFile(work, 'f.txt', 'base\nAAA\nBBB\nCCC\n', 'the change', {
    GIT_COMMITTER_DATE: '2026-08-18T11:00:00',
  });
  pushRef(work, 'feat/drifted');
  // …main lands it REWRITTEN (one line consolidated — the doc-comment case):
  git(work, 'checkout', '-q', 'main');
  commitFile(work, 'f.txt', 'base\nAAA\nBBB(rewritten)\nCCC\n', 'landed differently', {
    GIT_COMMITTER_DATE: '2026-08-18T12:00:00',
  });
  pushRef(work, 'main');

  const { deps, pushes } = makeDeps();
  const res = await retireLandedBranches(work, deps);

  // 90% landed is NOT landed — neither exact proof sees through the rewrite,
  // and the honest default is LEAVE + SAY, never delete.
  assert.equal(res.retired.length, 0);
  assert.equal(pushes.length, 0);
  assert.ok(res.unproven.some((u) => u.branch === 'feat/drifted'));
});

// ── the proof cases (exact landings retire) ─────────────────────────────────

test('REVERSE-APPLY: exact cherry-pick landing retires — tag created at tip, tag pushed BEFORE delete', async () => {
  const { work } = makeRepo();
  commitFile(work, 'f.txt', 'base\n', 'base');
  pushRef(work, 'main');
  git(work, 'branch', 'feat/fresh', 'main');
  // Main advances FIRST (different parent ⇒ the landing gets a different sha).
  commitFile(work, 'other.txt', 'main advanced\n', 'advance', {
    GIT_COMMITTER_DATE: '2026-08-18T10:00:00',
  });
  pushRef(work, 'main');
  git(work, 'checkout', '-q', 'feat/fresh');
  commitFile(work, 'f.txt', 'base\nlanded line\n', 'the change', {
    GIT_COMMITTER_DATE: '2026-08-18T11:00:00',
  });
  pushRef(work, 'feat/fresh');
  git(work, 'checkout', '-q', 'main');
  commitFile(work, 'f.txt', 'base\nlanded line\n', 'the landing', {
    GIT_COMMITTER_DATE: '2026-08-18T12:00:00',
  });
  pushRef(work, 'main');
  const tip = git(work, 'rev-parse', 'origin/feat/fresh').trim();

  const { deps, pushes } = makeDeps();
  const res = await retireLandedBranches(work, deps);

  assert.equal(res.retired.length, 1);
  const r = res.retired[0];
  assert.equal(r.branch, 'feat/fresh');
  assert.equal(r.tip, tip);
  assert.equal(r.tag, archiveTagFor('feat/fresh'));
  // other.txt lives only on main → trees differ → P1 cannot hold; the claim
  // reverse-applies onto main's current tree → P2 is the deterministic proof.
  assert.equal(r.proof, 'reverse-apply');
  // Order pins the safety property: the archive push precedes the delete.
  assert.equal(pushes.length, 2);
  assert.ok(pushes[0].join(' ').includes('archive/feat/fresh'));
  assert.deepEqual(pushes[1], ['push', 'origin', '--delete', 'feat/fresh']);
  // The recovery ref REALLY exists locally at the branch tip.
  assert.equal(git(work, 'rev-parse', `refs/tags/${r.tag}^{}`).trim(), tip);
});

test('TREE-EQUALITY: landing followed by unrelated main advance retires via the historical tree', async () => {
  const { work } = makeRepo();
  commitFile(work, 'f.txt', 'base\n', 'base');
  pushRef(work, 'main');
  git(work, 'branch', 'feat/hist', 'main');
  git(work, 'checkout', '-q', 'feat/hist');
  commitFile(work, 'f.txt', 'base\nlanded line\n', 'the change', {
    GIT_COMMITTER_DATE: '2026-08-18T11:00:00',
  });
  pushRef(work, 'feat/hist');
  // Main lands the SAME content (same tree as the branch, different sha)…
  git(work, 'checkout', '-q', 'main');
  commitFile(work, 'f.txt', 'base\nlanded line\n', 'the landing', {
    GIT_COMMITTER_DATE: '2026-08-18T12:00:00',
  });
  // …then advances PAST the landing, so the branch tree matches only the
  // HISTORICAL main tree (the brand-refresh shape).
  commitFile(work, 'later.txt', 'main moved on\n', 'advance', {
    GIT_COMMITTER_DATE: '2026-08-18T13:00:00',
  });
  pushRef(work, 'main');

  const { deps, pushes } = makeDeps();
  const res = await retireLandedBranches(work, deps);

  assert.equal(res.retired.length, 1);
  assert.equal(res.retired[0].branch, 'feat/hist');
  assert.equal(res.retired[0].proof, 'tree-equality');
  assert.equal(pushes.length, 2);
});

// ── the guards (never-touch rules) ──────────────────────────────────────────

test('WORKTREE-HELD: a branch checked out in a live worktree is never retired, even when provably landed', async () => {
  const { tmp, work } = makeRepo();
  commitFile(work, 'f.txt', 'base\n', 'base');
  pushRef(work, 'main');
  git(work, 'branch', 'feat/held', 'main');
  commitFile(work, 'other.txt', 'x\n', 'advance', { GIT_COMMITTER_DATE: '2026-08-18T10:00:00' });
  pushRef(work, 'main');
  git(work, 'checkout', '-q', 'feat/held');
  commitFile(work, 'f.txt', 'base\nlanded line\n', 'the change', {
    GIT_COMMITTER_DATE: '2026-08-18T11:00:00',
  });
  pushRef(work, 'feat/held');
  git(work, 'checkout', '-q', 'main');
  commitFile(work, 'f.txt', 'base\nlanded line\n', 'the landing', {
    GIT_COMMITTER_DATE: '2026-08-18T12:00:00',
  });
  pushRef(work, 'main');
  // A live worktree sits on the branch tip (kelly/meredith situation).
  git(work, 'worktree', 'add', '-q', join(tmp, 'holder'), 'feat/held');

  const { deps, pushes } = makeDeps();
  const res = await retireLandedBranches(work, deps);

  assert.equal(res.retired.length, 0);
  assert.equal(pushes.length, 0);
  assert.ok(res.heldWorktree.includes('feat/held'));
  rmSync(join(tmp, 'holder'), { recursive: true, force: true });
});

test('STALE TAG GUARD: an archive tag already existing at a DIFFERENT commit blocks retirement', async () => {
  const { work } = makeRepo();
  commitFile(work, 'f.txt', 'base\n', 'base');
  pushRef(work, 'main');
  git(work, 'branch', 'feat/tagged', 'main');
  commitFile(work, 'other.txt', 'x\n', 'advance', { GIT_COMMITTER_DATE: '2026-08-18T10:00:00' });
  pushRef(work, 'main');
  git(work, 'checkout', '-q', 'feat/tagged');
  commitFile(work, 'f.txt', 'base\nlanded line\n', 'the change', {
    GIT_COMMITTER_DATE: '2026-08-18T11:00:00',
  });
  pushRef(work, 'feat/tagged');
  git(work, 'checkout', '-q', 'main');
  commitFile(work, 'f.txt', 'base\nlanded line\n', 'the landing', {
    GIT_COMMITTER_DATE: '2026-08-18T12:00:00',
  });
  pushRef(work, 'main');
  // A pre-existing archive tag pointing somewhere else → human must look.
  git(work, 'tag', '-a', archiveTagFor('feat/tagged'), 'main', '-m', 'old tag at wrong commit');

  const { deps, pushes } = makeDeps();
  const res = await retireLandedBranches(work, deps);

  assert.equal(res.retired.length, 0);
  assert.equal(pushes.length, 0);
  assert.ok(
    res.unproven.some((u) => u.branch === 'feat/tagged' && /different commit/.test(u.reason)),
  );
});

test('MERGED-TIP + MAIN: ancestor tips and main itself are out of scope — untouched, counted', async () => {
  const { work } = makeRepo();
  commitFile(work, 'f.txt', 'base\n', 'base');
  pushRef(work, 'main');
  // An old release branch fully contained in main (tip IS an ancestor).
  git(work, 'branch', 'release/old');
  pushRef(work, 'release/old');
  commitFile(work, 'f.txt', 'base\nmain advanced\n', 'advance');
  pushRef(work, 'main');

  const { deps, pushes } = makeDeps();
  const res = await retireLandedBranches(work, deps);

  assert.equal(res.ran, true);
  assert.equal(res.mergedTips, 1, 'ancestor tip is counted, not deleted');
  assert.equal(res.retired.length, 0);
  assert.equal(pushes.length, 0, 'wholesale release/* deletion is an operator call, not ours');
});

test('NO-DELETE-WITHOUT-ARCHIVE: a failed tag push refuses the remote delete', async () => {
  const { work } = makeRepo();
  commitFile(work, 'f.txt', 'base\n', 'base');
  pushRef(work, 'main');
  git(work, 'branch', 'feat/pushtagfails', 'main');
  commitFile(work, 'other.txt', 'x\n', 'advance', { GIT_COMMITTER_DATE: '2026-08-18T10:00:00' });
  pushRef(work, 'main');
  git(work, 'checkout', '-q', 'feat/pushtagfails');
  commitFile(work, 'f.txt', 'base\nlanded line\n', 'the change', {
    GIT_COMMITTER_DATE: '2026-08-18T11:00:00',
  });
  pushRef(work, 'feat/pushtagfails');
  git(work, 'checkout', '-q', 'main');
  commitFile(work, 'f.txt', 'base\nlanded line\n', 'the landing', {
    GIT_COMMITTER_DATE: '2026-08-18T12:00:00',
  });
  pushRef(work, 'main');

  const deps = {
    today: '2026-08-18',
    push: async (_cwd, args) =>
      args.includes('--delete')
        ? { ok: false, error: 'must not be reached' }
        : { ok: false, error: 'network down' }, // tag push FAILS
  };
  const res = await retireLandedBranches(work, deps);

  assert.equal(res.retired.length, 0);
  assert.ok(
    res.failed.some((f) => f.branch === 'feat/pushtagfails' && /delete refused/.test(f.reason)),
  );
});

// ── the contract (never throws; says when it can't run) ─────────────────────

test('non-repo / no origin: returns ran:false with a reason, never throws', async () => {
  const bogus = join(mkdtempSync(join(tmpdir(), 'branch-retire-norepo-')), 'empty');
  mkdirSync(bogus);
  const res = await retireLandedBranches(bogus, makeDeps().deps);
  assert.equal(res.ran, false);
  assert.ok(res.reason);
});

test('index.ts wires the step at app start, fire-and-forget beside the graph refresh', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.ok(/void retireLandedBranches\(app\.getAppPath\(\)\);/.test(src));
  assert.ok(/import \{ retireLandedBranches \} from '\.\/branchRetire';/.test(src));
});
