'use strict';

/**
 * ONE tasks.json lock helper (card agent-two-parallel-tasks-json--2026-08-18).
 *
 * Roy's askme/slack batch introduced HiveManager.withTasksLock, the pause-flag
 * card introduced withLedgerLock — two correct copies of bin/hive-card's lock
 * discipline over the same tasks.json.lock. This branch unified them onto
 * withLedgerLock. These tests fail loudly if the helpers ever drift apart
 * again: a structural pin that exactly ONE lock path exists in hive.ts, and a
 * behavioural pin that the unified lock still excludes a concurrent writer
 * and still takes over a stale (>10s) lock file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function setup(t, tasks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-tasks-lock-unified-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureAgent({ id: 'god1', name: 'God', provider: 'claude', cwd: home, isGod: true });
  hive.writeTasks(tasks);
  return {
    hive,
    ledger: path.join(home, 'hive', 'tasks.json'),
    lock: path.join(home, 'hive', 'tasks.json.lock'),
  };
}

test('hive.ts has exactly ONE tasks.json lock path and no withTasksLock left', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  const lockPaths = src.match(/join\(root, 'tasks\.json\.lock'\)/g) ?? [];
  assert.equal(
    lockPaths.length,
    1,
    'exactly one tasks.json.lock helper — two lock paths over one file is the regression this card fixed',
  );
  assert.ok(!src.includes('withTasksLock'), 'the duplicate helper stays deleted');
});

test('unified lock excludes a concurrent writer (fresh held lock → refuse, ledger untouched)', async (t) => {
  const { hive, ledger, lock } = setup(t, [{ id: 'a', title: 'A', status: 'todo' }]);
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  t.after(() => fs.rmSync(lock, { force: true }));
  const before = fs.readFileSync(ledger, 'utf8');

  assert.equal(hive.updateTaskStatus('a', 'done'), false, 'refused while the lock is held');
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'ledger byte-identical — no lost update');
});

test('unified lock takes over a stale lock file (>10s)', async (t) => {
  const { hive, ledger, lock } = setup(t, [{ id: 'a', title: 'A', status: 'todo' }]);
  fs.writeFileSync(lock, '99999', { flag: 'wx' }); // crashed holder
  const stale = new Date(Date.now() - 11_000);
  fs.utimesSync(lock, stale, stale);

  assert.equal(hive.updateTaskStatus('a', 'done'), true, 'stale lock is taken over');
  const after = JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks;
  assert.equal(after.find((c) => c.id === 'a').status, 'done');
  assert.equal(fs.existsSync(lock), false, 'lock released after the write');
});
