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

function setup(t, { agentId = 'god', userHome } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-dispatch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  const cli = path.join(root, 'bin', 'hive-dispatch');
  const tasksPath = path.join(root, 'tasks.json');
  // Every test gets an isolated $HOME so the claude-session existence check
  // (--resume) never sees the developer's real ~/.claude/projects.
  const isolatedHome = userHome ?? fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-dispatch-home-'));
  t.after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HIVE_ROOT: root,
    AGENT_ID: agentId,
    HOME: isolatedHome,
  };
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

// ─── --resume: return an agent to a card's stored conversation ────────────────
// (card agent-hive-dispatch-blocked-ca-2026-08-19). The stamp already exists;
// this mode makes it REACHABLE again — and refuses rather than silently
// degrading to a fresh clear, which would wipe the pane's current work.

/** Plant a claude session transcript under $HOME/.claude/projects/<proj>/. */
function plantClaudeSession(userHome, sid, proj = '-opt-somewhere') {
  const dir = path.join(userHome, '.claude', 'projects', proj);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), '{}\n', 'utf8');
}

test('--resume: flips doing, stamps sessionMode resume, keeps the sessionId, mails the contract', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const sid = 'f68d69ae-c2ac-4d4d-ae63-b244fff90453';
  plantClaudeSession(s.env.HOME, sid);
  s.hive.writeTasks([
    {
      id: 'agent-stamped-card-2026-08-18',
      title: 'Was blocked, now back',
      status: 'todo',
      assignee: 'worker-1',
      sessionId: sid,
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'agent',
    },
  ]);

  const r = s.run(
    '--card',
    'agent-stamped-card-2026-08-18',
    '--assignee',
    'worker-1',
    '--resume',
    '--body',
    'continue the ticket',
  );
  assert.equal(r.code, 0, 'accepted');
  const card = s.tasks().find((c) => c.id === 'agent-stamped-card-2026-08-18');
  assert.equal(card.status, 'doing');
  assert.equal(card.assignee, 'worker-1');
  assert.equal(card.sessionMode, 'resume', 'the resume mode is stamped for the watcher/audit');
  assert.equal(card.sessionId, sid, 'the stored conversation id is PRESERVED, never restamped');
  assert.equal(s.outboxMails().length, 1, 'contract mail queued on the card conversation');
});

test('--resume refuses when the card carries no sessionId — never a silent fresh fallback', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-unstamped-card-2026-08-19',
      title: 'Never ran',
      status: 'todo',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'human',
    },
  ]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const r = s.run(
    '--card',
    'agent-unstamped-card-2026-08-19',
    '--assignee',
    'worker-1',
    '--resume',
    '--body',
    'c',
  );
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /no sessionId|carries no sessionId/i, 'refusal names the missing stamp');
  assert.match(r.stderr, /wipe|fresh/i, 'refusal says why it will not fall back to fresh');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched');
  assert.deepEqual(s.outboxMails(), [], 'no mail queued');
});

test('--resume refuses when the stored session is gone from disk', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-gone-session-2026-08-19',
      title: 'Old stamp, dead session',
      status: 'todo',
      assignee: 'worker-1',
      sessionId: '00000000-0000-4000-8000-000000000000',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const r = s.run(
    '--card',
    'agent-gone-session-2026-08-19',
    '--assignee',
    'worker-1',
    '--resume',
    '--body',
    'c',
  );
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /gone|no longer|not found/i, 'refusal says the session is gone');
  assert.match(
    r.stderr,
    /00000000-0000-4000-8000-000000000000/,
    'refusal names the dead session id',
  );
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched');
  assert.deepEqual(s.outboxMails(), [], 'no mail queued');
});

test('--resume needs --card (a --title card is new — nothing stored to resume)', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const r = s.run('--title', 'Brand new', '--assignee', 'worker-1', '--resume', '--body', 'c');
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /--resume.*--card|--card.*--resume/, 'error pairs the flag with --card');
  assert.deepEqual(s.outboxMails(), [], 'no mail queued');
});

