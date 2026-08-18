'use strict';

/**
 * Outbox-stall backstop (card agent-hive-mail-silently-destr-2026-08-18,
 * god's revised definition-of-done: a stalled queue must become VISIBLE —
 * a backlog silently sitting is as damaging as loss).
 *
 * The router (1.5s setInterval) can freeze or die while outbox mail keeps
 * arriving — the documented system-sleep incident (index.ts power-monitor
 * re-arm) is the precedent. When that happens, mails sit in a REAL outbox
 * for minutes with zero error anywhere. The backstop: detect (any outbox
 * .json older than the stall horizon), LOG once per episode, surface in the
 * fleet snapshot + god's roster injection, and let the 8s fleet tick call
 * routeOnce as a self-healing backstop router.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-stall-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  const drop = (agentId, ageSec, id = `m-${ageSec}-${Math.random().toString(16).slice(2, 8)}`) => {
    const dir = path.join(root, 'agents', agentId, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        to: 'god',
        act: 'done',
        created_at: new Date(Date.now() - ageSec * 1000).toISOString(),
      }),
    );
  };
  return { hive, root, drop };
}

test('outboxStalls: fresh mail is not a stall; old mail is, with age and count', async (t) => {
  const s = setup(t);
  await s.hive.ensureAgent({ id: 'a-1', name: 'A', provider: 'claude', cwd: s.root });
  s.drop('a-1', 10); // fresh
  assert.deepEqual(s.hive.outboxStalls(120), [], 'fresh mail: no stall');

  s.drop('a-1', 700); // 11m40s old
  const stalls = s.hive.outboxStalls(120);
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].agentId, 'a-1');
  assert.equal(stalls[0].count, 1, 'the fresh mail does not inflate the stalled count');
  assert.ok(
    stalls[0].oldestSecAgo >= 690 && stalls[0].oldestSecAgo <= 700,
    `age ~700s, got ${stalls[0].oldestSecAgo}`,
  );
});

test('outboxStalls: junk rows and missing dirs never throw', async (t) => {
  const s = setup(t);
  await s.hive.ensureAgent({ id: 'a-1', name: 'A', provider: 'claude', cwd: s.root });
  fs.writeFileSync(path.join(s.root, 'agents', 'a-1', 'outbox', 'junk.json'), 'not json{');
  assert.deepEqual(
    s.hive.outboxStalls(120),
    [],
    'unparseable file: no crash, no stall claim (mtime path used, but junk mtime is now)',
  );
  assert.deepEqual(
    new HiveManager(() => '/nonexistent').outboxStalls(120),
    [],
    'missing hive root: []',
  );
});

test('mailBackstop: logs ONCE per episode, resets when the backlog drains', async (t) => {
  const s = setup(t);
  await s.hive.ensureAgent({ id: 'a-1', name: 'A', provider: 'claude', cwd: s.root });
  s.drop('a-1', 700);
  const logPath = path.join(s.root, 'log.jsonl');
  const countStallLogs = () =>
    fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.includes('mail_stall')).length;

  const first = s.hive.mailBackstop(120);
  assert.equal(first.length, 1, 'stall detected');
  assert.equal(countStallLogs(), 1, 'one log entry');
  s.hive.mailBackstop(120);
  s.hive.mailBackstop(120);
  assert.equal(countStallLogs(), 1, 'same episode: still exactly one log entry');

  // Drain (simulate the self-heal routeOnce moving the file) → episode ends…
  const obDir = path.join(s.root, 'agents', 'a-1', 'outbox');
  for (const f of fs.readdirSync(obDir).filter((x) => x.endsWith('.json'))) {
    fs.rmSync(path.join(obDir, f));
  }
  assert.deepEqual(s.hive.mailBackstop(120), [], 'drained: no stall');
  // …so a NEW stall logs again.
  s.drop('a-1', 700);
  s.hive.mailBackstop(120);
  assert.equal(countStallLogs(), 2, 'new episode: logged again');
});

test("rosterContext: a fleet snapshot carrying mailStall renders god's MAIL STALLED line — both branches", async (t) => {
  const s = setup(t);
  await s.hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: s.root,
    isGod: true,
  });
  s.hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [{ id: 'god-1', name: 'Michael', isGod: true }],
    mailStall: [{ agentId: 'a-1', count: 2, oldestSecAgo: 143 }],
  });
  const full = s.hive.rosterContext();
  assert.match(full, /MAIL STALLED: a-1 \d+s \(2 mail/i, 'full block carries the stall line');
  s.hive.rosterContext('god-1');
  assert.match(s.hive.rosterContext('god-1'), /MAIL STALLED: a-1/, 'slim line carries it too');

  // No stall → no line.
  s.hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [{ id: 'god-1', name: 'Michael', isGod: true }],
  });
  assert.doesNotMatch(s.hive.rosterContext(), /MAIL STALLED/i);
});
