'use strict';

/**
 * hive-inbox drain (card agent-harness-hive-inbox-cli-o-2026-08-17): the read
 * side of the mail plumbing — print every pending mail (from | act | subject,
 * then body) and archive each to inbox/.done/ in the same pass. --peek prints
 * without archiving. Unparseable files are warned about and LEFT in the inbox
 * (a poison file must never eat mail silently). Empty inbox: 'no mail', exit 0.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const POSIX = process.platform !== 'win32';

function setup(t, { agentId = 'test-worker-1', target } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-inbox-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  const cli = path.join(root, 'bin', 'hive-inbox');
  const targetId = target || agentId;
  const inbox = path.join(root, 'agents', targetId, 'inbox');
  const done = path.join(inbox, '.done');
  fs.mkdirSync(inbox, { recursive: true });
  const env = { ...process.env, HIVE_ROOT: root, AGENT_ID: agentId };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const drop = (id, msg) =>
    fs.writeFileSync(path.join(inbox, id + '.json'), JSON.stringify(msg, null, 2), 'utf8');
  const pending = () =>
    fs.existsSync(inbox)
      ? fs
          .readdirSync(inbox)
          .filter((f) => f.endsWith('.json'))
          .sort()
      : [];
  const archived = () =>
    fs.existsSync(done)
      ? fs
          .readdirSync(done)
          .filter((f) => f.endsWith('.json'))
          .sort()
      : [];
  return { hive, root, cli, inbox, done, env, run, drop, pending, archived };
}

const MSG = (over = {}) => ({
  id: '2026-08-18T10-00-00-000Z-aaaaaa',
  conversation: 'conv-1',
  in_reply_to: null,
  from: 'god',
  to: 'test-worker-1',
  act: 'request',
  subject: 'Do the thing',
  body: 'OBJECTIVE: the thing.',
  hops: 0,
  requires_reply: true,
  needs_human: false,
  created_at: '2026-08-18T10:00:00.000Z',
  ...over,
});

test('ensureHive ships an executable hive-inbox in hive/bin', { skip: !POSIX }, (t) => {
  const s = setup(t);
  assert.ok(fs.existsSync(s.cli), 'hive-inbox exists in <hive>/bin');
  assert.equal(fs.statSync(s.cli).mode & 0o777, 0o755, 'it is executable');
});

test('drain: prints from | act | subject then body, archives to .done in the same pass', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.drop('2026-08-18T10-00-00-000Z-aaaaaa', MSG());
  s.drop(
    '2026-08-18T11-00-00-000Z-bbbbbb',
    MSG({
      id: '2026-08-18T11-00-00-000Z-bbbbbb',
      act: 'inform',
      subject: 'FYI',
      body: 'Second message body.',
      requires_reply: false,
    }),
  );

  const r = s.run('drain');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /god \| request \| Do the thing/);
  assert.match(r.stdout, /OBJECTIVE: the thing\./);
  assert.match(r.stdout, /god \| inform \| FYI/);
  assert.match(r.stdout, /Second message body\./);
  assert.ok(
    r.stdout.indexOf('Do the thing') < r.stdout.indexOf('FYI'),
    'oldest mail first (filename = ISO timestamp)',
  );
  assert.deepEqual(s.pending(), [], 'inbox drained');
  assert.deepEqual(
    s.archived(),
    ['2026-08-18T10-00-00-000Z-aaaaaa.json', '2026-08-18T11-00-00-000Z-bbbbbb.json'],
    'both archived',
  );
});

test('--peek: prints without archiving', { skip: !POSIX }, (t) => {
  const s = setup(t);
  s.drop('2026-08-18T10-00-00-000Z-aaaaaa', MSG());
  const r = s.run('drain', '--peek');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /god \| request \| Do the thing/);
  assert.deepEqual(s.pending(), ['2026-08-18T10-00-00-000Z-aaaaaa.json'], 'still pending');
  assert.deepEqual(s.archived(), [], 'nothing archived');
});

test('empty inbox: exit 0 with "no mail"', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const r = s.run('drain');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^no mail\n?$/);
});

test('--agent <id> overrides the caller default', { skip: !POSIX }, (t) => {
  const s = setup(t, { target: 'someone-else' });
  s.drop('2026-08-18T10-00-00-000Z-aaaaaa', MSG({ to: 'someone-else' }));
  const r = s.run('drain', '--agent', 'someone-else');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Do the thing/);
  assert.deepEqual(s.archived(), ['2026-08-18T10-00-00-000Z-aaaaaa.json']);

  // default (no --agent) reads the CALLER's inbox, which is empty here
  const mine = s.run('drain');
  assert.match(mine.stdout, /^no mail\n?$/);
});

test('unparseable message: warned on stderr, left in the inbox, rest still drains', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.inbox, 'poison.json'), 'not json', 'utf8');
  s.drop('2026-08-18T10-00-00-000Z-aaaaaa', MSG());
  const r = s.run('drain');
  assert.equal(r.code, 0, 'the drain still succeeds');
  assert.match(r.stdout, /Do the thing/);
  assert.match(r.stderr, /poison\.json/);
  assert.deepEqual(s.pending(), ['poison.json'], 'poison file left for inspection');
  assert.deepEqual(s.archived(), ['2026-08-18T10-00-00-000Z-aaaaaa.json']);
});

test('usage guard: unknown subcommand or flags fail with an explanation', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  for (const args of [[''], ['nonsense'], ['drain', '--nope'], ['drain', 'extra-positional']]) {
    const argv = args.filter((a) => a !== '');
    const r = s.run(...argv);
    assert.notEqual(r.code, 0, 'refused: ' + argv.join(' '));
    assert.ok(r.stderr.trim(), 'explains itself: ' + argv.join(' '));
  }
});
