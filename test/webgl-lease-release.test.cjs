'use strict';

/**
 * The floor-reset-on-card-click bug.
 *
 * Clicking an agent card attaches that agent's pooled terminal, which takes a
 * WebGL lease (@xterm/addon-webgl); the previously selected one releases its
 * lease. Releasing used to mean `addon.dispose()` and nothing else — but the
 * addon never calls WEBGL_lose_context, and on xterm 5.5.0 its teardown throws
 * before it can restore the DOM renderer (it dereferences
 * `_terminal._core._store`, which 5.5.0 does not have). The render service
 * therefore keeps pointing at the disposed WebGL renderer, which keeps its
 * canvas, which keeps a LIVE GL context — for the life of the pooled terminal.
 *
 * REPRODUCED over CDP against the shipped bundles: 24 lease/release cycles
 * logged 9 × "WARNING: Too many active WebGL contexts. Oldest context will be
 * lost." and left a bystander canvas' context lost. The office floor's Pixi
 * canvas is built at startup, so it is always the oldest — Chromium evicts it,
 * glRecovery rebuilds the scene, and the floor visibly blacks out and restarts.
 * Forcing the loss on release made the same run log 0 warnings.
 *
 * These tests pin the release path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { releaseWebglContexts } = loadTs('src/renderer/src/components/terminalRecovery.ts');

/** A canvas stand-in. `contextType` is what getContext() will answer to. */
function fakeCanvas({ connected = false, contextType = 'webgl2', extension = true } = {}) {
  const gl = {
    lost: false,
    getExtension: (name) =>
      extension && name === 'WEBGL_lose_context'
        ? {
            loseContext: () => {
              gl.lost = true;
            },
          }
        : null,
  };
  return {
    isConnected: connected,
    gl,
    getContext: (type) => (type === contextType ? gl : null),
  };
}

test('a released lease hands its GPU context back instead of waiting for GC', () => {
  const canvas = fakeCanvas();
  assert.equal(releaseWebglContexts([canvas]), 1);
  assert.equal(canvas.gl.lost, true, 'the context was left alive — the floor will be evicted');
});

test('a canvas still in the document is left alone', () => {
  // The addon removes its own canvas on dispose. One still in the DOM belongs to
  // somebody else (a terminal that just legitimately claimed it) — killing its
  // context would blank a live terminal.
  const canvas = fakeCanvas({ connected: true });
  assert.equal(releaseWebglContexts([canvas]), 0);
  assert.equal(canvas.gl.lost, false);
});

test('a 2D canvas is not touched — getContext must not mint a new context', () => {
  const canvas = fakeCanvas({ contextType: '2d' });
  assert.equal(releaseWebglContexts([canvas]), 0);
  assert.equal(canvas.gl.lost, false);
});

test('every released canvas is covered, and one failure does not skip the rest', () => {
  const first = fakeCanvas();
  const angry = fakeCanvas();
  angry.getContext = () => {
    throw new Error('context is gone');
  };
  const last = fakeCanvas();
  assert.equal(releaseWebglContexts([first, angry, last]), 2);
  assert.equal(first.gl.lost, true);
  assert.equal(last.gl.lost, true, 'a throwing canvas swallowed the rest of the release');
});

test('a browser without WEBGL_lose_context degrades quietly', () => {
  const canvas = fakeCanvas({ extension: false });
  assert.equal(releaseWebglContexts([canvas]), 0);
});
