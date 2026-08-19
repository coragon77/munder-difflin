'use strict';

/**
 * God has to know the LIVE floor across its own restarts — a roster it read once
 * goes stale, and it then messages agents that were archived or killed. So the
 * roster is PUSHED into god's context (SessionStart + every prompt) rather than
 * pulled.
 *
 * Only one `additionalContext` may be returned per hook, so the roster and the
 * operator-steer path must MERGE — otherwise they silently displace each other.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// hooks.ts pulls Notification from electron; outside Electron that resolve gives
// a path string, so seed the cache with the surface the server actually touches.
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    Notification: class {
      show() {}
      static isSupported() {
        return false;
      }
    },
  },
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const CONFIG = { notifications: false };

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-roster-inj-'));
}

async function floor(t, { steer } = {}) {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: home,
    isGod: true,
  });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });

  const control = steer
    ? {
        takeSteer: (id) => (id === 'god-1' ? steer : null),
        shouldHalt: () => false,
        toolDecision: () => ({ deny: false }),
      }
    : undefined;
  const server = new HookServer(
    hive,
    () => null,
    () => CONFIG,
    control,
    undefined,
  );
  const fire = (agent_id, hook_event_name) =>
    server.handle({ agent_id, hook_event_name, session_id: 's1' });
  return { home, hive, server, fire };
}

function snapshot(hive, over = {}) {
  hive.writeFleetSnapshot({
    ts: Date.now() - 4000,
    ...over,
    agents: over.agents ?? [
      {
        id: 'god-1',
        name: 'Michael',
        role: 'orchestrator',
        isGod: true,
        breaker: 'ok',
        tokens: 812_400,
        usd: 4.2199,
        lastActiveSecAgo: 6,
        inboxBacklog: 2,
      },
      {
        id: 'jim-1',
        name: 'Jim',
        role: 'agent',
        breaker: 'warn',
        tokens: 120_401,
        usd: 1.0231,
        lastActiveSecAgo: 240,
        inboxBacklog: 0,
      },
      {
        id: 'pam-1',
        name: 'Pam',
        role: 'agent',
        breaker: 'ok',
        tokens: 0,
        usd: 0,
        lastActiveSecAgo: null,
        inboxBacklog: 0,
      },
    ],
  });
}

const context = (res) => res?.hookSpecificOutput?.additionalContext ?? '';

test('the roster line carries the whole floor and its state', async (t) => {
  const { hive } = await floor(t);
  assert.equal(hive.rosterContext(), null, 'no snapshot yet — inject nothing rather than noise');

  snapshot(hive);
  const line = hive.rosterContext();

  assert.ok(!line.includes('\n'), 'must stay a single compact line');
  for (const id of ['god-1', 'jim-1', 'pam-1']) assert.ok(line.includes(id), `missing ${id}`);
  assert.match(line, /812k tok/);
  assert.match(line, /\$4\.22/);
  assert.match(line, /inbox 2/);
  assert.match(line, /breaker warn/);
  assert.match(line, /god-1[^;]*you/, 'god has to be able to spot itself');
  assert.match(line, /no activity yet/, 'an agent that never ran must not read as "active never"');
  assert.match(line, /SUPERSEDES/, 'the point is to override what god remembers');
  assert.ok(line.length < 1200, `too long for a 3-agent floor: ${line.length} chars`);
});

test('an unknown role LOOKS unknown — never a placeholder that reads like a description (registry-role-overwrite incident 2026-08-19)', async (t) => {
  const { hive } = await floor(t);
  snapshot(hive, {
    agents: [
      {
        id: 'jim-1',
        name: 'Jim',
        // no role — a wiped/never-set registry field
        breaker: 'ok',
        tokens: 0,
        usd: 0,
        lastActiveSecAgo: null,
        inboxBacklog: 0,
      },
    ],
    vacation: [{ id: 'ryan-1', name: 'Ryan', cwd: '/tmp', parkedAt: null }],
  });

  const line = hive.rosterContext();

  // The misroute happened because the gap rendered as plausible text; the
  // marker must be unambiguous in BOTH the active list and the fetchable pool.
  assert.match(line, /jim-1[^;]*role: unknown/);
  assert.match(line, /ryan-1[^;]*role: unknown/);
  assert.ok(!/\(agent\)/.test(line), 'no bare "agent" placeholder that reads like a role');
});

test('god gets the roster on SessionStart and on every prompt — nobody else does', async (t) => {
  const { hive, fire } = await floor(t);
  snapshot(hive);

  const start = await fire('god-1', 'SessionStart');
  assert.match(context(start), /LIVE ROSTER/);
  assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(context(await fire('god-1', 'UserPromptSubmit')), /LIVE ROSTER/);

  assert.doesNotMatch(context(await fire('jim-1', 'SessionStart')), /LIVE ROSTER/);
  assert.doesNotMatch(context(await fire('jim-1', 'UserPromptSubmit')), /LIVE ROSTER/);
  assert.doesNotMatch(
    context(await fire('god-1', 'PostToolUse')),
    /LIVE ROSTER/,
    'prompt boundaries only — not once per tool call',
  );
});

test('the ACTIONABLE board line rides the god-only injection (card agent-actionablecards-one-shar-2026-08-18)', async (t) => {
  const { hive, fire } = await floor(t);
  snapshot(hive);
  hive.writeTasks([
    {
      id: 'agent-free-2026-08-18',
      title: 'Unowned unpaused todo',
      status: 'todo',
      dependsOn: [],
      priority: 3,
      createdAt: new Date().toISOString(),
      origin: 'human',
    },
    {
      id: 'agent-held-2026-08-18',
      title: 'Operator hold',
      status: 'todo',
      paused: true,
      dependsOn: [],
      priority: 3,
      createdAt: new Date().toISOString(),
      origin: 'human',
    },
  ]);
  // Through the REAL hook chain (HookServer.handle → rosterContext), not
  // just rosterContext directly: the state must reach god's additionalContext
  // on every prompt, slim line included — the whole point of the card.
  assert.match(
    context(await fire('god-1', 'SessionStart')),
    /ACTIONABLE: 1 - agent-free-2026-08-18\./,
  );
  assert.match(
    context(await fire('god-1', 'UserPromptSubmit')),
    /ACTIONABLE: 1 - agent-free-2026-08-18\./,
  );
});

test('a queued operator steer is not swallowed by the roster', async (t) => {
  const steer = 'OPERATOR: stop and summarize.';
  const { hive, fire } = await floor(t, { steer });
  snapshot(hive);

  const ctx = context(await fire('god-1', 'UserPromptSubmit'));
  assert.match(ctx, /LIVE ROSTER/);
  assert.ok(
    ctx.includes(steer),
    'only one additionalContext exists — the two must merge, not race',
  );
});

// ── steady state is SLIM (card agent-harness-slim-god-s-per-t-2026-08-17) ────
// The full block is only worth its ~600 tokens when the floor actually MOVED.
// Every other turn god gets the ids + their state, the seat count and the
// vacation COUNT — enough to route, ~a quarter of the tokens.

const FLEET = {
  floor: { maxAgents: 16, onFloor: 3, freeSeats: 13 },
  vacation: [
    { id: 'creed-1', name: 'Creed', role: 'agent' },
    { id: 'toby-1', name: 'Toby', role: 'agent' },
  ],
};

test('the second injection to the same agent is the slim line', async (t) => {
  const { hive } = await floor(t);
  snapshot(hive, FLEET);

  const first = hive.rosterContext('god-1');
  assert.match(first, /SUPERSEDES/, 'first injection of a session is the full block');

  const slim = hive.rosterContext('god-1');
  assert.match(slim, /^\[LIVE ROSTER/, 'same marker — it is still the live floor');
  assert.match(slim, /unchanged/i);
  assert.doesNotMatch(slim, /SUPERSEDES/, 'the long standing orders ride the full block only');

  // Still enough to route: every active id, its state, seats, vacation COUNT.
  for (const id of ['god-1', 'jim-1', 'pam-1']) assert.ok(slim.includes(id), `missing ${id}`);
  assert.match(slim, /inbox 2/);
  assert.match(slim, /breaker warn/);
  assert.match(slim, /3\/16/, 'floor seats are the fan-out budget — always live');
  assert.match(slim, /VACATION 2/, 'the pool is a COUNT here, not a name list');
  assert.doesNotMatch(slim, /Creed/, 'names cost tokens; fleet.json has them');
  assert.doesNotMatch(slim, /812k tok/, 'spend telemetry is not routing state');

  assert.ok(slim.length < first.length / 2, `slim (${slim.length}) must undercut full`);
  assert.ok(Math.ceil(slim.length / 4) < 200, `over budget: ~${Math.ceil(slim.length / 4)} tokens`);
});

test('a join, a leave, a park or a breaker flip re-emits the full block', async (t) => {
  const { hive } = await floor(t);
  const rows = () => [
    { id: 'god-1', name: 'Michael', role: 'orchestrator', isGod: true, breaker: 'ok' },
    { id: 'jim-1', name: 'Jim', role: 'agent', breaker: 'ok' },
  ];
  const settle = () => {
    hive.rosterContext('god-1');
    assert.doesNotMatch(hive.rosterContext('god-1'), /SUPERSEDES/, 'should be settled by now');
  };

  snapshot(hive, { ...FLEET, agents: rows() });
  settle();

  // join
  snapshot(hive, { ...FLEET, agents: [...rows(), { id: 'pam-1', name: 'Pam', breaker: 'ok' }] });
  assert.match(hive.rosterContext('god-1'), /SUPERSEDES/, 'a new hire must land in full');
  settle();

  // leave
  snapshot(hive, { ...FLEET, agents: rows() });
  assert.match(hive.rosterContext('god-1'), /SUPERSEDES/, 'an archived agent must land in full');
  settle();

  // park / recall — the vacation pool is part of the roster
  snapshot(hive, { ...FLEET, vacation: [{ id: 'creed-1', name: 'Creed' }], agents: rows() });
  assert.match(hive.rosterContext('god-1'), /SUPERSEDES/, 'a park must land in full');
  settle();

  // status flip
  snapshot(hive, {
    ...FLEET,
    vacation: [{ id: 'creed-1', name: 'Creed' }],
    agents: [rows()[0], { ...rows()[1], breaker: 'steer' }],
  });
  assert.match(hive.rosterContext('god-1'), /SUPERSEDES/, 'a breaker flip must land in full');
});

test('churn that is not roster state (tokens, activity, inbox) stays slim', async (t) => {
  const { hive } = await floor(t);
  const rows = (over) => [
    { id: 'god-1', name: 'Michael', isGod: true, breaker: 'ok', lastActiveSecAgo: 4 },
    { id: 'jim-1', name: 'Jim', breaker: 'ok', tokens: 1000, inboxBacklog: 0, ...over },
  ];
  snapshot(hive, { ...FLEET, agents: rows() });
  hive.rosterContext('god-1');

  snapshot(hive, { ...FLEET, agents: rows({ tokens: 90_000, lastActiveSecAgo: 900 }) });
  assert.doesNotMatch(hive.rosterContext('god-1'), /SUPERSEDES/, 'spend is not a roster change');

  snapshot(hive, { ...FLEET, agents: rows({ inboxBacklog: 3 }) });
  const slim = hive.rosterContext('god-1');
  assert.doesNotMatch(slim, /SUPERSEDES/, 'mail arriving is not a roster change');
  assert.match(slim, /inbox 3/, 'but the slim line still carries it');
});

test('SessionStart always re-emits the full block', async (t) => {
  const { hive, fire } = await floor(t);
  snapshot(hive, FLEET);

  assert.match(context(await fire('god-1', 'SessionStart')), /SUPERSEDES/);
  assert.doesNotMatch(
    context(await fire('god-1', 'UserPromptSubmit')),
    /SUPERSEDES/,
    'steady state on the prompt boundary',
  );
  // A fresh session resumes a transcript that has none of this — full again.
  assert.match(
    context(await fire('god-1', 'SessionStart')),
    /SUPERSEDES/,
    'a new session has no roster in its transcript, changed or not',
  );
});

test('a corrupt fleet.json degrades to no injection instead of throwing into a hook', async (t) => {
  const { home, hive, fire } = await floor(t);
  snapshot(hive);
  fs.writeFileSync(path.join(home, 'hive', 'fleet.json'), '{ not json');

  assert.equal(hive.rosterContext(), null);
  const res = await fire('god-1', 'SessionStart');
  assert.doesNotMatch(context(res), /LIVE ROSTER/);
});
