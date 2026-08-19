'use strict';

/**
 * R4 residual audit (card agent-audit-legacy-writetasks--2026-08-19): every
 * LEGACY main-process writer of tasks.json routes through withLedgerLock
 * (hive.ts's tasks.json.lock helper) and does a targeted read-modify-write.
 *
 * Behavioural pins (loadTs hive.ts): the four legacy Hive methods —
 * addHumanTask, deleteHumanTask, stampCard, stampActiveCards (via
 * recordSession) — REFUSE while a fresh tasks.json.lock is held and leave the
 * ledger byte-identical. A regression to an unlocked read-modify-write fails
 * exactly here: it would write anyway and clobber the concurrent holder.
 *
 * Structural pins (source slices): the webhook card append (index.ts
 * dispatchWebhookWork) and the four realtime voice executors
 * (realtimeActions.ts) mutate the ledger inside the lock helper, never via a
 * pre-lock read. index.ts wires hiveWithLedgerLock into the voice deps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function setup(t, tasks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-tasks-writers-locked-'));
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

// ── behavioural: legacy Hive writers respect a held lock ────────────────────

test('addHumanTask refuses while held; free → targeted append (sibling fields survive)', async (t) => {
  const { hive, ledger, lock } = setup(t, [
    { id: 'a', title: 'A', status: 'doing', assignee: 'w1', exotic: 'keep-me' },
  ]);
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  t.after(() => fs.rmSync(lock, { force: true }));
  const before = fs.readFileSync(ledger, 'utf8');

  assert.equal(hive.addHumanTask('Fresh card'), null, 'refused while the lock is held');
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'ledger byte-identical — no lost update');

  fs.rmSync(lock);
  const added = hive.addHumanTask('Fresh card');
  assert.ok(added && added.id.startsWith('human-fresh-card-'), 'appends once free');
  const tasks = JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks;
  assert.equal(tasks.find((c) => c.id === 'a').exotic, 'keep-me', 'targeted write, no sanitize');
});

test('deleteHumanTask refuses while the lock is held', async (t) => {
  const { hive, ledger, lock } = setup(t, [
    { id: 'human-x-2026-08-19', title: 'X', status: 'todo', origin: 'human' },
  ]);
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  t.after(() => fs.rmSync(lock, { force: true }));
  const before = fs.readFileSync(ledger, 'utf8');

  assert.equal(hive.deleteHumanTask('human-x-2026-08-19'), false, 'refused while held');
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'ledger byte-identical');
});

test('stampCard and stampActiveCards (recordSession) skip while held, stamp when free', async (t) => {
  const { hive, ledger, lock } = setup(t, [
    { id: 'a', title: 'A', status: 'doing', assignee: 'god1' },
  ]);
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  t.after(() => fs.rmSync(lock, { force: true }));
  const before = fs.readFileSync(ledger, 'utf8');

  hive.stampCard('a', 'sess-1'); // no-op while held — watcher retries later
  // Refresh the held lock: stampCard's ~5s refusal would otherwise push its
  // mtime past the 10s stale-takeover window and recordSession would
  // legitimately take the "crashed" lock over.
  const now = new Date();
  fs.utimesSync(lock, now, now);
  hive.recordSession('god1', 'sess-1'); // registry write ok, ledger stamp must skip
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'ledger byte-identical');

  fs.rmSync(lock);
  hive.stampCard('a', 'sess-2');
  hive.recordSession('god1', 'sess-3'); // new id → stampActiveCards fires
  const card = JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks.find((c) => c.id === 'a');
  assert.equal(card.sessionId, 'sess-3', 'both stamps land once free');
});

// ── structural: writers outside hive.ts mutate inside the lock ──────────────

function sliceFn(file, name) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in ${file}`);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

test('webhook card append (dispatchWebhookWork) runs under hive.withLedgerLock', () => {
  const src = sliceFn('src/main/index.ts', 'dispatchWebhookWork');
  assert.match(src, /withLedgerLock\(/, 'append runs inside the lock helper');
  assert.ok(
    !src.includes('hive.tasks()'),
    'no unlocked pre-read — the callback gets the freshly-read array',
  );
});

for (const name of ['execCreateTask', 'execAssignTask', 'execUpdateTask', 'execDeleteTask']) {
  test(`realtimeActions ${name} mutates the ledger under hiveWithLedgerLock`, () => {
    const src = sliceFn('src/main/realtimeActions.ts', name);
    assert.match(src, /hiveWithLedgerLock\(/, 'read-modify-write runs inside the lock');
    assert.ok(!src.includes('findTasks('), 'no unlocked pre-read of the ledger');
  });
}

test('index.ts wires hiveWithLedgerLock into the realtime voice deps', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /hiveWithLedgerLock:\s*\(fn\)\s*=>\s*hive\.withLedgerLock\(fn\)/);
});
