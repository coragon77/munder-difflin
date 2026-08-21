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
const { randomUUID } = require('node:crypto');
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

  // NO_SCOPE pins the plain detached-spawn path: the systemd-scope launcher is
  // exercised by its own opt-in test below; every other test stays
  // deterministic and free of transient user scopes.
  const command = (args, env = {}, opts = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        HIVE_ROOT: root,
        ...(opts.allowScope ? {} : { HIVE_RESTART_WINDOW_NO_SCOPE: '1' }),
        ...env,
      },
      encoding: 'utf8',
    });
  const run = (target, env = {}) =>
    command(['run', target, '--repo', live], {
      HIVE_RESTART_WINDOW_DIRECT_RUN: '1',
      HIVE_RESTART_WINDOW_SKIP_WAIT: '1',
      ...env,
    });
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'restart-window.json'), 'utf8'));
  const log = () => fs.readFileSync(path.join(root, 'restart-merge.log'), 'utf8');

  return { root, cli, live, worker, remote, command, run, state, log };
}

// Test seam for the watcher's build step: stand in for `npm run build` by
// producing exactly the artifact the completion verdict requires.
const BUILD_OK = "mkdir -p out/main && echo 'post-merge bundle' > out/main/index.js";

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

// The 2026-08-18 incident shape: a target that is current on origin/main, a
// clean live checkout, and a watcher whose completion verdict must depend on
// the BUILT artifact, not the checkout sha. Shared by the build-gate tests.
function landableTarget(s) {
  commit(s.worker, 'worker.txt', 'worker\n', 'worker landing');
  git(s.worker, 'push', 'origin', 'main');
  git(s.live, 'fetch', 'origin', 'main');
  git(s.live, 'switch', '-c', 'renderer-batch', 'origin/main');
  const target = commit(s.live, 'batch.txt', 'batch\n', 'renderer batch');
  git(s.live, 'switch', 'main');
  return target;
}

test('current target advances both origin/main and the live checkout', { skip: !POSIX }, (t) => {
  const s = setup(t);
  const target = landableTarget(s);

  const r = s.run(target, { HIVE_RESTART_WINDOW_BUILD_CMD: BUILD_OK });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(s.live, 'rev-parse', 'HEAD'), target);
  assert.equal(git(s.remote, 'rev-parse', 'refs/heads/main'), target);
  assert.equal(s.state().status, 'completed');
  // The post-sync leg is observable end to end — a death anywhere in it is
  // bracketed to the second (incident 2026-08-20: two watchers died in a
  // fully silent push->merge->build leg).
  assert.match(s.log(), /restart window open/);
  assert.match(s.log(), /pushed target .* to origin\/main/);
  assert.match(s.log(), /live checkout fast-forwarded to target/);
  assert.match(s.log(), /building live checkout: /);
  assert.match(s.log(), /completed: live checkout and origin\/main at/);
  assert.ok(
    fs.existsSync(path.join(s.live, 'out', 'main', 'index.js')),
    'completion certifies a built artifact, not just the checkout sha',
  );
  assert.match(s.log(), /live build verified: out\/main\/index\.js rebuilt/);
});

test('a pre-merge build is never called complete — stale out/main/index.js fails loudly', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const target = landableTarget(s);

  // The live checkout already ran a build: out/main/index.js predates the merge.
  fs.mkdirSync(path.join(s.live, 'out', 'main'), { recursive: true });
  fs.writeFileSync(path.join(s.live, 'out', 'main', 'index.js'), 'pre-merge build\n', 'utf8');

  // A build step that "succeeds" without rebuilding the artifact is the false
  // "landed" report of 2026-08-18 (checkout at target, bundle pre-merge).
  const r = s.run(target, { HIVE_RESTART_WINDOW_BUILD_CMD: 'true' });
  assert.notEqual(r.status, 0, 'a stale build must never be reported complete');
  assert.equal(git(s.live, 'rev-parse', 'HEAD'), target, 'the merge itself still landed');
  assert.equal(s.state().status, 'failed');
  assert.match(s.state().reason, /out\/main\/index\.js was not rebuilt after the merge/);
  assert.match(s.log(), /ABORT: out\/main\/index\.js was not rebuilt after the merge/);
});

test('a failed build step reports failed with the build error, never completed', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const target = landableTarget(s);

  const r = s.run(target, { HIVE_RESTART_WINDOW_BUILD_CMD: 'echo bundle-boom >&2; exit 3' });
  assert.notEqual(r.status, 0);
  assert.equal(s.state().status, 'failed');
  assert.match(s.state().reason, /live build failed \(exit 3\): bundle-boom/);
  assert.match(s.log(), /ABORT: live build failed/);
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
  // NO_SCOPE: the raw spawn() invocations below bypass command()'s pin; the
  // scope launcher has its own dedicated test.
  const env = { HIVE_RESTART_PROCESS_PATTERN: token, HIVE_RESTART_WINDOW_NO_SCOPE: '1' };
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

// ── Incident 2026-08-20/21: two watchers were killed externally in the
// post-sync leg and left restart-window.json reading "syncing" forever. A
// dead watcher must never read as in-progress, and a signal death must leave
// a post-mortem instead of silence.

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate, what) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for ' + what);
};

