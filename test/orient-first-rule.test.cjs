'use strict';

/**
 * ORIENT-FIRST rule (card agent-ship-the-rule-read-a-dir-2026-08-18).
 *
 * Root incident (2026-08-17): god dispatched a design review into
 * /opt/munder-difflin and the reviewer burned 2.43M tokens grepping and
 * reading source — while that directory's OWN AGENTS.md documented a working
 * graphify-out/ knowledge graph that answered the question cheaply. Neither
 * god nor the worker had read it.
 *
 * The rule: orientation is the FIRST action in any directory, for EVERY
 * agent including god — read the directory's own CLAUDE.md/AGENTS.md before
 * grepping, reading source, or forming a plan; orient via the docs/graph,
 * then verify with targeted reads ONLY the specific lines to be cited
 * (calibration: docs and graphs go stale — orient, don't blindly trust).
 *
 * It ships on three surfaces, all generated from src/main/hive.ts constants
 * (the generated files are wiped on bootstrap — the constant is the source):
 *  1. HIVE_ROOT_AGENTS_MD — the engine-neutral hive-root AGENTS.md every
 *     provider reads (PRIMARY home).
 *  2. The worker seed — the injected HIVE PROTOCOL list, so a spawned worker
 *     orients before its first tool call.
 *  3. The godLine — god obeys the same rule before dispatching (he skipped it
 *     too, then dispatched his own grep path onward).
 *
 * Same pattern as godline-rules.test.cjs (content tests over the constants).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HiveManager, hiveRootAgentsMd } = loadTs('src/main/hive.ts');

// TS `private` is compile-time only — erased by transpile, reachable at runtime.
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const WORKER = { id: 'worker-x', name: 'X', role: 'worker', cwd: '/w' };
const GOD = { id: 'god', name: 'God', role: 'god', cwd: '/w', isGod: true };

// ——— 1. hive-root AGENTS.md (engine-neutral, every provider) ————————————

test('AGENTS.md carries the ORIENT-FIRST rule in both switch states', () => {
  for (const sdd of [true, false]) {
    const md = hiveRootAgentsMd(sdd);
    assert.ok(/Orient first/i.test(md), `rule section present (sdd=${sdd})`);
    assert.ok(/CLAUDE\.md and AGENTS\.md/.test(md), 'names both doc files');
    assert.ok(/graphify-out\//.test(md), 'names the installed-graph affordance');
    assert.ok(/2\.43M tokens/.test(md), 'carries the incident cost');
  }
});

test('AGENTS.md binds god too and keeps the staleness calibration', () => {
  const md = hiveRootAgentsMd(true);
  assert.ok(/god included/i.test(md), 'the rule binds god explicitly');
  assert.ok(/stale/.test(md), 'oriented is not verified: docs/graphs go stale');
  assert.ok(/targeted reads/.test(md), 'verify the specific cited lines');
});

// ——— 2. worker seed: the HIVE PROTOCOL list ————————————————————————————

test('worker seed: ORIENT FIRST is protocol item 2, right after the inbox read', () => {
  const p = injectedPrompt.call(null, WORKER, '/agents/x', '/hive', false, false);
  const item = /2\. ORIENT FIRST[\s\S]*?(?=\n3\. )/.exec(p)?.[0] ?? '';
  assert.ok(item, 'ORIENT FIRST is numbered protocol item 2');
  assert.ok(/CLAUDE\.md and AGENTS\.md/.test(item));
  assert.ok(/graphify-out\//.test(item));
  assert.ok(/stale/.test(item), 'carries the staleness calibration');
  // protocol numbering stays sequential 1..5 after the insert
  assert.ok(/1\. At the START of a task/.test(p), 'inbox/memory item still leads');
  assert.ok(/3\. Record durable facts/.test(p), 'old item 2 renumbered');
  assert.ok(/4\. To ask another agent/.test(p), 'old item 3 renumbered');
  assert.ok(/5\. At the END of a task/.test(p), 'old item 4 renumbered');
});

// ——— 3. godLine ————————————————————————————————————————————————————————

test('godLine carries ORIENT FIRST (god skipped it too in the incident)', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/ORIENT FIRST:/.test(p), 'the rule is named in the god briefing');
  assert.ok(/directory's own CLAUDE\.md\/AGENTS\.md/.test(p));
  assert.ok(/graphify-out\//.test(p));
  assert.ok(/2\.43M tokens/.test(p), 'carries the incident cost');
  assert.ok(/stale/.test(p), 'keeps the staleness calibration');
});
