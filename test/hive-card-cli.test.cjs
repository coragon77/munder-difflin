'use strict';

/**
 * hive-card (card harness-hive-card-cli-20260817): the kanban CLI every agent
 * uses to write tasks.json. Stefan runs /ticket in a worker pane and says
 * "card it" — the worker cards ITSELF (origin 'agent', assignee defaults to
 * $AGENT_ID). Both subcommands are schema-checked and ATOMIC: the full new
 * JSON lands in a tempfile in the SAME directory, then renames onto
 * tasks.json — a reader can never parse a half-written ledger, and
 * concurrent writers retry instead of clobbering each other.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const POSIX = process.platform !== 'win32';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-card-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const cli = path.join(home, 'hive', 'bin', 'hive-card');
  const tasksPath = path.join(home, 'hive', 'tasks.json');
  const env = { ...process.env, HIVE_ROOT: path.join(home, 'hive'), AGENT_ID: 'test-worker-1' };
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const runFail = (...args) => {
    try {
      run(...args);
      return { code: 0, stderr: '' };
    } catch (e) {
      return { code: e.status ?? -1, stderr: String(e.stderr ?? '') };
    }
  };
  const tasks = () => JSON.parse(fs.readFileSync(tasksPath, 'utf8')).tasks;
  return { hive, cli, tasksPath, env, run, runFail, tasks };
}

test('ensureHive ships an executable hive-card in hive/bin', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  assert.ok(fs.existsSync(s.cli), 'hive-card exists in <hive>/bin');
  assert.equal(fs.statSync(s.cli).mode & 0o777, 0o755, 'it is executable');
});

test('add: schema-valid agent card, assignee defaults to $AGENT_ID, prints the id', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  // A pre-existing god card must survive the read-modify-write.
  s.hive.writeTasks([
    {
      id: 'god-card',
      title: 'god work',
      status: 'doing',
      dependsOn: [],
      priority: 2,
      createdAt: '2026-08-17T00:00:00.000Z',
    },
  ]);

  const out = s.run(
    'add',
    '--title',
    'Fix the flaky test',
    '--status',
    'todo',
    '--notes',
    'seen twice on CI',
  );
  const id = out.trim().split('\n').pop();
  assert.match(id, /^agent-fix-the-flaky-test-\d{4}-\d{2}-\d{2}$/, 'prints the generated id');

  const cards = s.tasks();
  assert.equal(cards.length, 2, 'the god card survives');
  assert.equal(cards[0].id, 'god-card');
  const card = cards.find((c) => c.id === id);
  assert.ok(card, 'the new card is on disk');
  assert.equal(card.title, 'Fix the flaky test');
  assert.equal(card.status, 'todo');
  assert.equal(card.origin, 'agent');
  assert.equal(card.assignee, 'test-worker-1', 'assignee defaults to $AGENT_ID');
  assert.equal(card.description, 'seen twice on CI', '--notes lands in description');
  assert.deepEqual(card.dependsOn, []);
  assert.equal(typeof card.priority, 'number');
  assert.ok(!Number.isNaN(Date.parse(card.createdAt)), 'createdAt is ISO-parseable');
});

test('add: --status doing accepted; --assignee overrides $AGENT_ID', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const id = s
    .run('add', '--title', 'Refactor the router', '--status', 'doing', '--assignee', 'other-agent')
    .trim()
    .split('\n')
    .pop();
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.status, 'doing');
  assert.equal(card.assignee, 'other-agent');
});

test('add: same title twice on one day yields distinct ids', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  const a = s.run('add', '--title', 'Dup title', '--status', 'todo').trim();
  const b = s.run('add', '--title', 'Dup title', '--status', 'todo').trim();
  assert.notEqual(a, b);
  assert.ok(s.tasks().some((c) => c.id === a) && s.tasks().some((c) => c.id === b));
});

test('add: rejects bad status and missing title, ledger untouched', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  s.hive.writeTasks([]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  let r = s.runFail('add', '--title', 'x', '--status', 'done');
  assert.notEqual(r.code, 0, 'status outside todo|doing is rejected on add');
  assert.match(r.stderr, /status/i);

  r = s.runFail('add', '--status', 'todo');
  assert.notEqual(r.code, 0, 'missing --title is rejected');

  r = s.runFail('add', '--title', '   ', '--status', 'todo');
  assert.notEqual(r.code, 0, 'blank title is rejected');

  assert.equal(
    fs.readFileSync(s.tasksPath, 'utf8'),
    before,
    'ledger byte-identical after rejections',
  );
});

test('status: moves an existing card and validates inputs', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  const id = s.run('add', '--title', 'Ship it', '--status', 'todo').trim();

  s.run('status', id, 'doing');
  assert.equal(s.tasks().find((c) => c.id === id).status, 'doing');
  s.run('status', id, 'done');
  assert.equal(s.tasks().find((c) => c.id === id).status, 'done');

  const before = fs.readFileSync(s.tasksPath, 'utf8');
  let r = s.runFail('status', 'no-such-card', 'doing');
  assert.notEqual(r.code, 0, 'unknown id rejected');
  r = s.runFail('status', id, 'nonsense');
  assert.notEqual(r.code, 0, 'invalid status rejected');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched after rejections');
});

test('concurrent adds all survive and the file never parses half-written', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const N = 8;
  // A nervous reader hammering the file while writes land: it must ALWAYS
  // parse (atomic rename), never see a partial ledger.
  let reads = 0;
  let readErr = null;
  const iv = setInterval(() => {
    try {
      JSON.parse(fs.readFileSync(s.tasksPath, 'utf8'));
      reads++;
    } catch (e) {
      readErr = readErr ?? e;
    }
  }, 1);
  t.after(() => clearInterval(iv));

  const one = (i) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [s.cli, 'add', '--title', `Concurrent card ${i}`, '--status', 'todo'],
        { env: s.env, encoding: 'utf8' },
        (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
      );
    });
  const ids = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
  clearInterval(iv);
  assert.equal(readErr, null, 'every read mid-write parsed cleanly');
  assert.ok(reads > 0, 'the reader actually ran');

  const cards = s.tasks();
  for (const id of ids)
    assert.ok(
      cards.some((c) => c.id === id),
      `${id} survived the race`,
    );
  assert.equal(cards.length, N, 'no card lost, no duplicate');

  const leftovers = fs.readdirSync(path.dirname(s.tasksPath)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no tmp files left behind');
});

test('update: enrich an existing (human) card — title/notes/assignee, other cards untouched', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  // The god-adoption path: a human-origin card gets enriched + assigned
  // in place (no duplicate card minted).
  const card = s.hive.addHumanTask('Kampa: Ticket #3216');
  s.hive.writeTasks([
    ...s.tasks(),
    {
      id: 'other-card',
      title: 'unrelated',
      status: 'doing',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-17T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const before = s.tasks().find((c) => c.id === 'other-card');

  const out = s.run(
    'update',
    card.id,
    '--title',
    'Kampa: VLB-ONIX conflicts (#3216)',
    '--notes',
    'VLB-ONIX delivery conflicts; redmine 3216',
    '--assignee',
    'stanley-1',
  );
  assert.match(out.trim(), new RegExp('^' + card.id + ' updated$'), 'prints <id> updated');

  const after = s.tasks().find((c) => c.id === card.id);
  assert.equal(after.title, 'Kampa: VLB-ONIX conflicts (#3216)');
  assert.equal(after.description, 'VLB-ONIX delivery conflicts; redmine 3216');
  assert.equal(after.assignee, 'stanley-1');
  assert.equal(after.origin, 'human', 'same card, same origin — no duplicate minted');
  assert.equal(s.tasks().length, 2, 'no extra card appears');
  assert.deepEqual(
    s.tasks().find((c) => c.id === 'other-card'),
    before,
  );
});

test('update: partial fields only touch what was given; rejects bad input', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const card = s.hive.addHumanTask('Only assign me');

  s.run('update', card.id, '--assignee', 'jessica-1');
  let c = s.tasks().find((x) => x.id === card.id);
  assert.equal(c.assignee, 'jessica-1');
  assert.equal(c.title, 'Only assign me', 'title untouched');
  assert.equal(c.description, undefined, 'notes untouched');

  const before = fs.readFileSync(s.tasksPath, 'utf8');
  let r = s.runFail('update', 'no-such-card', '--assignee', 'x');
  assert.notEqual(r.code, 0, 'unknown id rejected');
  assert.match(r.stderr, /no card with id/);

  r = s.runFail('update', card.id);
  assert.notEqual(r.code, 0, 'no flags rejected — nothing to update');
  assert.match(r.stderr, /nothing to update/);

  r = s.runFail('update', card.id, '--status', 'doing');
  assert.notEqual(r.code, 0, 'unknown flag rejected (status has its own subcommand)');

  r = s.runFail('update', card.id, '--title', '   ');
  assert.notEqual(r.code, 0, 'blank title rejected');

  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched after rejections');
});

test('corrupt tasks.json: refuses to write, errors cleanly', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  fs.writeFileSync(s.tasksPath, 'this is not json', 'utf8');
  const r = s.runFail('add', '--title', 'x', '--status', 'todo');
  assert.notEqual(r.code, 0, 'refuses to touch an unparseable ledger');
  assert.equal(
    fs.readFileSync(s.tasksPath, 'utf8'),
    'this is not json',
    'corrupt file not clobbered',
  );
});
