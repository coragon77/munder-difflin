'use strict';

/**
 * Card agent-harness-graphify-graph-f-2026-08-18 — the MAIN checkout's graphify
 * graph (the one strangers read) was the stalest of five copies because workers
 * only ever updated graphs inside their disposable worktrees. The durable fix:
 * a harness-owned main-process step that refreshes the project-root graph at app
 * start — i.e. seconds after every restart-window merge, and after ANY other
 * path that advances the main checkout (god manual merge, operator pull),
 * without lengthening the watcher's merge window at all.
 *
 *  - isGraphStale (graphRefresh.ts) — pure staleness decision on the graph's
 *    recorded built_at_commit vs HEAD
 *  - refreshProjectGraph (graphRefresh.ts) — orchestration with injectable
 *    gitHead/runUpdate: skip when fresh, skip when no graph, skip when not a
 *    repo, run `graphify update .` when stale, swallow every failure
 *  - graphifyCandidates (graphRefresh.ts) — desktop PATHs miss ~/.local/bin, so
 *    the explicit user-install path is tried first, PATH second
 *  - getHead (git.ts) — rev-parse HEAD, null when cwd isn't a repo
 *  - index.ts source pin — the whenReady wiring (index.ts is not loadable in
 *    the .cjs harness; same pattern as worktree-isolation-refusal)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const loadTs = require('./load-ts.cjs');

const { getHead } = loadTs('src/main/git.ts');
const { isGraphStale, refreshProjectGraph, graphifyCandidates } = loadTs(
  'src/main/graphRefresh.ts',
);

// ── isGraphStale ───────────────────────────────────────────────────────────

test('graph commit differing from HEAD is stale', () => {
  assert.equal(isGraphStale('3f96d7aa', 'b5fecafc'), true);
});

test('graph commit equal to HEAD is fresh', () => {
  assert.equal(isGraphStale('b5fecafc', 'b5fecafc'), false);
});

test('missing graph commit counts as stale (rebuild)', () => {
  assert.equal(isGraphStale(undefined, 'abc'), true);
  assert.equal(isGraphStale(null, 'abc'), true);
});

// ── refreshProjectGraph (injected runner — no real graphify in unit tests) ──

function makeTree(builtAtCommit) {
  const tmp = mkdtempSync(join(tmpdir(), 'graph-refresh-'));
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'graphify-out'), { recursive: true });
  if (builtAtCommit !== undefined) {
    writeFileSync(
      join(repo, 'graphify-out', 'graph.json'),
      JSON.stringify({ built_at_commit: builtAtCommit }),
    );
  }
  return { tmp, repo };
}

test('stale graph triggers an update in the repo root', async () => {
  const { tmp, repo } = makeTree('oldsha');
  try {
    const calls = [];
    const res = await refreshProjectGraph(repo, {
      gitHead: async () => 'newsha',
      runUpdate: async (root, home) => {
        calls.push([root, home]);
      },
    });
    assert.equal(res.ran, true, `should run: ${res.reason}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], repo, 'must update the MAIN checkout root');
    assert.equal(typeof calls[0][1], 'string', 'home passed for binary resolution');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fresh graph is skipped without spawning', async () => {
  const { tmp, repo } = makeTree('same');
  try {
    let spawned = false;
    const res = await refreshProjectGraph(repo, {
      gitHead: async () => 'same',
      runUpdate: async () => {
        spawned = true;
      },
    });
    assert.equal(res.ran, false);
    assert.match(res.reason, /fresh/);
    assert.equal(spawned, false, 'no spawn when graph tracks HEAD');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('no existing graph is skipped (scope: refresh, not first build)', async () => {
  const { tmp, repo } = makeTree(undefined);
  try {
    let spawned = false;
    const res = await refreshProjectGraph(repo, {
      gitHead: async () => 'abc',
      runUpdate: async () => {
        spawned = true;
      },
    });
    assert.equal(res.ran, false);
    assert.match(res.reason, /no-graph/);
    assert.equal(spawned, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('non-repo root (packaged app.asar etc.) is skipped', async () => {
  const { tmp, repo } = makeTree('x');
  try {
    let spawned = false;
    const res = await refreshProjectGraph(repo, {
      gitHead: async () => null,
      runUpdate: async () => {
        spawned = true;
      },
    });
    assert.equal(res.ran, false);
    assert.match(res.reason, /no-head/);
    assert.equal(spawned, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a failing update never throws — failure is a reason, not an error', async () => {
  const { tmp, repo } = makeTree('old');
  try {
    const res = await refreshProjectGraph(repo, {
      gitHead: async () => 'new',
      runUpdate: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    assert.equal(res.ran, false);
    assert.match(res.reason, /update-failed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('unparseable graph.json counts as stale and rebuilds', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'graph-refresh-'));
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'graphify-out'), { recursive: true });
  writeFileSync(join(repo, 'graphify-out', 'graph.json'), '{truncated');
  try {
    const res = await refreshProjectGraph(repo, {
      gitHead: async () => 'new',
      runUpdate: async () => {},
    });
    assert.equal(res.ran, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── graphifyCandidates ─────────────────────────────────────────────────────

test('explicit user-install path first, PATH second (desktop launches miss ~/.local/bin)', () => {
  const c = graphifyCandidates('/home/sfuchs');
  assert.equal(c[0], '/home/sfuchs/.local/bin/graphify');
  assert.equal(c[1], 'graphify');
});

// ── getHead (real git) ─────────────────────────────────────────────────────

test('getHead resolves HEAD in a real repo, null outside', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'graph-refresh-'));
  try {
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
    const head = await getHead(repo);
    assert.match(head, /^[0-9a-f]{40}$/, 'full sha');
    const outside = await getHead(tmp);
    assert.equal(outside, null, 'non-repo → null');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── whenReady wiring (source pin) ──────────────────────────────────────────

const src = readFileSync(join(__dirname, '..', 'src/main', 'index.ts'), 'utf8');

test('app start fires the graph refresh (fire-and-forget, after merge windows close)', () => {
  const start = src.indexOf('app.whenReady().then(() => {');
  const end = src.indexOf('\n});', start);
  const block = src.slice(start, end > start ? end : undefined);
  assert.ok(start > 0, 'whenReady block found');
  assert.match(block, /void refreshProjectGraph\(/, 'fire-and-forget call in whenReady');
});
