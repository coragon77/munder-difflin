'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { permissionModeArgs, inferAgentProvider, isAgentProvider, providerPreset } = loadTs(
  'src/shared/agentProvider.ts',
);
const {
  buildSpawnCommand,
  decodeProviderModel,
  encodeProviderModel,
  modelProvidersForAgent,
  modelsForProvider,
  tokenizeCommand,
} = loadTs('src/renderer/src/store/config.ts');

const autoConfig = { defaultCommand: 'claude', autoMode: true };

test('Kimi is a first-class inferred provider with autonomous defaults', () => {
  assert.equal(isAgentProvider('kimi'), true);
  assert.equal(inferAgentProvider('kimi --auto'), 'kimi');
  const preset = providerPreset('kimi');
  assert.equal(preset.defaultCommand, 'kimi');
  assert.equal(preset.autoFlag, '--auto');
  assert.equal(preset.supportsModel, true);
  assert.equal(preset.canReceiveInbox, false);
  assert.equal(preset.positionalInitialPrompt, undefined);
});

test('Grok is a first-class inferred provider with hooks, resume, and always-approve', () => {
  assert.equal(isAgentProvider('grok'), true);
  assert.equal(inferAgentProvider('/Users/test/.local/bin/grok --model grok-4.5'), 'grok');
  const preset = providerPreset('grok');
  assert.equal(preset.defaultCommand, 'grok');
  assert.equal(preset.autoFlag, '--permission-mode bypassPermissions');
  assert.equal(preset.supportsModel, true);
  assert.equal(preset.canReceiveInbox, true);
  assert.equal(preset.hookBridge, 'grok');
  assert.equal(preset.positionalInitialPrompt, true);
  assert.equal(preset.resumeFlag, '--resume');
});

test('provider commands use matching models and equivalent bypass modes', () => {
  // Since the renderer-hire-flag fix the command STRING carries only the
  // binary + model; the auto-mode bypass flag rides ARGV via
  // autoModeArgsForCommand (see the argv test below) — string-appending it was
  // the same bug class 2714c92 fixed for spawn-requests (any consumer that
  // resolves the command to its binary drops a glued tail).
  assert.equal(
    buildSpawnCommand(autoConfig, 'claude-sonnet-5', 'claude'),
    'claude --model claude-sonnet-5',
  );
  assert.equal(buildSpawnCommand(autoConfig, 'gpt-5.6-sol', 'codex'), 'codex --model gpt-5.6-sol');
  assert.equal(buildSpawnCommand(autoConfig, 'grok-4.5', 'grok'), 'grok --model grok-4.5');
  assert.equal(buildSpawnCommand(autoConfig, 'kimi-code/k3', 'kimi'), 'kimi --model kimi-code/k3');
});

test('renderer hire argv carries the selected permission-mode flag on the args channel', () => {
  // Mirrors spawnAgentCore's composition: the spawn site tokenizes the built
  // command, and the mode flag is appended as ARGV TOKENS from the shared
  // preset table (cards spawn-bypass-flag-dropped + renderer-hire-flag-append
  // + permission-mode-config).
  const cases = [
    ['claude', 'claude-sonnet-5', 'auto', ['--permission-mode', 'auto']],
    ['claude', 'claude-sonnet-5', 'bypass', ['--dangerously-skip-permissions']],
    ['claude', 'claude-sonnet-5', 'default', []],
    ['codex', 'gpt-5.6-sol', 'bypass', ['--dangerously-bypass-approvals-and-sandbox']],
    // grok's flag: verified in an earlier round, NOT re-verified since — no
    // grok binary installed on this machine (documented per card).
    ['grok', 'grok-4.5', 'auto', ['--permission-mode', 'bypassPermissions']],
    ['kimi', 'kimi-code/k3', 'auto', ['--auto']],
  ];
  for (const [provider, model, mode, flagTokens] of cases) {
    const cmd = buildSpawnCommand(autoConfig, model, provider);
    const argv = [...tokenizeCommand(cmd), ...permissionModeArgs(cmd, provider, mode)];
    for (const t of flagTokens)
      assert.ok(argv.includes(t), `${provider}/${mode}: token ${t} missing from argv: ${argv}`);
    assert.equal(
      argv.length,
      tokenizeCommand(cmd).length + flagTokens.length,
      `${provider}/${mode}: unexpected extra tokens: ${argv}`,
    );
  }
});

