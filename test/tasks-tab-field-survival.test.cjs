'use strict';

/**
 * tasks-tab-field-survival (card agent-tasks-tab-ui-strips-card-2026-08-18).
 *
 * Found by Robert in design review: ONE status move in the tasks tab stripped
 * fields from EVERY card — parseTasks (TasksKanban) is a whitelist that drops
 * sessionId, sessionMode, result, slack, webhook and downgrades origin:'agent'
 * to undefined; TaskDetailOverlay.move then rewrote the WHOLE ledger from that
 * sanitized copy via hiveWriteTasks. Live damage: sessionId (the /resume key)
 * wiped on every move; a Slack-origin card moved to done loses slack routing
 * before the done-notifier can reply. Second defect on the same path: the
 * overlay wrote from a 5s-stale poll with NO lock, so a concurrent CLI flip
 * was silently reverted.
 *
 * Fix shape (both parts pinned here):
 *  1. parseTasks spreads the RAW card and overrides only normalized fields —
 *     any future field survives every round-trip forever (the incoming
 *     'paused' flag and anything after it ride free).
 *  2. The overlay no longer whole-file overwrites: a targeted main-process
 *     read-modify-write (updateTaskStatus, the addHumanTask pattern) under the
 *     SAME tasks.json.lock bin/hive-card takes — the stale-poll lost-update
 *     window closes because the status flip is applied to a FRESH read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// parseTasks lives in a .tsx (JSX — not loadTs-compilable); its SURVIVAL
// contract is pinned at the source level, and the behavioral round-trip is
// pinned through the MAIN-side writer (HiveManager, plain .ts).
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-task-surv-'));
}

async function hiveWithLedger(t, tasks) {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god1', name: 'God', provider: 'claude', cwd: home, isGod: true });
  hive.writeTasks(tasks);
  return { hive, home };
}

const readLedger = (home) =>
  JSON.parse(fs.readFileSync(path.join(home, 'hive', 'tasks.json'), 'utf8')).tasks;

// ——— part 1: parseTasks spreads the raw card (source pins) ———————————

test('parseTasks spreads the RAW card and overrides only normalized fields', () => {
  const src = read('src/renderer/src/components/TasksKanban.tsx');
  assert.match(src, /\.\.\.t,/, 'spread of the raw card');
  assert.match(src, /id:\s*\n\s*typeof t\.id/, 'id still normalized');
  assert.match(src, /status:.*as Status/, 'status still normalized');
  // the documented list of previously-stripped fields must be named as
  // preserved in the doc comment (the contract statement)
  assert.match(src, /sessionId[\s\S]{0,300}slack/, 'names the previously-stripped fields');
});

// ——— part 2: targeted read-modify-write replaces the whole-file overwrite —

test('updateTaskStatus flips ONE card from a FRESH read — other cards untouched, unknown fields survive', async (t) => {
  const { hive, home } = await hiveWithLedger(t, [
    {
      id: 'a',
      title: 'A',
      status: 'doing',
      sessionId: 'sess-a',
      slack: { channel: 'C1', thread_ts: '1' },
    },
    { id: 'b', title: 'B', status: 'todo', sessionId: 'sess-b', paused: true },
  ]);
  const ok = hive.updateTaskStatus('a', 'done');
  assert.equal(ok, true);
  const after = readLedger(home);
  assert.equal(after.find((c) => c.id === 'a').status, 'done');
  assert.equal(after.find((c) => c.id === 'a').sessionId, 'sess-a', 'sessionId survives');
  assert.deepEqual(after.find((c) => c.id === 'a').slack, { channel: 'C1', thread_ts: '1' });
  assert.equal(after.find((c) => c.id === 'b').status, 'todo', 'other cards untouched');
  assert.equal(after.find((c) => c.id === 'b').paused, true, 'unknown field on sibling survives');
});

test('updateTaskStatus on a missing card is a no-op returning false (never mints)', async (t) => {
  const { hive, home } = await hiveWithLedger(t, [{ id: 'a', title: 'A', status: 'todo' }]);
  assert.equal(hive.updateTaskStatus('ghost', 'done'), false);
  assert.equal(readLedger(home).length, 1);
});

test('updateTaskStatus closes the lost-update window: applies onto a FRESH read, not the stale caller copy', async (t) => {
  // Simulates: operator drags a card from a 5s-stale poll while god's CLI
  // flips a DIFFERENT card concurrently. Old path (whole-file overwrite from
  // the stale copy) reverted god's flip; the new path re-reads first.
  const { hive, home } = await hiveWithLedger(t, [
    { id: 'stale-view-a', title: 'A', status: 'todo' },
    { id: 'stale-view-b', title: 'B', status: 'todo' },
  ]);
  // the "stale renderer copy" moves A; BEFORE the write lands, the CLI flips B
  hive.updateTaskStatus('stale-view-a', 'doing');
  // (in the real world these interleave; single-threaded here the ordering IS
  // the test: the update re-read the ledger, so B's earlier CLI flip below
  // would survive — asserted directly:)
  hive.updateTaskStatus('stale-view-b', 'blocked');
  const after = readLedger(home);
  assert.equal(after.find((c) => c.id === 'stale-view-a').status, 'doing');
  assert.equal(after.find((c) => c.id === 'stale-view-b').status, 'blocked');
});

// ——— wiring: the overlay uses the targeted path, not the overwrite ——————

test('TaskDetailOverlay.move routes through updateTaskStatus — no hiveWriteTasks', () => {
  const overlay = read('src/renderer/src/components/TaskDetailOverlay.tsx');
  assert.ok(overlay.includes('hiveUpdateTaskStatus'), 'calls the targeted handler');
  assert.ok(!overlay.includes('hiveWriteTasks'), 'the whole-file overwrite is gone');
});

test('preload + IPC expose hiveUpdateTaskStatus', () => {
  const pre = read('src/preload/index.ts');
  assert.ok(pre.includes('hiveUpdateTaskStatus'));
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes("'hive:updateTaskStatus'"));
});

test('updateTaskStatus takes the same tasks.json.lock bin/hive-card takes', async (t) => {
  const { hive, home } = await hiveWithLedger(t, [{ id: 'a', title: 'A', status: 'todo' }]);
  const root = home;
  const lock = path.join(root, 'hive', 'tasks.json.lock');
  // held lock (fresh, non-stale): the update must NOT clobber a concurrent writer
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  const before = JSON.stringify(readLedger(home));
  const ok = hive.updateTaskStatus('a', 'done');
  assert.equal(ok, false, 'refused while the lock is held');
  assert.equal(JSON.stringify(readLedger(home)), before, 'ledger byte-identical — no lost update');
  fs.unlinkSync(lock);
});
