'use strict';

/**
 * MAIL FOLD (card agent-mail-queued-alongside-a--2026-08-19): mail queued
 * alongside a fresh dispatch was silently missed — the agent read only the
 * dispatch file. The fold closes it mechanically: when a dispatch contract
 * becomes visible (direct delivery, or release from inbox/.staged), it
 * ABSORBS everything else pending for the agent, so the dispatch is the ONE
 * thing beside itself. A per-tick backstop fold keeps that true for mail
 * routed after the contract. Originals are archived to inbox/.done/
 * (consumed). Reviewer-driven cases included: mixed-age timeout, single
 * combined budget, delivery-order independence, amendment anchoring,
 * invalid-mail tolerance, deterministic fold order.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MAIL_STAGE_TIMEOUT_MS } = loadTs('src/main/cardSessions.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const CARD = (over = {}) => ({
  id: 'card-1',
  title: 'Fold card',
  assignee: 'dwight',
  status: 'doing',
  ...over,
});

const CONTRACT = {
  to: 'dwight',
  subject: 'Fold card — card card-1',
  body: 'the contract',
  conversation: 'card-card-1',
};

/** Hand-built hive with god + dwight (claude, an old live session so the
 *  mail hold is active for an unstamped doing card), an inbox each. */
function foldHive(tasks) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-'));
  const root = path.join(tmp, 'hive');
  for (const id of ['god', 'dwight']) {
    fs.mkdirSync(path.join(root, 'agents', id, 'inbox'), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, 'registry.json'),
    JSON.stringify({
      godId: 'god',
      agents: {
        god: { id: 'god', name: 'God', cwd: '/g', status: 'idle', lastSeen: 0 },
        dwight: {
          id: 'dwight',
          name: 'Dwight',
          cwd: '/w',
          status: 'idle',
          lastSeen: 0,
          sessionId: 'old-engagement',
          provider: 'claude',
        },
      },
    }),
  );
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks }));
  return { hive: new HiveManager(() => tmp), root };
}

function inboxDir(root) {
  return path.join(root, 'agents', 'dwight', 'inbox');
}

test('fold: staged siblings absorb into the dispatch contract at release — one visible message', () => {
  const { hive, root } = foldHive([CARD()]);
  const inbox = inboxDir(root);
  // God mails an amendment while the card conversation establishes — it stages.
  hive.send(
    { to: 'dwight', act: 'request', subject: 'amendment', body: 'ALSO do the two additions' },
    'god',
  );
  // The dispatch contract (card conversation) — stages beside it.
  hive.send(CONTRACT, 'god');
  assert.equal(fs.readdirSync(path.join(inbox, '.staged')).length, 2, 'both staged');
  // The card-scoped clear executed: a NEW conversation reported in → stamp.
  hive.recordSession('dwight', 'fresh-card-conversation');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'exactly ONE message — nothing beside the dispatch');
  assert.equal(msgs[0].conversation, 'card-card-1', 'it is the contract');
  assert.match(msgs[0].body, /the contract/);
  assert.match(msgs[0].body, /ALSO do the two additions/);
  assert.match(msgs[0].body, /MAIL FOLDED INTO THIS DISPATCH/);
  // God's caveats: the act survives the fold (a folded request still waits on
  // an answer) and the framing marks it as separate mail, not contract lines.
  assert.match(msgs[0].body, /act: request \| Subject: amendment/);
  assert.match(msgs[0].body, /handle it alongside this contract/);
  assert.equal(fs.readdirSync(path.join(inbox, '.staged')).length, 0, 'staged drained');
  assert.equal(
    fs.readdirSync(path.join(inbox, '.done')).length,
    1,
    'amendment archived (consumed)',
  );
});

