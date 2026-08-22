# Agent & Workspace Lifecycle

- **Coverage:** `src/main/vacationBusy.ts`, `src/main/vacationFlow.ts`, `src/main/closingTime.ts`, `src/main/pendingWork.ts`, `src/main/orphanSweep.ts`, `src/main/worktreeAdopt.ts`, `src/main/branchRetire.ts`, `src/main/graphRefresh.ts`
- **Depends on:** [Munder Difflin Spec](spec.md), [The Hive](hive.md), [Message queue](message-queue.md), [Telemetry](telemetry.md)
- **Last Updated:** 2026-08-22

## Purpose

Everything that happens to an agent and its workspace *around* the PTY: parking it on vacation and fetching it back, closing the floor without losing what agents hold in working memory, deciding at boot which registry entries are corpses, and cleaning up the git artefacts (worktrees, branches, the project graph) agent work leaves behind. It does not own the PTY itself ([spec.md](spec.md)), the hive registry writes and park/recall CLI ([hive.md](hive.md)), or the auto-park evidence gate `src/main/autoPark.ts` ([message-queue.md](message-queue.md)) — this slice is the decision core those callers route through.

**Every module here is a separate file for one reason:** the `.cjs` test harness cannot load `src/main/index.ts` (Electron main entry), so each decision was extracted out of it, dependency-injected and pinned by tests, leaving `index.ts` adapters that are pure wiring. `vacationBusy.ts` set the precedent; `vacationFlow.ts` states it as a characterization contract against the inline code at `main @ 0170dfa`.

## Terminology

| Term | Means |
|---|---|
| **park / vacation** | Off the floor, PTY killed, worktree + session + identity kept. `vacation:true` + `archived:true`. |
| **recall** | Spawn the parked agent back into its existing worktree, resuming its last conversation. |
| **retired / fired** | Permanent. Mutually exclusive with vacation. Interns are fired, never parked. |
| **pinned** | The human's "never park this one" flag on a worker. |
| **Closing Time** | The shutdown protocol: everyone saves state and confirms before the app quits. |
| **census** | The pending-background-work snapshot taken at an agent's last Stop hook. |

## Mechanism

### When an agent counts as busy

