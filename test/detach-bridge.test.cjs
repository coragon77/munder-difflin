'use strict';

/**
 * Detach-to-kitty bridge (card harness-detach-to-kitty-20260817).
 *
 * Detach = main opens a per-agent bidirectional unix-socket bridge onto the
 * EXISTING pty (the pane is only a view) and launches a kitty window running
 * a thin raw-mode client. The agent process never notices: floor sprite,
 * fleet.json, breaker, inbox all stay live. NOT the vacation machinery —
 * nothing is parked, no session handoff.
 *
 * This file pins the main-process half (deps-injected, electron-free — the
 * vacationFlow precedent):
 *
 *   • kittyLaunchPlan — the kitty ladder: a running remote-control socket
 *     wins (window in the live satellite), else a fresh kitty, else refuse.
 *     The client must run under ELECTRON_RUN_AS_NODE in BOTH modes.
 *   • DetachBridge — sockets + lifecycle: replay-then-tap output routing,
 *     client input → pty, hello/resize size ownership (kitty owns it while
 *     detached), bye/manual-close auto-reattach, double-detach refusal,
 *     client-never-connected timeout, unknown-pty refusal.
 *   • the real client script (resources/md-detach-client.cjs), exercised as
 *     a child process against a live bridge: hello with fallback size,
 *     bidirectional passthrough, resize on WINCH (skipped without a TTY),
 *     exit on bye.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { DetachBridge, kittyLaunchPlan } = loadTs('src/main/detachBridge.ts');

// ─── kittyLaunchPlan ────────────────────────────────────────────────────────

const PLAN_BASE = {
  kittySocketExists: true,
  kittySocket: '/tmp/md-kitty-1000.sock',
  kittyBin: '/usr/local/bin/kitty',
  execPath: '/Applications/MD.app/Contents/MacOS/MD',
  clientScript: '/x/resources/md-detach-client.cjs',
  dataSock: '/tmp/md-detach/p1.data.sock',
  ctlSock: '/tmp/md-detach/p1.ctl.sock',
  title: 'Ada',
};

test('launch plan prefers a live remote-control socket (window in the satellite)', () => {
  const p = kittyLaunchPlan(PLAN_BASE);
  assert.equal(p.mode, 'remote');
  assert.equal(p.file, '/usr/local/bin/kitty');
  assert.ok(p.args.includes('launch'));
  assert.ok(p.args.includes('--type=window'));
  const toIdx = p.args.indexOf('--to');
  assert.equal(p.args[toIdx + 1], 'unix:/tmp/md-kitty-1000.sock');
  // The remote mode cannot pass an env object — ELECTRON_RUN_AS_NODE rides argv.
  assert.ok(p.args.includes('--env'), 'remote launch carries --env');
  assert.equal(p.args[p.args.indexOf('--env') + 1], 'ELECTRON_RUN_AS_NODE=1');
  // Client argv rides the tail: execPath, script, data sock, ctl sock.
  assert.deepEqual(p.args.slice(-4), [
    PLAN_BASE.execPath,
    PLAN_BASE.clientScript,
    PLAN_BASE.dataSock,
    PLAN_BASE.ctlSock,
  ]);
  // env is not used in remote mode (argv-only)
  assert.deepEqual(p.env ?? {}, {});
});

test('launch plan falls back to a fresh kitty when no socket is live', () => {
  const p = kittyLaunchPlan({ ...PLAN_BASE, kittySocketExists: false });
  assert.equal(p.mode, 'fresh');
  assert.equal(p.file, '/usr/local/bin/kitty');
  assert.ok(p.args.includes('--title'));
  assert.equal(p.args[p.args.indexOf('--title') + 1], 'Ada');
  assert.deepEqual(p.args.slice(-4), [
    PLAN_BASE.execPath,
    PLAN_BASE.clientScript,
    PLAN_BASE.dataSock,
    PLAN_BASE.ctlSock,
  ]);
  // Fresh spawn CAN take an env object.
  assert.equal(p.env.ELECTRON_RUN_AS_NODE, '1');
});

test('launch plan refuses when kitty is not installed', () => {
  const p = kittyLaunchPlan({ ...PLAN_BASE, kittyBin: null });
  assert.equal(p.mode, 'none');
  assert.ok(p.error);
});

test('launch plan takes the socket path from the argument, not a constant', () => {
  const p = kittyLaunchPlan({ ...PLAN_BASE, kittySocket: '/custom/kitty.sock' });
  assert.equal(p.mode, 'remote');
  assert.equal(p.args[p.args.indexOf('--to') + 1], 'unix:/custom/kitty.sock');
});

// ─── DetachBridge harness ───────────────────────────────────────────────────

/** Bridge deps with an in-memory pty and a record tape. `out` is the pty's
 *  pending output-tail (replay source). */
