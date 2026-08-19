'use strict';

/**
 * Blocked provenance (card agent-disambiguate-blocked-ope-2026-08-19): ONE
 * blocked status, gated on WHO the card waits on. `hive-card status blocked`
 * stamps blockedBy=$AGENT_ID (+ optional --why → blockedWhy); `hive-card
 * ask` stamps blockedBy='human-ask'. The hive-dispatch gate refuses exactly
 * as before EXCEPT the recorded owner's own --resume return (blockedBy =
 * card assignee = --assignee); the refusal wording splits by kind (human-ask
 * quotes the open question, agent-wait names who, no-provenance keeps
 * today's wording), paused is checked FIRST and stays absolute, and legacy
 * blocked cards without blockedBy fail closed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const POSIX = process.platform !== 'win32';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-blocked-prov-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  const dispatchCli = path.join(root, 'bin', 'hive-dispatch');
  const cardCli = path.join(root, 'bin', 'hive-card');
  const tasksPath = path.join(root, 'tasks.json');
  // Isolated $HOME so --resume's claude-session check never sees the
  // developer's real ~/.claude/projects.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'md-blocked-prov-home-'));
  t.after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HIVE_ROOT: root,
    AGENT_ID: 'god',
    HOME: isolatedHome,
  };
  const runDispatch = (args, envOver) =>
    execFileSyncSafe(process.execPath, [dispatchCli, ...args], {
      env: { ...env, ...envOver },
      encoding: 'utf8',
    });
  const runCard = (args, envOver) =>
    execFileSyncSafe(process.execPath, [cardCli, ...args], {
      env: { ...env, ...envOver },
      encoding: 'utf8',
    });
  const tasks = () => JSON.parse(fs.readFileSync(tasksPath, 'utf8')).tasks;
  const writeRegistry = (agents) =>
    fs.writeFileSync(
      path.join(root, 'registry.json'),
      JSON.stringify({ godId: 'god', agents }, null, 2),
    );
  const outboxMails = () => {
    const dir = path.join(root, 'agents', 'god', 'outbox');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  };
  return { hive, root, tasksPath, env, runDispatch, runCard, tasks, writeRegistry, outboxMails };
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

/** Plant a claude session transcript under $HOME/.claude/projects/<proj>/. */
function plantClaudeSession(userHome, sid, proj = '-opt-somewhere') {
  const dir = path.join(userHome, '.claude', 'projects', proj);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), '{}\n', 'utf8');
}

const WORKERS = {
  'worker-1': { id: 'worker-1', name: 'Worker One', archived: false, vacation: false },
  'worker-2': { id: 'worker-2', name: 'Worker Two', archived: false, vacation: false },
};

// ─── hive-card status blocked: the provenance stamp ──────────────────────────

test('status blocked stamps blockedBy=$AGENT_ID and --why becomes blockedWhy', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const id = s
    .runCard(['add', '--title', 'Wait card', '--status', 'todo'], { AGENT_ID: 'worker-1' })
    .stdout.trim();

  const r = s.runCard(['status', id, 'blocked', '--why', 'waiting on the restart window'], {
    AGENT_ID: 'worker-1',
  });
  assert.equal(r.code, 0, `blocked flip lands: ${r.stderr}`);
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.status, 'blocked');
  assert.equal(card.blockedBy, 'worker-1', 'the stamp records WHO the card waits on');
  assert.equal(card.blockedWhy, 'waiting on the restart window');

  // --why=<v> spelling works too.
  const r2 = s.runCard(['status', id, 'blocked', '--why=restart moved'], { AGENT_ID: 'worker-1' });
  assert.equal(r2.code, 0, `--why= spelling lands: ${r2.stderr}`);
  assert.equal(s.tasks().find((c) => c.id === id).blockedWhy, 'restart moved');
});

test('status blocked without --why leaves no stale blockedWhy', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const id = s
    .runCard(['add', '--title', 'Wait card', '--status', 'todo'], { AGENT_ID: 'worker-1' })
    .stdout.trim();
  s.runCard(['status', id, 'blocked', '--why', 'first reason'], { AGENT_ID: 'worker-1' });
  s.runCard(['status', id, 'todo'], { AGENT_ID: 'worker-1' });
  s.runCard(['status', id, 'blocked'], { AGENT_ID: 'worker-1' });
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.blockedBy, 'worker-1');
  assert.equal(card.blockedWhy, undefined, 'a new blocked flip without --why starts clean');
});

