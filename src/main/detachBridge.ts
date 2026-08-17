/**
 * Detach-to-kitty bridge (card harness-detach-to-kitty-20260817).
 *
 * The claude pty is owned by the harness MAIN process; the pane is only a
 * view. Detach opens a per-agent bidirectional unix-socket bridge onto the
 * EXISTING pty and launches a kitty window running a thin raw-mode client
 * (resources/md-detach-client.cjs) on that socket. The agent process never
 * notices: floor sprite, fleet.json, breaker, inbox all stay live. NOT the
 * vacation machinery — nothing is parked, no session handoff, no --resume.
 *
 * Protocol (two sockets per detach, in deps.socketDir):
 *   `<id>.data.sock` — raw bytes both ways: replay + live pty output →
 *     client, client keystrokes → pty. One client at a time (later
 *     connections are destroyed — one view owns the size).
 *   `<id>.ctl.sock`  — JSON lines from the client: {"t":"hello"|"resize",
 *     cols, rows} set the pty size (kitty owns the winsize while detached);
 *     {"t":"bye"} from the BRIDGE tells the client to exit (its window
 *     closes with it).
 *
 * Wrinkles solved here (spec'd in the card):
 *   • winsize ownership — while detached, main refuses the renderer's
 *     pty:write/pty:resize (see index.ts gating) and the kitty client's
 *     hello/resize frames drive the pty. On reattach the pane refits and
 *     owns it again.
 *   • scrollback replay — the pty's recent output tail (PtyManager ring) is
 *     written to the data socket BEFORE live bytes; full-screen TUIs then
 *     repaint at the kitty size via the hello resize anyway.
 *   • kitty spawn — a running remote-control socket wins (window in the
 *     live satellite), else a fresh kitty, else the detach is refused
 *     (kittyLaunchPlan; index.ts feeds it real facts).
 *
 * Electron-free on purpose (the vacationFlow precedent): every side effect
 * is an injected dep, so the whole lifecycle is pinned by real-socket tests
 * without booting the app.
 */
import * as net from 'node:net';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** How the kitty window gets opened for a detach. */
export type KittyLaunchPlan =
  | {
      ok: true;
      mode: 'remote' | 'fresh';
      file: string;
      args: string[];
      env: Record<string, string>;
    }
  | { ok: false; mode: 'none'; error: string };

/**
 * The kitty ladder — PURE, pinned by tests.
 *
 * Remote (`kitty @ --to unix:<sock> launch --type=window …`) opens a window
 * in the ALREADY RUNNING satellite kitty: no new instance, and the window
 * behaves like a native kitty tab. Remote control cannot pass a child env
 * object, so ELECTRON_RUN_AS_NODE rides argv as `--env KEY=V`. Fresh mode
 * spawns a standalone kitty with the env object. No binary → refuse: a
 * detach without a viewer is just a bricked pane.
 */