function makeDeps(over = {}) {
  const t = {
    events: [],
    push(e) {
      this.events.push(e);
    },
  };
  const state = { taps: new Map(), out: over.tail ?? 'REPLAY-BYTES' };
  const deps = {
    socketDir: over.socketDir,
    connectTimeoutMs: over.connectTimeoutMs ?? 2000,
    ptyExists: (id) => !over.missing?.includes(id),
    ptyWrite: (id, data) => t.push({ kind: 'write', id, data }),
    ptyResize: (id, cols, rows) => t.push({ kind: 'resize', id, cols, rows }),
    ptyOutputTail: () => state.out,
    tapOutput: (id, fn) => {
      fn ? state.taps.set(id, fn) : state.taps.delete(id);
    },
    launchKitty: (o) => {
      t.push({ kind: 'spawn', ...o });
      return { ok: true };
    },
    notify: (e) => t.push({ kind: 'notify', ...e }),
    log: () => {},
  };
  return { deps, t, state };
}

/** Connect a FAKE kitty client (ctl + data sockets); resolves handlers. */
function fakeClient(dir, id, onCtlLine) {
  const ac = new Promise((res) => {
    const ctl = net.connect(path.join(dir, `${id}.ctl.sock`), () => res(ctl));
    ctl.on('data', (d) => {
      for (const line of d.toString().split('\n'))
        if (line.trim() && onCtlLine) onCtlLine(line, ctl);
    });
  });
  const ad = new Promise((res) => {
    const data = net.connect(path.join(dir, `${id}.data.sock`), () => res(data));
    data.setEncoding('utf8');
  });
  return { ctlP: ac, dataP: ad };
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-detach-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A bridge that ALWAYS gets disposed — open socket servers keep the node
 *  event loop (and the test runner) alive otherwise. */
function mkBridge(t, deps) {
  const b = new DetachBridge(deps);
  t.after(() => b.disposeAll());
  return b;
}

test('detach: replay then live tap out, client input in, hello owns the size', async (t) => {
  const dir = tmpDir(t);
  const { deps, t: tape, state } = makeDeps({ socketDir: dir });
  const bridge = mkBridge(t, deps);

  const res = await bridge.detach('p1', 'Ada');
  assert.equal(res.ok, true);
  assert.equal(bridge.isDetached('p1'), true);
  assert.equal(tape.events.filter((e) => e.kind === 'spawn').length, 1, 'kitty client spawned');

  const got = [];
  const { ctlP, dataP } = fakeClient(dir, 'p1');
  const data = await dataP;
  data.on('data', (chunk) => got.push(chunk));
  const ctl = await ctlP;
  ctl.write('{"t":"hello","cols":120,"rows":40}\n');

  // Replay lands first, then live tap bytes.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(got.join(''), 'REPLAY-BYTES', 'pty tail is replayed into the client');
  state.taps.get('p1')('LIVE-OUT');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(got.join(''), 'REPLAY-BYTESLIVE-OUT');

  // hello resized the pty to the kitty window's size.
  assert.deepEqual(
    tape.events.find((e) => e.kind === 'resize'),
    { kind: 'resize', id: 'p1', cols: 120, rows: 40 },
  );

  // Client keystrokes reach the pty.
  data.write('hello-agent');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    tape.events.find((e) => e.kind === 'write'),
    { kind: 'write', id: 'p1', data: 'hello-agent' },
  );

  // Renderer is told the pane is now read-only.
  assert.deepEqual(
    tape.events.find((e) => e.kind === 'notify'),
    { kind: 'notify', id: 'p1', detached: true },
  );
  bridge.disposeAll();
});