test('status blocked refuses without AGENT_ID — no stamp, no block', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const id = s
    .runCard(['add', '--title', 'Wait card', '--status', 'todo'], { AGENT_ID: 'worker-1' })
    .stdout.trim();
  const before = fs.readFileSync(s.tasksPath, 'utf8');
  const noAgentEnv = { ...s.env };
  delete noAgentEnv.AGENT_ID;
  const r = execFileSyncSafe(
    process.execPath,
    [path.join(s.root, 'bin', 'hive-card'), 'status', id, 'blocked'],
    {
      env: noAgentEnv,
      encoding: 'utf8',
    },
  );
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /AGENT_ID/);
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched');
});

test('--why applies only to status blocked', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const id = s
    .runCard(['add', '--title', 'Wait card', '--status', 'todo'], { AGENT_ID: 'worker-1' })
    .stdout.trim();
  const r = s.runCard(['status', id, 'doing', '--why', 'because'], { AGENT_ID: 'worker-1' });
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /--why.*blocked/i);
  assert.equal(s.tasks().find((c) => c.id === id).status, 'todo', 'not flipped');
});

test('leaving blocked clears blockedBy/blockedWhy — provenance belongs to the wait', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const id = s
    .runCard(['add', '--title', 'Wait card', '--status', 'todo'], { AGENT_ID: 'worker-1' })
    .stdout.trim();
  s.runCard(['status', id, 'blocked', '--why', 'a wait'], { AGENT_ID: 'worker-1' });
  const r = s.runCard(['status', id, 'doing'], { AGENT_ID: 'worker-1' });
  assert.equal(r.code, 0, 'blocked->doing stays legal (the documented resume flow)');
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.status, 'doing');
  assert.equal(card.blockedBy, undefined);
  assert.equal(card.blockedWhy, undefined);
});

test('hive-card ask stamps blockedBy=human-ask', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const id = s
    .runCard(['add', '--title', 'Ask card', '--status', 'doing'], { AGENT_ID: 'worker-1' })
    .stdout.trim();
  const r = s.runCard(['ask', id, '--q', 'Ship A or B?'], { AGENT_ID: 'worker-1' });
  assert.equal(r.code, 0, `ask lands: ${r.stderr}`);
  const card = s.tasks().find((c) => c.id === id);
  assert.equal(card.status, 'blocked');
  assert.equal(card.blockedBy, 'human-ask');
  assert.equal(card.blockedWhy, undefined);
});

// ─── the dispatch gate: owner-resume exception, split wordings ──────────────

function blockedOwnerCard(sid) {
  return {
    id: 'agent-waiting-card-2026-08-19',
    title: 'Waiting on a restart window',
    status: 'blocked',
    assignee: 'worker-1',
    sessionId: sid,
    blockedBy: 'worker-1',
    blockedWhy: 'waiting on the restart window',
    dependsOn: [],
    priority: 3,
    createdAt: '2026-08-19T00:00:00.000Z',
    origin: 'agent',
  };
}

test("the recorded owner's --resume return sails through the gate", { skip: !POSIX }, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const sid = 'f68d69ae-c2ac-4d4d-ae63-b244fff90453';
  plantClaudeSession(s.env.HOME, sid);
  s.hive.writeTasks([blockedOwnerCard(sid)]);

  const r = s.runDispatch([
    '--card',
    'agent-waiting-card-2026-08-19',
    '--assignee',
    'worker-1',
    '--resume',
    '--body',
    'the window is open — continue',
  ]);
  assert.equal(r.code, 0, `owner resume lands: ${r.stderr}`);
  const card = s.tasks().find((c) => c.id === 'agent-waiting-card-2026-08-19');
  assert.equal(card.status, 'doing');
  assert.equal(card.sessionMode, 'resume');
  assert.equal(card.sessionId, sid, 'the stored conversation is preserved');
  assert.equal(card.blockedBy, undefined, 'provenance is cleared with the wait');
  assert.equal(card.blockedWhy, undefined);
  assert.equal(s.outboxMails().length, 1, 'contract mail queued');
});

test('--resume by a DIFFERENT agent is refused — the wait is not theirs', { skip: !POSIX }, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const sid = 'f68d69ae-c2ac-4d4d-ae63-b244fff90454';
  plantClaudeSession(s.env.HOME, sid);
  s.hive.writeTasks([blockedOwnerCard(sid)]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const r = s.runDispatch([
    '--card',
    'agent-waiting-card-2026-08-19',
    '--assignee',
    'worker-2',
    '--resume',
    '--body',
    'c',
  ]);
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /waiting on "worker-1"/, 'refusal names who the card waits on');
  assert.match(r.stderr, /waiting on the restart window/, 'refusal quotes blockedWhy');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger byte-identical');
});

