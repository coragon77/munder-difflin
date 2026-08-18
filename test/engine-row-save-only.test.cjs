'use strict';

/**
 * God engine-row SAVE ONLY (card agent-command-center-save-with-2026-08-18).
 *
 * godEffort is READ AT SPAWN (spawnAgentCore injects godEffortArgs from fresh
 * config), but "apply" restarts with resume:false — so there was no way to set
 * god effort through the UI without ending the running conversation. "save only"
 * persists godProvider/godModel/godEffort via updateConfig and NOTHING else:
 * no restart, dirty clears via the savedEngine adoption, and a persistent
 * "saved — takes effect on next restart" hint keeps the row from LOOKING
 * applied while the live process still runs the old engine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const panel = () => read('src/renderer/src/components/CommandCenterPanel.tsx');

test('savedForNextRestart flag exists, starts false, remount is its clearing event', () => {
  const p = panel();
  assert.match(
    p,
    /useState\(false\)[\s\S]{0,80}savedForNextRestart|savedForNextRestart[\s\S]{0,200}useState\(false\)/,
    'boolean state, false on mount (any restart remounts the panel with the saved config live)',
  );
});

test('save only persists provider/model/effort and never restarts', () => {
  const p = panel();
  // The button block: anchor on its unique title, run to its closing tag.
  const start = p.indexOf('Persist without restarting');
  assert.ok(start > 0, 'the save-only button exists with an explicit title');
  const open = p.lastIndexOf('<PixelButton', start);
  const block = p.slice(open, p.indexOf('</PixelButton>', start));
  assert.match(block, /godProvider: engineProvider/, 'persists the provider');
  assert.match(block, /godModel: engineModel/, 'persists the model');
  assert.match(block, /godEffort: engineEffort/, 'persists the effort');
  assert.ok(!/restartWithModel/.test(block), 'it must NOT restart — that is the whole point');
  assert.match(block, /setSavedForNextRestart\(true\)/, 'it raises the next-restart flag');
  assert.match(block, /setSavedEngine\(/, 'it adopts the selection so dirty clears');
});

test('save only is inert unless there is something to save', () => {
  const p = panel();
  assert.match(
    p,
    /disabled=\{restarting === a\.id \|\| !engineDirty\}/,
    'disabled while a restart runs or the row is clean',
  );
});

test('the row SAYS when a saved engine is not live yet — and dirty outranks it', () => {
  const p = panel();
  assert.match(p, /saved — takes effect on next restart/, 'the persistent hint exists');
  assert.match(
    p,
    /engineDirty \?[\s\S]{0,200}unsaved — press apply[\s\S]{0,200}: savedForNextRestart \?[\s\S]{0,200}saved — takes effect on next restart/,
    'dirty hint first, next-restart hint second, never both',
  );
});

test('apply stays byte-true: still persists, adopts, and restarts with resume:false', () => {
  const p = panel();
  const applyLabel = p.indexOf("restarting === a.id ? 'restarting…' : 'apply'");
  assert.ok(applyLabel > 0, 'apply label untouched');
  const before = p.slice(0, applyLabel);
  assert.match(
    before,
    /restartWithModel\(a, engineModel, \{\s*provider: engineProvider,\s*resume: false,\s*\}\)/,
    'apply still restarts fresh — the card forbids changing what apply does',
  );
});
