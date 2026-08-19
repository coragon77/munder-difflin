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

// ——— operator holds vs the doing flip (card agent-hive-dispatch-must-be-th-
// 2026-08-18): a paused card is the operator's hold — the doing flip must
// refuse it, not silently auto-resume it. blocked->doing stays legal (the
// humanQA resume flow: god unblocks a card once the human answered).

test("status doing on a PAUSED card refuses — the hold is the operator's, nothing written", {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const id = s.run('add', '--title', 'Held card', '--status', 'todo').trim();
  s.run('update', id, '--paused');
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const r = s.runFail('status', id, 'doing');
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /paused:true/, 'refusal names the flag');
  assert.match(r.stderr, /operator/i, 'refusal points at the operator');
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.status, 'todo', 'card not flipped');
  assert.equal(card.paused, true, 'still on hold');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched');
});

test('status doing on a BLOCKED card still works — the humanQA resume flow stays legal', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const id = s.run('add', '--title', 'Blocked card', '--status', 'todo').trim();
  s.run('status', id, 'blocked');
  s.run('status', id, 'doing');
  assert.equal(s.tasks().find((c) => c.id === id).status, 'doing', 'resume via doing flip works');
});

// ——— engagement-aware flips (2026-08-17): status doing --adopt / --fresh ————
// --adopt marks the card sessionMode:'adopt' (the watcher leads + stamps the
// assignee's CURRENT conversation, NO clear); --fresh is the explicit spelling
// of the default. Born-doing SELF-cards stamp their own sessionId at creation
// (ghost-card fix: a card born doing never passes through a transition, so
// nothing else would ever link it to the conversation it runs in).

test('status doing --adopt marks sessionMode and prints the mode', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  const id = s
    .run('add', '--title', 'Connected card', '--status', 'todo', '--assignee', 'kevin-1')
    .trim();
  const out = s.run('status', id, 'doing', '--adopt');
  assert.match(out.trim(), new RegExp('^' + id + ' -> doing \\(adopt\\)$'));
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.status, 'doing');
  assert.equal(card.sessionMode, 'adopt', 'the marker the watcher consumes');
});

test('status doing --fresh is the explicit default — no marker', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  const id = s
    .run('add', '--title', 'Plain flip', '--status', 'todo', '--assignee', 'kevin-1')
    .trim();
  s.run('status', id, 'doing', '--fresh');
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.status, 'doing');
  assert.equal(card.sessionMode, undefined, 'absent marker = fresh (the default)');
});

