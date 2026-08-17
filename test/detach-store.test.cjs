'use strict';

// Detach-to-kitty, renderer half (card harness-detach-to-kitty-20260817).
//
// The store tracks WHICH panes are detached (greyed out, input refused) via
// `detachedPtyIds`. Main is the authority — the IPC events drive the slice —
// but the actions are exported so the event hook stays a one-liner.

const test = require('node:test');
const assert = require('node:assert/strict');

const memoryStorage = {
  data: {},
  getItem(k) {
    return Object.hasOwn(this.data, k) ? this.data[k] : null;
  },
  setItem(k, v) {
    this.data[k] = String(v);
  },
  removeItem(k) {
    delete this.data[k];
  },
};
globalThis.localStorage = memoryStorage;
globalThis.window = {
  localStorage: memoryStorage,
  addEventListener() {},
  setTimeout,
  clearTimeout,
};

const loadTs = require('./load-ts.cjs');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

test('detach/reattach toggle pane ids in detachedPtyIds', () => {
  useStore.setState({ detachedPtyIds: [] });
  useStore.getState().setPtyDetached('pty-a', true);
  assert.deepEqual(useStore.getState().detachedPtyIds, ['pty-a']);
  // idempotent set
  useStore.getState().setPtyDetached('pty-a', true);
  assert.deepEqual(useStore.getState().detachedPtyIds, ['pty-a']);
  useStore.getState().setPtyDetached('pty-b', true);
  assert.deepEqual(useStore.getState().detachedPtyIds, ['pty-a', 'pty-b']);
  useStore.getState().setPtyDetached('pty-a', false);
  assert.deepEqual(useStore.getState().detachedPtyIds, ['pty-b']);
});

test('reattaching an unknown id is a no-op', () => {
  useStore.setState({ detachedPtyIds: ['pty-b'] });
  useStore.getState().setPtyDetached('ghost', false);
  assert.deepEqual(useStore.getState().detachedPtyIds, ['pty-b']);
});
