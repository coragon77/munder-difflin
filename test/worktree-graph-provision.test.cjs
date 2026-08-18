'use strict';

/**
 * Card agent-fix-2-provision-a-warm-g-2026-08-18 — graphify-out/ is gitignored
 * (.gitignore), so a fresh worktree ships without a graph while its TRACKED
 * AGENTS.md still tells the worker to `graphify query` first — a dead pointer
 * for graph-less workers (the 2.43M-token grep fallback mode). Provisioning
 * now lives next to the node_modules precedent in the worktree-CREATION path:
 *  - copyProjectGraph (git.ts) — best-effort COPY of the main checkout's
 *    graphify-out FUNCTIONAL SET (graph.json, manifest.json,
 *    .graphify_labels.json, GRAPH_REPORT.md, cache/) into the new worktree.
 *    COPY, never a symlink: a symlink would race concurrent graphify update
 *    runs and misdescribe a diverged branch. Deliberately NOT the whole
 *    directory: graph.html (viz artifact), dated snapshot dirs and
 *    .graphify_root (records the MAIN checkout's watch path) are skipped —
 *    ~5.2 MB copied of ~13.9 MB on disk, and only the copied parts are read
 *    by `graphify query` / `graphify update`.
 *  - addWorktree (git.ts) — calls it after linkNodeModules; a failure logs
 *    and the spawn proceeds (pre-fix status quo, like node_modules).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { addWorktree, copyProjectGraph } = loadTs('src/main/git.ts');

/** A temp dir with a real git repo (one commit on main) + a graphify-out that
 *  carries the functional set AND the artifacts that must NOT travel. */
function makeRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-gfy-'));
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-b', 'main', '-q']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.email=t@t.local',
    '-c',
    'user.name=t',
    'commit',
    '--allow-empty',
    '-m',
    'init',
    '-q',
  ]);
  const out = join(repo, 'graphify-out');
  mkdirSync(out, { recursive: true });
  // functional set
  writeFileSync(join(out, 'graph.json'), '{"nodes":[]}');
  writeFileSync(join(out, 'manifest.json'), '{}');
  writeFileSync(join(out, '.graphify_labels.json'), '{}');
  writeFileSync(join(out, 'GRAPH_REPORT.md'), '# report');
  mkdirSync(join(out, 'cache', 'ast'), { recursive: true });
  writeFileSync(join(out, 'cache', 'ast', 'hash.json'), '{}');
  // artifacts that must be skipped
  writeFileSync(join(out, 'graph.html'), '<html>big</html>');
  mkdirSync(join(out, '2026-08-16'), { recursive: true });
  writeFileSync(join(out, '2026-08-16', 'graph.json'), '{"old":true}');
  writeFileSync(join(out, '.graphify_root'), '/opt/munder-difflin');
  return { tmp, repo };
}

function gitCommitlessRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-gfy-'));
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-b', 'main', '-q']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.email=t@t.local',
    '-c',
    'user.name=t',
    'commit',
    '--allow-empty',
    '-m',
    'init',
    '-q',
  ]);
  return { tmp, repo };
}

async function makeWorktree(repo, tmp, name) {
  const wtPath = join(tmp, 'worktrees', name);
  mkdirSync(dirname(wtPath), { recursive: true });
  const res = await addWorktree(repo, wtPath, 'main');
  assert.equal(res.ok, true, `addWorktree must succeed: ${res.error ?? ''}`);
  return wtPath;
}

// ── integration: the full creation path ────────────────────────────────────

