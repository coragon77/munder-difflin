'use strict';

/**
 * save-only provider scoping (deputy card god-pi-switch-2026-08-18, fix 2 of 2).
 *
 * "save only" was born for EFFORT (safe to defer: read at spawn, same engine,
 * same session). But it defers provider/model the same way — and a DEFERRED
 * provider switch is the one production door into the stale-resume crash:
 * config says pi while the registry keeps the claude-era sessionId (fix 1
 * guards the spawn; this fix removes the UI lie at its source).
 *
 * Scope: when the provider select is dirty against the persisted snapshot,
 * save only persists EFFORT ALONE (provider-agnostic, always deferrable); a
 * model picked from the NEW provider's list is a foreign-dialect id and is
 * dropped with it. The row stays dirty and says why: an engine switch needs
 * apply (fresh session by design — a different engine can't resume the thread).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const panel = () => read('src/renderer/src/components/CommandCenterPanel.tsx');

test('engineSwitchPending is derived from the provider select vs the persisted snapshot', () => {
  const p = panel();
  assert.match(
    p,
    /engineSwitchPending = engineProvider !== savedEngine\.provider/,
    'the pending-switch condition is explicit',
  );
});

test('save only scopes to effort when an engine switch is pending (no provider/model persisted)', () => {
  const p = panel();
  const start = p.indexOf('Persist without restarting');
  assert.ok(start > 0, 'the save-only button still exists');
  const open = p.lastIndexOf('<PixelButton', start);
  const block = p.slice(open, p.indexOf('</PixelButton>', start));
  assert.match(
    block,
    /engineSwitchPending\s*\?\s*\{\s*godEffort: engineEffort,?\s*\}\s*:\s*\{/,
    'a conditional persist payload exists (effort-only vs full)',
  );
  // The effort-only arm must NOT carry the provider/model keys.
  const pendingArm = block.match(/engineSwitchPending\s*\?\s*(\{[^{}]*\})\s*:/)?.[1];
  assert.ok(pendingArm, 'the pending arm of the payload was found');
  assert.ok(
    !pendingArm.includes('godProvider') && !pendingArm.includes('godModel'),
    'the pending arm persists no provider/model (engine switches need apply)',
  );
});

test('the row explains why it stays dirty on a pending engine switch', () => {
  const p = panel();
  assert.match(
    p,
    /engine switch needs apply/i,
    'a visible reason replaces the silently-staying-dirty row',
  );
});
