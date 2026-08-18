'use strict';

/**
 * actionableCards (card agent-actionablecards-one-shar-2026-08-18): ONE
 * definition of "actionable" — status todo, not paused:true, not blocked, no
 * owner already on it — with THREE consumers that must never disagree:
 *
 *   1. god's roster injection (HiveManager.rosterContext — slim AND full),
 *   2. the hive-dispatch hold gate (refuses paused/blocked targets),
 *   3. `hive-card actionable` (god's on-demand lister).
 *
 * The load-bearing tests here are the CROSS-CHECKS: they execute the REAL
 * generated bin/ CLIs against the lister's output. If the gate and the lister
 * ever drift apart, the injection would name a card the gate refuses — and
 * these tests fail before that can ship.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { actionableCards, cardHeld, renderActionableLine } = loadTs('src/main/actionableCards.ts');

const POSIX = process.platform !== 'win32';

function card(id, extra = {}) {
  return {
    id,
    title: `Card ${id}`,
    status: 'todo',
    dependsOn: [],
    priority: 3,
    createdAt: '2026-08-18T00:00:00.000Z',
    origin: 'human',
    ...extra,
  };
}

// Every card shape the predicate must separate.
const SHAPES = [
  card('free-todo'), // actionable
  card('paused-todo', { paused: true }), // operator hold — excluded
  card('blocked-card', { status: 'blocked' }), // operator hold — excluded
  card('owned-todo', { assignee: 'bystander' }), // owned — excluded (list only)
  card('doing-card', { status: 'doing', assignee: 'bystander' }),
  card('done-card', { status: 'done', assignee: 'bystander' }),
];

// ── the predicate ───────────────────────────────────────────────────────

test('actionableCards: exactly the unowned, unpaused, non-blocked todos', () => {
  assert.deepEqual(actionableCards({ tasks: SHAPES }), ['free-todo']);
});

test('actionableCards: paused must be strictly true — truthy noise is not a hold', () => {
  assert.deepEqual(
    actionableCards({
      tasks: [card('a'), card('b', { paused: undefined }), card('c', { paused: false })],
    }),
    ['a', 'b', 'c'],
  );
});

test('actionableCards: whitespace-only assignee is unowned', () => {
  assert.deepEqual(actionableCards({ tasks: [card('a', { assignee: '   ' })] }), ['a']);
});

test('actionableCards: defensive shapes — missing ledger, junk rows, junk input', () => {
  assert.deepEqual(actionableCards(undefined), []);
  assert.deepEqual(actionableCards({}), []);
  assert.deepEqual(actionableCards('not a ledger'), []);
  assert.deepEqual(actionableCards({ tasks: 'nope' }), []);
  assert.deepEqual(actionableCards({ tasks: [null, 7, { no: 'id' }, card('ok')] }), ['ok']);
});

test('cardHeld: paused:true or status blocked — the operator hold', () => {
  assert.equal(cardHeld(card('a')), false);
  assert.equal(cardHeld(card('a', { paused: true })), true);
  assert.equal(cardHeld(card('a', { status: 'blocked' })), true);
  assert.equal(cardHeld(card('a', { status: 'doing' })), false);
  assert.equal(cardHeld(card('a', { paused: 'yes' })), false); // strictly true, not truthy
  assert.equal(cardHeld(null), false);
});

// ── the rendered line (wording is part of the feature) ──────────────────

test('renderActionableLine: plain fact, ids, cap at 3 then +K more', () => {
  assert.equal(renderActionableLine([]), 'ACTIONABLE: 0');
  assert.equal(renderActionableLine(['one']), 'ACTIONABLE: 1 - one');
  assert.equal(renderActionableLine(['one', 'two']), 'ACTIONABLE: 2 - one, two');
  assert.equal(renderActionableLine(['a', 'b', 'c', 'd']), 'ACTIONABLE: 4 - a, b, c (+1 more)');
  assert.equal(
    renderActionableLine(['a', 'b', 'c', 'd', 'e', 'f']),
    'ACTIONABLE: 6 - a, b, c (+3 more)',
  );
});

test('renderActionableLine: never reads as a directive', () => {
  const line = renderActionableLine(['a']);
  assert.doesNotMatch(line, /dispatch|should|must|now|please|queue/i);
});

// ── setup with a real generated hive ────────────────────────────────────

function setup(t, { tasks = SHAPES } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-actionable-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  const env = { ...process.env, HIVE_ROOT: root, AGENT_ID: 'god' };
  const tasksPath = path.join(root, 'tasks.json');
  hive.writeTasks(tasks);
  const writeRegistry = (agents) =>
    fs.writeFileSync(
      path.join(root, 'registry.json'),
      JSON.stringify({ godId: 'god', agents }, null, 2),
    );
  const ledger = () => JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  const run = (cli, ...args) => {
    const { execFileSync } = require('node:child_process');
    try {
      return {
        code: 0,
        stdout: execFileSync(path.join(root, 'bin', cli), args, { env, encoding: 'utf8' }),
        stderr: '',
      };
    } catch (e) {
      return {
        code: e.status ?? -1,
        stdout: String(e.stdout ?? ''),
        stderr: String(e.stderr ?? ''),
      };
    }
  };
  return { hive, root, env, tasksPath, ledger, run, writeRegistry };
}

const WORKERS = {};
for (let i = 1; i <= 6; i++)
  WORKERS[`worker-${i}`] = { id: `worker-${i}`, name: `W${i}`, archived: false, vacation: false };

// ── LOAD-BEARING: the gate and the lister cannot disagree ───────────────

test('every card the lister names dispatches through the REAL hive-dispatch gate', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const named = actionableCards(s.ledger());
  assert.deepEqual(named, ['free-todo'], 'fixture sanity: exactly one named card');

  for (const id of named) {
    const r = s.run('hive-dispatch', '--card', id, '--assignee', 'worker-1', '--body', 'c');
    assert.equal(r.code, 0, `gate must accept the injected card ${id}: ${r.stderr}`);
  }
});

test('held cards are excluded by the lister AND refused by the gate — no asymmetry', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  for (const id of ['paused-todo', 'blocked-card']) {
    const r = s.run('hive-dispatch', '--card', id, '--assignee', 'worker-1', '--body', 'c');
    assert.notEqual(r.code, 0, `gate refuses ${id}`);
    assert.match(r.stderr, /operator/i);
  }
});

test('a card the gate holds can never appear in the lister output (all shapes, all consumers)', () => {
  const ids = actionableCards({ tasks: SHAPES });
  for (const c of SHAPES) {
    if (cardHeld(c)) assert.ok(!ids.includes(c.id), `held card ${c.id} must not be listed`);
  }
});

test('owned todos stay gate-LEGAL by design (assign-then-dispatch flow) — pinned asymmetry', {
  skip: !POSIX,
}, (t) => {
  // The lister excludes owned todos (someone is already on it); the gate still
  // accepts them — hive-card update --assignee + hive-dispatch is a documented
  // flow. This is the ONE deliberate narrow difference; hold conditions
  // (paused/blocked) have zero asymmetry, as pinned above.
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const r = s.run('hive-dispatch', '--card', 'owned-todo', '--assignee', 'worker-2', '--body', 'c');
  assert.equal(r.code, 0, `owned todo is dispatchable: ${r.stderr}`);
});

// ── CLI lister: hive-card actionable ────────────────────────────────────

test('hive-card actionable prints the same rendered line and the same list', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const r = s.run('hive-card', 'actionable');
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(
    lines[0],
    renderActionableLine(actionableCards(s.ledger())),
    'first line = injection render',
  );
  assert.deepEqual(lines.slice(1), actionableCards(s.ledger()), 'then the full uncapped list');
});

test('hive-card actionable: zero and backlog shapes', { skip: !POSIX }, (t) => {
  const s0 = setup(t, { tasks: [card('held', { paused: true }), card('own', { assignee: 'x' })] });
  const r0 = s0.run('hive-card', 'actionable');
  assert.equal(r0.code, 0);
  assert.equal(r0.stdout.trim(), 'ACTIONABLE: 0');

  const ids = ['a1', 'b2', 'c3', 'd4', 'e5'];
  const s5 = setup(t, { tasks: ids.map((i) => card(i)) });
  const r5 = s5.run('hive-card', 'actionable');
  assert.equal(r5.code, 0);
  assert.equal(r5.stdout.trim().split('\n')[0], 'ACTIONABLE: 5 - a1, b2, c3 (+2 more)');
  assert.deepEqual(r5.stdout.trim().split('\n').slice(1), ids);
});

test('hive-card actionable: corrupt ledger refuses, never guesses', { skip: !POSIX }, (t) => {
  const s = setup(t);
  fs.writeFileSync(s.tasksPath, 'this is not json', 'utf8');
  const r = s.run('hive-card', 'actionable');
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.trim(), 'error explains itself');
});

// ── the injection: rosterContext slim AND full carry the line ───────────

test('rosterContext full block carries the ACTIONABLE line with ids', async (t) => {
  const s = setup(t);
  await s.hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: s.root,
    isGod: true,
  });
  s.hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [{ id: 'god-1', name: 'Michael', isGod: true }],
  });
  const full = s.hive.rosterContext();
  assert.match(full, /ACTIONABLE: 1 - free-todo/);
});

test('rosterContext slim line (unchanged roster) still carries the ACTIONABLE line', async (t) => {
  const s = setup(t);
  await s.hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: s.root,
    isGod: true,
  });
  s.hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [{ id: 'god-1', name: 'Michael', isGod: true }],
  });
  s.hive.rosterContext('god-1'); // full — stores the sig
  const slim = s.hive.rosterContext('god-1'); // unchanged → slim
  assert.match(slim, /unchanged/);
  assert.match(slim, /ACTIONABLE: 1 - free-todo/);
});

test('rosterContext: all held/owned renders the plain zero', async (t) => {
  const s = setup(t, { tasks: [card('held', { paused: true })] });
  await s.hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: s.root,
    isGod: true,
  });
  s.hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [{ id: 'god-1', name: 'Michael', isGod: true }],
  });
  assert.match(s.hive.rosterContext(), /ACTIONABLE: 0/);
  s.hive.rosterContext('god-1');
  assert.match(s.hive.rosterContext('god-1'), /ACTIONABLE: 0/);
});

test('rosterContext: a backlog caps the ids at 3 then +K more', async (t) => {
  const s = setup(t, { tasks: ['a1', 'b2', 'c3', 'd4', 'e5'].map((i) => card(i)) });
  await s.hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: s.root,
    isGod: true,
  });
  s.hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [{ id: 'god-1', name: 'Michael', isGod: true }],
  });
  const expected = 'ACTIONABLE: 5 - a1, b2, c3 (+2 more)';
  assert.ok(s.hive.rosterContext().includes(expected), 'full block caps');
  s.hive.rosterContext('god-1');
  assert.ok(s.hive.rosterContext('god-1').includes(expected), 'slim line caps');
});

test('rosterContext: a missing or corrupt tasks.json still renders the roster', async (t) => {
  const s = setup(t);
  await s.hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: s.root,
    isGod: true,
  });
  s.hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [{ id: 'god-1', name: 'Michael', isGod: true }],
  });
  fs.writeFileSync(s.tasksPath, 'not json', 'utf8');
  const r = s.hive.rosterContext();
  assert.ok(r, 'roster still renders');
  assert.match(r, /ACTIONABLE: 0/);
});
