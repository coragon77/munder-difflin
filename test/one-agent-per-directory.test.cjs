'use strict';

/**
 * ONE AGENT PER DIRECTORY — operator addendum to the parallel-dispatch /
 * floorMaxAgents cards (agent-harness-parallel-dispatc-2026-08-17 +
 * agent-harness-floormaxagents-s-2026-08-17).
 *
 * No more than one hire/intern may work on the same physical checkout
 * without a git worktree. Pinned here:
 *  - the occupant lookup (hive.ts) the spawn gate uses — resolved dirs in,
 *    occupant id out; a respawn's own id never conflicts
 *  - the god briefing carries the rule: check WORKTREE STATE before ruling a
 *    conflict (registry cwd alone is not evidence — named incident:
 *    Alfred-vs-Kevin, merlin_editionplatin), and the allowSharedCwd override
 *    is operator-instruction-only
 *  - the generated hive-root AGENTS.md carries the same policy in every mode
 *
 * The spawnAgentCore gate itself (index.ts) is not loadable outside
 * Electron; its decision inputs are tested here at their source, same
 * pattern as the floor-cap tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HiveManager, findCheckoutOccupant, hiveRootAgentsMd } = loadTs('src/main/hive.ts');

// ── findCheckoutOccupant ─────────────────────────────────────────────────

test('finds the occupant of a shared checkout', () => {
  const dirs = new Map([
    ['alfred-1', '/repos/merlin'],
    ['kevin-1', '/worktrees/kevin-1'],
  ]);
  assert.equal(findCheckoutOccupant(dirs, '/repos/merlin'), 'alfred-1');
});

test('a worktree-isolated occupant does not conflict on the base checkout', () => {
  // Kevin's RESOLVED dir is his worktree — asking about the base repo finds
  // nobody in it (this is exactly the Alfred-vs-Kevin false positive).
  const dirs = new Map([['kevin-1', '/worktrees/kevin-1']]);
  assert.equal(findCheckoutOccupant(dirs, '/repos/merlin'), null);
});

test('no occupant for a free directory', () => {
  const dirs = new Map([['a-1', '/repos/a']]);
  assert.equal(findCheckoutOccupant(dirs, '/repos/b'), null);
  assert.equal(findCheckoutOccupant(new Map(), '/repos/a'), null);
});

test('a respawn never conflicts with its own seat', () => {
  const dirs = new Map([['a-1', '/repos/a']]);
  assert.equal(findCheckoutOccupant(dirs, '/repos/a', 'a-1'), null);
  assert.equal(findCheckoutOccupant(dirs, '/repos/a'), 'a-1');
});

// ── god briefing carries the rule ────────────────────────────────────────

const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const GOD = { id: 'god', name: 'God', role: 'god', cwd: '/w', isGod: true };

test('godLine carries the ONE-AGENT-PER-DIRECTORY rule', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/ONE-AGENT-PER-DIRECTORY/.test(p), 'rule must be named');
  assert.ok(
    /never dispatch two agents into the same working directory unless all but one are isolated/.test(
      p,
    ),
  );
  assert.ok(/CHECK WORKTREE STATE before ruling/.test(p), 'must order the worktree-state check');
  assert.ok(
    /registry cwd alone is NOT sufficient evidence/.test(p),
    'must say cwd alone is not evidence',
  );
  assert.ok(/Alfred vs Kevin in merlin_editionplatin/.test(p), 'must name the root incident');
  assert.ok(/allowSharedCwd:true/.test(p), 'must name the override affordance');
  assert.ok(
    /ONLY on explicit operator instruction, never infer it/.test(p),
    'override is operator-only, never god-inferred',
  );
});

// ── generated hive-root AGENTS.md carries the rule ───────────────────────

test('hive-root AGENTS.md carries the one-agent-per-directory policy in every mode', () => {
  for (const mode of ['god', 'workers', 'lean']) {
    const md = hiveRootAgentsMd(true, mode);
    assert.match(md, /ONE AGENT PER DIRECTORY/, `mode ${mode}: rule missing`);
    assert.match(md, /CHECK\s+WORKTREE STATE/, `mode ${mode}: worktree check missing`);
    assert.match(md, /Alfred-vs-Kevin/, `mode ${mode}: incident missing`);
    assert.match(md, /allowSharedCwd/, `mode ${mode}: override affordance missing`);
    assert.match(md, /never god-inferred/, `mode ${mode}: override discipline missing`);
  }
});
