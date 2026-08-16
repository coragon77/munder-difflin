'use strict';

/**
 * M1 of vacation-review-bundle-20260816: the voice floor watcher diffed the
 * `archived` flag alone, so Michael reported a PARK as "X was archived" and a
 * RECALL as "X is back from the archive" — the voice layer could not tell a
 * vacationer (resting, protected, recallable) from a plain archive (gone).
 * These tests pin the vacation-aware deltas; the plain-archive wording is
 * pinned too, so the fix cannot regress one shelf while fixing the other.
 *
 * The watcher is dep-injected (no ptyManager/electron), so this drives the
 * real tick() diff directly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { RealtimeFloorWatcher } = loadTs('src/main/realtimeFloorWatcher.ts');

/** One live session over a registry that STARTS as `initial` (present before
 *  connect, so the first diff is the transition under test, not "joined").
 *  `step` advances one poll tick. */
function rig(initial) {
  const pushed = [];
  let agents = initial;
  const watcher = new RealtimeFloorWatcher({
    enabled: () => true,
    registry: () => ({ agents }),
    tasks: () => null,
    ptys: () => [],
    push: (text) => pushed.push(text),
  });
  watcher.setSessionLive(true);
  return {
    pushed,
    /** First tick primes the snapshot (no deltas from before connect). */
    prime: () => watcher.tick(),
    step: (next) => {
      agents = next;
      watcher.tick();
    },
  };
}

test('a park reports "went on vacation", never "was archived"', () => {
  const r = rig({ 'pam-1': { name: 'Pam', archived: false } });
  r.prime();
  r.step({ 'pam-1': { name: 'Pam', archived: true, vacation: true } });
  const said = r.pushed.join(' ');
  assert.match(said, /Pam went on vacation/);
  assert.doesNotMatch(said, /was archived/, 'a vacationer is resting, not gone');
});

test('a recall reports "back from vacation", never "back from the archive"', () => {
  const r = rig({ 'pam-1': { name: 'Pam', archived: true, vacation: true } });
  r.prime();
  r.step({ 'pam-1': { name: 'Pam', archived: false, vacation: false } });
  const said = r.pushed.join(' ');
  assert.match(said, /Pam is back from vacation/);
  assert.doesNotMatch(said, /back from the archive/);
});

test('a vacation ended without a respawn says so — demoted to plain archived', () => {
  const r = rig({ 'pam-1': { name: 'Pam', archived: true, vacation: true } });
  r.prime();
  r.step({ 'pam-1': { name: 'Pam', archived: true, vacation: false } });
  const said = r.pushed.join(' ');
  assert.match(said, /Pam's vacation ended/);
  assert.match(said, /archived/, 'the demoted shelf is named');
  assert.doesNotMatch(said, /back from/);
});

test('plain archive and unarchive keep their existing wording', () => {
  const r = rig({ 'jim-1': { name: 'Jim', archived: false } });
  r.prime();
  r.step({ 'jim-1': { name: 'Jim', archived: true } });
  assert.match(r.pushed.join(' '), /Jim was archived/);

  const r2 = rig({ 'jim-1': { name: 'Jim', archived: true } });
  r2.prime();
  r2.step({ 'jim-1': { name: 'Jim', archived: false } });
  assert.match(r2.pushed.join(' '), /Jim is back from the archive/);
});
