'use strict';

/**
 * Durable restart-window integration: a detached watcher must never land a
 * batch that stopped containing origin/main while it was armed. Before making
 * that decision it fast-forwards the live checkout to origin/main, so a refused
 * renderer batch still restarts the harness on the latest landed main.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const POSIX = process.platform !== 'win32';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd, file, body, message) {
  fs.writeFileSync(path.join(cwd, file), body, 'utf8');
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function configure(cwd) {
  git(cwd, 'config', 'user.name', 'Restart Window Test');
  git(cwd, 'config', 'user.email', 'restart-window@example.invalid');
}

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-restart-window-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  const cli = path.join(root, 'bin', 'hive-restart-window');
  const remote = path.join(home, 'origin.git');
  const seed = path.join(home, 'seed');
  const live = path.join(home, 'live');
  const worker = path.join(home, 'worker');

  git(home, 'init', '--bare', '--initial-branch=main', remote);
  fs.mkdirSync(seed);
  git(seed, 'init', '--initial-branch=main');
  configure(seed);
  commit(seed, 'base.txt', 'base\n', 'base');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');

  git(home, 'clone', '--branch', 'main', remote, live);
  git(home, 'clone', '--branch', 'main', remote, worker);
  configure(live);
  configure(worker);

  const command = (args, env = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, HIVE_ROOT: root, ...env },
      encoding: 'utf8',
    });
  const run = (target) =>
    command(['run', target, '--repo', live], {
      HIVE_RESTART_WINDOW_DIRECT_RUN: '1',
      HIVE_RESTART_WINDOW_SKIP_WAIT: '1',
    });
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'restart-window.json'), 'utf8'));
  const log = () => fs.readFileSync(path.join(root, 'restart-merge.log'), 'utf8');

  return { root, cli, live, worker, remote, command, run, state, log };
}

test('ensureHive ships an executable hive-restart-window CLI', { skip: !POSIX }, (t) => {
  const s = setup(t);
  assert.ok(fs.existsSync(s.cli));
  assert.equal(fs.statSync(s.cli).mode & 0o777, 0o755);
});

test('stale target is refused loudly after the live checkout syncs to origin/main', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);

  git(s.live, 'switch', '-c', 'renderer-batch');
  const staleTarget = commit(s.live, 'batch.txt', 'batch\n', 'renderer batch');
  git(s.live, 'switch', 'main');

  const originTip = commit(s.worker, 'worker.txt', 'worker\n', 'worker landing');
  git(s.worker, 'push', 'origin', 'main');

  const r = s.run(staleTarget);
  assert.notEqual(r.status, 0, 'a stale batch is a refusal, not success');
  assert.equal(git(s.live, 'rev-parse', 'HEAD'), originTip, 'live checkout caught up first');
  assert.match(s.log(), /REFUSED: target went stale/);
  assert.deepEqual(
    { status: s.state().status, target: s.state().target, originMain: s.state().originMain },
    { status: 'refused', target: staleTarget, originMain: originTip },
  );
  assert.match(s.state().reason, new RegExp(`${staleTarget}.*origin/main ${originTip}`));
});

test('current target advances both origin/main and the live checkout', { skip: !POSIX }, (t) => {
  const s = setup(t);

  commit(s.worker, 'worker.txt', 'worker\n', 'worker landing');
  git(s.worker, 'push', 'origin', 'main');
  git(s.live, 'fetch', 'origin', 'main');
  git(s.live, 'switch', '-c', 'renderer-batch', 'origin/main');
  const target = commit(s.live, 'batch.txt', 'batch\n', 'renderer batch');
  git(s.live, 'switch', 'main');

  const r = s.run(target);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(s.live, 'rev-parse', 'HEAD'), target);
  assert.equal(git(s.remote, 'rev-parse', 'refs/heads/main'), target);
  assert.equal(s.state().status, 'completed');
  assert.match(s.log(), /completed: live checkout and origin\/main at/);
});

test('dirty live checkout aborts without moving main or origin/main', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const main = git(s.live, 'rev-parse', 'HEAD');
  git(s.live, 'switch', '-c', 'renderer-batch');
  const target = commit(s.live, 'batch.txt', 'batch\n', 'renderer batch');
  git(s.live, 'switch', 'main');
  fs.writeFileSync(path.join(s.live, 'base.txt'), 'dirty\n', 'utf8');

  const r = s.run(target);
  assert.notEqual(r.status, 0);
  assert.equal(git(s.live, 'rev-parse', 'HEAD'), main);
  assert.equal(git(s.remote, 'rev-parse', 'refs/heads/main'), main);
  assert.equal(s.state().status, 'failed');
  assert.match(s.state().reason, /tracked changes/);
  assert.match(s.log(), /ABORT: live checkout has tracked changes/);
});

test('retarget serializes its pid handoff; disarm verifies process ownership', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const firstTarget = git(s.live, 'rev-parse', 'HEAD');
  git(s.live, 'switch', '-c', 'renderer-batch');
  const secondTarget = commit(s.live, 'batch.txt', 'batch\n', 'renderer batch');
  const thirdTarget = commit(s.live, 'batch-2.txt', 'batch 2\n', 'renderer batch 2');
  git(s.live, 'switch', 'main');

  const token = `md-restart-window-hold-${process.pid}-${Date.now()}`;
  const hold = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', token], {
    detached: true,
    stdio: 'ignore',
  });
  hold.unref();
  t.after(() => {
    try {
      process.kill(hold.pid, 'SIGKILL');
    } catch {}
  });
  const env = { HIVE_RESTART_PROCESS_PATTERN: token };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (predicate) => {
    for (let i = 0; i < 50; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('timed out waiting for watcher lifecycle change');
  };

  const armed = s.command(['arm', firstTarget, '--repo', s.live], env);
  assert.equal(armed.status, 0, armed.stderr);
  const firstPid = s.state().pid;
  assert.ok(alive(firstPid), 'arm publishes a live watcher pid');

  const retargeted = s.command(['retarget', secondTarget, '--repo', s.live], env);
  assert.equal(retargeted.status, 0, retargeted.stderr);
  const secondPid = s.state().pid;
  assert.notEqual(secondPid, firstPid, 'retarget launches a replacement');
  await waitFor(() => !alive(firstPid));
  assert.ok(alive(secondPid), 'replacement watcher is live');
  assert.equal(s.state().target, secondTarget);

  const lockPath = path.join(s.root, 'restart-window.json.lock');
  fs.writeFileSync(lockPath, 'held by test\n', 'utf8');
  const retargetExits = [undefined, undefined];
  const retargetErrors = ['', ''];
  const retargetDone = retargetExits.map((_, index) => {
    const child = spawn(process.execPath, [s.cli, 'retarget', thirdTarget, '--repo', s.live], {
      env: { ...process.env, HIVE_ROOT: s.root, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
      retargetErrors[index] += chunk;
    });
    return new Promise((resolve) => {
      child.on('close', (code) => {
        retargetExits[index] = code;
        resolve();
      });
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    retargetExits,
    [undefined, undefined],
    'the held lifecycle lock keeps competing retargets pending',
  );
  assert.equal(s.state().pid, secondPid, 'the active watcher stays authoritative while locked');
  assert.ok(alive(secondPid));
  fs.unlinkSync(lockPath);
  await Promise.all(retargetDone);
  assert.deepEqual(retargetExits, [0, 0], retargetErrors.join('\n'));
  const thirdState = s.state();
  const thirdPid = thirdState.pid;
  const replacementPids = [...s.log().matchAll(/retargeted watcher pid \d+ -> (\d+)/g)].map(
    (match) => Number(match[1]),
  );
  await waitFor(() => replacementPids.every((pid) => pid === thirdPid || !alive(pid)));
  assert.ok(alive(thirdPid), 'only the final serialized replacement stays live');
  assert.equal(thirdState.target, thirdTarget);
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the child publish its armed ack

  fs.writeFileSync(
    path.join(s.root, 'restart-window.json'),
    JSON.stringify({ ...thirdState, status: 'syncing' }, null, 2),
    'utf8',
  );
  const syncingRefusal = s.command(['disarm'], env);
  assert.notEqual(syncingRefusal.status, 0, 'syncing ownership cannot be interrupted');
  assert.ok(alive(thirdPid));

  fs.writeFileSync(
    path.join(s.root, 'restart-window.json'),
    JSON.stringify({ ...thirdState, instance: 'not-the-live-process' }, null, 2),
    'utf8',
  );
  const wrongOwner = s.command(['disarm'], env);
  assert.notEqual(wrongOwner.status, 0, 'a stale/reused pid is never signalled');
  assert.ok(alive(thirdPid));
  fs.writeFileSync(
    path.join(s.root, 'restart-window.json'),
    JSON.stringify(thirdState, null, 2),
    'utf8',
  );

  const disarmed = s.command(['disarm'], env);
  assert.equal(disarmed.status, 0, disarmed.stderr);
  await waitFor(() => !alive(thirdPid));
  assert.equal(s.state().status, 'disarmed');
  assert.equal(s.state().pid, thirdPid, 'state records exactly which pid was stopped');
  assert.match(s.log(), new RegExp(`disarmed watcher pid ${thirdPid}`));
});

test('corrupt published state is loud and can never mean not armed', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const statePath = path.join(s.root, 'restart-window.json');
  fs.writeFileSync(statePath, '{broken', 'utf8');

  let r = s.command(['status']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /restart-window\.json is not parseable JSON/);
  assert.doesNotMatch(r.stdout, /not armed/);

  fs.writeFileSync(statePath, JSON.stringify({ status: 'armed' }), 'utf8');
  r = s.command(['status']);
  assert.notEqual(r.status, 0, 'valid JSON with no active watcher identity is still corrupt');
  assert.match(r.stderr, /armed state.*pid.*instance/i);

  fs.writeFileSync(
    statePath,
    JSON.stringify({
      status: 'armed',
      pid: process.pid,
      instance: 'node',
      target: git(s.live, 'rev-parse', 'HEAD'),
      repo: s.live,
    }),
    'utf8',
  );
  r = s.command(['status']);
  assert.notEqual(r.status, 0, 'generic process-name fragments are not valid ownership tokens');
  assert.match(r.stderr, /UUID instance/);
});

test('the internal run verb refuses direct callers without the explicit test seam', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const target = git(s.live, 'rev-parse', 'HEAD');

  const r = s.command(['run', target, '--repo', s.live], {
    HIVE_RESTART_WINDOW_SKIP_WAIT: '1',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /internal run verb/);
});