test('fold: inbox-pending mail (stamp→sweep race window) absorbs into the staged contract', () => {
  const { hive, root } = foldHive([CARD()]);
  const inbox = inboxDir(root);
  hive.send(CONTRACT, 'god');
  hive.recordSession('dwight', 'fresh-card-conversation'); // stamp → hold open
  // Amendment lands AFTER the stamp but BEFORE the release sweep → inbox.
  hive.send({ to: 'dwight', subject: 'late amendment', body: 'LATE add this too' }, 'god');
  assert.equal(hive.inbox('dwight').length, 1, 'amendment landed beside the (staged) dispatch');
  hive.routeOnce(); // the release sweep folds it into the staged contract
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'still exactly ONE message');
  assert.match(msgs[0].body, /the contract/);
  assert.match(msgs[0].body, /LATE add this too/);
  assert.equal(fs.readdirSync(path.join(inbox, '.done')).length, 1, 'late amendment archived');
});

test('fold: adopt dispatch (direct delivery) absorbs pending inbox mail into the contract', () => {
  const { hive } = foldHive([CARD({ sessionMode: 'adopt' })]);
  hive.send({ to: 'dwight', subject: 'pre-dispatch note', body: 'NOTE read me too' }, 'god');
  assert.equal(hive.inbox('dwight').length, 1, 'note pending');
  hive.send(CONTRACT, 'god');
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'contract absorbed the pending note');
  assert.match(msgs[0].body, /the contract/);
  assert.match(msgs[0].body, /NOTE read me too/);
});

test('fold: dispatch with an empty inbox is byte-identical — no fold section', () => {
  const { hive, root } = foldHive([CARD()]);
  hive.send(CONTRACT, 'god');
  hive.recordSession('dwight', 'fresh-card-conversation');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].body, 'the contract', 'no FOLDED section appended');
  const done = path.join(inboxDir(root), '.done');
  assert.ok(!fs.existsSync(done) || fs.readdirSync(done).length === 0, 'nothing archived');
});

test('fold: past the body budget, headers fold and overflow stays pending — never a mid-sentence cut', () => {
  const { hive, root } = foldHive([CARD()]);
  const inbox = inboxDir(root);
  const big = 'x'.repeat(10_000);
  hive.send({ to: 'dwight', act: 'query', subject: 'big one', body: big }, 'god');
  hive.send({ to: 'dwight', act: 'inform', subject: 'big two', body: big }, 'god');
  hive.send({ to: 'dwight', act: 'inform', subject: 'big three', body: big }, 'god');
  hive.send(CONTRACT, 'god');
  hive.recordSession('dwight', 'fresh-card-conversation');
  hive.routeOnce();
  // Release pass: big one fits the single 16k budget; big two/three overflow
  // beside the contract as headers + a drain pointer. The same tick's
  // backstop pass must NOT re-budget them in (idempotence — a backlog cannot
  // be swallowed 16k per tick): they stay pending, pointed at.
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 3, 'both beyond-budget messages stay beside the contract');
  const contract = msgs.find((m) => m.conversation === 'card-card-1');
  assert.ok(contract, 'contract released');
  assert.match(contract.body, /the contract/);
  assert.ok(contract.body.includes(big), 'big mail folded IN FULL — no truncation');
  assert.match(contract.body, /Subject: big two/);
  assert.match(contract.body, /Subject: big three/);
  assert.match(contract.body, /act: query \| Subject: big one/, 'act preserved in the fold');
  assert.match(
    contract.body,
    /2 message\(s\) beyond the fold budget remain pending in your inbox — run hive-inbox drain/,
    'the drain pointer names what is left',
  );
  assert.equal(
    fs.readdirSync(path.join(inbox, '.done')).length,
    1,
    'only fully folded mail consumed (big one)',
  );
});

