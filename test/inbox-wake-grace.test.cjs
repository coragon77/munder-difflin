'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { nudgeGraceMsForProvider, hasInboxMonitor } = loadTs('src/shared/providerAutomation.ts');
// — part 2: per-provider nudge grace —

test('claude (monitor-capable) gets the 45s nudge grace so its monitor wins the race', () => {
  assert.equal(nudgeGraceMsForProvider('claude'), 45_000);
});

test('providers without a monitor arm get NO grace — their nudge latency is unchanged', () => {
  for (const p of ['codex', 'crush', 'pi', 'grok', 'kimi', 'opencode', 'qwen', 'antigravity', 'copilot', 'custom']) {
    assert.equal(nudgeGraceMsForProvider(p), 0, p);
  }
});

test('hasInboxMonitor is true exactly for the providers the boot prompt arms', () => {
  assert.equal(hasInboxMonitor('claude'), true);
  for (const p of ['pi', 'codex', 'crush']) assert.equal(hasInboxMonitor(p), false, p);
});

