/**
 * KittySatellite — give harness agents the same Kitty handoff environment they
 * have when the user works in Kitty directly.
 *
 * The user's handoff skills (`pi-handoff` / `claude-handoff` in their skill
 * repos) branch on `$KITTY_LISTEN_ON`: set → `kitty @ launch --match
 * window_id:$KITTY_WINDOW_ID` opens a split BESIDE the current session; unset →
 * print a paste-line fallback. Harness agents live in app PTYs, not in Kitty —
 * so without help the skills always degrade to the fallback.
 *
 * Fix: at boot, spawn a small "satellite" Kitty window with a known listen
 * socket, read its first window id, and export KITTY_LISTEN_ON + that
 * KITTY_WINDOW_ID into process.env. Every agent PTY (spawned with a merged
 * process.env) then sees exactly what a pane inside that satellite window would
 * see — and a handoff split lands in the satellite, where the user watches it.
 * The skills themselves stay harness-unaware and unchanged.
 *
 * Failure is always graceful: kitty absent, headless box, display gone → no
 * env vars → skills take their existing fallback path. kitty exiting later
 * (user closed the satellite) leaves stale-but-harmless vars; a relaunch of the
 * app re-establishes everything.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const log = (...a: unknown[]) => console.log('[kitty-satellite]', ...a);

/** One-shot guard — the satellite starts at most once per app run. */
let started = false;

/** Path of the satellite's remote-control socket (deterministic per user). */
export function kittySocketPath(): string {
  return join(tmpdir(), `md-kitty-${process.getuid?.() ?? 'u'}.sock`);
}

/** Kitty binary path or null — exported for the openInKitty IPC (tab-in-satellite). */
export function kittyBinPath(): string | null {
  const candidates = [
    join(homedir(), '.local/bin/kitty'),
    '/usr/local/bin/kitty',
    '/usr/bin/kitty'
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const kittyBin = kittyBinPath;

/** `kitty @ ls` the socket, return the first window id (as a string — kitty
 *  ids exceed Number.MAX_SAFE_INTEGER, and the skills interpolate the value
 *  verbatim into `--match window_id:`). */
async function firstWindowId(socket: string, kitty: string): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await new Promise<{ code: number; out: string }>((resolve) => {
        const p = spawn(kitty, ['@', '--to', `unix:${socket}`, 'ls'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (d) => { out += d.toString(); });
        p.on('error', () => resolve({ code: 1, out: '' }));
        p.on('close', (code) => resolve({ code: code ?? 1, out }));
      });
      if (res.code === 0 && res.out.trim()) {
        const m = res.out.match(/"id":\s*(\d+)/);
        if (m) return m[1];
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Start the satellite and export the handoff env. No-op (and env-clean) when
 *  kitty is missing or the socket never comes up. LAZY: called from the first
 *  agent spawn, not app boot — the user sees no Kitty window until an agent
 *  actually exists that might hand off. Awaits the window id so even the first
 *  PTY's env carries both vars. */
export async function startKittySatellite(): Promise<void> {
  // Respect an explicit opt-out and headless sessions.
  if (process.env.MD_DISABLE_KITTY_SATELLITE === '1' || !process.env.DISPLAY) return;
  if (started) return;
  started = true;
  const kitty = kittyBin();
  if (!kitty) return;
  const socket = kittySocketPath();
  // A listening kitty from a previous app run still works — reuse it (kitty is
  // single-instance per socket), just re-read the window id.
  const child = spawn(kitty, [
    '--listen-on', `unix:${socket}`,
    // Socket-only remote control matches the user's own kitty.conf posture.
    // NOTE: --override takes 'key value' (config-file syntax), NOT 'key=value' —
    // the '=' form is an invalid line → kitty's "error parsing configuration"
    // dialog at startup (seen live, kitty 0.48). 
    '--override', 'allow_remote_control socket-only',
    '--override', 'enabled_layouts splits',
    '--title', 'MD satellite'
  ], {
    detached: true, stdio: 'ignore',
    // Inherit DISPLAY so the window opens on the user's desktop.
    env: { ...process.env }
  });
  child.unref();
  const winId = await firstWindowId(socket, kitty);
  if (!winId) {
    log('kitty started but no window id — leaving handoff env unset');
    return;
  }
  process.env.KITTY_LISTEN_ON = `unix:${socket}`;
  process.env.KITTY_WINDOW_ID = winId;
  log('handoff env exported:', process.env.KITTY_LISTEN_ON, 'window', winId);
}