test('fold: ONE budget across staged siblings and inbox-pending mail (no double 16k)', () => {
  const { hive } = foldHive([CARD()]);
  const nine = 'y'.repeat(9_000);
  // 9k stages beside the contract; another 9k lands in the inbox after the
  // stamp (stamp→sweep window). A combined budget folds the first in full and
  // header-points the second; two separate budgets would inline both (18k).
  hive.send({ to: 'dwight', subject: 'staged nine', body: nine }, 'god');
  hive.send(CONTRACT, 'god');
  hive.recordSession('dwight', 'fresh-card-conversation');
  hive.send({ to: 'dwight', subject: 'inbox nine', body: nine }, 'god');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  const contract = msgs.find((m) => m.conversation === 'card-card-1');
  assert.ok(contract, 'contract released');
  // The combined fold must NOT fully contain BOTH 8k bodies.
  const yRuns = contract.body.match(/y{8,}/g) ?? [];
  assert.equal(yRuns.length, 1, `exactly one 9k body inlined, got ${yRuns.length}`);
  assert.match(contract.body, /Subject: (staged nine|inbox nine)/);
  assert.match(contract.body, /MAIL QUEUED BESIDE THIS DISPATCH/);
});

test('fold: mixed-age timeout — a stale contract release folds its FRESH staged sibling too', () => {
  const { hive, root } = foldHive([CARD()]);
  const stagedDir = path.join(inboxDir(root), '.staged');
  hive.send(CONTRACT, 'god');
  // Backdate ONLY the contract: it is timeout-stale, the amendment is fresh.
  const contractFile = path.join(stagedDir, fs.readdirSync(stagedDir)[0]);
  const old = new Date(Date.now() - MAIL_STAGE_TIMEOUT_MS - 5000);
  fs.utimesSync(contractFile, old, old);
  hive.send({ to: 'dwight', subject: 'fresh amendment', body: 'FRESH do this too' }, 'god');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'the fresh sibling did not stay hidden in .staged');
  assert.match(msgs[0].body, /the contract/);
  assert.match(msgs[0].body, /FRESH do this too/);
  assert.equal(fs.readdirSync(stagedDir).length, 0, 'staged drained');
});

test('fold: mail routed AFTER a direct (adopt) contract is folded in on the next tick', () => {
  const { hive } = foldHive([CARD({ sessionMode: 'adopt' })]);
  hive.send(CONTRACT, 'god');
  // A note routed after the contract lands beside it — delivery order must
  // not decide visibility. The tick fold consolidates it into the unread
  // contract.
  hive.send({ to: 'dwight', subject: 'late note', body: 'LATE handle me' }, 'god');
  assert.equal(hive.inbox('dwight').length, 2, 'briefly beside — as routed');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'tick fold consolidated the late arrival');
  assert.match(msgs[0].body, /the contract/);
  assert.match(msgs[0].body, /LATE handle me/);
});

test('fold: a later same-conversation amendment never consumes the original contract', () => {
  const { hive, root } = foldHive([CARD({ sessionMode: 'adopt' })]);
  const inbox = inboxDir(root);
  hive.send(
    { ...CONTRACT, body: 'the ORIGINAL contract', created_at: '2026-08-19T10:00:00.000Z' },
    'god',
  );
  hive.send(
    {
      to: 'dwight',
      subject: 'amendment to the card',
      body: 'AMEND the scope thus',
      conversation: 'card-card-1',
      created_at: '2026-08-19T10:00:02.000Z',
    },
    'god',
  );
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'one message');
  // The ORIGINAL is the anchor: its body leads, the amendment is the framed
  // foreign section — never the reverse.
  const origAt = msgs[0].body.indexOf('the ORIGINAL contract');
  const amendAt = msgs[0].body.indexOf('AMEND the scope thus');
  assert.ok(origAt >= 0 && amendAt > origAt, 'original contract anchors, amendment folds in');
  assert.match(msgs[0].body, /Subject: amendment to the card/);
  assert.equal(
    fs.readdirSync(path.join(inbox, '.done')).length,
    1,
    'the amendment (not the contract) was consumed',
  );
});

