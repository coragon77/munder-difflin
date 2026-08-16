'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  AGENT_PROVIDER_PRESETS,
  autoModeArgsForCommand,
  providerPreset
} = loadTs('src/shared/agentProvider.ts');

// — claude flag: verified against the SHIPPED binary (claude 2.1.221, native
//   ELF). `--dangerously-skip-permissions` is documented there as "Alias for
//   --permission-mode bypassPermissions" AND is the launch flag the runtime
//   bypass toggle requires ("session was not launched with
//   --dangerously-skip-permissions" is the binary's own refusal text).
//   Stefan's `--dangerously-bypass-permissions` has ZERO occurrences in the
//   binary — it parses silently and engages nothing. —

test('claude autoFlag is the verified single-token bypass spelling', () => {
  const p = providerPreset('claude');
  assert.equal(p.autoFlag, '--dangerously-skip-permissions');
  assert.equal(p.autoModeFlag, p.autoFlag);
});

test('autoModeArgsForCommand yields argv TOKENS for a claude spawn', () => {
  assert.deepEqual(autoModeArgsForCommand('claude', undefined, true), ['--dangerously-skip-permissions']);
  // Explicit provider, same answer.
  assert.deepEqual(autoModeArgsForCommand('claude', 'claude', true), ['--dangerously-skip-permissions']);
});

test('regression: the spawn-request argv composition carries the flag tokens', () => {
  // Mirrors processSpawnRequest: args = [model flag?] + auto-mode tokens. The
  // command STRING is resolved to its binary only (PATH resolution drops any
  // appended tail), so this args channel is the sole way the flag reaches argv.
  const raw = { model: 'sonnet' };
  const command = 'claude';
  const args = [...(raw.model ? ['--model', raw.model] : []), ...autoModeArgsForCommand(command, undefined, true)];
  assert.ok(args.includes('--dangerously-skip-permissions'), `argv tokens: ${args}`);
  assert.deepEqual(args, ['--model', 'sonnet', '--dangerously-skip-permissions']);
});

test('idempotency guard: an explicit flag in the command string is respected, never doubled', () => {
  assert.deepEqual(autoModeArgsForCommand('claude --dangerously-skip-permissions', undefined, true), []);
});

test('auto mode off, or a provider with no flag, yields nothing', () => {
  assert.deepEqual(autoModeArgsForCommand('claude', undefined, false), []);
  assert.deepEqual(autoModeArgsForCommand('opencode', 'opencode', true), []);
  assert.deepEqual(autoModeArgsForCommand('some-custom-cli', 'custom', true), []);
});

test('multi-token autoFlags split into separate argv tokens', () => {
  // copilot's flag is genuinely multi-token; each piece must be its own argv
  // element (a single glued token would be one unparsable argv entry).
  assert.deepEqual(
    autoModeArgsForCommand('copilot', 'copilot', true),
    ['-s', '--allow-all-tools', '--no-ask-user']
  );
});

test('every provider mirrors autoFlag === autoModeFlag (two consumers, one value)', () => {
  for (const p of AGENT_PROVIDER_PRESETS) {
    assert.equal(p.autoFlag, p.autoModeFlag, `${p.id}: autoFlag/autoModeFlag drifted`);
  }
});
