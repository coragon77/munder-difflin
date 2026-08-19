'use strict';

/**
 * The DevTools debug handle's input validation (window.__cthTermDebug —
 * terminalRenderDebug.ts / terminalPool.ts).
 *
 * The handle exists to diagnose the pane flicker/blur report by flipping
 * xterm render options at runtime. Its input is whatever someone typed into
 * the DevTools console — hostile by default. sanitizeTerminalRenderOptionPatch
 * is the trust boundary: junk must be DROPPED (an exception in the handle
 * would take every open terminal's diagnosis session down with it), and the
 * values that do pass must be clamped to ranges xterm/the app can actually
 * render, so a typo can't soft-lock the panes (e.g. fontSize 0.0001 or
 * lineHeight 50).
 *
 * terminalPool.ts itself can't be loaded here (its import graph ends in
 * @xterm/xterm's CSS), so this pins the pure half; the pool-side apply path
 * is deliberately thin (assign + reflowTerminal).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { sanitizeTerminalRenderOptionPatch } = loadTs(
  'src/renderer/src/components/terminalRenderDebug.ts',
);

test('valid values pass through untouched', () => {
  assert.deepEqual(
    sanitizeTerminalRenderOptionPatch({
      minimumContrastRatio: 1,
      fontFamily: 'Menlo',
      fontSize: 16,
      lineHeight: 1.1,
    }),
    { minimumContrastRatio: 1, fontFamily: 'Menlo', fontSize: 16, lineHeight: 1.1 },
  );
});

test("contrast is clamped to xterm's 1..21 — 1 is the diagnosis value (off)", () => {
  assert.equal(
    sanitizeTerminalRenderOptionPatch({ minimumContrastRatio: 0 }).minimumContrastRatio,
    1,
  );
  assert.equal(
    sanitizeTerminalRenderOptionPatch({ minimumContrastRatio: 99 }).minimumContrastRatio,
    21,
  );
  assert.equal(
    sanitizeTerminalRenderOptionPatch({ minimumContrastRatio: 4.5 }).minimumContrastRatio,
    4.5,
  );
});

test('fontSize is rounded and clamped, lineHeight clamped — no soft-lock sizes', () => {
  assert.equal(sanitizeTerminalRenderOptionPatch({ fontSize: 2 }).fontSize, 6);
  assert.equal(sanitizeTerminalRenderOptionPatch({ fontSize: 500 }).fontSize, 72);
  assert.equal(sanitizeTerminalRenderOptionPatch({ fontSize: 15.6 }).fontSize, 16);
  assert.equal(sanitizeTerminalRenderOptionPatch({ lineHeight: 50 }).lineHeight, 2);
  assert.equal(sanitizeTerminalRenderOptionPatch({ lineHeight: 0 }).lineHeight, 0.8);
});

test('wrong-typed and non-finite values are dropped, not thrown on', () => {
  assert.deepEqual(
    sanitizeTerminalRenderOptionPatch({ minimumContrastRatio: 'high', fontSize: NaN }),
    {},
  );
  assert.deepEqual(sanitizeTerminalRenderOptionPatch({ fontFamily: '   ' }), {});
});

test('unknown keys never reach a Terminal', () => {
  assert.deepEqual(sanitizeTerminalRenderOptionPatch({ scrollback: 1, theme: {} }), {});
});

test('non-object input degrades to an empty (no-op) patch', () => {
  assert.deepEqual(sanitizeTerminalRenderOptionPatch(null), {});
  assert.deepEqual(sanitizeTerminalRenderOptionPatch('contrast(1)'), {});
  assert.deepEqual(sanitizeTerminalRenderOptionPatch(4.5), {});
});
