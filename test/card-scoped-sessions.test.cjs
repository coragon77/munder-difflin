'use strict';

/**
 * Card-scoped sessions (card-scoped-sessions-20260816): one kanban card = one
 * conversation. Built on Ada's session-requests mechanism (same emit channel,
 * same provider table via composeSessionCommand).
 *
 * The lifecycle engine is a pure transition function (cards + last tick's
 * snapshot + registry session ids → pane actions), so every rule is pinned
 * without fs or timers:
 *   - NEW card (never ran)            → clear (provider-aware) + card-title lead
 *   - PAUSED card returning           → /resume <card.sessionId> + lead
 *   - card already in its own session → no-op
 *   - first tick / no transition      → NOTHING (a restart must never re-clear)
 * The tick adds: FIFO emit ordering, failed-emit retry semantics (the card
 * stays unseen), and the HiveManager stamp (recordSession → stampActiveCards:
 * the active doing-card tracks the agent's conversation).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { cardSessionDecisions, cardSessionTick } = loadTs('src/main/cardSessions.ts');
const { cardSessionActionStillValid } = loadTs('src/shared/cardSessions.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const CARD = (over = {}) => ({
  id: 'card-1',
  title: 'Vacation state implementation',
  assignee: 'dwight',
  status: 'doing',
  ...over,
});

// ——— the pure transition engine ——————————————————————————————————————

test('NEW card (no sessionId) → provider clear + card-title lead', () => {
  const [a] = cardSessionDecisions(
    [CARD()],
    { 'card-1': { status: 'todo' } },
    { dwight: 'old-session' },
    { dwight: 'claude' },
  );
  assert.equal(a.kind, 'clear');
  assert.equal(a.command, '/clear');
  assert.equal(a.agentId, 'dwight');
  assert.ok(a.label.startsWith('Card "Vacation state implementation"'), 'lead names the card');
});

test('grok assignee gets the provider clear (/new), not claude /clear', () => {
  const [a] = cardSessionDecisions(
    [CARD()],
    { 'card-1': { status: 'todo' } },
    { dwight: 'x' },
    { dwight: 'grok' },
  );
  assert.equal(a.command, '/new');
});

test('PAUSED card returning (stamp ≠ live session) → /resume <stamp> + lead', () => {
  const [a] = cardSessionDecisions(
    [CARD({ sessionId: 'card-session-uuid' })],
    { 'card-1': { status: 'todo' } },
    { dwight: 'a-different-live-session' },
    { dwight: 'claude' },
  );
  assert.equal(a.kind, 'resume');
  assert.equal(a.command, '/resume card-session-uuid');
});

test('card whose session is already live → no-op (already in that conversation)', () => {
  const actions = cardSessionDecisions(
    [CARD({ sessionId: 'live-now' })],
    { 'card-1': { status: 'todo' } },
    { dwight: 'live-now' },
    { dwight: 'claude' },
  );
  assert.equal(actions.length, 0);
});

test('FIRST TICK (card unseen) → nothing — a restart never re-clears a working pane', () => {
  const actions = cardSessionDecisions(
    [CARD()],
    {}, // empty seen = first tick after boot
    { dwight: 's' },
    { dwight: 'claude' },
  );
  assert.equal(actions.length, 0);
});

test('no transition to doing (still todo / still doing / → done) → nothing', () => {
  const reg = { dwight: 's' },
    prov = { dwight: 'claude' };
  assert.equal(
    cardSessionDecisions([CARD({ status: 'todo' })], { 'card-1': { status: 'todo' } }, reg, prov)
      .length,
    0,
  );
  assert.equal(
    cardSessionDecisions([CARD()], { 'card-1': { status: 'doing' } }, reg, prov).length,
    0,
  );
  assert.equal(
    cardSessionDecisions([CARD({ status: 'done' })], { 'card-1': { status: 'doing' } }, reg, prov)
      .length,
    0,
  );
});

test('card without assignee never steers anything', () => {
  const actions = cardSessionDecisions(
    [CARD({ assignee: undefined })],
    { 'card-1': { status: 'todo' } },
    {},
    {},
  );
  assert.equal(actions.length, 0);
});

// ——— stale-drop at DELIVERY (card-session-stamp-never-fires-20260816) ————
// A queued card action may park for a long time in a BUSY pane's queue; the
// card state it was decided against can change underneath it (god flip-flops
// blocked/done, reassigns, or the stamp lands). The queue-drain revalidates at
// delivery through the same rules the nudge uses for inboxFor.

test('validity: card gone / not doing / reassigned → stale', () => {
  const m = { cardId: 'card-1', agentId: 'dwight', kind: 'clear' };
  assert.equal(cardSessionActionStillValid(undefined, m), false);
  assert.equal(
    cardSessionActionStillValid({ id: 'card-1', status: 'blocked', assignee: 'dwight' }, m),
    false,
  );
  assert.equal(
    cardSessionActionStillValid({ id: 'card-1', status: 'done', assignee: 'dwight' }, m),
    false,
  );
  assert.equal(
    cardSessionActionStillValid({ id: 'card-1', status: 'doing', assignee: 'kevin' }, m),
    false,
  );
  assert.equal(
    cardSessionActionStillValid({ id: 'card-1', status: 'doing', assignee: 'dwight' }, m),
    true,
  );
});

test('validity: a clear whose card gained a sessionId is stale — a conversation already started; a late clear would wipe it', () => {
  const m = { cardId: 'card-1', agentId: 'dwight', kind: 'clear' };
  assert.equal(
    cardSessionActionStillValid(
      { id: 'card-1', status: 'doing', assignee: 'dwight', sessionId: 's' },
      m,
    ),
    false,
  );
});

test('validity: a resume is stale when the card re-stamped to a different session; unset or matching stays valid', () => {
  const m = { cardId: 'card-1', agentId: 'dwight', kind: 'resume', session: 'orig' };
  assert.equal(
    cardSessionActionStillValid(
      { id: 'card-1', status: 'doing', assignee: 'dwight', sessionId: 'other' },
      m,
    ),
    false,
  );
  assert.equal(
    cardSessionActionStillValid(
      { id: 'card-1', status: 'doing', assignee: 'dwight', sessionId: 'orig' },
      m,
    ),
    true,
  );
  assert.equal(
    cardSessionActionStillValid({ id: 'card-1', status: 'doing', assignee: 'dwight' }, m),
    true,
  );
});

test('validity: an adopt lead is stale when the card re-stamped elsewhere; unstamped stays valid', () => {
  const m = { cardId: 'card-1', agentId: 'dwight', kind: 'adopt', session: 'young' };
  assert.equal(
    cardSessionActionStillValid(
      { id: 'card-1', status: 'doing', assignee: 'dwight', sessionId: 'other' },
      m,
    ),
    false,
  );
  assert.equal(
    cardSessionActionStillValid({ id: 'card-1', status: 'doing', assignee: 'dwight' }, m),
    true,
  );
  assert.equal(
    cardSessionActionStillValid(
      { id: 'card-1', status: 'doing', assignee: 'dwight', sessionId: 'young' },
      m,
    ),
    true,
  );
});

// ——— adopt: the manual-clear race (the 22:05 wipe) ————————————————
// God can clear an agent's pane for this card's work 30s BEFORE flipping the
// card to doing (card blocked at clear time → the stamp correctly did not
// fire). The watcher must not queue ANOTHER clear for a conversation that is
// demonstrably fresh — it adopts it (lead only + stamp) instead of wiping it.

test('adopt: doing-flip with a YOUNG live session → lead only (no clear) + stamp the card', () => {
  const now = 1_000_000;
  const actions = cardSessionDecisions(
    [CARD()],
    { 'card-1': { status: 'todo' } },
    { dwight: 'fresh-conversation' },
    { dwight: 'claude' },
    { dwight: now - 25_000 }, // session started 25s ago (god's manual clear)
    now,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'adopt');
  assert.equal(actions[0].command, ''); // nothing typed as the command — lead only
  assert.equal(actions[0].session, 'fresh-conversation');
});

test('adopt: an OLD live session still gets the clear (the standing-engagement case the feature exists for)', () => {
  const now = 1_000_000;
  const actions = cardSessionDecisions(
    [CARD()],
    { 'card-1': { status: 'todo' } },
    { dwight: 'old-engagement' },
    { dwight: 'claude' },
    { dwight: now - 30 * 60_000 }, // 30min old
    now,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'clear');
});

test('adopt: unknown session age (pre-upgrade registry) behaves like the old clear path', () => {
  const actions = cardSessionDecisions(
    [CARD()],
    { 'card-1': { status: 'todo' } },
    { dwight: 's' },
    { dwight: 'claude' },
  );
  assert.equal(actions[0].kind, 'clear');
});

// ——— explicit --adopt (engagement-aware flips, 2026-08-17) —————————————
// `hive-card status <id> doing --adopt` stamps sessionMode:'adopt' on the
// card: the assignee's CURRENT conversation IS this card's engagement (a
// connected second card, a mid-work handoff) — lead only + stamp, NO clear,
// and NO age limit (the 2min heuristic is for implicit adoption only; god's
// explicit word beats any heuristic — root incident: Kevin's pane wiped at
// 17:36 because a connected card's flip defaulted to fresh).

test('explicit --adopt: lead only + stamp, regardless of conversation age', () => {
  const now = 1_000_000;
  const actions = cardSessionDecisions(
    [CARD({ sessionMode: 'adopt' })],
    { 'card-1': { status: 'todo' } },
    { dwight: 'old-standing-conversation' },
    { dwight: 'claude' },
    { dwight: now - 30 * 60_000 }, // 30min old — the young-session heuristic would clear
    now,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'adopt');
  assert.equal(actions[0].command, '', 'nothing typed as the command — the lead only');
  assert.equal(actions[0].session, 'old-standing-conversation');
});

test('explicit --adopt wins over the already-live no-op (re-adopt still leads)', () => {
  // blocked→doing re-flip with --adopt on a card already stamped to the live
  // conversation: without the marker this reads "already in session, nothing
  // to steer" — with it the card-title lead still goes out (an info line for
  // the second card of the engagement).
  const actions = cardSessionDecisions(
    [CARD({ sessionMode: 'adopt', sessionId: 'live-now' })],
    { 'card-1': { status: 'blocked' } },
    { dwight: 'live-now' },
    { dwight: 'claude' },
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'adopt');
  assert.equal(actions[0].command, '');
  assert.equal(actions[0].session, 'live-now');
});

test('explicit --adopt without a live conversation falls through to fresh (nothing to adopt)', () => {
  const actions = cardSessionDecisions(
    [CARD({ sessionMode: 'adopt' })],
    { 'card-1': { status: 'todo' } },
    { dwight: undefined }, // pane never reported a session
    { dwight: 'claude' },
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'clear');
});

// ——— idle-gated fresh clears (engagement-aware flips, 2026-08-17) ————————
// A pane-restarting command (/clear, /resume) must never fire at a BUSY pane
// (the assignee did real work inside vacationBusy's window — the house busy
// rule, same definition the vacation gate uses). The decision comes back
// DEFERRED: the command it WILL fire, but the tick must not emit yet — the
// transition stays pending and retries each tick until the pane goes quiet.

test('busy pane defers the fresh clear — action marked deferred, command kept', () => {
  const actions = cardSessionDecisions(
    [CARD()],
    { 'card-1': { status: 'todo' } },
    { dwight: 'old' },
    { dwight: 'claude' },
    {},
    1_000_000,
    { dwight: true },
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'clear');
  assert.equal(actions[0].command, '/clear', 'the command that WILL fire once idle');
  assert.equal(actions[0].deferred, true);
});

test('busy pane defers a resume too — same wipe hazard, same gate', () => {
  const actions = cardSessionDecisions(
    [CARD({ sessionId: 'card-session-uuid' })],
    { 'card-1': { status: 'todo' } },
    { dwight: 'a-different-live-session' },
    { dwight: 'claude' },
    {},
    1_000_000,
    { dwight: true },
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].deferred, true);
  assert.equal(actions[0].command, '/resume card-session-uuid');
});

test('busy pane does NOT defer an adopt lead (no pane-restart command, just an info line)', () => {
  const now = 1_000_000;
  const actions = cardSessionDecisions(
    [CARD({ sessionMode: 'adopt' })],
    { 'card-1': { status: 'todo' } },
    { dwight: 'live' },
    { dwight: 'claude' },
    { dwight: now - 10_000 },
    now,
    { dwight: true },
  );
  assert.equal(actions.length, 1);
  assert.notEqual(actions[0].deferred, true);
  assert.equal(actions[0].command, '');
});

test('idle pane (not in the busy map) behaves exactly as before — no deferral', () => {
  const actions = cardSessionDecisions(
    [CARD()],
    { 'card-1': { status: 'todo' } },
    { dwight: 'old' },
    { dwight: 'claude' },
    {},
    1_000_000,
    { kevin: true }, // someone ELSE is busy
  );
  assert.equal(actions.length, 1);
  assert.notEqual(actions[0].deferred, true);
});

// ——— the tick: ordering, retries, snapshot updates ————————————————————

function tmpHive() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-'));
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify({ tasks: [] }));
  return tmp;
}

function fakeDeps(tmp, agents = {}, emitResult = true) {
  const emitted = [];
  const informs = [];
  const stamped = [];
  let busy = false;
  return {
    deps: {
      root: () => tmp,
      registry: () => ({ agents }),
      emit: (agentId, text, marker) => {
        emitted.push({ agentId, text, marker });
        return emitResult;
      },
      informGod: (s, b) => informs.push({ subject: s, body: b }),
      stampCard: (cardId, sessionId) => stamped.push({ cardId, sessionId }),
      busy: () => busy,
    },
    emitted,
    informs,
    stamped,
    setBusy: (v) => {
      busy = v;
    },
  };
}

function setCards(tmp, tasks) {
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify({ tasks }));
}

test('tick: clear then lead are emitted in order; god is informed; snapshot advances', () => {
  const tmp = tmpHive();
  setCards(tmp, [CARD({ status: 'todo' })]);
  const { deps, emitted, informs } = fakeDeps(tmp, {
    dwight: { sessionId: 'old', provider: 'claude' },
  });
  const seen = {};
  cardSessionTick(deps, seen); // first tick: snapshot only
  assert.equal(emitted.length, 0);
  setCards(tmp, [CARD()]); // god flips it to doing
  cardSessionTick(deps, seen);
  assert.deepEqual(
    emitted.map((e) => e.text),
    [
      '/clear',
      'Card "Vacation state implementation" — this conversation is scoped to that kanban card; read your hive inbox for the full dispatch and act on it now.',
    ],
  );
  assert.equal(emitted[0].agentId, 'dwight');
  // Both the command and the lead carry the cardFor marker so the queue-drain
  // can stale-drop them at delivery (card-session-stamp-never-fires-20260816).
  assert.deepEqual(
    emitted.map((e) => e.marker && e.marker.cardId),
    ['card-1', 'card-1'],
  );
  assert.equal(emitted[0].marker.kind, 'clear');
  assert.ok(informs.some((i) => /clear queued for dwight/.test(i.subject)));
  cardSessionTick(deps, seen); // steady state: nothing new
  assert.equal(emitted.length, 2);
});

test('tick: adopt stamps the card through deps and emits ONLY the lead, with the adopt marker', () => {
  const tmp = tmpHive();
  setCards(tmp, [CARD({ status: 'todo' })]);
  const { deps, emitted, informs, stamped } = fakeDeps(tmp, {
    dwight: { sessionId: 'fresh', sessionStartedAt: Date.now() - 10_000, provider: 'claude' },
  });
  const seen = {};
  cardSessionTick(deps, seen); // snapshot
  setCards(tmp, [CARD()]); // → doing while a young conversation is live
  cardSessionTick(deps, seen);
  assert.equal(emitted.length, 1); // the lead, NOT a clear
  assert.ok(emitted[0].text.startsWith('Card "Vacation state implementation"'));
  assert.equal(emitted[0].marker.kind, 'adopt');
  assert.equal(emitted[0].marker.session, 'fresh');
  assert.deepEqual(stamped, [{ cardId: 'card-1', sessionId: 'fresh' }]);
  assert.ok(informs.some((i) => /adopt queued for dwight/.test(i.subject)));
});

// ——— tick: explicit --adopt + idle-gated deferral (engagement-aware) ——————

test('tick: explicit --adopt on an OLD conversation leads + stamps, no clear, mail states adopt', () => {
  const tmp = tmpHive();
  setCards(tmp, [CARD({ status: 'todo' })]);
  const { deps, emitted, informs, stamped } = fakeDeps(tmp, {
    dwight: {
      sessionId: 'old-engagement',
      sessionStartedAt: Date.now() - 30 * 60_000,
      provider: 'claude',
    },
  });
  const seen = {};
  cardSessionTick(deps, seen); // snapshot
  setCards(tmp, [CARD({ sessionMode: 'adopt' })]); // god: status <id> doing --adopt
  cardSessionTick(deps, seen);
  assert.equal(emitted.length, 1, 'the lead only — the pane keeps its conversation');
  assert.ok(emitted[0].text.startsWith('Card "Vacation state implementation"'));
  assert.equal(emitted[0].marker.kind, 'adopt');
  assert.deepEqual(stamped, [{ cardId: 'card-1', sessionId: 'old-engagement' }]);
  const mail = informs.find((i) => /adopt queued for dwight/.test(i.subject));
  assert.ok(mail, 'god is informed');
  assert.match(mail.body, /mode: adopt/, 'the notice mail states the mode');
  cardSessionTick(deps, seen); // steady state
  assert.equal(emitted.length, 1);
});

test('tick: busy pane defers the fresh clear; fires with a fresh-deferred (fired at HH:MM) notice once quiet', () => {
  const tmp = tmpHive();
  setCards(tmp, [CARD({ status: 'todo' })]);
  const { deps, emitted, informs, setBusy } = fakeDeps(tmp, {
    dwight: { sessionId: 'old', provider: 'claude' },
  });
  const seen = {};
  cardSessionTick(deps, seen); // snapshot
  setBusy(true); // dwight is mid-work (vacationBusy's rule)
  setCards(tmp, [CARD()]); // god flips to doing (default --fresh)
  cardSessionTick(deps, seen);
  assert.equal(emitted.length, 0, 'nothing typed into a busy pane');
  assert.ok(
    !informs.some((i) => /queued for dwight/.test(i.subject)),
    'no fire notice while deferred (the mode is stated when it fires)',
  );
  // The pane goes quiet → the deferred clear fires with the deferred notice.
  setBusy(false);
  cardSessionTick(deps, seen);
  assert.deepEqual(emitted.map((e) => e.text).slice(0, 1), ['/clear']);
  const fire = informs.find((i) => /clear queued for dwight/.test(i.subject));
  assert.ok(fire, 'god is informed at fire time');
  assert.match(
    fire.body,
    /fresh-deferred \(fired at \d{2}:\d{2}\)/,
    'the notice states the deferred mode and the fire time',
  );
  cardSessionTick(deps, seen); // steady state — no second fire
  assert.equal(emitted.length, 2);
});

test('tick: an idle pane at flip time fires fresh immediately (mode: fresh, no deferral noise)', () => {
  const tmp = tmpHive();
  setCards(tmp, [CARD({ status: 'todo' })]);
  const { deps, emitted, informs } = fakeDeps(tmp, {
    dwight: { sessionId: 'old', provider: 'claude' },
  });
  const seen = {};
  cardSessionTick(deps, seen); // snapshot
  setCards(tmp, [CARD()]);
  cardSessionTick(deps, seen);
  assert.equal(emitted.length, 2);
  const mail = informs.find((i) => /clear queued for dwight/.test(i.subject));
  assert.ok(mail);
  assert.match(mail.body, /mode: fresh/);
  assert.doesNotMatch(mail.body, /deferred/);
});

test('tick: failed emit leaves the card unseen → retries next tick; others still advance', () => {
  const tmp = tmpHive();
  setCards(tmp, [CARD({ id: 'a', status: 'todo' }), CARD({ id: 'b', status: 'todo' })]);
  const { deps, emitted, informs } = fakeDeps(
    tmp,
    { dwight: { sessionId: 'old', provider: 'claude' } },
    false,
  );
  const seen = {};
  cardSessionTick(deps, seen); // snapshot
  setCards(tmp, [CARD({ id: 'a' }), CARD({ id: 'b' })]);
  cardSessionTick(deps, seen); // both fail to emit (the label never even queues)
  assert.ok(emitted.every((e) => e.text === '/clear'));
  assert.ok(informs.some((i) => /not delivered/.test(i.subject)));
  // Re-arm the window: both transitions were left unseen → both retry, complete
  // (command + label each), in card order.
  deps.emit = (agentId, text) => {
    emitted.push({ agentId, text });
    return true;
  };
  cardSessionTick(deps, seen);
  assert.deepEqual(
    emitted.map((e) => e.text),
    [
      '/clear',
      '/clear', // the failed attempts (spy records them)
      '/clear',
      CARD().title &&
        `Card "Vacation state implementation" — this conversation is scoped to that kanban card; read your hive inbox for the full dispatch and act on it now.`,
      '/clear',
      `Card "Vacation state implementation" — this conversation is scoped to that kanban card; read your hive inbox for the full dispatch and act on it now.`,
    ],
  );
  cardSessionTick(deps, seen); // steady state — no third round
  assert.equal(emitted.length, 6);
});

// ——— the stamp: recordSession → active doing-card tracks the conversation —

test('stamp: a session change lands on the agent’s active doing card (and only that)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  const root = path.join(tmp, 'hive'); // root() = <home>/hive by construction
  fs.mkdirSync(root, { recursive: true });
  // Minimal hand-built hive: registry with the agent, tasks with a doing card.
  fs.writeFileSync(
    path.join(root, 'registry.json'),
    JSON.stringify({
      godId: 'god',
      agents: {
        dwight: {
          id: 'dwight',
          name: 'Dwight',
          cwd: '/w',
          status: 'idle',
          lastSeen: 0,
          sessionId: 'old',
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'tasks.json'),
    JSON.stringify({
      tasks: [
        CARD({ id: 'active', status: 'doing' }),
        CARD({ id: 'paused', status: 'todo', sessionId: 'paused-session' }),
        CARD({ id: 'other-guy', assignee: 'kevin', status: 'doing' }),
      ],
    }),
  );
  const hive = new HiveManager(() => tmp);
  hive.recordSession('dwight', 'new-conversation');
  const tasks = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks;
  assert.equal(tasks.find((t) => t.id === 'active').sessionId, 'new-conversation');
  assert.equal(tasks.find((t) => t.id === 'paused').sessionId, 'paused-session'); // untouched
  assert.equal(tasks.find((t) => t.id === 'other-guy').sessionId, undefined); // other agent untouched
  // The session START time lands too — the watcher's adopt rule (young-session
  // check) needs to know when the current conversation began.
  const reg = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
  assert.equal(typeof reg.agents.dwight.sessionStartedAt, 'number');
  // Unchanged session → no rewrite (idempotent no-op path).
  hive.recordSession('dwight', 'new-conversation');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks.find(
      (t) => t.id === 'active',
    ).sessionId,
    'new-conversation',
  );
});

test('stampCard: stamps exactly the named card (the watcher’s adopt path)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stampcard-'));
  const root = path.join(tmp, 'hive');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ godId: 'god', agents: {} }));
  fs.writeFileSync(
    path.join(root, 'tasks.json'),
    JSON.stringify({
      tasks: [CARD({ id: 'a', status: 'doing' }), CARD({ id: 'b', status: 'todo' })],
    }),
  );
  const hive = new HiveManager(() => tmp);
  hive.stampCard('a', 'adopted-session');
  const tasks = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks;
  assert.equal(tasks.find((t) => t.id === 'a').sessionId, 'adopted-session');
  assert.equal(tasks.find((t) => t.id === 'b').sessionId, undefined);
});