test('a freshly created worktree gets a warm graph COPY (not a symlink) of the functional set only', async () => {
  const { tmp, repo } = makeRepo();
  try {
    const wtPath = await makeWorktree(repo, tmp, 'agent-x');
    const out = join(wtPath, 'graphify-out');
    // copied: the functional set, contents equal to the source
    assert.equal(readFileSync(join(out, 'graph.json'), 'utf8'), '{"nodes":[]}');
    assert.equal(readFileSync(join(out, 'manifest.json'), 'utf8'), '{}');
    assert.equal(readFileSync(join(out, 'GRAPH_REPORT.md'), 'utf8'), '# report');
    assert.equal(
      readFileSync(join(out, 'cache', 'ast', 'hash.json'), 'utf8'),
      '{}',
      'cache/ travels so the first worktree graphify update is incremental',
    );
    // real copies, never symlinks — independence from the source is the point
    const st = lstatSync(join(out, 'graph.json'));
    assert.equal(st.isSymbolicLink(), false, 'graph.json must be a copy, not a link');
    // skipped: viz artifact, dated snapshot dirs, watch-path marker
    for (const skipped of ['graph.html', '2026-08-16', '.graphify_root']) {
      let saw = true;
      try {
        lstatSync(join(out, skipped));
      } catch {
        saw = false;
      }
      assert.equal(saw, false, `${skipped} must NOT be provisioned`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the copy is independent: mutating the source does not touch the worktree graph', async () => {
  const { tmp, repo } = makeRepo();
  try {
    const wtPath = await makeWorktree(repo, tmp, 'agent-ind');
    writeFileSync(join(repo, 'graphify-out', 'graph.json'), '{"nodes":["CHANGED"]}');
    assert.equal(
      readFileSync(join(wtPath, 'graphify-out', 'graph.json'), 'utf8'),
      '{"nodes":[]}',
      'worktree graph is branch-local — no symlink back to main',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('addWorktree still succeeds when the main checkout has no graphify-out at all', async () => {
  const { tmp, repo } = gitCommitlessRepo();
  try {
    const wtPath = await makeWorktree(repo, tmp, 'agent-none');
    let saw = true;
    try {
      lstatSync(join(wtPath, 'graphify-out'));
    } catch {
      saw = false;
    }
    assert.equal(saw, false, 'no source graph → no graphify-out entry, spawn proceeds');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a source graphify-out without graph.json (unbuildable) provisions nothing', async () => {
  const { tmp, repo } = gitCommitlessRepo();
  mkdirSync(join(repo, 'graphify-out', 'cache'), { recursive: true });
  try {
    const wtPath = await makeWorktree(repo, tmp, 'agent-empty');
    let saw = true;
    try {
      lstatSync(join(wtPath, 'graphify-out', 'graph.json'));
    } catch {
      saw = false;
    }
    assert.equal(saw, false, 'a graph-less source graph must not be half-copied');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── copyProjectGraph unit behavior ─────────────────────────────────────────

test('never clobbers a worktree graph the worker already built', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-gfy-'));
  try {
    const mainRoot = join(tmp, 'main');
    const wt = join(tmp, 'wt');
    mkdirSync(join(mainRoot, 'graphify-out'), { recursive: true });
    writeFileSync(join(mainRoot, 'graphify-out', 'graph.json'), '{"main":true}');
    mkdirSync(join(wt, 'graphify-out'), { recursive: true });
    writeFileSync(join(wt, 'graphify-out', 'graph.json'), '{"mine":true}');
    const res = await copyProjectGraph(wt, mainRoot);
    assert.equal(res.copied, false, 'must skip, not replace');
    assert.equal(
      readFileSync(join(wt, 'graphify-out', 'graph.json'), 'utf8'),
      '{"mine":true}',
      'worktree graph untouched',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('idempotent re-run after a successful copy changes nothing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-gfy-'));
  try {
    const mainRoot = join(tmp, 'main');
    const wt = join(tmp, 'wt');
    mkdirSync(join(mainRoot, 'graphify-out'), { recursive: true });
    writeFileSync(join(mainRoot, 'graphify-out', 'graph.json'), '{"a":1}');
    mkdirSync(wt, { recursive: true });
    const first = await copyProjectGraph(wt, mainRoot);
    assert.equal(first.copied, true);
    const again = await copyProjectGraph(wt, mainRoot);
    assert.equal(again.copied, false, 'second run sees the worktree graph and stops');
    assert.equal(readFileSync(join(wt, 'graphify-out', 'graph.json'), 'utf8'), '{"a":1}');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('reports ok:false without throwing when the destination is unwritable, and never fails creation', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-gfy-'));
  try {
    const mainRoot = join(tmp, 'main');
    const wt = join(tmp, 'wt');
    mkdirSync(join(mainRoot, 'graphify-out'), { recursive: true });
    writeFileSync(join(mainRoot, 'graphify-out', 'graph.json'), '{"a":1}');
    mkdirSync(wt, { recursive: true });
    // graphify-out exists as a FILE → cp into it fails deterministically
    writeFileSync(join(wt, 'graphify-out'), 'occupied');
    const res = await copyProjectGraph(wt, mainRoot);
    assert.equal(res.ok, false, 'surface the failure');
    assert.ok(res.error, 'with a reason');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
