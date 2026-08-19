'use strict';

/**
 * Card agent-remove-the-unlocked-hive-2026-08-19: the 'hive:writeTasks' IPC
 * channel was an UNLOCKED whole-ledger-overwrite primitive with zero renderer
 * callers, so it was deleted rather than repointed at withLedgerLock. A
 * regression that reintroduces the channel or its preload exposure fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test("main no longer registers the 'hive:writeTasks' IPC channel", () => {
  assert.ok(
    !read('src/main/index.ts').includes("'hive:writeTasks'"),
    'channel re-registered — an unlocked whole-ledger overwrite is not reachable from IPC',
  );
});

test('preload no longer exposes hiveWriteTasks to the renderer', () => {
  assert.ok(
    !read('src/preload/index.ts').includes('hiveWriteTasks'),
    'hiveWriteTasks exposure returned — window.cth must not carry the overwrite primitive',
  );
});
