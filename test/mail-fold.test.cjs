'use strict';

/**
 * MAIL FOLD (card agent-mail-queued-alongside-a--2026-08-19): mail queued
 * alongside a fresh dispatch was silently missed — the agent read only the
 * dispatch file. The fold closes it mechanically: when a dispatch contract
 * becomes visible (direct delivery, or release from inbox/.staged), it
 * ABSORBS everything else pending for the agent, so the dispatch is the ONE
 * thing beside itself. Originals are archived to inbox/.done/ (consumed).
 *
 * These tests pin the HiveManager delivery surface (deliver/releaseStagedMail)
 * on top of the staging behaviour pinned by card-scoped-sessions.test.cjs.
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
  hive.send(
    {
      to: 'dwight',
      subject: 'Fold card — card card-1',
      body: 'the contract',
      conversation: 'card-card-1',
    },
    'god',
  );
  assert.equal(fs.readdirSync(path.join(inbox, '.staged')).length, 2, 'both staged');
  // The card-scoped clear executed: the new conversation reported in → stamp.
  hive.recordSession('dwight', 'fresh-card-conversation');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'exactly ONE message — nothing beside the dispatch');
  assert.equal(msgs[0].conversation, 'card-card-1', 'it is the contract');
  assert.match(msgs[0].body, /the contract/);
  assert.match(msgs[0].body, /ALSO do the two additions/);
  assert.match(msgs[0].body, /MAIL FOLDED INTO THIS DISPATCH/);
  // God's caveats: the act survives the fold (a folded request still waits on
  // an answer) and the framing cannot be mistaken for card instructions.
  assert.match(msgs[0].body, /act: request \| Subject: amendment/);
  assert.match(msgs[0].body, /NOT part of this card's contract/);
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
  hive.send(
    {
      to: 'dwight',
      subject: 'Fold card — card card-1',
      body: 'the contract',
      conversation: 'card-card-1',
    },
    'god',
  );
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
  hive.send(
    {
      to: 'dwight',
      subject: 'Fold card — card card-1',
      body: 'the contract',
      conversation: 'card-card-1',
    },
    'god',
  );
  const msgs = hive.inbox('dwight');
  assert.equal(msgs.length, 1, 'contract absorbed the pending note');
  assert.match(msgs[0].body, /the contract/);
  assert.match(msgs[0].body, /NOTE read me too/);
});

test('fold: dispatch with an empty inbox is byte-identical — no fold section', () => {
  const { hive, root } = foldHive([CARD()]);
  hive.send(
    {
      to: 'dwight',
      subject: 'Fold card — card card-1',
      body: 'the contract',
      conversation: 'card-card-1',
    },
    'god',
  );
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
  hive.send(
    {
      to: 'dwight',
      subject: 'Fold card — card card-1',
      body: 'the contract',
      conversation: 'card-card-1',
    },
    'god',
  );
  hive.recordSession('dwight', 'fresh-card-conversation');
  hive.routeOnce();
  const msgs = hive.inbox('dwight');
  // The contract + the two beyond-budget messages (left pending, pointed at).
  assert.equal(msgs.length, 3, 'overflow stays pending in the inbox');
  const contract = msgs.find((m) => m.conversation === 'card-card-1');
  assert.ok(contract, 'contract released');
  assert.match(contract.body, /the contract/);
  assert.ok(contract.body.includes(big), 'first big mail folded IN FULL — no truncation');
  assert.match(contract.body, /MAIL QUEUED BESIDE THIS DISPATCH/);
  assert.match(contract.body, /Subject: big two/);
  assert.match(contract.body, /Subject: big three/);
  assert.match(contract.body, /act: query \| Subject: big one/, 'act preserved in the full fold');
  assert.match(
    contract.body,
    /2 message\(s\) beyond the fold budget remain pending in your inbox — run hive-inbox drain/,
    'the drain pointer names what is left',
  );
  assert.equal(
    fs.readdirSync(path.join(inbox, '.done')).length,
    1,
    'only the fully folded mail consumed',
  );
});

test('fold: timeout release still warns god, and the folded contract carries its siblings', () => {
  const { hive, root } = foldHive([CARD()]);
  const stagedDir = path.join(inboxDir(root), '.staged');
  hive.send({ to: 'dwight', subject: 'amendment', body: 'ADD this as well' }, 'god');
  hive.send(
    {
      to: 'dwight',
      subject: 'Fold card — card card-1',
      body: 'the contract',
      conversation: 'card-card-1',
    },
    'god',
  );
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
