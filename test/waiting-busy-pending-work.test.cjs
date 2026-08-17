'use strict';

/**
 * waiting-busy-pending-work (card agent-harness-busy-signal-coun-2026-08-17).
 *
 * Live incident class: Kevin arms a one-shot CI monitor, settles at the prompt,
 * and the harness reads him IDLE (telemetry silent, pane quiet) — so the
 * idle-gated clear fires and wipes the conversation the monitor was going to
 * wake. Exactly the context wipe the idle gate was built to prevent.
 *
 * The fix: busy = recentActivity OR pendingFiniteBackgroundWork. The census
 * comes from claude's own Stop payload, which carries `background_tasks` — a
 * live snapshot of its task registry (types: shell, subagent, workflow,
 * monitor, MCP task, teammate, dream, auto-mode scan, cloud session), already
 * filtered upstream to running+backgrounded. Persistent monitors (the
 * inbox-wake loop every agent arms) are EXCLUDED by the taskId learned at arm
 * time from PostToolUse(Monitor).tool_response.persistent — counting them
 * would make the whole floor permanently busy and no clear/park would ever
 * fire. Anything the harness cannot classify COUNTS (safe direction: a
 * deferred clear costs minutes, a fired one costs a context).
 *
 * Pure decision in vacationBusy() + PendingWorkTracker (pendingWork.ts)
 * because index.ts is the Electron main entry and untestable from this
 * harness (vacationBusy precedent).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { vacationBusy } = loadTs('src/main/vacationBusy.ts');
const { PendingWorkTracker, PENDING_CENSUS_TTL_MS } = loadTs('src/main/pendingWork.ts');

// ——— vacationBusy: the third input ————————————————————————————————————————

test('pending background work makes a telemetry-idle agent busy (the incident)', () => {
  // Telemetry 5min stale, pane quiet — the old gate says parkable/idle. With
  // one CI monitor pending the agent is WAITING, not idle.
  assert.equal(vacationBusy(5 * 60_000, 5 * 60_000, true, 1), true);
  assert.equal(
    vacationBusy(undefined, undefined, false, 1),
    true,
    'no signals at all, work pending → busy',
  );
});

test('zero pending work changes nothing (pure extension, not a fork)', () => {
  assert.equal(vacationBusy(5 * 60_000, 50, true, 0), false);
  assert.equal(vacationBusy(5_000, 120_000, true, 0), true);
  assert.equal(vacationBusy(undefined, 2_000, true, 0), false);
  assert.equal(vacationBusy(undefined, 2_000, false, 0), true);
});

// ——— the census itself —————————————————————————————————————————————————————

const task = (over) => ({ id: 't1', type: 'shell', status: 'running', description: 'ci', ...over });

test('a Stop settle with finite background tasks counts them', () => {
  const tr = new PendingWorkTracker();
  tr.recordSettle('kevin', [task({ id: 'b1' }), task({ id: 'b2', type: 'monitor' })]);
  assert.equal(tr.countFor('kevin'), 2);
});

test('empty settle → zero (the honest idle)', () => {
  const tr = new PendingWorkTracker();
  tr.recordSettle('kevin', []);
  assert.equal(tr.countFor('kevin'), 0);
});

test('persistent monitors are excluded — the floor must not go permanently busy', () => {
  const tr = new PendingWorkTracker();
  // Arm-time classification: PostToolUse(Monitor).tool_response carries
  // taskId + persistent. The inbox-wake loop arms persistent:true.
  tr.recordMonitorArm('kevin', 'mon-inbox', true);
  tr.recordSettle('kevin', [
    task({ id: 'mon-inbox', type: 'monitor' }),
    task({ id: 'mon-ci', type: 'monitor' }),
  ]);
  assert.equal(tr.countFor('kevin'), 1, 'inbox monitor excluded, one-shot CI monitor counts');
});

test('unclassifiable task types COUNT (safe direction)', () => {
  const tr = new PendingWorkTracker();
  tr.recordSettle('kevin', [
    task({ id: 'x1', type: 'dream' }),
    task({ id: 'x2', type: 'auto-mode scan' }),
    task({ id: 'x3', type: 'something-new-in-2.2' }),
  ]);
  assert.equal(tr.countFor('kevin'), 3);
});

test('garbage payloads never throw and read as zero', () => {
  const tr = new PendingWorkTracker();
  tr.recordSettle('kevin', undefined);
  tr.recordSettle('kevin', 'nonsense');
  tr.recordSettle('kevin', [null, 42, {}]);
  assert.equal(tr.countFor('kevin'), 3, 'shapeless entries count — they might be work');
  tr.recordSettle('kevin', []);
  assert.equal(tr.countFor('kevin'), 0);
});

test('a census goes stale after the TTL — a monitor killed by timeout (no wake, no new Stop) must not wedge the gates forever', () => {
  // Finite monitors max out at claude's 1h timeout ceiling; +15min margin.
  assert.ok(PENDING_CENSUS_TTL_MS >= 60 * 60_000 + 5 * 60_000);
  let now = 1_000_000;
  const tr = new PendingWorkTracker(() => now);
  tr.recordSettle('kevin', [task({ id: 'b1' })]);
  assert.equal(tr.countFor('kevin'), 1);
  now += PENDING_CENSUS_TTL_MS + 1;
  assert.equal(tr.countFor('kevin'), 0, 'expired census reads idle again');
});

test('every Stop refreshes the census — completions that wake the agent self-heal', () => {
  const tr = new PendingWorkTracker();
  tr.recordSettle('kevin', [task({ id: 'b1' })]);
  assert.equal(tr.countFor('kevin'), 1);
  // Monitor completed, agent handled it, settled again with nothing pending.
  tr.recordSettle('kevin', []);
  assert.equal(tr.countFor('kevin'), 0);
});

test('SessionStart resets the agent — a fresh conversation inherits no stale census', () => {
  const tr = new PendingWorkTracker();
  tr.recordMonitorArm('kevin', 'mon-inbox', true);
  tr.recordSettle('kevin', [task({ id: 'b1' })]);
  tr.resetAgent('kevin');
  assert.equal(tr.countFor('kevin'), 0);
  // The persistent set died with the session too: a reused monitor id in the
  // NEW session counts until re-classified at its own arm time.
  tr.recordSettle('kevin', [task({ id: 'mon-inbox', type: 'monitor' })]);
  assert.equal(tr.countFor('kevin'), 1);
});

test("agents are independent — one agent's monitor does not shadow another's", () => {
  const tr = new PendingWorkTracker();
  tr.recordMonitorArm('kevin', 'mon-inbox', true);
  tr.recordSettle('kevin', [task({ id: 'mon-inbox', type: 'monitor' })]);
  tr.recordSettle('pam', [task({ id: 'mon-inbox', type: 'monitor' })]);
  assert.equal(tr.countFor('kevin'), 0);
  assert.equal(tr.countFor('pam'), 1);
});

// ——— the wiring: real hook payloads through the real HookServer ————————————
// Pins that the census actually flows: Monitor arm classification lands in the
// tracker, the Stop snapshot refreshes it, and SessionStart resets it. Same
// electron-shim pattern as vacation-busy-check's collector test.

test('HookServer feeds the tracker from live payload shapes (Monitor arm → Stop census → reset)', () => {
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
  const { HookServer } = loadTs('src/main/hooks.ts');
  const { PendingWorkTracker: T } = loadTs('src/main/pendingWork.ts');
  const tracker = new T();
  const hive = {
    recordSession() {},
    sockPath() {
      return null;
    },
    isGod() {
      return false;
    },
    appendCostLedger() {},
  };
  const srv = new HookServer(
    hive,
    () => null,
    () => ({ notifications: false }),
    undefined,
    undefined,
    undefined,
    tracker,
  );

  // The inbox-wake monitor arms persistent; a one-shot CI monitor arms finite.
  srv.handle({
    hook_event_name: 'PostToolUse',
    agent_id: 'kevin',
    tool_name: 'Monitor',
    tool_response: { taskId: 'mon-inbox', timeoutMs: 0, persistent: true },
  });
  srv.handle({
    hook_event_name: 'PostToolUse',
    agent_id: 'kevin',
    tool_name: 'Monitor',
    tool_response: { taskId: 'mon-ci', timeoutMs: 300000 },
  });
  // Kevin settles: claude's Stop payload with the live registry snapshot.
  srv.handle({
    hook_event_name: 'Stop',
    agent_id: 'kevin',
    session_id: 's1',
    stop_hook_active: false,
    background_tasks: [
      { id: 'mon-inbox', type: 'monitor', status: 'running', description: 'inbox wake' },
      { id: 'mon-ci', type: 'monitor', status: 'running', description: 'ci' },
      { id: 'bash1', type: 'shell', status: 'running', command: 'gh run watch' },
    ],
  });
  assert.equal(
    tracker.countFor('kevin'),
    2,
    'persistent inbox monitor excluded; CI monitor + CI shell count',
  );
  // And the busy signal reads busy on an otherwise completely idle pane.
  assert.equal(vacationBusy(5 * 60_000, 5 * 60_000, true, tracker.countFor('kevin')), true);

  // CI work completes and wakes Kevin → he settles again with nothing pending.
  srv.handle({
    hook_event_name: 'Stop',
    agent_id: 'kevin',
    background_tasks: [{ id: 'mon-inbox', type: 'monitor' }],
  });
  assert.equal(tracker.countFor('kevin'), 0, 're-settle refreshes — the self-heal path');
  assert.equal(vacationBusy(5 * 60_000, 5 * 60_000, true, tracker.countFor('kevin')), false);

  // A fresh session inherits no stale census.
  srv.handle({ hook_event_name: 'SessionStart', agent_id: 'kevin' });
  assert.equal(tracker.countFor('kevin'), 0);
});