test('tokenizeCommand semantics stay intact: a quoted model label stays ONE argv token', () => {
  // The pane-restart path (CommandCenterPanel restartWithModel) rebuilds the
  // command string and re-tokenizes it — buildSpawnCommand must keep emitting a
  // string that tokenizes losslessly (spaces in the model value stay one arg).
  const cmd = buildSpawnCommand(autoConfig, 'Gemini 3.1 Pro (High)', 'antigravity');
  const argv = [...tokenizeCommand(cmd), ...permissionModeArgs(cmd, 'antigravity', 'auto')];
  assert.deepEqual(argv, [
    'agy',
    '--model',
    'Gemini 3.1 Pro (High)',
    '--dangerously-skip-permissions',
  ]);
});

test('restart honors the STORED per-agent choice, not the live global toggle', () => {
  // Restart/restore/revive pass the agent's persisted permissionMode through to
  // spawnPty; spawnAgentCore injects per that mode. A stored 'default' stays
  // flag-less even on an install with autoMode on (and vice versa).
  const cmd = buildSpawnCommand(autoConfig, 'claude-sonnet-5', 'claude');
  assert.deepEqual(
    [...tokenizeCommand(cmd), ...permissionModeArgs(cmd, 'claude', 'bypass')],
    ['claude', '--model', 'claude-sonnet-5', '--dangerously-skip-permissions'],
  );
  assert.deepEqual(
    [...tokenizeCommand(cmd), ...permissionModeArgs(cmd, 'claude', 'default')],
    ['claude', '--model', 'claude-sonnet-5'],
  );
});

test('joined command+args guard: an operator-typed flag is respected, never doubled', () => {
  // spawnAgentCore guards with the JOIN of command + args (the flag may live
  // in either: a user-typed flag lands in args after tokenization; a persisted
  // pre-fix command string bakes it into the command). Both spellings — single
  // token and multi-token grok — must suppress the injection.
  assert.deepEqual(
    permissionModeArgs(['claude', '--dangerously-skip-permissions'].join(' '), 'claude', 'bypass'),
    [],
  );
  assert.deepEqual(
    permissionModeArgs(
      ['grok', '--permission-mode', 'bypassPermissions'].join(' '),
      'grok',
      'bypass',
    ),
    [],
  );
});

test('model picker options stay provider-specific', () => {
  assert.equal(
    modelsForProvider('claude').find((model) => model.id === 'claude-opus-5')?.label,
    'Opus 5 · 1M',
  );
  assert.deepEqual(
    modelsForProvider('codex').map((model) => model.id),
    [undefined, 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  );
  assert.deepEqual(
    modelsForProvider('grok').map((model) => model.id),
    [undefined, 'grok-4.5'],
  );
  assert.deepEqual(
    modelsForProvider('kimi').map((model) => model.id),
    [undefined, 'kimi-code/k3', 'kimi-code/kimi-for-coding', 'kimi-code/kimi-for-coding-highspeed'],
  );
  assert.deepEqual(modelsForProvider('custom'), []);
});

test('Command Center model choices round-trip provider and model', () => {
  const encoded = encodeProviderModel('antigravity', 'Gemini 3.1 Pro (High)');
  assert.deepEqual(decodeProviderModel(encoded), {
    provider: 'antigravity',
    model: 'Gemini 3.1 Pro (High)',
  });
  assert.deepEqual(decodeProviderModel(encodeProviderModel('kimi')), {
    provider: 'kimi',
    model: undefined,
  });
  assert.equal(decodeProviderModel('unknown:model'), null);
});

test('God only sees providers that can drain hive inbox messages', () => {
  // God-eligible = supportsModel && canReceiveInbox: kimi and copilot are
  // excluded (no inbox drain path), custom is excluded (no model picker).
  assert.deepEqual(
    modelProvidersForAgent(true).map((preset) => preset.id),
    ['claude', 'codex', 'grok', 'antigravity', 'qwen', 'opencode', 'crush', 'pi'],
  );
  assert.deepEqual(
    modelProvidersForAgent(false).map((preset) => preset.id),
    [
      'claude',
      'codex',
      'grok',
      'kimi',
      'antigravity',
      'qwen',
      'opencode',
      'crush',
      'pi',
      'copilot',
    ],
  );
});
