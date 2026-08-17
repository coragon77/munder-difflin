'use strict';

/**
 * Card agent-harness-harden-isolate-t-2026-08-17 — an isolate:true spawn whose
 * worktree creation FAILS must FAIL THE SPAWN, not silently fall back to the
 * shared base cwd (the old fallback let an "isolated" worker land untracked in
 * the checkout isolation exists to protect). Pinned here:
 *  - worktreeIsolationRefusal (git.ts) — the actionable refusal: names the
 *    worktree error, offers retry / free the target path / an explicit
 *    operator-authorized allowSharedCwd exit
 *  - the gate's PLACEMENT in spawnAgentCore (index.ts source pins — not
 *    loadable outside Electron; same pattern as integration-mode-toggle):
 *    every isolate:true failure branch returns the refusal, and the silent
 *    fallback is gone. Successful creation + the isolate:false flow untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { worktreeIsolationRefusal } = loadTs('src/main/git.ts');

// ── the refusal message ────────────────────────────────────────────────────

test('refusal names the worktree error and the target path', () => {
  const msg = worktreeIsolationRefusal('/h/worktrees/kelly-1', "fatal: 'path' already exists");
  assert.ok(msg.includes("fatal: 'path' already exists"), 'must carry the git error');
  assert.ok(msg.includes('/h/worktrees/kelly-1'), 'must name the blocked worktree path');
  assert.match(msg, /REFUSED/, 'must say the spawn was refused');
});

test('refusal offers retry, free-the-directory, and the allowSharedCwd exit', () => {
  const msg = worktreeIsolationRefusal('/h/worktrees/x', 'boom');
  assert.match(msg, /Retry the spawn/, 'retry exit');
  assert.match(msg, /git worktree remove/, 'free-the-directory exit names the commands');
  assert.match(msg, /WITHOUT "isolate"/, 'shared-cwd exit drops isolate');
  assert.match(msg, /"allowSharedCwd": true/, 'shared-cwd exit names the override');
  assert.match(
    msg,
    /ONLY on explicit operator instruction/,
    'allowSharedCwd stays operator-authorized, never inferred',
  );
});

test('refusal states there is no silent fallback', () => {
  assert.match(worktreeIsolationRefusal('/h/w', 'boom'), /no silent fallback/);
});

// ── gate placement in spawnAgentCore (source pins) ─────────────────────────

const src = readFileSync(join(__dirname, '..', 'src/main', 'index.ts'), 'utf8');
const start = src.indexOf('// Git isolation:');
const end = src.indexOf('// Worktree RE-ENTRY adoption');
assert.ok(start > 0 && end > start, 'isolation block found before the adoption block');
const block = src.slice(start, end);

test('every isolate:true failure branch returns the refusal from spawnAgentCore', () => {
  // unsafe-path branch, addWorktree error branch, thrown-exception branch
  assert.match(block, /wtFailure = `unsafe worktree path/, 'unsafe path feeds the refusal');
  assert.match(block, /wtFailure = wt\.error/, 'addWorktree error feeds the refusal');
  assert.match(block, /wtFailure = e instanceof Error/, 'exceptions feed the refusal');
  assert.match(
    block,
    /return \{ ok: false, error: worktreeIsolationRefusal\(wtPath, wtFailure\) \}/,
    'failure returns ok:false with the refusal',
  );
});

test('the silent shared-cwd fallback is gone', () => {
  assert.ok(!/fall[s]? back/.test(block), 'no fallback wording in the isolation block');
  assert.ok(!src.includes('Best-effort — a failure falls back'), 'old comment removed');
});

test('successful creation still registers the worktree (success path unchanged)', () => {
  assert.match(block, /worktreePaths\.set\(opts\.id, wtPath\)/);
  assert.match(block, /worktreeOrigins\.set\(opts\.id, origCwd\)/);
});
