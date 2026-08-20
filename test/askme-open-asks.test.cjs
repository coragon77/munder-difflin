'use strict';

/**
 * ASK ME board: switch through ALL open humanQA entries, not just the last
 * (card agent-ask-me-board-switch-thro-2026-08-20, spec
 * docs/superpowers/specs/2026-08-20-ask-me-multi-question.md).
 *
 * The board used to render exactly ONE open entry per card (openQuestion's
 * tail-most walk) — everything else was reachable only serially, newest-batch
 * first. Two behavioral contracts land here:
 *
 *  1. ORDER (openAsks, plain .ts — loadTs-compilable): all OPEN asks, oldest
 *     first. Sort key is LOAD-BEARING: askedAt ASCENDING (missing first),
 *     tiebreak array index DESCENDING — one `hive-card ask` call shares a
 *     single askedAt and stores its --q flags REVERSED, so within a call the
 *     LATER index is the EARLIER ask. This fixes the cross-call inversion
 *     (newest batch surfacing first) without touching the CLI or stored data.
 *  2. PRECISE WRITE TARGET (HiveManager.resolveHumanQuestion + optional
 *     index): when index points at an OPEN entry whose q strictly equals the
 *     question, patch exactly that one — two IDENTICAL open texts become
 *     addressable. Any index mismatch falls back to the tail-first text
 *     match, so a valid text match can never fail on a stale index.
 *
 * The .tsx wiring (AskMeTab draft keys `${taskId}:${index}`) is pinned at the
 * source level — same convention as tasks-tab-field-survival for JSX files.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const { openAsks } = loadTs('src/renderer/src/components/openAsks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

// ─── openAsks ordering ──────────────────────────────────────────────────────

/** humanQA array exactly as three separate `hive-card ask` calls would store
 *  it (cmdAsk pushes each call's --q flags REVERSED, one shared askedAt):
 *    call 1 (t1): --q A --q B   → [B, A]
 *    call 2 (t2): --q C         → append [C]
 *    call 3 (t3): --q D --q E   → append [E, D]
 *  Stored array: [B, A, C, E, D] — the OLD backward walk surfaced E first. */
const threeCallsQA = [
  { q: 'B', askedAt: '2026-08-20T10:00:00.000Z' },
  { q: 'A', askedAt: '2026-08-20T10:00:00.000Z' },
  { q: 'C', askedAt: '2026-08-20T11:00:00.000Z' },
  { q: 'E', askedAt: '2026-08-20T12:00:00.000Z' },
  { q: 'D', askedAt: '2026-08-20T12:00:00.000Z' },
];

test('openAsks orders all open asks oldest-first, in-call order preserved', () => {
  const asks = openAsks({ humanQA: threeCallsQA });
  assert.deepEqual(
    asks.map((o) => o.entry.q),
    ['A', 'B', 'C', 'D', 'E'],
  );
});

test('openAsks carries the stable array index (draft keys, indexed writes)', () => {
  const asks = openAsks({ humanQA: threeCallsQA });
  // indices point INTO the stored array — A is stored at index 1, E at 3.
  assert.deepEqual(
    asks.map((o) => o.index),
    [1, 0, 2, 4, 3],
  );
});

test('openAsks excludes answered and dismissed entries', () => {
  const asks = openAsks({
    humanQA: [
      { q: 'answered', a: 'yes', askedAt: '2026-08-20T10:00:00.000Z' },
      { q: 'dismissed', dismissedAt: '2026-08-20T10:00:00.000Z' },
      { q: 'still open', askedAt: '2026-08-20T11:00:00.000Z' },
    ],
  });
  assert.deepEqual(
    asks.map((o) => o.entry.q),
    ['still open'],
  );
});

test('openAsks sorts entries missing askedAt first (stable via index tiebreak)', () => {
  const asks = openAsks({
    humanQA: [
      { q: 'dated', askedAt: '2026-08-20T10:00:00.000Z' },
      { q: 'legacy-b' }, // no askedAt — legacy hand-written entries
      { q: 'legacy-a' },
    ],
  });
  assert.deepEqual(
    asks.map((o) => o.entry.q),
    ['legacy-a', 'legacy-b', 'dated'],
  );
});

test('openAsks on cards without humanQA is an empty list, not undefined', () => {
  assert.deepEqual(openAsks({}), []);
  assert.deepEqual(openAsks({ humanQA: [] }), []);
});

// ─── resolveHumanQuestion with optional index ───────────────────────────────

function setup(t, tasks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-askme-multi-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureAgent({ id: 'god1', name: 'God', provider: 'claude', cwd: home, isGod: true });
  hive.writeTasks(tasks);
  return { hive, ledger: path.join(home, 'hive', 'tasks.json') };
}

