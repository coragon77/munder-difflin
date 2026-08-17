'use strict';

/**
 * Settings UI mirror for the standupClerk switch (card
 * agent-harness-settings-ui-mirr-2026-08-17). Nate's finding on f415122:
 * standupClerk was config-file only while every sibling switch
 * (workersEnabled, integrationMode, kittyEnabled) has a Settings toggle.
 * Default ON (missing = on), same semantics as standupTarget in
 * src/main/standup.ts. Renderer-only branch — restart-window merge policy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

test('preload: the bridge config exposes standupClerk', () => {
  const idx = read('src/preload/index.ts');
  assert.ok(idx.includes('standupClerk?: boolean'), 'renderer-facing config type carries the key');
});

test('SettingsModal: toggle reads default-ON, persists via updateConfig', () => {
  const sm = read('src/renderer/src/components/SettingsModal.tsx');
  // Default ON: only explicit false switches it off (standupTarget semantics).
  assert.ok(
    sm.includes('config.standupClerk !== false'),
    'state hydrates default-ON (missing = on)',
  );
  assert.ok(
    sm.includes('{ standupClerk: next }'),
    'the toggle persists through window.cth.updateConfig',
  );
  assert.match(sm, /[Ss]tandup clerk/, 'a labeled row exists');
  // The toggle must not be dead UI: it is wired to onClick like kitty's.
  assert.ok(/void toggleStandupClerk\(\)/.test(sm), 'the row is wired to the toggle handler');
});

test('no store mirror required (no renderer affordance consumes it live)', () => {
  // The scheduler reads the config at standup time in MAIN — unlike
  // kittyEnabled there is no renderer surface that must flip live, so the
  // toggle persists and the next standup picks it up. Assert the negative:
  // no setStandupClerk store action is being added.
  const sm = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(!sm.includes('setStandupClerkStore'), 'no store mirror smuggled in');
});
