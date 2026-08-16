'use strict';

/**
 * Human-created todo cards (card human-todo-cards-20260816): the human adds
 * cards from the tasks tab; both add and delete are read-modify-write on
 * tasks.json at action time in the MAIN process. Delete is rule-gated:
 * only human-origin (origin 'human') cards, only while still 'todo' —
 * god-created cards and anything the hive picked up survive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-human-cards-'));
}

function tasksOf(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'hive', 'tasks.json'), 'utf8')).tasks;
}

test('addHumanTask appends a human-origin todo card without disturbing god cards', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureAgent({ id: 'god1', name: 'God', provider: 'claude', cwd: home, isGod: true });

  hive.writeTasks([{ id: 'god-card', title: 'god work', status: 'doing', dependsOn: [], priority: 2, createdAt: '2026-08-16T00:00:00.000Z' }]);

  const card = hive.addHumanTask('Fix the Login Flow!!', 'noticed it twice');
  assert.ok(card, 'a valid title yields a card');
  assert.match(card.id, /^human-fix-the-login-flow-\d{4}-\d{2}-\d{2}$/);
  assert.equal(card.status, 'todo');
  assert.equal(card.origin, 'human');
  assert.equal(card.assignee, undefined);

  const onDisk = tasksOf(home);
  assert.equal(onDisk.length, 2, 'the god card survives');
  assert.deepEqual(onDisk[0].id, 'god-card');
  assert.equal(onDisk.find((x) => x.id === card.id).description, 'noticed it twice');
});

test('addHumanTask: empty title rejected; same-day duplicates get distinct ids', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureAgent({ id: 'god1', name: 'God', provider: 'claude', cwd: home, isGod: true });

  assert.equal(hive.addHumanTask('   '), null);
  const a = hive.addHumanTask('same title');
  const b = hive.addHumanTask('same title');
  assert.notEqual(a.id, b.id, 'ids must not collide (React keys, god lookups)');
  assert.equal(tasksOf(home).length, 2);
});

test('deleteHumanTask: only human-origin todo cards go; god cards and progressed cards stay', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureAgent({ id: 'god1', name: 'God', provider: 'claude', cwd: home, isGod: true });

  hive.writeTasks([
    { id: 'god-card', title: 'god', status: 'todo', dependsOn: [], priority: 2, createdAt: '2026-08-16T00:00:00.000Z' },
    { id: 'human-1', title: 'kept', status: 'todo', dependsOn: [], priority: 3, createdAt: '2026-08-16T00:00:00.000Z', origin: 'human' },
    { id: 'human-2', title: 'picked up', status: 'doing', dependsOn: [], priority: 3, createdAt: '2026-08-16T00:00:00.000Z', origin: 'human' }
  ]);

  assert.equal(hive.deleteHumanTask('god-card'), false, 'god card: never UI-deletable');
  assert.equal(hive.deleteHumanTask('human-2'), false, 'left todo: the hive picked it up');
  assert.equal(hive.deleteHumanTask('missing'), false);
  assert.equal(hive.deleteHumanTask('human-1'), true);

  const onDisk = tasksOf(home).map((x) => x.id);
  assert.deepEqual(onDisk, ['god-card', 'human-2'], 'only the untouched human card is gone');
});

test('addHumanTask never wakes the god (amendment 1: heartbeat triage, no inbox message)', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureAgent({ id: 'god1', name: 'God', provider: 'claude', cwd: home, isGod: true });

  hive.addHumanTask('quiet card');
  const inbox = path.join(home, 'hive', 'agents', 'god1', 'inbox');
  const files = fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((f) => f.endsWith('.json')) : [];
  assert.equal(files.length, 0, 'card creation must not deliver any message');
});
