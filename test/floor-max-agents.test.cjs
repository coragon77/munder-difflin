'use strict';

/**
 * floorMaxAgents — the floor's physical workplace cap (cards
 * agent-harness-floormaxagents-s-2026-08-17 +
 * agent-harness-parallel-dispatc-2026-08-17).
 *
 * The office ships 16 desks; hires + interns on the floor can never exceed
 * `floorMaxAgents` (god excluded). Pinned here:
 *  - the clamp helper (config.ts) the spawn gate + fleet snapshot share
 *  - the floor census (hive.ts) that counts seats — god/archived/vacation/
 *    retired never count, a respawn's own id never counts against itself
 *  - the LIVE ROSTER injection carries the live seat count (the volatile
 *    channel; the briefing itself stays volatile-free)
 *  - the generated hive-root AGENTS.md carries the fan-out policy + cap
 *  - restore-team's hold-against-the-cap split (renderer, pure helpers)
 *
 * The spawnAgentCore gate itself is exercised by the gate's placement (the
 * single door every spawn passes through); index.ts is not loadable outside
 * Electron, so the decision inputs are tested here at their source.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// useRestoreTeam.ts pulls in react + the store, which read window/localStorage
// at module load — same shim the other store-backed tests use.
const memoryStorage = {
  data: {},
  getItem(k) {
    return Object.hasOwn(this.data, k) ? this.data[k] : null;
  },
  setItem(k, v) {
    this.data[k] = String(v);
  },
  removeItem(k) {
    delete this.data[k];
  },
};
globalThis.localStorage = memoryStorage;
globalThis.window = {
  localStorage: memoryStorage,
  addEventListener() {},
  setTimeout,
  clearTimeout,
};

const loadTs = require('./load-ts.cjs');
const { normalizeFloorMaxAgents } = loadTs('src/main/config.ts');
const { HiveManager, floorCensus, hiveRootAgentsMd } = loadTs('src/main/hive.ts');
const { clampFloorCap, capRestorables } = loadTs('src/renderer/src/hooks/useRestoreTeam.ts');

// ── normalizeFloorMaxAgents ──────────────────────────────────────────────

test('unset/invalid floorMaxAgents → the full 16-workplace floor', () => {
  assert.equal(normalizeFloorMaxAgents(undefined), 16);
  assert.equal(normalizeFloorMaxAgents(null), 16);
  assert.equal(normalizeFloorMaxAgents(Number.NaN), 16);
});

test('floorMaxAgents clamps into 1..16 and floors fractions', () => {
  assert.equal(normalizeFloorMaxAgents(1), 1);
  assert.equal(normalizeFloorMaxAgents(16), 16);
  assert.equal(normalizeFloorMaxAgents(0), 1);
  assert.equal(normalizeFloorMaxAgents(-5), 1);
  assert.equal(normalizeFloorMaxAgents(99), 16);
  assert.equal(normalizeFloorMaxAgents(7.9), 7);
});

// ── floorCensus ──────────────────────────────────────────────────────────

const reg = (agents, godId = 'god') => ({ godId, agents });

test('census counts live hires, excludes god', () => {
  const r = reg({
    god: { isGod: true },
    'andy-1': {},
    'intern-x': { role: 'intern' },
  });
  assert.equal(floorCensus(r), 2);
});

test('census excludes archived, vacation and retired agents', () => {
  const r = reg({
    god: { isGod: true },
    live: {},
    closed: { archived: true },
    parked: { vacation: true, archived: true },
    fired: { retired: true },
  });
  assert.equal(floorCensus(r), 1);
});

test('census excludes god by godId even without the isGod flag', () => {
  const r = reg({ michael: {} }, 'michael');
  assert.equal(floorCensus(r), 0);
});

test('a respawn never counts against its own seat', () => {
  const r = reg({ god: { isGod: true }, a: {}, b: {} });
  assert.equal(floorCensus(r, 'b'), 1, 'excluding self frees its own seat');
  assert.equal(floorCensus(r), 2);
});

// ── rosterContext carries the live seat count ────────────────────────────

test('the LIVE ROSTER line carries the floor seats (and the FULL variant)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-floor-cap-'));
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

  hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [
      { id: 'god-1', name: 'Michael', isGod: true },
      { id: 'jim-1', name: 'Jim' },
    ],
    vacation: [],
    floor: { maxAgents: 16, onFloor: 1, freeSeats: 15 },
  });
  const line = hive.rosterContext();
  assert.match(line, /FLOOR SEATS: 1 of 16 workplaces occupied/);
  assert.match(line, /config floorMaxAgents/);
  assert.match(line, /15 free/);

  // A full floor must say so — the fan-out policy hinges on it.
  hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [{ id: 'god-1', name: 'Michael', isGod: true }],
    vacation: [],
    floor: { maxAgents: 8, onFloor: 8, freeSeats: 0 },
  });
  const full = hive.rosterContext();
  assert.match(full, /FLOOR SEATS: 8 of 8/);
  assert.match(full, /FULL: spawns are refused until a seat frees/);
});

// ── generated hive-root AGENTS.md carries the fan-out policy ─────────────

test('hive-root AGENTS.md carries the parallel-dispatch policy in every mode', () => {
  for (const mode of ['god', 'workers', 'lean']) {
    const md = hiveRootAgentsMd(true, mode);
    assert.match(md, /AREA FAN-OUT/, `mode ${mode}: fan-out rule missing`);
    assert.match(md, /one owner per card, parallel across cards/i, `mode ${mode}`);
    assert.match(md, /Sequential ONLY on real ticket dependencies/, `mode ${mode}`);
    assert.match(md, /INTERNS ARE THE OVERFLOW/, `mode ${mode}`);
    assert.match(md, /overflow capacity, not a last/i, `mode ${mode}`);
    assert.match(md, /PER-CARD ONLY/, `mode ${mode}`);
    assert.match(md, /floorMaxAgents/, `mode ${mode}: cap reference missing`);
  }
});

// ── restore-team hold behavior (pure helpers) ────────────────────────────

test('clampFloorCap mirrors the main-side clamp', () => {
  assert.equal(clampFloorCap(16), 16);
  assert.equal(clampFloorCap(0), 1);
  assert.equal(clampFloorCap(99), 16);
  assert.equal(clampFloorCap(Number.NaN), 16);
});

test('capRestorables restores up to the free seats and holds the rest', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(capRestorables(ids, 2), { restoring: ['a', 'b'], held: 2 });
  assert.deepEqual(capRestorables(ids, 4), { restoring: ids, held: 0 });
  assert.deepEqual(capRestorables(ids, 99), { restoring: ids, held: 0 });
  assert.deepEqual(capRestorables(ids, 0), { restoring: [], held: 4 });
  assert.deepEqual(capRestorables(ids, -3), { restoring: [], held: 4 });
  assert.deepEqual(capRestorables([], 5), { restoring: [], held: 0 });
});

test('capRestorables keeps roster order (never completion order)', () => {
  const { restoring } = capRestorables(['z', 'y', 'x'], 2);
  assert.deepEqual(restoring, ['z', 'y']);
});
