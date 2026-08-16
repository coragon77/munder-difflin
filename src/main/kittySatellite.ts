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
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HIRE_PERMISSION_MODE,
  permissionModeArgs,
  type HirePermissionMode,
} from '../shared/agentProvider';

const log = (...a: unknown[]) => console.log('[kitty-satellite]', ...a);

/** Path of the satellite's remote-control socket (deterministic per user). */
export function kittySocketPath(): string {
  return join(tmpdir(), `md-kitty-${process.getuid?.() ?? 'u'}.sock`);
}

/** Kitty binary path or null — exported for the openInKitty IPC (tab-in-satellite). */
export function kittyBinPath(): string | null {
  const candidates = [
    join(homedir(), '.local/bin/kitty'),
    '/usr/local/bin/kitty',
    '/usr/bin/kitty',
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
        const p = spawn(kitty, ['@', '--to', `unix:${socket}`, 'ls'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let out = '';
        p.stdout.on('data', (d) => {
          out += d.toString();
        });
        p.on('error', () => resolve({ code: 1, out: '' }));
        p.on('close', (code) => resolve({ code: code ?? 1, out }));
      });
      if (res.code === 0 && res.out.trim()) {
        const m = res.out.match(/"id":\s*(\d+)/);
        if (m) return m[1];
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** The satellite's FIRST window is the god's co-terminal: the configured
 *  default engine (e.g. `claude`) in the hive cwd. Same memory/inbox/roster
 *  files as the in-app god session — a second process, not a shared transcript.
 *  Falls back to a plain shell when no engine/hive is configured. */
export function godCommand(): { file: string; args: string[]; cwd: string | null } {
  try {
    const cfgPath = join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'munder-difflin',
      'config.json',
    );
    if (!existsSync(cfgPath)) return { file: 'bash', args: [], cwd: null };
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      defaultCommand?: string;
      harnessHome?: string | null;
    };
    const cmd = (cfg.defaultCommand ?? '').trim() || 'bash';
    const parts = cmd.split(/\s+/);
    const hive = cfg.harnessHome ?? null;
    // God co-terminal mirrors the in-app god's resolution (card
    // god-boot-ignores-permission-mode-20260816): his REGISTRY record's stored
    // permissionMode wins when set, else the Claude-Auto default. He is an
    // unattended orchestrator — permission prompts in the satellite window
    // answer nobody. A typed --permission-mode wins and is never doubled.
    let godMode: HirePermissionMode | undefined;
    if (hive) {
      try {
        const reg = JSON.parse(readFileSync(join(hive, 'registry.json'), 'utf8')) as {
          godId?: string | null;
          agents?: Record<string, { permissionMode?: HirePermissionMode }>;
        };
        godMode = reg.agents?.[reg.godId ?? 'god']?.permissionMode;
      } catch {
        /* no/bad registry → default */
      }
    }
    if (parts[0] === 'claude' && !parts.includes('--permission-mode')) {
      parts.push(
        ...permissionModeArgs(parts.join(' '), 'claude', godMode ?? DEFAULT_HIRE_PERMISSION_MODE),
      );
    }
    // Claude at the hive root finds the god's memory/board/inbox via its cwd.
    const godCwd = hive ? join(hive, 'agents', 'god') : null;
    return {
      file: parts[0],
      args: parts.slice(1),
      cwd: godCwd && existsSync(godCwd) ? godCwd : hive,
    };
  } catch {
    return { file: 'bash', args: [], cwd: null };
  }
}

/** Start the satellite and export the handoff env. No-op (and env-clean) when
 *  kitty is missing or the socket never comes up. LAZY: called from the first
 *  agent spawn, not app boot — the user sees no Kitty window until an agent
 *  actually exists that might hand off. Awaits the window id so even the first
 *  PTY's env carries both vars. */
export async function startKittySatellite(): Promise<void> {
  // Respect an explicit opt-out and headless sessions.
  if (process.env.MD_DISABLE_KITTY_SATELLITE === '1' || !process.env.DISPLAY) return;
  // One-shot per SATELLITE LIFETIME, not per app run: if the socket is gone
  // (user closed the satellite window mid-run), allow a restart. The window-id
  // poll below re-exports the env over the (possibly new) id.
  if (existsSync(kittySocketPath())) return; // already alive — nothing to do
  const kitty = kittyBin();
  if (!kitty) return;
  const socket = kittySocketPath();
  // A listening kitty from a previous app run still works — reuse it (kitty is
  // single-instance per socket), just re-read the window id.
  const child = spawn(
    kitty,
    [
      '--listen-on',
      `unix:${socket}`,
      // Socket-only remote control matches the user's own kitty.conf posture.
      // NOTE: --override takes 'key value' (config-file syntax), NOT 'key=value' —
      // the '=' form is an invalid line → kitty's "error parsing configuration"
      // dialog at startup (seen live, kitty 0.48).
      '--override',
      'allow_remote_control socket-only',
      '--override',
      'enabled_layouts splits',
      '--title',
      'MD satellite',
      // The initial window is a THROWAWAY shell whose tab title we set via an OSC
      // escape (bash rcfiles would otherwise rewrite it to user@host:cwd — verified
      // live). `--noprofile --norc` keeps our title; close-tab later matches it.
      '--',
      'bash',
      '--noprofile',
      '--norc',
      '-c',
      'printf "\\e]2;md-shell-placeholder\\a"; exec bash --noprofile --norc',
    ],
    {
      detached: true,
      stdio: 'ignore',
      // Inherit DISPLAY so the window opens on the user's desktop.
      env: { ...process.env },
    },
  );
  child.unref();
  const winId = await firstWindowId(socket, kitty);
  if (!winId) {
    log('kitty started but no window id — leaving handoff env unset');
    return;
  }
  // The initial window is a plain shell (kitty launched bare). Replace it with
  // the god co-terminal: launch his engine in a new tab of the SAME window, then
  // close the shell tab's window only after Michael's tab exists. NOTE: closing
  // by window id would close Michael too — the shell is tab 1 of the same
  // os-window, so close by TAB, not window (close-tab --match state:older).
  const god = godCommand();
  try {
    const tabCwd = god.cwd ?? process.cwd();
    await new Promise<void>((resolve) => {
      const p = spawn(
        kitty,
        [
          '@',
          '--to',
          `unix:${socket}`,
          'launch',
          '--type=tab',
          `--match=window_id:${winId}`,
          `--cwd=${tabCwd}`,
          '--title',
          'Michael',
          '--hold',
          god.file,
          ...god.args,
        ],
        { stdio: 'ignore' },
      );
      p.on('error', () => resolve());
      p.on('close', () => resolve());
    });
    // Close the initial throwaway shell tab, matched by its distinctive title
    // (set via OSC escape at launch — see above; verified live against kitty
    // 0.48: user rcfiles rewrite tab titles, --noprofile --norc keeps ours).
    await new Promise<void>((resolve) => {
      const p = spawn(
        kitty,
        [
          '@',
          '--to',
          `unix:${socket}`,
          'close-tab',
          '--match',
          `window_id:${winId}`,
          '--match',
          'title:md-shell-placeholder',
        ],
        { stdio: 'ignore' },
      );
      p.on('error', () => resolve());
      p.on('close', () => resolve());
    });
  } catch {
    /* best-effort: satellite with a shell is still fine */
  }
  process.env.KITTY_LISTEN_ON = `unix:${socket}`;
  process.env.KITTY_WINDOW_ID = winId;
  log(
    'handoff env exported:',
    process.env.KITTY_LISTEN_ON,
    'window',
    winId,
    '(Michael tab:',
    god.file,
    ')',
  );
}
