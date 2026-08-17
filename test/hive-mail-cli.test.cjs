'use strict';

/**
 * hive-mail (card agent-harness-reduce-transcrip-2026-08-17, E2): the cheap
 * mail carrier. Agents author ONLY to/act/subject/body — the CLI fills the
 * envelope (id/from/hops/created_at/requires_reply), writes the outbox JSON
 * atomically, and prints EXACTLY ONE line. Those two conditions carry the
 * measured saving (~215-235 tok per long mail, ~58% on short protocol mails):
 * a chatty stdout or a `cat`-back-to-verify re-reads the body into context and
 * the win evaporates. No --body-file variant (measured worst carrier).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const POSIX = process.platform !== 'win32';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-mail-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const cli = path.join(home, 'hive', 'bin', 'hive-mail');
  const outbox = path.join(home, 'hive', 'agents', 'test-worker-1', 'outbox');
  const env = { ...process.env, HIVE_ROOT: path.join(home, 'hive'), AGENT_ID: 'test-worker-1' };
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const runFail = (...args) => {
    try {
      run(...args);
      return { code: 0, stderr: '' };
    } catch (e) {
      return { code: e.status ?? -1, stderr: String(e.stderr ?? '') };
    }
  };
  return { hive, cli, outbox, env, run, runFail };
}

test('ensureHive ships an executable hive-mail in hive/bin', { skip: !POSIX }, async (t) => {
  const s = setup(t);
  assert.ok(fs.existsSync(s.cli), 'hive-mail exists in <hive>/bin');
  assert.equal(fs.statSync(s.cli).mode & 0o777, 0o755, 'it is executable');
});

test('happy path: envelope autofilled, file named <id>.json, stdout is exactly one line', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const out = s.run(
    '--to',
    'god',
    '--act',
    'done',
    '--subject',
    'Shipped the thing',
    '--body',
    'Card X done.\n\nMulti-line body with "quotes" and stuff.',
  );

  assert.match(out, /^queued [^\s]+\.json\n$/, 'exactly one line: queued <id>.json');
  const id = out.trim().slice('queued '.length, -'.json'.length);
  const file = path.join(s.outbox, `${id}.json`);
  assert.ok(fs.existsSync(file), 'the file is named after the generated id');

  const msg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(msg.id, id);
  assert.equal(msg.from, 'test-worker-1', 'from = $AGENT_ID, filled by the CLI');
  assert.equal(msg.to, 'god');
  assert.equal(msg.act, 'done');
  assert.equal(msg.subject, 'Shipped the thing');
  assert.equal(msg.body, 'Card X done.\n\nMulti-line body with "quotes" and stuff.');
  assert.equal(msg.hops, 0);
  assert.equal(msg.requires_reply, false, 'done is terminal — no reply expected');
  assert.equal(msg.in_reply_to, null);
  assert.match(msg.conversation, /^conv-/, 'a fresh conversation is minted when not given');
  assert.ok(!Number.isNaN(Date.parse(msg.created_at)), 'created_at is ISO-parseable');
  assert.equal(msg.needs_human, false);
});

test('--conversation and --in-reply-to carried; requires_reply derives from act', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const out = s.run(
    '--to',
    'god-1',
    '--act',
    'request',
    '--subject',
    'Need a decision',
    '--body',
    'Merge or rebase?',
    '--conversation',
    'conv-card-42',
    '--in-reply-to',
    'god-meredith-ask-20260817',
  );
  const id = out.trim().slice('queued '.length, -'.json'.length);
  const msg = JSON.parse(fs.readFileSync(path.join(s.outbox, `${id}.json`), 'utf8'));
  assert.equal(msg.conversation, 'conv-card-42');
  assert.equal(msg.in_reply_to, 'god-meredith-ask-20260817');
  assert.equal(msg.requires_reply, true, 'request expects a reply — derived, not hand-set');
});

test('validation: missing/bad input rejected, nothing written, stderr explains', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  fs.mkdirSync(s.outbox, { recursive: true });

  let r = s.runFail('--act', 'inform', '--subject', 'x', '--body', 'y');
  assert.notEqual(r.code, 0, 'missing --to rejected');
  r = s.runFail('--to', 'god', '--subject', 'x', '--body', 'y');
  assert.notEqual(r.code, 0, 'missing --act rejected');
  r = s.runFail('--to', 'god', '--act', 'nonsense', '--subject', 'x', '--body', 'y');
  assert.notEqual(r.code, 0, 'unknown act rejected');
  assert.match(r.stderr, /act/);
  r = s.runFail('--to', 'god', '--act', 'inform', '--body', 'y');
  assert.notEqual(r.code, 0, 'missing --subject rejected');
  r = s.runFail('--to', 'god', '--act', 'inform', '--subject', 'x');
  assert.notEqual(r.code, 0, 'missing --body rejected');
  r = s.runFail('--to', 'god', '--act', 'inform', '--subject', 'x', '--body', 'y', '--wat', 'z');
  assert.notEqual(r.code, 0, 'unknown flag rejected');

  assert.deepEqual(fs.readdirSync(s.outbox), [], 'nothing written on rejection');
});

test('router integration: a CLI-written mail routes into the inbox and archives under .sent', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  // The recipient must exist before the router can deliver.
  await s.hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: s.hive.root(),
    isGod: true,
  });
  await s.hive.ensureAgent({
    id: 'test-worker-1',
    name: 'Tw',
    provider: 'claude',
    cwd: s.hive.root(),
  });

  const out = s.run('--to', 'god-1', '--act', 'inform', '--subject', 'FYI', '--body', 'all green');
  const id = out.trim().slice('queued '.length, -'.json'.length);

  const routed = s.hive.routeOnce();
  assert.equal(routed, 1, 'the router accepted the CLI-written envelope');
  assert.ok(
    fs.existsSync(path.join(s.outbox, '.sent', `${id}.json`)),
    'archived under outbox/.sent',
  );
  const inboxFile = path.join(s.hive.root(), 'agents', 'god-1', 'inbox', `${id}.json`);
  assert.ok(fs.existsSync(inboxFile), 'delivered into the recipient inbox');
  const delivered = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
  assert.equal(delivered.from, 'test-worker-1', 'sender is authoritative — the owning directory');
  assert.equal(delivered.subject, 'FYI');
});