test('--adopt and --resume are mutually exclusive', { skip: !POSIX }, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const sid = '11111111-2222-4333-8444-555555555555';
  plantClaudeSession(s.env.HOME, sid);
  s.hive.writeTasks([
    {
      id: 'agent-both-flags-2026-08-19',
      title: 'T',
      status: 'todo',
      assignee: 'worker-1',
      sessionId: sid,
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const r = s.run(
    '--card',
    'agent-both-flags-2026-08-19',
    '--assignee',
    'worker-1',
    '--adopt',
    '--resume',
    '--body',
    'c',
  );
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /adopt.*resume|resume.*adopt/, 'error names both flags');
});

test('plain re-dispatch clears a stale sessionMode — a leftover adopt must not hijack the flip', {
  skip: !POSIX,
}, (t) => {
  // Regression shape of the live card agent-sst-ticket-3110: dispatched --adopt
  // once, then blocked; the 'adopt' mode SURVIVED (nothing consumed it), so a
  // plain re-dispatch would adopt whatever conversation is currently live
  // instead of resuming the card's stamp.
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const sid = 'f68d69ae-c2ac-4d4d-ae63-b244fff90453';
  plantClaudeSession(s.env.HOME, sid);
  s.hive.writeTasks([
    {
      id: 'agent-stale-adopt-2026-08-18',
      title: 'Stale adopt',
      status: 'todo',
      assignee: 'worker-1',
      sessionId: sid,
      sessionMode: 'adopt',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const r = s.run(
    '--card',
    'agent-stale-adopt-2026-08-18',
    '--assignee',
    'worker-1',
    '--body',
    'c',
  );
  assert.equal(r.code, 0);
  const card = s.tasks().find((c) => c.id === 'agent-stale-adopt-2026-08-18');
  assert.equal(card.sessionMode, undefined, 'stale mode cleared — fresh default, no adopt hijack');
  assert.equal(card.sessionId, sid, 'stamp preserved for the watcher resume');
});

test("--resume session store is provider-aware: pi and codex check the agent's own sessions tree", {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry({
    'pi-worker': {
      id: 'pi-worker',
      name: 'Pi One',
      archived: false,
      vacation: false,
      provider: 'pi',
    },
    'codex-worker': {
      id: 'codex-worker',
      name: 'Codex One',
      archived: false,
      vacation: false,
      provider: 'codex',
    },
  });
  const piSid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const piSessions = path.join(s.root, 'agents', 'pi-worker', '.pi-agent', 'sessions');
  fs.mkdirSync(piSessions, { recursive: true });
  fs.writeFileSync(path.join(piSessions, `20260819T10-00-00_${piSid}.jsonl`), '{}\n');
  const cxSid = '11112222-3333-4444-8555-666666666666';
  const cxSessions = path.join(
    s.root,
    'agents',
    'codex-worker',
    '.codex',
    'sessions',
    '2026',
    '08',
  );
  fs.mkdirSync(cxSessions, { recursive: true });
  fs.writeFileSync(path.join(cxSessions, `rollout-2026-08-19T10-00-00-${cxSid}.jsonl`), '{}\n');

  s.hive.writeTasks([
    {
      id: 'agent-pi-card-2026-08-19',
      title: 'Pi card',
      status: 'todo',
      assignee: 'pi-worker',
      sessionId: piSid,
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'agent',
    },
    {
      id: 'agent-cx-gone-card-2026-08-19',
      title: 'Codex dead stamp',
      status: 'todo',
      assignee: 'codex-worker',
      sessionId: '99999999-9999-4999-8999-999999999999',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'agent',
    },
  ]);

  const pi = s.run(
    '--card',
    'agent-pi-card-2026-08-19',
    '--assignee',
    'pi-worker',
    '--resume',
    '--body',
    'c',
  );
  assert.equal(pi.code, 0, 'pi: the <ts>_<sid>.jsonl file in the agent tree satisfies the check');
  assert.equal(s.tasks().find((c) => c.id === 'agent-pi-card-2026-08-19').sessionMode, 'resume');

  const cx = s.run(
    '--card',
    'agent-cx-gone-card-2026-08-19',
    '--assignee',
    'codex-worker',
    '--resume',
    '--body',
    'c',
  );
  assert.notEqual(cx.code, 0, 'codex: a stamp with no rollout file on disk is refused');
  assert.match(cx.stderr, /gone|no longer|not found/i);
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

test('a BLOCKED card does NOT occupy its assignee — the dispatch lands, the blocked card is untouched', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-blocked-eng-2026-08-18',
      title: 'Waiting on the customer',
      status: 'blocked',
      assignee: 'worker-1',
      sessionId: 'f68d69ae-c2ac-4d4d-ae63-b244fff90453',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'agent',
    },
  ]);

  const r = s.run('--title', 'New work meanwhile', '--assignee', 'worker-1', '--body', 'c');
  assert.equal(r.code, 0, 'a blocked card waits on someone else — its owner is dispatchable');

  const blocked = s.tasks().find((c) => c.id === 'agent-blocked-eng-2026-08-18');
  assert.equal(blocked.status, 'blocked', 'blocked card keeps its status');
  assert.equal(blocked.assignee, 'worker-1', 'blocked card KEEPS its assignee (who-did-what)');
  assert.equal(
    blocked.sessionId,
    'f68d69ae-c2ac-4d4d-ae63-b244fff90453',
    'blocked card keeps its conversation stamp for the later --resume',
  );
});

test('a DOING card still occupies its assignee (only doing counts as busy)', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-doing-eng-2026-08-18',
      title: 'D',
      status: 'doing',
      assignee: 'worker-1',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'agent',
    },
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
  assert.notEqual(r.code, 0, 'the doing card still refuses');
  assert.match(r.stderr, /agent-doing-eng-2026-08-18/, 'refusal names the DOING card');
  assert.doesNotMatch(r.stderr, /agent-blocked-eng/, 'the blocked card is not the blocker');
});

