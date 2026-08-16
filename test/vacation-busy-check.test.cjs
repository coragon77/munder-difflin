'use strict';

/**
 * vacation-busy-check (card vacation-busy-check-tui-repaint-20260816).
 *
 * Live bug: parkAgent's busy gate watched ptyManager.lastOutputAt with a 10s
 * window — but an idle claude TUI repaints its chrome continuously, so
 * "produced output recently" was permanently true and the park button refused
 * idle agents ("actively working"). The three parks that DID succeed in the
 * morning had just hit a quiet repaint gap: a flaky gate, not a working one.
 *
 * The fix: the busy signal must mean REAL WORK. TelemetryCollector liveness
 * (the hook/OTLP lastActive ts that fe49af8 wired into snapshot().usage) is
 * the primary — a tool call or inference inside the window = busy; a TUI
 * repaint emits no telemetry, so an idle pane goes parkable. lastOutputAt
 * survives ONLY as the fallback for agents with no telemetry row (no hooks,
 * no OTLP — nothing else to ask). The pure decision lives in vacationBusy()
 * because index.ts is the Electron main entry and untestable from this
 * harness (same extraction pattern as parkedAgentIds, vacation-restore-skip).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { vacationBusy, VACATION_BUSY_MS } = loadTs('src/main/vacationBusy.ts');

test('the window is 60s — generous for telemetry gaps, still "goes quiet" fast', () => {
  // Hook/OTLP events fire on tool calls and token usage. Inter-event gaps in
  // an active session routinely exceed the old 10s (one 30s bash tool, a long
  // inference turn) but essentially never exceed 60s while work continues.
  assert.equal(VACATION_BUSY_MS, 60_000);
});

test('idle TUI repaint does NOT block the park (the live bug)', () => {
  // Telemetry row exists but is 5 minutes stale (no tool calls, no inference);
  // the pane still repaints its chrome every frame → ptyIdleMs ≈ 50ms.
  // Old gate: ptyIdleMs < 10s → "actively working" → refused. Wrong.
  assert.equal(vacationBusy(5 * 60_000, 50), false);
});

test('recent telemetry activity DOES block, even with a quiet PTY', () => {
  // A tool call fired 5s ago (hook/OTLP row fresh) but the pane has been
  // silent for 2 minutes while the model works — inference gaps emit no PTY
  // bytes. This is exactly the agent the gate exists to protect.
  assert.equal(vacationBusy(5_000, 120_000), true);
});

test('telemetry is strictly primary — it decides even when the PTY disagrees', () => {
  assert.equal(vacationBusy(90_000, 100), false, 'stale telemetry + chatty pane → parkable');
  assert.equal(vacationBusy(10_000, 90_000), true, 'fresh telemetry + quiet pane → busy');
});

test('the window edge: exactly VACATION_BUSY_MS ago is not busy', () => {
  assert.equal(vacationBusy(VACATION_BUSY_MS, undefined), false);
  assert.equal(vacationBusy(VACATION_BUSY_MS - 1, undefined), true);
});

test('no telemetry row → PTY output is the fallback signal', () => {
  assert.equal(vacationBusy(undefined, 2_000), true, 'no row, pane printed 2s ago → busy');
  assert.equal(vacationBusy(undefined, 2 * 60_000), false, 'no row, pane quiet 2min → parkable');
});

test('no telemetry row and no PTY → not busy (nothing on the floor to guard)', () => {
  assert.equal(vacationBusy(undefined, undefined), false);
});

test('fresh-boot truth table: a capable provider with no row is IDLE, not busy', () => {
  // The fresh-boot false-positive (card vacation-busy-fresh-boot-20260817):
  // an agent with no turn since app boot has NO telemetry row, so the gate
  // fell into the PTY fallback — where the idle claude TUI's chrome repaint
  // keeps ptyIdleMs < 60s forever and the park is refused forever. For a
  // telemetry-CAPABLE provider, no row means "silent since boot" = idle.
  assert.equal(
    vacationBusy(undefined, 2_000, true),
    false,
    'capable + no row + chatty pane → parkable (the bug)',
  );
  // Providers with NO telemetry plane keep the PTY residual — unchanged.
  assert.equal(
    vacationBusy(undefined, 2_000, false),
    true,
    'no plane + no row + chatty pane → still busy (residual)',
  );
  // The row, when it exists, stays strictly primary whatever the capability.
  assert.equal(
    vacationBusy(5_000, 120_000, true),
    true,
    'capable + fresh row → busy (row decides)',
  );
  assert.equal(
    vacationBusy(5 * 60_000, 50, true),
    false,
    'capable + stale row + chatty pane → parkable (row decides)',
  );
});

// ——— the wiring parkAgent uses, against the real collector ————————————————
// parkAgent computes telemetryAgeMs from TelemetryCollector's snapshot rows
// and ptyIdleMs from ptyManager.idleFor(). This pins that the snapshot rows
// actually carry a usable liveness ts for both ingest planes.

test('TelemetryCollector snapshot rows feed the gate (hook plane, the blind-provider fix)', () => {
  // hooks.ts pulls Notification from electron; outside Electron that resolve
  // gives a path string, so seed the cache (same shim as fleet-telemetry.test).
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
  const { TelemetryCollector } = loadTs('src/main/telemetry.ts');

  const c = new TelemetryCollector();
  assert.equal(vacationBusy(undefined, undefined), false, 'no row yet → fallback decides');
  c.recordHookActivity('pam-1');
  const row = c.snapshot().usage.find((u) => u.agentId === 'pam-1');
  assert.ok(row, 'hook activity must create a snapshot row the gate can read');
  assert.ok(typeof row.ts === 'number' && row.ts > 0, 'row carries a liveness ts');
  assert.equal(
    vacationBusy(Date.now() - row.ts, 200),
    true,
    'fresh hook row blocks the park even while the pane repaints',
  );
});
