'use strict';

/**
 * Settings helper-reopen + placement (card agent-settings-helper-model-no-
 * 2026-08-18).
 *
 * (1) BUG — helper model invisible on reopen. The modal remounts per open and
 *     the App's `config` prop is loaded once and never refreshed after a save
 *     (the reseed effect's own header comment). Every editable control is
 *     therefore re-seeded from DISK in the on-open getConfig effect — except
 *     the helper fields, which seeded only from the stale prop. The persisted
 *     helperDefaults (e.g. pi + openai-codex/gpt-5.6-luna) exist on disk, the
 *     engine runs them, but reopening showed provider-by-luck and no model.
 *     Fix = the intern pattern: reseed inside the on-open effect behind a
 *     touched-guard so a late resolve can't snap mid-edit picks back.
 *
 * (2) MOVE — the standup-clerk switch and the "Hidden helper engine" block
 *     move from the Connections section into Autonomy & Budgets, directly
 *     below the intern configuration. Placement only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

const sm = () => read('src/renderer/src/components/SettingsModal.tsx');

test('reseed: the on-open getConfig effect re-seeds the helper fields from DISK', () => {
  const p = sm();
  const effect = p.indexOf(
    '// Re-seed every editable field from the on-disk config when the modal opens.',
  );
  const internSeed = p.indexOf('setInternProvider((cc as HarnessConfig).internDefaults');
  assert.ok(effect > 0 && internSeed > effect, 'found the reseed effect region');
  // The helper reseed must live in the SAME effect (one disk read reseeds all).
  const helperProviderSeed = p.indexOf('setHelperProvider((cc as HarnessConfig).helperDefaults');
  const helperModelSeed = p.indexOf('setHelperModel((cc as HarnessConfig).helperDefaults');
  assert.ok(
    helperProviderSeed > effect && helperProviderSeed < internSeed + 1000,
    'helperProvider re-seeds inside the on-open effect',
  );
  assert.ok(
    helperModelSeed > effect && helperModelSeed < internSeed + 1000,
    'helperModel re-seeds inside the on-open effect',
  );
});

test('snap-back guard: helper writes set the touched ref (intern pattern parity)', () => {
  const p = sm();
  const touchedDecl = p.indexOf('helperDefaultsTouched.current = true');
  assert.ok(touchedDecl > 0, 'writeHelperDefaults marks the fields touched');
  const guardUse = p.indexOf('!helperDefaultsTouched.current');
  assert.ok(guardUse > 0, 'the reseed is guarded by the touched ref');
  assert.ok(touchedDecl > p.indexOf('const writeHelperDefaults'), 'set inside the writer');
});

test('placement: clerk + helper blocks live in Autonomy & Budgets, below intern config', () => {
  const p = sm();
  const autonomy = p.indexOf("activeSection === 'Autonomy & Budgets'");
  const connections = p.indexOf("activeSection === 'Connections'");
  const autonomyEnd = p.indexOf('activeSection', autonomy + 10);
  const intern = p.indexOf('Intern defaults — engine + model', autonomy);
  const clerk = p.indexOf('Standup clerk', autonomy);
  const helper = p.indexOf('Hidden helper engine', autonomy);
  assert.ok(autonomy > 0 && connections > autonomy, 'both sections exist');
  assert.ok(
    intern > 0 && clerk > intern && helper > clerk,
    'order inside Autonomy & Budgets: intern < standup clerk < helper engine',
  );
  assert.ok(
    helper < autonomyEnd && clerk < autonomyEnd,
    'both blocks sit INSIDE the Autonomy & Budgets section',
  );
  // And they are GONE from Connections: no second occurrence after it starts.
  const after = p.slice(connections);
  assert.equal(after.indexOf('Standup clerk'), -1, 'no clerk copy in Connections');
  assert.equal(after.indexOf('Hidden helper engine'), -1, 'no helper copy in Connections');
});
