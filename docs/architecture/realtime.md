# The Voice Plane — Realtime Michael, Free Flow, Groq

- **Coverage:** `src/main/realtime.ts`, `src/main/realtimeActions.ts`, `src/main/realtimeCompletionWatcher.ts`, `src/main/realtimeCost.ts`, `src/main/realtimeFloorWatcher.ts`, `src/renderer/src/realtime/`, `src/shared/realtimePricing.ts`, `src/main/freeflow.ts`, `src/renderer/src/freeflow/`, `src/main/groq.ts`
- **Depends on:** [Hive](hive.md), [Message Queue](message-queue.md)
- **Last Updated:** 2026-08-22

## Purpose

Two unrelated ways of speaking to the harness live here, plus one unused HTTP
client.

**Realtime Michael** is a full second orchestrator that happens to have a voice.
A live speech-to-speech WebRTC session with OpenAI `gpt-realtime-2.1` runs in the
RENDERER; the model is given the persona "Michael", a set of read tools over the
hive, and a set of action tools that can ping, dispatch, steer, hire, kill,
archive, edit the task board, edit schedules, and change app settings. Michael
acts on the same hive the typing orchestrator ("god") acts on, and every
committed write is attributed to `michael-voice` and announced to god.

**Free Flow** is dictation, not orchestration. Hold Option, talk, release; the
clip goes to Groq Whisper and the transcript is APPENDED to the composer draft of
the focused agent. It never sends. The two features share nothing but the
main-process microphone gate.

