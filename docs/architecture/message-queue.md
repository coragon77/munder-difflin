# The message queue — how anything gets typed into an agent's terminal

- **Coverage:** `src/main/autoPark.ts`, `src/main/pty.ts`, `src/renderer/src/components/MessageQueueComposer.tsx`
- **Last Updated:** 2026-08-21

Every agent runs a real CLI in a real PTY. That CLI has exactly one input line, and
you are not the only one who wants it: you type into the terminal directly, and the
harness also has messages of its own to deliver. This document is the contract for
who gets that line and when.

Two different queues get called "the queue". They are not the same thing:

| Name | Lives in | Holds |
|---|---|---|
| **MD queue** | the harness (zustand store, per agent) | messages parked by *Munder Difflin* until that agent's terminal is free |
| **Claude queue** | inside Claude Code itself | text Claude Code has accepted but not started on yet |

Everything below is about the **MD queue**. The harness cannot see the Claude queue
and never reasons about it.

---

## 1. One gate

One place types automatic messages into a live agent's PTY: the **drain loop**,
`useHive.ts` effect #4. Everything that wants to reach a running agent enqueues into
the MD queue and lets the drain decide when.

(The single exception is the god agent's boot sequence, `useHive.ts:284`, which
writes its remote-control command and orientation prompt directly. That PTY was
spawned milliseconds earlier and is covered by the boot-grace window, so there is no
user draft it could land on.)

```
composer / Slack ingress ─┐
inbox nudge (effect #3) ──┼──▶ enqueueMessage(agentId, text) ──▶ MD queue ──▶ drain (#4) ──▶ PTY
scheduled /compact (#6) ──┘
```

This is load-bearing. When the inbox nudge wrote straight into the terminal, it was
a second writer with its own idea of when the prompt was free — and its text landed
on top of a half-written line, so the nudge and the user's sentence were submitted
together as one garbled prompt. Routing it through the queue means one loop owns
every "is this terminal free?" decision, and the nudge needs no prompt logic of its
own.

The drain runs on every store change (debounced 200 ms, so a burst of PTY output
coalesces) plus a 3 s backstop tick.

## 2. What the drain checks

The front of an agent's MD queue is delivered only when **all** of these hold:

| Condition | Why |
|---|---|
| agent status is `idle` | don't interrupt a running turn |
| auto-delivery not paused — **or the message was manually released** | floor-wide switch (Command Center); see below |
| past the boot grace window | the CLI is still painting its banner |
| `isTerminalAutomationSafe(ptyId)` | the user owns the prompt — see below |
| 4.5 s since the last delivery to this agent | back-to-back sends jam the TUI |

**Manual release (v0.3.5).** While floor-wide auto-delivery is paused, every queued row
shows a **send now** link. Clicking it sets `manual: true` on that message and moves it
to the front of its queue. The drain then bypasses **only the pause check** for that
message — every other condition in this table still applies, so a manually released
message waits for idle, respects your draft/picker, and is acknowledged the same way.
The pause gate holds everything else untouched.

Delivery is acknowledged only after both PTY writes (the text, then the submit) have
succeeded. A failure leaves the message visible in the queue and it retries.

## 3. The user owns the prompt

`isTerminalAutomationSafe` is the gate that protects your typing. It refuses
delivery while any of these is true (`terminalAutomation.ts`):

| Block | Set by | Cleared by |
|---|---|---|
| `exited` | the PTY died | respawn |
| `picker` | you submitted a bare `/model`-style command that opens a menu | an Enter / Escape / Ctrl-C typed into that terminal, or expiry |
| `draft` | you have unsubmitted text on the prompt | submitting or clearing it, or expiry |
| `settling` | a short repaint window after the line was freed | time |

Both `picker` and `draft` expire after **30 minutes** (`STALE_PICKER_MS`,
`STALE_INPUT_MS`). The expiry exists because both flags are inferred, not reported —
a picker closed some way we can't observe, or a draft flag left set by a TUI that
swallowed keys, would otherwise wedge that agent's MD queue for the rest of the
session.

Two rules about what happens when a block expires:

- **Automation never erases your text.** Expiry means the queued message is typed
  *after* whatever is on the line; the two fuse into one prompt. An earlier version
  sent Ctrl-U first, which silently destroyed real drafts that had merely been left
  alone for a minute.
- **Automation never closes your menu.** We do not send Escape at a picker. You may
  have opened it deliberately and stepped away; taking it down to make room for a
  queued message is not the harness's call, and we cannot verify that Escape worked
  anyway. The composer has a button that does it — because then *you* asked.

