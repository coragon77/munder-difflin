# The Hive — autonomous multi-agent layer

- **Coverage:** `src/main/hive.ts`, `src/main/hiveGate.ts`, `src/main/memory.ts`, `src/main/roster.ts`, `src/main/actionableCards.ts`, `src/main/actionableWatch.ts`, `src/main/cardSessions.ts`, `src/main/orientGate.ts`, `src/main/orientInject.ts`, `src/main/sessionRequests.ts`, `src/main/standup.ts`, `src/shared/hiveMail.ts`, `src/renderer/src/hooks/useHive.ts`, `hive/`, `src/shared/cardSessions.ts`, `src/shared/inboxWake.ts`, `src/main/reflect.ts`, `src/shared/agentRole.ts`
- **Depends on:** [Munder Difflin Spec](docs/architecture/spec.md)
- **Last Updated:** 2026-08-22

> How Munder Difflin turns a room full of independent agent processes —
> `claude` or `pi` CLI engines — into a collaborating, self-coordinating team
> with persistent memory, a shared blackboard, and a "god" orchestrator that
> runs the floor.

This document is the design source of truth for the agent-collaboration layer. It
sits alongside [`SPEC.md`](./SPEC.md) (terminal/event plane) and
[`DESIGN.md`](./DESIGN.md) (visual system). Code is the source of truth for what's
*built*; this is the source of truth for what we're *building toward*.

---

## 1. What we're building (and what it's called)

Each spawned agent is a real CLI process — engine `claude` or `pi`, carried
on every roster surface — with a filesystem, a system prompt, and a hook
lifecycle. We layer four classic patterns on top:

| Behaviour the user asked for | Pattern (the name) |
| --- | --- |
| Per-agent memory file made at spawn, that the agent reads and updates | **Agent long-term memory** (MemGPT/Letta-style self-managed memory) |
| Writing a requirement into another agent's file | **Stigmergy** — coordinating by modifying a shared environment |
| A shared plan multiple agents edit | **Blackboard architecture** (Hearsay-II) |
| "Check after finishing every task" | **Mailbox / actor model** — drain an inbox at a lifecycle point |
| A "god" agent that runs the floor and clarifies for others | **Orchestrator / supervisor** (LangGraph-supervisor-style) |

The umbrella term is a **multi-agent system (MAS)** with **autonomous agent
loops**. The closest academic analogue to this app is Stanford's *Generative
Agents* (Park et al., 2023): Sims-style avatars in a 2D world with a memory
stream, retrieval, reflection, and planning.

---

## 2. Locked design decisions