export function kittyLaunchPlan(o: {
  kittySocketExists: boolean;
  kittySocket: string;
  kittyBin: string | null;
  execPath: string;
  clientScript: string;
  dataSock: string;
  ctlSock: string;
  title: string;
}): KittyLaunchPlan {
  const clientArgv = [o.execPath, o.clientScript, o.dataSock, o.ctlSock];
  if (!o.kittyBin) return { ok: false, mode: 'none', error: 'kitty is not installed' };
  if (o.kittySocketExists) {
    return {
      ok: true,
      mode: 'remote',
      file: o.kittyBin,
      args: [
        '@',
        '--to',
        `unix:${o.kittySocket}`,
        'launch',
        '--type=window',
        '--title',
        o.title,
        // Remote control has no env-object channel; ride argv. Double-quoted
        // by kitty itself — an `=` value needs no further escaping.
        '--env',
        'ELECTRON_RUN_AS_NODE=1',
        ...clientArgv,
      ],
      env: {},
    };
  }
  return {
    ok: true,
    mode: 'fresh',
    file: o.kittyBin,
    args: ['--title', o.title, ...clientArgv],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/** Everything the bridge touches outside its own decision-making. Each dep
 *  maps 1:1 onto a live singleton in index.ts — the wiring there is pure
 *  adapter, same as the vacationFlow precedent. */
export interface DetachDeps {
  /** Directory for the per-detach sockets (created if missing). */
  socketDir: string;
  /** How long to wait for the kitty client to connect before giving up
   *  (default 10s). */
  connectTimeoutMs?: number;
  ptyExists(id: string): boolean;
  ptyWrite(id: string, data: string): void;
  ptyResize(id: string, cols: number, rows: number): void;
  /** The pty's recent output (the replay source — PtyManager's ring). */
  ptyOutputTail(id: string): string;
  /** Install/remove main's output tap for this pty (PtyManager hook). */
  tapOutput(id: string, fn: ((data: string) => void) | null): void;
  /** Open the kitty window running the client. Returns not-ok to refuse the
   *  detach (kitty missing, headless box). */
  launchKitty(o: { dataSock: string; ctlSock: string; title: string }): {
    ok: boolean;
    error?: string;
  };
  /** Tell the renderer the pane's detach state changed (main sends
   *  pty:detached / pty:reattached IPC events through this). */
  notify(event: { id: string; detached: boolean; error?: string }): void;
  log(message: string): void;
}

interface DetachState {
  dataServer: net.Server;
  ctlServer: net.Server;
  dataSock: string;
  ctlSock: string;
  /** The one live data connection (the kitty client's terminal pipe). */
  client: net.Socket | null;
  /** The one live ctl connection (JSON lines). */
  ctl: net.Socket | null;
  /** Kill switch for the connect timeout. */
  timer: ReturnType<typeof setTimeout> | null;
}

function listen(sockPath: string, onConnection: (s: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    // A stale socket file from a crashed run would fail the bind — unlink first.
    try {
      if (existsSync(sockPath)) unlinkSync(sockPath);
    } catch {
      /* best-effort */
    }
    const server = net.createServer(onConnection);
    server.on('error', reject);
    server.listen(sockPath, () => resolve(server));
  });
}

function destroyServer(server: net.Server, sockPath: string): void {
  try {
    server.close();
  } catch {
    /* already closed */
  }
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch {
    /* best-effort */
  }
}

export class DetachBridge {
  private readonly detached = new Map<string, DetachState>();

  constructor(private readonly deps: DetachDeps) {}

  isDetached(id: string): boolean {
    return this.detached.has(id);
  }

  /** Open the bridge + kitty window for a live pty. The pane greys out
   *  (renderer-side, driven by the notify event) and main refuses its
   *  pty:write/pty:resize until reattach. */
  async detach(id: string, title: string): Promise<{ ok: boolean; error?: string }> {
    if (this.detached.has(id)) return { ok: false, error: `"${id}" is already detached` };
    if (!this.deps.ptyExists(id)) return { ok: false, error: `no pty: ${id}` };
    try {
      mkdirSync(this.deps.socketDir, { recursive: true });
    } catch {
      /* exists */
    }
    const dataSock = join(this.deps.socketDir, `${id}.data.sock`);
    const ctlSock = join(this.deps.socketDir, `${id}.ctl.sock`);
    let state: DetachState;
    try {
      const dataServer = await listen(dataSock, (s) => this.onClientDataConnection(id, s));
      const ctlServer = await listen(ctlSock, (s) => this.onCtlConnection(id, s));
      state = { dataServer, ctlServer, dataSock, ctlSock, client: null, ctl: null, timer: null };
    } catch (e) {
      return { ok: false, error: `could not open bridge sockets: ${String(e)}` };
    }
    this.detached.set(id, state);

    const launch = this.deps.launchKitty({ dataSock, ctlSock, title });
    if (!launch.ok) {
      this.cleanup(id);
      return { ok: false, error: launch.error ?? 'kitty unavailable' };
    }

    // Belt: if the client never connects (kitty failed silently, wrong
    // DISPLAY), give up and hand the pane back rather than leaving it grey
    // forever.
    state.timer = setTimeout(() => {
      const s = this.detached.get(id);
      if (!s) return;
      if (!s.client) {
        this.deps.log(`[detach] client never connected for ${id} — auto-reattach`);
        this.cleanup(id);
        this.deps.notify({ id, detached: false, error: 'kitty window never opened' });
      }
    }, this.deps.connectTimeoutMs ?? 10_000);
    state.timer.unref?.();

    // From now on the pty's output is ALSO mirrored to the client. The pane
    // keeps its read-only mirror (spec: "read-only output mirror OK").
    this.deps.tapOutput(id, (data) => this.emitPtyOutput(id, data));
    this.deps.notify({ id, detached: true });
    this.deps.log(`[detach] ${id} detached to kitty (${title})`);
    return { ok: true };
  }

  /** Close the kitty window (bye frame), tear the bridge down, re-enable the
   *  pane. Safe to call for a live detach, a half-dead one, or none at all. */
  reattach(id: string): { ok: boolean; error?: string } {
    const state = this.detached.get(id);
    if (!state) return { ok: false, error: `"${id}" is not detached` };
    // Ask the client to exit first — its exit closes the kitty window. If the
    // client is already gone this write is a silent no-op on a dead socket.
    try {
      state.ctl?.write('{"t":"bye"}\n');
    } catch {
      /* client gone */
    }
    this.cleanup(id);
    this.deps.notify({ id, detached: false });
    this.deps.log(`[detach] ${id} reattached`);
    return { ok: true };
  }

  /** Main-side output tap target: pty bytes → the live kitty client. */
  emitPtyOutput(id: string, data: string): void {
    const state = this.detached.get(id);
    if (!state?.client) return;
    try {
      state.client.write(data);
    } catch {
      /* client died — its socket close will auto-reattach */
    }
  }

  /** Wholesale shutdown (app quit): no notify storm, no bye frames. */
  disposeAll(): void {
    for (const id of [...this.detached.keys()]) this.cleanup(id);
  }

  private onClientDataConnection(id: string, sock: net.Socket): void {
    const state = this.detached.get(id);
    if (!state) {
      sock.destroy();
      return;
    }
    // ONE view at a time — a second connection would fight for the winsize.
    if (state.client) {
      sock.destroy();
      return;
    }
    state.client = sock;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    // Scrollback replay first (spec wrinkle 2): the pty's recent tail, then
    // live bytes. The hello resize (ctl) repaints full-screen TUIs anyway.
    try {
      sock.write(this.deps.ptyOutputTail(id));
    } catch {
      /* client died immediately — close below handles it */
    }
    sock.setEncoding('utf8');
    // Keystrokes → pty, verbatim (raw-mode passthrough, wrinkle 3).
    sock.on('data', (data: string) => this.deps.ptyWrite(id, data));
    // The kitty window closed (manually or via bye exit) → auto-reattach.
    const gone = (): void => {
      const s = this.detached.get(id);
      if (!s) return;
      if (s.client !== sock) return; // a destroyed intruder, not our client
      this.deps.log(`[detach] kitty client for ${id} went away — auto-reattach`);
      this.cleanup(id);
      this.deps.notify({ id, detached: false });
    };
    sock.on('close', gone);
    sock.on('error', gone);
  }

  private onCtlConnection(id: string, sock: net.Socket): void {
    const state = this.detached.get(id);
    if (!state) {
      sock.destroy();
      return;
    }
    if (state.ctl) {
      sock.destroy();
      return;
    }
    state.ctl = sock;
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.onCtlLine(id, line);
      }
    });
    // The ctl socket dying means the client is going too — the data socket's
    // close handler is the authoritative cleanup, so just drop the reference.
    sock.on('close', () => {
      const s = this.detached.get(id);
      if (s?.ctl === sock) s.ctl = null;
    });
  }

  /** hello/resize frames: while detached, the kitty window owns the pty's
   *  size (spec wrinkle 1). */
  private onCtlLine(id: string, line: string): void {
    if (!line.trim()) return;
    let msg: { t?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(line) as { t?: string; cols?: number; rows?: number };
    } catch {
      return; // garbage line — ignore, never kill the bridge over it
    }
    if ((msg.t === 'hello' || msg.t === 'resize') && msg.cols && msg.rows) {
      this.deps.ptyResize(id, msg.cols, msg.rows);
    }
  }

  private cleanup(id: string): void {
    const state = this.detached.get(id);
    if (!state) return;
    this.detached.delete(id);
    if (state.timer) clearTimeout(state.timer);
    this.deps.tapOutput(id, null);
    try {
      state.client?.destroy();
    } catch {
      /* gone */
    }
    try {
      state.ctl?.destroy();
    } catch {
      /* gone */
    }
    destroyServer(state.dataServer, state.dataSock);
    destroyServer(state.ctlServer, state.ctlSock);
  }
}

/** Best-effort sweep of leftover sockets (app quit while detached). */
export function sweepDetachSockets(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