test('a fresh dispatch onto an agent-waiting blocked card is refused — resume only', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([blockedOwnerCard('f68d69ae-c2ac-4d4d-ae63-b244fff90455')]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const r = s.runDispatch([
    '--card',
    'agent-waiting-card-2026-08-19',
    '--assignee',
    'worker-1',
    '--body',
    'c',
  ]);
  assert.notEqual(r.code, 0, 'refused without --resume');
  assert.match(r.stderr, /waiting on "worker-1"/);
  assert.match(r.stderr, /--resume/, 'refusal points at the sanctioned return');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger byte-identical');
});

test('blockedBy stamped by SOMEONE ELSE: refusal names them and the unblock path', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const card = blockedOwnerCard('f68d69ae-c2ac-4d4d-ae63-b244fff90456');
  card.blockedBy = 'god'; // god blocked the worker's card — provenance ≠ owner
  delete card.blockedWhy;
  s.hive.writeTasks([card]);

  const r = s.runDispatch([
    '--card',
    'agent-waiting-card-2026-08-19',
    '--assignee',
    'worker-1',
    '--resume',
    '--body',
    'c',
  ]);
  assert.notEqual(r.code, 0, 'refused — only blockedBy === assignee === target passes');
  assert.match(r.stderr, /waiting on "god"/);
  assert.match(r.stderr, /hive-card status/, 'refusal names the unblock path');
});

test('human-ask refusal quotes the OPEN question (the one the ASK ME board shows)', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-asked-card-2026-08-19',
      title: 'Waiting on the human',
      status: 'blocked',
      assignee: 'worker-1',
      sessionId: 'f68d69ae-c2ac-4d4d-ae63-b244fff90457',
      blockedBy: 'human-ask',
      humanQA: [
        { q: 'Third ask', askedAt: '2026-08-19T00:00:00.000Z' },
        { q: 'Second ask', askedAt: '2026-08-19T00:00:01.000Z' },
        // asked FIRST (entries land reversed), already answered:
        { q: 'First ask', a: 'take A', askedAt: '2026-08-19T00:00:02.000Z' },
      ],
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  for (const args of [
    ['--card', 'agent-asked-card-2026-08-19', '--assignee', 'worker-1', '--body', 'c'],
    ['--card', 'agent-asked-card-2026-08-19', '--assignee', 'worker-1', '--resume', '--body', 'c'],
  ]) {
    const r = s.runDispatch(args);
    assert.notEqual(r.code, 0, `refused: ${args.join(' ')}`);
    assert.match(r.stderr, /WAITING ON THE HUMAN/, 'refusal names the kind');
    assert.match(
      r.stderr,
      /"Second ask"/,
      'quotes the next unanswered question, not the answered one',
    );
    assert.doesNotMatch(r.stderr, /"First ask"|"Third ask"/);
  }
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger byte-identical');
});

test('legacy blocked card with NO blockedBy fails closed — today, and with --resume', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-legacy-blocked-2026-08-19',
      title: 'Blocked before provenance existed',
      status: 'blocked',
      assignee: 'worker-1',
      sessionId: 'f68d69ae-c2ac-4d4d-ae63-b244fff90458',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  for (const args of [
    ['--card', 'agent-legacy-blocked-2026-08-19', '--assignee', 'worker-1', '--body', 'c'],
    [
      '--card',
      'agent-legacy-blocked-2026-08-19',
      '--assignee',
      'worker-1',
      '--resume',
      '--body',
      'c',
    ],
  ]) {
    const r = s.runDispatch(args);
    assert.notEqual(r.code, 0, `refused: ${args.join(' ')}`);
    assert.match(r.stderr, /wait on the operator/i, 'keeps today\u2019s wording verbatim');
  }
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger byte-identical');
});

test('paused is checked FIRST and stays absolute — a provenance stamp never loosens it', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const card = blockedOwnerCard('f68d69ae-c2ac-4d4d-ae63-b244fff90459');
  card.paused = true; // operator hold ON TOP of a provenance-stamped block
  s.hive.writeTasks([card]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const r = s.runDispatch([
    '--card',
    'agent-waiting-card-2026-08-19',
    '--assignee',
    'worker-1',
    '--resume',
    '--body',
    'c',
  ]);
  assert.notEqual(r.code, 0, 'refused even for the recorded owner resume');
  assert.match(r.stderr, /paused:true/, 'the paused wording wins');
  assert.match(r.stderr, /no override/i);
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger byte-identical');
});
