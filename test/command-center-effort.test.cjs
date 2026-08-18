'use strict';

/**
 * God engine-row EFFORT dropdown (card agent-command-center-engine-ro-2026-08-18).
 *
 * A third control between the model Select and the apply button in god's
 * Command Center engine row, setting the thinking effort god runs at. The
 * flag NAME and LEVEL SET are provider-specific (VERIFIED on the binaries,
 * 2026-08-18): claude `--effort low|medium|high|xhigh|max`; pi `--thinking
 * off|minimal|low|medium|high|xhigh|max`. Modeled as a per-provider preset
 * field next to recommendedOrchestratorModel; providers without effort
 * support get no field → the control hides.
 *
 * TWO TRAPS (binding, from the card):
 * (1) claude does NOT hard-fail an unknown --effort value — it warns and uses
 *     the default. So tests assert the constructed ARGV, and an unknown or
 *     wrongly-cased config value must be DROPPED before it can silently
 *     degrade.
 * (2) Command-string tails are dropped at spawn (renderer-hire-flag-append
 *     bug): the effort flag rides opts.args via the permissionModeArgs-style
 *     injection, NEVER the command string.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { AGENT_PROVIDER_PRESETS, providerPreset, godEffortArgs } = loadTs(
  'src/shared/agentProvider.ts',
);

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// ── preset facts ────────────────────────────────────────────────────────────

test('presets: claude carries --effort with its 5 levels; pi carries --thinking with 7', () => {
  const claude = providerPreset('claude');
  assert.ok(claude.effort, 'claude has an effort spec');
  assert.equal(claude.effort.flag, '--effort');
  assert.deepEqual(claude.effort.levels, ['low', 'medium', 'high', 'xhigh', 'max']);

  const pi = providerPreset('pi');
  assert.ok(pi.effort, 'pi has an effort spec');
  assert.equal(pi.effort.flag, '--thinking');
  assert.deepEqual(pi.effort.levels, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('presets: providers without verified effort support carry NO spec (control hides)', () => {
  // Every OTHER shipped provider, checked individually per the card — a
  // provider whose CLI would reject the flag must never see one.
  const others = AGENT_PROVIDER_PRESETS.filter((p) => p.id !== 'claude' && p.id !== 'pi');
  assert.ok(others.length >= 8, 'sanity: the rest of the provider table is non-trivial');
  for (const p of others) {
    assert.equal(p.effort, undefined, `${p.id} must not declare effort support`);
  }
});

// ── argv construction (trap 1: assert argv, drop unknown values) ────────────

test('godEffortArgs: god + valid level → [flag, level] argv tokens', () => {
  assert.deepEqual(godEffortArgs('claude', 'claude', 'high', true), ['--effort', 'high']);
  assert.deepEqual(godEffortArgs('pi', 'pi', 'xhigh', true), ['--thinking', 'xhigh']);
  assert.deepEqual(godEffortArgs('claude', 'claude', 'max', true), ['--effort', 'max']);
});

test('godEffortArgs: unknown or wrongly-cased value is DROPPED (claude only warns)', () => {
  assert.deepEqual(godEffortArgs('claude', 'claude', 'bogus', true), []);
  assert.deepEqual(godEffortArgs('claude', 'claude', 'High', true), [], 'case-sensitive levels');
  assert.deepEqual(godEffortArgs('pi', 'pi', 'ultra', true), []);
  assert.deepEqual(godEffortArgs('pi', 'pi', 'OFF', true), []);
});

test('godEffortArgs: non-god agents and unset effort never get a flag', () => {
  assert.deepEqual(
    godEffortArgs('claude', 'claude', 'high', false),
    [],
    "worker panes: god's effort never leaks",
  );
  assert.deepEqual(godEffortArgs('claude', 'claude', undefined, true), []);
  assert.deepEqual(godEffortArgs('claude', 'claude', '', true), []);
});

test('godEffortArgs: a flag already on the line wins, never doubled', () => {
  assert.deepEqual(godEffortArgs('claude --effort max', 'claude', 'high', true), []);
  assert.deepEqual(godEffortArgs('pi --thinking off', 'pi', 'high', true), []);
  // the guard sees command+args joined, exactly like permissionModeArgs
  assert.deepEqual(godEffortArgs('claude --model opus', 'claude', 'high', true), [
    '--effort',
    'high',
  ]);
});

test('godEffortArgs: providers without a spec get nothing even for god', () => {
  assert.deepEqual(godEffortArgs('codex', 'codex', 'high', true), []);
  assert.deepEqual(godEffortArgs('qwen', 'qwen', 'high', true), []);
});

// ── config surface ──────────────────────────────────────────────────────────

test('config: godEffort key exists, mirrors godModel, and has NO default', () => {
  const cfg = read('src/main/config.ts');
  const iface = cfg.slice(
    cfg.indexOf('export interface HarnessConfig'),
    cfg.indexOf('const DEFAULTS'),
  );
  assert.match(iface, /godEffort\?: string;/, 'interface carries godEffort');
  const defaults = cfg.slice(cfg.indexOf('const DEFAULTS'));
  assert.ok(
    !/godEffort/.test(defaults),
    'DEFAULTS must not pin an effort — undefined = the CLI default',
  );
});

// ── wiring (trap 2: opts.args, never the command string) ───────────────────

test('spawnAgentCore injects godEffortArgs into opts.args (permissionModeArgs pattern)', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /godEffortArgs\(/, 'the injector is called');
  assert.match(
    idx,
    /godEffortArgs\(\s*\[opts\.command, \.\.\.\(opts\.args \?\? \[\]\)\]\.join\(' '\)/,
    'it receives the command+args join like permissionModeArgs',
  );
  assert.match(
    idx,
    /if \(effortArgs\.length\) opts\.args = \[\.\.\.\(opts\.args \?\? \[\]\), \.\.\.effortArgs\];/,
    'the tokens are appended to opts.args',
  );
});

test('buildSpawnCommand stays flag-free: no effort token in the command string', () => {
  const store = read('src/renderer/src/store/config.ts');
  const fn = store.slice(store.indexOf('export function buildSpawnCommand'));
  assert.ok(
    !/effort/i.test(fn.slice(0, fn.indexOf('\nexport '))),
    'the command string must never carry the effort flag (tails are dropped at spawn)',
  );
});

// ── renderer surface ────────────────────────────────────────────────────────

test('CommandCenterPanel: EFFORT Select between model Select and apply, driven by the preset', () => {
  const p = read('src/renderer/src/components/CommandCenterPanel.tsx');
  // seeded from config like engineModel
  assert.match(p, /setEngineEffort\(c\.godEffort\)/, 'state seeds from config.godEffort');
  // driven by the per-provider preset, not a hardcoded list
  assert.match(
    p,
    /effortLevels|preset\.effort|providerPreset\([^)]*\)\.effort/,
    'options come from the preset',
  );
  assert.match(p, /effort: default/, 'an explicit default option exists');
  // rides the apply path — same updateConfig as provider+model
  assert.match(p, /godEffort: engineEffort/, 'apply persists godEffort');
  // placement: between the model Select and the apply button — the effort
  // Select appears after the model select (modelsFor — pi-discovered, god-pi-
  // switch follow-up) and before the apply PixelButton.
  const modelSel = p.indexOf('modelsFor(engineProvider)');
  const effortSel = p.indexOf('engineEffort ??');
  const apply = p.indexOf("restarting === a.id ? 'restarting…' : 'apply'");
  assert.ok(
    modelSel > 0 && effortSel > modelSel && apply > effortSel,
    'order: model < effort < apply',
  );
  // Provider switches re-seed an effort the new vocabulary doesn't take
  // (pi 'off' under claude) — the dropdown never shows a dead value.
  assert.match(
    p,
    /!preset\?\.effort\?\.levels\.includes\(engineEffort\)/,
    'provider switch clears a stale effort level',
  );
});

test('preload + renderer HarnessConfig mirror godEffort', () => {
  assert.match(read('src/preload/index.ts'), /godEffort\?: string;/);
  assert.match(read('src/renderer/src/store/config.ts'), /godEffort\?: string;/);
});