test('a plain or --fresh doing flip CLEARS a stale sessionMode adopt — no hijack on re-flip', {
  skip: !POSIX,
}, async (t) => {
  // Regression shape of the live card agent-sst-ticket-3110: an --adopt flip
  // leaves sessionMode:'adopt' on the card forever (the watcher consumes the
  // transition, not the field). Blocked→doing without --adopt must NOT adopt
  // whatever conversation happens to be live — it resumes the card's stamp
  // instead (the watcher's sessionId branch), so the stale marker has to go.
  const s = setup(t);
  s.hive.writeTasks([
    {
      id: 'agent-stale-adopt-2026-08-18',
      title: 'Stale adopt marker',
      status: 'blocked',
      assignee: 'kevin-1',
      sessionId: 'f68d69ae-c2ac-4d4d-ae63-b244fff90453',
      sessionMode: 'adopt',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  s.run('status', 'agent-stale-adopt-2026-08-18', 'doing');
  const card = s.tasks().find((c) => c.id === 'agent-stale-adopt-2026-08-18');
  assert.equal(card.sessionMode, undefined, 'stale adopt cleared by the plain flip');
  assert.equal(card.sessionId, 'f68d69ae-c2ac-4d4d-ae63-b244fff90453', 'stamp kept');
});

test('status --adopt/--fresh validate: only doing, not both, needs assignee, unknown flags rejected', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const id = s.run('add', '--title', 'Checks', '--status', 'todo', '--assignee', 'kevin-1').trim();
  const bare = s.hive.addHumanTask('No assignee yet').id;

  const before = fs.readFileSync(s.tasksPath, 'utf8');
  let r = s.runFail('status', id, 'done', '--adopt');
  assert.notEqual(r.code, 0, '--adopt outside doing rejected');
  assert.match(r.stderr, /doing/);
  r = s.runFail('status', id, 'doing', '--adopt', '--fresh');
  assert.notEqual(r.code, 0, 'both flags rejected');
  r = s.runFail('status', bare, 'doing', '--adopt');
  assert.notEqual(r.code, 0, '--adopt without an assignee rejected');
  assert.match(r.stderr, /assignee/);
  r = s.runFail('status', id, 'doing', '--nonsense');
  assert.notEqual(r.code, 0, 'unknown flag rejected');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched after rejections');
});

test('add --status doing (self-card) stamps the current sessionId — born-doing ghost fix', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  // The running pane's conversation, as registry.json knows it.
  const regPath = path.join(path.dirname(s.tasksPath), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  reg.agents['test-worker-1'] = {
    ...(reg.agents['test-worker-1'] ?? { id: 'test-worker-1' }),
    sessionId: 'live-conversation-42',
  };
  fs.writeFileSync(regPath, JSON.stringify(reg));

  const id = s.run('add', '--title', 'Self carded mid-work', '--status', 'doing').trim();
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.status, 'doing');
  assert.equal(card.assignee, 'test-worker-1');
  assert.equal(card.sessionId, 'live-conversation-42', 'born linked to its conversation');
});

test("add --status doing for ANOTHER assignee stamps nothing (god's fresh intent stands)", {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const regPath = path.join(path.dirname(s.tasksPath), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  reg.agents['kevin-1'] = { id: 'kevin-1', sessionId: 'kevins-conversation' };
  fs.writeFileSync(regPath, JSON.stringify(reg));

  // God mints a born-doing card FOR kevin from god's own pane: stamping
  // kevin's current conversation would silently adopt whatever kevin is in —
  // no stamp, no false linkage.
  const id = s
    .run('add', '--title', 'Dispatched card', '--status', 'doing', '--assignee', 'kevin-1')
    .trim();
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.sessionId, undefined);
});

test('add --status todo stamps nothing even for a self-card', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  const regPath = path.join(path.dirname(s.tasksPath), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  reg.agents['test-worker-1'] = { id: 'test-worker-1', sessionId: 'live-conversation-42' };
  fs.writeFileSync(regPath, JSON.stringify(reg));
  const id = s.run('add', '--title', 'Queued work', '--status', 'todo').trim();
  assert.equal(s.tasks().find((c) => c.id === id).sessionId, undefined);
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
  const c = s.tasks().find((x) => x.id === card.id);
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

// ——— god-mint defaults + assignee clear (card agent-harness-hive-card-add-mu-2026-08-17) —
// Self-assignment is a WORKER affordance: god mints the backlog, so a card god
// adds without --assignee carries NO assignee (registry.json's godId is the
// only god signal). update --assignee '' clears (god had to python-patch the
// ledger by hand before).

test('add: god-minted card without --assignee stays UNASSIGNED', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const regPath = path.join(path.dirname(s.tasksPath), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  reg.godId = 'test-god-1';
  fs.writeFileSync(regPath, JSON.stringify(reg));
  const godEnv = { ...s.env, AGENT_ID: 'test-god-1' };

  const id = execFileSync(
    process.execPath,
    [s.cli, 'add', '--title', 'Backlog from god', '--status', 'todo'],
    { env: godEnv, encoding: 'utf8' },
  ).trim();
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.assignee, undefined, 'no caller default for the god mint');
});

test('add: god with explicit --assignee still assigns (dispatch path unchanged)', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const regPath = path.join(path.dirname(s.tasksPath), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  reg.godId = 'test-god-1';
  fs.writeFileSync(regPath, JSON.stringify(reg));
  const godEnv = { ...s.env, AGENT_ID: 'test-god-1' };

  const id = execFileSync(
    process.execPath,
    [s.cli, 'add', '--title', 'Dispatched by god', '--status', 'todo', '--assignee', 'kevin-1'],
    { env: godEnv, encoding: 'utf8' },
  ).trim();
  assert.equal(s.tasks().find((c) => c.id === id).assignee, 'kevin-1');
});

test("update: --assignee '' clears the assignee, untouched fields stay", {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const card = s.hive.addHumanTask('Wrongly mine');
  s.run('update', card.id, '--title', 'Renamed meanwhile', '--assignee', 'stanley-1');

  s.run('update', card.id, '--assignee', '');
  const c = s.tasks().find((x) => x.id === card.id);
  assert.equal(c.assignee, undefined, 'empty --assignee clears');
  assert.equal(c.title, 'Renamed meanwhile', 'untouched fields stay');
  assert.ok(!('assignee' in c), 'the key is gone, not an empty string');
});

// ——— list (card agent-hive-card-list-a-read-on-2026-08-19): the READ-ONLY
// board reader — one line per card, fixed columns, paused rendered
// UNCONDITIONALLY. God's ad-hoc python heredocs read whatever fields their
// author remembered (2026-08-18: filtered on status alone, never read
// paused, dispatched a held card) — this subcommand is the replacement.

function seedBoard(s) {
  const mk = (over) => ({
    dependsOn: [],
    priority: 3,
    createdAt: '2026-08-19T00:00:00.000Z',
    origin: 'agent',
    ...over,
  });
  // Ledger order deliberately shuffled: done, blocked, todo×2, doing.
  s.hive.writeTasks([
    mk({ id: 'l-done', title: 'Shipped long ago', status: 'done', assignee: 'stanley-1' }),
    mk({
      id: 'l-blocked',
      title: 'Waiting on customer',
      status: 'blocked',
      assignee: 'jessica-1',
    }),
    mk({
      id: 'l-todo-held',
      title: 'Held import',
      status: 'todo',
      assignee: 'kevin-1',
      paused: true,
    }),
    mk({ id: 'l-todo', title: 'Fresh backlog', status: 'todo' }),
    mk({ id: 'l-doing', title: 'In flight', status: 'doing', assignee: 'kevin-1' }),
  ]);
}

const L_HELD = 'todo | l-todo-held | kevin-1 | paused=yes | Held import';
const L_TODO = 'todo | l-todo | - | paused=no | Fresh backlog';
const L_DOING = 'doing | l-doing | kevin-1 | paused=no | In flight';
const L_BLOCKED = 'blocked | l-blocked | jessica-1 | paused=no | Waiting on customer';
const L_DONE = 'done | l-done | stanley-1 | paused=no | Shipped long ago';

const linesOf = (out) => out.split('\n').filter(Boolean);

test('list: no filters — every card, fixed columns, paused ALWAYS rendered, grouped order', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  seedBoard(s);
  // Group order todo→doing→blocked→done, stable within a group (the held
  // todo precedes the fresh one in the ledger and must stay first).
  assert.deepEqual(linesOf(s.run('list')), [L_HELD, L_TODO, L_DOING, L_BLOCKED, L_DONE]);
});

test('list: --open is the working set todo+doing+blocked — done excluded', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  seedBoard(s);
  assert.deepEqual(linesOf(s.run('list', '--open')), [L_HELD, L_TODO, L_DOING, L_BLOCKED]);
});

