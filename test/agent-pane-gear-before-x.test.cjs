'use strict';

// agent-agent-window-move-settin-2026-08-17: the agent pane header's settings
// gear sits immediately LEFT of the X (close) button. Source-text pin because
// the repo has no DOM harness (same discipline as vacation-ui-surface.test.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('agent pane header renders the settings gear immediately left of the X', () => {
  const src = read('src/renderer/src/components/AgentDetailPanel.tsx');
  const header = src.slice(src.indexOf('Thin header strip'), src.indexOf('openTerminalError &&'));

  const gear = header.indexOf('name="gear"');
  const x = header.indexOf('name="x"');
  assert.ok(gear !== -1, 'header still renders the settings gear');
  assert.ok(x !== -1, 'header still renders the X close button');
  assert.ok(gear < x, 'settings gear renders before the X');

  // "Immediately left of": the next button after the gear is the destructive X.
  const afterGearClose = header.slice(gear).slice(header.slice(gear).indexOf('</PixelButton>'));
  const nextButton = afterGearClose.indexOf('<PixelButton');
  assert.ok(nextButton !== -1, 'a button follows the settings gear');
  assert.ok(
    afterGearClose.slice(nextButton, nextButton + 60).includes('variant="destructive"'),
    'the button immediately right of the gear is the destructive X',
  );
});
