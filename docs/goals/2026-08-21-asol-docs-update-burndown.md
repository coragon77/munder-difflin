# asol-docs update burn-down — run doc

**Status:** closed 2026-08-22 — all five chapters done · **Opened:** 2026-08-21 · **Expected scale:** ~5 conversations, one chunk each

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
| `memory-graph-spec.md` claims "No component code is written yet", but `src/renderer/src/components/memoryGraph/` (buildGraph, forceLayout, extractTopics) and `MemoryGraphPanel.tsx` exist. AGENTS.md repeats the stale claim ("describes an unbuilt feature") — doc side fixed in C1 (2026-08-21, citing `7ea347b8`); the AGENTS.md echo still stands, outside the doc set's machinery | Directory listing + grep, 2026-08-21 |
| `HIVE.md` is aspirational by convention: "`HIVE.md` is what we're building *toward*; code is truth for what's *built*." Updaters must not treat unbuilt design sections as stale; only built-then-changed mechanisms drift | AGENTS.md § Conventions |
| Update mechanics: per-doc brief = commits since `Last Updated` touching the coverage globs; one reviewer subagent per transaction; deletion only with the invalidating commit cited — suspicion becomes a VERIFY marker | asol-docs skill (`references/updater-brief.md`, `references/reviewer-brief.md`) |
| This repo is a hard fork of `chaitanyagiri/munder-difflin`; upstream is a pull-only source. Doc changes need no upstream compatibility thought | `git remote -v`; Stefan, 2026-08-21 |

Expected, not verified: most of `design.md`'s 130 commits apply its rules without changing them — its globs cover all renderer components, but the doc records rules and tokens.

## Decided

- Update runs in chunks, one conversation per chunk — Stefan, 2026-08-21 ("We will structure it in several chunks and do them in seperate conversations").
- The run plan lives in the repo docs, not in agent memory — Stefan, 2026-08-21 ("Shouldn't the plan be saved to the created docs?").
- Adoption layout (symlinks for root docs, `docs/architecture/` as machinery root) — settled at commit `216d602`.
- `memory-graph-spec.md`: revision, not rebuild — Stefan, 2026-08-21, on the C1 updater's recommendation (~90% of the spec matched shipped reality; rebuild would regenerate the irreproducible decision tables).
- `spec.md`: rebuild, not revision — Stefan, 2026-08-21 ("wait till C4 is done then rebuild"), on the C5 assessment (~20% of the 317-line inception proposal survived as true; zero accreted scar tissue to lose; revision would exceed surviving content ~4:1). Map-gate calls (Stefan, 2026-08-21, all four as recommended): identity kept (`SPEC.md` + symlink), one doc, globs kept + `hive.md` extension with `useHive.ts`, compact inception-history section.

## Open questions

- The 98 uncovered `src/` files: new docs, glob extensions, or driftignore entries? Owner: Stefan. Unblocked by finishing this run.
- New `TelemetryCollector` architecture doc (OTLP seam, hook plane, breaker/ledger boundary), then narrow `telemetry.md` Coverage to `analytics.ts`. Owner: Stefan (decided 2026-08-21, C1 interview); doc-writing is bootstrap-machinery work for a later session. The open INTENT marker in `telemetry.md` tracks it.

## Findings

(appended per chunk as transactions complete)