test('fold: structurally invalid pending mail is skipped, not fatal — and stays pending', () => {
  const { hive, root } = foldHive([CARD()]);
  const inbox = inboxDir(root);
  hive.send({ to: 'dwight', subject: 'broken envelope', body: 'x' }, 'god');
  // The hold is active, so the note STAGED. Corrupt it there to
  // valid-JSON-but-not-a-message (no body).
  const stagedDir = path.join(inbox, '.staged');
  const stagedFiles = fs.readdirSync(stagedDir).filter((f) => f.endsWith('.json'));
  const broken = stagedFiles[0];
  fs.writeFileSync(path.join(stagedDir, broken), JSON.stringify({ nope: true }));
  hive.send(CONTRACT, 'god');
  hive.recordSession('dwight', 'fresh-card-conversation');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  const contract = msgs.find((m) => m.conversation === 'card-card-1');
  assert.ok(contract, 'contract released despite the invalid sibling');
  // The invalid file is invisible to inbox() (pre-existing parity) and is
  // released un-parsed like any staged file — but never consumed by the fold.
  assert.ok(
    fs.existsSync(path.join(inbox, broken)) || fs.existsSync(path.join(stagedDir, broken)),
    'invalid file not consumed by the fold',
  );
  const done = path.join(inbox, '.done');
  assert.ok(!fs.existsSync(done) || fs.readdirSync(done).length === 0, 'nothing archived');
});

test('fold: fold order is oldest-first regardless of directory enumeration', () => {
  const { hive } = foldHive([CARD({ sessionMode: 'adopt' })]);
  const first = hive.send(
    {
      to: 'dwight',
      subject: 'older note',
      body: 'OLDEST',
      created_at: '2026-08-19T10:00:00.000Z',
    },
    'god',
  );
  const second = hive.send(
    {
      to: 'dwight',
      subject: 'newer note',
      body: 'NEWEST',
      created_at: '2026-08-19T10:00:01.000Z',
    },
    'god',
  );
  assert.ok(Date.parse(second.created_at) > Date.parse(first.created_at));
  hive.send(CONTRACT, 'god');
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1);
  assert.ok(
    msgs[0].body.indexOf('OLDEST') < msgs[0].body.indexOf('NEWEST'),
    'oldest body folded first',
  );
});

test('fold: timeout release still warns god, and the folded contract carries its siblings', () => {
  const { hive, root } = foldHive([CARD()]);
  const stagedDir = path.join(inboxDir(root), '.staged');
  hive.send({ to: 'dwight', subject: 'amendment', body: 'ADD this as well' }, 'god');
  hive.send(CONTRACT, 'god');
  // Backdate both past the horizon (mtime is the timeout clock).
  const old = new Date(Date.now() - MAIL_STAGE_TIMEOUT_MS - 5000);
  for (const f of fs.readdirSync(stagedDir)) fs.utimesSync(path.join(stagedDir, f), old, old);
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'timeout released the contract carrying the amendment');
  assert.match(msgs[0].body, /the contract/);
  assert.match(msgs[0].body, /ADD this as well/);
  assert.ok(
    hive.inbox('god').some((m) => /mail-staged/.test(m.subject) && /dwight/.test(m.body)),
    'god is still warned about the stuck establishment',
  );
});

