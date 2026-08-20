'use strict';

// R3 — the compact/clear collision resolved at enqueue time (card
// agent-harness-fix-the-staging--2026-08-20).
//
// Cause A of the wedge: the hourly context trigger parks a /compact in a
// context-heavy agent's queue; the card-session watcher then appends the
// card-scoped /clear + lead BEHIND it. At idle the drain types the compact
// (~2min), and the clear — dispatched seconds later into the compacting REPL
// — never executes: the dispatch mail times out into the pre-clear
// conversation.
//
// The card-scoped clear RESTARTS the pane's conversation — a compaction
// parked ahead of it is pointless (it would run against the conversation the
// clear is about to end) and actively harmful (its run window swallows the
// clear). So the clear removes the parked compact. The invariant lives in the
// store's enqueueMessage — the one choke point the existing
// one-pending-compact invariant already calls home.

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

const CLEAR_MARKER = { cardFor: { cardId: 'card-1', agentId: 'stanley', kind: 'clear' } };

test('a card-scoped clear removes a parked compaction for the same agent', () => {
  useStore.setState({ messageQueues: {} });
  useStore.getState().enqueueMessage('stanley', '/compact keep the card work');
  assert.equal(useStore.getState().messageQueues.stanley.length, 1);
  useStore.getState().enqueueMessage('stanley', '/clear', CLEAR_MARKER);
  const q = useStore.getState().messageQueues.stanley;
  assert.equal(q.length, 1, 'compact evicted, clear enqueued');
  assert.equal(q[0].text, '/clear');
  assert.deepEqual(q[0].cardFor, CLEAR_MARKER.cardFor);
});

test('the clear lands WHERE the compact sat — ahead of messages queued behind it', () => {
  useStore.setState({ messageQueues: {} });
  useStore.getState().enqueueMessage('stanley', '/compact');
  useStore.getState().enqueueMessage('stanley', 'some queued follow-up');
  useStore.getState().enqueueMessage('stanley', '/clear', CLEAR_MARKER);
  const q = useStore.getState().messageQueues.stanley;
  assert.deepEqual(
    q.map((m) => m.text),
    ['/clear', 'some queued follow-up'],
    'the clear takes the compact slot, not the tail',
  );
});

test('a plain clear (no card marker) leaves a parked compact alone (scoped fix)', () => {
  useStore.setState({ messageQueues: {} });
  useStore.getState().enqueueMessage('stanley', '/compact');
  useStore.getState().enqueueMessage('stanley', '/clear');
  const q = useStore.getState().messageQueues.stanley;
  assert.deepEqual(
    q.map((m) => m.text),
    ['/compact', '/clear'],
  );
});

test('card-scoped clear without a parked compact is a normal enqueue', () => {
  useStore.setState({ messageQueues: {} });
  useStore.getState().enqueueMessage('stanley', '/clear', CLEAR_MARKER);
  assert.equal(useStore.getState().messageQueues.stanley.length, 1);
});

test('the one-pending-compact invariant still holds', () => {
  useStore.setState({ messageQueues: {} });
  useStore.getState().enqueueMessage('stanley', '/compact');
  useStore.getState().enqueueMessage('stanley', '/compact again');
  assert.equal(useStore.getState().messageQueues.stanley.length, 1);
});
