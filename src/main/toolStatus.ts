/**
 * Live tool detection for the Prerequisites settings page (card
 * agent-prerequisites-panel-live-2026-08-18).
 *
 * HARD RULE — detection must NEVER hang the UI or the main process: the app
 * already burned time on a spawnSync that blocked Electron's main process for
 * up to 120s. So PATH presence is a pure `existsSync` walk (no spawn at all),
 * and the only spawn — the optional `--version` probe — is async execFile
 * with a hard 3s timeout per tool, all running in parallel off the main loop.
 *
 * Detection mirrors what the harness actually does at SPAWN time: the user's
 * interactive-shell PATH (Electron on macOS boots without it) plus the same
 * fixed candidate dirs `resolveCommand` (shellEnv.ts) falls back to — so this
 * page says "found" exactly when a spawn would find the binary.
 */

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { toolCatalog, type ToolStatus } from '../shared/toolCatalog';
import { userShellPath } from './shellEnv';
import type { MemoryStatus } from './memory';

/** Injectable detection environment — pure function, unit-testable without
 *  touching the real filesystem or shell. */
export interface DetectEnv {
  /** The PATH string to walk (colon- or semicolon-separated). */
  pathEnv: string;
  /** Fixed fallback dirs probed AFTER the PATH (mirrors resolveCommand). */
  extraDirs: string[];
  exists: (p: string) => boolean;
  platform: string;
}

/** The same fixed candidate dirs resolveCommand() falls back to, so a "found"
 *  here means a spawn would find it too. Evaluated lazily (HOME/APPDATA). */
export function defaultExtraDirs(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? '';
    const localAppData = env.LOCALAPPDATA ?? '';
    const home = env.USERPROFILE ?? env.HOME ?? '';
    return [
      appData ? join(appData, 'npm') : '',
      localAppData ? join(localAppData, 'Programs', 'claude') : '',
      home ? join(home, '.claude', 'local') : '',
    ].filter(Boolean);
  }
  const home = env.HOME ?? '';
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    home ? join(home, '.local', 'bin') : '',
    home ? join(home, '.claude', 'local') : '',
    home ? join(home, '.volta', 'bin') : '',
  ].filter(Boolean);
}

/** Resolve `bin` to an absolute path, or null. Pure PATH + candidate walk —
 *  NO spawn, so it can never hang. A binary that exists somewhere OUTSIDE the
 *  PATH (and the candidate dirs) is reported null on purpose: the harness
 *  spawns via PATH, so "installed but unreachable" and "missing" are the same
 *  failure and this page should say so. */
export function detectToolPath(bin: string, env: DetectEnv): string | null {
  const sep = env.platform === 'win32' ? ';' : ':';
  const dirs = [...env.pathEnv.split(sep).filter(Boolean), ...env.extraDirs];
  // Windows resolves PATHEXT; posix runs the file as-is.
  const exts = env.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (env.exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Best-effort `--version` first line, capped. Async + hard timeout: a hung
 *  CLI costs at most 3s and never blocks the main loop. Never rejects. */
export function probeVersion(binPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        binPath,
        ['--version'],
        { timeout: 3000, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          if (err) return resolve(undefined);
          const line = ((stdout ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
          resolve(line ? line.slice(0, 60) : undefined);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

/** The full live status for the Prerequisites panel. `memoryStatus` is
 *  injected so this stays testable and the IPC handler owns the
 *  resetBinCache() call. Never throws: a probe failure degrades the ROW,
 *  never the page. */
export async function toolsStatus(memoryStatus: () => MemoryStatus | null): Promise<ToolStatus[]> {
  const win = process.platform === 'win32';
  const env: DetectEnv = {
    // userShellPath() is memoized for the process lifetime (shellEnv.ts) and
    // bounded by its own 3s shell timeout — one warm-up, never per call.
    pathEnv: userShellPath(),
    extraDirs: defaultExtraDirs(),
    exists: existsSync,
    platform: process.platform,
  };
  const mem = (() => {
    try {
      return memoryStatus();
    } catch {
      return null;
    }
  })();
  const rows: ToolStatus[] = toolCatalog().map((spec): ToolStatus => {
    const installCommand = win ? spec.install.win32 : spec.install.posix;
    if (spec.id === 'mempalace') {
      return {
        ...spec,
        installCommand,
        found: !!mem?.available,
        path: mem?.bin ?? null,
        detail: mem?.available
          ? mem.initialized
            ? 'palace initialised'
            : 'installed — palace not built yet'
          : undefined,
      };
    }
    if (!spec.bin) return { ...spec, installCommand, found: false, path: null };
    const path = detectToolPath(spec.bin, env);
    return { ...spec, installCommand, found: !!path, path };
  });
  // Versions in parallel, each capped at 3s — wall time stays ~3s no matter
  // how many tools are installed.
  await Promise.all(
    rows.map(async (r) => {
      if (r.found && r.path && r.bin && !r.detail) r.detail = await probeVersion(r.path);
    }),
  );
  return rows;
}
