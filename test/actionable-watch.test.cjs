'use strict';

/**
 * The actionable-card watch mission (card agent-actionable-card-watch-fi-
 * 2026-08-19), defect (B): god is event-driven but the board is state, and
 * NOTHING woke god when dispatchable cards appeared — the (now disabled)
 * heartbeat fired on the floor being QUIET, which is when god is least
 * useful. The watch ticks every ~2 min and mails god ONLY on a TRANSITION:
 * an actionable id that was not in the last-reported set.
 *
 * These tests pin the pure transition core in src/main/actionableWatch.ts —
 * that module exists as a seam precisely because src/main/index.ts (where the
 * mission arms) cannot be loaded by the test harness (it imports electron).
 * The arm-side glue is thin by design: read the mission's reported set, diff
 * via newActionableIds, persist the CURRENT set whenever it changed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { newActionableIds, actionableWatchBody } = loadTs('src/main/actionableWatch.ts');
const { ACTIONABLE_WATCH_MISSION } = loadTs('src/main/config.ts');

test('transition: fires once for a new id, silent on the next tick with the same set', () => {
  assert.deepEqual(newActionableIds(undefined, ['a']), ['a'], 'first sighting reports');
  assert.deepEqual(newActionableIds(['a'], ['a']), [], 'same set next tick: silent');
  assert.deepEqual(newActionableIds([], []), [], 'empty→empty: silent');
});

test('transition: only the newcomer fires; a card that leaves todo and returns re-fires', () => {
  assert.deepEqual(newActionableIds(['a'], ['a', 'b']), ['b'], 'only the new id');
  assert.deepEqual(newActionableIds(['a'], []), [], 'everything dispatched/dropped: silent');
  // The arm persists the CURRENT set on every change — the card dropped out
  // of it, so a later return is a new sighting again. That re-fire is correct.
  assert.deepEqual(newActionableIds([], ['a']), ['a'], 'leave-and-return re-fires');
  assert.deepEqual(newActionableIds(['a', 'b'], ['b']), [], 'the departed id is not re-reported');
});

test('body names the new card ids and the free-seat count', () => {
  const body = actionableWatchBody(['agent-x-1', 'agent-y-2'], 3);
  assert.match(body, /agent-x-1/);
  assert.match(body, /agent-y-2/);
  assert.match(body, /free floor seats/i);
  assert.match(body, /\b3\b/);
});

test('body names the nominee for a nominated card (card agent-hive-dispatch-nomination-2026-08-19)', () => {
  const body = actionableWatchBody(['agent-x-1', 'agent-y-2'], 3, { 'agent-x-1': 'creed' });
  assert.match(body, /agent-x-1/, 'the nominated id is present');
  assert.match(body, /creed/, 'its nominee is named');
  assert.match(body, /agent-y-2/, 'an un-nominated id stays present');
});

test('mission: kind, cadence, and body EMPTY by design (the fire computes the mail)', () => {
  // The heartbeat trap this card exists not to repeat: HEARTBEAT_MISSION.body
  // is configured prose its arm NEVER sends — dead text. This mission keeps
  // body empty so nothing can rot; armActionableWatch builds the mail per fire.
  assert.equal(ACTIONABLE_WATCH_MISSION.kind, 'actionable-watch');
  assert.equal(ACTIONABLE_WATCH_MISSION.intervalMs, 120_000, 'a ~2 min watch, not a tight poll');
  assert.equal(ACTIONABLE_WATCH_MISSION.body, '', 'configured body must stay dead-empty');
});