test('list: --status selects one status', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  seedBoard(s);
  assert.deepEqual(linesOf(s.run('list', '--status', 'doing')), [L_DOING]);
  assert.deepEqual(linesOf(s.run('list', '--status', 'done')), [L_DONE]);
});

test('list: --assignee filter keeps held cards VISIBLE with paused=yes — the incident read', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  seedBoard(s);
  // Filtering by owner is exactly the 2026-08-18 shape: the answer must
  // still surface paused=yes, never silently drop the hold column.
  assert.deepEqual(linesOf(s.run('list', '--assignee', 'kevin-1')), [L_HELD, L_DOING]);
});

test('list: filters AND together', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  seedBoard(s);
  assert.deepEqual(linesOf(s.run('list', '--status', 'todo', '--assignee', 'kevin-1')), [L_HELD]);
});

test('list: READ-ONLY under every flag combo — ledger byte-identical, no lock/tmp residue', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  seedBoard(s);
  const before = fs.readFileSync(s.tasksPath, 'utf8');
  const combos = [
    [],
    ['--open'],
    ['--status', 'done'],
    ['--status=done'],
    ['--assignee', 'kevin-1'],
    ['--status', 'todo', '--assignee', 'kevin-1'],
  ];
  for (const args of combos) {
    s.run('list', ...args);
    assert.equal(
      fs.readFileSync(s.tasksPath, 'utf8'),
      before,
      'ledger untouched by: list ' + args.join(' '),
    );
  }
  const residue = fs
    .readdirSync(path.dirname(s.tasksPath))
    .filter((f) => f.includes('.tmp') || f.endsWith('.lock'));
  assert.deepEqual(residue, [], 'no lock or tmp files left behind');
});

