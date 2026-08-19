'use strict';

/**
 * GPU compositing default + kill-switch
 * (card agent-flip-md-enable-gpu-compo-2026-08-19; kill-switch born in
 * agent-add-disable-gpu-composit-2026-08-19).
 *
 * History: the switch shipped as opt-IN (=1) while chasing a whole-window
 * flicker that turned out to be driver/compositor level (reproduces in plain
 * Chrome). Software compositing by default burned ~84% of a core in the GPU
 * process while the app idled (god, 2026-08-19, 9 agents on the floor) — so
 * the default flipped: GPU compositing ON unless explicitly disabled.
 *
 * The instrument is Chromium's --disable-gpu-compositing. Two properties must
 * hold, and both are source contracts because index.ts (7582 lines, electron
 * import at the top) cannot be loaded in a node --test process:
 *
 *  (1) ORDERING — appendSwitch is read at GPU-process startup. Appended
 *      after app.whenReady() resolves it is a silent no-op, i.e. the test
 *      "runs" with GPU compositing on and reports a false negative. So the
 *      call must sit at module top level, provably before the whenReady
 *      line — this is the assertion that fails if someone relocates it.
 *
 *  (2) KILL SWITCH — exactly MD_ENABLE_GPU_COMPOSITING=0 disables GPU
 *      compositing without a rebuild. Every other value — unset, empty,
 *      "1", "false", garbage — leaves it ON (the default). Strict '0' only:
 *      one comparison, no truthy-spelling zoo, and a typo'd disable degrades
 *      to the cheap default rather than silently re-enabling software
 *      compositing's CPU burn.
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

test('MD_ENABLE_GPU_COMPOSITING=0 (and only exactly "0") disables compositing; default is ON', () => {
  assert.ok(
    src.includes("process.env.MD_ENABLE_GPU_COMPOSITING === '0'"),
    "switch append is guarded by an exact === '0' comparison (new default: GPU compositing ON)",
  );
  assert.ok(
    !src.includes("process.env.MD_ENABLE_GPU_COMPOSITING !== '1'") &&
      !src.includes("process.env.MD_ENABLE_GPU_COMPOSITING != '1'"),
    "old opt-in guard (!== '1', software compositing by default) must be gone",
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
