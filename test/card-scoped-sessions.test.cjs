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
const { HiveManager } = loadTs('src/main/hive.ts');

const CARD = (over = {}) => ({
  id: 'card-1', title: 'Vacation state implementation', assignee: 'dwight',
  status: 'doing', ...over
});

// ——— the pure transition engine ——————————————————————————————————————

test('NEW card (no sessionId) → provider clear + card-title lead', () => {
  const [a] = cardSessionDecisions(
    [CARD()],
    { 'card-1': { status: 'todo' } },
    { dwight: 'old-session' },
    { dwight: 'claude' }
  );
  assert.equal(a.kind, 'clear');
  assert.equal(a.command, '/clear');
  assert.equal(a.agentId, 'dwight');
  assert.ok(a.label.startsWith('Card "Vacation state implementation"'), 'lead names the card');
});

test('grok assignee gets the provider clear (/new), not claude /clear', () => {
  const [a] = cardSessionDecisions(
    [CARD()], { 'card-1': { status: 'todo' } }, { dwight: 'x' }, { dwight: 'grok' }
  );
  assert.equal(a.command, '/new');
});

test('PAUSED card returning (stamp ≠ live session) → /resume <stamp> + lead', () => {
  const [a] = cardSessionDecisions(
    [CARD({ sessionId: 'card-session-uuid' })],
    { 'card-1': { status: 'todo' } },
    { dwight: 'a-different-live-session' },
    { dwight: 'claude' }
  );
  assert.equal(a.kind, 'resume');
  assert.equal(a.command, '/resume card-session-uuid');
});

test('card whose session is already live → no-op (already in that conversation)', () => {
  const actions = cardSessionDecisions(
    [CARD({ sessionId: 'live-now' })],
    { 'card-1': { status: 'todo' } },
    { dwight: 'live-now' },
    { dwight: 'claude' }
  );
  assert.equal(actions.length, 0);
});

test('FIRST TICK (card unseen) → nothing — a restart never re-clears a working pane', () => {
  const actions = cardSessionDecisions(
    [CARD()], {}, // empty seen = first tick after boot
    { dwight: 's' }, { dwight: 'claude' }
  );
  assert.equal(actions.length, 0);
});

test('no transition to doing (still todo / still doing / → done) → nothing', () => {
  const reg = { dwight: 's' }, prov = { dwight: 'claude' };
  assert.equal(cardSessionDecisions([CARD({ status: 'todo' })], { 'card-1': { status: 'todo' } }, reg, prov).length, 0);
  assert.equal(cardSessionDecisions([CARD()], { 'card-1': { status: 'doing' } }, reg, prov).length, 0);
  assert.equal(cardSessionDecisions([CARD({ status: 'done' })], { 'card-1': { status: 'doing' } }, reg, prov).length, 0);
});

test('card without assignee never steers anything', () => {
  const actions = cardSessionDecisions(
    [CARD({ assignee: undefined })], { 'card-1': { status: 'todo' } }, {}, {}
  );
  assert.equal(actions.length, 0);
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
  return {
    deps: {
      root: () => tmp,
      registry: () => ({ agents }),
      emit: (agentId, text) => { emitted.push({ agentId, text }); return emitResult; },
      informGod: (s, b) => informs.push({ subject: s, body: b })
    },
    emitted, informs
  };
}

function setCards(tmp, tasks) {
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify({ tasks }));
}

test('tick: clear then lead are emitted in order; god is informed; snapshot advances', () => {
  const tmp = tmpHive();
  setCards(tmp, [CARD({ status: 'todo' })]);
  const { deps, emitted, informs } = fakeDeps(tmp, { dwight: { sessionId: 'old', provider: 'claude' } });
  const seen = {};
  cardSessionTick(deps, seen); // first tick: snapshot only
  assert.equal(emitted.length, 0);
  setCards(tmp, [CARD()]); // god flips it to doing
  cardSessionTick(deps, seen);
  assert.deepEqual(emitted.map((e) => e.text), ['/clear',
    'Card "Vacation state implementation" — this conversation is scoped to that kanban card; read your hive inbox for the full dispatch and act on it now.']);
  assert.equal(emitted[0].agentId, 'dwight');
  assert.ok(informs.some((i) => /clear queued for dwight/.test(i.subject)));
  cardSessionTick(deps, seen); // steady state: nothing new
  assert.equal(emitted.length, 2);
});

test('tick: failed emit leaves the card unseen → retries next tick; others still advance', () => {
  const tmp = tmpHive();
  setCards(tmp, [CARD({ id: 'a', status: 'todo' }), CARD({ id: 'b', status: 'todo' })]);
  const { deps, emitted, informs } = fakeDeps(tmp, { dwight: { sessionId: 'old', provider: 'claude' } }, false);
  const seen = {};
  cardSessionTick(deps, seen); // snapshot
  setCards(tmp, [CARD({ id: 'a' }), CARD({ id: 'b' })]);
  cardSessionTick(deps, seen); // both fail to emit (the label never even queues)
  assert.ok(emitted.every((e) => e.text === '/clear'));
  assert.ok(informs.some((i) => /not delivered/.test(i.subject)));
  // Re-arm the window: both transitions were left unseen → both retry, complete
  // (command + label each), in card order.
  deps.emit = (agentId, text) => { emitted.push({ agentId, text }); return true; };
  cardSessionTick(deps, seen);
  assert.deepEqual(emitted.map((e) => e.text), [
    '/clear', '/clear', // the failed attempts (spy records them)
    '/clear', CARD().title && `Card "Vacation state implementation" — this conversation is scoped to that kanban card; read your hive inbox for the full dispatch and act on it now.`,
    '/clear', `Card "Vacation state implementation" — this conversation is scoped to that kanban card; read your hive inbox for the full dispatch and act on it now.`
  ]);
  cardSessionTick(deps, seen); // steady state — no third round
  assert.equal(emitted.length, 6);
});

// ——— the stamp: recordSession → active doing-card tracks the conversation —

test('stamp: a session change lands on the agent’s active doing card (and only that)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  const root = path.join(tmp, 'hive'); // root() = <home>/hive by construction
  fs.mkdirSync(root, { recursive: true });
  // Minimal hand-built hive: registry with the agent, tasks with a doing card.
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({
    godId: 'god',
    agents: { dwight: { id: 'dwight', name: 'Dwight', cwd: '/w', status: 'idle', lastSeen: 0, sessionId: 'old' } }
  }));
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [
    CARD({ id: 'active', status: 'doing' }),
    CARD({ id: 'paused', status: 'todo', sessionId: 'paused-session' }),
    CARD({ id: 'other-guy', assignee: 'kevin', status: 'doing' })
  ] }));
  const hive = new HiveManager(() => tmp);
  hive.recordSession('dwight', 'new-conversation');
  const tasks = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks;
  assert.equal(tasks.find((t) => t.id === 'active').sessionId, 'new-conversation');
  assert.equal(tasks.find((t) => t.id === 'paused').sessionId, 'paused-session'); // untouched
  assert.equal(tasks.find((t) => t.id === 'other-guy').sessionId, undefined); // other agent untouched
  // Unchanged session → no rewrite (idempotent no-op path).
  hive.recordSession('dwight', 'new-conversation');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks.find((t) => t.id === 'active').sessionId, 'new-conversation');
});