test('list: long titles truncate, embedded newlines flatten — one card per line', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  s.hive.writeTasks([
    {
      id: 'l-long',
      title: 'X'.repeat(300) + '\nINJECTED SECOND LINE',
      status: 'todo',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const out = s.run('list');
  const lines = linesOf(out);
  assert.equal(lines.length, 1, 'exactly one line — no wrap, no injected row');
  assert.ok(!out.includes('INJECTED'), 'a newline in a title cannot add rows');
  const title = lines[0].split(' | ')[4];
  assert.ok(title.endsWith('…'), 'over-long title truncated');
  assert.equal(title.length, 80, 'title column capped at 80');
});

test('list: rejects unknown flags, bad --status, and --open with --status — nothing written', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  seedBoard(s);
  const before = fs.readFileSync(s.tasksPath, 'utf8');
  let r = s.runFail('list', '--paused');
  assert.notEqual(r.code, 0, 'list takes no mutation flags');
  r = s.runFail('list', '--paused', 'now');
  assert.notEqual(r.code, 0, 'valued mutation flag rejected');
  assert.match(r.stderr, /unknown flag/i);
  r = s.runFail('list', '--status', 'nonsense');
  assert.notEqual(r.code, 0, 'bad status rejected');
  r = s.runFail('list', '--open', '--status', 'todo');
  assert.notEqual(r.code, 0, '--open with --status rejected');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched');
});

// ——— ask + prune-done (card agent-hive-card-ask-prune-done-2026-08-19) ———
// The two card mutations god used to hand-edit into tasks.json — the one file
// its own instructions say must never be hand-edited.

/** The REAL openQuestion from the renderer: the ASK ME board's selector, and
 *  the reason `ask` appends its entries REVERSED. Scraped + transpiled rather
 *  than imported — TasksKanban.tsx pulls in the whole React renderer, while
 *  this function is pure and import-free. A failing scrape is itself the
 *  signal: the CLI's ordering is calibrated against this exact walk. */
function loadOpenQuestion(t) {
  const ts = require('typescript');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src/renderer/src/components/TasksKanban.tsx'),
    'utf8',
  );
  const start = src.indexOf('export function openQuestion');
  assert.ok(start >= 0, 'openQuestion still lives in TasksKanban.tsx');
  let depth = 0;
  let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) {
      end = j + 1;
      break;
    }
  }
  assert.ok(end > 0, 'openQuestion body parses');
  const js = ts.transpileModule(src.slice(start, end).replace('export function', 'function'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = path.join(os.tmpdir(), `md-openquestion-${process.pid}-${Date.now()}.cjs`);
  fs.writeFileSync(file, `${js}\nmodule.exports = openQuestion;\n`);
  t.after(() => fs.rmSync(file, { force: true }));
  return require(file);
}

/** What the operator actually experiences: answer the surfaced ask, look
 *  again, repeat. Returns the questions in the order the board shows them. */
function drainAsks(openQuestion, card) {
  const seen = [];
  for (let guard = 0; guard < 20; guard++) {
    const open = openQuestion(card);
    if (!open) break;
    seen.push(open.q);
    open.a = 'answered';
  }
  return seen;
}

test('ask: one entry per --q, surfaced in the order given, card blocks', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const openQuestion = loadOpenQuestion(t);
  const id = s.run('add', '--title', 'Needs the human', '--status', 'doing').trim();

  const out = s.run(
    'ask',
    id,
    '--q',
    'Ship A or B?',
    '--q',
    'Who owns the rollout?',
    '--q',
    'Budget for the migration?',
  );
  assert.match(out, /-> blocked/, 'receipt names the block');
  assert.match(out, /3 asks appended/, 'receipt counts the asks');

  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.status, 'blocked', 'asking the human blocks the card');
  assert.equal(card.humanQA.length, 3, 'three separate entries — never one joined paragraph');
  for (const e of card.humanQA) {
    assert.ok(!Number.isNaN(Date.parse(e.askedAt)), 'each entry stamps askedAt');
    assert.equal(e.a, undefined, 'each entry is open, with its own answer slot');
  }
  assert.deepEqual(
    drainAsks(openQuestion, card),
    ['Ship A or B?', 'Who owns the rollout?', 'Budget for the migration?'],
    'the ASK ME board surfaces them in the order they were written',
  );
});

