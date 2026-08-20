# Fix the staging wedge — orphaned monitors, compact eats the clear, armed late-wipe trap

Card: agent-harness-fix-the-staging--2026-08-20. Spec: Robert's diagnosis (mail
2026-08-20T22-32-30-894Z). Census link VERIFIED independently with process
evidence (see card report) — Robert's elimination-based inference holds.

## Branch A — main process (merges normally): R1 + R4

### R1 — monitors never count in the pending-work census (simple form)
`recordSettle` skips background_tasks entries with `type === 'monitor'`.
Why simple over minimum: the exclusion-set bookkeeping is session-scoped but
the monitors are PROCESS-scoped — they survive compact and in-place /clear
(Robert's live orphan counts + verified here via live process list), while
every SessionStart wipes the set, so any wipe-based fix re-wedges on the next
boundary whose semantics we misread. Type-skip makes the wedge structurally
impossible. Cost (finite monitor no longer defers clear/park) is rare and
self-healing: the completion event fires into whatever conversation is live.
The persistentMonitorIds set STAYS — it is the rearm-aware nudge's
session-scoped half (hooks.ts nudgeRearmFor); only its census role dies.
hooks.ts needs no change: resetAgent's wipe is correct for the nudge and now
harmless for the census.

- src/main/pendingWork.ts: recordSettle skips type 'monitor'; comments.
- test/waiting-busy-pending-work.test.cjs: wedge regression (arm → settle →
  resetAgent → settle again with the monitor still listed → count 0), monitors
  never counted, non-monitors/unclassifiable still count, nudge set intact.

### R4 — consume the pending transition on timeout release
A per-file staging timeout releasing mail into the pre-clear conversation must
also consume that card's pending →doing transition; otherwise the watcher
re-decides each tick and types the /clear hours later into the conversation
that absorbed the released mail (Stanley's 21:56 card is armed on this NOW).

- src/main/cardSessions.ts: `cardSessionHoldCards()` (cardSessionMailHold
  becomes its Set wrapper — one definition), and
  `consumeCardTransitions(cardIds, seen = module cardSeen)`.
- src/main/hive.ts: release sweep passes the agent's holding card ids;
  releaseStagedAgent consumes them when stale files released under an active
  hold; timeout god-notice gains the disarm line.
- test/card-scoped-sessions.test.cjs: deferred transition consumed → no fire;
  later genuine re-flip still fires.

## Branch B — renderer (GATED, pushed, tip reported; no live merge): R2+R3+R5

### R2 — compaction visible to the drain
After the drain delivers a compaction command, hold that agent's queue until
the next SessionStart/PostCompact/Stop hook event (bootGraceUntil shape),
bounded by a 30-minute safety expiry.

### R3 — resolve the compact/clear collision at enqueue time
(a) store.ts enqueueMessage: a card-scoped clear (meta.cardFor.kind==='clear')
removes a parked compaction for the same agent — the one-pending-compact
invariant already lives there.
(b) useHive.ts context trigger fire(): a queued card-session clear skips the
agent for the compact action (verb dedupe is the hook).

### R5 — cardFor re-validation fails open for real
Fetch error (hiveTasks reject) holds the message for retry instead of dropping
it; only a successful fetch that shows the card stale drops.
