'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { tokenizeCommand, commandCarriesModel, permissionModeArgs, prependCommandTail } = loadTs(
  'src/shared/agentProvider.ts',
);

// Card renderer-hire-flag-append-20260816: flags typed into a hire's command
// string were dropped at spawn — pty.spawn resolves only the first token to a
// binary and passes opts.args as argv. spawnAgentCore now tokenizes the tail
// and PREPENDS it to opts.args before permissionModeArgs runs. These tests
// replay that composition exactly as spawnAgentCore wires it.

/** Mirror of spawnAgentCore's tail-prepend + permission-inject composition. */
function composeArgv(command, provider, mode, args = []) {
  let argv = prependCommandTail(command, args);
  argv = [...argv, ...permissionModeArgs([command, ...argv].join(' '), provider, mode)];
  return argv;
}

test('tokenizeCommand: bare binary, flags, quoted args round-trip', () => {
  assert.deepEqual(tokenizeCommand('claude'), ['claude']);
  assert.deepEqual(tokenizeCommand('pi --approve'), ['pi', '--approve']);
  assert.deepEqual(tokenizeCommand('  claude   --model   opus  '), ['claude', '--model', 'opus']);
  // buildSpawnCommand quotes whitespace model labels ('agy' display names) —
  // the quoted value must survive as ONE token, quotes stripped.
  assert.deepEqual(tokenizeCommand('agy --model "Gemini 3.1 Pro (High)"'), [
    'agy',
    '--model',
    'Gemini 3.1 Pro (High)',
  ]);
  assert.deepEqual(tokenizeCommand('claude --note \'two words\' --x "a b"'), [
    'claude',
    '--note',
    'two words',
    '--x',
    'a b',
  ]);
  assert.deepEqual(tokenizeCommand(''), []);
});

test('typed tail + stored bypass → flag reaches argv, never doubled', () => {
  // Kevin/dwight/angela roster shape: '--permission-mode bypassPermissions'
  // typed into the command + bypass mode resolved at spawn.
  const cmd = 'claude --model claude-opus-5 --permission-mode bypassPermissions';
  const argv = composeArgv(cmd, 'claude', 'bypass');
  assert.equal(argv.filter((a) => a === '--permission-mode').length, 1);
  assert.ok(
    !argv.includes('--dangerously-skip-permissions'),
    'bypass flag must not double a typed --permission-mode',
  );
  assert.deepEqual(argv, ['--model', 'claude-opus-5', '--permission-mode', 'bypassPermissions']);
});

test('typed bypass flag + bypass mode → no doubling', () => {
  // oscar/andy roster shape.
  const argv = composeArgv('claude --dangerously-skip-permissions', 'claude', 'bypass');
  assert.deepEqual(argv, ['--dangerously-skip-permissions']);
});

test('bare command + bypass mode → flag still injected', () => {
  assert.deepEqual(composeArgv('claude', 'claude', 'bypass'), ['--dangerously-skip-permissions']);
  assert.deepEqual(composeArgv('claude', 'claude', 'auto'), ['--permission-mode', 'auto']);
});

test("'pi --approve' tail reaches argv (Pam's case)", () => {
  const argv = composeArgv('pi --approve', 'pi', 'auto');
  assert.deepEqual(argv, ['--approve']);
  assert.equal(
    argv.filter((a) => a === '--approve').length,
    1,
    'pi autoFlag must not double the typed tail',
  );
});

test('install-relaunch re-entry: the tail is never prepended twice', () => {
  // The missing-CLI install-relaunch re-enters spawnAgentCore with the SAME
  // opts object — its stored args already carry the tail from pass 1.
  const command = 'claude --model claude-opus-5';
  const pass1 = prependCommandTail(command, []);
  assert.deepEqual(pass1, ['--model', 'claude-opus-5']);
  const pass2 = prependCommandTail(command, pass1);
  assert.deepEqual(pass2, ['--model', 'claude-opus-5']);
  // Caller-provided args ride AFTER the tail on the first pass…
  assert.deepEqual(prependCommandTail(command, ['--resume', 'abc']), [
    '--model',
    'claude-opus-5',
    '--resume',
    'abc',
  ]);
  // …and a bare command leaves args untouched.
  const untouched = ['--model', 'opus'];
  assert.equal(prependCommandTail('claude', untouched), untouched);
});

test('tail --model + roster model field → single --model', () => {
  assert.ok(commandCarriesModel('claude --model claude-opus-5'));
  assert.ok(commandCarriesModel('claude --model "Gemini 3.1 Pro (High)"'));
  assert.ok(!commandCarriesModel('claude'));
  assert.ok(!commandCarriesModel('pi --approve'));
  assert.ok(!commandCarriesModel(undefined));
  // Recall/spawn-request callers: recipe model skipped when the tail carries one.
  const command = 'claude --model claude-opus-5';
  const recipeModel = 'claude-opus-5';
  const callerArgs = recipeModel && !commandCarriesModel(command) ? ['--model', recipeModel] : [];
  const argv = composeArgv(command, 'claude', 'auto', callerArgs);
  assert.equal(argv.filter((a) => a === '--model').length, 1);
  // …and still appended when the tail has none.
  const callerArgs2 = recipeModel && !commandCarriesModel('claude') ? ['--model', recipeModel] : [];
  assert.deepEqual(composeArgv('claude', 'claude', 'auto', callerArgs2), [
    '--model',
    'claude-opus-5',
    '--permission-mode',
    'auto',
  ]);
});