What this plane deliberately does not do: it does not hold API keys in the
renderer, it does not confirm destructive actions on screen (the confirm surface
is voice-only, by the operator's decision), and it does not speak money — the
spend cap still exists and still fires, silently.

## Terminology

| Term | Where it shows up | What it means |
|---|---|---|
| Michael | `MICHAEL_PERSONA`, `VOICE_ACTOR` | The voice orchestrator persona. Also the actor id `michael-voice` stamped on every write. |
| god | `Registry.godId` | The *typing* orchestrator. A separate agent that shares the floor with Michael. |
| Free Flow | `freeflowEnabled` | Push-to-talk dictation into a composer draft. Unrelated to Michael. |
| the floor | `RealtimeFloorWatcher` | The live set of agents, their PTY activity, and the task board. |
| snapshot | `realtimeSessionSummary()` | The one-shot floor picture injected at connect. |
| floor delta / floor update | `realtime:floorDelta` | A short coalesced sentence about what changed mid-call. |
| soft / destructive | `VERBS`, `SETTING_POLICY` | The two action tiers. Soft runs on the spot; destructive needs a spoken confirm. |
| echo-back | `proposeDestructive()` | Main reads the action back and stages it; nothing has happened yet. |
| distinct token | `confirmAccepted()` | What the user says must be `confirm` or the verb's own `confirmWord` — never a bare "yes". |
| completion | `RealtimeCompletion` | A dispatched unit of work observed finishing, which Michael announces unprompted. |

## Mechanism

### Where the OpenAI key lives, and what crosses IPC

The renderer never holds the real key. `src/main/realtime.ts` is the whole of the
main-side surface: the BYOK OpenAI key sits encrypted under `apikey:openai` in
the same write-only secret broker the CLI engines use, and main decrypts it only
inside `mintRealtimeToken()` to buy a short-lived ephemeral client secret from
OpenAI. Only that token and `{ model }` return over IPC.

Two channels, both registered by one `registerRealtimeIpc()` call:

- `realtime:hasKey` — presence only, no decryption. Gates the Talk button.
- `realtime:mintToken` — returns `{ ok, token, expiresAt, sessionConfig }`.

The mint tries the GA endpoint `/v1/realtime/client_secrets` first and falls back
to the legacy `/v1/realtime/sessions` on a **404**, normalizing both response
shapes (`{ value }` vs `{ client_secret: { value } }`).

> ⚠ **VERIFY:** `src/main/realtime.ts:33-35` says the GA/legacy mint fallback is
> unverified against a real account ("Live verification is pending the user's real
> key"). Has anyone since run a real mint? If the legacy branch is dead, the
> 404 fallback and the dual-shape normalizer can go. (raised 2026-08-22)

### How a voice session opens

`connect()` in `src/renderer/src/realtime/session.ts` is a single module-level
singleton — one voice loop at a time. The step order is in the Workflows table
below; two of those steps are constraints rather than sequence.

**`setMicGate(true)` must complete before `getUserMedia`.** It writes
`realtimeVoiceEnabled: true` to config, and the Electron permission handler in
`src/main/index.ts` reads that config SYNCHRONOUSLY — so the flag has to be
persisted by the time the mic opens, not merely requested.

**The transport is a custom `OpenAIRealtimeWebRTC`, not the bare `'webrtc'`
string.** The bare form lets the SDK own the mic stream and playback, which would
cost the device picker and the audio constraints. Constructing it directly lets
`connect()` hand in its own `mediaStream` and its own `audioElement`.

The state machine is `off → connecting → listening ⇄ responding`, with `working`
overriding everything while a tool call is in flight. `wire()` maps SDK events
onto it, and `agent_tool_start` / `agent_tool_end` mute and unmute the mic — so
every tool call, including `confirm_action`, commits with the mic closed.

### What Michael knows without calling a tool

The context strategy is **snapshot at connect plus append-only deltas**, and the
reason is prompt caching: the persona and tool definitions form a byte-stable
prefix that stays cached across turns and sessions, and a `session.update` on
instructions would bust it. So nothing is ever added to the instructions after
connect.

`realtimeSessionSummary()` (`realtime/tools.ts:691`) builds a compact per-agent
table — status, engine, context fill, breaker, unread count, in-flight and
blocked cards, plus a vacation line — and `injectSilent()` puts it in as the
FIRST conversation item using a raw `conversation.item.create` transport event
with no `response.create`. That is the silent path: the SDK's `sendMessage()`
always triggers a spoken response, so anything the model should absorb without
speaking goes one level down to the transport.

`RealtimeFloorWatcher` (`src/main/realtimeFloorWatcher.ts`) is the delta half. It
polls every `POLL_MS` (5s) and diffs three main-owned signals — registry roster,
task statuses, and PTY quiet/streaming flips derived from `lastOutputAt` against
`ACTIVE_WINDOW_MS` — then pushes one coalesced parenthetical line, debounced by
`MIN_PUSH_GAP_MS` (12s) and capped at `MAX_PUSH_CHARS`. Roster wording is
vacation-aware: a park flips `archived` and `vacation` in the same tick, so
`vacation` is tested first and a vacationer is never spoken as archived.

### What Michael can read

Thirteen read tools in `realtime/tools.ts`, each a thin wrapper over an IPC the
office-floor UI already uses, each returning **spoken prose** — no markdown, no
bullets, because a TTS voice reads the result verbatim. `get_floor_state` is the
one deliberate exception (see Gotchas). `spoken()` wraps every body so a read
failure degrades into a sentence instead of rejecting the model's tool call.

`get_config` is the one with a rule attached: it NEVER iterates `HarnessConfig`
(that object carries `groqApiKey`, Slack and webhook tokens, signing secrets). It
reads a hand-picked allowlist, field by field, through a defensive `obj()` so the
renderer's config mirror can lag main's without breaking.

`get_messages` reads message BODIES. All redaction is main-side in
`hive.voiceMessages()` / `redactSecrets()`; the renderer holds zero redaction
policy. The full privacy boundary is written up in
`src/renderer/src/realtime/VOICE-MESSAGE-ACCESS.md`, which is part of this slice.

### What Michael can do, and what has to be said out loud

`src/main/realtimeActions.ts` is the entire safety surface, and it is entirely in
MAIN. The renderer tools in `realtime/actions.ts` are deliberately policy-free:
each one forwards `{ verb, ...args }` through `window.cth.realtimeAction` and
speaks back whatever `res.spoken` says. The renderer is the untrusted side.

`VERBS` assigns every verb a tier and a confirm word:

- **Soft** (runs immediately): `ping`, `dispatch`, `steer`, `create_task`,
  `assign_task`, `update_task`, `delete_task`, `resume`, `auto_delivery`,
  `gate_tool`, `unarchive`.
- **Destructive** (echo-back then confirm): `spawn`, `kill`, `pause`, `halt`,
  `archive`, `clear_context`, `edit_schedule`, `create_schedule`,
  `update_setting`.

A destructive verb calls `proposeDestructive()`, which resolves the target, runs
the hard allowlist, builds a `commit` closure, and stores it in a single-slot
`pending` with a 120s TTL (`PENDING_TTL_MS`). Nothing has happened yet. The model
then calls `confirm_action` with the user's actual words, and `confirmAccepted()`
gates the commit:

``` typescript
if (BARE_AFFIRMATIONS.has(p)) return false;          // "yes", "ok", "sure", "do it"…
if (/\bconfirm(ed|s)?\b/.test(p)) return true;
if (new RegExp(`\\b${escapeRegExp(confirmWord)}\\b`).test(p)) return true;
```

The pending is consumed *before* the commit runs, so a failing action cannot be
re-confirmed. Because the confirming tool call itself mutes the mic, the commit
instant is always mic-idle — ambient speech cannot inject consent.

`update_setting` has a second gate on top: `SETTING_POLICY` is the only path from
speech to config. Every key carries its own tier and typed validation (`min` /
`max` / `values`), cosmetic keys apply immediately, behavior-changing keys echo
old→new behind a confirm, and anything not in the table — `harnessHome`, every
secret-bearing key, provider base URLs, integrations — is refused outright. The
raw `config:update` IPC is never reachable from speech.

### What is forbidden even with a valid confirm

Two rules reject before a pending is ever created:

- **Mass targets.** `isMassTarget()` catches "all", "every", "everyone", "the
  team", "fleet", "*", and any comma- or "and"-joined list.
- **The god orchestrator.** `kill` / `pause` / `halt` / `archive` on god are
  voice-forbidden and must be done in the UI. `clear_context` on god is the one
  exception — it is allowed behind the normal confirm, because a cleared session
  resumes and "clear Michael's context" is a real operator need.

### Which agent or card a spoken name resolves to

`resolveAgent()` walks exact id → the `god`/`michael`/`the god` alias → exact
name preferring non-archived → single partial match, and returns a spoken
disambiguation error rather than guessing when several match.

Task cards use a scored matcher, because speech loses punctuation.
`normMatch()` strips every non-alphanumeric (so spoken "message visibility"
matches stored "message-visibility"), `scoreCard()` scores exact → truncation →
full token coverage → substring → prefix coverage, and `findCard()` returns
`ambiguous` when the top two are within `AMBIGUOUS_MARGIN` (0.08) so the caller
asks which one instead of mutating the wrong card. Assign, update and delete are
immediate writes, which is exactly why guessing was unacceptable.

All four task executors mutate inside `deps.hiveWithLedgerLock(...)` — read,
mutate and write under `tasks.json.lock`, never a stale pre-read. A contended
lock returns `false`, which the executors report as "the task board was busy",
not as done.

### How a finished dispatch reaches the user

`src/main/realtimeCompletionWatcher.ts` is deliberately electron-free and
reader-injected: it imports no session, no IPC, no filesystem. `detectCompletion()`
is a pure predicate over `{ tasks, inbox }` and fires on either signal:

- **card-done** — the dispatched card's status is `done`, or
- **inbox-reply** — a non-system message from the assignee that post-dates the
  dispatch, preferring an explicit `in_reply_to` match.

The watcher is a singleton (`initCompletionWatcher` / `getCompletionWatcher`) so
`track()` and `onCompletion()` cannot land on different objects. `route()` splits
on `sessionLive`: live sessions get an emit that becomes a spoken notification
plus a `CompletionToast`; a closed session queues (capped at `MAX_QUEUED` = 50)
and fires an OS notification, and the queue is drained into the next connect's
warm-start as "Completions since you last spoke". Memory is bounded by
`MAX_PENDING` (200) and a 24h `PENDING_TTL_MS`.

Text arriving on this path is untrusted — `objective` comes from a task somebody
else may have written. It is neutralized twice: `neutralizeForVoice()` in the
watcher and `sanitizeForVoice()` at the session injection seam, both stripping
prompt-injection lead-ins ("ignore previous…", "you are now…", role markers) and
capping length. Neither is the security boundary; main independently gates every
destructive operation regardless of what the model was told.

### What stops a runaway session

A 10s tick (`COST_GUARD_TICK_MS`) started at connect checks two conditions:

- `getRealtimeCostSnapshot().overCap` → `disconnect('cost-cap')`
- `isRealtimeIdle(idleMs, now)` → `disconnect('idle')`

`idleMs` comes from `config.realtimeIdleDisconnectMs`, defaulting to
`DEFAULT_IDLE_DISCONNECT_MS` (180_000). `0` disables the idle check, which is why
the cost cap is described as the guard that stays.

Pricing lives in `src/shared/realtimePricing.ts` so main and renderer cannot
disagree. `computeRealtimeUsd()` prices EVERY token at the audio rate
(`REALTIME_AUDIO_INPUT_PER_MTOK` = 32, `REALTIME_AUDIO_OUTPUT_PER_MTOK` = 64) —
a deliberate conservative upper bound, since for a guard warning early beats
under-counting, and it uses only the authoritative audio numbers instead of
guessing text and cache rates. `costStore.ts` accumulates deltas fed from the raw
`response.done` transport event.

### How push-to-talk dictation works

`freeflow/recorder.ts` is one shared capture engine for both entry points — the
composer button and the hold gesture — so only one recording can run at a time.
The capture path is in the Workflows table below; the two hard parts are not
visible in it.

The first is `freeflow/holdOption.ts`, because in a terminal Option IS Meta.
Four rules disambiguate: a solo-hold threshold of `ARM_MS` (320ms) before
recording arms; instant disqualification the moment any other key joins while
Option is down; `e.repeat` ignored so a held Option cannot re-arm; and
capture-phase listeners on `window` so the gesture still fires while xterm holds
focus. `preventDefault` is never called, so a real Alt combo reaches the terminal
untouched.

The second is `wantActive`, which exists because hold-to-talk makes the start/stop
race real: a user can release Option before `getUserMedia` resolves, so the open
path checks the flag and discards rather than stranding a recording.

## Workflows

### Opening a voice session

| Step | Action | Location |
|---|---|---|
| 1 | User clicks Talk | `components/RealtimeMichaelToggle.tsx` (outside this slice) |
| 2 | Mint ephemeral secret | `mintRealtimeToken()`, `main/realtime.ts` |
| 3 | Persist `realtimeVoiceEnabled: true`, await it | `setMicGate()`, `realtime/session.ts` |
| 4 | Open mic, build transport, connect WebRTC | `connect()`, `realtime/session.ts` |
| 5 | Inject the floor snapshot silently | `injectSilent()` + `realtimeSessionSummary()` |
| 6 | Drain queued completions into warm-start | `realtime:drainCompletions` → watcher |
| 7 | Flip watchers live, subscribe to pushes | `realtime:setSessionLive` |
| 8 | Start the cost/idle guard, speak a greeting | `costGuardTimer`, `GREETINGS` |

### A destructive verb, end to end

| Step | Action | Location |
|---|---|---|
| 1 | Model calls e.g. `kill_agent` | `realtime/actions.ts` |
| 2 | Forwarded as `{ verb: 'kill', … }` | `realtime:action` IPC |
| 3 | Mass-target and god checks | `isMassTarget()`, `r.isGod`, `proposeDestructive()` |
| 4 | Resolve target, build commit, stage `pending` | `resolveAgent()`, `buildKill()` |
| 5 | Echo-back returned as `spoken`, nothing done | `ActionResult.needsConfirm` |
| 6 | User speaks; model calls `confirm_action` with their words | `realtime:action:confirm` |
| 7 | Distinct-token check; bare "yes" rejected | `confirmAccepted()` |
| 8 | Pending consumed, commit runs, god notified | `attribute()` → `hiveSend` to god |

### Free Flow hold-Option capture

| Step | Action | Location |
|---|---|---|
| 1 | Option down alone, no other key | `onKeyDown`, `freeflow/holdOption.ts` |
| 2 | 320ms elapse without disqualification → arm | `ARM_MS` timer |
| 3 | Capture starts for the fullscreen or selected agent | `freeflowRecorder.start()` |
| 4 | Option released → stop | `onKeyUp` → `recorder.stop()` |
| 5 | Blob to main, Groq Whisper, transcript back | `freeflow:transcribe`, `main/freeflow.ts` |
| 6 | Appended to the agent's composer draft | `deliverTranscript()` → `store.setDraft` |

## Integration points

**Hive ledger and registry** ([hive.md](hive.md)). Everything the action spine
touches arrives through injected deps, so this module never imports `index.ts`:
`hive.send`, `hive.withLedgerLock`, `hive.writeTasks`, `hive.registry`,
`hive.appendLog`, `hive.inbox`. Redaction for `get_messages` is
`redactSecrets()` on the hive side; the voice layer receives already-clean text.

**PTY spine.** Two touchpoints only. `ptyManager.list()` supplies `lastOutputAt`
to the floor watcher's activity diff, and `ptyManager.kill()` plus `teardownPty()`
back the `kill` verb. The control layer supplies `control.pause`, `control.steer`,
`control.halt`, `control.resume`, `control.snapshot`, `control.pauseAutoDelivery`
and `control.gateTool`.

**Message queue** ([message-queue.md](message-queue.md)). `clear_context` does not
type into a PTY. Main resolves the provider's own verb via
`clearCommandForProvider()` (it is `/new` for some providers, and Crush/Copilot
have none, in which case Michael says so) and pushes it over `realtime:enqueue`
so delivery inherits every existing gate: idle-only, boot grace, draft and picker
safety, auto-delivery pause.

**Config and the mic gate.** `readConfig().freeflowEnabled || realtimeVoiceEnabled`
is the sole condition in the Electron `setPermissionRequestHandler` /
`setPermissionCheckHandler` for media. The gate deliberately does NOT check for an
OpenAI key, because that key is shared with the CLI engines and a CLI-only user
must not get the mic opened.

**Spawn.** `spawn` maps a spoken provider name through `PROVIDER_COMMAND` into a
`RealtimeSpawnSpec`, which `index.ts` adapts to `spawnAgentCore`'s options.

**Renderer mounts** (all outside this slice): `RealtimeMichaelToggle` drives
`useRealtimeMichael()`, `CostHud compact` sits in `AgentCard` and
`FullscreenTerminal`, the full `CostHud` and `RealtimeDevicePicker` sit in
`SettingsModal`, and `CompletionToast` is mounted once in `App`.

## Gotchas

- **`groqChat()` has no callers.** `src/main/groq.ts` is a complete, hardened Groq
  chat client — secret-shape egress blocking, untrusted-data wrapping, SSE
  streaming — and nothing in the repository imports it. The string "VDE" appears
  in that file and nowhere else in `src/`. Free Flow uses `src/main/freeflow.ts`,
  a different module against a different endpoint.

> ✔ **Resolved (2026-08-22, Stefan):** still planned — `groq.ts` stays and waits
> for its caller. (Committed for "VDE AI assist" in 11bdf12, 2026-06-19.)

- **The persona promises activity the snapshot no longer carries.**
  `MICHAEL_PERSONA` tells Michael to "glance at recent activity (your
  `get_activity` tool, and the snapshot you were given)" — that phrasing dates
  from rt-7 (85c4684), where `realtimeSessionSummary()` did pull the recent hive
  log. The v0.3.4 rewrite replaced it with the per-agent table and no longer
  fetches the log at all. The tool still works; only the snapshot half is stale.

> ⚠ **VERIFY:** Was dropping the recent-activity lines from
> `realtimeSessionSummary()` in v0.3.4 (ef46d32) deliberate, or lost in the
> rewrite? The commit body does not mention it, and the persona still advertises
> it. (raised 2026-08-22)

- **A voice dispatch creates no task card.** `execDispatch()` sends a 4-part work
  order to the agent's inbox and calls `trackDispatch()` with the message id as
  the correlation id — but no `taskId`. So `detectCompletion()`'s card-done branch
  can never fire for a plain voice dispatch; only the inbox-reply branch can.
  `wait_for(taskId)` on an untracked card uses `syntheticPending()`, which is
  card-done only, so the two paths are exact complements.

- **The cost cap is off by default.** `costStore` starts with `capUsd: null`, and
  the only thing that sets it is the user typing a number into the full `CostHud`
  in Settings. With no cap, `overCap` is permanently false and the idle timeout is
  the only guard — and `realtimeIdleDisconnectMs: 0` turns that off too.

> ✔ **Resolved (2026-08-22, Stefan):** off by design — the cap is opt-in; no
> default value is owed. (`session.ts:139-141` still calls the guard the thing
> that "curbs runaway audio spend"; that only holds once the user sets a cap.)

- **The confirm check matches a substring, so a negation passes.**
  `confirmAccepted('don\'t kill Jim', 'kill')` returns true — the regex only asks
  whether the verb word appears as a whole word. Bare affirmations are screened
  exactly (`BARE_AFFIRMATIONS.has(p)` is a full-string match, so "yes" is rejected
  but "yes, kill him" is accepted, which is the intent), but no negation screening
  exists.

> ✔ **Resolved (2026-08-22, Stefan):** never considered — a real gap in
> `confirmAccepted()` (`realtimeActions.ts:314`). Fix owed: D1 in
> `docs/goals/2026-08-22-intent-interview-decisions.md`.

- **The mic gate is disk state, not session state.** `setMicGate()` opens the
  Electron permission gate by *persisting* `realtimeVoiceEnabled: true`, because
  the permission handler reads config synchronously and has nothing else to read.
  The consequence is that a hard crash or reload mid-session skips
  `disconnect()`'s teardown (`session.ts:527`) and leaves the flag stuck true on
  disk. `index.ts:7623`, inside `app.whenReady()`, force-closes it at STARTUP for
  exactly that case — so the gate never boots pre-open, and a real session
  re-opens it via `setMicGate(true)`. macOS TCC is a second gate regardless.

- **One pending slot, cleared by any new proposal.** `runAction()` sets `pending =
  null` on every incoming verb before dispatching. Proposing a second destructive
  action silently discards the first — and a soft verb spoken between the
  echo-back and the confirm does the same, so a later `confirm_action` answers
  "There's nothing waiting to confirm."

- **"Michael" resolves to god.** `resolveAgent()` aliases `god`, `michael` and
  `the god` to `reg.godId`. So "kill Michael" resolves to the god orchestrator and
  is refused by the god allowlist — the voice cannot address itself as a target.

- **The card matcher exists twice on purpose.** `test/realtime-findcard.test.cjs`
  holds a character-identical copy of `normMatch` / `scoreCard` / `findCard`
  because the originals are module-local TypeScript and cannot be required from a
  `.cjs` test. The same algorithm is also validated by `node bin/find-task.cjs
  --selftest` in the hive repo, outside this checkout. Changing one without the
  other silently unpins the behaviour.

- **`isSystemSender()` is unreachable for real dispatches.** In
  `detectCompletion()` it is checked *after* `m.from !== pending.targetAgentId`
  has already continued, so a breaker or scheduler message can only reach it if
  the dispatch target were itself named `breaker`/`scheduler`/`system`. It is
  defensive, not active.

- **One read tool breaks the spoken-prose rule on purpose.** Every other tool
  returns speakable text only; `get_floor_state` returns a one-line summary
  followed by `DATA: <JSON>` (`tools.ts:662-665`). The comment there sources it to
  the Realtime prompting guidance — precise fields the model can quote verbatim,
  with the spoken line kept separate — so a "what is everyone doing" answer can
  cite real numbers instead of paraphrasing them.

- **Silent injection needs the transport, not the SDK.** `sendMessage()` in this
  SDK version always triggers a response. The snapshot and floor deltas go in via
  a raw `conversation.item.create` transport event so the model absorbs them
  without speaking; completions deliberately use `sendMessage()` because Michael
  *should* speak those.

- **The compact HUD shows tokens, the Settings HUD shows dollars.** De-monetizing
  (12cac15, 1c41fbe) removed money from the agent chrome, the persona, and every
  read tool — `get_cost` reports tokens and `get_config` reports a token cap. The
  full `CostHud` in Settings still shows USD, because the cap the user sets is a
  USD figure.

- **Free Flow never sends.** `deliverTranscript()` appends the transcript to the
  draft with a separating space; the user reviews and presses Send. Nothing pins
  this — no test and no constraint would fail if someone made it auto-send.

- **The floor watcher forgets on every session flip.** `setSessionLive()` clears
  the buffer and resets `primed`, so the first tick after a connect diffs against
  NOW rather than against pre-connect state. Old buffered deltas would duplicate
  what the fresh snapshot already said.

## Key files

| File | What lives in it |
|---|---|
| `src/main/realtime.ts` | Ephemeral-token mint, key presence check, the two mint IPC channels. Never returns the real key. |
| `src/main/realtimeActions.ts` | The entire safety spine: `VERBS` tiering, `SETTING_POLICY`, `resolveAgent`, `findCard`/`scoreCard`, the pending slot, `confirmAccepted`, all executors and commit builders, `michael-voice` attribution and the god cross-notify. |
| `src/main/realtimeCompletionWatcher.ts` | Electron-free completion engine: `detectCompletion()` predicate, the polling watcher, live-emit vs closed-session queue, `waitFor`, the shared singleton. |
| `src/main/realtimeFloorWatcher.ts` | 5s floor diff (roster, tasks, PTY activity) into coalesced debounced delta sentences. |
| `src/main/realtimeCost.ts` | Eleven lines. Re-exports the shared pricing helpers so main need not reach into `../shared`. |
| `src/shared/realtimePricing.ts` | `REALTIME_MODEL`, the audio token rates, `normalizeRealtimeUsage`, `computeRealtimeUsd`, `formatUsd`. |
| `src/renderer/src/realtime/session.ts` | The voice loop: persona, greetings, connect/disconnect, the state machine, silent injection, sanitization, cost guard, device selection, `useRealtimeMichael()`. |
| `src/renderer/src/realtime/tools.ts` | The thirteen read tools and `realtimeSessionSummary()`, plus the spoken-prose formatters. |
| `src/renderer/src/realtime/actions.ts` | The write tools. Policy-free forwarders over `realtime:action`, plus `wait_for`, `confirm_action`, `cancel_action`. |
| `src/renderer/src/realtime/roster.ts` | Pure, import-free vacation-aware roster wording, kept separate so node tests can pin the spoken strings without loading the realtime SDK. |
| `src/renderer/src/realtime/costStore.ts` | Live session meter, spend cap, `isRealtimeIdle()`. |
| `src/renderer/src/realtime/CostHud.tsx` | Compact token chip and the full cap control. |
| `src/renderer/src/realtime/CompletionToast.tsx` | Self-subscribing bottom-right toast stack for completions. |
| `src/renderer/src/realtime/DevicePicker.tsx` | Mic and speaker dropdowns; mic applies next connect, speaker applies live via `setSinkId`. |
| `src/renderer/src/realtime/VOICE-MESSAGE-ACCESS.md` | The `get_activity` / `get_messages` privacy boundary and redaction limits. |
| `src/main/freeflow.ts` | Groq Whisper transcription upload. Electron-free, key never logged. |
| `src/renderer/src/freeflow/recorder.ts` | Shared capture engine, the `wantActive` race guard, draft delivery. |
| `src/renderer/src/freeflow/holdOption.ts` | Hold-Option-to-talk gesture and the terminal Alt/Meta disambiguation. |
| `src/main/groq.ts` | Groq chat completion client. Currently uncalled — see Gotchas. |

Behaviour is pinned by `test/realtime-findcard.test.cjs` (the card matcher),
`test/realtime-roster-words.test.cjs` (vacation wording), and
`test/vacation-floor-watcher.test.cjs` (the floor-delta diff, driving the real
`tick()` through injected deps).
