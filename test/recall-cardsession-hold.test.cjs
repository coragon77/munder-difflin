'use strict';

/**
 * RECALLED PANE DRAINS ITS DISPATCH (card agent-recalled-pane-resumes-it-2026-08-18).
 *
 * Incident (Jim, 2026-08-18, all VERIFIED on the live hive): a dispatch to a
 * PARKED agent flips the card to doing, mails the contract, and queues the
 * recall. The card-session watcher saw the flip and emitted the card-scoped
 * clear + lead — but the assignee was still parked, so the renderer's
 * realtime:enqueue handler (useHive 5c) SILENTLY DROPPED both messages (no
 * floor card for a parked agent), while paneCommandEmit had already returned
 * true and the watcher consumed the transition. The recall then spawned the
 * pane with resume:true — the agent's OWN old conversation — and the clear
 * that should have started the card-scoped fresh conversation was gone
 * forever: card.sessionId never stamped, no first turn to arm the inbox
 * monitor on, dispatch mail unread until a standup noticed.
 *
 * The fix pinned here: the tick treats an assignee with NO live pane exactly
 * like a busy pane — the transition stays PENDING (no emit, no god notice,
 * nothing consumed) and re-decides every tick, so the clear + lead fire AFTER
 * the recall spawn brings the pane up. A /clear typed into a resumed pane
 * still wins (resume is argv; the clear is just input — vacationFlow's own
 * contract), the card lead becomes the fresh conversation's first turn, and
 * the monitor-arming text that rides every spawn's system-prompt injection
 * finally has a turn to act on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { cardSessionTick } = loadTs('src/main/cardSessions.ts');

const CARD = (over = {}) => ({
  id: 'card-1',
  title: 'Resolve the sync key scope regression',
  assignee: 'jim',
  status: 'doing',
  ...over,
});

function tmpHive() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-hold-'));
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify({ tasks: [] }));
  return tmp;
}

/** Fake deps mirroring card-scoped-sessions.test.cjs, plus a PANE toggle —
 *  ptyForAgent(id) returns a pty id only while the simulated recall spawn is
 *  up. `busy` stays wired so the two hold reasons compose. */
function fakeDeps(tmp, agents = {}) {
  const emitted = [];
  const informs = [];
  const stamped = [];
  const state = { pane: false, busy: false };
  return {
    deps: {
      root: () => tmp,
      registry: () => ({ agents }),
      ptyForAgent: (id) => (state.pane ? `pty-${id}` : undefined),
      emit: (agentId, text, marker) => {
        emitted.push({ agentId, text, marker });
        return true;
      },
      informGod: (s, b) => informs.push({ subject: s, body: b }),
      stampCard: (cardId, sessionId) => stamped.push({ cardId, sessionId }),
      busy: (id) => state.busy,
    },
    emitted,
    informs,
    stamped,
    state,
  };
}

function setCards(tmp, tasks) {
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify({ tasks }));
}

test('pane-less assignee: the doing-flip holds pending — no emit, no god notice, nothing consumed', () => {
  const tmp = tmpHive();
  const { deps, emitted, informs, state } = fakeDeps(tmp, {
    jim: { sessionId: 'old-session', provider: 'claude' },
  });
  const seen = {};
  setCards(tmp, [CARD({ status: 'todo' })]); // seed while parked so the first tick snapshots it
  cardSessionTick(deps, seen); // first tick: snapshot only
  setCards(tmp, [CARD()]); // god flips to doing while jim is still PARKED
  cardSessionTick(deps, seen);
  // The emit channel CANNOT reach a cardless agent (the renderer drops it
  // silently), so firing here is the silent-loss bug — hold instead.
  assert.equal(emitted.length, 0, 'nothing is emitted while the assignee has no pane');
  assert.equal(informs.length, 0, 'no notice either — the hold is invisible until it fires');
  cardSessionTick(deps, seen); // still parked next tick: STILL pending
  assert.equal(emitted.length, 0, 'the transition is not consumed by a failed delivery');
  // The recall spawn lands: pane up, idle.
  state.pane = true;
  cardSessionTick(deps, seen);
  assert.deepEqual(
    emitted.map((e) => e.text),
    [
      '/clear',
      'Card "Resolve the sync key scope regression" — this conversation is scoped to that kanban card; read your hive inbox for the full dispatch and act on it now.',
    ],
    'the held clear + card lead fire the moment the recalled pane exists — the fresh card conversation starts, which is what re-arms the inbox monitor',
  );
  assert.equal(emitted[0].marker.kind, 'clear');
  assert.ok(
    informs.some((i) => /clear queued for jim/.test(i.subject)),
    'god hears about the eventual fire',
  );
  cardSessionTick(deps, seen); // steady state: delivered once, never again
  assert.equal(emitted.length, 2);
});

test('pane present the whole time: today’s behavior unchanged (fires on the flip tick)', () => {
  const tmp = tmpHive();
  const { deps, emitted, state } = fakeDeps(tmp, { jim: { sessionId: 'old', provider: 'claude' } });
  const seen = {};
  state.pane = true;
  setCards(tmp, [CARD({ status: 'todo' })]);
  cardSessionTick(deps, seen); // snapshot
  setCards(tmp, [CARD()]);
  cardSessionTick(deps, seen);
  assert.equal(emitted.length, 2, 'clear + lead fire immediately for a live assignee');
});

test('no-pane hold composes with the busy hold: pane up but busy stays pending until idle', () => {
  const tmp = tmpHive();
  const { deps, emitted, state } = fakeDeps(tmp, {
    jim: { sessionId: 'old-session', provider: 'claude' },
  });
  const seen = {};
  setCards(tmp, [CARD({ status: 'todo' })]);
  cardSessionTick(deps, seen); // snapshot
  setCards(tmp, [CARD()]); // flip while parked
  state.pane = true; // ...and the recalled pane is busy resuming its transcript
  state.busy = true;
  cardSessionTick(deps, seen);
  assert.equal(emitted.length, 0, 'busy pane holds the clear (engagement-aware flips)');
  state.busy = false;
  cardSessionTick(deps, seen);
  assert.equal(emitted.length, 2, 'fires once the recalled pane is both up and quiet');
});