test('refuses a PAUSED target card — names the hold, tells god to ask the operator, writes nothing', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-held-card-2026-08-18',
      title: 'Held by the operator',
      status: 'todo',
      paused: true,
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'human',
    },
  ]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const r = s.run('--card', 'agent-held-card-2026-08-18', '--assignee', 'worker-1', '--body', 'c');
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /paused:true/, 'refusal names the flag');
  assert.match(r.stderr, /operator/i, 'refusal points at the operator, not a retry');
  assert.match(r.stderr, /no override/i, 'refusal says there is no override to reach for');
  assert.doesNotMatch(r.stderr, /retry|try again|later/i, 'must not read as transient');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger byte-identical');
  assert.deepEqual(s.outboxMails(), [], 'no mail queued');
  assert.deepEqual(s.recallRequests(), [], 'no recall queued');
});

test('refuses a BLOCKED target card — same gate, writes nothing', { skip: !POSIX }, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-blocked-target-2026-08-18',
      title: 'Waiting on the operator',
      status: 'blocked',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'human',
    },
  ]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const r = s.run(
    '--card',
    'agent-blocked-target-2026-08-18',
    '--assignee',
    'worker-1',
    '--body',
    'c',
  );
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /blocked/, 'refusal names the status');
  assert.match(r.stderr, /operator/i, 'refusal points at the operator, not a retry');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger byte-identical');
  assert.deepEqual(s.outboxMails(), [], 'no mail queued');
});

test('an UNPAUSED todo card still dispatches (the gate is the flag, not the todo status)', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-free-card-2026-08-18',
      title: 'Free to dispatch',
      status: 'todo',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-18T00:00:00.000Z',
      origin: 'human',
    },
  ]);
  const r = s.run('--card', 'agent-free-card-2026-08-18', '--assignee', 'worker-1', '--body', 'c');
  assert.equal(r.code, 0, 'an unheld todo card dispatches normally');
  assert.equal(s.tasks().find((c) => c.id === 'agent-free-card-2026-08-18').status, 'doing');
});

// ─── the nomination guard (card agent-hive-dispatch-nomination-2026-08-19) ───
// A todo that already carries an assignee is NOMINATED, not free capacity.
// Before this guard, hive-dispatch set card.assignee unconditionally, so a
// saturation round-robin over the actionable line could silently overwrite a
// standing nomination. The guard refuses a DIFFERENT assignee without writing,
// names the nominee, and points at the deliberate two-step reassignment
// (hive-card update --assignee, then dispatch). Same-assignee and unassigned
// cards sail through; a mode flag (--adopt/--resume) is no licence to steal.

test('nomination guard: refuses a DIFFERENT assignee over a nominated card, names the nominee, writes nothing', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-nominated-card-2026-08-19',
      title: 'Creed is nominated',
      status: 'todo',
      assignee: 'creed-msx8l6ju',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'human',
    },
  ]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');

  const r = s.run(
    '--card',
    'agent-nominated-card-2026-08-19',
    '--assignee',
    'worker-1',
    '--body',
    'c',
  );
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /creed-msx8l6ju/, 'refusal names the standing nominee');
  assert.match(r.stderr, /worker-1/, 'refusal names the would-be assignee');
  assert.match(r.stderr, /hive-card update/, 'refusal points at the documented reassignment path');
  assert.match(r.stderr, /--assignee/, 'refusal names the --assignee step');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger byte-identical');
  assert.deepEqual(s.outboxMails(), [], 'no mail queued');
  assert.equal(
    s.tasks().find((c) => c.id === 'agent-nominated-card-2026-08-19').assignee,
    'creed-msx8l6ju',
    'nominee untouched',
  );
});

