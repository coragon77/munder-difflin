/**
 * Project-root graphify refresh (card agent-harness-graphify-graph-f-2026-08-18).
 *
 * Workers updated graphify graphs inside their worktrees, where the result is
 * private and disposable — meanwhile the MAIN checkout's graph (the one every
 * stranger reads) was the stalest copy of five. The durable home for the
 * refresh is HERE, a harness-owned main-process step at app start, not the
 * ad-hoc restart-merge watcher script (god rewrites that per batch — a hook
 * planted only there is erased on the next re-arm). The restart window exists
 * because the app is DOWN: the watcher merges only while the app is gone and
 * the app always starts right after, so an app-start refresh runs within
 * seconds of every watcher merge — and also covers every other path that
 * advances the main checkout (god manual merges, operator pulls) without
 * lengthening the watcher's merge+push window by a single second.
 *
 * Contract (card boundaries): the graph build runs AFTER the merge (app start
 * is strictly post-merge), never blocks anything (fire-and-forget at the call
 * site), and a graph failure never propagates — every failure is a logged
 * reason. Runtime on this repo: ~2.4s no-op / ~3.1s full rebuild (measured
 * 2026-08-18, AST-only, no API cost). Extracted electron-free so the .cjs
 * harness can pin it (vacationFlow precedent).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHead } from './git';

/** Is the graph at `built_atCommit` older than `head`? Missing graph commit
 *  counts as stale (rebuild); equal commits are fresh. */
export function isGraphStale(builtAtCommit: string | null | undefined, head: string): boolean {
  if (!builtAtCommit) return true;
  return builtAtCommit !== head;
}

/** graphify binary candidates in try-order. Desktop launches (no login shell)
 *  often miss ~/.local/bin, so the explicit user-install path comes first;
 *  the PATH lookup second covers brew/system installs. */
export function graphifyCandidates(home: string): string[] {
  return [join(home, '.local', 'bin', 'graphify'), 'graphify'];
}

/** Default `gitHead`: real rev-parse via git.ts. */
type GitHead = (cwd: string) => Promise<string | null>;

/** Default `runUpdate`: spawn `graphify update .` in `repoRoot`, trying each
 *  candidate binary until one exists. 120s cap so a hung build can't leave a
 *  zombie. Throws on total failure — refreshProjectGraph converts to a reason. */
async function spawnGraphifyUpdate(repoRoot: string, home: string): Promise<void> {
  let lastMissing = '';
  for (const bin of graphifyCandidates(home)) {
    const outcome = await new Promise<'ok' | 'missing' | 'failed'>((resolve) => {
      let proc: ChildProcess;
      try {
        proc = spawn(bin, ['update', '.'], { cwd: repoRoot, stdio: 'ignore' });
      } catch {
        resolve('missing');
        return;
      }
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* noop */
        }
        resolve('failed');
      }, 120_000);
      proc.on('error', (e) => {
        clearTimeout(timer);
        resolve(/ENOENT|not found/i.test(e.message) ? 'missing' : 'failed');
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? 'ok' : 'failed');
      });
    });
    if (outcome === 'ok') return;
    if (outcome === 'failed') throw new Error(`graphify update exited nonzero (${bin})`);
    lastMissing = bin;
  }
  throw new Error(`graphify not found (tried: ${lastMissing})`);
}

/** Refresh the project-root graphify graph when it lags HEAD. Best-effort by
 *  construction: every failure path returns `{ ran: false, reason }` — never
 *  throws, never blocks a caller that fire-and-forgets. */
export async function refreshProjectGraph(
  repoRoot: string,
  deps: {
    gitHead?: GitHead;
    runUpdate?: (repoRoot: string, home: string) => Promise<void>;
    home?: string;
  } = {},
): Promise<{ ran: boolean; reason: string }> {
  const head = await (deps.gitHead ?? getHead)(repoRoot);
  if (!head)
    return {
      ran: false,
      reason: 'no-head (not a repo or git unavailable) — skipping graph refresh',
    };
  let builtAt: string | null | undefined;
  try {
    const raw = await readFile(join(repoRoot, 'graphify-out', 'graph.json'), 'utf8');
    try {
      builtAt = JSON.parse(raw).built_at_commit;
    } catch {
      builtAt = null; // exists but unparseable → rebuild
    }
  } catch {
    // Absent graph: out of scope — this refreshes, it doesn't first-build
    // (first builds can be slow; the card targets staleness of an existing
    // graph).
    return {
      ran: false,
      reason: 'no-graph — nothing to refresh (first build stays a manual step)',
    };
  }
  if (!isGraphStale(builtAt, head)) return { ran: false, reason: 'fresh (graph tracks HEAD)' };
  const home = deps.home ?? process.env.HOME ?? '';
  try {
    await (deps.runUpdate ?? spawnGraphifyUpdate)(repoRoot, home);
    console.log(`[graph] refreshed project-root graphify graph to ${head.slice(0, 8)}`);
    return { ran: true, reason: 'updated' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[graph] graphify update failed:', msg);
    return { ran: false, reason: `update-failed: ${msg}` };
  }
}
