'use strict';

/**
 * hive-dispatch (card agent-harness-hive-dispatch-cl-2026-08-17): god's whole
 * dispatch flow collapsed into ONE command — card create-or-adopt + assign,
 * vacation recall for parked assignees, the doing flip, and the contract mail
 * on the card conversation. One receipt line out. All validation happens
 * BEFORE any write: a refusal leaves ledger, outbox and vacation-requests
 * byte-identical.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const POSIX = process.platform !== 'win32';

function setup(t, { agentId = 'god' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-dispatch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  const cli = path.join(root, 'bin', 'hive-dispatch');
  const tasksPath = path.join(root, 'tasks.json');
  const env = { ...process.env, HIVE_ROOT: root, AGENT_ID: agentId };
  const run = (...args) =>
    execFileSyncSafe(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const runStdin = (input, ...args) =>
    execFileSyncSafe(process.execPath, [cli, ...args], { env, encoding: 'utf8', input });
  const tasks = () => JSON.parse(fs.readFileSync(tasksPath, 'utf8')).tasks;
  const writeRegistry = (agents) =>
    fs.writeFileSync(
      path.join(root, 'registry.json'),
      JSON.stringify({ godId: 'god', agents }, null, 2),
    );
  const outboxMails = () => {
    const dir = path.join(root, 'agents', agentId, 'outbox');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  };
  const recallRequests = () => {
    const dir = path.join(root, 'vacation-requests');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  };
  return {
    hive,
    root,
    cli,
    tasksPath,
    env,
    run,
    runStdin,
    tasks,
    writeRegistry,
    outboxMails,
    recallRequests,
  };
}

// execFileSync that returns {code, stderr} on failure instead of throwing.
function execFileSyncSafe(cmd, args, opts) {
  const { execFileSync } = require('node:child_process');
  try {
    return { code: 0, stdout: execFileSync(cmd, args, opts), stderr: '' };
  } catch (e) {
    return { code: e.status ?? -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

const WORKERS = {
  'worker-1': { id: 'worker-1', name: 'Worker One', archived: false, vacation: false },
  'parked-1': { id: 'parked-1', name: 'Parked One', archived: false, vacation: true },
};

test('ensureHive ships an executable hive-dispatch in hive/bin', { skip: !POSIX }, (t) => {
  const s = setup(t);
  assert.ok(fs.existsSync(s.cli), 'hive-dispatch exists in <hive>/bin');
  assert.equal(fs.statSync(s.cli).mode & 0o777, 0o755, 'it is executable');
});

test('--card <existing>: assigns, flips doing, sends contract mail on the card conversation', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-existing-card-2026-08-18',
      title: 'Existing card',
      status: 'todo',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'human',
    },
  ]);

  const r = s.run(
    '--card',
    'agent-existing-card-2026-08-18',
    '--assignee',
    'worker-1',
    '--body',
    'OBJECTIVE: do the thing.',
  );
  assert.equal(r.code, 0, 'succeeds');
  assert.equal(r.stdout.trim().split('\n').length, 1, 'exactly one receipt line');
  assert.match(r.stdout, /dispatched agent-existing-card-2026-08-18.*worker-1/);

  const card = s.tasks().find((c) => c.id === 'agent-existing-card-2026-08-18');
  assert.equal(card.status, 'doing', 'card flipped doing');
  assert.equal(card.assignee, 'worker-1', 'card assigned');
  assert.equal(card.origin, 'human', 'existing card keeps its origin');

  const mails = s.outboxMails();
  assert.equal(mails.length, 1, 'exactly one contract mail queued');
  const m = mails[0];
  assert.equal(m.to, 'worker-1');
  assert.equal(m.from, 'god');
  assert.equal(m.act, 'request');
  assert.equal(m.requires_reply, true, 'a dispatch expects a reply');
  assert.equal(
    m.conversation,
    'card-agent-existing-card-2026-08-18',
    'mail rides the card conversation',
  );
  assert.equal(m.body, 'OBJECTIVE: do the thing.');
  assert.deepEqual(s.recallRequests(), [], 'floor agent: no recall queued');
});

test('--title <t>: creates the card born-assigned doing, then dispatches', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);

  const r = s.run('--title', 'Fix the widget', '--assignee', 'worker-1', '--body', 'contract');
  assert.equal(r.code, 0);
  const id = /dispatched (\S+)/.exec(r.stdout.trim())[1];
  assert.match(id, /^agent-fix-the-widget-\d{4}-\d{2}-\d{2}$/, 'receipt names the minted id');

  const card = s.tasks().find((c) => c.id === id);
  assert.ok(card, 'card on disk');
  assert.equal(card.status, 'doing');
  assert.equal(card.assignee, 'worker-1');
  assert.equal(card.origin, 'agent');
  assert.equal(s.outboxMails()[0].conversation, 'card-' + id);
});

test('--adopt passes through to the doing flip (sessionMode adopt)', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const id = s
    .run('--title', 'Second card same engagement', '--assignee', 'worker-1', '--body', 'c')
    .stdout.match(/dispatched (\S+)/)[1];
  // re-dispatch the SAME card with --adopt (idempotent: same card, same agent)
  const r = s.run('--card', id, '--assignee', 'worker-1', '--body', 'c2', '--adopt');
  assert.equal(r.code, 0);
  assert.equal(s.tasks().find((c) => c.id === id).sessionMode, 'adopt', '--adopt reached the flip');
});

test('parked assignee: queues the vacation recall before the mail', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const r = s.run('--title', 'Wake the parked one', '--assignee', 'parked-1', '--body', 'contract');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /recall/i, 'receipt mentions the queued recall');
  const recalls = s.recallRequests();
  assert.equal(recalls.length, 1);
  assert.equal(recalls[0].agentId, 'parked-1');
  assert.equal(recalls[0].action, 'recall');
  assert.equal(s.outboxMails().length, 1, 'contract mail still queued');
});

test('refuses when the assignee is active on a DIFFERENT card — nothing written', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-other-engagement-2026-08-18',
      title: 'Other work',
      status: 'doing',
      assignee: 'worker-1',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'agent',
    },
    {
      id: 'agent-target-card-2026-08-18',
      title: 'Target',
      status: 'todo',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'human',
    },
  ]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const r = s.run(
    '--card',
    'agent-target-card-2026-08-18',
    '--assignee',
    'worker-1',
    '--body',
    'c',
  );
  assert.notEqual(r.code, 0, 'refused');
  assert.match(
    r.stderr,
    /worker-1.*agent-other-engagement-2026-08-18|agent-other-engagement-2026-08-18.*worker-1/,
    'error names agent and card',
  );
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched');
  assert.deepEqual(s.outboxMails(), [], 'no mail queued');
});

test('blocked cards also count as active; done/todo cards do not', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-blocked-eng-2026-08-18',
      title: 'B',
      status: 'blocked',
      assignee: 'worker-1',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const r = s.run('--title', 'New', '--assignee', 'worker-1', '--body', 'c');
  assert.notEqual(r.code, 0, 'blocked assignee refused');

  s.hive.writeTasks([
    {
      id: 'agent-done-eng-2026-08-18',
      title: 'D',
      status: 'done',
      assignee: 'worker-1',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const ok = s.run('--title', 'New2', '--assignee', 'worker-1', '--body', 'c');
  assert.equal(ok.code, 0, 'done assignments do not block a fresh dispatch');
});

test('stdin carries the contract when --body is absent', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const r = s.runStdin('piped contract body\n', '--title', 'Stdin card', '--assignee', 'worker-1');
  assert.equal(r.code, 0);
  assert.equal(
    s.outboxMails()[0].body,
    'piped contract body',
    'trailing newline trimmed, content exact',
  );
});

test('validation refusals: bad combos, unknown assignee, missing body — ledger untouched', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');
  const refuse = (...args) => {
    const r = s.run(...args);
    assert.notEqual(r.code, 0, 'refused: ' + args.join(' '));
    assert.ok(r.stderr.trim(), 'error explains itself: ' + args.join(' '));
  };
  refuse('--title', 'T', '--assignee', 'worker-1'); // no body at all (stdin is empty pipe → empty)
  refuse('--title', 'T', '--card', 'x', '--assignee', 'worker-1', '--body', 'c'); // both selectors
  refuse('--assignee', 'worker-1', '--body', 'c'); // neither selector
  refuse('--title', 'T', '--body', 'c'); // no assignee
  refuse('--title', 'T', '--assignee', 'ghost-1', '--body', 'c'); // not in registry
  refuse('--card', 'no-such-card', '--assignee', 'worker-1', '--body', 'c'); // unknown card
  refuse('--title', 'T', '--assignee', 'worker-1', '--body', '   '); // blank body
  refuse('--title', 'T', '--assignee', 'worker-1', '--body', 'c', '--nonsense', 'x'); // unknown flag
  assert.equal(
    fs.readFileSync(s.tasksPath, 'utf8'),
    before,
    'ledger byte-identical after refusals',
  );
});

test('corrupt tasks.json: refuses, never clobbers', { skip: !POSIX }, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  fs.writeFileSync(s.tasksPath, 'this is not json', 'utf8');
  const r = s.run('--title', 'T', '--assignee', 'worker-1', '--body', 'c');
  assert.notEqual(r.code, 0);
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), 'this is not json', 'corrupt file preserved');
});
