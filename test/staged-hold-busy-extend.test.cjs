'use strict';

/**
 * STAGED HOLD, BUSY EXTENSION (card agent-dispatch-mail-still-land-2026-08-21):
 * the staging timeout treated AGE ALONE as "the establishment chain is broken".
 * On a standing deep-work agent (claude pane with in-flight background
 * subagents/shells — the pendingWork census — or a long active turn) the pane
 * legitimately stays non-idle far past the 10-minute horizon: the card-scoped
 * clear is QUEUED behind the drain's idle gate BY DESIGN and will fire the
 * moment the pane quiets. The timeout fired anyway, dumped the contract into
 * the PRE-clear conversation and consumed the watcher transition (R4) — the
 * card never got its scoped conversation (toby ×3, alfred, robert on
 * 2026-08-21; the healthy chain releases in seconds on fresh spawns).
 *
 * The fix: while the assignee is busy by the HOUSE rule (vacationBusy —
 * telemetry-hot OR pendingWork census > 0), the timed-out leg does not break
 * the hold. The chain is alive-but-slow, not broken. God gets ONE hold-extended
 * notice per staging epoch so the operator keeps visibility.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MAIL_STAGE_TIMEOUT_MS } = loadTs('src/main/cardSessions.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const CARD = {
  id: 'card-1',
  title: 'Stuck card',
  assignee: 'toby',
  status: 'doing',
};

const CONTRACT = {
  to: 'toby',
  subject: 'Stuck card — card card-1',
  body: 'the contract',
  conversation: 'card-card-1',
};

/** Hand-built hive with god + toby (claude, old live session → the mail hold
 *  is active for the unstamped doing card), an inbox each. */
function busyHive() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-'));
  const root = path.join(tmp, 'hive');
  for (const id of ['god', 'toby']) {
    fs.mkdirSync(path.join(root, 'agents', id, 'inbox'), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, 'registry.json'),
    JSON.stringify({
      godId: 'god',
      agents: {
        god: { id: 'god', name: 'God', cwd: '/g', status: 'idle', lastSeen: 0 },
        toby: {
          id: 'toby',
          name: 'Toby',
          cwd: '/w',
          status: 'idle',
          lastSeen: 0,
          sessionId: 'old-engagement',
          provider: 'claude',
        },
      },
    }),
  );
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [CARD] }));
  return { hive: new HiveManager(() => tmp), root };
}

const inboxDir = (root) => path.join(root, 'agents', 'toby', 'inbox');
const stagedDir = (root) => path.join(inboxDir(root), '.staged');

/** Stage the contract and backdate it past the horizon (mtime is the clock). */
function stageStale(hive, root) {
  hive.send(CONTRACT, 'god');
  const staged = stagedDir(root);
  assert.equal(fs.readdirSync(staged).length, 1, 'contract staged');
  const old = new Date(Date.now() - MAIL_STAGE_TIMEOUT_MS - 60_000);
  for (const f of fs.readdirSync(staged)) fs.utimesSync(path.join(staged, f), old, old);
}

test('busy extension: a timeout-stale contract does NOT release while the assignee is busy', () => {
  const { hive, root } = busyHive();
  hive.setStageBusyProbe(() => true); // house rule: in-flight subagents / active turn
  stageStale(hive, root);
  hive.routeOnce();
  assert.equal(fs.readdirSync(stagedDir(root)).length, 1, 'still staged — chain alive, just slow');
  assert.equal(hive.inbox('toby').length, 0, 'nothing leaked into the pre-clear inbox');
});

test('busy extension: god is told ONCE per staging epoch that the hold extended', () => {
  const { hive, root } = busyHive();
  hive.setStageBusyProbe(() => true);
  stageStale(hive, root);
  hive.routeOnce();
  hive.routeOnce();
  hive.routeOnce();
  const notices = hive.inbox('god').filter((m) => /hold extended/.test(m.subject || ''));
  assert.equal(notices.length, 1, 'exactly one hold-extended notice, not one per tick');
  assert.match(
    notices[0].body,
    /legitimately busy/,
    'the notice names the cause (busy pane, chain intact)',
  );
});

