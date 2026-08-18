/**
 * Automatic branch retirement (card agent-archive-tag-the-5-delete-2026-08-18).
 *
 * Renderer batches land via CHERRY-PICK: the commits that reach main carry the
 * same content under NEW shas, so the source branch tips are never ancestors of
 * main and every ref-level check calls them unmerged — forever. The unmerged
 * list decayed into noise until a manual content-verification sweep (card
 * agent-clean-up-stale-origin-br-2026-08-18) deleted five branches that had
 * all landed. This module is the durable version of that sweep: at every app
 * start (the graphRefresh precedent — the app restarts seconds after every
 * restart-window batch lands, and this also covers worker self-pushes and god
 * manual merges without lengthening the watcher's merge window by a second),
 * each origin branch that REPORTS unmerged refs is checked against origin/main
 * and retired — archive-tag first, remote-delete second — ONLY on a proof.
 *
 * PROOFS (the only things that may delete; both are exact, both come from the
 * manual method this card's spec):
 *   P1 tree-equality — the branch tip's tree is byte-identical to the tree of
 *      some commit main gained since the merge-base (catches a cherry-pick
 *      landing even after main advanced past it).
 *   P2 reverse-apply — the branch's whole claim (diff merge-base..tip, binary
 *      included) reverse-applies cleanly onto origin/main's CURRENT tree,
 *      checked against a throwaway temp index (GIT_INDEX_FILE) so neither the
 *      working tree nor the real index is ever touched.
 *
 * UNSURE = LEAVE AND SAY. `git cherry`/patch-id lied in BOTH directions during
 * the manual sweep (missed landed content after rebase drift; and brooklyn99
 * reported unique commits while its theme partially sat in main), so no
 * heuristic threshold may delete. A branch that fails both proofs is listed in
 * `unproven` with the reason and never touched. A branch whose tip is checked
 * out in ANY live worktree is never touched even when provably landed — two
 * branches were worktree-held at the time of this card. A failed fetch skips
 * the whole run (stale refs can only err toward "leave", but why decide on
 * stale data). A failed worktree listing skips the run too: we cannot verify
 * holders, so we do not delete anything.
 *
 * Delete ordering is archive-FIRST: the tag is created and pushed, and only a
 * successful tag push unlocks the remote delete — no delete ever happens
 * without its recovery ref already on the remote.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeRev, listWorktrees, runGit } from './git';

/** What a branch may be retired on. Both are exact content proofs — no
 *  heuristic, no coverage percentage, nothing that could delete on a "probably". */
export type RetireProof = 'tree-equality' | 'reverse-apply';

export interface RetiredBranch {
  branch: string; // short name, no origin/ prefix
  tip: string;
  proof: RetireProof;
  tag: string; // archive/<branch>
}

export interface BranchRetireResult {
  ran: boolean;
  reason?: string; // present when ran === false
  retired: RetiredBranch[];
  /** Proven-or-not, a live worktree holds the tip — never touched. */
  heldWorktree: string[];
  /** Failed both proofs (or a guard refused): left alone, reason stated. */
  unproven: { branch: string; reason: string }[];
  /** Proven landed but the archive-tag/delete could not complete. */
  failed: { branch: string; reason: string }[];
  /** Tips already ancestors of origin/main — they never polluted the unmerged
   *  signal; wholesale-deleting release/* history is an operator call, not ours. */
  mergedTips: number;
}