- **2026-08-22 — post-close: both open questions resolved.** The coverage-gap round ran the same day (`a962ff3` glob extensions + driftignore, `2369f1f` six new docs incl. `telemetry-collector.md`; map approved by Stefan, six writer/reviewer pairs, all green). Drift report: 0 coverage gaps. `telemetry.md` narrowed to `analytics.ts`; its INTENT marker resolved.
- **2026-08-22 — run closed.** The four C5 INTENT markers closed on Stefan's word, each answer written into `spec.md` with attribution (`035702f`, `da39015`, `3ac5f8a`): tmux-attach superseded by the kitty-pane approach (KittySatellite), §12 text a leftover of the initial discussion; `tmuxTarget` stays deliberately as a placeholder for possible future tmux support; `Agent.goal` unfinished by the original author and the concept judged wrong — TODO queued as an open question in `docs/goals/harness-vision.md` (V2); the 4000 ms idle-drift window "eyeballed until it looked right" — tuned constant, needs further work. The C5 `App.tsx` coverage deviation approved (Stefan, 2026-08-22: "keep App.tsx"). `spec.md` marker debt is zero. The two open questions above (89 coverage gaps; `TelemetryCollector` doc) move to their own future sessions.
- **2026-08-22 — C5 committed.** `spec.md`: rebuilt. The 317-line inception-day proposal (`Last Updated` = repo day zero `dc7f1ce`; its 413 briefed commits were the coverage globs' entire lifetime, +14,155/−512 net, files 11 → 15) replaced by a 757-line template-shaped architecture doc; old doc fed in as intent-carrying source. All five survival-contract items carried and reviewer-verified: two-planes rationale (quoted, with the honest `[byte stream]` substitution), Sims-metaphor product reasoning, the §12 decision list incl. the inverted tmux decision (spec said attach-don't-spawn; `dc7f1ce` already shipped node-pty; `tmuxTarget` vestigial at `store.ts:56`, three `''` writers, zero readers), the "/goal" origin story, and the MVP NOT-list as a fates table (agent bus → hive; no-remote → inverted via tunnelmole `webhook.ts`/`slack.ts`/`telegram.ts`; no-editor → inverted via monaco/codemirror; not-a-CLI-replacement → still true). Reviewer: pass-with-findings, no blockers — 1 must-fix (`isDetached` is the detach bridge's own method, `detachBridge.ts:177`, consulted by `pty:resize` via `index.ts:4075`; not a `PtyManager` method — "exactly three methods" corrected to two) + 6 minor (`teardownPty` step order per `index.ts:705`–742; `AGENTS.md:51`–`54` cite; function-not-module docstring `usePtyParser.ts:66`; `emit()` payload gains `source` per `hooks.ts:658`–666; `claudeCommands.ts:149` anchor; the mock-event-loop gotcha cited `App.tsx` outside Coverage) — all seven fixed. Coverage extended: `spec.md` + `src/renderer/src/App.tsx` (reviewer finding — the gotcha would rot invisibly); `hive.md` + `src/renderer/src/hooks/useHive.ts` (map-gate de-dup; hive.md's date not bumped — no content change, and bumping would hide its un-briefed commits). Routing row and doc-index line regenerated from the writer's triggers. Markers: 4 INTENT UNVERIFIED raised (same-day tmux-attach abandonment; vestigial `tmuxTarget`; `Agent.goal` authored/validated/persisted but no delivery path; the 4000 ms `usePtyParser` idle-drift window) — interview ran in deferral mode (Stefan offline; autonomous finish 2026-08-22), all four stay open with proposed dispositions in the session report. Run note: all five chapters are now checked; the remaining open questions (89 coverage gaps; `TelemetryCollector` doc) unblock.
- **2026-08-21 — C4 committed.** `design.md`: pass-with-findings → all nine findings fixed → green. Of the 130 briefed commits, 31 produced edits and 99 were confirmed no-edit-owed (11 merges, 5 lint/format-only, 6 reverts/deletions of features the doc never described, 6 terminal/scene mechanics outside the design system, 71 that applied the tokens without changing them — the tracker's "expected, not verified" guess held, proven per commit). The substance sits in three design rewrites: `51ec611` (Inter/JetBrains Mono replace Pixelify Sans/VT323, all 22 accent+status hexes recalibrated, dark terminal theme), `3c2b6d1` (three-layer border → single hairline, body/mono type ramps one step down, AgentCard 196×76 / god 216×86), `5510818` (dark mode shipped; `theme.ts` stamps `data-cth-theme`; §18.2 struck as decided). Also new: §12.4 floor-motion rules (`34958c5`/`2672efc`/`7693d83`/`b95d2fd`), §8.4 real preset catalog (`OFFICE_CAST` 25, three-rung identity ladder), §11 hex dump replaced by anchors to `PtyTerminalView.tsx:54`/`:82`. Reviewer findings, all fixed by the updater: one invented change ("no per-size mono line height" was a pre-existing doc error, not a code change), one over-broad claim (three of four button borders moved, `primary` stays `ink-900`), two misattributions, one misread (12.5 px is `.cth-md-preview code`, not the preview body), one unsourced marker clause (`c42b36b` dropped), one under-cited deletion (light terminal hexes — fixed with out-of-window citations, `1ee25e8`), one protocol-violating sentence deletion (§6.4 sibling-block alternative restored at 3 px). Markers: 5 VERIFY raised; interview: #4 answered by Stefan — archetypes are history, presets are per-theme (`ThemeConfig` `e8228e9` Phase 0; `custom` theme `d8d33dd` = operator's byte-copy clone of `office.tmj`, `preservesAgents: true`, LimeZu atlases at fresh firstgids), answer written into §8.4; #1 "Never bold", #2 4 px grid, #3 accent→sprite `primary` deferred — owner intent not formed, settle in the V2 vision discussion (`docs/goals/harness-vision.md`); #5 z-index 0–5 scale deferred to a later `z-index` sweep. Coverage extended (Stefan): `src/renderer/src/statusLabel.ts`, `src/shared/waitingLabel.ts`, `src/renderer/index.html`; `agentRole.ts`/`agentOrder.ts` skipped to the post-run coverage round. Owner-authorized out-of-radius fixes: §7.3's broken message-queue link (now `docs/architecture/message-queue.md`) and §3.4's `waiting` row disambiguated from the §7.3 `wait (N)` badge. Coverage gaps 91 → 89. Residuals: the doc is now ~1015 lines, past the ~900 split threshold — partition at a future run's partition time, seam = UI design system vs game layer (§8/§9/§13); §9 Stations and §15.1 main view are likely stale but every proving commit predates 2026-08-04 — needs a pre-window-scoped check or an owner spot-check; design.md will show same-day stale commits until its date next advances.
- **2026-08-21 — C3 committed.** `hive.md`: pass-with-findings → both findings fixed → green. 164 briefed commits against the 228-line aspirational doc produced 71 insertions / 11 deletions, every hunk hash-cited. Substance: §2 decision 1 refined (`hive-card restore` reads ledger history via read-only `git log/show`, main stays sole committer `f7f62cc`; `cost-ledger.jsonl` deliberately untracked `1603014`); §2 decision 2 built-differently (`tasks.json`/`registry.json` multi-writer under shared O_EXCL locks `5174788`/`32c5eaa`/`7cb3969`, non-primitive access refused by the `hiveGate.ts` PreToolUse gate `a7076bb`/`26d7de2`); §3 layout tree + new primitive-wave paragraph (full `bin/` CLI roster per-CLI-cited, `hive-dispatch` sole todo→doing path `de2b141`, dead-`HIVE_ROOT` guard `1c27440`); §4 envelope extensions (`cardId` `40d86ac`, `foldedIds`/`pointedIds` `a006908`/`40bd9cb`); §5 delivery refinements (staged mail `09ddde2`, contract mail-folding `4924149`, outbox-stall backstop `7fcb8bd`, peer-mail audit CC `a3cf1e6`); §6 god bullets + "tune the prompt, not the code" qualified — holds are now mechanism `2ecb500`/`de2b141`/`a7076bb`, judgment stays prompt. Reviewer findings, both fixed by the updater: `from`-stamping reframed as inception-era mechanism (`normalize`, `dc7f1ce`) whose rule text landed via `2476ac5`; scribe exception recited to builder `f415122` (prose-sweep `23bd03b` kept as secondary in §3). Aspirational sections untouched per AGENTS.md convention (§7 phases, §8 risks, MemPalace future note — the latter tensions with Phase 3's "(not MCP, by decision)", pre-window, left as-is). No markers raised, none were open — the interview was empty. Coverage extended (Stefan: "the six + sessionRequests"): `actionableCards.ts`, `actionableWatch.ts`, `cardSessions.ts`, `orientGate.ts`, `orientInject.ts`, `sessionRequests.ts`, `standup.ts`; `autoPark.ts` deliberately skipped — already claimed by `message-queue.md`, migrates only per the C2 unit-migration decision. Coverage gaps 98 → 91. Residual: hive.md shows 27 same-day stale commits (`--since` boundary, all in the C3 brief) until its date next advances.
- **2026-08-21 — C2 committed.** `message-queue.md`: pass — 8 of 19 briefed commits produced edits (new §6 auto-park evidence gate via `1f8d75c`/`926d3b9`/`71b1b90`/`f7a4bd8`/`e9fff4b`; §3 detach-does-not-pause-the-queue via `888f9e4`; §5 QUEUE-box collapse via `37d506d`; `autoPark.ts` key-files row), 11 confirmed no-edit-owed (incl. `dca2267` "send now" — already documented, same-day seed boundary). One VERIFY raised (kitty-detach drafts vs the draft gate) and closed by investigation, **suspicion confirmed real**: the drain can deliver onto a kitty-side draft (`term.onData` never fires for bridge input, `automationStateOf` short-circuits before the buffer read, no gate is detach-aware) *and* the pane's read-only gate is dead (main's detach notify sends both `pty:detached` and `pty:reattached` per state change; handlers ignore the payload, so `entry.detached` settles false). Recorded as a §3 gotcha (Stefan: resolve→gotcha). **Open code bug, out of run scope** — needs a detach-aware delivery gate plus the double-notify fix in `index.ts`; Stefan cards the fix himself (Stefan: tracker note only). Updater coverage notes, accepted as-is: `src/main/index.ts` deliberately not added to Coverage (app-wide entry would flood the drift check; the mechanism is in `autoPark.ts`, and `autoParkSweep()` is named in the doc); auto-park §6 + its glob migrate as one unit if a hive/vacation doc ever exists.
- **2026-08-21 — C1 committed.** All three transactions reviewer-green. `telemetry.md`: pass — no claim changed; the "nothing not listed here is sent" contract proven intact against `fe49af8a` (the collector has no outbound call); one INTENT marker raised and owner-answered (separate `TelemetryCollector` doc later — see Open questions; marker stays open). `knowledge-graph.md`: pass — zero edits owed, both briefed commits proven cosmetic (reviewer regenerated `117ab988` byte-for-byte with Biome); accretion on top: §6 export/method lists completed (incl. `KG_CORE` in `env()`; `corePath()`/`cliPath()` are private and stay undocumented), stale `index.ts (~1251)` line citation dropped. `memory-graph-spec.md`: pass-with-findings — revised per the accepted recommendation; a dozen cited hunks (status line, Fruchterman–Reingold §6, SVG resolution §7, act-filter "Not built" §8, stroke tokens §9, §10/§12 shipped-reality notes via `7ea347b8`/`737b904f`); its VERIFY closed by investigation citing `21e5156` (icon `'web'` deliberate); Coverage extended with `CommandCenterPanel.tsx` (Stefan). Residual: `knowledge-graph.md` will show 1 stale commit (the adoption commit, same-day `--since` boundary, assessed no-edit-owed) until its date next advances.

