'use strict';

/**
 * Card block-askuserquestion-20260817 — claude agents must NEVER expose
 * AskUserQuestion: its modal blocks the pane and no harness mechanism can
 * answer it (live freeze 2026-08-15: a worker stalled mid-merge at a
 * skill-triggered AskUserQuestion). Two layers, both pinned here:
 *
 *  (1) ENFORCEMENT — disallowedToolsArgs() puts '--disallowedTools
 *      AskUserQuestion' on every claude spawn's argv (spawnAgentCore is the
 *      single door for pty:spawn/restore/spawn-requests/recall/god boot; the
 *      kitty satellite god co-terminal appends the same pair). The flag is
 *      verified against the installed claude 2.1.221 help: variadic
 *      comma/space list; deny rules apply in EVERY permission mode — hidden
 *      claude sessions already run it beside --permission-mode
 *      bypassPermissions. Other providers get nothing (they have no such
 *      tool).
 *
 *  (2) BRIEFING — the injectedPrompt (mode-independent part) carries the
 *      routing rule: questions to the human go via pane chat or the card
 *      humanQA / ASK ME surface, never a question tool.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { prependCommandTail, permissionModeArgs, disallowedToolsArgs } = loadTs(
  'src/shared/agentProvider.ts',
);
const { HiveManager } = loadTs('src/main/hive.ts');

// TS `private` is compile-time only — erased by transpile, reachable at runtime.
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const WORKER = { id: 'worker-x', name: 'X', role: 'agent', cwd: '/w' };

/** Mirror of spawnAgentCore's composition, wired in its real order:
 *  typed command tail → permission mode → AskUserQuestion deny. */
function composeArgv(command, provider, mode, args = []) {
  let argv = prependCommandTail(command, args);
  argv = [...argv, ...permissionModeArgs([command, ...argv].join(' '), provider, mode)];
  return [...argv, ...disallowedToolsArgs([command, ...argv].join(' '), provider)];
}

// ── Layer 1: enforcement ─────────────────────────────────────────────────────

test('claude spawn argv denies AskUserQuestion (default auto mode)', () => {
  const argv = composeArgv('claude', 'claude', 'auto');
  const i = argv.indexOf('--disallowedTools');
  assert.ok(i >= 0, 'claude argv must carry --disallowedTools');
  assert.equal(argv[i + 1], 'AskUserQuestion');
});

test("bypass mode composes with the deny flag (skip-permissions doesn't lift denies)", () => {
  const argv = composeArgv('claude --dangerously-skip-permissions', 'claude', 'bypass');
  assert.ok(argv.includes('--dangerously-skip-permissions'));
  assert.ok(argv.includes('AskUserQuestion'), 'deny must ride argv alongside bypass');
});

test('non-claude providers get no deny flag', () => {
  for (const [cmd, prov] of [
    ['codex', 'codex'],
    ['pi --approve', 'pi'],
    ['grok', 'grok'],
    ['copilot', 'copilot'],
  ]) {
    const argv = composeArgv(cmd, prov, 'bypass');
    assert.deepEqual(
      argv.filter((a) => a.includes('disallow')),
      [],
      `${prov} must not carry a deny flag`,
    );
  }
});

test('typed tail + model flag: deny still rides argv and is never doubled', () => {
  const argv = composeArgv('claude --model claude-opus-5', 'claude', 'auto');
  assert.ok(argv.includes('--model'));
  assert.equal(argv.filter((a) => a === '--disallowedTools').length, 1);
});

test('install-relaunch re-entry (same opts re-sent) never doubles the pair', () => {
  const once = composeArgv('claude', 'claude', 'auto');
  const twice = composeArgv('claude', 'claude', 'auto', once);
  assert.equal(twice.filter((a) => a === '--disallowedTools').length, 1);
});

test('typed deny list WITHOUT AskUserQuestion: list preserved, deny still appended', () => {
  // The rule is absolute: an operator-typed '--disallowedTools Bash' denies
  // Bash but must not silently drop the AskUserQuestion block. Commander
  // concatenates duplicate variadic options, so both lists apply.
  const argv = composeArgv('claude --disallowedTools Bash', 'claude', 'auto');
  assert.equal(argv.filter((a) => a === '--disallowedTools').length, 2);
  assert.ok(argv.includes('Bash'));
  assert.ok(argv.includes('AskUserQuestion'));
});

test('typed comma list already containing AskUserQuestion is not doubled', () => {
  const argv = composeArgv('claude --disallowedTools AskUserQuestion,Bash', 'claude', 'auto');
  assert.equal(argv.filter((a) => a === '--disallowedTools').length, 1);
  assert.ok(argv.includes('AskUserQuestion,Bash'), 'operator list text preserved');
});

test('both spellings recognized by the idempotency guard', () => {
  // Typed '--disallowed-tools' (kebab spelling) already denies the tool —
  // the guard must suppress the append, keeping the operator's spelling.
  const argv = composeArgv('claude --disallowed-tools AskUserQuestion', 'claude', 'auto');
  assert.equal(
    argv.filter((a) => a.startsWith('--disallowed')).length,
    1,
    'typed deny kept, second append suppressed',
  );
  assert.ok(argv.includes('AskUserQuestion'));
});

// ── Layer 2: briefing ────────────────────────────────────────────────────────

test('briefing carries the question-routing rule in every integration mode', () => {
  for (const mode of ['god', 'workers', 'lean']) {
    const p = injectedPrompt.call(
      null,
      WORKER,
      '/agents/worker-x',
      '/hive',
      false,
      false,
      true,
      mode,
    );
    assert.ok(/AskUserQuestion/.test(p), `mode ${mode}: briefing names the blocked tool`);
    assert.ok(
      /humanQA|ASK ME/.test(p),
      `mode ${mode}: briefing routes questions to pane chat / humanQA (ASK ME)`,
    );
    assert.ok(
      /pane chat|chat in your pane/i.test(p),
      `mode ${mode}: briefing names pane chat as a routing channel`,
    );
  }
});

test('god briefing carries the routing rule too (god is also a claude agent)', () => {
  const GOD = { id: 'god', name: 'God', role: 'god', cwd: '/w', isGod: true };
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false, true, 'lean');
  assert.ok(/AskUserQuestion/.test(p));
});
