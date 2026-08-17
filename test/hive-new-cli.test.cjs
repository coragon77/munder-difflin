'use strict';

/**
 * hive-new (card harness-hive-new-script): the card-free fresh-conversation
 * CLI. Queues "/new" into a LIVE agent pane through the exact mechanism the
 * card-session clear uses — a request JSON dropped into
 * $HIVE_ROOT/session-requests/ (verb 'clear' + optional lead) — but with NO
 * card created or consulted. Refuses the god pane. The main-side half of the
 * contract (emit order, god refusal) lives in session-requests.test.cjs.
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-new-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  const cli = path.join(root, 'bin', 'hive-new');
  // The script only READS registry.json — hand-write the shape it guards on
  // (god via godId AND isGod, one worker) instead of spawning agents.
  const registry = {
    godId: 'god',
    agents: {
      god: { name: 'Michael', isGod: true, provider: 'claude' },
      'creed-msvfirau': { name: 'Creed', provider: 'pi' },
    },
  };
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(registry, null, 2));
  // The app's session-request watcher mkdirs this at start; mirror it so the
  // helper can list even when a test drops nothing.
  fs.mkdirSync(path.join(root, 'session-requests'), { recursive: true });
  const env = { ...process.env, HIVE_ROOT: root };
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
  const requests = () => {
    const dir = path.join(root, 'session-requests');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  };
  return { cli, env, run, runFail, requests, root };
}

test('ensureHive ships an executable hive-new in hive/bin', { skip: !POSIX }, (t) => {
  const s = setup(t);
  assert.ok(fs.existsSync(s.cli), 'hive-new exists in <hive>/bin');
  assert.equal(fs.statSync(s.cli).mode & 0o777, 0o755, 'it is executable');
});

test('happy path: drops a clear request for the agent, no card fields', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const out = s.run('creed-msvfirau');
  const reqs = s.requests();
  assert.equal(reqs.length, 1, 'exactly one request queued');
  assert.deepEqual(reqs[0], { agentId: 'creed-msvfirau', verb: 'clear' });
  assert.match(out, /creed-msvfirau/);
});

test("--lead rides on the request as the fresh conversation's first turn", {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  s.run('creed-msvfirau', '--lead', 'Card "X" — this conversation is scoped to that card');
  assert.deepEqual(s.requests()[0], {
    agentId: 'creed-msvfirau',
    verb: 'clear',
    lead: 'Card "X" — this conversation is scoped to that card',
  });
});

test('refuses the god pane (by id, by godId alias, by isGod entry)', { skip: !POSIX }, (t) => {
  const s = setup(t);
  for (const id of ['god', 'michael-by-flag']) {
    if (id === 'michael-by-flag') {
      // rewrite the registry so the god id is not literally 'god'
      const reg = { godId: id, agents: { [id]: { name: 'Michael', isGod: true } } };
      fs.writeFileSync(path.join(s.root, 'registry.json'), JSON.stringify(reg));
    }
    const r = s.runFail(id);
    assert.notEqual(r.code, 0, `exit 1 for ${id}`);
    assert.match(r.stderr, /god/i);
    assert.equal(s.requests().length, 0, 'no request dropped');
  }
});

test('refuses an unknown agentId (typo guard before the drop)', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const r = s.runFail('creed-msx8l6ju');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no agent/i);
  assert.equal(s.requests().length, 0);
});

test('refuses to run without HIVE_ROOT (same contract as hive-card)', { skip: !POSIX }, (t) => {
  const s = setup(t);
  assert.throws(
    () =>
      execFileSync(process.execPath, [s.cli, 'creed-msvfirau'], {
        env: { ...process.env, HIVE_ROOT: '' },
        encoding: 'utf8',
      }),
    /HIVE_ROOT/,
  );
});

test('usage errors: missing agentId, unknown flag, empty --lead', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const noArg = s.runFail();
  assert.match(noArg.stderr, /usage/);
  const badFlag = s.runFail('creed-msvfirau', '--title', 'x');
  assert.match(badFlag.stderr, /--title/);
  const emptyLead = s.runFail('creed-msvfirau', '--lead', '   ');
  assert.match(emptyLead.stderr, /--lead/);
  assert.equal(s.requests().length, 0);
});
