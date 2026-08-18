'use strict';

/**
 * Card agent-monitor-lists-sort-agent-2026-08-18: every grouped agent list the
 * operator reads — god's LIVE ROSTER injection (active + vacation) and the
 * spoken roster — must show GOD FIRST, everyone else alphabetical by name,
 * each group sorted independently. These checks feed deliberately shuffled
 * input and pin the emitted order.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// hooks.ts pulls Notification from electron; rosterContext itself does not,
// but HiveManager's import graph does — seed the surface (same as
// hive-roster-injection.test.cjs).
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

const { compareAgentOrder } = loadTs('src/shared/agentOrder.ts');
const { splitRoster, rosterSpeech, vacationSummaryLine } = loadTs(
  'src/renderer/src/realtime/roster.ts',
);
const { HiveManager } = loadTs('src/main/hive.ts');
test('comparator: god pinned first, rest alphabetical by name (id fallback)', () => {
  const sorted = [
    { id: 'zeta', name: 'Kelly' },
    { id: 'aa', name: 'Zeta' },
    { id: 'god-1', name: 'Michael', isGod: true },
    { id: 'no-name' },
    { id: 'bb', name: 'Ann' },
  ].sort(compareAgentOrder);
  assert.deepEqual(
    sorted.map((a) => a.name || a.id),
    ['Michael', 'Ann', 'Kelly', 'no-name', 'Zeta'],
  );
});

test('spoken roster: god first, alphabetical within active/vacation/archived', () => {
  const shuffled = [
    { id: 'pam', name: 'Pam', provider: 'claude', archived: false },
    { id: 'creed', name: 'Creed', provider: 'claude', archived: true, vacation: true },
    { id: 'god-1', name: 'Michael', provider: 'claude', archived: false, isGod: true },
    { id: 'andy', name: 'Andy', provider: 'claude', archived: true },
    { id: 'jim', name: 'Jim', provider: 'claude', archived: false },
    { id: 'toby', name: 'Toby', provider: 'claude', archived: true, vacation: true },
    { id: 'erin', name: 'Erin', provider: 'claude', archived: true },
  ];
  const { active, vacationing, archived } = splitRoster(shuffled);
  assert.deepEqual(
    active.map((r) => r.name),
    ['Michael', 'Jim', 'Pam'],
  );
  assert.deepEqual(
    vacationing.map((r) => r.name),
    ['Creed', 'Toby'],
  );
  assert.deepEqual(
    archived.map((r) => r.name),
    ['Andy', 'Erin'],
  );

  const speech = rosterSpeech(shuffled, true);
  assert.ok(
    speech.indexOf('Michael') < speech.indexOf('Jim') &&
      speech.indexOf('Jim') < speech.indexOf('Pam'),
    'spoken active order must be god, then alphabetical',
  );
  assert.ok(speech.indexOf('Creed') < speech.indexOf('Toby'), 'vacation sentence sorted');

  const line = vacationSummaryLine(shuffled);
  assert.ok(line.indexOf('Creed') < line.indexOf('Toby'), 'vacation summary sorted');
});

test('LIVE ROSTER injection: god first, alphabetical in ACTIVE and ON VACATION', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agent-order-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: home,
    isGod: true,
  });

  // Deliberately unsorted: god buried mid-list, names out of order in both groups.
  hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [
      { id: 'pam-1', name: 'Pam', role: 'agent' },
      { id: 'god-1', name: 'Michael', role: 'orchestrator', isGod: true },
      { id: 'andy-1', name: 'Andy', role: 'agent' },
    ],
    vacation: [
      { id: 'toby-1', name: 'Toby', role: 'agent' },
      { id: 'creed-1', name: 'Creed', role: 'agent' },
    ],
  });

  const line = hive.rosterContext();
  assert.ok(line.indexOf('god-1') < line.indexOf('andy-1'), 'god before Andy');
  assert.ok(line.indexOf('andy-1') < line.indexOf('pam-1'), 'Andy before Pam');
  assert.ok(line.indexOf('creed-1') < line.indexOf('toby-1'), 'vacation line alphabetical');

  // Slim variant (second call for the same agent) keeps the same order.
  hive.rosterContext('god-1');
  const slim = hive.rosterContext('god-1');
  assert.match(slim, /unchanged/);
  assert.ok(slim.indexOf('god-1') < slim.indexOf('andy-1'), 'slim line: god first');
  assert.ok(slim.indexOf('andy-1') < slim.indexOf('pam-1'), 'slim line alphabetical');
});

test('fleet.json write order on disk is untouched — only the rendered line is sorted', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agent-order-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: home,
    isGod: true,
  });
  const agents = [
    { id: 'pam-1', name: 'Pam', role: 'agent' },
    { id: 'god-1', name: 'Michael', role: 'orchestrator', isGod: true },
  ];
  hive.writeFleetSnapshot({ ts: Date.now(), agents });
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'fleet.json'), 'utf8'));
  assert.deepEqual(
    onDisk.agents.map((a) => a.id),
    ['pam-1', 'god-1'],
    'the snapshot file keeps its own order',
  );
});