1. **Git as the coordination/audit layer, single committer.** Everything the
   hive knows is files in one local git repo. To avoid `.git/index.lock`
   corruption with many concurrent agents, **only the Electron main process
   commits**. Agents never call git — they write plain files. (Research:
   GitHub Desktop's commit-queue pattern; lazygit/git-retry backoff.)
   *Built refinements:* `bin/hive-card restore` reads past ledger versions out
   of the hive's own git history — read-only `git log`/`show`, the main process
   stays the only committer (f7f62cc) — and churny append-only live files are
   deliberately untracked (`cost-ledger.jsonl`, 1603014).
2. **Single-writer-per-file.** Each agent writes only inside its own
   `agents/<id>/` directory. Cross-agent delivery happens by the **router**
   (main process) moving messages from a sender's `outbox/` into a recipient's
   `inbox/`. No file is ever written by two processes.
   *Built differently:* shared state (`tasks.json`, `registry.json`) is
   multi-writer by design — the main process **and** the generated
   `bin/hive-*` primitives — serialized by O_EXCL lock files
   (`tasks.json.lock`: 5174788, 32c5eaa; one shared `registry.json.lock`
   across CLI and main-process setters: 7cb3969). Every *non-primitive*
   access is refused by the god-scoped PreToolUse shared-state gate
   (`src/main/hiveGate.ts`, a7076bb; reads included since 26d7de2). The gate's
   primitive-invocation classifier is exported to the orientation backstop
   (`src/main/orientGate.ts`), so the two PreToolUse gates can never disagree
   about what a primitive invocation is — for both, prose inside a primitive
   call is mention, not access (0b36cf1) — and since 13b432a the orient
   gate's single shell tokenizer (`parseCommand`) knows what is live by
   construction.
3. **God-mode autonomy, native HITL.** A privileged **god agent** (lives in
   Michael's room) adjudicates cross-agent traffic. Routine requests
   (clarifications, data asks, plan tweaks) it resolves itself and the system
   keeps running fully autonomously. **Critical** items (destructive ops, spend,
   scope changes, unresolvable conflicts) route to the god, who surfaces them to
   the human natively in his own Claude Code session — there is no separate
   approval queue. Tool-permission prompts are the HITL gate, and they're
   approvable remotely from a phone via `/remote-control` (link gated by the
   `godRemoteControl` config flag, on by default).
4. **Memory: markdown first.** Per-agent `memory.md` + shared blackboard, with a
   SQLite FTS index when keyword recall isn't enough. A heavyweight vector layer
   (Letta/Mem0/Zep) is *not* needed at 5–15 agents and is architecturally wrong
   here (they want to own the agent runtime; our runtime is the `claude` CLI).
   Optional future upgrade: **MemPalace over MCP** (validate its retrieval first —
   its public benchmarks are overstated per independent audit).
5. **Autonomous loop = `Stop` hook.** An agent that finishes drains its inbox via
   a `Stop` hook that returns `{"decision":"block","reason":…}` to keep it
   working, guarded by `stop_hook_active` to prevent infinite loops.

---

## 3. On-disk layout — the "hive"

Lives under `<harnessHome>/hive/`, a git repo committed only by the main process.

```
hive/
  PROTOCOL.md            # the agent-facing contract (how to remember + message)
  registry.json          # roster: every agent, role, capabilities, status, seat
  board.md               # shared blackboard / co-authored plans
  tasks.json             # task ledger (id, assignee, spec, status, result ref)
  tasks.json.lock        # O_EXCL lock shared by main process + CLIs (5174788, 32c5eaa)
  fleet.json             # near-live floor snapshot; rebuilt on roster flips, not just the beat (15d18e6)
  log.jsonl              # append-only event feed (drives the UI activity stream)
  bin/                   # generated lifecycle primitives — the sanctioned door to shared state (see below)
  spawn-requests/         # hire queue — written by hive-hire; hand-drops gate-refused (26d7de2)
  fire-requests/          # god fires an intern via hive-fire (intern-scoped; human hires stay human surfaces)
  vacation-requests/      # park/recall queue — written by hive-park/hive-recall (788e344)
  agents/<agentId>/
    identity.md          # who am I, my role, my capabilities  (read at start)
    memory.md            # my long-term memory  (I read at start, append as I learn)
    inbox/               # messages delivered TO me — <ts>-<msgid>.json
    inbox/.done/         # processed messages (kept for audit, not deleted)
    inbox/.staged/       # mail held invisible until the card's conversation exists (09ddde2)
    outbox/              # messages I want to SEND — router drains these
    cursor.json          # { lastProcessed: <msgid> }  — avoids reprocessing
```

Design rules that make this robust:
- **One JSON file per message**, written via temp-file + atomic `rename` — never
  a co-edited shared mailbox file (those conflict under git).
- **Append-only** `log.jsonl`; consumers track their own cursor.
- `board.md` is the one genuinely co-edited file — it goes through the god agent
  (single scribe) to avoid conflicts. One built exception: the standup clerk
  appends a single escalation line per anomalous standup (f415122; sole-scribe
  texts swept in 23bd03b).

**Built on top of this layout (the 2026-08-17→21 "primitive wave"):** shared
state is no longer touched by hand. `ensureHive` regenerates `bin/` at every
boot — `hive-card` add/status/update/list/show/ask/prune-done/restore (5174788,
40d86ac, 7cb1733, bf8a8fe, 3ab7355, f7f62cc), `hive-mail` (d66e1d7; bodies with
`$`/backticks go via stdin, 533375e), `hive-dispatch` + `hive-inbox` (a20f75a),
`hive-hire`/`hive-fire` (0875b5a), `hive-park`/`hive-recall` (788e344),
`hive-roster` show/list (357610e), `hive-new` (0a94b09), `hive-retarget`
(6e69f80, the only primitive that changes an agent's registry cwd),
`hive-restart-window` (1f976fc; its watcher survives the restart it serves by
launching in its own transient systemd scope — `detached:true` does not escape
the app's scope cgroup, 9e25944). `hive-dispatch` is the **only**
todo→doing path (de2b141), and every writer CLI refuses a dead `HIVE_ROOT`
before touching disk (1c27440, the phantom-hive mail-loss fix). Card
dependencies got their sanctioned writer late: `hive-card update --depends-on`
(087060f) — until then `dependsOn` had four readers and no writer, so the
dep-waiting state was unreachable by any sanctioned path.

Four hive-side helpers claimed in the coverage-gap round (2026-08-22), each
with its rationale in its own header docstring: `src/shared/cardSessions.ts`
(the card-session delivery-staleness schema shared between the main-process
watcher that mints the marker and the renderer queue-drain that revalidates it
at delivery, fail-open (54e3737) — the shared half of the covered
`src/main/cardSessions.ts`);
`src/shared/inboxWake.ts` (the reconciler behind `useHive` effect #3, the
inbox-wake nudge — reconciliation over observable state replaced the
enqueue-time edge-trigger after a lost nudge silenced an agent for 57 minutes;
b593e99, 1fbfdf0); `src/main/reflect.ts` (`MemoryReflector` — the CONDENSE
half of the janitor: acts on the janitor's "Needs condensing." flag for
oversized `agents/<id>/memory.md`); `src/shared/agentRole.ts` ("role is
identity" — the registry field god routes work on; absent must render as
unmistakably unknown, never as a placeholder).

---

## 4. Message schema (FIPA-lite)

Borrow the one useful idea from FIPA-ACL/KQML — the **speech act** — and drop the
LISP syntax. Seven semantic fields:

```jsonc
{
  "id":            "2026-05-30T14-03-11-123Z-a1b2",  // unique, time-sortable
  "conversation":  "conv-7f3",                        // groups a thread
  "in_reply_to":   "<prev msgid> | null",
  "from":          "agent.researcher",
  "to":            "agent.coder | god | broadcast",
  "act":           "request | inform | propose | query | agree | refuse | done",
  "subject":       "short human-readable summary",
  "body":          "free text / markdown / structured payload",
  "hops":          3,            // ++ per reply; capped to kill ping-pong loops
  "requires_reply": true,        // only request/query/propose obligate a reply
  "needs_human":   false,        // router/god may flip this to escalate
  "created_at":    "ISO-8601"
}
```

Anti-livelock rules: only `request`/`query`/`propose` obligate a reply (pure
`inform`/`done` are terminal); every reply increments `hops`; past a hop cap the
god agent escalates instead of letting two agents loop forever; re-seeing a
processed `id` is a no-op (idempotent via cursor).

Built envelope extensions: `cardId` ties a human-task mail to its card so god
adopts instead of minting a twin (40d86ac); `foldedIds`/`pointedIds` make
dispatch-contract mail-folding idempotent (a006908, 40bd9cb). The router has
stamped `from` since inception (`normalize`, dc7f1ce), so `from:god` is
unforgeable by peers — 2476ac5 shipped the *rule text* relying on that fact
(god-relayed operator authorization), no envelope change.

---

## 5. Control flow

```
agent B mid-task needs something from agent C
        │ writes  agents/B/outbox/<msg>.json   (act:request, to:C)
        ▼
┌─────────────────────── main process (the harness) ───────────────────────┐
│  Router watches every outbox/                                             │
│    → deliver to agents/C/inbox/   (to:"human" → routed to the god proxy;  │
│       the god surfaces critical calls natively in its own session)        │
│    → append to log.jsonl → git commit (single committer, retry+backoff)   │
└──────────────────────────────────────────────────────────────────────────┘
        │ delivered to C's inbox
        ▼
agent C finishes its current turn → Stop hook fires
        │ hook POSTs to the hive socket; main process checks C's inbox
        │ unread messages?  → reply {"decision":"block","reason": <messages>}
        ▼
agent C keeps working: reads the messages, acts, replies via its own outbox
```

The same hook socket drives the avatars: `PreToolUse`/`PostToolUse` payloads move
an agent to the right station (replacing today's `mockEvents.ts` / PTY-scraping).

Built refinements to delivery: while an assignee holds a doing card whose
card-scoped conversation is not yet established, `deliver()` stages mail in
`inbox/.staged` — invisible to every wake rail until the session stamp lands
(09ddde2) — and a dispatch contract absorbs the assignee's other pending mail
into its own body (budgeted, idempotently folded), so an agent can never read
the dispatch and miss the mail beside it (4924149). The staging hold is
time-bounded: past `MAIL_STAGE_TIMEOUT_MS` the mail releases rather than
wedging — monitors never count in the pending-work census, and the timeout
release disarms the late-wipe trap (1c76ab0) — unless a house busy probe shows
the assignee legitimately busy, which extends the hold and notifies god once
per release epoch (9f3cd0d, 8b0241b). A stalled outbox is
detected once per episode and self-healed by a backstop `routeOnce()` on the
fleet tick (7fcb8bd). Registered worker-to-worker mail drops a no-wake audit
CC into god's inbox (a3cf1e6).

---

## 6. The god agent (orchestrator)

A fixed, always-on agent seated at `desk-ceo` (Michael's room), `character:
michael`, flagged `isGod`. It is an ordinary `claude` process — the *intelligence*
— while the main process is the *mechanism* (git, sockets, routing). It owns:

- **Roster & routing** (`registry.json`): who exists, their capabilities,
  status — consumed via the auto-injected LIVE ROSTER line (slim per prompt,
  full block only on roster change, 16a6def) and the read-only
  `hive-roster show/list` (357610e); raw `registry.json`/`fleet.json` reads
  are gate-refused (26d7de2). Every roster surface — fleet snapshot rows and
  the roster lines — carries the agent's engine token (`engine=claude` /
  `engine=pi`), so god's only sanctioned view of the floor is not
  engine-blind (15f9303).
- **Adjudication**: read each outbound request; resolve routine ones itself
  (answer clarifications, route to the right specialist with a self-contained
  task spec), escalate only critical ones. This is "god mode."
- **Blackboard scribe**: the single writer of `board.md`, so shared plans never
  conflict (built exception: the standup clerk's escalation line, f415122).
- **Task ledger** (`tasks.json`): assign, track, retry, checkpoint — through
  `hive-card`/`hive-dispatch` only; hand-edits are gate-refused (a7076bb) and
  `hive-dispatch` owns the todo→doing flip (de2b141).
- **Hiring & firing**: mints standing interns with `hive-hire` and fires them
  with `hive-fire` — the CLIs own the spawn-/fire-request JSON (0875b5a,
  honoring the worker-bypass setting); ephemeral workers are gated OFF by
  default (`workersEnabled`, da8f0c3); parks/recalls ride
  `hive-park`/`hive-recall` (788e344) with an evidence-gated auto-park sweep
  for idle agents (1f8d75c) and a busy pre-flight on `hive-park` — refusals
  are truthful and name the census reason instead of printing a success
  receipt over a silent bounce (6b04996); human-made hires stay human
  surfaces.

Its escalation policy (what counts as "critical") lives in its system prompt and
is the primary control surface — tune the prompt, not the code. Since the
primitive wave that split has hardened: rules that must *hold* are mechanism,
not prose — the paused hold is god-only in the CLI (2ecb500), the operator's
holds are enforced at the doing flip itself (de2b141), and the shared-state
gate has no override flag (a7076bb) — while judgment (escalation, parking
evidence, dispatch contracts) stays in the prompt. Checks that classify free
prose sit in between and are warn-only by standing ruling: the compose lint on
dispatch bodies (unsourced diagnoses, dead `file:line` cites, b7b159d) and the
scope-fold check on updating a doing card (fc06196) print advisories, never
block.

---

## 7. Phased plan

- **Phase 0 — Foundation** ✅: `hive.ts` on-disk layer + spawn injection
  (identity, protocol, env) + IPC to read hive state. Agents are hive-aware: they
  read their memory/inbox at task start and send via outbox; the router delivers;
  everything is committed and visible.
- **Phase 1 — Autonomy** ✅: `hooks.ts` UDS server + `cth-hook` shim (attached per
  agent via `--settings`) + `Stop`-loop so agents drain their inbox automatically
  and keep running (guarded by `stop_hook_active` + cursor); hook events stream to
  the renderer to drive avatars.
- **Phase 2 — God mode** ✅: the god agent auto-spawns into Michael's room
  (`desk-ceo` reserved) and, on a fresh spawn, is started with `/remote-control`
  (best-effort; gated by the `godRemoteControl` config flag) plus an
  orientation prompt so it begins running the floor on its
  own. The router routes `to:"human"` traffic to the god (the human's proxy);
  there is no separate approval queue — human-in-the-loop is native to each
  agent's Claude Code session (permission prompts, approvable remotely from a
  phone). Idle agents are woken when they hold unread inbox messages.
- **Phase 3 — Semantic memory** ✅ (CLI integration): `memory.ts` wraps the
  **MemPalace CLI** (not MCP, by decision). The harness keeps one shared palace
  under `harnessHome`, points every agent's `MEMPALACE_PALACE_PATH` at it, mines
  each agent's `memory.md` into its own wing (mtime-gated), and agents recall via
  `mempalace search` / `wake-up`. Detect-and-degrade: a no-op when `mempalace`
  isn't installed (markdown memory still works). Default model `minilm` (light,
  for low-RAM Macs); `embeddinggemma` is the multilingual opt-in. A `MemoryPanel`
  lets the human search the same palace.
  - *Still open*: reflection/summarization to bound `memory.md`; needs a live
    `mempalace` install to validate retrieval end-to-end.

---

## 8. Key risks & mitigations

| Risk | Mitigation |
| --- | --- |
| `index.lock` corruption | Single committer (main process), retry+backoff, stale-lock cleanup |
| Infinite Stop-hook loop | Guard on `stop_hook_active`; `hops` cap; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` |
| Two agents ping-ponging | Only request/query/propose obligate replies; hop cap → god escalates |
| Reprocessing messages | Per-agent `cursor.json`; processed messages move to `inbox/.done/` |
| `memory.md` unbounded growth | Phase 3 reflection/summarization |
| Modifying the user's repo with hooks | Write hooks to `<cwd>/.claude/settings.local.json` (gitignored convention) |

---

## 9. References

- Anthropic — *Building a multi-agent research system* (lead/subagent, plan-to-memory).
- LangGraph supervisor (structured routing + handoff registry + checkpoints).
- FIPA-ACL / KQML (speech acts).
- Stanford *Generative Agents* (memory stream, reflection, 2D world).
- Claude Code hooks reference (`Stop`, `PreToolUse`, `UserPromptSubmit`; `stop_hook_active`).