type GitRunner = (
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;

const defaultGit: GitRunner = (cwd, args, opts) =>
  runGit(cwd, args, opts?.timeoutMs ?? 8000, opts?.env);

/** Default push: real `git push` (longer timeout — network). */
const defaultPush: GitRunner = (cwd, args) => runGit(cwd, args, 60_000);

/** Archive tag name for a branch: `archive/<branch>` — mirrors the branch
 *  namespace so `git tag -l 'archive/*'` reads as "the branches we retired". */
export function archiveTagFor(branch: string): string {
  return `archive/${branch}`;
}

/** One branch's verdict, computed but not acted on. Extracted so the act step
 *  stays tiny; not exported (tests exercise it through retireLandedBranches). */
interface Verdict {
  branch: string;
  tip: string;
  action: 'retire' | 'leave';
  proof?: RetireProof;
  reason?: string; // for leave: why (SAY it)
}

/** Prove `tip`'s content is in `origin/main` since the merge-base `mb`.
 *  Returns the proof that held, or null. Exact only — see module header. */
async function proveLanded(
  git: GitRunner,
  cwd: string,
  branchTip: string,
  mb: string,
  scratch: string,
): Promise<RetireProof | null> {
  // P1: tip tree among the trees main gained since the merge-base.
  const tipTree = await git(cwd, ['rev-parse', `${branchTip}^{tree}`]);
  const mainTrees = await git(cwd, ['log', '--pretty=format:%T', `origin/main`, `^${mb}`]);
  if (tipTree.ok && mainTrees.ok && mainTrees.stdout.split('\n').includes(tipTree.stdout.trim())) {
    return 'tree-equality';
  }
  // P2: the whole claim reverse-applies onto origin/main's current tree.
  const claim = await git(cwd, ['diff', '--binary', mb, branchTip]);
  if (!claim.ok) return null;
  const patchPath = join(scratch, 'claim.patch');
  await writeFile(patchPath, claim.stdout, 'utf8');
  const idx = join(scratch, 'index');
  const readTree = await git(cwd, ['read-tree', 'origin/main'], { env: { GIT_INDEX_FILE: idx } });
  if (!readTree.ok) return null;
  const apply = await git(cwd, ['apply', '--cached', '--check', '-R', patchPath], {
    env: { GIT_INDEX_FILE: idx },
  });
  return apply.ok ? 'reverse-apply' : null;
}

/**
 * Check every origin branch that reports unmerged refs against origin/main and
 * retire the PROVEN-landed ones (archive-tag push, then remote delete).
 * Fire-and-forget safe: never throws — every failure is a returned reason
 * (graphRefresh contract).
 */
export async function retireLandedBranches(
  repoRoot: string,
  deps: {
    git?: GitRunner;
    push?: GitRunner;
    today?: string; // ISO date for tag messages (injectable for tests)
  } = {},
): Promise<BranchRetireResult> {
  const git = deps.git ?? defaultGit;
  const push = deps.push ?? defaultPush;
  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  const out: BranchRetireResult = {
    ran: false,
    retired: [],
    heldWorktree: [],
    unproven: [],
    failed: [],
    mergedTips: 0,
  };

  // Fresh remote state, or no run at all.
  const fetch = await git(repoRoot, ['fetch', 'origin', '--prune'], { timeoutMs: 60_000 });
  if (!fetch.ok) {
    out.reason = `fetch failed (${fetch.error}) — deciding on stale refs refused`;
    return out;
  }
  const mainSha = await git(repoRoot, ['rev-parse', 'refs/remotes/origin/main']);
  if (!mainSha.ok) {
    out.reason = 'no refs/remotes/origin/main — not an origin-backed repo';
    return out;
  }

  // Worktree guard FIRST: a failed listing means we cannot verify holders →
  // delete nothing this run (fail-safe, same shape as worktreeHasUnintegratedWork).
  const wts = await listWorktrees(repoRoot);
  if (!Array.isArray(wts)) {
    out.reason = `worktree listing failed (${wts.error}) — cannot verify holders, deleting nothing`;
    return out;
  }
  const heldHeads = new Set(wts.map((w) => w.head).filter(Boolean));

  const refs = await git(
    repoRoot,
    ['for-each-ref', 'refs/remotes/origin', '--format=%(refname:short)%09%(objectname)'],
    { timeoutMs: 15_000 },
  );
  if (!refs.ok) {
    out.reason = `branch listing failed (${refs.error})`;
    return out;
  }

  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'branch-retire-'));
    for (const line of refs.stdout.split('\n')) {
      const [ref, tip] = line.split('\t');
      if (!ref || !tip || ref === 'origin/HEAD' || ref === 'origin/main') continue;
      const branch = ref.slice('origin/'.length);
      if (!isSafeRev(branch)) {
        out.unproven.push({ branch, reason: 'unsafe ref name — left for a human' });
        continue;
      }
      if (heldHeads.has(tip)) {
        out.heldWorktree.push(branch);
        continue;
      }
      const count = await git(repoRoot, ['rev-list', '--count', `origin/main..origin/${branch}`]);
      if (!count.ok) {
        out.unproven.push({ branch, reason: `rev-list failed (${count.error})` });
        continue;
      }
      if ((parseInt(count.stdout.trim(), 10) || 0) === 0) {
        out.mergedTips++;
        continue; // ancestor of main — never polluted the unmerged signal
      }
      const mb = await git(repoRoot, ['merge-base', 'origin/main', `origin/${branch}`]);
      if (!mb.ok) {
        out.unproven.push({ branch, reason: 'no merge-base with origin/main' });
        continue;
      }
      const claimCheck = await git(repoRoot, ['diff', '--stat', mb.stdout.trim(), tip]);
      if (claimCheck.ok && claimCheck.stdout.trim() === '') {
        out.unproven.push({ branch, reason: 'branch holds no changes (empty claim)' });
        continue;
      }
      const proof = await proveLanded(git, repoRoot, tip, mb.stdout.trim(), scratch);
      const verdict: Verdict =
        proof === null
          ? { branch, tip, action: 'leave', reason: 'content not proven in origin/main' }
          : { branch, tip, action: 'retire', proof };
      if (verdict.action === 'leave') {
        out.unproven.push({ branch, reason: verdict.reason ?? 'unproven' });
        continue;
      }

      // Act — archive FIRST; only a pushed tag unlocks the delete.
      const tag = archiveTagFor(branch);
      const existing = await git(repoRoot, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
      if (existing.ok) {
        if (existing.stdout.trim() !== tip) {
          out.unproven.push({
            branch,
            reason: `archive tag ${tag} exists at a different commit — left for a human`,
          });
          continue;
        }
        // Tag already at the right tip (previous partial run) → straight to delete.
      } else {
        const msg =
          `archive of origin/${branch} (tip ${tip.slice(0, 8)}) — content PROVEN landed in ` +
          `origin/main (${verdict.proof}, verified ${today}). Remote branch deleted ${today} by ` +
          `automatic branch retirement; do not resurrect. Card agent-archive-tag-the-5-delete-2026-08-18.`;
        const mk = await git(repoRoot, ['tag', '-a', tag, tip, '-m', msg], { timeoutMs: 15_000 });
        if (!mk.ok) {
          out.failed.push({ branch, reason: `tag creation failed (${mk.error}) — NOT deleted` });
          continue;
        }
      }
      const pushTag = await push(repoRoot, ['push', 'origin', `refs/tags/${tag}`]);
      if (!pushTag.ok) {
        out.failed.push({
          branch,
          reason: `archive tag push failed (${pushTag.error}) — delete refused`,
        });
        continue;
      }
      const del = await push(repoRoot, ['push', 'origin', '--delete', branch]);
      if (!del.ok) {
        out.failed.push({ branch, reason: `remote delete failed (${del.error}) — tag stays` });
        continue;
      }
      out.retired.push({ branch, tip, proof: verdict.proof!, tag });
      console.log(
        `[branch-retire] retired origin/${branch} (${verdict.proof}) — archived as ${tag}`,
      );
    }
    for (const u of out.unproven)
      console.log(`[branch-retire] origin/${u.branch} left alone — ${u.reason}`);
    for (const f of out.failed)
      console.error(`[branch-retire] origin/${f.branch} NOT retired — ${f.reason}`);
    out.ran = true;
    return out;
  } catch (e) {
    // Never throw (fire-and-forget contract); report what we have.
    out.reason = `unexpected failure: ${e instanceof Error ? e.message : String(e)}`;
    return out;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