test('ask: appends to history — existing entries and their answers survive untouched', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const openQuestion = loadOpenQuestion(t);
  s.hive.writeTasks([
    {
      id: 'agent-with-history-2026-08-19',
      title: 'Card with a decided question',
      status: 'doing',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      humanQA: [
        {
          q: 'Old decided question?',
          a: 'Yes, do it.',
          askedAt: '2026-08-18T09:00:00.000Z',
          answeredAt: '2026-08-18T10:00:00.000Z',
        },
        { q: 'Still-open older ask?', askedAt: '2026-08-18T11:00:00.000Z' },
      ],
    },
  ]);
  const before = s.tasks()[0].humanQA.slice(0, 2);

  s.run('ask', 'agent-with-history-2026-08-19', '--q', 'New one?', '--q', 'New two?');
  const card = s.tasks()[0];
  assert.deepEqual(card.humanQA.slice(0, 2), before, 'history byte-identical, still first');
  assert.equal(card.humanQA.length, 4, 'appended, nothing dropped');
  assert.deepEqual(
    drainAsks(openQuestion, card),
    ['New one?', 'New two?', 'Still-open older ask?'],
    'new asks come first, the older open one is still reachable, the answered one is done',
  );
});

test('ask: validates and leaves the ledger untouched on refusal', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  const id = s.run('add', '--title', 'Guarded', '--status', 'doing').trim();
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  let r = s.runFail('ask', id);
  assert.notEqual(r.code, 0, 'no --q rejected');
  assert.match(r.stderr, /at least one --q/);
  r = s.runFail('ask', id, '--q', '   ');
  assert.notEqual(r.code, 0, 'blank --q rejected');
  r = s.runFail('ask', id, '--q', 'ok', '--notes', 'nope');
  assert.notEqual(r.code, 0, 'unknown flag rejected');
  r = s.runFail('ask', 'no-such-card', '--q', 'ok');
  assert.notEqual(r.code, 0, 'unknown id rejected');
  assert.match(r.stderr, /no card with id/);

  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched after rejections');
});

