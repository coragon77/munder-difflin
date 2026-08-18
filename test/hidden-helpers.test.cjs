'use strict';

/**
 * hidden-helpers (engine-neutral one-shot assistants).
 *
 * The harness's hidden one-shots (standup clerk, memory condenser) were
 * hardwired to the claude binary through runHiddenClaude — an Anthropic API
 * outage took down the clerk AND god's engine switch left no helper at all.
 * The card adds ONE resolved engine for every hidden helper:
 *
 *   resolveHelperEngine: helperDefaults (Settings) > godProvider (onboarding
 *   driver choice) > 'claude'. Model: helperDefaults.model > claude's
 *   haiku-class helper constant > CLI's own default (pi: no --model flag —
 *   the operator pins one in Settings if they want it).
 *
 *   runHiddenHelper dispatches: claude → runHiddenClaude (unchanged PTY
 *   machinery), pi → runHiddenPi (plain headless `pi -p`, no PTY dance).
 *   Other providers are refused loudly — call sites already have
 *   deterministic fallbacks (clerk facts / condense-abort).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { resolveHelperEngine, piHelperArgs } = loadTs('src/main/hiddenHelpers.ts');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const CFG = (over) => ({
  defaultCommand: 'claude',
  godProvider: 'claude',
  ...over,
});

// ——— resolution precedence ————————————————————————————————————————————————

test('helperDefaults win over the onboarding driver choice', () => {
  const r = resolveHelperEngine(CFG({ helperDefaults: { provider: 'pi', model: 'x/y' } }));
  assert.equal(r.provider, 'pi');
  assert.equal(r.model, 'x/y');
  assert.equal(r.command, 'pi');
});

test('unset falls back to godProvider — a pi god gets pi helpers with the CLI default model', () => {
  const r = resolveHelperEngine(CFG({ godProvider: 'pi', defaultCommand: 'custom-claude' }));
  assert.equal(r.provider, 'pi');
  assert.equal(r.model, undefined, 'pi never gets a forced model id');
  assert.equal(r.command, 'pi');
});

test('unset everything keeps today exactly: claude + haiku helper + defaultCommand honored', () => {
  const r = resolveHelperEngine(CFG({ defaultCommand: '/opt/claude --flag' }));
  assert.equal(r.provider, 'claude');
  assert.match(r.model, /haiku/);
  assert.equal(r.command, '/opt/claude --flag');
});

test('blank strings are unset (Settings writes empty on clear)', () => {
  const r = resolveHelperEngine(CFG({ helperDefaults: { provider: '', model: '  ' } }));
  assert.equal(r.provider, 'claude');
  assert.match(r.model, /haiku/);
});

test('a claude pick may pin a non-haiku model; a pi pick may pin any model id', () => {
  const c = resolveHelperEngine(CFG({ helperDefaults: { provider: 'claude', model: 'sonnet' } }));
  assert.equal(c.model, 'sonnet');
  const p = resolveHelperEngine(
    CFG({ godProvider: 'pi', helperDefaults: { model: 'anthropic/claude-haiku-4-5' } }),
  );
  assert.equal(p.provider, 'pi');
  assert.equal(p.model, 'anthropic/claude-haiku-4-5');
});

// ——— pi argv ———————————————————————————————————————————————————————————————

test('piHelperArgs: headless flags, optional --model, prompt as ONE argv element', () => {
  const base = piHelperArgs(undefined, 'summarize this');
  assert.deepEqual(base, ['-p', '--no-tools', '--no-session', '--mode', 'text', 'summarize this']);
  const withModel = piHelperArgs('anthropic/claude-haiku-4-5', 'multi word prompt');
  assert.deepEqual(withModel, [
    '-p',
    '--no-tools',
    '--no-session',
    '--mode',
    'text',
    '--model',
    'anthropic/claude-haiku-4-5',
    'multi word prompt',
  ]);
  assert.equal(withModel[withModel.length - 1], 'multi word prompt', 'prompt never split');
});

test('runHiddenPi ignores stdin — pi -p waits for EOF on an open pipe (live-verified hang)', () => {
  const src = read('src/main/hiddenHelpers.ts');
  assert.match(src, /stdio: \['ignore', 'pipe', 'pipe'\]/, 'stdin never a held-open pipe');
});

// ——— wiring (source pins, house style) ————————————————————————————————————

test('both hidden-helper call sites route through the resolved engine', () => {
  const clerk = read('src/main/index.ts').slice(
    read('src/main/index.ts').indexOf('async function runStandupClerk'),
  );
  assert.match(clerk, /resolveHelperEngine\(/, 'clerk resolves the helper engine');
  assert.match(clerk, /runHiddenHelper\(/, 'clerk dispatches through runHiddenHelper');
  assert.ok(!clerk.includes('STANDUP_CLERK_MODEL'), 'no hardcoded clerk model left');

  const reflect = read('src/main/reflect.ts');
  assert.match(reflect, /runHiddenHelper\(/, 'condenser dispatches through runHiddenHelper');
  assert.ok(!reflect.includes('CONDENSE_MODEL'), 'no hardcoded condense model left');
});

test('config + preload + Settings surface the helperDefaults knob', () => {
  assert.ok(
    read('src/main/config.ts').includes('helperDefaults?:'),
    'HarnessConfig carries helperDefaults',
  );
  assert.ok(
    read('src/preload/index.ts').includes('helperDefaults?:'),
    'renderer-facing config type carries the key',
  );
  const sm = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(sm.includes('writeHelperDefaults'), 'Settings writes the helper defaults');
  assert.ok(sm.includes('helperDefaults: {'), 'persists through updateConfig');
});
