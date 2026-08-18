'use strict';

/**
 * ASK ME + Slack card targeted writes (card
 * agent-askmetab-ensureslackcard-2026-08-18).
 *
 * These renderer flows used to read tasks.json, mutate a stale copy, then
 * overwrite the whole ledger without taking tasks.json.lock. A concurrent
 * hive-card update between their read and write was silently reverted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const { HiveManager } = loadTs('src/main/hive.ts');

function setup(t, tasks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-targeted-task-writes-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureAgent({ id: 'god1', name: 'God', provider: 'claude', cwd: home, isGod: true });
  hive.writeTasks(tasks);
  const ledger = path.join(home, 'hive', 'tasks.json');
  return { hive, ledger, lock: `${ledger}.lock` };
}

const card = {
  id: 'ask-1',
  title: 'Need an answer',
  status: 'blocked',
  dependsOn: [],
  priority: 1,
  createdAt: '2026-08-18T00:00:00.000Z',
  humanQA: [{ q: 'Ship it?', askedAt: '2026-08-18T00:01:00.000Z' }],
};

const ledgerTasks = (ledger) => JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks;

test('resolveHumanQuestion answers the matching open ask on a fresh ledger read', (t) => {
  const { hive, ledger } = setup(t, [
    card,
    {
      id: 'concurrent',
      title: 'CLI changed me',
      status: 'doing',
      dependsOn: [],
      priority: 2,
      createdAt: '2026-08-18T00:00:00.000Z',
      paused: true,
    },
  ]);

  assert.equal(hive.resolveHumanQuestion('ask-1', 'Ship it?', 'Yes'), true);
  const after = ledgerTasks(ledger);
  const qa = after.find((task) => task.id === 'ask-1').humanQA[0];
  assert.equal(qa.a, 'Yes');
  assert.ok(Date.parse(qa.answeredAt), 'answer timestamp is persisted');
  assert.equal(after.find((task) => task.id === 'concurrent').status, 'doing');
  assert.equal(after.find((task) => task.id === 'concurrent').paused, true);
});

test('resolveHumanQuestion dismisses one open ask without fabricating an answer', (t) => {
  const { hive, ledger } = setup(t, [card]);

  assert.equal(hive.resolveHumanQuestion('ask-1', 'Ship it?'), true);
  const qa = ledgerTasks(ledger)[0].humanQA[0];
  assert.equal(qa.a, undefined);
  assert.ok(Date.parse(qa.dismissedAt), 'dismissal timestamp is persisted');
  assert.equal(hive.resolveHumanQuestion('ask-1', 'Ship it?', 'too late'), false);
});

test('ensureSlackCard appends from a fresh read and is idempotent', (t) => {
  const { hive, ledger } = setup(t, [
    {
      id: 'concurrent',
      title: 'CLI changed me',
      status: 'blocked',
      dependsOn: [],
      priority: 2,
      createdAt: '2026-08-18T00:00:00.000Z',
      sessionId: 'kept',
    },
  ]);
  const slack = { channel: 'C123', thread_ts: '1720000000.123' };
  const text = 'x'.repeat(90);

  assert.equal(hive.ensureSlackCard('message-1', text, slack), true);
  assert.equal(hive.ensureSlackCard('message-1', text, slack), true);
  const after = ledgerTasks(ledger);
  assert.equal(after.length, 2, 'the same Slack work item is promoted once');
  assert.equal(after[0].status, 'blocked', 'a concurrent CLI status survives');
  assert.equal(after[0].sessionId, 'kept', 'existing card fields survive');
  assert.deepEqual(after[1].slack, slack);
  assert.equal(after[1].id, 'slack-1720000000.123-message-1');
  assert.equal(after[1].title, `${'x'.repeat(79)}…`);
  assert.equal(after[1].description, text);
});

test('both targeted writes refuse a held tasks.json.lock without changing the ledger', (t) => {
  const { hive, ledger, lock } = setup(t, [card]);
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  t.after(() => fs.rmSync(lock, { force: true }));
  const before = fs.readFileSync(ledger, 'utf8');

  assert.equal(hive.resolveHumanQuestion('ask-1', 'Ship it?', 'Yes'), false);
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'answer path leaves ledger byte-identical');
  fs.utimesSync(lock, new Date(), new Date()); // keep the second contention test below 10s stale
  assert.equal(
    hive.ensureSlackCard('message-1', 'Slack work', { channel: 'C123', thread_ts: '1.2' }),
    false,
  );
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'Slack path leaves ledger byte-identical');
});

test('renderer paths call the targeted IPCs instead of hiveWriteTasks', () => {
  const askMe = read('src/renderer/src/components/AskMeTab.tsx');
  assert.ok(askMe.includes('hiveResolveHumanQuestion'));
  assert.ok(!askMe.includes('hiveWriteTasks'));

  const useHive = read('src/renderer/src/hooks/useHive.ts');
  assert.ok(useHive.includes('hiveEnsureSlackCard'));
  assert.ok(!useHive.includes('hiveWriteTasks'));

  const preload = read('src/preload/index.ts');
  assert.ok(preload.includes('hiveResolveHumanQuestion'));
  assert.ok(preload.includes('hiveEnsureSlackCard'));
  const main = read('src/main/index.ts');
  assert.ok(main.includes("'hive:resolveHumanQuestion'"));
  assert.ok(main.includes("'hive:ensureSlackCard'"));
});
