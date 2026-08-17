'use strict';

/**
 * workersEnabled (DEFAULT OFF) + internsEnabled (DEFAULT ON) — card
 * agent-harness-workersenabled-d-2026-08-17.
 *
 * The old ephemeral-worker system is gated OFF by default (operator rationale:
 * workers are superseded by interns on this floor); the intern path stays ON.
 * Pinned here:
 *  - spawnSwitches (config.ts) — the asymmetric defaults every consumer reads:
 *    unset ⇒ workers OFF / interns ON, which is ALSO what an existing install
 *    whose config.json predates the fields must see (readConfig merges over
 *    DEFAULTS; the resolver re-encodes the asymmetry so the two can't drift)
 *  - DEFAULTS in config.ts carry the asymmetry (source pin)
 *  - the gate's PLACEMENT in processSpawnRequest (index.ts source pins — not
 *    loadable outside Electron; same pattern as worktree-isolation-refusal):
 *    both directions refuse before any spawn, each naming its setting
 *  - the voice allowlist (realtimeActions.ts) carries both keys confirm-tier
 *  - HIRING_AGENTS_MD documents both switches beside 'The two caps' with the
 *    superseded-by-interns rationale
 *  - the god-pane workers tab is hidden when workers are off (CommandCenterPanel
 *    source pin) and the settings UI + store mirror exist (renderer source pins)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { spawnSwitches } = loadTs('src/main/config.ts');
const { renderCommandsMd } = loadTs('src/main/hive.ts');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// ── spawnSwitches — the asymmetric defaults ────────────────────────────────

test('unset ⇒ workers OFF, interns ON (the shipped asymmetry)', () => {
  assert.deepEqual(spawnSwitches({}), { workers: false, interns: true });
  assert.deepEqual(spawnSwitches({ workersEnabled: undefined, internsEnabled: undefined }), {
    workers: false,
    interns: true,
  });
});

test('explicit values are honored both ways', () => {
  assert.deepEqual(spawnSwitches({ workersEnabled: true, internsEnabled: true }), {
    workers: true,
    interns: true,
  });
  assert.deepEqual(spawnSwitches({ workersEnabled: false, internsEnabled: false }), {
    workers: false,
    interns: false,
  });
  assert.deepEqual(spawnSwitches({ workersEnabled: true, internsEnabled: false }), {
    workers: true,
    interns: false,
  });
});

test('garbage values fall back to the asymmetry, never coerce', () => {
  assert.deepEqual(spawnSwitches({ workersEnabled: 'yes', internsEnabled: 0 }), {
    workers: false,
    interns: true,
  });
});

test('an existing install predating the fields sees workers OFF (DEFAULTS pin)', () => {
  // readConfig merges {...DEFAULTS, ...parsed}, so DEFAULTS IS what a
  // pre-field config.json resolves to — pin the asymmetry at the source.
  const src = read('src/main/config.ts');
  assert.match(src, /workersEnabled: false,/, 'DEFAULTS ship workers OFF');
  assert.match(src, /internsEnabled: true,/, 'DEFAULTS ship interns ON');
});

// ── gate placement in processSpawnRequest (source pins) ───────────────────

const idx = read('src/main', 'index.ts');
const fnStart = idx.indexOf('async function processSpawnRequest(');
assert.ok(fnStart > 0, 'processSpawnRequest found');
const fnEnd = idx.indexOf('function processFireRequest', fnStart);
const fnSrc = idx.slice(fnStart, fnEnd > fnStart ? fnEnd : idx.length);

test('the gate reads spawnSwitches from the live config', () => {
  assert.match(fnSrc, /spawnSwitches\(readConfig\(\)\)/);
});

test('both directions refuse BEFORE any spawn happens', () => {
  const gateAt = fnSrc.indexOf('spawnSwitches(readConfig())');
  const spawnAt = fnSrc.indexOf('spawnAgentCore(spawnOpts');
  assert.ok(gateAt > 0, 'gate present');
  assert.ok(spawnAt > 0, 'spawn call present');
  assert.ok(gateAt < spawnAt, 'gate sits before the spawn call');
  // persistent:true rides the interns switch, everything else the workers one
  assert.match(fnSrc, /internsEnabled|interns\b/);
  assert.match(fnSrc, /workersEnabled|workers\b/);
});

test('each refusal names its setting so the error is actionable', () => {
  assert.match(fnSrc, /workersEnabled/, 'worker refusal names workersEnabled');
  assert.match(fnSrc, /internsEnabled/, 'intern refusal names internsEnabled');
  assert.match(fnSrc, /superseded by interns/i, 'worker refusal carries the operator rationale');
});

// ── voice allowlist (realtimeActions.ts) ───────────────────────────────────

test('both switches are voice-settable, confirm tier like their siblings', () => {
  const src = read('src/main', 'realtimeActions.ts');
  assert.match(src, /workersEnabled: \{ tier: 'confirm', type: 'boolean' \}/);
  assert.match(src, /internsEnabled: \{ tier: 'confirm', type: 'boolean' \}/);
});

test('the voice tool description lists both keys as behavior-changing', () => {
  const src = read('src/renderer/src/realtime', 'actions.ts');
  const desc = src.slice(src.indexOf('Change one app setting'), src.indexOf('Secrets, folders'));
  assert.match(desc, /workersEnabled/);
  assert.match(desc, /internsEnabled/);
});

// ── HIRING_AGENTS_MD documentation ─────────────────────────────────────────

const cmds = renderCommandsMd();

test('the switches are documented beside "The two caps"', () => {
  const capsAt = cmds.indexOf('**The two caps');
  const switchesAt = cmds.indexOf('**The two switches');
  assert.ok(capsAt > 0, 'two caps section present');
  assert.ok(switchesAt > 0, 'two switches section present');
  assert.ok(switchesAt > capsAt, 'switches block follows the caps block');
});

test('the docs name both settings, their defaults, and the rationale', () => {
  assert.match(cmds, /`workersEnabled` \(default \*\*OFF\*\*\)/);
  assert.match(cmds, /`internsEnabled` \(default \*\*ON\*\*\)/);
  assert.match(cmds, /superseded by interns/i, 'operator rationale stays in the copy');
});

// ── god-pane workers tab hidden when workers are off (source pins) ─────────

test('the Command Center filters the workers tab on the store mirror', () => {
  const src = read('src/renderer/src/components', 'CommandCenterPanel.tsx');
  assert.match(src, /useStore\(\(s\) => s\.workersEnabled\)/, 'reads the store mirror');
  assert.match(
    src,
    /t\.key !== 'workers' \|\| workersOn/,
    'visibleTabs drops the workers tab when off',
  );
  assert.match(src, /tab === 'workers'/, 'never left parked on a hidden tab');
});

test('App seeds the store mirror from the loaded config', () => {
  const src = read('src/renderer/src', 'App.tsx');
  assert.match(src, /setWorkersEnabled\(/);
});

// ── settings UI beside the floor-cap stepper ───────────────────────────────

test('Settings exposes both switches and writes them through updateConfig', () => {
  const src = read('src/renderer/src/components', 'SettingsModal.tsx');
  assert.match(src, /updateConfig\(\{ workersEnabled:/);
  assert.match(src, /updateConfig\(\{ internsEnabled:/);
  assert.match(src, /superseded by interns/i, 'rationale in the settings copy too');
});