const qa = (ledger, id) =>
  JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks.find((task) => task.id === id).humanQA;

const dupCard = {
  id: 'dup-1',
  title: 'Two identical asks',
  status: 'blocked',
  dependsOn: [],
  priority: 1,
  createdAt: '2026-08-20T00:00:00.000Z',
  humanQA: [
    { q: 'Same text?', askedAt: '2026-08-20T10:00:00.000Z' },
    { q: 'Same text?', askedAt: '2026-08-20T11:00:00.000Z' },
    { q: 'Other ask', askedAt: '2026-08-20T11:30:00.000Z' },
  ],
};

test('resolveHumanQuestion(index) answers EXACTLY the addressed duplicate', (t) => {
  const { hive, ledger } = setup(t, [dupCard]);
  assert.equal(hive.resolveHumanQuestion('dup-1', 'Same text?', 'first one', 0), true);
  const after = qa(ledger, 'dup-1');
  assert.equal(after[0].a, 'first one');
  assert.ok(after[0].answeredAt);
  assert.equal(after[1].a, undefined); // the sibling duplicate stays open
  assert.equal(after[2].a, undefined);
});

test('resolveHumanQuestion(index) dismisses EXACTLY the addressed entry', (t) => {
  const { hive, ledger } = setup(t, [dupCard]);
  assert.equal(hive.resolveHumanQuestion('dup-1', 'Same text?', undefined, 1), true);
  const after = qa(ledger, 'dup-1');
  assert.ok(after[1].dismissedAt);
  assert.equal(after[1].a, undefined); // dismissal never fabricates an answer
  assert.equal(after[0].dismissedAt, undefined);
});

test('resolveHumanQuestion falls back to tail-first text match on a stale index', (t) => {
  const { hive, ledger } = setup(t, [
    {
      ...dupCard,
      humanQA: [
        { q: 'Same text?', a: 'already answered', askedAt: '2026-08-20T10:00:00.000Z' },
        { q: 'Same text?', askedAt: '2026-08-20T11:00:00.000Z' },
      ],
    },
  ]);
  // index 0 is CLOSED — the call must not fail, it falls back to text match.
  assert.equal(hive.resolveHumanQuestion('dup-1', 'Same text?', 'late', 0), true);
  const after = qa(ledger, 'dup-1');
  assert.equal(after[0].a, 'already answered'); // untouched
  assert.equal(after[1].a, 'late');
});

test('resolveHumanQuestion falls back when the indexed q disagrees with the text', (t) => {
  const { hive, ledger } = setup(t, [dupCard]);
  // index 2 holds 'Other ask', not 'Same text?' — mismatch means stale index.
  assert.equal(hive.resolveHumanQuestion('dup-1', 'Same text?', 'via fallback', 2), true);
  const after = qa(ledger, 'dup-1');
  assert.equal(after[1].a, 'via fallback'); // tail-most open text match
  assert.equal(after[0].a, undefined);
  assert.equal(after[2].a, undefined);
});

test('resolveHumanQuestion without index keeps the historical tail-first behavior', (t) => {
  const { hive, ledger } = setup(t, [dupCard]);
  assert.equal(hive.resolveHumanQuestion('dup-1', 'Same text?', 'no index'), true);
  const after = qa(ledger, 'dup-1');
  assert.equal(after[1].a, 'no index');
  assert.equal(after[0].a, undefined);
});

// ─── source-level pins (.tsx / preload wiring — JSX and electron modules
//     are not loadTs-compilable; same convention as field-survival) ─────────

