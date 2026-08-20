'use strict';

/**
 * waiting-busy-pending-work (card agent-harness-busy-signal-coun-2026-08-17).
 *
 * Live incident class: Kevin settles at the prompt while a finite background
 * task (a CI shell) is still running, and the harness reads him IDLE
 * (telemetry silent, pane quiet) — so the idle-gated clear fires and wipes
 * the conversation the completion was going to wake. Exactly the context wipe
 * the idle gate was built to prevent. (Monitors are the exception: they never
 * count, by type — see pendingWork.ts and the wedge test below.)
 *
 * The fix: busy = recentActivity OR pendingFiniteBackgroundWork. The census
 * comes from claude's own Stop payload, which carries `background_tasks` — a
 * live snapshot of its task registry (types: shell, subagent, workflow,
 * monitor, MCP task, teammate, dream, auto-mode scan, cloud session), already
 * filtered upstream to running+backgrounded. MONITORS NEVER COUNT (card
 * agent-harness-fix-the-staging--2026-08-20): they are skipped by type at
 * settle time — see the wedge test below for why the old by-taskId exclusion
 * could not hold. Anything the harness cannot classify COUNTS (safe direction:
 * a deferred clear costs minutes, a fired one costs a context).
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

test('a Stop settle with finite background tasks counts them (monitors never count)', () => {
  const tr = new PendingWorkTracker();
  tr.recordSettle('kevin', [task({ id: 'b1' }), task({ id: 'b2', type: 'monitor' })]);
  assert.equal(tr.countFor('kevin'), 1);
});

test('empty settle → zero (the honest idle)', () => {
  const tr = new PendingWorkTracker();
  tr.recordSettle('kevin', []);
  assert.equal(tr.countFor('kevin'), 0);
});

test('monitors never count — persistent or one-shot, armed or not', () => {
  const tr = new PendingWorkTracker();
  // Arm-time classification still happens (PostToolUse(Monitor).tool_response
  // carries taskId + persistent) — but the census skips monitors BY TYPE, so
  // it no longer depends on the session-scoped arm bookkeeping surviving.
  tr.recordMonitorArm('kevin', 'mon-inbox', true);
  tr.recordSettle('kevin', [
    task({ id: 'mon-inbox', type: 'monitor' }),
    task({ id: 'mon-ci', type: 'monitor' }),
  ]);
  assert.equal(tr.countFor('kevin'), 0);
});

test('THE WEDGE (incident 2026-08-20): a monitor armed before a session boundary still never counts after the boundary wipes the arm bookkeeping', () => {
  // Stanley's sequence, verified live: persistent inbox monitor armed →
  // compaction fires SessionStart (resetAgent wipes the arm set) → the monitor
  // SURVIVES (it is process-scoped, not conversation-scoped) and stays in
  // background_tasks → the old by-taskId exclusion no longer knew it → it
  // counted as pending finite work forever → vacationBusy busy → both delivery
  // gates closed permanently. Type-skip makes this structurally impossible.
  const tr = new PendingWorkTracker();
  tr.recordMonitorArm('stanley', 'mon-inbox', true);
  tr.recordSettle('stanley', [task({ id: 'mon-inbox', type: 'monitor' })]);
  assert.equal(tr.countFor('stanley'), 0);
  tr.resetAgent('stanley'); // SessionStart: compact or in-place clear
  tr.recordSettle('stanley', [task({ id: 'mon-inbox', type: 'monitor' })]);
  assert.equal(tr.countFor('stanley'), 0, 'orphaned monitor never counts');
  assert.equal(vacationBusy(5 * 60_000, 5 * 60_000, true, tr.countFor('stanley')), false);
});

test('the arm set still drives the rearm-aware nudge (its surviving consumer)', () => {
  const tr = new PendingWorkTracker();
  assert.equal(tr.hasPersistentMonitor('kevin'), false);
  tr.recordMonitorArm('kevin', 'mon-inbox', true);
  assert.equal(tr.hasPersistentMonitor('kevin'), true);
  tr.recordMonitorArm('kevin', 'mon-ci', false); // finite re-arm de-classifies
  assert.equal(tr.hasPersistentMonitor('kevin'), true);
  tr.recordMonitorArm('kevin', 'mon-inbox', false);
  assert.equal(tr.hasPersistentMonitor('kevin'), false);
  tr.recordMonitorArm('kevin', 'mon-inbox', true);
  tr.resetAgent('kevin'); // fresh conversation: no rearm seen yet
  assert.equal(tr.hasPersistentMonitor('kevin'), false);
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
  assert.equal(tr.countFor('kevin'), 1);
  tr.resetAgent('kevin');
  assert.equal(tr.countFor('kevin'), 0);
  // A surviving monitor id in the NEW session still never counts (type-skip).
  tr.recordSettle('kevin', [task({ id: 'mon-inbox', type: 'monitor' })]);
  assert.equal(tr.countFor('kevin'), 0);
});

test("agents are independent — one agent's census does not shadow another's", () => {
  const tr = new PendingWorkTracker();
  tr.recordSettle('kevin', [task({ id: 'b1' })]);
  tr.recordSettle('pam', [task({ id: 'b2' }), task({ id: 'mon', type: 'monitor' })]);
  assert.equal(tr.countFor('kevin'), 1);
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
    recordInboxMonitorArm() {},
    sockPath() {
      return null;
    },
    isGod() {
      return false;
    },
    providerOf() {
      return undefined;
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
    1,
    'both monitors skipped by type; only the CI shell counts',
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