## Living rules

- Check a chapter off only when its docs are committed. Append a dated status line under Findings per chunk.
- Start every chunk conversation with `/asol-docs update <docs>`. The skill re-runs the drift report and re-derives each brief from headers and git — trust that over this doc's baseline numbers.
- If the run stalls mid-chunk, supersede this doc with a handover; do not rewrite history.
- A chunk kickoff brief carries: the chapter row with its `done =`, the Decided entries with attribution, the standing constraints (the `HIVE.md` aspirational convention, the deletion protocol), the pointers above, and the current drift-report numbers.
- A kickoff brief carries no task list, no code sketches, and no wording that lets a chunk skip its updater → reviewer → interview cycle.

## Chapters

Ordered smallest-first to shake down the update mechanics before the high-value, high-volume docs; `spec.md` is last because it may convert to a rebuild.

- [x] **C1. telemetry.md + knowledge-graph.md + memory-graph-spec.md**
  - done = all three transactions reviewer-green, markers interviewed, committed; memory-graph-spec update-vs-rebuild answered.
- [x] **C2. message-queue.md**
  - done = transaction reviewer-green, markers interviewed, committed.
- [x] **C3. hive.md**
  - done = transaction reviewer-green, markers interviewed, committed.
- [x] **C4. design.md**
  - done = transaction reviewer-green, markers interviewed, committed.
- [x] **C5. spec.md**
  - done = update-vs-rebuild decided by Stefan; the chosen path reviewer-green and committed.