test('AskMeTab drafts are keyed taskId:humanQA-index and writes carry the index', () => {
  const src = read('src/renderer/src/components/AskMeTab.tsx');
  // one draft per open entry — the key must carry the entry index
  assert.match(src, /`\$\{task\.id\}:\$\{o\.index\}`/);
  // answer + dismiss both address the selected entry, not openQuestion()
  assert.doesNotMatch(src, /openQuestion\(/);
  assert.match(
    src,
    /hiveResolveHumanQuestion\(\s*task\.id,\s*o\.entry\.q,\s*text,\s*o\.index,?\s*\)/,
  );
  assert.match(
    src,
    /hiveResolveHumanQuestion\(\s*task\.id,\s*o\.entry\.q,\s*undefined,\s*o\.index,?\s*\)/,
  );
});

test('preload and IPC pass the optional index through with validation', () => {
  const preload = read('src/preload/index.ts');
  assert.match(preload, /hiveResolveHumanQuestion[\s\S]*?index\?: number/);
  assert.match(preload, /'hive:resolveHumanQuestion', id, question, answer, index/);
  const main = read('src/main/index.ts');
  assert.match(main, /'hive:resolveHumanQuestion'[\s\S]*?index/);
  assert.match(main, /Number\.isInteger/);
});

// ─── Stefan's literal acceptance scenario, exercised against a REAL ledger ──
// ('answer question 3/8 first'): the day's actual write pattern is many
// single-ask calls, so 8 calls land in chronological array order. Each check
// below drives the exact call sequence AskMeTab makes — resolveHumanQuestion
// (id, q, text, index) on a fresh locked ledger read — never a source read.

/** 8 single-ask calls at ascending times → array in call order. */
function eightAsksCard() {
  return {
    id: 'eight-1',
    title: 'Eight open asks',
    status: 'blocked',
    dependsOn: [],
    priority: 1,
    createdAt: '2026-08-20T00:00:00.000Z',
    humanQA: Array.from({ length: 8 }, (_, i) => ({
      q: `Question ${i + 1}/8`,
      askedAt: `2026-08-20T1${i}:00:00.000Z`,
    })),
  };
}

test('3/8 answered FIRST writes exactly entry 3; 1/8, 2/8 and the rest stay open on the board', (t) => {
  const { hive, ledger } = setup(t, [eightAsksCard()]);
  const before = openAsks(JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks[0]);
  assert.equal(before.length, 8);

  // the board renders all 8; the human expands #3 and answers it
  assert.equal(hive.resolveHumanQuestion('eight-1', 'Question 3/8', 'answering 3 first', 2), true);

  const after = JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks[0];
  assert.equal(after.humanQA[2].a, 'answering 3 first');
  assert.ok(after.humanQA[2].answeredAt);
  for (const i of [0, 1, 3, 4, 5, 6, 7]) {
    assert.equal(after.humanQA[i].a, undefined);
    assert.equal(after.humanQA[i].dismissedAt, undefined);
  }
  // stays ON the board: blocked + remaining open asks (waitsOnHuman's inputs)
  const remaining = openAsks(after);
  assert.equal(after.status, 'blocked');
  assert.equal(remaining.length, 7);
  assert.deepEqual(
    remaining.map((o) => o.entry.q),
    [
      'Question 1/8',
      'Question 2/8',
      'Question 4/8',
      'Question 5/8',
      'Question 6/8',
      'Question 7/8',
      'Question 8/8',
    ],
  );
});

test('the remaining 7 keep their draft keys — a draft on 4/8 never lands on 5/8', (t) => {
  const { hive, ledger } = setup(t, [eightAsksCard()]);
  const keyOf = (task, o) => `${task.id}:${o.index}`;
  const before = openAsks(JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks[0]);
  hive.resolveHumanQuestion('eight-1', 'Question 3/8', 'done with 3', 2);
  const after = openAsks(JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks[0]);
  // distinct per entry…
  assert.equal(new Set(before.map((o) => keyOf({ id: 'eight-1' }, o))).size, 8);
  // …and unchanged for every entry that is still open: paging away and back
  // finds the same key, so the draft typed there is the draft found there
  const beforeKeys = new Map(before.map((o) => [o.entry.q, keyOf({ id: 'eight-1' }, o)]));
  for (const o of after) assert.equal(keyOf({ id: 'eight-1' }, o), beforeKeys.get(o.entry.q));
});

test('scrambled out-of-order answering closes every entry exactly once, then none remain', (t) => {
  const { hive, ledger } = setup(t, [eightAsksCard()]);
  const order = [7, 0, 4, 1, 6, 3, 5]; // answer #3 first was the previous test; scramble the rest
  for (const i of order) {
    assert.equal(hive.resolveHumanQuestion('eight-1', `Question ${i + 1}/8`, `a${i}`, i), true);
  }
  assert.equal(hive.resolveHumanQuestion('eight-1', 'Question 3/8', 'a2', 2), true);
  const after = JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks[0];
  for (const e of after.humanQA) {
    assert.ok(e.a); // every entry answered, exactly its own answer
    assert.equal(e.a, `a${Number(e.q.slice('Question '.length, -2)) - 1}`);
  }
  // board-empty condition: no open asks left → the card leaves ASK ME
  assert.equal(openAsks(after).length, 0);
});

test('dismissing 3/8 sets dismissedAt on exactly that entry; board keeps 7', (t) => {
  const { hive, ledger } = setup(t, [eightAsksCard()]);
  assert.equal(hive.resolveHumanQuestion('eight-1', 'Question 3/8', undefined, 2), true);
  const after = JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks[0];
  assert.ok(after.humanQA[2].dismissedAt);
  assert.equal(after.humanQA[2].a, undefined);
  assert.equal(openAsks(after).length, 7);
  assert.equal(after.status, 'blocked'); // task itself stays blocked on the kanban
});
