'use strict';

// Floor departure animation, renderer half (card floor-departure-animation-20260816).
//
// The roster row flips or disappears the moment the backend acts, so the floor
// renderer must detect the active → parked/fired/archived transition from store
// snapshots alone and keep a ghost sprite walking to the door. This file pins
// the pure diff logic: which vanished agents are DEPARTURES (and of what kind),
// which are not (a dead-PTY reconcile parks the agent in restorableAgents —
// that is a crash/restore, not someone leaving), and that every kind has a
// bubble pool of 3–5 lines with the operator-approved seed lines in it.

const test = require('node:test');
const assert = require('node:assert/strict');

const loadTs = require('./load-ts.cjs');
const { detectDepartures, DEPARTURE_THOUGHTS } = loadTs(
  'src/renderer/src/scene/office/departures.ts',
);

const snap = ({ agents = [], archived = [], restorable = [] } = {}) => ({
  agents,
  archivedAgents: archived,
  restorableAgents: restorable,
});
const a = (id) => ({ id });

test('agent that lands in archivedAgents with vacation flag is a vacation departure', () => {
  const prev = snap({ agents: [a('dwight'), a('jim')] });
  const next = snap({
    agents: [a('jim')],
    archived: [{ id: 'dwight', vacation: true }],
  });
  assert.deepEqual(detectDepartures(prev, next), [{ id: 'dwight', kind: 'vacation' }]);
});

test('agent that lands in archivedAgents without vacation flag is a plain archive', () => {
  const prev = snap({ agents: [a('kevin')] });
  const next = snap({ agents: [], archived: [{ id: 'kevin' }] });
  assert.deepEqual(detectDepartures(prev, next), [{ id: 'kevin', kind: 'archive' }]);
});

test('agent that vanishes from every list is a fired departure (interns drop off entirely)', () => {
  const prev = snap({ agents: [a('intern-1'), a('pam')] });
  const next = snap({ agents: [a('pam')] });
  assert.deepEqual(detectDepartures(prev, next), [{ id: 'intern-1', kind: 'fired' }]);
});

test('a dead-PTY reconcile is NOT a departure — no walk-out for a crashed/restored agent', () => {
  const prev = snap({ agents: [a('stanley')] });
  const next = snap({ agents: [], restorable: [a('stanley')] });
  assert.deepEqual(detectDepartures(prev, next), []);
});

test('staying agents and bulk departures both diff correctly', () => {
  const prev = snap({ agents: [a('a'), a('b'), a('c'), a('d')] });
  const next = snap({
    agents: [a('b'), a('d')],
    archived: [{ id: 'a' }, { id: 'c', vacation: true }],
  });
  assert.deepEqual(detectDepartures(prev, next), [
    { id: 'a', kind: 'archive' },
    { id: 'c', kind: 'vacation' },
  ]);
});

test('every departure kind has a pool of 3-5 distinct lines with the seed line present', () => {
  const kinds = ['vacation', 'fired', 'archive'];
  assert.deepEqual(Object.keys(DEPARTURE_THOUGHTS).sort(), [...kinds].sort());
  const seeds = {
    vacation: 'Looking forward to that vacation',
    fired: 'I hope they hire me for real next time',
    archive: 'Moving on to new things',
  };
  for (const kind of kinds) {
    const pool = DEPARTURE_THOUGHTS[kind];
    assert.ok(
      pool.length >= 3 && pool.length <= 5,
      `${kind} pool has 3-5 lines (got ${pool.length})`,
    );
    assert.ok(new Set(pool).size === pool.length, `${kind} lines are distinct`);
    assert.ok(pool.includes(seeds[kind]), `${kind} pool contains its seed line`);
  }
});
