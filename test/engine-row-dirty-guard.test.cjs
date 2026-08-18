'use strict';

/**
 * God engine-row DIRTY guard (card agent-engine-row-silently-disc-2026-08-18).
 *
 * Provider/model/effort selects are local React state seeded from config.
 * Only "apply" persists them; god's "restart & continue" respawns the pane,
 * the panel remounts, the selects re-seed from config — a pending selection
 * was silently GONE. The operator read that as "the feature does not work".
 *
 * Fix shape (option a+d from the card, plus the guard that makes losing a
 * selection impossible to miss): a `savedEngine` snapshot of the persisted
 * config drives `engineDirty` over ALL THREE selects; while dirty the row
 * shows an "unsaved" affordance, apply flips to primary, and
 * restart & continue refuses without an explicit confirm. Option (c) —
 * carrying the selection into restart & continue — is rejected by the card:
 * that button's contract is resuming the SAME engine+model.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const panel = () => read('src/renderer/src/components/CommandCenterPanel.tsx');

test('savedEngine snapshot seeds from the SAME config read as the selects', () => {
  const p = panel();
  assert.match(p, /setSavedEngine\(/, 'a persisted-config snapshot state exists');
  assert.match(
    p,
    /setSavedEngine\(\{\s*provider: c\.godProvider \?\? 'claude',\s*model: c\.godModel,\s*effort: c\.godEffort,?\s*\}\)/,
    'it seeds from the exact godProvider/godModel/godEffort config keys',
  );
});

test('engineDirty covers ALL THREE selects — provider, model AND effort', () => {
  const p = panel();
  assert.match(
    p,
    /engineDirty =\s*engineProvider !== savedEngine\.provider \|\|\s*engineModel !== savedEngine\.model \|\|\s*engineEffort !== savedEngine\.effort/,
    'dirty compares every select against the persisted snapshot (the trap predates the effort work)',
  );
});

test('apply persists and THEN refreshes the snapshot (dirty clears)', () => {
  const p = panel();
  const applyPersist = p.indexOf('godEffort: engineEffort');
  assert.ok(applyPersist > 0, 'apply still persists all three keys');
  const refresh = p.search(
    /setSavedEngine\(\{\s*provider: engineProvider,\s*model: engineModel,\s*effort: engineEffort,?\s*\}\)/,
  );
  assert.ok(refresh > applyPersist, 'after updateConfig the snapshot adopts the applied values');
});

test('restart & continue (god row) refuses to discard a dirty selection silently', () => {
  const p = panel();
  // The god-row button lives AFTER the apply button (its label marker).
  const applyLabel = p.indexOf("restarting === a.id ? 'restarting…' : 'apply'");
  assert.ok(applyLabel > 0);
  const godRow = p.slice(applyLabel);
  const restartIdx = godRow.indexOf('restart &amp; continue');
  assert.ok(restartIdx > 0, 'god-row restart & continue still exists');
  const before = godRow.slice(0, restartIdx);
  assert.match(
    before,
    /engineDirty &&\s*!window\.confirm/,
    'its onClick confirms before discarding unsaved engine changes',
  );
  assert.match(
    before,
    /restartWithModel\(a, a\.model, \{ resume: true \}\)/,
    'it still resumes the SAME engine+model (contract intact)',
  );
});

test('dirty affordance: unsaved hint + apply emphasised', () => {
  const p = panel();
  assert.match(p, /unsaved — press apply/, 'a visible one-line hint when dirty');
  assert.match(
    p,
    /variant=\{engineDirty \? 'primary' : 'secondary'\}/,
    'apply flips to primary while a selection waits',
  );
});

test('non-god restart & continue stays unguarded — no pending selects to lose there', () => {
  const p = panel();
  // The non-god row renders the plain arrow form; only the god row got the
  // confirm block. Assert the untouched one-liner still exists.
  assert.match(
    p,
    /onClick=\{\(\) => restartWithModel\(a, a\.model, \{ resume: true \}\)\}/,
    'per-agent row keeps its immediate restart',
  );
});
