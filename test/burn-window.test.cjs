'use strict';
/**
 * Rolling-window token burn (card agent-rolling-window-token-bur-2026-08-18).
 *
 * The maths that must never break: per-agent sums over a TRAILING window read
 * from cost-ledger.jsonl, incremental across calls, unknown (absent/null)
 * rather than zero when there are no in-window rows, and resilient to a
 * half-written last line and to file shrink/rotation.
 *
 * Run with `node --test test/burn-window.test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { burnWindows, resetBurnCursor } = loadTs('src/main/burn.ts');

const MIN = 60_000;
const H = 60 * MIN;
const WINDOW = 5 * H;
const NOW = 1_800_000_000_000; // fixed clock

function row(agent, minutesAgo, tokens, over = {}) {
  return JSON.stringify({
    agent_id: agent,
    ts: NOW - minutesAgo * MIN,
    input: tokens,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
    ...over,
  });
}

function ledger(name, lines) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'burn-')), name);
  fs.writeFileSync(p, (lines ?? []).join('\n') + (lines ? '\n' : ''), 'utf8');
  resetBurnCursor(p);
  return p;
}

test('per-agent trailing-window sums; aged rows drop; absent = unknown, never zero', () => {
  const p = ledger('l.jsonl', [
    row('pi-1', 30, 1000), // in window
    row('pi-1', 4 * 60, 2000), // in window (4h ago)
    row('pi-1', 6 * 60, 999_999), // aged out
    row('claude-1', 90, 500), // in window
    row('junk', 1, 0), // zero-token rows are not data
  ]);
  const r = burnWindows(p, WINDOW, NOW);
  assert.equal(r.agents['pi-1'], 3000);
  assert.equal(r.agents['claude-1'], 500);
  assert.equal(r.agents['junk'], undefined, 'no-row agents stay ABSENT (unknown), not 0');
  assert.equal(r.total, 3500);
  assert.equal(r.rowsKept, 3);
});

test('empty or missing ledger reads as unknown — total null, never zero', () => {
  const empty = ledger('empty.jsonl', []);
  const r = burnWindows(empty, WINDOW, NOW);
  assert.deepEqual(r.agents, {});
  assert.equal(r.total, null);
  const missing = burnWindows(
    path.join(os.tmpdir(), 'no-such-' + Date.now() + '.jsonl'),
    WINDOW,
    NOW,
  );
  assert.equal(missing.total, null);
});

test('incremental: appended rows accumulate; a half-written line is picked up once complete', () => {
  const p = ledger('inc.jsonl', [row('a', 10, 100)]);
  assert.equal(burnWindows(p, WINDOW, NOW).agents.a, 100);
  // Append WITHOUT trailing newline (a writer mid-row), then complete it.
  fs.appendFileSync(p, row('a', 1, 40).slice(0, 20), 'utf8');
  assert.equal(burnWindows(p, WINDOW, NOW).agents.a, 100, 'partial row not counted');
  fs.appendFileSync(p, row('a', 1, 40).slice(20) + '\n', 'utf8');
  assert.equal(burnWindows(p, WINDOW, NOW).agents.a, 140);
});

test('file shrink (rotation/edit) resets and rescans instead of reading garbage', () => {
  const p = ledger('rot.jsonl', [row('a', 10, 100), row('b', 10, 50)]);
  assert.equal(burnWindows(p, WINDOW, NOW).total, 150);
  fs.writeFileSync(p, row('c', 5, 7) + '\n', 'utf8'); // smaller file
  const r = burnWindows(p, WINDOW, NOW);
  assert.equal(r.total, 7);
  assert.equal(r.agents.c, 7);
});

test('window slides forward: earlier rows age out as the clock advances', () => {
  const p = ledger('slide.jsonl', [row('a', 4 * 60 + 30, 100)]); // 4.5h before NOW
  assert.equal(burnWindows(p, WINDOW, NOW).total, 100);
  assert.equal(
    burnWindows(p, WINDOW, NOW + 31 * MIN).total,
    null,
    'aged out — and reads unknown, not 0',
  );
});
