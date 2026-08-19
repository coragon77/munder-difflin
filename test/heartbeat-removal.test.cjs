'use strict';

/**
 * Floor-heartbeat removal (card agent-delete-the-floor-heartbe-2026-08-19).
 * The operator deleted the heartbeat after it failed to deliver; adversarial
 * review (Robert) recommended deletion over repair. This file pins:
 *   1. the one piece of NEW logic — the boot migration that strips persisted
 *      heartbeat missions (without it, an install where the heartbeat was
 *      ENABLED falls through to the generic dispatch path and starts sending
 *      the dead body text every interval: defect (c) resurrected);
 *   2. that the heartbeat is GONE from config (no mission constant, no kind
 *      member at runtime);
 *   3. that the coverage that must survive does survive (actionable-watch
 *      ships enabled; historical 'heartbeat' mail still classifies as system).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const config = loadTs('src/main/config.ts');
const { SYSTEM_SENDERS } = loadTs('src/shared/hiveMail.ts');

test('stripHeartbeatMissions removes persisted heartbeat missions, keeps the rest, idempotent', () => {
  const standup = {
    id: 'ops-standup',
    label: 'Hourly ops standup',
    intervalMs: 1,
    to: 'god',
    body: 'x',
    enabled: true,
  };
  const watch = {
    id: 'actionable-watch',
    label: 'Actionable-card watch',
    intervalMs: 1,
    to: 'god',
    body: '',
    enabled: true,
    kind: 'actionable-watch',
  };
  const legacy = {
    id: 'heartbeat',
    label: 'Floor heartbeat',
    intervalMs: 120_000,
    to: 'god',
    body: 'dead text',
    enabled: true,
    kind: 'heartbeat',
    quietThresholdMs: 300_000,
  };
  const out = config.stripHeartbeatMissions([standup, legacy, watch]);
  assert.deepEqual(out, [standup, watch]);
  // Idempotent — a second pass changes nothing (no write churn on boot).
  assert.deepEqual(config.stripHeartbeatMissions(out), out);
});

test('stripHeartbeatMissions returns the input array unchanged when no heartbeat is present', () => {
  const missions = [
    { id: 'ops-standup', label: 's', intervalMs: 1, to: 'god', body: 'x', enabled: true },
  ];
  assert.equal(
    config.stripHeartbeatMissions(missions),
    missions,
    'same reference — caller skips the write',
  );
});

test('HEARTBEAT_MISSION is gone from config', () => {
  assert.equal(config.HEARTBEAT_MISSION, undefined);
});

test('no default mission carries kind heartbeat', () => {
  for (const m of [config.OPS_STANDUP_MISSION, config.ACTIONABLE_WATCH_MISSION]) {
    assert.notEqual(m.kind, 'heartbeat');
  }
});

// ————————————————————————— coverage that must survive ——————————————————————

test('actionable-watch still ships enabled on the 2-minute tick (new/undispatched work)', () => {
  assert.equal(config.ACTIONABLE_WATCH_MISSION.enabled, true);
  assert.equal(config.ACTIONABLE_WATCH_MISSION.kind, 'actionable-watch');
  assert.equal(config.ACTIONABLE_WATCH_MISSION.intervalMs, 120_000);
  // The configured-body trap must not repeat: the watch COMPUTES its mail.
  assert.equal(config.ACTIONABLE_WATCH_MISSION.body, '');
});

test("SYSTEM_SENDERS keeps 'heartbeat' — historical undrained beat mail must never wake god", () => {
  // The sender can no longer be minted (reengageGod is deleted with the
  // mission), but god's inbox may still hold an old beat; dropping the label
  // would reclassify that mail as real agent/human mail exactly once. Kept
  // deliberately — a future cleanup may remove it once no old mail can exist.
  assert.ok(SYSTEM_SENDERS.has('heartbeat'));
});
