'use strict';

/**
 * god-pi-switch (deputy card, 2026-08-18).
 *
 * The operator moved god from claude to pi; god stayed dead. Three gaps:
 *
 *  (1) STALE godModel POISONS THE BOOT — config carried godModel
 *      'claude-opus-5' from the claude era; buildSpawnCommand passed it
 *      through verbatim → `pi --model claude-opus-5` → boot dies. A model id
 *      from ANOTHER provider's dialect is stale config, never intent: fall
 *      back to the target provider's recommended orchestrator model (or the
 *      CLI default if it has none).
 *
 *  (2) THE KITTY SATELLITE CO-TERMINAL IGNORED godProvider — godCommand()
 *      built from config.defaultCommand only, so a pi god kept getting a
 *      claude co-terminal. It must resolve the god engine: godProvider >
 *      claude; claude keeps defaultCommand compat, other providers use their
 *      preset binary (permissionModeArgs already maps pi bypass → --approve).
 *
 *  (3) godProvider has no post-onboarding UI — the flip itself is a
 *      config.json edit; the restart-window config patcher does it while the
 *      app is closed (see hive/restart-config-pi-god.log).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { buildSpawnCommand } = loadTs('src/renderer/src/store/config.ts');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// ——— (1) stale-model guard in buildSpawnCommand ——————————————————————————

test('a claude-dialect godModel on a pi spawn falls back to the pi recommendation', () => {
  const cmd = buildSpawnCommand({ defaultCommand: 'claude' }, 'claude-opus-5', 'pi');
  assert.ok(cmd.startsWith('pi'), `command starts with pi: ${cmd}`);
  assert.ok(!cmd.includes('claude-opus-5'), `stale model dropped: ${cmd}`);
  assert.match(cmd, /--model anthropic\//, 'pi recommended orchestrator model applied');
});

test('a matching model still passes through untouched (guard is dialect-aware, not a blanket drop)', () => {
  const pi = buildSpawnCommand({ defaultCommand: 'claude' }, 'anthropic/claude-haiku-4-5', 'pi');
  assert.match(pi, /--model anthropic\/claude-haiku-4-5/);
  const cl = buildSpawnCommand({ defaultCommand: 'claude' }, 'claude-opus-5', 'claude');
  assert.match(cl, /--model claude-opus-5/);
});

test('a provider with no recommended model drops the stale flag entirely (CLI default)', () => {
  const cmd = buildSpawnCommand({ defaultCommand: 'claude' }, 'claude-opus-5', 'codex');
  assert.ok(!cmd.includes('claude-opus-5'), `stale model dropped: ${cmd}`);
  assert.ok(!/--model/.test(cmd) || !cmd.includes('claude-'), `no claude id smuggled: ${cmd}`);
});

// ——— (2) kitty satellite godCommand resolves the god engine ——————————————

test('godCommand: godProvider drives the co-terminal, claude keeps defaultCommand compat', () => {
  const src = read('src/main/kittySatellite.ts');
  assert.match(src, /godProvider/, 'the satellite reads the god engine from config');
  // The provider resolution must happen BEFORE the command is chosen, and the
  // claude-only flag branches must key on the RESOLVED provider, not parts[0].
  const fn = src.slice(src.indexOf('export function godCommand'));
  assert.match(fn, /providerPreset\(/, 'non-claude gods get their preset binary');
  assert.match(fn, /cfg\.defaultCommand/, 'claude compat path keeps the operator command');
  // pi's bypass maps to --approve through permissionModeArgs (provider-aware);
  // the guard must no longer hardcode parts[0] === 'claude'.
  assert.ok(!fn.includes("parts[0] === 'claude'"), 'flag branches keyed on the resolved provider');
});
