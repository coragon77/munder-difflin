'use strict';

/**
 * SAVED permissionMode MUST SURVIVE A HARNESS RESTART (card
 * agent-harness-bug-saved-permis-2026-08-17).
 *
 * Stefan's repro: Ryan + Toby saved with BYPASS reopened as 'auto' after a
 * restart, while park+recall restored the saved mode. Verified root cause: the
 * boot restore (useRestoreTeam) DOES re-send the persisted per-agent mode from
 * the restorable row — but the row itself had been rebuilt WITHOUT the field by
 * useHive's `hive:agentSpawned` handler (main-side respawn: recall, unarchive,
 * god persistent spawn). That handler fires when the agent is NOT on the floor
 * (its addAgent idempotency guard), so the fresh record REPLACES the shelf row
 * in every later read: the next boot's restorable snapshot, rosterRecipe, the
 * edit dialog prefill. spawnAgentCore then walks its fallback ladder
 * (explicit → registry → default) and, with both rungs empty for a worker,
 * lands on DEFAULT_HIRE_PERMISSION_MODE 'auto'. Live evidence: Ryan/Toby's
 * roster agents rows and registry entries all lack the field while their panes
 * ran bypass.
 *
 * Three pins:
 *  1. THE regression — a main-side respawn keeps the prior row's saved mode.
 *  2. The boot-restore recipe re-sends the persisted per-agent mode (the
 *     behavior the card feared had been replaced by a toggle/defaults rebuild).
 *  3. The spawn-side fallback ladder, behaviorally: explicit beats stored,
 *     stored beats the default — the ordering that makes an explicitly saved
 *     per-agent mode win (and made an empty row degrade to 'auto').
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

// agentProvider.ts reads nothing global, but keep the standard shim discipline
// (see gear-vacation-archived.test.cjs) in case shared deps grow one.
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
globalThis.window = { localStorage: memoryStorage, addEventListener() {} };

const loadTs = require('./load-ts.cjs');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

// ─── 1. the regression: main-side respawn keeps the saved mode ──────────────

test("agentSpawned handler: a main-side respawn keeps the prior row's saved permissionMode", () => {
  const src = read('src/renderer/src/hooks/useHive.ts');
  const at = src.indexOf('onHiveAgentSpawned');
  assert.ok(at > 0, 'the agentSpawned handler exists');
  const handler = src.slice(at, src.indexOf('onHiveAgentArchived'));
  assert.ok(
    handler.includes('permissionMode: prior'),
    "the rebuilt floor record carries the prior shelf row's permissionMode — without it every recall/unarchive silently downgrades the agent to Claude Auto on the next restart (card agent-harness-bug-saved-permis-2026-08-17)",
  );
});

// ─── 2. the boot-restore recipe re-sends the persisted per-agent mode ────────

test('boot restore: the spawn recipe re-sends the persisted per-agent permissionMode', () => {
  const src = read('src/renderer/src/hooks/useRestoreTeam.ts');
  const at = src.indexOf('spawnPty({');
  assert.ok(at > 0, 'the restore spawn call exists');
  const call = src.slice(at, src.indexOf('});', at));
  assert.ok(
    call.includes('permissionMode: a.permissionMode'),
    "restore-team sends the restorable row's own mode (not the workerBypass toggle, not a rebuilt default) — the boot-restore recipe stays pinned to the persisted one",
  );
});

// ─── 3. the spawn-side ladder (behavioral) ───────────────────────────────────

test('resolveHirePermissionMode: explicit beats stored beats default', () => {
  const { resolveHirePermissionMode, DEFAULT_HIRE_PERMISSION_MODE } = loadTs(
    'src/shared/agentProvider.ts',
  );
  assert.equal(DEFAULT_HIRE_PERMISSION_MODE, 'auto');
  // Explicit wins — a saved per-agent mode must beat whatever rung sits under it.
  assert.equal(resolveHirePermissionMode('bypass', 'auto'), 'bypass');
  assert.equal(resolveHirePermissionMode('default', 'bypass'), 'default');
  // No explicit mode → the stored rung (registry) — a persisted choice survives.
  assert.equal(resolveHirePermissionMode(undefined, 'bypass'), 'bypass');
  // Both empty → the shipped default. This is the 'auto' the bug degraded to,
  // and the reason a respawn that drops the row's mode is a silent downgrade.
  assert.equal(resolveHirePermissionMode(undefined, undefined), 'auto');
});
