'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { AGENT_PROVIDER_PRESETS, DEFAULT_HIRE_PERMISSION_MODE, permissionModeArgs, providerPreset } =
  loadTs('src/shared/agentProvider.ts');

// — claude flags verified against the SHIPPED binary (claude 2.1.221, native
//   ELF, `claude --help`): `--permission-mode` accepts choices "acceptEdits",
//   "auto", "bypassPermissions", "manual", "dontAsk", "plan" — Claude Auto is
//   `--permission-mode auto`. `--dangerously-skip-permissions` is documented
//   there as the bypass launch flag the runtime bypass toggle requires
//   ("session was not launched with --dangerously-skip-permissions" is the
//   binary's own refusal text). Stefan's
//   `--dangerously-bypass-permissions` has ZERO occurrences in the binary. —

test('claude autoFlag is the verified single-token bypass spelling', () => {
  const p = providerPreset('claude');
  assert.equal(p.autoFlag, '--dangerously-skip-permissions');
  assert.equal(p.autoModeFlag, p.autoFlag);
});

test('permissionModeArgs: claude auto and bypass map to their verified flags', () => {
  assert.deepEqual(permissionModeArgs('claude', 'claude', 'auto'), ['--permission-mode', 'auto']);
  assert.deepEqual(permissionModeArgs('claude', undefined, 'bypass'), [
    '--dangerously-skip-permissions',
  ]);
});

test('permissionModeArgs: default or unset mode injects NOTHING', () => {
  // Explicit 'default' is a real choice (spawn-request workers with the bypass
  // setting OFF): no flag even though the install-wide autoMode may be on.
  assert.deepEqual(permissionModeArgs('claude', 'claude', 'default'), []);
  assert.deepEqual(permissionModeArgs('claude', 'claude', undefined), []);
});

test('permissionModeArgs: non-claude providers map both auto and bypass to their one autonomous flag', () => {
  // Other CLIs have a single autonomous flag — auto IS bypass for them.
  assert.deepEqual(permissionModeArgs('kimi', 'kimi', 'auto'), ['--auto']);
  assert.deepEqual(permissionModeArgs('kimi', 'kimi', 'bypass'), ['--auto']);
  assert.deepEqual(permissionModeArgs('grok', 'grok', 'bypass'), [
    '--permission-mode',
    'bypassPermissions',
  ]);
  // Multi-token flags split into one argv element per token.
  assert.deepEqual(permissionModeArgs('copilot', 'copilot', 'bypass'), [
    '-s',
    '--allow-all-tools',
    '--no-ask-user',
  ]);
  // Providers with no flag (custom) stay flag-less in every mode.
  assert.deepEqual(permissionModeArgs('some-custom-cli', 'custom', 'bypass'), []);
});

test('typed-flag precedence: an explicit flag in the command wins, never doubled', () => {
  // Exact bypass flag typed → no injection.
  assert.deepEqual(
    permissionModeArgs('claude --dangerously-skip-permissions', 'claude', 'bypass'),
    [],
  );
  // Any typed --permission-mode <value> wins over a selected claude auto mode
  // (appending a second --permission-mode would conflict on the same key).
  assert.deepEqual(
    permissionModeArgs('claude --permission-mode acceptEdits', 'claude', 'auto'),
    [],
  );
  // Non-claude: the provider's own typed flag suppresses injection.
  assert.deepEqual(permissionModeArgs('kimi --auto', 'kimi', 'auto'), []);
});

test('spawn-request path: the worker bypass SETTING (not autoMode) keys the injection', () => {
  // Mirrors processSpawnRequest after card permission-mode-config-20260816:
  // args = [model?] and the ride-along mode = setting ? 'bypass' : 'default'
  // — injection happens once, centrally, in spawnAgentCore.
  const raw = { model: 'sonnet' };
  const command = 'claude';
  const argvFor = (bypassSetting) => [
    ...(raw.model ? ['--model', raw.model] : []),
    ...permissionModeArgs(command, undefined, bypassSetting ? 'bypass' : 'default'),
  ];
  assert.deepEqual(argvFor(true), ['--model', 'sonnet', '--dangerously-skip-permissions']);
  // Setting OFF (the shipped default): no bypass even though autoMode is on.
  assert.deepEqual(argvFor(false), ['--model', 'sonnet']);
});

test('hire selector default is Claude Auto', () => {
  assert.equal(DEFAULT_HIRE_PERMISSION_MODE, 'auto');
});

test('every provider mirrors autoFlag === autoModeFlag (two consumers, one value)', () => {
  for (const p of AGENT_PROVIDER_PRESETS) {
    assert.equal(p.autoFlag, p.autoModeFlag, `${p.id}: autoFlag/autoModeFlag drifted`);
  }
});