test('nomination guard: re-dispatching the SAME assignee sails through (a return, not a steal)', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-same-nominee-2026-08-19',
      title: 'Same owner returns',
      status: 'todo',
      assignee: 'worker-1',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const r = s.run(
    '--card',
    'agent-same-nominee-2026-08-19',
    '--assignee',
    'worker-1',
    '--body',
    'c',
  );
  assert.equal(r.code, 0, 'same assignee is not a mismatch');
  assert.equal(s.tasks().find((c) => c.id === 'agent-same-nominee-2026-08-19').status, 'doing');
});

test('nomination guard: an unassigned or whitespace-only assignee dispatches — nothing to overwrite', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry({
    'worker-1': { id: 'worker-1', name: 'Worker One', archived: false, vacation: false },
    'worker-2': { id: 'worker-2', name: 'Worker Two', archived: false, vacation: false },
  });
  s.hive.writeTasks([
    {
      id: 'agent-unassigned-2026-08-19',
      title: 'No nominee',
      status: 'todo',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'human',
    },
    {
      id: 'agent-ws-nominee-2026-08-19',
      title: 'Whitespace-only nominee counts as unassigned',
      status: 'todo',
      assignee: '   ',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'human',
    },
  ]);
  const r1 = s.run(
    '--card',
    'agent-unassigned-2026-08-19',
    '--assignee',
    'worker-1',
    '--body',
    'c',
  );
  assert.equal(r1.code, 0, 'no assignee: nothing to overwrite');
  const r2 = s.run(
    '--card',
    'agent-ws-nominee-2026-08-19',
    '--assignee',
    'worker-2',
    '--body',
    'c',
  );
  assert.equal(r2.code, 0, 'whitespace-only assignee reads as empty: dispatchable');
});

test('nomination guard: hive-card update --assignee then dispatch — the documented deliberate reassignment', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  s.hive.writeTasks([
    {
      id: 'agent-reassign-2026-08-19',
      title: 'Deliberate handoff',
      status: 'todo',
      assignee: 'creed-msx8l6ju',
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'human',
    },
  ]);
  const { execFileSync } = require('node:child_process');
  // Step 1: the direct dispatch is refused — still nominated to creed.
  const refused = s.run(
    '--card',
    'agent-reassign-2026-08-19',
    '--assignee',
    'worker-1',
    '--body',
    'c',
  );
  assert.notEqual(refused.code, 0, 'guard holds before the reassignment');
  // Step 2: deliberately move the nomination via hive-card update.
  execFileSync(
    path.join(s.root, 'bin', 'hive-card'),
    ['update', 'agent-reassign-2026-08-19', '--assignee', 'worker-1'],
    { env: s.env, encoding: 'utf8' },
  );
  assert.equal(
    s.tasks().find((c) => c.id === 'agent-reassign-2026-08-19').assignee,
    'worker-1',
    'update moved the nomination',
  );
  // Step 3: now the dispatch lands — nomination and assignee agree.
  const r = s.run('--card', 'agent-reassign-2026-08-19', '--assignee', 'worker-1', '--body', 'c');
  assert.equal(r.code, 0, 'dispatch succeeds after the deliberate reassignment');
  assert.equal(s.tasks().find((c) => c.id === 'agent-reassign-2026-08-19').status, 'doing');
});

test('nomination guard: fires on --resume too — a mode flag is no licence to overwrite', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.writeRegistry(WORKERS);
  const sid = 'f68d69ae-c2ac-4d4d-ae63-b244fff90453';
  plantClaudeSession(s.env.HOME, sid);
  s.hive.writeTasks([
    {
      id: 'agent-nominated-resume-2026-08-19',
      title: 'Nominated, stamped',
      status: 'todo',
      assignee: 'creed-msx8l6ju',
      sessionId: sid,
      dependsOn: [],
      priority: 3,
      createdAt: '2026-08-19T00:00:00.000Z',
      origin: 'agent',
    },
  ]);
  const before = fs.readFileSync(s.tasksPath, 'utf8');
  const r = s.run(
    '--card',
    'agent-nominated-resume-2026-08-19',
    '--assignee',
    'worker-1',
    '--resume',
    '--body',
    'c',
  );
  assert.notEqual(r.code, 0, 'guard fires even in --resume mode');
  assert.match(r.stderr, /creed-msx8l6ju/, 'refusal names the standing nominee');
  assert.equal(fs.readFileSync(s.tasksPath, 'utf8'), before, 'ledger untouched');
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