Both windows are long on purpose. Treating a live draft as abandoned is the
expensive mistake; leaving a queued message parked a while longer is the cheap one.

**Detach does not pause the queue.** An agent's chat can be detached to a kitty
window: the PTY is owned by main and the pane is only a view, so detach bridges
the *existing* PTY over a unix socket — replaying a bounded per-session
`outputTail` ring (`OUTPUT_TAIL_MAX`, ~48 KB, `src/main/pty.ts`) so the window
opens with context — while the pane greys out read-only. The pane's keystrokes
are *meant* to be refused at the pool's single chokepoint (`term.onData`, gated
on `entry.detached` — but see below), and `pty:write` is deliberately **not**
gated: queue delivery and nudges keep flowing while detached, because the agent
must stay fully live.

**A kitty-side draft does not hold the queue — confirmed gap.** Keystrokes typed
in the detached window go client → unix socket → `detachBridge.ts` →
`PtyManager.write`, so the pane's `term.onData` never fires and `inputDirty`
never sets; a `/model` picker opened in kitty never latches either.
`automationStateOf` (`terminalPool.ts`) short-circuits on `inputDirty` before
consulting the buffer — the echoed kitty text *is* visible there, but the
one-directional read only ever clears a draft. No gate is detach-aware
(`detachedPtyIds` is UI-only), so the drain can fuse a queued message onto a
half-written kitty-side line: exactly the failure §3 exists to prevent, arriving
by a path the draft model cannot see. The pane's own refusal is dead too: main's
detach `notify` sends **both** `pty:detached` and `pty:reattached` on every
state change, the pool handlers ignore the payload and reattach lands last, so
`entry.detached` settles `false` and the greyed pane (veil is
`pointerEvents: 'none'`) still accepts focus and keys. Unfixed as of 2026-08-21;
fix is tracked outside this doc. (VERIFY raised and closed by investigation,
2026-08-21: traced `detachBridge.ts`, `terminalPool.ts` `automationStateOf` /
detach handlers, `index.ts` detach notify, drain in `useHive.ts`.)

## 4. Reading the prompt instead of modelling it

`inputDirty` is inferred by counting keystrokes in `term.onData`. That model drifts:
a TUI that eats keys for its own UI leaves the count above zero while the prompt is
visibly empty — a **phantom draft**, which blocks the MD queue against text that
does not exist.

xterm already holds the rendered screen, so `promptLineHasText` reads it directly
(`term.buffer.active`, the row at `baseY + cursorY`, stripped of prompt chrome).

It is deliberately **one-directional**: the buffer read can only *clear* a draft,
never invent one.

- screen says empty ⇒ believe it, drop the block
- screen says text, or cannot be read ⇒ fall back to the keystroke count

The asymmetry is the point, because the two mistakes don't cost the same. A wrong
"empty" opens the gate and fuses a queued message onto what you're writing. A wrong
"has text" only parks that message until the draft expires. So the cheap mistake is
the one we allow to happen.

One case where the screen is not evidence at all: `inputDirty` is set the moment you
press a key, but the character only reaches xterm's buffer after the PTY echoes it
back. Inside that gap the buffer is still showing the previous state, so a read of a
freshly started draft would return "empty" — the expensive direction. A read within
`ECHO_GRACE_MS` (1 s) of the last keystroke therefore returns "don't know" and clears
nothing.

## 5. Seeing why nothing is being delivered

A held MD queue used to look exactly like an idle agent with nothing to do. The
`typing` badge (`--cth-status-typing`, label **"your draft"**) fixes that: it renders
on agent cards and in the fullscreen roster whenever `hasTerminalDraft(ptyId)` is
true.

It is not an agent status and is never stored on the agent — the PTY parser owns
that field and would overwrite it. It is derived at render from the same draft
detection the gate uses, so the badge is reporting the same draft the gate sees.

It does **not** apply the 30-minute expiry the gate applies. Past that window the
gate starts delivering while the badge still reads "your draft" — which is honest:
your text really is still sitting on the prompt. The badge answers "is my text
there", not "is the queue blocked".

The QUEUE box itself collapses to a slim bar (per-agent flag in the store, shared
by all three hosts — agent panel, command center, fullscreen). The bar keeps the
queue count and the held/delivery status hint visible: queued messages never
become invisible just because the box is folded up.

## 6. Auto-park — when the harness gives the seat up instead

