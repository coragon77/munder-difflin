'use strict';
/**
 * procKill tests — prove the PID-release hardening works on a REAL process
 * tree. Self-contained, no framework — run with `node test/proc-kill.test.cjs`
 * (mirrors test/breaker.test.cjs). POSIX-only assertions (the Windows path is
 * `taskkill /T /F`, exercised in CI on a Windows runner if ever added); on
 * win32 this file exits 0 after a smoke import.
 *
 * Scenario mirroring the leak: a session leader that IGNORES SIGHUP (like a
 * wedged TUI) with a live child of its own. A bare pty kill() leaves both
 * running forever; ensureKilled() must reap the whole group.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { spawn, execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'main', 'procKill.ts');
const PTY_SRC = path.join(__dirname, '..', 'src', 'main', 'pty.ts');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prockill-'));
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
fs.writeFileSync(path.join(out, 'procKill.js'), js, 'utf8');
const { isAlive, hardKillTree, ensureKilled } = require(path.join(out, 'procKill.js'));

/** Load PtyManager with its sibling imports stubbed (electron is type-only and
 *  erased; killAll never touches node-pty spawn paths — we inject sessions). */
function loadPtyManager() {
  // Inside test/ (not os.tmpdir) so require('node-pty') walks up to the repo's
  // node_modules — killAll never calls pty.spawn, but the module loads at import.
  const dir = fs.mkdtempSync(path.join(__dirname, '.pty-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const stubs = {
    shellEnv: 'exports.captureFromLoginShell = () => {};\nexports.userShellPath = () => "/bin/sh";',
    fs: 'exports.expandTilde = (p) => p;',
  };
  for (const [name, body] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(dir, `${name}.js`), body, 'utf8');
  }
  fs.copyFileSync(path.join(out, 'procKill.js'), path.join(dir, 'procKill.js'));
  fs.writeFileSync(
    path.join(dir, 'pty.js'),
    ts.transpileModule(fs.readFileSync(PTY_SRC, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
    'utf8',
  );
  return require(path.join(dir, 'pty.js')).PtyManager;
}

if (process.platform === 'win32') {
  console.log('  ok  (win32: smoke import only — POSIX group semantics not applicable)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Live pids in process group `pgid` (empty when the group is gone). */
function groupPids(pgid) {
  try {
    return execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  } // pgrep exits 1 when no match
}

/** Spawn a detached (own-process-group) leader that traps HUP, with a child. */
function spawnStubbornTree() {
  const proc = spawn('sh', ['-c', 'trap "" HUP; sleep 60 & wait'], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  return proc.pid;
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

(async () => {
  await test('isAlive: true for a live process, false after it dies', async () => {
    const pid = spawnStubbornTree();
    await sleep(200);
    assert.ok(isAlive(pid), 'leader should be alive');
    hardKillTree(pid);
    await sleep(200);
    assert.ok(!isAlive(pid), 'leader should be dead after hardKillTree');
  });

  await test('hardKillTree reaps the WHOLE group, not just the leader', async () => {
    const pid = spawnStubbornTree();
    await sleep(300);
    const before = groupPids(pid);
    assert.ok(before.length >= 2, `expected leader+child in group, saw: ${before.join(',')}`);
    hardKillTree(pid);
    await sleep(300);
    assert.deepEqual(groupPids(pid), [], 'group should be empty');
  });

  await test('SIGHUP alone does NOT kill the stubborn leader (the leak)', async () => {
    const pid = spawnStubbornTree();
    await sleep(200);
    try {
      process.kill(pid, 'SIGHUP');
    } catch {
      /* noop */
    }
    await sleep(300);
    assert.ok(
      isAlive(pid),
      'a HUP-trapping leader survives a bare SIGHUP — this is the leaked-PID case',
    );
    hardKillTree(pid); // cleanup
  });

  await test('ensureKilled escalates after the grace and releases every PID', async () => {
    const pid = spawnStubbornTree();
    await sleep(200);
    try {
      process.kill(pid, 'SIGHUP');
    } catch {
      /* noop */
    } // the polite kill that gets ignored
    ensureKilled(pid, 400);
    await sleep(1200);
    assert.ok(!isAlive(pid), 'leader must be gone after escalation');
    assert.deepEqual(groupPids(pid), [], 'no survivors in the group');
  });

  await test('ensureKilled tolerates bad pids', async () => {
    ensureKilled(undefined);
    ensureKilled(-5);
    ensureKilled(0);
    ensureKilled(1.5);
  });

  await test('hardKillTree probes the group — no blind SIGKILL after the probe says gone', async () => {
    // The recycled-pgid guard: a probe that reports the group gone must gate the
    // group SIGKILL. A blind fire can hit an UNRELATED process group that the
    // kernel recycled onto that id inside the grace window.
    const pid = spawnStubbornTree();
    await sleep(300);
    const real = process.kill;
    const calls = [];
    process.kill = (target, sig) => {
      calls.push([target, String(sig)]);
      if (target === -pid && sig === 0) {
        // Simulate "every group member already exited" — the guard's case.
        const err = new Error('simulated ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return real(target, sig);
    };
    try {
      hardKillTree(pid);
    } finally {
      process.kill = real;
    }
    assert.ok(
      !calls.some(([t, s]) => t === -pid && s === 'SIGKILL'),
      `group SIGKILL attempted after the probe said gone: ${JSON.stringify(calls)}`,
    );
    assert.ok(
      calls.some(([t, s]) => t === pid && s === 'SIGKILL'),
      `a lone surviving leader must still be reaped: ${JSON.stringify(calls)}`,
    );
  });

  await test('hardKillTree on a fully dead tree delivers no kill signal at all', async () => {
    const pid = spawnStubbornTree();
    await sleep(300);
    hardKillTree(pid); // kill it for real first
    await sleep(300);
    assert.deepEqual(groupPids(pid), [], 'precondition: tree fully gone');
    const real = process.kill;
    const calls = [];
    process.kill = (target, sig) => {
      calls.push([target, String(sig)]);
      return real(target, sig);
    };
    try {
      hardKillTree(pid);
    } finally {
      process.kill = real;
    }
    assert.ok(
      calls.every(([, s]) => s === '0'),
      `a dead tree must see probes only, no kill signals: ${JSON.stringify(calls)}`,
    );
  });

  await test('killAll({immediateSweep:true}) reaps each tree synchronously; default defers', async () => {
    const PtyManager = loadPtyManager();
    const stubborn = [spawnStubbornTree(), spawnStubbornTree()];
    await sleep(300);
    const mgr = new PtyManager();
    for (const [i, pid] of stubborn.entries()) {
      mgr.sessions.set(`s${i}`, {
        proc: {
          pid,
          kill: () => {
            try {
              process.kill(pid, 'SIGHUP'); // the polite signal the leader traps
            } catch {
              /* gone */
            }
          },
        },
      });
    }
    mgr.killAll({ immediateSweep: true });
    // The SIGKILL is swept with no grace timer — death is observable well
    // inside a second (the default grace is 4s, and the app is about to exit
    // with its unref'd escalation timer cancelled). Poll briefly: the signal
    // is synchronous, reaping is not.
    let swept = false;
    for (let i = 0; i < 20 && !swept; i++) {
      await sleep(100);
      swept = !isAlive(stubborn[0]) && !isAlive(stubborn[1]);
    }
    assert.ok(swept, 'immediateSweep reaped both trees without the grace timer');
    assert.equal(mgr.sessions.size, 0, 'sessions cleared');

    const deferred = spawnStubbornTree();
    await sleep(300);
    const mgr2 = new PtyManager();
    mgr2.sessions.set('s', {
      proc: {
        pid: deferred,
        kill: () => {
          try {
            process.kill(deferred, 'SIGHUP');
          } catch {
            /* gone */
          }
        },
      },
    });
    mgr2.killAll();
    await sleep(600); // well under the 4s grace
    assert.ok(isAlive(deferred), 'default killAll defers to the grace timer');
    hardKillTree(deferred); // cleanup
  });

  process.exit(failures ? 1 : 0);
})();
