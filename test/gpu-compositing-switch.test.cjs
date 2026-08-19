'use strict';

/**
 * GPU compositing kill-switch for the whole-window flicker test
 * (card agent-add-disable-gpu-composit-2026-08-19).
 *
 * The flicker moved beyond the xterm panes to the office floor, which points
 * below xterm at GPU compositing / the NVIDIA driver. The instrument is
 * Chromium's --disable-gpu-compositing. Two properties must hold, and both
 * are source contracts because index.ts (7582 lines, electron import at the
 * top) cannot be loaded in a node --test process:
 *
 *  (1) ORDERING — appendSwitch is read at GPU-process startup. Appended
 *      after app.whenReady() resolves it is a silent no-op, i.e. the test
 *      "runs" with GPU compositing on and reports a false negative. So the
 *      call must sit at module top level, provably before the whenReady
 *      line — this is the assertion that fails if someone relocates it.
 *
 *  (2) ESCAPE HATCH — the A/B comparison must not cost a rebuild:
 *      MD_ENABLE_GPU_COMPOSITING=1 restores default GPU compositing.
 *
 * Boundary from the dispatch: --disable-gpu-compositing ONLY. Mixing in
 * --disable-gpu / disableHardwareAcceleration() would test two variables at
 * once and the flicker verdict would tell us nothing — asserted here too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
const lineOf = (needle) => src.indexOf(needle);

test('disable-gpu-compositing is appended at module top level, before whenReady', () => {
  const switchLine = lineOf("app.commandLine.appendSwitch('disable-gpu-compositing')");
  const readyLine = lineOf('app.whenReady().then');
  assert.ok(switchLine >= 0, 'appendSwitch call exists in src/main/index.ts');
  assert.ok(readyLine >= 0, 'app.whenReady() exists in src/main/index.ts');
  assert.ok(
    switchLine < readyLine,
    `switch must be appended before whenReady (silent no-op otherwise): switch@${switchLine} ready@${readyLine}`,
  );
});

test('MD_ENABLE_GPU_COMPOSITING=1 restores default compositing without a rebuild', () => {
  assert.ok(
    src.includes("process.env.MD_ENABLE_GPU_COMPOSITING !== '1'") ||
      src.includes("process.env.MD_ENABLE_GPU_COMPOSITING != '1'"),
    'switch append is guarded by the MD_ENABLE_GPU_COMPOSITING escape hatch',
  );
});

test('no other GPU switches ride along — one variable at a time', () => {
  const forbidden = [
    "appendSwitch('disable-gpu'",
    'disableHardwareAcceleration',
    "appendSwitch('disable-gpu-vsync'",
  ];
  for (const f of forbidden) {
    assert.ok(!src.includes(f), `expected ${f} NOT to appear in src/main/index.ts`);
  }
});