test('busy extension: when the pane quiets, the stale mail releases with the usual timeout notice', () => {
  const { hive, root } = busyHive();
  let busy = true;
  hive.setStageBusyProbe(() => busy);
  stageStale(hive, root);
  hive.routeOnce();
  busy = false; // background work finished, pane idle — chain dead or delivered
  hive.routeOnce();
  assert.equal(fs.readdirSync(stagedDir(root)).length, 0, 'released once not busy');
  assert.equal(hive.inbox('toby').length, 1, 'contract visible');
  const warned = hive.inbox('god').some((m) => /timeout release for toby/.test(m.subject || ''));
  assert.ok(warned, 'the ordinary timeout warning still fires on the eventual release');
});

test('busy extension never delays the NORMAL release: the stamp lands while busy → mail releases', () => {
  const { hive, root } = busyHive();
  hive.setStageBusyProbe(() => true);
  hive.send(CONTRACT, 'god');
  hive.recordSession('toby', 'fresh-card-conversation'); // card-scoped clear executed
  hive.routeOnce();
  assert.equal(fs.readdirSync(stagedDir(root)).length, 0, 'established → released');
  assert.equal(hive.inbox('toby').length, 1, 'contract delivered');
});

test('no probe wired (legacy construction): stale mail times out as before', () => {
  const { hive, root } = busyHive();
  stageStale(hive, root);
  hive.routeOnce();
  assert.equal(fs.readdirSync(stagedDir(root)).length, 0, 'timeout released (old behavior)');
  assert.equal(hive.inbox('toby').length, 1, 'contract visible');
});

test('tick fold never drains staged mail around the busy hold (reviewer blocker)', () => {
  const { hive, root } = busyHive();
  let busy = false; // the first epoch releases by ordinary timeout
  hive.setStageBusyProbe(() => busy);
  hive.send(CONTRACT, 'god');
  // Epoch 1: not busy → timeout release (backdate), contract lands UNREAD.
  const staged = stagedDir(root);
  const old = new Date(Date.now() - MAIL_STAGE_TIMEOUT_MS - 60_000);
  for (const f of fs.readdirSync(staged)) fs.utimesSync(path.join(staged, f), old, old);
  hive.routeOnce();
  assert.equal(hive.inbox('toby').length, 1, 'epoch-1 contract released, unread in inbox');
  // Epoch 2: god amends the SAME card conversation while the pane is busy.
  // The hold is still active (card unstamped + doing) — the amendment must
  // STAGE, and the tick fold must not pull it into the unread anchor.
  busy = true;
  hive.send({ ...CONTRACT, id: 'amend-1', subject: 'amendment', body: 'do more' }, 'god');
  hive.routeOnce();
  hive.routeOnce();
  assert.equal(
    fs.readdirSync(staged).length,
    1,
    'amendment stays staged — no fold-out around the busy hold',
  );
  const anchor = hive.inbox('toby').find((m) => m.conversation === 'card-card-1');
  assert.doesNotMatch(anchor.body ?? '', /do more/, 'anchor body untouched');
});

test('a fresh staging epoch after a release gets its own hold-extended notice', () => {
  const { hive, root } = busyHive();
  let busy = false;
  hive.setStageBusyProbe(() => busy);
  // Epoch 1: busy extension notifies once, then the pane quiets → release.
  stageStale(hive, root);
  busy = true;
  hive.routeOnce(); // hold-extended notice #1
  busy = false;
  hive.routeOnce(); // release (epoch ends)
  assert.equal(fs.readdirSync(stagedDir(root)).length, 0, 'epoch 1 drained');
  // Epoch 2: new mail stages immediately, pane busy again, goes stale.
  hive.send({ ...CONTRACT, id: 'second-1', subject: 'second dispatch', body: 'again' }, 'god');
  busy = true;
  const stale2 = new Date(Date.now() - MAIL_STAGE_TIMEOUT_MS - 60_000);
  for (const f of fs.readdirSync(stagedDir(root)))
    fs.utimesSync(path.join(stagedDir(root), f), stale2, stale2);
  hive.routeOnce();
  const notices = hive.inbox('god').filter((m) => /hold extended/.test(m.subject || ''));
  assert.equal(notices.length, 2, 'epoch 2 notified again — not suppressed by epoch 1');
});
