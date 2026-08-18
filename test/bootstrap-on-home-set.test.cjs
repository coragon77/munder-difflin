'use strict';
/**
 * First-run bootstrap bug (ported by intent from upstream 1b821b3): a fresh
 * install boots with harnessHome null — bootstrapHiveServices() early-returns
 * at app-ready, and onboarding's config:update never re-bootstrapped, so the
 * message router, hook server, telemetry collector and mission scheduler
 * stayed dead for the whole first session (mail never moved, cards never
 * reported, "Restart & Continue" had no session id). It healed on the next
 * launch, which is why it survived unnoticed.
 *
 * index.ts imports electron, so these assert on the handler source — the same
 * pattern as integration-mode-toggle / graph-refresh tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

test('config:update re-bootstraps hive services on the null -> set harnessHome transition', () => {
  const start = src.indexOf("ipcMain.handle('config:update'");
  const end = src.indexOf("ipcMain.handle('config:ensureHome'");
  assert.ok(start !== -1 && end > start, 'config:update handler found');
  const body = src.slice(start, end);

  const capture = body.indexOf('const hiveWasEnabled = hive.enabled()');
  const write = body.indexOf('writeConfig(patch)');
  const gate = body.indexOf('!hiveWasEnabled && hive.enabled()');
  // With the semicolon: matches the CALL, not the explanatory comment above it.
  const bootstrap = body.indexOf('bootstrapHiveServices();');
  assert.ok(capture !== -1, 'enabled state is captured before the config write');
  assert.ok(write !== -1, 'handler writes the config patch');
  assert.ok(capture < write, 'capture must happen BEFORE writeConfig (pre-write state)');
  assert.ok(gate > write, 'transition gate is checked AFTER writeConfig (post-write state)');
  assert.ok(bootstrap > gate, 'the null -> set transition calls bootstrapHiveServices()');
});

test('breaker beat records the live session id from the usage tick', () => {
  // Second resume-key source: recordSession() is otherwise reachable only from
  // the hook shim; in any window where hooks never land (the first-run gap
  // above), "Restart & Continue" had no recorded session id even though the
  // usage tick already proved the app knew it.
  const ledger = src.indexOf('hive.appendCostLedger(sample)');
  assert.ok(ledger !== -1, 'ledger append line found (anchor)');
  assert.match(
    src.slice(ledger, ledger + 700),
    /if \(sample\?\.sessionId\) hive\.recordSession\(id, sample\.sessionId\);/,
    'recordSession from the usage tick, same liveness gate as the ledger append',
  );
});
