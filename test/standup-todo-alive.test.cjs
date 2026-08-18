'use strict';

/**
 * todo-keeps-standup-alive (card agent-every-non-paused-todo-ke-2026-08-18).
 *
 * Operator decision (Stefan): EVERY non-paused todo keeps the hourly standup
 * alive; reference-only cards get a one-click on-hold (paused) flag so they
 * stop counting. Design + binding amendments from Robert's review — pinned
 * here:
 *   A: Stefan's predicate VERBATIM (any non-paused todo ⇒ not quiet); the nag
 *      is fixed in the CLERK — age gate at STALLED_SEC + once-only dedup per
 *      card id, persisted on the mission config, dedup restricted to the new
 *      kind.
 *   B: anomaly kind 'todo-unattended': skips dep-waiting todos, covers
 *      unassigned AND assigned-idle in one kind, age-gated.
 *   C: godLine's quiet-floor sentence + sibling doc contracts updated.
 *   D: the ->doing flip and paused — SUPERSEDED by card
 *      agent-hive-dispatch-must-be-th-2026-08-18: both CLIs REFUSE the doing
 *      flip on a paused card (the operator hold, checked in the primitive);
 *      the two operator-facing writers (overlay updateTaskStatus,
 *      execUpdateTask) keep the auto-resume — the operator is the unpause
 *      authority.
 *   E: pause toggle ON THE CARD FACE (one click), overlay toggle secondary.
 *   F: the four reference cards' pausing is god's data step — NOT here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { detectAnomalies, STALLED_SEC, ledgerDisqualifiesQuiet } = loadTs('src/main/standup.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const OLD = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString();
const AGENT = (id, lastActiveSecAgo) => ({
  id,
  name: id,
  breaker: 'healthy',
  lastActiveSecAgo,
});

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-todo-alive-'));
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

// ——— A1: the quiet predicate (Stefan's, verbatim) ————————————————————————

test('ledgerDisqualifiesQuiet: a NON-PAUSED todo keeps the floor non-quiet (the operator decision)', () => {
  const todo = (x) => ({ tasks: [{ id: 'c', title: 't', status: 'todo', ...x }] });
  assert.equal(ledgerDisqualifiesQuiet(todo({})), true, 'plain todo ⇒ NOT quiet');
  assert.equal(
    ledgerDisqualifiesQuiet(todo({ assignee: 'someone' })),
    true,
    'assigned todo too — EVERY todo counts',
  );
  assert.equal(ledgerDisqualifiesQuiet(todo({ origin: 'agent' })), true, 'agent-origin todo too');
  assert.equal(
    ledgerDisqualifiesQuiet(todo({ paused: true })),
    false,
    'paused todo alone ⇒ quiet (the release valve)',
  );
});

test('ledgerDisqualifiesQuiet: doing/blocked still disqualify; paused consulted only for todo', () => {
  assert.equal(
    ledgerDisqualifiesQuiet({ tasks: [{ id: 'c', status: 'doing', paused: true }] }),
    true,
  );
  assert.equal(
    ledgerDisqualifiesQuiet({ tasks: [{ id: 'c', status: 'blocked', paused: true }] }),
    true,
  );
  assert.equal(ledgerDisqualifiesQuiet({ tasks: [{ id: 'c', status: 'done' }] }), false);
});

test('ledgerDisqualifiesQuiet: garbage fails toward NOT quiet (fire, never skip on a guess)', () => {
  assert.equal(ledgerDisqualifiesQuiet(null), true);
  assert.equal(ledgerDisqualifiesQuiet({ tasks: 'nonsense' }), true);
  assert.equal(ledgerDisqualifiesQuiet({ tasks: [{ no: 'status' }] }), true);
});

test('floorQuietSince consults the shared predicate (single source of truth)', () => {
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes('ledgerDisqualifiesQuiet(t)'), 'index.ts routes through it');
});

// ——— A2 + B: the todo-unattended anomaly, age-gated, dep-skipping —————————

test('todo-unattended: unassigned old todo escalates', () => {
  const out = detectAnomalies(
    { agents: [AGENT('a1', 60)] },
    { tasks: [{ id: 'c1', title: 'x', status: 'todo', createdAt: OLD(STALLED_SEC + 60) }] },
    {},
  );
  assert.equal(out.filter((a) => a.kind === 'todo-unattended').length, 1);
});

test('todo-unattended: assigned-but-idle todo escalates (dispatch never happened)', () => {
  const out = detectAnomalies(
    { agents: [AGENT('dwight', 999_999)] },
    {
      tasks: [
        {
          id: 'c1',
          title: 'x',
          status: 'todo',
          assignee: 'dwight',
          createdAt: OLD(STALLED_SEC + 60),
        },
      ],
    },
    {},
  );
  assert.equal(out.filter((a) => a.kind === 'todo-unattended').length, 1);
});

test('todo-unattended: young todo is presumed mid-dispatch — no anomaly', () => {
  const out = detectAnomalies(
    { agents: [AGENT('a1', 60)] },
    { tasks: [{ id: 'c1', title: 'x', status: 'todo', createdAt: OLD(120) }] },
    {},
  );
  assert.equal(out.filter((a) => a.kind === 'todo-unattended').length, 0);
});

test('todo-unattended: missing createdAt cannot prove young — counts (fail toward surfacing)', () => {
  const out = detectAnomalies(
    { agents: [AGENT('a1', 60)] },
    { tasks: [{ id: 'c1', title: 'x', status: 'todo' }] },
    {},
  );
  assert.equal(out.filter((a) => a.kind === 'todo-unattended').length, 1);
});

test('todo-unattended: paused todo never escalates', () => {
  const out = detectAnomalies(
    { agents: [AGENT('a1', 60)] },
    { tasks: [{ id: 'c1', title: 'x', status: 'todo', paused: true, createdAt: OLD(999_999) }] },
    {},
  );
  assert.equal(out.filter((a) => a.kind === 'todo-unattended').length, 0);
});

test('todo-unattended: dep-waiting todo is correctly waiting, not unattended', () => {
  const tasks = {
    tasks: [
      { id: 'c1', title: 'x', status: 'todo', createdAt: OLD(999_999), dependsOn: ['c2'] },
      { id: 'c2', title: 'dep', status: 'doing' },
    ],
  };
  const out = detectAnomalies({ agents: [AGENT('a1', 60)] }, tasks, {});
  assert.equal(
    out.filter((a) => a.kind === 'todo-unattended').some((a) => a.subject === 'c1'),
    false,
    'c1 waits on c2',
  );
  // met dependency (dep done) → counts again
  const met = { tasks: tasks.tasks.map((t) => (t.id === 'c2' ? { ...t, status: 'done' } : t)) };
  const out2 = detectAnomalies({ agents: [AGENT('a1', 60)] }, met, {});
  assert.equal(
    out2.filter((a) => a.kind === 'todo-unattended').some((a) => a.subject === 'c1'),
    true,
  );
});

test('todo-unattended: assignee ACTIVE now → no anomaly (dispatch is happening)', () => {
  const out = detectAnomalies(
    { agents: [AGENT('pam', 30)] },
    { tasks: [{ id: 'c1', title: 'x', status: 'todo', assignee: 'pam', createdAt: OLD(999_999) }] },
    {},
  );
  assert.equal(out.filter((a) => a.kind === 'todo-unattended').length, 0);
});

// ——— A2: dedup — once per card id, restricted to the new kind ————————————

test('dedup: a todo escalated at the previous standup is silent this standup', () => {
  const fleet = { agents: [AGENT('a1', 60)] };
  const tasks = { tasks: [{ id: 'c1', title: 'x', status: 'todo', createdAt: OLD(999_999) }] };
  const first = detectAnomalies(fleet, tasks, {}, undefined, []);
  assert.equal(first.length, 1);
  const second = detectAnomalies(fleet, tasks, {}, undefined, ['c1']);
  assert.equal(second.length, 0, 'same card, next hour — deduped');
});

test('dedup is restricted to todo-unattended: stalled repeats hourly (repetition is a feature there)', () => {
  const fleet = { agents: [AGENT('owner', 999_999)] };
  const tasks = { tasks: [{ id: 'c1', title: 'x', status: 'doing', assignee: 'owner' }] };
  const first = detectAnomalies(fleet, tasks, {}, undefined, ['owner']);
  assert.equal(
    first.some((a) => a.kind === 'stalled'),
    true,
    'stalled fires even with its id in the dedup set',
  );
  const second = detectAnomalies(fleet, tasks, {}, undefined, ['owner', 'c1']);
  assert.equal(
    second.some((a) => a.kind === 'stalled'),
    true,
    'stalled is never deduped',
  );
});

// ——— the flag: HiveManager writers ———————————————————————————————————————

test('setTaskPaused sets/clears the flag under the ledger lock, fields intact', async (t) => {
  const { hive, home } = await hiveWithLedger(t, [
    { id: 'c1', title: 'A', status: 'todo', sessionId: 's1' },
  ]);
  assert.equal(hive.setTaskPaused('c1', true), true);
  let card = readLedger(home)[0];
  assert.equal(card.paused, true);
  assert.equal(card.sessionId, 's1');
  assert.equal(hive.setTaskPaused('c1', false), true);
  card = readLedger(home)[0];
  assert.ok(card.paused === undefined || card.paused === false, 'cleared back');
  assert.equal(hive.setTaskPaused('ghost', true), false, 'missing card → false');
});

test('updateTaskStatus -> DOING clears paused (auto-resume; amendment D, writer 2)', async (t) => {
  const { hive, home } = await hiveWithLedger(t, [
    { id: 'c1', title: 'A', status: 'todo', paused: true },
  ]);
  hive.updateTaskStatus('c1', 'doing');
  const card = readLedger(home)[0];
  assert.equal(card.status, 'doing');
  assert.ok(card.paused === undefined || card.paused === false, 'no stale on-hold into doing');
});

test('execUpdateTask -> doing clears paused (amendment D, writer 3)', () => {
  const src = read('src/main/realtimeActions.ts');
  assert.match(
    src,
    /card\.status === 'doing'[\s\S]{0,200}card\.paused/,
    'clears paused on the doing flip',
  );
});

// ——— D (card agent-hive-dispatch-must-be-th-2026-08-18): the doing flip on
// a PAUSED card now REFUSES in both CLIs (hive-card cmdStatus, hive-dispatch)
// — the operator hold lives in the primitive, and the old silent auto-resume
// was exactly the bypass. The two operator-facing writers (overlay
// updateTaskStatus, voice execUpdateTask) keep the auto-resume: the operator
// IS the unpause authority. Amendment D's original three-writer auto-resume
// contract was superseded by this card.

test('hive-card CLI: --paused/--resume on update; status -> doing REFUSES while paused, flips after --resume', (t) => {
  // Runs the REAL generated bin/hive-card (HiveManager.ensureHive). An earlier
  // version regex-scraped the HIVE_CARD_CLI template literal out of hive.ts,
  // but that constant now INTERPOLATES the shared actionableCards functions
  // into itself (card agent-actionablecards-one-shar-2026-08-18) — raw text
  // is no longer valid JS, and the installed CLI is what ships anyway.
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  fs.writeFileSync(
    path.join(root, 'tasks.json'),
    JSON.stringify(
      { tasks: [{ id: 'c1', title: 'A', status: 'todo', createdAt: new Date().toISOString() }] },
      null,
      2,
    ),
  );
  const cliPath = path.join(root, 'bin', 'hive-card');
  assert.match(fs.readFileSync(cliPath, 'utf8'), /--paused/, 'update accepts --paused');
  assert.match(fs.readFileSync(cliPath, 'utf8'), /--resume/, 'update accepts --resume');
  const run = (args) =>
    execFileSync(process.execPath, [cliPath, ...args], {
      env: { ...process.env, HIVE_ROOT: root },
      encoding: 'utf8',
    }).trim();
  run(['update', 'c1', '--paused']);
  let card = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(card.paused, true);
  // held: the doing flip must REFUSE (the primitive checks the flag)
  let refused = false;
  try {
    run(['status', 'c1', 'doing']);
  } catch {
    refused = true;
  }
  assert.ok(refused, 'CLI doing-flip refuses a paused card');
  card = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(card.status, 'todo', 'not flipped while held');
  assert.equal(card.paused, true, 'still on hold');
  // released: the doing flip works and leaves no stale hold behind
  run(['update', 'c1', '--resume']);
  run(['status', 'c1', 'doing']);
  card = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(card.status, 'doing');
  assert.ok(card.paused !== true, 'no stale on-hold flag into doing');
});

// ——— E: the UI — one click on the card face, overlay secondary ———————————

test('card face: pause glyph in the TODO column, one click (amendment E)', () => {
  const src = read('src/renderer/src/components/TasksKanban.tsx');
  assert.match(src, /hiveSetTaskPaused/, 'calls the targeted IPC');
  assert.match(src, /onTogglePaused/, 'card face carries the toggle');
  assert.ok(src.includes('paused'), 'renderer type/parse carries the field');
});

test('overlay: labeled pause toggle as the secondary control', () => {
  const src = read('src/renderer/src/components/TaskDetailOverlay.tsx');
  assert.match(src, /hiveSetTaskPaused/, 'overlay can toggle too');
  assert.match(src, /on hold/i, 'labeled "on hold"');
});

test('IPC + preload expose hiveSetTaskPaused', () => {
  assert.ok(read('src/main/index.ts').includes("'hive:setTaskPaused'"));
  assert.ok(read('src/preload/index.ts').includes('hiveSetTaskPaused'));
});

// ——— A2 persistence + C: mission config + doc contracts ——————————————————

test('ScheduledMission carries escalatedTodos; the clerk passes + persists the set', () => {
  const cfg = read('src/main/config.ts');
  assert.match(cfg, /escalatedTodos/, 'mission schema field');
  const idx = read('src/main/index.ts');
  assert.match(idx, /escalatedTodos/, 'clerk reads/writes the set');
  // The persisted set must be every CURRENTLY qualifying todo id, not just the
  // ones reported this cycle: a suppressed card dropped from the set would be
  // re-escalated on the ALTERNATING hour (nag halved, not removed). Persisting
  // the qualifying set keeps it in the set for the whole episode; it drops out
  // only when it stops qualifying (fixed/paused/dep-waiting), so a relapse
  // escalates again as a NEW episode.
  assert.match(
    idx,
    /detectAnomalies\(([\s\S]{0,160}?)\[\]/,
    'clerk computes the qualifying set with an EMPTY dedup set for persistence',
  );
});

test('godLine + sibling docs teach the NEW quiet predicate (amendment C)', () => {
  const hive = read('src/main/hive.ts');
  assert.match(
    hive,
    /no doing\/blocked cards and no un-paused todo/,
    'godLine: the updated sentence',
  );
  const idx = read('src/main/index.ts');
  assert.match(idx, /non-paused todo/i, 'floorQuietSince docblock updated');
  const st = read('src/main/standup.ts');
  assert.match(st, /non-paused todo/i, 'standup header updated');
});
