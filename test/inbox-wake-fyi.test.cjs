'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { SYSTEM_SENDERS, isFyiMail } = loadTs('src/shared/hiveMail.ts');

// — part 3: FYI classification —

test('system informs are FYI — they must never wake anyone', () => {
  // The named noise: ephemeral-worker lifecycle notices.
  assert.equal(isFyiMail({ from: 'ephemeral-worker', act: 'inform' }), true);
  assert.equal(isFyiMail({ from: 'scheduler', act: 'inform' }), true);
  assert.equal(isFyiMail({ from: 'heartbeat', act: 'inform' }), true);
  assert.equal(isFyiMail({ from: 'system', act: 'inform' }), true);
  assert.equal(isFyiMail({ from: 'breaker', act: 'inform' }), true);
});

test('scheduler standup REQUESTS still wake god (act request is never FYI)', () => {
  assert.equal(isFyiMail({ from: 'scheduler', act: 'request' }), false);
  assert.equal(isFyiMail({ from: 'heartbeat', act: 'request' }), false);
  // A breaker steer must interrupt a looping agent.
  assert.equal(isFyiMail({ from: 'breaker', act: 'request' }), false);
});

test('real mail from real agents is never FYI, whatever its act', () => {
  assert.equal(isFyiMail({ from: 'pam-msvqb91b', act: 'inform' }), false);
  assert.equal(isFyiMail({ from: 'pam-msvqb91b', act: 'request' }), false);
  assert.equal(isFyiMail({ from: 'god', act: 'inform' }), false);
  assert.equal(isFyiMail({ from: 'webhook', act: 'inform' }), false);
  // Unknown future senders count as real by default (fail-open for mail).
  assert.equal(isFyiMail({ from: 'someone-new', act: 'inform' }), false);
});

test('SYSTEM_SENDERS is the one shared classification, matching the breaker seam', () => {
  for (const s of ['heartbeat', 'scheduler', 'breaker', 'system', 'ephemeral-worker']) {
    assert.ok(SYSTEM_SENDERS.has(s), s);
  }
  assert.equal(isFyiMail({ from: undefined, act: 'inform' }), true); // malformed never wakes
});
