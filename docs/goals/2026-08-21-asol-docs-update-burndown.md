# asol-docs update burn-down — run doc

**Status:** active · **Opened:** 2026-08-21 · **Expected scale:** ~5 conversations, one chunk each

This is a goals document, not a spec. Chapters go through the normal `/asol-docs update` transaction (updater → reviewer → marker interview → commit), never through ad-hoc editing.

## Why

The doc set entered the asol-docs machinery on 2026-08-21 (commit `216d602`). The `Last Updated` dates were seeded from each file's last edit. That baseline is optimistic by design. The first drift report shows the honest backlog: every architecture doc has commits it has never seen, and `spec.md` has a full summer of them. These docs are blocking reads — agents read them before they touch code. A stale claim in `hive.md` or `message-queue.md` therefore misleads every session that reads it. This run burns the staleness backlog down to current, chunk by chunk.

## Scope

In:

- Diff-scoped update transactions for the seven adopted architecture docs.
- Coverage-glob extensions the updaters discover.
- VERIFY / INTENT UNVERIFIED markers the updaters raise.
- The end-of-chunk marker interviews.

Out:

- New architecture docs for the 98 uncovered `src/` files (see Open questions).
- Content work beyond each diff's blast radius.
- The canon copies in `docs/claude/`.
- Everything under `archived_docs/`.

## Facts a new session must not re-derive

Staleness baseline from the drift report of 2026-08-21, run at adoption:

| Doc | Commits behind | Last Updated |
|---|---|---|
| `spec.md` | 413 | 2026-05-31 |
| `hive.md` | 164 | 2026-08-16 |
| `design.md` | 130 | 2026-08-04 |
| `message-queue.md` | 19 | 2026-08-06 |
| `memory-graph-spec.md` | 6 | 2026-06-04 |
| `telemetry.md` | 4 | 2026-08-15 |
| `knowledge-graph.md` | 1 | 2026-06-11 |

| Fact | Proven by |
|---|---|
| `docs/architecture/{hive,spec,design,memory-graph-spec,telemetry}.md` are symlinks to the canonical root files (`HIVE.md` etc.); either path edits the same file. `message-queue.md` and `knowledge-graph.md` are real files there | `ls -la docs/architecture/` at adoption (2026-08-21) |
| `memory-graph-spec.md` claims "No component code is written yet", but `src/renderer/src/components/memoryGraph/` (buildGraph, forceLayout, extractTopics) and `MemoryGraphPanel.tsx` exist. AGENTS.md repeats the stale claim ("describes an unbuilt feature") | Directory listing + grep, 2026-08-21 |
| `HIVE.md` is aspirational by convention: "`HIVE.md` is what we're building *toward*; code is truth for what's *built*." Updaters must not treat unbuilt design sections as stale; only built-then-changed mechanisms drift | AGENTS.md § Conventions |
| Update mechanics: per-doc brief = commits since `Last Updated` touching the coverage globs; one reviewer subagent per transaction; deletion only with the invalidating commit cited — suspicion becomes a VERIFY marker | asol-docs skill (`references/updater-brief.md`, `references/reviewer-brief.md`) |
| This repo is a hard fork of `chaitanyagiri/munder-difflin`; upstream is a pull-only source. Doc changes need no upstream compatibility thought | `git remote -v`; Stefan, 2026-08-21 |

Expected, not verified: most of `design.md`'s 130 commits apply its rules without changing them — its globs cover all renderer components, but the doc records rules and tokens.

## Decided

- Update runs in chunks, one conversation per chunk — Stefan, 2026-08-21 ("We will structure it in several chunks and do them in seperate conversations").
- The run plan lives in the repo docs, not in agent memory — Stefan, 2026-08-21 ("Shouldn't the plan be saved to the created docs?").
- Adoption layout (symlinks for root docs, `docs/architecture/` as machinery root) — settled at commit `216d602`.

## Open questions

- `spec.md`: update or `--rebuild`? Owner: Stefan. Unblocked by C5's updater assessment of surviving content.
- `memory-graph-spec.md`: update or `--rebuild`? Owner: Stefan. Unblocked by C1's updater recommendation.
- The 98 uncovered `src/` files: new docs, glob extensions, or driftignore entries? Owner: Stefan. Unblocked by finishing this run.

## Findings

(appended per chunk as transactions complete)

## Living rules

- Check a chapter off only when its docs are committed. Append a dated status line under Findings per chunk.
- Start every chunk conversation with `/asol-docs update <docs>`. The skill re-runs the drift report and re-derives each brief from headers and git — trust that over this doc's baseline numbers.
- If the run stalls mid-chunk, supersede this doc with a handover; do not rewrite history.
- A chunk kickoff brief carries: the chapter row with its `done =`, the Decided entries with attribution, the standing constraints (the `HIVE.md` aspirational convention, the deletion protocol), the pointers above, and the current drift-report numbers.
- A kickoff brief carries no task list, no code sketches, and no wording that lets a chunk skip its updater → reviewer → interview cycle.

## Chapters

Ordered smallest-first to shake down the update mechanics before the high-value, high-volume docs; `spec.md` is last because it may convert to a rebuild.

- [ ] **C1. telemetry.md + knowledge-graph.md + memory-graph-spec.md**
  - done = all three transactions reviewer-green, markers interviewed, committed; memory-graph-spec update-vs-rebuild answered.
- [ ] **C2. message-queue.md**
  - done = transaction reviewer-green, markers interviewed, committed.
- [ ] **C3. hive.md**
  - done = transaction reviewer-green, markers interviewed, committed.
- [ ] **C4. design.md**
  - done = transaction reviewer-green, markers interviewed, committed.
- [ ] **C5. spec.md**
  - done = update-vs-rebuild decided by Stefan; the chosen path reviewer-green and committed.