test('a dead watcher never reads as in-progress — status reaps it to failed', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const target = git(s.live, 'rev-parse', 'HEAD');
  const token = `md-restart-window-dead-${process.pid}-${Date.now()}`;
  const env = { HIVE_RESTART_PROCESS_PATTERN: token };

  const armed = s.command(['arm', target, '--repo', s.live], env);
  assert.equal(armed.status, 0, armed.stderr);
  const pid = s.state().pid;
  assert.ok(alive(pid));

  // The incident shape: the watcher is killed externally (SIGKILL leaves no
  // chance for cleanup) while armed/syncing.
  process.kill(pid, 'SIGKILL');
  await waitFor(() => !alive(pid), 'watcher death');

  const r = s.command(['status']);
  assert.equal(r.status, 0, r.stderr);
  const reaped = JSON.parse(r.stdout);
  assert.equal(reaped.status, 'failed', 'a dead watcher is failed, never in-progress');
  assert.match(reaped.reason, new RegExp(`pid ${pid} died during armed`));
  assert.match(s.log(), /reaped dead watcher/);

  // The reaped state is terminal: disarm reports not armed, arm can re-arm.
  const d = s.command(['disarm'], env);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /not armed/);
});

test('a signal death lands a post-mortem — SIGTERM never kills silently', {
  skip: !POSIX,
}, async (t) => {
  const s = setup(t);
  const target = git(s.live, 'rev-parse', 'HEAD');
  const token = `md-restart-window-term-${process.pid}-${Date.now()}`;

  const child = spawn(process.execPath, [s.cli, 'run', target, '--repo', s.live], {
    env: {
      ...process.env,
      HIVE_ROOT: s.root,
      HIVE_RESTART_WINDOW_DIRECT_RUN: '1',
      HIVE_RESTART_WINDOW_NO_SCOPE: '1',
      HIVE_RESTART_PROCESS_PATTERN: token, // window never opens: stays armed
    },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  t.after(() => {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {}
  });

  await waitFor(() => {
    try {
      return s.state().status === 'armed' && s.state().pid === child.pid;
    } catch {
      return false;
    }
  }, 'watcher armed publish');

  process.kill(child.pid, 'SIGTERM');
  await waitFor(() => !alive(child.pid), 'watcher SIGTERM exit');

  const st = s.state();
  assert.equal(st.status, 'failed', 'the signal handler records the death');
  assert.match(st.reason, /SIGTERM/);
  assert.match(s.log(), /ABORT: watcher received SIGTERM during armed/);
});

test('the run verb reads target/repo from env — argv keeps only the instance', {
  skip: !POSIX,
}, (t) => {
  const s = setup(t);
  const target = landableTarget(s);

  // The spawned watcher carries target/repo/note in ENV, not argv: its
  // command line must not share the app's broad pattern-kill surface
  // (a pkill -f <repo-path> took a watcher down with the app, 2026-08-20).
  const r = s.command(['run', '--instance', randomUUID()], {
    HIVE_RESTART_WINDOW_DIRECT_RUN: '1',
    HIVE_RESTART_WINDOW_SKIP_WAIT: '1',
    HIVE_RESTART_WINDOW_BUILD_CMD: BUILD_OK,
    HIVE_RESTART_WINDOW_TARGET: target,
    HIVE_RESTART_WINDOW_REPO: s.live,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.state().status, 'completed');
  assert.equal(s.state().target, target);
  assert.equal(git(s.live, 'rev-parse', 'HEAD'), target);
});

// The root-cause fix: detached:true escapes the session and process group
// but NOT the systemd scope cgroup the armer lives in — an app-scope stop
// (KillMode=control-group, FinalKillSignal=9) sweeps everything still
// inside, watcher included. With a user session available the watcher is
// launched in its OWN transient scope, outside the app's cgroup.
function scopeLaunchAvailable() {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return false;
  const probe = spawnSync('systemd-run', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

function ownCgroupScope() {
  try {
    const raw = fs.readFileSync('/proc/self/cgroup', 'utf8').trim();
    const segment = raw.split('\n')[0]?.split(':').pop() ?? '';
    return path.basename(segment);
  } catch {
    return '';
  }
}

test('the watcher escapes the armer systemd scope cgroup', {
  skip: !POSIX || !scopeLaunchAvailable() || !ownCgroupScope(),
}, async (t) => {
  const s = setup(t);
  const target = git(s.live, 'rev-parse', 'HEAD');
  const token = `md-restart-window-scope-${process.pid}-${Date.now()}`;
  const env = { HIVE_RESTART_PROCESS_PATTERN: token };

  const armed = s.command(['arm', target, '--repo', s.live], env, { allowScope: true });
  assert.equal(armed.status, 0, armed.stderr);
  const st = s.state();
  assert.ok(alive(st.pid), 'arm returns with a live watcher pid');

  const watcherCgroup = fs
    .readFileSync(`/proc/${st.pid}/cgroup`, 'utf8')
    .trim()
    .split('\n')[0]
    ?.split(':')
    .pop();
  assert.ok(watcherCgroup, 'watcher cgroup readable');
  assert.ok(
    !watcherCgroup.includes(ownCgroupScope()),
    `watcher must not sit in the armer's scope (armer: ${ownCgroupScope()}, watcher: ${watcherCgroup})`,
  );

  const disarmed = s.command(['disarm'], env);
  assert.equal(disarmed.status, 0, disarmed.stderr);
  await waitFor(() => !alive(st.pid), 'scoped watcher stop');
  assert.equal(s.state().status, 'disarmed');
});