The queue delivers *into* an idle terminal; auto-park is the opposite ruling on
much of the same evidence: an agent idle for an hour with all its work verifiably
finished is parked (vacation) rather than left holding a floor seat. The rule
used to be prose in god's instructions — it ran when god remembered, and the
standup could not backstop it because a standup skips itself on a quiet floor,
which is exactly the state idle agents accumulate in. It is now a pure evidence
gate in `src/main/autoPark.ts`, swept by `autoParkSweep()` (`src/main/index.ts`)
inside the always-on ephemeral-worker tick — no quiet predicate — throttled to
once per `AUTO_PARK_SWEEP_MS` (60 s). Kill-switch: config `autoParkIdle`,
default **on**, no Settings UI.

God, interns (fired, never parked), pinned, archived, already-vacationing and
retired agents are never candidates; every proposed park still goes through the
shared `parkAgent` ladder with origin `'auto'`, whose refusals (busy included —
a busy refusal is a strict no-op) stand behind the sweep.

`autoParkDecisions()` parks only when **every** row here is provable:

| Evidence | Source | Unknown means |
|---|---|---|
| idle ≥ `AUTO_PARK_IDLE_MS` (1 h) | telemetry age (hook/OTLP `lastActive`) — an idle TUI repaints its chrome, so PTY output would read idle as busy forever | no telemetry row = cannot prove idle = no park |
| inbox drained | `inboxBacklogStrict()` — returns `null` on read failure and counts staged dispatch contracts as pending | unknown ≠ drained; blocks |
| no pending background work | finite background-work count | malformed count blocks |
| **every** assigned card `done`, at least one | `cardsByAssignee()` over tasks.json | non-array = no evidence |
| freshest `doneAt` within idle age + `AUTO_PARK_DONE_RECENT_MS` (1 h slack) of the sweep | all three card writers stamp `doneAt` on →done and clear it on any flip off done | unstamped legacy done card = unknown flip time; blocks |

Everything ambiguous fails toward *not* parking: NaN/Infinity/negative ages and
malformed counts are unknown, never zero. The done card is the machine-readable
done-report of the parking gate; an assigned **todo blocks too** — deliberately
stricter than the prose rule, because parking an agent god just assigned work
to, only to auto-recall it on dispatch, is churn. The recency row exists because
the plain done check was weaker than it read: a done flip at 10:00 satisfied it
all evening beside uncarded work. The third `doneAt` writer (the voice writer)
was found by tracing every status-flip call site — a hole in one writer is a
hole in the rule.

Races get the drain's treatment — assume the world moved while you were parking:

- The sweep takes **one short ledger-lock acquisition per park**, evidence read
  fresh inside it, and re-reads the ledger after the park: a `doing`/`blocked`
  card that appeared mid-park triggers an immediate recall
  (`kind:'auto_park_undone'` + god notice). The invariant is restored, not
  hoped for.
- When that backstop recall races hive-dispatch's own queued recall, the
  loser's "not on vacation" answer counts as success — the goal was already
  achieved, so no rejection mail lands beside a restored seat.
- After a shift-close `hive-card prune` no agent has a done card, so the gate
  can never fire again — silently, the deleted-heartbeat failure shape.
  `evidencePruned()` detects that signature (an otherwise-parkable agent plus
  zero done cards floor-wide), logs `auto_park_evidence_pruned` and mails god
  once per episode (in-memory arm, disarmed the moment a done card exists
  again).

Every park mails god why and when (`autoParkReason()` names every gate input)
and logs `kind:'auto_park'`. One scar is load-bearing for anyone touching the
ledger reads: `cardsByAssignee()` accepts **both** tasks.json shapes — the
wrapper object and the bare array `withLedgerLock` hands its callback — because
the first version read `.tasks` off the bare array, every candidate saw zero
cards, and no agent could ever qualify. A shape mismatch degrades silently to
"no evidence", which is why the contract is pinned by behavioral test
(`test/auto-park.test.cjs`), not a source regex.

## 7. Where the code lives

| File | Role |
|---|---|
| `src/renderer/src/components/terminalAutomation.ts` | pure policy — blocks, expiry windows. No DOM, fully unit-tested (`test/terminal-automation.test.cjs`) |
| `src/renderer/src/components/terminalPool.ts` | the pooled xterm per PTY; buffer reads, latches, `isTerminalAutomationSafe`, `hasTerminalDraft` |
| `src/renderer/src/hooks/useHive.ts` | effect #3 inbox nudge (enqueues), effect #4 drain (the one writer), effect #6 scheduled `/compact` |
| `src/renderer/src/store/store.ts` | the MD queues themselves + agent persistence |
| `src/main/autoPark.ts` | the auto-park evidence gate + prune sentinel — pure, unit-tested (`test/auto-park.test.cjs`); sweep wiring is `autoParkSweep()` in `src/main/index.ts` |
