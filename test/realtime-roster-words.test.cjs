'use strict';

// Vacation renderer follow-up (M1): the voice layer must speak vacationers as
// vacationers, not as plain archived agents. The wording lives in
// src/renderer/src/realtime/roster.ts — a pure, import-free module so these
// spoken strings are pinnable without loading the realtime SDK.

const test = require('node:test');
const assert = require('node:assert/strict');

const loadTs = require('./load-ts.cjs');
const { splitRoster, rosterSpeech, agentWhere, vacationSummaryLine } = loadTs(
  'src/renderer/src/realtime/roster.ts',
);

const row = (id, extra = {}) => ({
  id,
  name: id,
  provider: 'claude',
  archived: false,
  vacation: false,
  ...extra,
});

test('splitRoster keeps vacationers off the plain-archived list', () => {
  const { active, vacationing, archived } = splitRoster([
    row('pam', {}),
    row('meredith', { archived: true }),
    row('kevin', { archived: true, vacation: true }),
  ]);
  assert.deepEqual(
    active.map((r) => r.id),
    ['pam'],
  );
  assert.deepEqual(
    vacationing.map((r) => r.id),
    ['kevin'],
  );
  assert.deepEqual(
    archived.map((r) => r.id),
    ['meredith'],
  );
});

test('rosterSpeech speaks a distinct vacation bucket with recall guidance', () => {
  const speech = rosterSpeech(
    [
      row('pam'),
      row('meredith', { archived: true }),
      row('kevin', { archived: true, vacation: true }),
    ],
    true,
  );
  assert.match(speech, /On vacation: kevin/);
  assert.match(speech, /recall/i);
  // Kevin must not be lumped into the Archived: bucket
  const archivedPart = speech.split('Archived:')[1]?.split('.')[0] ?? '';
  assert.ok(!archivedPart.includes('kevin'), `kevin leaked into Archived: "${archivedPart}"`);
});

test('rosterSpeech without vacationers is unchanged in shape', () => {
  const speech = rosterSpeech([row('pam'), row('meredith', { archived: true })], true);
  assert.ok(!speech.includes('On vacation'), 'no vacation bucket when nobody is parked');
  assert.match(speech, /Archived: meredith/);
});

test('agentWhere distinguishes vacation from archived', () => {
  const vacation = agentWhere(row('kevin', { archived: true, vacation: true, status: 'idle' }));
  assert.match(vacation, /on vacation/i);
  assert.ok(!vacation.includes('terminal is closed'), vacation);
  assert.match(vacation, /recall/i);

  const archived = agentWhere(row('meredith', { archived: true, status: 'idle' }));
  assert.match(archived, /terminal is closed/);

  const active = agentWhere(row('pam', { status: 'writing' }));
  assert.match(active, /active and writing/);
});

test('vacationSummaryLine names parked agents or stays empty', () => {
  assert.equal(vacationSummaryLine([]), '');
  assert.equal(vacationSummaryLine([row('pam')]), '');
  const line = vacationSummaryLine([row('pam'), row('kevin', { archived: true, vacation: true })]);
  assert.match(line, /On vacation: kevin/);
  assert.match(line, /recall/i);
});
