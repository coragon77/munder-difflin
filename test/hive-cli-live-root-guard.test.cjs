'use strict';

/**
 * Live-hive guard for the generated bin/ CLIs (card
 * agent-hive-mail-silently-destr-2026-08-18).
 *
 * Incident, 2026-08-18: Ada queued 7 mails with
 * `HIVE_ROOT=/home/sfuchs/HarnessAgents` — missing the `/hive` suffix. The
 * CLIs happily mkdir'd a PHANTOM hive tree and "queued" every mail into an
 * outbox no router polls: receipts looked normal, delivery never happened,
 * zero trace anywhere in the real hive. It read as "mail silently destroyed
 * in transit"; it was mail written into a ghost root. (Two independent agents
 * hit the same footgun the same day — hand-typing HIVE_ROOT "to be safe".)
 *
 * The guard: a generated CLI refuses to run when HIVE_ROOT is not a LIVE
 * hive — (a) when the script itself lives in <hive>/bin, HIVE_ROOT must
 * match that exact hive; (b) HIVE_ROOT must contain registry.json (the
 * ensureHive bootstrap invariant). Loud refusal, zero writes, and the
 * message names the correct root. The card's "runnable check": every test
 * here fails if any writer CLI can be pointed at a dead root again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const POSIX = process.platform !== 'win32';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-live-root-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  const bin = path.join(root, 'bin');
  const agentId = 'test-worker-1';
  hive.ensureAgent({ id: agentId, name: 'T', provider: 'claude', cwd: home });
  const run = (cli, envRoot, ...args) => {
    const { execFileSync } = require('node:child_process');
    try {
      return {
        code: 0,
        stdout: execFileSync(process.execPath, [path.join(bin, cli), ...args], {
          env: { ...process.env, HIVE_ROOT: envRoot, AGENT_ID: agentId },
          encoding: 'utf8',
        }),
        stderr: '',
      };
    } catch (e) {
      return {
        code: e.status ?? -1,
        stdout: String(e.stdout ?? ''),
        stderr: String(e.stderr ?? ''),
      };
    }
  };
  return { home, root, bin, agentId, run };
}

test('hive-mail: HIVE_ROOT missing the /hive suffix → LOUD refusal, zero phantom writes', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  // The exact incident shape: real CLI, root = parent of the real hive.
  const r = s.run(
    'hive-mail',
    s.home,
    '--to',
    'god',
    '--act',
    'done',
    '--subject',
    'x',
    '--body',
    'b',
  );
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /HIVE_ROOT/, 'error names the env var');
  assert.match(r.stderr, /hive/, 'error names the real hive root');
  assert.match(r.stderr, /phantom|undeliverable|never deliver/i, 'error says WHY');
  // The whole point: no ghost tree may spring into existence.
  assert.ok(!fs.existsSync(path.join(s.home, 'agents')), 'no phantom agents/ tree created');
  assert.ok(!fs.existsSync(path.join(s.home, 'tasks.json')), 'no phantom tasks.json');
  const outbox = path.join(s.root, 'agents', s.agentId, 'outbox');
  assert.deepEqual(
    fs.readdirSync(outbox).filter((f) => f.endsWith('.json')),
    [],
    'nothing queued in the real outbox either',
  );
});

test('hive-mail: HIVE_ROOT pointing at an empty dir → refused as not-a-live-hive', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const dead = fs.mkdtempSync(path.join(os.tmpdir(), 'md-dead-root-'));
  t.after(() => fs.rmSync(dead, { recursive: true, force: true }));
  // The registry branch is reachable when the script does NOT sit in a live
  // <hive>/bin (e.g. a CLI copied elsewhere — same shape as tests that
  // extract the template source). Copy it out, then point it at a dead root.
  const { execFileSync } = require('node:child_process');
  const copy = path.join(dead, '..', 'cli-copy.cjs');
  fs.copyFileSync(path.join(s.bin, 'hive-mail'), copy);
  let r;
  try {
    execFileSync(
      process.execPath,
      [copy, '--to', 'god', '--act', 'done', '--subject', 'x', '--body', 'b'],
      {
        env: { ...process.env, HIVE_ROOT: dead, AGENT_ID: s.agentId },
        encoding: 'utf8',
      },
    );
    r = { code: 0, stderr: '' };
  } catch (e) {
    r = { code: e.status ?? -1, stderr: String(e.stderr ?? '') };
  }
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.stderr, /registry\.json/, 'names what proves a live hive');
  assert.doesNotMatch(r.stderr, /queued/, 'nothing queued');
  assert.deepEqual(fs.readdirSync(dead), [], 'the dead root is left untouched');
});

test('correct HIVE_ROOT still queues — and the receipt carries the FULL path (visible root)', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const r = s.run(
    'hive-mail',
    s.root,
    '--to',
    'god',
    '--act',
    'inform',
    '--subject',
    'x',
    '--body',
    'b',
  );
  assert.equal(r.code, 0, r.stderr);
  const line = r.stdout.trim();
  assert.match(line, /^queued \S+\.json$/, 'still exactly one receipt line');
  assert.ok(
    line.includes(path.join(s.root, 'agents', s.agentId, 'outbox')),
    `receipt names the absolute outbox path so a wrong root is visible: ${line}`,
  );
  const file = line.slice('queued '.length);
  assert.ok(fs.existsSync(file), 'receipt path points at the real file');
});

test('every generated CLI that takes HIVE_ROOT refuses a dead root loudly', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const dead = fs.mkdtempSync(path.join(os.tmpdir(), 'md-dead-root-'));
  t.after(() => fs.rmSync(dead, { recursive: true, force: true }));
  const clis = [
    'hive-mail',
    'hive-card',
    'hive-dispatch',
    'hive-inbox',
    'hive-hire',
    'hive-fire',
    'hive-new',
  ];
  for (const cli of clis) {
    const r = s.run(cli, dead, 'drain');
    assert.notEqual(r.code, 0, `${cli} refuses a dead root`);
    assert.match(r.stderr, /HIVE_ROOT/, `${cli} error names HIVE_ROOT`);
    assert.deepEqual(fs.readdirSync(dead), [], `${cli} leaves the dead root untouched`);
  }
});

test('hive-inbox drain with a mis-rooted HIVE_ROOT no longer lies "no mail"', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const r = s.run('hive-inbox', s.home, 'drain');
  assert.notEqual(r.code, 0, 'refused instead of the silent empty-drain lie');
  assert.match(r.stderr, /HIVE_ROOT/);
});

test('hive-card with a mis-rooted HIVE_ROOT refuses instead of writing a phantom ledger', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const r = s.run('hive-card', s.home, 'add', '--title', 'Ghost card', '--status', 'todo');
  assert.notEqual(r.code, 0, 'refused');
  assert.ok(!fs.existsSync(path.join(s.home, 'tasks.json')), 'no phantom tasks.json created');
});