test('resize frames from the client re-resize the pty while detached', async (t) => {
  const dir = tmpDir(t);
  const { deps, t: tape } = makeDeps({ socketDir: dir });
  const bridge = mkBridge(t, deps);
  await bridge.detach('p1', 'Ada');

  const { ctlP } = fakeClient(dir, 'p1');
  const ctl = await ctlP;
  ctl.write('{"t":"hello","cols":100,"rows":30}\n');
  ctl.write('{"t":"resize","cols":80,"rows":24}\n');
  await new Promise((r) => setTimeout(r, 50));
  const resizes = tape.events.filter((e) => e.kind === 'resize');
  assert.deepEqual(resizes, [
    { kind: 'resize', id: 'p1', cols: 100, rows: 30 },
    { kind: 'resize', id: 'p1', cols: 80, rows: 24 },
  ]);
  bridge.disposeAll();
});

test('reattach: bye tells the client to exit, state clears, pane re-enabled', async (t) => {
  const dir = tmpDir(t);
  const { deps, t: tape, state } = makeDeps({ socketDir: dir });
  const bridge = mkBridge(t, deps);
  await bridge.detach('p1', 'Ada');
  const { ctlP, dataP } = fakeClient(dir, 'p1');
  const ctl = await ctlP;
  await dataP;

  let bye = '';
  ctl.on('data', (d) => {
    bye += d.toString();
  });
  const res = bridge.reattach('p1');
  assert.equal(res.ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(bye.includes('"t":"bye"'), 'client is told to close its window');
  assert.equal(bridge.isDetached('p1'), false);
  assert.equal(state.taps.size, 0, 'output tap removed');
  assert.ok(tape.events.some((e) => e.kind === 'notify' && e.id === 'p1' && e.detached === false));
  // Sockets are gone — a new listen on the same path would not collide.
  assert.equal(fs.existsSync(path.join(dir, 'p1.data.sock')), false);
});

test('manual kitty close auto-reattaches', async (t) => {
  const dir = tmpDir(t);
  const { deps, t: tape } = makeDeps({ socketDir: dir });
  const bridge = mkBridge(t, deps);
  await bridge.detach('p1', 'Ada');
  const { ctlP, dataP } = fakeClient(dir, 'p1');
  const ctl = await ctlP;
  const data = await dataP;
  ctl.destroy();
  data.destroy();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(bridge.isDetached('p1'), false);
  assert.ok(tape.events.some((e) => e.kind === 'notify' && e.id === 'p1' && e.detached === false));
});

test('detach while detached is refused (idempotent guard)', async (t) => {
  const dir = tmpDir(t);
  const { deps } = makeDeps({ socketDir: dir });
  const bridge = mkBridge(t, deps);
  assert.equal((await bridge.detach('p1', 'Ada')).ok, true);
  const again = await bridge.detach('p1', 'Ada');
  assert.equal(again.ok, false);
  assert.ok(again.error);
  bridge.disposeAll();
});

test('detach of an unknown pty is refused', async (t) => {
  const dir = tmpDir(t);
  const { deps } = makeDeps({ socketDir: dir, missing: ['ghost'] });
  const bridge = mkBridge(t, deps);
  const res = await bridge.detach('ghost', 'Ghost');
  assert.equal(res.ok, false);
  assert.ok(res.error);
  assert.equal(bridge.isDetached('ghost'), false);
});

test('client that never connects times out and auto-reattaches', async (t) => {
  const dir = tmpDir(t);
  const { deps, t: tape } = makeDeps({ socketDir: dir, connectTimeoutMs: 150 });
  const bridge = mkBridge(t, deps);
  assert.equal((await bridge.detach('p1', 'Ada')).ok, true);
  // NO client connects — the timeout must fire.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bridge.isDetached('p1'), false);
  const n = tape.events.find((e) => e.kind === 'notify' && e.detached === false);
  assert.ok(n, 'renderer is told the pane is active again');
  assert.ok(n.error, 'the notice carries the failure reason');
});

test('a second client on the same sockets is destroyed — one view at a time', async (t) => {
  const dir = tmpDir(t);
  const { deps } = makeDeps({ socketDir: dir });
  const bridge = mkBridge(t, deps);
  await bridge.detach('p1', 'Ada');
  const first = await fakeClient(dir, 'p1');
  await first.ctlP;
  const d1 = await first.dataP;
  let secondGone = false;
  const intruder = net.connect(path.join(dir, 'p1.data.sock'));
  intruder.on('close', () => {
    secondGone = true;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(secondGone, true, 'intruder connection is dropped');
  assert.equal(bridge.isDetached('p1'), true, 'the first client keeps the bridge');
  d1.destroy();
  bridge.disposeAll();
});

// ─── the real client script ─────────────────────────────────────────────────

const CLIENT = path.resolve(__dirname, '..', 'resources', 'md-detach-client.cjs');

test('client: hello with fallback size, passthrough both ways, exit on bye', async (t) => {
  const dir = tmpDir(t);
  const { deps, t: tape } = makeDeps({ socketDir: dir, connectTimeoutMs: 5000 });
  const bridge = mkBridge(t, deps);
  assert.equal((await bridge.detach('p1', 'Ada')).ok, true);

  const ctlLine = '';
  const ctlServerSeen = new Promise((res) => {
    // capture hello via a passive peek: the bridge resizes on hello, which is
    // our observable — no socket tap needed. We wait for the resize event.
    const deadline = Date.now() + 3000;
    const iv = setInterval(() => {
      if (tape.events.some((e) => e.kind === 'resize') || Date.now() > deadline) {
        clearInterval(iv);
        res();
      }
    }, 20);
  });

  const child = spawn(
    process.execPath,
    [CLIENT, path.join(dir, 'p1.data.sock'), path.join(dir, 'p1.ctl.sock')],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* gone */
    }
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d.toString();
  });
  let err = '';
  child.stderr.on('data', (d) => {
    err += d.toString();
  });

  // The pty (fake) emits live output through the tap — the child must print it.
  await ctlServerSeen; // hello landed (fallback size without a TTY)
  const hello = tape.events.find((e) => e.kind === 'resize');
  assert.ok(hello, 'hello arrived with a fallback size');
  assert.ok(hello.cols > 0 && hello.rows > 0);

  // give the data pipe a moment, then push live output + read input
  await new Promise((r) => setTimeout(r, 100));
  // The bridge's tap: the deps' fake tap map — grab it via a fresh makeDeps state? Simplest: notify through ptyOutputTail replay instead.
  // (The bridge taps output via deps.tapOutput; makeDeps wires it into state.taps — reach in through a new bridge-level API: emitPtyOutput.)
  bridge.emitPtyOutput('p1', 'CLIENT-SEES-THIS');
  child.stdin.write('TYPED-IN-KITTY');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(
    out.includes('CLIENT-SEES-THIS'),
    `client mirrors pty output (out=${JSON.stringify(out)})`,
  );
  assert.ok(
    tape.events.some((e) => e.kind === 'write' && e.data === 'TYPED-IN-KITTY'),
    'client keystrokes reach the pty',
  );

  const exited = new Promise((res) => child.on('exit', (c) => res(c)));
  bridge.reattach('p1'); // sends bye
  const code = await Promise.race([
    exited,
    new Promise((r) => setTimeout(() => r('no-exit'), 3000)),
  ]);
  assert.equal(code, 0, `client exits cleanly on bye (err=${JSON.stringify(err)})`);
  void ctlLine;
});
