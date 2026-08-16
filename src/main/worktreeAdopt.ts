/**
 * Worktree re-entry adoption (card vacation-worktree-leak-20260816).
 * Extracted from index.ts so the rule is testable — the Electron main entry
 * cannot be loaded from the .cjs test harness (vacationBusy precedent).
 */

import { dirname, resolve } from 'node:path';

/** Should spawnAgentCore ADOPT `cwd` back into worktreePaths/worktreeOrigins
 *  as a re-entered harness worktree?
 *
 *  Park deliberately drops those map entries (9d4c5ee: teardownPty's
 *  force-remove must not delete a parked agent's worktree), but the recall —
 *  like the restart restore and un-archive flows — re-enters the worktree by
 *  spawning `isolate:false` with cwd = the worktree path, and the fresh-spawn
 *  branch (`isolate:true`) is the only place that ever registers. Without
 *  adoption the worktree is untracked forever: no later archive/kill/exit can
 *  remove it, so the directory + its `git worktree` registration leak on disk.
 *
 *  Adopt exactly the shape the fresh branch creates: a DIRECT child of the
 *  harness worktrees root. `isolate:true` never adopts (the fresh branch owns
 *  registration); anything outside the root, nested deeper, or the root itself
 *  is not ours to track. The caller still gates on isRepo(cwd). */
export function shouldAdoptWorktree(
  isolate: boolean | undefined,
  cwd: string,
  wtRoot: string,
): boolean {
  if (isolate === true) return false;
  if (!cwd) return false;
  return dirname(resolve(cwd)) === resolve(wtRoot);
}