test('fold: all-overflow timeout fold — no crash, overflow rides out with the contract', () => {
  const { hive, root } = foldHive([CARD()]);
  const inbox = inboxDir(root);
  const stagedDir = path.join(inbox, '.staged');
  const big = 'z'.repeat(10_000);
  hive.send({ ...CONTRACT, created_at: '2026-08-19T10:00:00.000Z' }, 'god');
  hive.send(
    { to: 'dwight', subject: 'big A', body: big, created_at: '2026-08-19T10:00:01.000Z' },
    'god',
  );
  hive.send(
    { to: 'dwight', subject: 'big B', body: big, created_at: '2026-08-19T10:00:02.000Z' },
    'god',
  );
  // Backdate ONLY the contract past the horizon; both bigs are fresh.
  const files = fs.readdirSync(stagedDir);
  const contractFile = files.find(
    (f) =>
      JSON.parse(fs.readFileSync(path.join(stagedDir, f), 'utf8')).conversation === 'card-card-1',
  );
  const old = new Date(Date.now() - MAIL_STAGE_TIMEOUT_MS - 5000);
  fs.utimesSync(path.join(stagedDir, contractFile), old, old);
  hive.routeOnce();
  // The contract released (timeout) and fold: one big fits the budget, the
  // other is header-pointed — but MUST NOT stay hidden in .staged (its drain
  // pointer claims it is pending): it rides out with the contract.
  const msgs = hive.inbox('dwight');
  const contract = msgs.find((m) => m.conversation === 'card-card-1');
  assert.ok(contract, 'contract released');
  assert.ok(contract.body.includes(big), 'first big folded in full');
  assert.match(contract.body, /Subject: big B/);
  assert.match(contract.body, /1 message\(s\) beyond the fold budget/);
  assert.equal(fs.readdirSync(stagedDir).length, 0, 'overflow sibling released with the contract');
  assert.ok(
    msgs.some((m) => m.subject === 'big B'),
    'overflow sibling is VISIBLE',
  );
});

test('fold: one lifetime budget across the direct fold and the tick backstop', () => {
  const { hive } = foldHive([CARD({ sessionMode: 'adopt' })]);
  const nine = 'q'.repeat(9_000);
  // BEFORE the contract: folded at delivery (fits the fresh budget).
  hive.send({ to: 'dwight', subject: 'pre note', body: nine }, 'god');
  hive.send(CONTRACT, 'god');
  // AFTER the contract: the backstop must see the SHRUNKEN remaining budget
  // (lifetime 16k minus what the contract already carries) and header-point
  // the second 9k — two per-pass budgets would inline both.
  hive.send({ to: 'dwight', subject: 'post note', body: nine }, 'god');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 2, 'overflow post note stays beside, pointed at');
  const contract = msgs.find((m) => m.conversation === 'card-card-1');
  assert.ok(contract, 'contract present');
  const qRuns = contract.body.match(/q{8,}/g) ?? [];
  assert.equal(qRuns.length, 1, `exactly one 9k body inlined across passes, got ${qRuns.length}`);
  assert.match(contract.body, /Subject: post note/);
  assert.match(contract.body, /1 message\(s\) beyond the fold budget/);
});

test('fold: idempotence is structural (foldedIds), not body substring matching', () => {
  const { hive } = foldHive([CARD({ sessionMode: 'adopt' })]);
  // A message whose id is a SUBSTRING of the contract body ('the') must
  // still fold — body.includes(id) skipped it.
  hive.send(CONTRACT, 'god');
  hive.routeOnce(); // ensure clean baseline (no-op)
  const tricky = hive.send(
    { to: 'dwight', id: 'the', subject: 'tricky id', body: 'TRICKY fold me' },
    'god',
  );
  assert.equal(tricky.id, 'the');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  const contract = msgs.find((m) => m.conversation === 'card-card-1');
  assert.ok(contract, 'contract present');
  assert.match(contract.body, /TRICKY fold me/, 'substring-colliding id still folded');
});

test('fold: equal created_at ties anchor deterministically (same rule everywhere)', () => {
  const { hive } = foldHive([CARD({ sessionMode: 'adopt' })]);
  const ts = '2026-08-19T10:00:00.000Z';
  // Both same-conversation, same timestamp: the (ts, id) order must pick ONE
  // anchor consistently — the lower id — and fold the other in. No flip
  // between the delivery guard and the tick fold.
  hive.send({ ...CONTRACT, id: 'aaa-contract', body: 'CONTRACT body', created_at: ts }, 'god');
  hive.send(
    {
      to: 'dwight',
      id: 'zzz-amendment',
      subject: 'same-ts amendment',
      body: 'AMENDMENT body',
      conversation: 'card-card-1',
      created_at: ts,
    },
    'god',
  );
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'one message');
  assert.equal(msgs[0].id, 'aaa-contract', 'the lower (ts,id) anchors');
  assert.match(msgs[0].body, /CONTRACT body/);
  assert.match(msgs[0].body, /AMENDMENT body/);
});