test('prune-done: defaults to a dry run — lists the ids, writes nothing', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const done = s.run('add', '--title', 'Shipped it', '--status', 'todo').trim();
  s.run('status', done, 'done');
  const open = s.run('add', '--title', 'Still going', '--status', 'doing').trim();
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const out = s.run('prune-done');
  assert.match(out, /1 done card would be removed \(dry run/, 'says what WOULD happen');
  assert.match(out, /--confirm/, 'names the confirming flag');
  assert.ok(out.includes(done), 'lists the id');
  assert.ok(!out.includes(open), 'lists only done cards');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'dry run wrote nothing');

  const explicit = s.run('prune-done', '--dry-run');
  assert.equal(explicit, out, '--dry-run is the explicit spelling of the default');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'still nothing written');
});

test('prune-done --confirm removes ONLY done cards', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  const ids = {};
  for (const st of ['todo', 'doing', 'blocked', 'done']) {
    const id = s.run('add', '--title', `Card ${st}`, '--status', 'todo').trim();
    if (st !== 'todo') s.run('status', id, st);
    ids[st] = id;
  }
  const second = s.run('add', '--title', 'Also finished', '--status', 'todo').trim();
  s.run('status', second, 'done');

  const out = s.run('prune-done', '--confirm');
  assert.match(out, /2 done cards removed/, 'prints the count');
  assert.ok(out.includes(ids.done) && out.includes(second), 'prints the removed ids');

  const left = s
    .tasks()
    .map((c) => c.id)
    .sort();
  assert.deepEqual(left, [ids.todo, ids.doing, ids.blocked].sort(), 'only done cards went');

  const empty = s.run('prune-done', '--confirm');
  assert.match(empty, /^prune-done: 0 done cards removed\n$/, 'a clean board prunes nothing');
  const r = s.runFail('prune-done', '--dry-run', '--confirm');
  assert.notEqual(r.code, 0, '--dry-run with --confirm rejected');
  const bad = s.runFail('prune-done', '--all');
  assert.notEqual(bad.code, 0, 'unknown argument rejected');
});

test('prune-done re-reads under the lock — a concurrent landing is never clobbered', {
  skip: !POSIX,
}, async (t) => {
  // The stale read-modify-write god carried by hand: read the ledger, prune,
  // write back — losing every card another writer landed in between. The
  // filter runs inside the lock on a fresh read, so it cannot happen.
  const s = setup(t);
  const doomed = [];
  for (let i = 0; i < 4; i++) {
    const id = s.run('add', '--title', `Finished ${i}`, '--status', 'todo').trim();
    s.run('status', id, 'done');
    doomed.push(id);
  }

  let readErr = null;
  const iv = setInterval(() => {
    try {
      JSON.parse(fs.readFileSync(s.tasksPath, 'utf8'));
    } catch (e) {
      readErr = readErr ?? e;
    }
  }, 1);
  t.after(() => clearInterval(iv));

  const spawn = (args) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [s.cli, ...args],
        { env: s.env, encoding: 'utf8' },
        (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
      );
    });
  const landed = await Promise.all([
    spawn(['prune-done', '--confirm']),
    ...Array.from({ length: 5 }, (_, i) =>
      spawn(['add', '--title', `Landed mid-prune ${i}`, '--status', 'doing']),
    ),
  ]);
  clearInterval(iv);
  assert.equal(readErr, null, 'every read mid-write parsed cleanly');

  const cards = s.tasks();
  for (const id of landed.slice(1)) {
    assert.ok(
      cards.some((c) => c.id === id),
      `${id} survived the prune`,
    );
  }
  for (const id of doomed) assert.ok(!cards.some((c) => c.id === id), `${id} was pruned`);
  assert.deepEqual(
    fs.readdirSync(path.dirname(s.tasksPath)).filter((f) => f.includes('.tmp')),
    [],
    'no tmp files left behind',
  );
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
