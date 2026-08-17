'use strict';

/**
 * KITTY ENABLED GATE (card agent-harness-kittyenabled-set-2026-08-17).
 *
 * One settings switch, default OFF, gating EVERY kitty feature. Two layers:
 *  • MAIN (source of truth): the probe, the satellite/tab launcher, and NEW
 *    detaches all refuse when the switch is off — so even raw IPC cannot start
 *    kitty. REATTACH stays open on purpose: it is the recovery path for a pane
 *    detached before the flip; refusing it would strand a live pty in an
 *    orphaned kitty window.
 *  • RENDERER: a store mirror (synced from config at boot and on toggle) hides
 *    the affordances live — kitty buttons, detach toggles — while a pane
 *    already detached keeps its reattach escape.
 *
 * Default OFF must hold for EXISTING configs: missing field = off (DEFAULTS
 * fill in readConfig).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

test('config: kittyEnabled defaults OFF and missing-field reads as off', () => {
  const cfg = read('src/main/config.ts');
  const defaultsAt = cfg.indexOf('const DEFAULTS: HarnessConfig =');
  assert.ok(defaultsAt > 0, 'DEFAULTS object exists');
  const defaults = cfg.slice(defaultsAt, cfg.indexOf('};', defaultsAt));
  assert.ok(
    defaults.includes('kittyEnabled: false'),
    'DEFAULTS pins kittyEnabled: false — readConfig deep-fills, so existing configs (missing field) read as off',
  );
  assert.ok(cfg.includes('kittyEnabled?: boolean'), 'schema field exists');

  const mirror = read('src/renderer/src/store/config.ts');
  assert.ok(mirror.includes('kittyEnabled?: boolean'), 'renderer config mirror has the field');
});

test('main: probe, satellite/tab launch, and NEW detach refuse when off; reattach stays open', () => {
  const src = read('src/main/index.ts');

  const probeAt = src.indexOf("ipcMain.handle('system:isKittyAvailable'");
  assert.ok(probeAt > 0, 'probe handler exists');
  const probe = src.slice(probeAt, src.indexOf('});', probeAt));
  assert.ok(
    probe.includes('kittyEnabled') && probe.includes('return false'),
    'probe reports unavailable when the switch is off (hides every probe-driven button)',
  );

  const openAt = src.indexOf("ipcMain.handle('terminal:openInKitty'");
  assert.ok(openAt > 0, 'openInKitty handler exists');
  const open = src.slice(openAt, src.indexOf('});', src.indexOf('runLaunch', openAt)));
  assert.ok(
    open.includes('kittyEnabled') && open.includes('return { ok: false'),
    'openInKitty (satellite + tabs) refuses when off',
  );

  const detachAt = src.indexOf("ipcMain.handle('pty:detach'");
  assert.ok(detachAt > 0, 'detach handler exists');
  const detach = src.slice(detachAt, src.indexOf('});', detachAt));
  assert.ok(
    detach.includes('kittyEnabled') && detach.includes('return { ok: false'),
    'pty:detach refuses NEW detaches when off',
  );

  const reattachAt = src.indexOf("ipcMain.handle('pty:reattach'");
  const reattach = src.slice(reattachAt, src.indexOf('});', reattachAt));
  assert.ok(
    !reattach.includes('kittyEnabled'),
    'reattach deliberately NOT gated — recovery path for pre-flip detaches (otherwise a live pty is stranded)',
  );
});

test('renderer: store mirror synced from config and every kitty affordance gated', () => {
  const store = read('src/renderer/src/store/store.ts');
  assert.ok(store.includes('kittyEnabled: boolean'), 'store carries the mirror flag');
  assert.ok(store.includes('setKittyEnabled'), 'store has the setter');

  const app = read('src/renderer/src/App.tsx');
  assert.ok(
    app.includes('setKittyEnabled(c.kittyEnabled === true)'),
    'App mirrors config → store at boot (missing field = off)',
  );

  // Pane: kitty button + detach toggle. The toggle keeps the reattach escape.
  const pane = read('src/renderer/src/components/AgentDetailPanel.tsx');
  assert.ok(
    pane.includes('kittyAvailable === true && kittyEnabled'),
    'pane kitty button hidden when off',
  );
  assert.ok(
    pane.includes("=== 'human' && (kittyEnabled || detached)"),
    'pane detach toggle gated, detached pane keeps its reattach escape',
  );

  // Card strip: the detach icon affordance.
  const strip = read('src/renderer/src/components/AgentStrip.tsx');
  assert.ok(
    strip.includes('(kittyEnabled || detachedPtyIds.includes(a.ptyId))'),
    'card detach icon gated with the same escape',
  );

  // God pane: satellite button + god detach toggle.
  const cc = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.ok(
    cc.includes('if (available !== true || !kittyEnabled) return null'),
    'GodKittyButton hidden when off',
  );
  assert.ok(
    cc.includes('agent.ptyId && (kittyEnabled || godDetached)'),
    'god detach toggle gated with the same escape',
  );
});

test('mounted views re-probe when the switch flips — no remount needed', () => {
  // Card agent-kittyenabled-toggle-moun-2026-08-17: main gates the probe
  // per call, but consumers probed ONCE at mount and cached — a view mounted
  // while OFF held a stale `false` after the operator flipped ON, so buttons
  // only appeared after switching cards (accidental remount). The probe
  // effects must re-run when the store flag flips.
  const pane = read('src/renderer/src/components/AgentDetailPanel.tsx');
  assert.ok(
    pane.includes('}, [kittyEnabled]);', pane.indexOf('.isKittyAvailable()')),
    'pane kitty probe re-runs when kittyEnabled flips (dep array carries the flag)',
  );

  const cc = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.ok(
    cc.includes('}, [kittyEnabled]);', cc.indexOf('GodKittyButton')),
    'GodKittyButton probe re-runs when kittyEnabled flips',
  );
});

test('settings: self-contained switch row with the VERBATIM tooltip, persisting immediately', () => {
  const modal = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(
    modal.includes('title="Kitty integration, if on assumes kitty is installed."'),
    'tooltip is verbatim, including the trailing period',
  );
  assert.ok(
    modal.includes('updateConfig({ kittyEnabled: next }'),
    'toggle persists via updateConfig — no separate save step',
  );
  assert.ok(
    modal.includes('setKittyEnabledStore(next)'),
    'toggle mirrors into the store so affordances flip live',
  );
});

test('generated god docs tell the truth about the switch', () => {
  const hive = read('src/main/hive.ts');
  assert.ok(
    /KITTY SATELLITE[\s\S]{0,400}Kitty integration[\s\S]{0,200}default OFF/.test(hive),
    'COMMANDS.md kitty section opens with the switch note',
  );
});
