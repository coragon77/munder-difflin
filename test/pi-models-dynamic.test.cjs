'use strict';

/**
 * pi models are DISCOVERED, never hardcoded (deputy card
 * god-pi-switch-2026-08-18, follow-up: "PI_MODELS is utter bullshit").
 *
 * The static PI_MODELS list was written before discovery existed and lied in
 * two directions: it suggested ids the operator never configured (sonnet as
 * the first real entry), and it fed the preset's recommendedOrchestratorModel
 * — so switching the engine row or onboarding to pi PRESELECTED
 * anthropic/claude-sonnet-4-5, and apply booted `pi --model
 * anthropic/claude-sonnet-4-5` on an operator whose pi default is glm-5.3
 * (live report 2026-08-18: "agent does not start with the default model").
 *
 * The harness already HAS the right mechanism (card
 * agent-harness-provider-model-l-2026-08-17): useProviderModels discovers the
 * auth-scoped list via `pi --list-models`. This card finishes the job:
 *   - every god/agent model picker uses the discovered list for pi
 *   - the static PI_MODELS fallback is `default` ONLY (no fake suggestions)
 *   - the pi preset carries NO recommendedOrchestratorModel (pi's default
 *     model is the operator's own pi config — discovery is the catalog)
 *   - buildSpawnCommand's foreign-dialect guard DROPS the stale model instead
 *     of substituting a recommendation
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// ——— the static list stops suggesting ————————————————————————————————————

test('PI_MODELS fallback offers ONLY the CLI default — no hardcoded ids', () => {
  const { PI_MODELS } = loadTs('src/renderer/src/store/config.ts');
  assert.equal(PI_MODELS.length, 1, `exactly one fallback entry, got ${PI_MODELS.length}`);
  assert.equal(PI_MODELS[0].id, undefined, 'the fallback entry is the CLI default');
});

test('the pi preset carries NO recommended orchestrator model', () => {
  const { providerPreset } = loadTs('src/shared/agentProvider.ts');
  assert.equal(
    providerPreset('pi').recommendedOrchestratorModel,
    undefined,
    'pi model choice = operator pi config + discovery, never a preset guess',
  );
});

// ——— pickers use the discovered list ————————————————————————————————————

test('Command Center god engine row + agent pickers use discovered pi models', () => {
  const p = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.match(p, /useProviderModels\('pi'\)/, 'the panel holds the discovered pi list');
  assert.match(
    p,
    /p === 'pi' \? \w+ModelOptions|p === 'pi' \? piModelOptions/,
    'a models-for-provider helper routes pi to the discovered list',
  );
  const engineRow = p.indexOf('modelsForProvider(engineProvider)');
  assert.equal(engineRow, -1, 'the engine row no longer reads the static list directly');
});

test('Onboarding god picker uses the discovered list for pi', () => {
  const w = read('src/renderer/src/components/OnboardingWizard.tsx');
  assert.match(w, /useProviderModels\(/, 'onboarding consumes discovered models');
  assert.equal(
    w.indexOf('modelsForProvider(godProvider)'),
    -1,
    'the god picker no longer reads the static list directly',
  );
});

// ——— the stale-model guard drops, never substitutes ————————————————————

test('a claude-dialect godModel on a pi spawn DROPS the flag (CLI default, no substitution)', () => {
  const { buildSpawnCommand } = loadTs('src/renderer/src/store/config.ts');
  const cmd = buildSpawnCommand({ defaultCommand: 'claude' }, 'claude-opus-5', 'pi');
  assert.ok(cmd.startsWith('pi'), `command starts with pi: ${cmd}`);
  assert.ok(!cmd.includes('claude-opus-5'), `stale model dropped: ${cmd}`);
  assert.ok(!cmd.includes('--model'), `no model forced — the CLI default rules: ${cmd}`);
});