test('fold: a no-op second tick leaves an overflow contract UNCHANGED (pointedIds)', () => {
  const { hive } = foldHive([CARD({ sessionMode: 'adopt' })]);
  const big = 'w'.repeat(10_000);
  hive.send(CONTRACT, 'god');
  hive.send({ to: 'dwight', subject: 'big one', body: big }, 'god');
  hive.send({ to: 'dwight', subject: 'big two', body: big }, 'god');
  hive.routeOnce();
  const after1 = hive.inbox('dwight').find((m) => m.conversation === 'card-card-1');
  assert.ok(after1, 'contract present');
  assert.match(after1.body, /1 message\(s\) beyond the fold budget/, 'one overflow pointed');
  // Round-3 blocker: the same overflow re-pointed every 1.5s grew the
  // contract forever. pointedIds makes later no-op ticks leave it untouched.
  hive.routeOnce();
  hive.routeOnce();
  const after3 = hive.inbox('dwight').find((m) => m.conversation === 'card-card-1');
  assert.equal(after3.body, after1.body, 'no growth across no-op ticks');
  assert.deepEqual(after3.pointedIds, after1.pointedIds);
});

test('fold: reverse mixed-age timeout — stale SIBLING release frees the fresh contract too', () => {
  const { hive, root } = foldHive([CARD()]);
  const inbox = inboxDir(root);
  const stagedDir = path.join(inbox, '.staged');
  // The CONTRACT is the older card-conversation message (normal dispatch
  // order); the later amendment goes stale alone.
  const sent = hive.send(
    { ...CONTRACT, body: 'the contract', created_at: '2026-08-19T10:00:00.000Z' },
    'god',
  );
  const contractId = sent.id;
  hive.send(
    {
      to: 'dwight',
      subject: 'late amendment',
      body: 'LATE amendment text',
      conversation: 'card-card-1',
      created_at: '2026-08-19T10:05:00.000Z',
    },
    'god',
  );
  // Backdate ONLY the amendment: it is timeout-stale, the contract is fresh.
  const amendFile = fs
    .readdirSync(stagedDir)
    .find(
      (f) =>
        JSON.parse(fs.readFileSync(path.join(stagedDir, f), 'utf8')).subject === 'late amendment',
    );
  const old = new Date(Date.now() - MAIL_STAGE_TIMEOUT_MS - 5000);
  fs.utimesSync(path.join(stagedDir, amendFile), old, old);
  hive.routeOnce();
  // Round-3 reverse mixed-age: the stale amendment must not release ALONE
  // (visible mail beside a hidden contract). With the anchor taken over ALL
  // staged entries, the fold ABSORBS the stale amendment into the still-held
  // contract BEFORE any release — nothing is visible yet, and when the gate
  // opens the contract surfaces as ONE consolidated message.
  assert.equal(hive.inbox('dwight').length, 0, 'nothing released beside the held contract');
  const stagedLeft = fs.readdirSync(stagedDir).filter((f) => f.endsWith('.json'));
  assert.equal(stagedLeft.length, 1, 'only the contract remains staged');
  const stagedMsg = JSON.parse(fs.readFileSync(path.join(stagedDir, stagedLeft[0]), 'utf8'));
  assert.equal(stagedMsg.id, contractId, 'the ORIGINAL contract is the anchor');
  assert.match(stagedMsg.body, /LATE amendment text/, 'stale amendment folded INTO it');
  // The gate opens (stamp): one consolidated message.
  hive.recordSession('dwight', 'fresh-card-conversation');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'one message');
  assert.equal(msgs[0].id, contractId, 'it is the contract');
  assert.match(msgs[0].body, /the contract/);
  assert.match(msgs[0].body, /LATE amendment text/);
});