One rule, `vacationBusy()` (`vacationBusy.ts:46`). Three consumers, no second definition: the park gate (`parkAgent`'s `deps.busy` closure, `index.ts:6678`), the card-session clear gate and the staged-mail hold — the latter two share the `houseBusy` closure (`index.ts:7419`), handed to the card-session watcher and to `hive.setStageBusyProbe(houseBusy)` (`index.ts:7434`), because a hold must not break while the pane it waits for is legitimately non-idle.

``` typescript
if (pendingBackgroundWork > 0) return true;                    // waiting ≠ idle
if (telemetryAgeMs !== undefined) return telemetryAgeMs < VACATION_BUSY_MS;
if (providerReportsTelemetry) return false;                    // silent since boot
if (ptyIdleMs !== undefined) return ptyIdleMs < VACATION_BUSY_MS;
```

Telemetry liveness (hook/OTLP `lastActive`) is **strictly primary**: stale row + chatty pane is parkable, fresh row + quiet pane is busy. PTY output survives only as the fallback for providers with no telemetry plane, because an idle claude TUI repaints its chrome continuously and `lastOutputAt` alone read every idle pane as "actively working" (the bug in 3275892). `VACATION_BUSY_MS` is 60s: the old 10s window tripped on a single long bash call, and 60s of telemetry silence essentially never happens while work continues.

The fourth input is the **census** (`PendingWorkTracker`, `pendingWork.ts:48`), fed from claude's Stop-hook `background_tasks` snapshot. An agent idle at its prompt but waiting on a background shell or in-flight subagent is busy — otherwise the idle-gated clear wipes the conversation the completion was going to wake. `recordSettle`'s only skip branch is `type === 'monitor'`; anything unclassifiable **counts**, because a deferred clear costs minutes and a fired one costs a context. The module header additionally states that `session_crons` (recurring wakeups) are the same never-completing class and never count — that is docstring, not code.

### What a park refuses, and in which order

`parkAgentCore()` (`vacationFlow.ts:119`) is a ladder of strict no-ops: hive disabled → unknown id → god (`isGod` **or** `registry.godId`) → intern → retired → already parked → **pinned** → busy. Pinned sits deliberately before the busy gate and the teardown so a refused park touches nothing. The busy rung is the only one `ParkOrigin` changes: `'operator'` (UI button) skips it — the human pressed it and can see the pane — while `'request'` (god) and `'auto'` (the idle sweep) enforce it. `deps.busy` may answer with a **string**, which lands in the refusal verbatim; boolean `true` falls back to the generic "actively working".

### What a park tears down, and what it keeps

Order is `dropWorktree(ptyId)` → `killPty` → `teardownPty` → `setVacation`, and the first step is load-bearing: a park is not a firing, the worktree **is** the agent's state, and `teardownPty`'s force-remove — correct for a closed terminal — would delete it. Dropping the `worktreePaths`/`worktreeOrigins` entries first makes park match the post-restart respawn path that was always correct. `setVacation` returning false **fails the park**: the terminal is already gone, so answering "protected" while the registry holds no flag would be a lie.

### Why a recall repairs the flag after a green spawn

The spawn *is* the recall (`recallAgentCore()`, `vacationFlow.ts:213`): `isolate:false`, `cwd` = the existing worktree, `resume:true` so the pane continues the last conversation instead of booting fresh, and the registry-saved `officeCharacter`/`officeAccent` riding the floor event so the agent comes back wearing its own sprite. `ensureAgent` clears `vacation` during that spawn but swallows its own failures by design ("never block a spawn on it"), so a green spawn does **not** prove the flag cleared — and a still-flagged agent is invisible to every roster read while its PTY burns tokens. The core re-checks and repairs; a failed repair is reported as a failed recall, never as green.

### Which park requests are held instead of answered

`vacationRequestTarget()` resolves the request file (both `agentId` and `id`, case-insensitive verb, `whenQuiet` as **strict** `true`). It rejects non-object bodies as its very first act because `JSON.parse('null')` parses fine and the field dereference then threw *past* every guard in `processVacationRequest` — the file was never archived and got retried forever. `shouldHoldPark()` is true for exactly one case: a `whenQuiet` **park** whose refusal carries `busy: true`. Permanent refusals and all recalls answer immediately — holding those would queue the request forever. The hold needs no state: not archiving the file leaves it in `vacation-requests/`, which the watcher re-reads next tick and after a restart.

### How the floor closes without losing state

Killing the PTYs mid-thought loses whatever agents hold in working memory: uncommitted WIP, unrecorded decisions, half-updated `memory.md` files. `ClosingTimeController` (`closingTime.ts:52`) closes the floor the way an office does — the human announces it, everyone packs up and confirms, the manager locks the door — and it never types into a terminal. It injects one mail and watches routed traffic; the existing hive rails (inbox delivery, the idle inbox-wake nudge, Stop-hook draining) do the rest.

`start()` mails god a numbered brief: broadcast closing time, collect a `CLOSING-TIME-ACK` from every named worker, save your own state, then send `CLOSING-TIME-COMPLETE`. In parallel it queues a `control.steer()` note for god and every live worker, because the inbox brief only lands when an agent next *stops* and a worker hours into a task would otherwise hold the entire shutdown; the steer rides the next hook boundary instead. `onRouted()` counts an ACK when `ACK_RE` matches, the sender is a known worker, and god is among the targets — the subject regexes are deliberately forgiving about case and `-`/`_`/space, since agents type them by hand.

On `CLOSING-TIME-COMPLETE` **from god only** — a worker must not be able to shut down the floor — the controller verifies its own ACK ledger rather than trusting the instruction: still-live, un-archived workers that never acked bounce the conclusion back to god with the straggler list, and the app stays open. Otherwise it emits `complete` and calls `onConcluded` (the shared `teardownAndQuit`) after `TEARDOWN_GRACE_MS`, so the god's final commit and log writes land on disk. The roster is **live PTYs**, not the registry — agents that died with a hard quit keep their record without ever being flagged `archived`, so a registry roster waits on ghosts that can never ACK (observed 0/9 with four real workers, 57ed817).

`TIMEOUT_MS` is 6 minutes and is only a UI signal: it emits a `timeout` phase so the dialog can offer a force quit, and nothing tears down on its own — compaction or a long tool call can legitimately hold an ACK for minutes. `cancel()` stands the floor back up: it clears the timers, fires `control.clearSteers()` for god and every worker so a steer no hook boundary has consumed yet cannot tell a busy agent to shut down *after* the human changed their mind, and mails god a `CLOSING TIME CANCELLED` note for the agents that already read theirs. A hard quit also calls `cancel()` first (`index.ts:5059`).

### What the boot orphan sweep may archive

`orphanedAgentIds()` (`orphanSweep.ts:55`) exists because on 2026-08-18 an app start archived 43 agents including the entire vacation pool. Rules in order: **zero live PTYs archives nobody** (`ptyToAgent` is process-local and filled only at spawn, so an empty map is the universal fresh-boot state, never "everyone is dead") → god never → `vacation:true` never, *whatever `archived` says* → already archived is untouched → live PTY is active → everything else is a stale orphan. The vacation exemption is its own rule so it cannot ride on the side-invariant `park ⇒ archived:true`, which divergent hand-edited states break. The sweep keeps its original reason: with at least one live hive PTY — the `config:changeHome` recover-in-place re-bootstrap, which re-runs the boot sequence mid-session — a PTY-less, non-parked, non-archived entry really is a carry-over from a session that died without archiving.

### Which worktrees a re-entering spawn adopts

`shouldAdoptWorktree()` (`worktreeAdopt.ts:24`) closes the leak that park's `dropWorktree` opens. Only the fresh-spawn branch (`isolate:true`) ever *registers* a worktree, so after park→recall the directory and its `git worktree` registration were untracked forever and nothing GC'd them. The rule adopts exactly the shape the fresh branch creates: `isolate !== true` **and** `cwd` a *direct* child of the harness worktrees root. The caller still gates on `isRepo(cwd)`.

### What may delete a remote branch

Renderer batches land by **cherry-pick**, so commits reach main under new shas and every ref-level check calls the source branch unmerged forever. `retireLandedBranches()` (`branchRetire.ts:136`) automates the manual sweep that content-verified and deleted five such branches by hand. It deletes only on an exact proof:

- **P1 tree-equality** — the tip's tree is byte-identical to the tree of some commit main gained since the merge-base (catches a landing even after main advanced past it).
- **P2 reverse-apply** — `git diff --binary <merge-base> <tip>` reverse-applies cleanly onto `origin/main`'s current tree, via `git apply --cached --check -R` against a **throwaway index** (`GIT_INDEX_FILE` pointed at a `mkdtemp` scratch dir), so neither the working tree nor the real index is touched.

**Unsure = leave and say:** `git cherry`/patch-id lied in both directions during the manual sweep, so no heuristic may delete; a branch failing both proofs lands in `unproven` with its reason. Four conditions abort the whole run before any branch is judged: a failed `fetch`, a missing `refs/remotes/origin/main`, a failed worktree listing (holders unverifiable → delete nothing) and a failed `for-each-ref` branch listing. Never touched: worktree-held tips, tips already ancestors of main, unsafe ref names, empty claims. Ordering is **archive-first** — the `archive/<branch>` tag must be created *and pushed* before any delete is attempted, so no delete happens without its recovery ref on the remote.

> ⚠ **INTENT UNVERIFIED:** Why does branch retirement — the only step here that performs a destructive *remote* operation, unprompted, on every app start — ship with no config kill-switch, when the reversible local auto-park sweep has `autoParkIdle`? Nothing in the code, the commits or the tests records the decision. (raised 2026-08-22; interview 2026-08-22: under discussion — switch default-on vs default-off vs leave-as-is presented, Stefan's decision pending)

### When the project-root graph is rebuilt

`refreshProjectGraph()` (`graphRefresh.ts:87`) rebuilds `graphify-out/graph.json` in the **main checkout** when its `built_at_commit` differs from HEAD. Workers refresh graphs inside their worktrees where the result is private and disposable, so the copy strangers read was the stalest of five. App start is the home because the restart-window watcher merges only while the app is *down* and the app always starts right after: the refresh runs seconds after every landing, covers manual merges and operator pulls too, and adds nothing to the watcher's merge+push window. Three skips, each a returned reason and never a throw: no HEAD (packaged asar), no `graph.json` (this refreshes, it does not first-build — first builds are slow and stay manual), and fresh. Binary lookup tries `~/.local/bin/graphify` **first** (desktop launches have no login shell and miss it), PATH second, 120s cap.

## Workflows

A vacation-request file, end to end:

| Step | Action | Location |
|---|---|---|
| 1 | Watcher tick reads the request JSON | `processVacationRequest`, `index.ts` |
| 2 | Parse/verb/id resolution | `vacationRequestTarget`, `vacationFlow.ts:319` |
| 3 | Park or recall (nothing may throw past here) | `parkAgent` / `recallAgent`, `index.ts:6671` / `6727` |
| 4 | Busy + `whenQuiet` → leave the file queued, mail god once | `shouldHoldPark`, `index.ts:6860` |
| 5 | Otherwise archive to `.done` / `.failed`, inform god | `archiveRequestIn`, `index.ts` |

At app start: `archiveOrphanedAgents()` (`index.ts:1398`) runs in the boot sequence, then `whenReady` fires `refreshProjectGraph` and `retireLandedBranches` side by side (`index.ts:7653`, `7663`) — same seam, same never-throw fire-and-forget contract.

## Integration points

- **PTY teardown** — `deps.killPty` / `deps.teardownPty` are `ptyManager.kill` and `teardownPty` ([spec.md](spec.md)). Teardown sets `archived` (liveness); vacation is the layer the park adds on top.
- **Hive registry** — `hive.setVacation` / `setArchived` / `appendLog` persist ([hive.md](hive.md)); `setVacation` refuses to flag a pinned, retired or god entry (`hive.ts:1473`) as a registry-level belt under this ladder's rungs, so a future caller that bypasses `parkAgentCore` still cannot park them.
- **Auto-park** — `src/main/autoPark.ts` decides *which* idle agents qualify, then parks through this ladder with `origin: 'auto'` ([message-queue.md](message-queue.md)).
- **Telemetry & hooks** — `vacationBusy`'s primary input is a `TelemetryCollector` row ([telemetry.md](telemetry.md)); `PendingWorkTracker` is fed entirely by `hooks.ts` (`PostToolUse(Monitor)` → `recordMonitorArm`, `Stop` → `recordSettle`, `SessionStart`/`SessionEnd` → `resetAgent`).
- **Routed mail & steering** — `hive.setRoutedObserver(...closingTime.onRouted...)` (`index.ts:5090`) is Closing Time's entire input; `control.steer` / `control.clearSteers` (`src/main/control.ts`) are the graceful-interrupt side.
- **Git** — `branchRetire` and `graphRefresh` use `src/main/git.ts` (`runGit`, `getHead`, `isSafeRev`, `listWorktrees`). `runGit`'s optional `env` passthrough exists for this slice's `GIT_INDEX_FILE` trick.

## Gotchas

- **No PTY means no busy check at all.** `parkAgentCore` consults `deps.busy` only inside `if (ptyId)`; an agent without a live pane goes straight to the flag write. Pinned by *"park: no PTY means no busy check, no teardown"*.
- **The census is a frozen snapshot and can hold a park shut for 75 minutes.** It refreshes only at Stop, so work that dies *without waking the agent* — the module's own example is a background shell killed by its timeout — produces no new settle, and `countFor` keeps returning the old count until `PENDING_CENSUS_TTL_MS` expires, while the agent sits idle at its prompt. This is why the refusal now carries a reason string naming the snapshot semantics and the ceiling (6b04996): "actively working" was a wrong verdict, twice observed on Stanley. Use `--when-quiet` instead of retrying. Work whose completion *does* wake the agent self-heals, because the wake produces a fresh settle.
- **Monitors never count by TYPE, not by id.** The original exclusion tracked monitor `taskId`s learned at arm time, but that bookkeeping is conversation-scoped while monitors are *process*-scoped: every `SessionStart(compact/clear)` wiped the ids while the monitors lived on, each orphan counted as pending finite work forever, and both delivery gates wedged (six timeout releases in one day). Pinned by *"THE WEDGE (incident 2026-08-20)"*.
- **`persistentMonitorIds` is no longer the census exclusion but is not dead.** Its surviving consumer is the rearm-aware nudge (`hooks.ts` `nudgeRearmFor`), where session scope is correct. Deleting it because "monitors are skipped by type now" breaks that wake.
- **The census dies with the process.** `PendingWorkTracker` is in-memory by design — a restart kills every PTY and with it every session's background work.
- **Zero live PTYs is the fresh-boot state, not an empty office.** Any future check reading "no live PTY" as evidence of death repeats the 2026-08-18 incident that archived 43 agents. Pinned by *"zero live PTYs archives nobody"*.
- **Adoption is exact-shape, one level deep.** A recall whose `cwd` sits two levels under the worktrees root is silently not adopted, and that worktree leaks forever — no later archive, kill or exit can remove it. Pinned by *"only DIRECT children match"*.
- **Idempotent recall depends on byte-exact error strings.** `processVacationRequest` treats a failed recall as benign — goal already achieved, archive to `.done` — only when `res.error` *equals* `"<id>" is not on vacation — nothing to recall` or `"<id>" is already on the floor` (`index.ts:6879`). Rewording either message in `recallAgentCore` (`vacationFlow.ts:225`, `:227`) silently turns an idempotent recall into a `.failed` archive plus a rejection mail to god. A substring regex was tried and rejected ("round 4"): recall passes arbitrary spawn errors through verbatim, so a substring match would archive any error containing the phrase as a success.
- **An archive tag that already exists decides the run.** At a *different* commit it blocks retirement outright (`unproven`, "left for a human"); at the branch's current tip it is treated as a previous partial run and the code skips straight to the remote delete. Re-pointing an `archive/*` tag by hand therefore either freezes a branch forever or hands it a pre-approved delete.
- **A branch is worktree-protected only while a worktree HEAD equals its remote tip.** `heldHeads` is a set of worktree head *shas*, so a worktree sitting on the branch but behind or ahead of `origin/<branch>` does not match; the branch then still needs a content proof, but that safety net is not what saves it.
- **Closing Time has no automated test.** Every other module in this slice is pinned by a `.cjs` suite; `closingTime.ts` has none anywhere in `test/`. ACK matching, the premature-COMPLETE verification and the steer fan-out are unguarded.
- **Re-pressing "closing time" while it runs notifies nobody.** `start()` returns early after re-arming the timeout and emitting `progress` — no new brief, no new steers. The timeout only emits a `timeout` phase for the UI; nothing force-quits on its own.
- **The shutdown brief still names a role that was deleted.** The body tells god "The prep assistant saves its own memory separately — do NOT wait for it", but the assistant concept was removed from main in 6d0e092 (`src/main/assistant.ts` deleted; `isAssistant` dropped from `hive.ts`, `config.ts` and `closingTime.ts` itself).

- **`ClosingTimeController.isActive()` has no caller.** Searched `src/`, `src/preload/` and `test/`: the only occurrence is the definition at `closingTime.ts:76`. The quit dialog tracks state through the `app:closingTime` event stream instead.

## Key files

| File | What lives in it |
|---|---|
| `src/main/vacationBusy.ts` | `VACATION_BUSY_MS`, `vacationBusy()` — the one house busy rule |
| `src/main/vacationFlow.ts` | `parkAgentCore`, `recallAgentCore`, `vacationRequestTarget`, `shouldHoldPark`, `ParkOrigin`, the `ParkDeps`/`RecallDeps` contracts |
| `src/main/pendingWork.ts` | `PendingWorkTracker`, `PENDING_CENSUS_TTL_MS` |
| `src/main/closingTime.ts` | `ClosingTimeController` — brief, steers, ACK ledger, COMPLETE verification, teardown grace |
| `src/main/orphanSweep.ts` | `orphanedAgentIds()` — the boot migration's decision core (pure, dependency-free) |
| `src/main/worktreeAdopt.ts` | `shouldAdoptWorktree()` |
| `src/main/branchRetire.ts` | `retireLandedBranches()`, `proveLanded()`, `archiveTagFor()` |
| `src/main/graphRefresh.ts` | `refreshProjectGraph()`, `isGraphStale()`, `graphifyCandidates()` |
| `src/main/index.ts` | Adapters only: `parkAgent`, `recallAgent`, `processVacationRequest`, `houseBusy`, `archiveOrphanedAgents`, the `whenReady` calls |

Pinned by `test/vacation-busy-check.test.cjs`, `vacation-flow.test.cjs` (the characterization suite), `vacation-park-when-quiet.test.cjs`, `waiting-busy-pending-work.test.cjs`, `orphan-sweep.test.cjs`, `worktree-adopt.test.cjs`, `branch-retire.test.cjs`, `graph-refresh.test.cjs`, plus `auto-park.test.cjs` and `hive-pin.test.cjs` for the ladder's callers.
