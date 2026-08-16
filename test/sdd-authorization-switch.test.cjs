'use strict';

/**
 * SDD subagent authorization switch (card sdd-authorization-switch-20260816).
 *
 * The claude CLI's STOCK system prompt forbids the AgentTool "unless the user
 * requested it" — not our code, not deletable. Its own escape clause is the
 * mechanism: the operator's standing request, scoped to skill-driven plan
 * execution (superpowers SDD), written into (a) the harness-generated
 * <harnessHome>/AGENTS.md and (b) every agent's injected briefing when the
 * switch is ON. OFF omits both — the engine's stock subagent rules then apply
 * unchanged (default-ON is the operator's stated preference).
 *
 * These tests pin BOTH switch states on both surfaces, plus the undefined =
 * ON semantics every consumer uses (matching the config default).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HiveManager, hiveRootAgentsMd } = loadTs('src/main/hive.ts');

const AUTHZ_MARK = 'Operator authorization';
const SCOPING = /scoped to skill execution/i; // AGENTS.md uppercases, the briefing sentence-cases
const SDD_MENTION = 'superpowers SDD';

// ——— generated AGENTS.md (hiveRootAgentsMd) ———————————————————————————

test('ON: AGENTS.md gains the operator-authorization section after the base doc', () => {
  const md = hiveRootAgentsMd(true);
  assert.ok(md.includes(AUTHZ_MARK), 'authorization section present');
  assert.ok(SCOPING.test(md), 'scoped to skill execution, not blanket use');
  assert.ok(md.includes(SDD_MENTION));
  assert.ok(md.includes('Agent-tool'), 'names the Agent tool');
  // Appended AFTER the base document — the engine-neutral read-me stays intact
  // and leads (delegation/roster guidance first).
  assert.ok(md.indexOf('# AGENTS.md — hive floor') === 0);
  assert.ok(md.indexOf('## Delegate first') < md.indexOf(AUTHZ_MARK));
});

test('OFF: AGENTS.md is exactly the base doc — no authorization anywhere', () => {
  const md = hiveRootAgentsMd(false);
  assert.ok(!md.includes(AUTHZ_MARK));
  assert.ok(!md.includes('AUTHORIZES Agent-tool'));
  // Base content still intact (spot checks).
  assert.ok(md.includes('## Delegate first'));
  assert.ok(md.includes('## Superpowers'));
});

// ——— agent briefing (injectedPrompt) ——————————————————————————————————

// TS `private` is compile-time only — erased by transpile, reachable at runtime.
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const META = { id: 'intern-x', name: 'X (Intern)', role: 'intern', cwd: '/w' };

test('ON: every agent briefing carries the OPERATOR AUTHORIZATION line', () => {
  const p = injectedPrompt.call(null, META, '/agents/x', '/hive', false, false, true);
  assert.ok(p.includes('OPERATOR AUTHORIZATION — SUBAGENTS FOR SKILL EXECUTION'));
  assert.ok(p.includes('user-requested'));
  assert.ok(SCOPING.test(p));
  assert.ok(p.includes('cheap model overrides for mechanical tasks'));
  // The rest of the briefing is untouched.
  assert.ok(p.includes('HIVE PROTOCOL'));
});

test('OFF: the briefing omits the authorization line entirely (stock rules apply)', () => {
  const p = injectedPrompt.call(null, META, '/agents/x', '/hive', false, false, false);
  assert.ok(!p.includes('OPERATOR AUTHORIZATION'));
  assert.ok(p.includes('HIVE PROTOCOL'));
});

test('undefined switch state defaults to ON (matching the config default)', () => {
  const p = injectedPrompt.call(null, META, '/agents/x', '/hive', false, false, undefined);
  assert.ok(p.includes('OPERATOR AUTHORIZATION'));
});

test('god also carries the line (god dispatches carry the authorization)', () => {
  const p = injectedPrompt.call(null, { ...META, isGod: true }, '/agents/god', '/hive', false, false, true);
  assert.ok(p.includes('OPERATOR AUTHORIZATION'));
  assert.ok(p.includes('God dispatches carry this authorization'));
});
