# The App Spine — Terminal Plane, Event Plane, IPC and Renderer State

- **Coverage:** `src/main/pty.ts`, `src/main/hooks.ts`, `src/main/index.ts`, `src/preload/`, `src/renderer/src/store/`, `src/renderer/src/hooks/`, `src/renderer/src/App.tsx`
- **Depends on:** [Hive](hive.md), [Message queue](message-queue.md), [Telemetry](telemetry.md)
- **Last Updated:** 2026-08-22

## Purpose

The spine is everything between a real CLI process on your machine and a moving
avatar on the office floor. It owns two independent data paths from the same
agent process, the IPC surface that carries both into the renderer, and the
renderer state they both write to.

- **Terminal plane** — `PtyManager` (`src/main/pty.ts:170`) spawns and owns a
  node-pty child per agent, and streams its raw bytes to an xterm.js view.
  Byte-for-byte authentic; it knows nothing about what the agent is doing.
- **Event plane** — each agent's CLI is launched with a `--settings` file that
  points its lifecycle hooks at a shim; the shim posts JSON to a Unix domain
  socket that `HookServer` (`src/main/hooks.ts:129`) owns. Structured; it knows
  exactly which tool is running and nothing about the pixels.

Both terminate in the same zustand store (`useStore`,
`src/renderer/src/store/store.ts:747`), which is what the Pixi scene and every
panel render from.

The spine deliberately does **not** own: the hive's file protocol, mail routing
or the god agent (`src/main/hive.ts`, `src/renderer/src/hooks/useHive.ts` — see
[hive.md](hive.md)); the queued-message drain loop and auto-park
(`src/main/autoPark.ts` — see [message-queue.md](message-queue.md)); the OTLP
collector (`src/renderer/src/hooks/useTelemetry.ts` — see
[telemetry.md](telemetry.md)); or anything about how the office is drawn (see
[design.md](design.md)).

## Terminology

| Term | What it means here |
|---|---|
| **Plane** | One of the two independent transports from an agent process to the renderer. Neither is a fallback for the other. |
| **PTY id** | The stable key for a terminal session (`pty-<agentId>` by convention). Survives a restart of the underlying process — a kill+respawn reuses it. |
| **Agent id** | The hive-registry identity. Mapped to its PTY id through `ptyToAgent` (`src/main/index.ts`); one agent has at most one live PTY. |
| **Shim** | `<hiveRoot>/bin/cth-hook.cjs`, written from the `HOOK_SHIM` template in `src/main/hive.ts:8790`. Reads a hook payload on stdin, writes it to `HIVE_SOCK`, prints the server's answer back to the CLI. |
| **Station** | A named spot on the floor an avatar walks to: `shelf`, `terminal`, `web`, `board`, `mailbox`, `mcp`, `desk` (`StationKind`, `store.ts:25`). |
| **Owner** | The `WebContents` that spawned a PTY. Its output routes only there, never broadcast (multi-window floors). |
| **Volatile field** | An `Agent` field recomputed from the live PTY on every reload, so it is never written to disk (`VOLATILE_AGENT_FIELDS`, `store.ts:525`). |
| **God** | The orchestrator agent ("Michael"). Several spine paths branch on `isGod` — only god escalates to the human. |

## Inception (2026-05-31): decisions and their fates

This file was originally the product's design proposal, written before any code
existed. Almost every mechanism below contradicts it. The proposal is kept here
in summary because the contradictions are the interesting part: they say what
was actually learned.

**The execution-model decision was inverted on day one.** The proposal's §12
read: *"Execution model: attach to existing terminal sessions (tmux), do not
spawn or own the `claude` process"*, and §8 justified it with *"Process control:
shelling out to tmux — No node-pty needed since we attach"*. The very first
commit (`dc7f1ce`, 2026-05-31) already declares `"node-pty": "^1.0.0"` in
`package.json` and ships a `src/main/pty.ts` whose first line is
`import * as pty from 'node-pty'`. There is no tmux code anywhere in the repo.
The app spawns and owns every agent process, which is why PTY lifecycle,
teardown, worktree cleanup and process-group killing are the spine's largest
responsibility rather than tmux's.

> ⚠ **INTENT UNVERIFIED:** Why was the tmux-attach model abandoned between the
> proposal and the first commit, on the same day? No commit message, test or
> comment records the reversal. (raised 2026-08-22)

The only surviving trace is `Agent.tmuxTarget` (`store.ts:56`), a required
`string` field. Every one of its three writers sets it to `''`
(`useHive.ts:397`, `useHive.ts:1238`, `AddAgentModal.tsx:532`) and nothing reads
it.

> ⚠ **INTENT UNVERIFIED:** Why does `tmuxTarget` remain a required field on
> `Agent` when it is written as `''` by all three call sites and read by none?
> (raised 2026-08-22)

**The other §12 decisions held.** The avatar metaphor is still active-Sims
(agents walk to stations). The tech stack is still Electron + React + Pixi.js +
xterm.js, and SQLite is still present — but only as a shadow of what §9
specified. The proposed schema had four tables (`agents`, `events`, `commands`,
`layout`); `src/main/db.ts` creates exactly two, `kv` and `command_history`.
`kv` is a scalar bag holding three keys today — the main window's bounds, the
context-trigger last-run map, and the held webhook tokens. (Its own module
docstring still says *"Today: the main window's bounds"*, which is stale.)
Agents, events and floor layout never became database rows: agents live in the
hive registry on disk plus
the renderer roster mirror, events are transient IPC, and layout is computed by
the scene. The last §12 line — *"MVP scope: N independent agents in a shared
workspace; no inter-agent coordination"* — is inverted; the hive is now the
largest subsystem in the app.

**The MVP NOT-list (§1) is now three-quarters wrong.**

| Proposal said it would not be | What happened |
|---|---|
| *"Not an agent-to-agent message bus… (Deferred to v2.)"* | Built. Hive mail with outbox→inbox routing and a per-agent queue — see [hive.md](hive.md), [message-queue.md](message-queue.md). |
| *"Not a remote dashboard. Local sessions only. No web access, no auth."* | Inverted. `src/main/webhook.ts`, `src/main/slack.ts` and `src/main/telegram.ts` accept inbound work, with `tunnelmole` opening a public URL for the Slack and webhook paths. |
| *"Not a code editor. We show terminal output, not source files."* | Inverted. `FullscreenFileEditor.tsx` and `src/renderer/src/ide/IdePanel.tsx` ship Monaco and CodeMirror. |
| *"Not a replacement for the `claude` CLI. The CLI is the runtime; this app is a viewer/controller."* | Still true, and still the framing in `AGENTS.md`. |

**The "/goal" question (§6) answered itself twice.** The proposal opened with a
question — *"You mentioned `/goal` — there's no built-in slash command by that
name in Claude Code as of early 2026"* — and spec'd a fallback: a per-avatar
`goal` string the app would prepend to each prompt or inject via a
`UserPromptSubmit` hook. Since then `/goal` became a real Claude Code slash
command, and the app documents it in its own cheat sheet
(`src/shared/claudeCommands.ts:149`: *"Set a goal condition; Claude keeps
working across turns until it is met."*). The app-side field also exists —
`Agent.goal` (`store.ts:58`), edited in the Add-Agent modal's Briefing tab, size-
capped at 4000 characters by the hire-manifest validator
(`src/shared/hire.ts:202`), persisted with the roster — but the injection half
was never built. Nothing in `src/main/`, `src/preload/` or `src/renderer/`
reads the value back out to prepend it or hand it to a hook.

> ⚠ **INTENT UNVERIFIED:** `Agent.goal` is authored, validated, persisted and
> shown, but no code path delivers it to the agent. Is the field waiting on the
> injection half, or superseded by the CLI's own `/goal` and the registry role?
> (raised 2026-08-22)

**One risk from §10 was called correctly and is still the design rule.** The
proposal listed *"The Sims metaphor lands as gimmicky"* as a real risk, with the
mitigation: *"make the metaphor informational — every animation should actually
tell you something you didn't know. If walking-to-the-shelf doesn't convey 'is
reading a file' faster than a text label, we built a toy."* That mitigation is
why the event plane exists at all. Every avatar movement in the current code is
driven by a real hook event carrying a real tool name (`stationForTool`,
`useHive.ts:201`), not by a timer or an animation curve. The proposal's other
sentence for the same idea — *"This is the demo. If this is fun to watch, the
product works"* — remains the product bet.

The proposal's milestones (M0–M3) and its open-questions list are not carried
forward; every question in them has since been answered by shipped code.

## Mechanism

### Why two planes and not one

The reasoning is unchanged from the proposal's §2 and is worth restating,
because both planes look redundant until you try to delete one:

> *"Hooks alone don't give you the raw stream the user expects to see. The [byte
> stream] alone doesn't tell you which tool is running without fragile output
> parsing. Together: the canvas is event-driven; the terminal view is
> byte-for-byte authentic."*

The repo has since paid for the second half of that sentence twice. The
fragile-parsing path was built anyway as a stopgap (`usePtyParser`) and is now
restricted to Claude sessions only, because its patterns match no other CLI's
TUI (below). And the parser cannot see anything the TUI does not print, while
the hook payload carries `tool_name`, `tool_input`, `session_id` and
`transcript_path` for free.

The planes are also independent in failure. A wedged socket leaves the terminal
readable and typeable; a dead PTY still leaves the last hook-derived status on
the card. `AGENTS.md:51`–`54` states the same split as the one-screen summary of
the architecture.

### How an agent process comes to exist

Every spawn — the Add-Agent modal, "restore team", a god-written spawn request,
the auto-relaunch after a first-time CLI install — funnels through
`spawnAgentCore` (`src/main/index.ts:3439`). The `pty:spawn` IPC handler
(`index.ts:3418`) does nothing but validate the three required string fields and
record the calling window as the PTY's owner before delegating.

Being the single door is what makes the gates enforceable. `spawnAgentCore`
refuses, in order, before any process starts:

- a **retired** agent id (`hive.isRetired`) — "fired stays fired" survives a
  localStorage wipe because the registry, not the renderer, is the authority;
- a spawn that would exceed the **floor cap** (`floorMaxAgents`, default 16;
  god is excluded and a respawn does not count against itself);
- a non-isolated spawn into a checkout another live agent already occupies
  (**one agent per directory**), resolved through `physicalCheckout()` so a
  subdirectory or symlink alias of a checkout counts as the same seat.

It is also the single point where a user-typed `~/dev/foo` becomes absolute.
`expandTilde()` runs here, on both `opts.cwd` and `opts.hive.cwd`, so the
registry only ever stores an absolute path, and the resolved value is echoed
back in the result so the renderer's agent record matches. Before that fix
(`913b8ad`) every `existsSync` downstream failed and the agent simply never
spawned: only a shell expands `~`, Node treats it as a directory literal.

After the gates, `spawnAgentCore` provisions the git worktree if isolation is
on, writes the hive identity, resolves model and resume flags, injects BYOK keys
for the non-Claude engines, and finally calls `ptyManager.spawn(opts, owner)`
(`index.ts:4039`), then `syncKeepAwake()` to arm the power-save blocker while at
least one PTY is alive.

### What a spawned child inherits, and what is scrubbed from it

`buildSpawnEnv` (`pty.ts:40`) is exported and pure so it can be tested directly.
It merges four things over the inherited environment, each for a reason the code
cannot infer:

```typescript
const env = {
  ...inherited,
  PATH: path,                    // user shell PATH + hive runtime fallback
  TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1',
  ...(process.platform === 'win32' ? {} : {
    LANG: inherited.LANG ?? 'en_US.UTF-8',
    LC_CTYPE: inherited.LC_ALL ?? inherited.LC_CTYPE ?? inherited.LANG ?? 'en_US.UTF-8',
  }),
  ...(extra ?? {}),              // AGENT_ID, HIVE_ROOT, HIVE_SOCK, …
};
if (extra?.AGENT_ID) { /* scrub CLAUDE_* child markers, force persistence */ }
```

The locale line sets `LC_CTYPE` and never `LC_ALL`, deliberately: a
GUI-launched Electron app inherits no locale at all, so without it every child
runs in the C locale and paints mojibake into a grid that is genuinely UTF-8
(xterm.js with the Unicode11 addon). `LC_ALL` would also override collation and
date formatting for every user who never exported a locale.

The scrub matters more than it looks. When the harness is started from inside a
Claude session — god's own detached restart script does exactly this — every
child inherits `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID`, `CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_ENTRYPOINT`. The CLI then treats each
agent pane as a nested child session and **disables transcript saving fleet-wide**,
which breaks `--resume` for everyone. Panes carrying `AGENT_ID` get the five
markers deleted and `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` set as belt and
braces; non-agent panes inherit untouched. Pinned by
`test/pane-env-persistence.test.cjs`.

`withHiveRuntimeFallback` (`pty.ts:22`) appends `<HIVE_ROOT>/bin/runtime` — a
directory holding a shim literally named `node` — to the child's PATH. It is
**appended, never prepended**, so a user who has their own node keeps their own
version and the harness is strictly the fallback; prepending would silently swap
the node version under the user's own projects for Electron's. Pinned by
`test/hive-runtime-path.test.cjs`.

### How a bare command becomes an executable path

`resolveCommand` (`pty.ts:268`) exists because Electron's spawn environment on
macOS has none of the user's interactive-shell PATH — nvm, asdf, volta and brew
installs are all invisible. On POSIX it runs `which <command>` through a fenced
login-shell capture (`captureFromLoginShell`, so rc-file chatter cannot poison
the answer), then falls back to a list of common install locations. On Windows
it uses `where`, skips the extensionless shim `where` usually returns first, and
takes the first PATHEXT-eligible hit.

The result carries `found` as well as `path`. When nothing is located, `path`
falls back to the bare command (so a spawn ENOENTs honestly) and `found` is
false — the signal the missing-CLI auto-install path keys on through
`isCommandAvailable()`.

The cache (`resolvedCommands`, `pty.ts:260`) is asymmetric on purpose. Each miss
costs a full interactive-shell launch, which sources the user's whole zshrc —
nvm/asdf init routinely takes about a second, synchronously, on the main
process, freezing every window; every agent spawn used to pay it twice, once for
the pre-check and once for the spawn. **Positive** results are cached but
re-validated with `existsSync` on every read, so an uninstall between spawns
re-probes instead of handing out a dead path. **Negative** results are never
cached, because the auto-install path must see a just-installed binary on its
re-check.

On Windows, `.cmd`/`.bat` files and extensionless shims cannot be executed by
`CreateProcess` at all (error 193), so they are routed through `cmd.exe`.
`buildCmdCommandLine` (`pty.ts:152`) builds one pre-escaped string —
`/d /s /c "<quoted target> <quoted args>"` — and hands it to node-pty as a
**string**, not an array: node-pty re-escapes array arguments but passes a string
through verbatim, so the quoting here is never double-wrapped. Tokens are quoted
on whitespace *and* on the cmd metacharacters `& | ^ < > ( ) % !`, so a token
cannot chain a second command.

### How agent output reaches the terminal view

`PtyManager.spawn` (`pty.ts:353`) captures the `PtySession` object it just
created, then registers callbacks that check that identity before doing
anything:

```typescript
this.sessions.set(opts.id, session);
proc.onData((data) => {
  if (this.sessions.get(opts.id) !== session) return;   // id was reclaimed
  session.hasOutput = true;
  session.lastOutputAt = Date.now();
  session.outputTail = (session.outputTail + data).slice(-OUTPUT_TAIL_MAX);
  session.outputTap?.(data);
  this.safeSend(`pty:data:${opts.id}`, data, session.owner);
});
```

The identity guard is not defensive noise. Changing an agent's model, or
"Restart & Continue", does `kill()` then `spawn()` under the **same** PTY id.
The old process's kill is asynchronous, so its `onData` and `onExit` can fire
after the replacement session is already in the map. Without the guard the dying
process would spray its final bytes into the new agent's fresh TUI frame
(scattered, overlapping text), and its exit would delete the replacement session
and emit a false `pty:exit`, killing input to the agent that just started
(`352e4aa`). `terminalPool.ts` relies on this being handled in main rather than
re-checking renderer-side.

Each chunk goes out on a **per-id channel**, `pty:data:<id>`, addressed to that
session's `owner` window — never broadcast, so one floor's stream cannot leak
into another. `safeSend` (`pty.ts:223`) drops the send when the target
`WebContents` is gone: during app quit, killing a PTY fires `onExit`
asynchronously, and by then `app.quit()` may have destroyed the window, where
`.send()` throws "Object has been destroyed" and surfaces as the main-process
crash dialog.

`outputTail` is a bounded ring (48 KB, `OUTPUT_TAIL_MAX` at `pty.ts:168`) whose
only consumers are the kitty detach bridge's replay and tap
(`index.ts:291`–`293`): a detached window opens with context instead of a blank
grid. `lastOutputAt` and its derived `idleFor(id)` are the idle handshake — the
automation paths never type into a PTY that produced output in the last few
seconds, because that means the TUI is mid-stream. `hasOutput` is the weaker
"has this child painted at least one frame yet" gate, so a startup prompt cannot
outrun the renderer's subscription.

On the renderer side the subscription is made **once per PTY for the terminal's
whole lifetime**, in `terminalPool.ts:172`, so the xterm buffer keeps filling
even while that terminal is not mounted in any view. Everything about how those
bytes are rendered belongs to [design.md](design.md).

### How a hook payload reaches the main process

`HookServer.start()` (`hooks.ts:176`) creates a `net` server on
`hive.sockPath()` — `<hiveRoot>/hooks.sock` on POSIX, and on Windows a derived
named pipe `\\.\pipe\munder-difflin-<sha1(root)[0:12]>`, because Node's `net`
IPC on Windows uses a flat pipe namespace and binding a filesystem path fails
with EACCES. A stale socket file from a previous run is removed before listening.

The wire protocol is one newline-terminated JSON object per connection. The
server buffers until it sees `\n`, parses, dispatches to `handle()`, and answers
with `conn.end(JSON.stringify(res ?? {}))` — the response is what the CLI reads
as the hook's verdict, which is how the gates below can deny a tool call.

The client half is `HOOK_SHIM` (`hive.ts:8790`), written to
`<hiveRoot>/bin/cth-hook.cjs`. It reads stdin, stamps `agent_id` from
`process.env.AGENT_ID` when the payload has none, and connects to
`process.env.HIVE_SOCK`. It is installed per agent, never into the user's own
config: `hookSettings()` (`hive.ts:1777`) builds a settings object and
`spawnAgentCore`'s hive provisioning writes it next to the agent's identity and
appends `--settings <path>` to the CLI's argv (`hive.ts:1305`–`1314`). Nine hook
events are wired — `Stop`, `SubagentStop`, `PreToolUse` and `PostToolUse` (both
with matcher `*`), `UserPromptSubmit`, `Notification`, `SessionStart`,
`PreCompact`, `PostCompact` — plus a `statusLine` entry running the same shim
with `--status`.

The shim is invoked through the bundled-node launcher `hive-node`, not bare
`node`. Agent CLIs run hooks via `sh -c` with a stripped
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, where an nvm-installed node does not
exist, so every payload used to die with exit 127 — no live status, no session
ids, no Stop-driven inbox handling (`913b8ad`). A wrapper *script* rather than
an inline `FOO=1 exe …` prefix, because that prefix is POSIX-sh syntax and a
hard error under `cmd.exe`, which is what runs hook commands on Windows.

### What the hook server decides before forwarding

`handle()` (`hooks.ts:240`) is a single ordered pipeline, and the order is the
design. Each stage either returns (ending the hook with a verdict) or falls
through.

| Stage | What it does | Why it sits there |
|---|---|---|
| Transcript + liveness | Records `transcript_path` per agent; `telemetry.recordHookActivity` | Every payload shape benefits, so it runs before any early return. For non-Claude providers the hook plane is their *only* telemetry. |
| Session boundary | `SessionStart`/`SessionEnd` reset the pending-work census | A fresh conversation must not inherit a stale census. |
| `Status` | Stores `{tokens, limit}` and pushes `hive:contextUpdate`, then returns | Status-line ticks are telemetry, not a hook boundary: they must never trip the HALT gate or feed the breaker's loop detector. |
| Operator HALT | Returns `{continue: false, stopReason}` | A graceful stop at a hook boundary rather than killing the PTY; `session_id` stays in the payload for a later `--resume`. |
| `recordSession` | Persists the CLI session id | Idempotent `--resume` and cost dedup. |
| `CostSample` | Appends to the cost ledger, then returns | Synthesized by the qwen proxy sidecar and the pi bridge; kept out of the Claude-only OTel path below. |
| `PostToolUse` | Feeds the breaker's repeated-tool signal, the telemetry span ring, and Monitor arm-time classification | A repeated identical `(name, input)` is the runaway-loop tell. |
| Compaction exemption | `PreCompact` opens it, `PostCompact` or any `SessionStart` closes it | The compaction token burst would otherwise trip the breaker's Δoutput arms (issue #109). |
| `Stop` / `SubagentStop` | Refreshes the census, fires a desktop toast, emits with `pendingWork` | The census refreshes exactly when the idle gates evaluate. `SubagentStop` is excluded from the census because its `agent_id` is Claude's internal subagent id, not a hive agent. |
| `PreToolUse` gates | HITL deny, shared-state gate, orient gate | All three answer immediately with a `permissionDecision: 'deny'`, with no renderer round trip, so they cannot hit the shim's timeout. |
| Context injection | Merges roster, rearm, nudge-rearm and steer into one `additionalContext` | Only **one** `additionalContext` may be returned per hook, so they must merge or displace each other. |
| `Notification` | Desktop toast when the message means "waiting for your input" | A permission request surfaces natively in the agent's own session instead. |
| Fallthrough | `emit()` | Everything reaches the renderer so avatars stay live. |

Two guards inside that pipeline are worth naming. The **synthetic-wake gate**
(`hooks.ts:522`) classifies a `UserPromptSubmit` whose prompt starts with
`<task-notification` — or is entirely a `<system-reminder>` — as
machine-generated, and suppresses the roster line and the steer take for it. The
steer half is the load-bearing one: `control.takeSteer()` is a *destructive*
delivered-once queue, so consuming it on a machine wake would silently swallow
queued operator guidance. A `<system-reminder>` only counts when it is the whole
prompt; appended to real typing it is a real prompt.

The second is **bridge capability**. A steer is consumed only when the agent's
provider actually delivers hook context back into the conversation
(`bridgeDeliversHookContext`). A provider with no delivering bridge would drop a
consumed steer on the floor, so for those the steer stays queued and the backlog
is announced loudly once per episode (`steerBacklogNotified`, `hooks.ts:146`).

Two emit paths leave the server: `emit()` (`hooks.ts:651`) sends `hive:hookEvent`
with the agent id, event name, tool, notification type, message, `source`, a
`blocked` flag and (on `Stop`) `pendingWork`; `emitControl()` (`hooks.ts:647`) sends
`control:approvalRequest` when a tool call was gated. Both go to
`liveWebContents()` (`index.ts:1928`), which prefers the most-recently-focused
window and falls back to any other live one rather than dropping the event.

### How a hook event becomes avatar movement

`useHive.ts:465` subscribes to `hive:hookEvent` and is the authoritative status
writer. `stationForTool` (`useHive.ts:201`) maps a tool name to a station and a
carried object; the effect then writes `status`, `currentStation`, `carrying`
and `action` into the store, and the Pixi scene walks the avatar there.

The mapping resolves in three rungs, and the lower two are why non-Claude agents
still move sensibly. An exact hit in `TOOL_STATION` wins. Otherwise any
`mcp__*` tool goes to the MCP station — before that fallback they silently sat
at the desk. Otherwise a regex ladder over the lowercased name catches the other
CLIs' vocabularies (Antigravity sends `run_command`, `ListDir`, `write_file`,
not Claude's tags): terminal, then web, then write/edit, then read/list, then
desk. The write/edit test runs **before** the read test on purpose, so
`write_file` does not match `file` and walk to the shelf.

The event-to-state mapping, in the order the branches are tested:

| Event | Store effect |
|---|---|
| `PreCompact` / `PostCompact` | `compacting` / back to `working` — visibly boxing up context, not frozen |
| `PreToolUse` | `working` at the tool's station, carrying the tool; bumps the tool counter |
| `PostToolUse`, `UserPromptSubmit` | stays `working`, so it cannot flicker idle between tool calls |
| `PreInvocation` / `PostInvocation` | Antigravity's per-turn boundary; `PostInvocation` maps to idle because agy's `Stop` fires only on process exit |
| `Stop` / `SubagentStop`, `blocked` | `working`, "reading inbox" — being re-engaged is not idle |
| `Stop` / `SubagentStop`, `pendingWork > 0` | `waiting` with the count — settled but waiting on background work |
| `Stop` / `SubagentStop`, otherwise | `idle`, `pending: 0` |
| `Notification` | `blocked` only when the message reads as a real approval request **and** the agent is god; everyone else reads `waiting` |

Two precedences override this. The **breaker** wins: while
`control:breakerState` reports `constrained` or `stopped`, every branch above is
skipped and the agent stays pinned to `looping` until it genuinely stops
(`breakerArmed`, `useHive.ts:482`). And **only god escalates to the human** — a
worker sitting at a prompt is autonomous, so it renders as `waiting` (parked on
god) rather than raising a human-approval card.

The `Notification` split exists because Claude Code fires the same hook for two
opposite situations: it needs a human decision, or the prompt merely went idle
("Claude is waiting for your input"). Treating the second as blocked made
Michael march to the door with a red "!" immediately after finishing every task.

### What the byte stream still decides

`usePtyParser` (`src/renderer/src/hooks/usePtyParser.ts:71`) is the surviving
fragment of the output-parsing approach. It scans each chunk for Claude's `●
Read foo.ts` tool lines (`TOOL_RE`), maps them to stations (`TOOL_TO_STATION`),
watches for the "esc to interrupt" footer to know a turn is running, and sniffs
the `/context` output's denominator to learn the session's real context-window
size — the only reliable source for a session on the CLI-default model, because
the `[1m]` alias exists only inside Claude Code.

It is **fenced to Claude sessions**. The first thing the returned callback does
is look up its own agent and return early when
`inferAgentProvider(...) !== 'claude'` (`usePtyParser.ts:116`). Its patterns
match no other CLI's TUI, so for every other provider it degraded into a
four-second idle-drift machine that fought the hook events — pi agents sat idle
on the floor while working. The division of labour is stated at
`useHive.ts:483`: *"Hook events are the authoritative status source for real
agents (the pty-stream parser only refines the on-floor action/station)."*

Its function docstring (`usePtyParser.ts:66`) still calls it *"a stopgap until
we wire real Claude Code hooks"*. That is stale — the hooks have been wired since the first release — but
the parser was kept because it produces something hooks do not: the *argument*
of the tool call, which becomes the human-readable status line under the avatar.

> ⚠ **INTENT UNVERIFIED:** Why is the idle-drift window 4000 ms
> (`usePtyParser.ts:89`)? Nothing in the code, commits or tests records how the
> value was picked. (raised 2026-08-22)

Blocked detection deliberately does **not** match the bare word "permission":
the Claude TUI footer permanently reads "bypass permissions on (shift+tab to
cycle)", which would flag every busy agent as blocked on each repaint and make
it flip-flop between working and blocked. `BLOCK_HINTS` (`usePtyParser.ts:50`)
matches only real prompts.

### How the renderer's roster survives a reload

The store persists to **two** places, and the reason is a bug that looked like
data loss. `localStorage` is partitioned by origin, and the two ways this app
runs do not share one: `npm run dev` serves the renderer from
`http://localhost:5173`, a packaged build loads it from `file://`. The roster —
agents, private notes, worktree paths, archived entries, parked queues — was
invisible to whichever of the two you were not currently in, even though the
hive on disk was shared and intact the whole time.

So the store also mirrors to `<harnessHome>/roster.json`, which both origins
reach by path. `localStorage` keeps being written byte-for-byte as before: it is
the fallback when there is no file yet, and a standing backup afterwards.

```
persistAgents / persistArchived / persistRestorable / persistQueues
   ├─→ window.localStorage.setItem(…)            (immediate, per origin)
   └─→ rosterMirror.<slice> = slim               (in-memory whole-file image)
          └─→ scheduleRosterFlush()  ──500ms──→  window.cth.rosterWrite(snapshot)
                                                        └─→ main RosterStore
```

Three details in that path are non-obvious:

- **`rosterMirror` is a mutable module-level image**, not a read-back from the
  store, because every `persist*` call happens *inside* a zustand `set()`, where
  `getState()` still returns the pre-update state — a snapshot built that way
  would reliably be one edit stale (`store.ts:440`).
- **The mirror is primed at module load** with everything just hydrated, so a
  later persist of one slice writes a complete file instead of blanking the
  slices it did not touch.
- **A quit inside the 500 ms debounce must not drop the last edit**, so
  `flushRosterNow` is also wired to `beforeunload` (`store.ts:481`).

Reading back, `useFileRoster` (`store.ts:431`) prefers the shared file **only
when it actually holds a roster**. An empty file must never win over a populated
`localStorage` — that is exactly the "opened the packaged build once and my
floor went blank" failure the mirror exists to prevent. Main holds the matching
brace: `RosterStore.write` refuses the first write of a run when it would
replace a non-empty roster with an empty one (`skipped: 'empty-first-write'`),
and keeps every previous version under `roster-backups/`. Pinned by
`test/roster.test.cjs`.

What gets written is a slimmed record. `PersistedAgent` (`store.ts:396`) drops
the large and transient fields, and `contextTokens`/`contextLimit` are dropped
because they describe a *live* session — persisting them showed a dead session's
context gauge after a restart until the poll caught up. The restorable list is
the one exception and keeps them, because a restorable entry is a spawn recipe
for a session not yet re-entered, so its last known context size is still
meaningful.

Whether a `updateAgent` patch is worth a disk write at all is decided by
`touchesDurableAgentField` against `VOLATILE_AGENT_FIELDS` (`store.ts:525`).
`updateAgent` is also the PTY parser's per-chunk write, so persisting
unconditionally would rewrite the roster on every burst of terminal output;
persisting nothing was worse, because a model or command change lived only in
memory and the selector snapped back on reload. The set is written as the
**volatile** list rather than the durable one on purpose: a newly added field
then persists by default instead of being silently dropped.

### What a PTY exit tears down

Natural exit and explicit kill run the same teardown, which was not true
originally. Until `c1ac7b5`, archive, worktree removal and map cleanup lived
only in the `pty:kill` IPC handler; when the child exited on its own, node-pty's
`onExit` merely re-emitted `pty:exit`, so the agent stayed "active" (broadcast
fan-out kept mailing a dead inbox), its isolated worktree stayed registered in
the user's real repo, and three bookkeeping maps leaked an entry per dead PTY.

Now `PtyManager.setExitHandler` (`pty.ts:215`) is called from inside `onExit`,
wrapped so a teardown error can never throw out of node-pty's callback, and the
handler installed at `index.ts:899` does two things: it checks whether this exit
was a successful first-time CLI install (in which case it re-arms the renderer's
pooled terminal via `pty:relaunch:<id>` and re-runs the same spawn with
`noAutoInstall`), and otherwise calls `teardownPty(id)`.

`teardownPty` (`index.ts:705`) is idempotent and best-effort throughout: revoke
the integration-broker capability for that id, drop its breaker state, stop its
proxy-bridge sidecar, archive the agent in the hive registry, then remove the
isolated worktree. Idempotence is what lets `pty:kill` call `ptyManager.kill()`
*and* `teardownPty()` while node-pty's own `onExit` fires later as a harmless
no-op.

`killAll()` (`pty.ts:580`) is the deliberate exception: it clears `exitHandler`
first, because app quit and reset are wholesale shutdown rather than per-agent
lifecycle — running the handler there would archive every agent and fire a storm
of `git worktree remove` while the process is tearing down. Its `immediateSweep`
option sweeps each process tree synchronously, because the normal escalation
timer is unref'd and the app usually exits before it fires.

Separately, `healthCheckPtys` (`index.ts:7519`) runs after system resume. It
probes each PID with `process.kill(pid, 0)` — a liveness check that never kills —
and reports any PTY whose process is gone but whose session is still registered,
then emits `power:resume` with the dead ids so the renderer can offer a respawn.

### Which window receives which stream

Floors are separate `BrowserWindow`s (`createWindow`, `index.ts:3097`), and each
one owns its own terminals. The routing rules:

- The **primary** window is the default sink: only it calls
  `ptyManager.attachWebContents(wc)` (`index.ts:3242`). Floors route purely by
  per-PTY `owner`.
- Each floor gets its own persistent session partition
  (`persist:floor-<n>`), so floors never share or stomp each other's
  `localStorage`. The primary keeps the default session so existing state loads.
- Closing a floor confirms only **its own** terminals (`countByOwner`), and
  kills them on `closed` (`killByOwner`) so they do not linger writing to a dead
  `webContents`. Closing the primary raises the app-wide quit warning.
- `backgroundThrottling` is off for every window, because the renderer runs the
  hive's heartbeat loops and Chromium throttles timers in occluded windows —
  including behind the lock screen — which silently stalls the hive while the
  user is away.

### What the preload bridge exposes

`src/preload/index.ts` builds one object and publishes it as `window.cth`
through `contextBridge.exposeInMainWorld('cth', api)`, with
`contextIsolation: true` and `nodeIntegration: false`. Its exported type
`CthApi` is what the renderer type-checks against, so adding an IPC channel is a
single-file change with a compile-time contract.

Three properties of the surface are worth knowing before adding to it:

- **Subscriptions return their own unsubscribe.** Every `on*` helper registers
  an `ipcRenderer.on` listener and returns a closure that removes exactly that
  listener, so a React effect can `return window.cth.onHiveHookEvent(cb)`
  directly.
- **PTY streams are per-id channels**, `pty:data:<id>` / `pty:exit:<id>` /
  `pty:relaunch:<id>` / `pty:detached:<id>`, while detach *state* is broadcast on
  a single `pty:detachState` because the store mirrors it for every pane.
- **Secrets never cross the bridge.** `IntegrationRecordView` replaces the
  secret handle with a `hasSecret` boolean, and key presence is exposed as
  booleans (`realtimeHasOpenAiKey`, `providerKeyHas`) so a UI can show a control
  as disabled without ever holding the value.

One call is synchronous on purpose. `rosterReadSync()` uses
`ipcRenderer.sendSync('roster:readSync')` because the zustand store is created
at module load: an async read would arrive after the first render and the floor
would flash empty. It is one blocking round trip at boot, and returns `null` on
any failure so the caller falls back to `localStorage`.

## Workflows

### Spawning an agent, end to end

| Step | What happens | Where |
|---|---|---|
| 1 | Renderer calls `window.cth.spawnPty(opts)` | `src/preload/index.ts:676` |
| 2 | Handler validates the three required strings, records the calling window as owner | `index.ts:3418` |
| 3 | Retired / floor-cap / one-agent-per-directory gates | `index.ts:3467`–`3524` |
| 4 | `~` expanded once; registry gets an absolute cwd | `spawnAgentCore`, `index.ts:3451` |
| 5 | Worktree provisioned (if isolating), hive identity written, `--settings <hook file>` and `HIVE_SOCK` added | `hive.ts:1305` |
| 6 | Command resolved, PATH and env built, child spawned | `pty.ts:353` |
| 7 | `ptyToAgent` records the mapping; `syncKeepAwake()` arms the power blocker | `index.ts:3945`, `index.ts:4041` |
| 8 | Result echoes the absolute `cwd`, the `worktreePath` and any `seedPrompt` back to the renderer | `index.ts:4049` |
| 9 | Renderer calls `addAgent()`; the card appears and the roster is persisted | `store.ts:822` |

### One hook, from tool call to avatar

| Step | What happens | Where |
|---|---|---|
| 1 | CLI runs the `PreToolUse` hook command through `hive-node` | `hive.ts:1785` |
| 2 | Shim reads the payload on stdin, stamps `agent_id` from env, connects to `HIVE_SOCK` | `HOOK_SHIM`, `hive.ts:8790` |
| 3 | Server buffers to the newline, parses, calls `handle()` | `hooks.ts:186` |
| 4 | Gates evaluate; a denial returns `permissionDecision: 'deny'` to the CLI | `hooks.ts:412`–`507` |
| 5 | `emit()` sends `hive:hookEvent` to `liveWebContents()` | `hooks.ts:651` |
| 6 | `conn.end(JSON.stringify(res))` — the CLI reads the verdict | `hooks.ts:204` |
| 7 | Renderer maps tool → station and writes the store | `useHive.ts:496` |
| 8 | Pixi scene walks the avatar to the station | see [design.md](design.md) |

## Integration points

- **Hive** (`src/main/hive.ts`, `src/renderer/src/hooks/useHive.ts`) — the
  deepest seam. The hive owns `sockPath()`, `HOOK_SHIM`, `hookSettings()` and
  the registry the hook gates read (`isGod`, `providerOf`, `recordSession`,
  `appendCostLedger`). `useHive.ts` is renderer-side hive orchestration and is
  documented in [hive.md](hive.md), even though the hook-event effect that lives
  in it is the event plane's terminus and is described above.
- **Message queue** (`src/main/autoPark.ts`, the drain loop in `useHive.ts`) —
  the store owns the queue *data* (`messageQueues`, `enqueueMessage`,
  `releaseQueuedMessage`, `clearQueue`) and `deliverWithAcknowledgement`
  (`queueDelivery.ts:3`), which acknowledges a queue item only after the send
  resolves so a rejection leaves it for the next retry. Delivery timing, the
  idle gates and auto-park belong to [message-queue.md](message-queue.md).
- **Telemetry** (`src/main/telemetry.ts`, `useTelemetry.ts`) — the hook plane
  feeds the collector three ways: `recordHookActivity` (liveness for providers
  with no OTLP), `recordHookSpan` (their only tool signal) and
  `recordHookUsage` (`CostSample` rows). See [telemetry.md](telemetry.md).
- **Circuit breaker and operator control** (`src/main/breaker.ts`,
  `src/main/control.ts`) — `HookServer` is constructed with both
  (`index.ts:553`). Control answers the HITL gate and the HALT gate inside the
  hook response; the breaker consumes `PostToolUse` and pushes
  `control:breakerState`, which outranks every hook-derived status in the
  renderer.
- **Gates outside this doc** — `sharedStateGate` (`src/main/hiveGate.ts`) and
  `orientGate` (`src/main/orientGate.ts`) are called from `handle()` but own
  their own policy; the spine only guarantees their position in the pipeline and
  that `orientGate` fails open.
- **Detach bridge** (`src/main/detachBridge.ts`) — reaches into `PtyManager`
  through exactly two methods: `outputTail(id)` for replay and `setOutputTap(id,
  fn)` while its window is live, both wired at `index.ts:291`–`293`. In the
  other direction, `pty:resize` consults `detachBridge.isDetached(id)`
  (`index.ts:4075`).
- **Design system and scene** ([design.md](design.md)) — `terminalPool.ts`,
  `PtyTerminalView` and the Pixi office read the store; nothing in the spine
  knows how they draw.

## Gotchas

- **A restart reuses the PTY id, so exits can arrive out of order.** `onData`
  and `onExit` both compare `this.sessions.get(id)` against the captured session
  object and return early on a mismatch. Without it, a model change sprays the
  dying process's last bytes into the new TUI frame and its exit kills input to
  the agent that just started (`352e4aa`).
- **`pty:write` is deliberately not gated on detach.** Two producers share it:
  the pane's xterm (user keystrokes, already refused renderer-side at the pool's
  `entry.detached` chokepoint) and automation (queue delivery, breaker, god's
  nudges). A detached agent must stay fully live, so blocking here would wedge
  every queued message for it. `pty:resize` *is* gated — the active view owns
  the winsize (`index.ts:4058`, `index.ts:4070`).
- **Failed command resolutions are never cached.** Only `found: true` results
  enter `resolvedCommands`, and even those are re-validated with `existsSync` on
  every read. Caching a miss would make the missing-CLI auto-installer unable to
  see the binary it just installed (`pty.ts:274`).
- **`usePtyParser` silently does nothing for non-Claude agents.** The provider
  check at `usePtyParser.ts:116` returns before any parsing. If a pi or Codex
  agent's floor status looks wrong, the bug is in the hook path, not here.
- **Only one `additionalContext` can be returned per hook**, so the roster line,
  the SessionStart rearm notice, the nudge rearm notice and a queued steer are
  joined with `\n\n` in one place (`hooks.ts:610`). Adding a fifth injection
  means extending that join, not adding a return.
- **`Status` payloads return before the HALT gate and the breaker.** They are
  status-line telemetry, not a hook boundary; letting them through would let a
  status tick trip a halt or feed the loop detector (`hooks.ts:271`).
- **`takeSteer()` is destructive.** It is a delivered-once queue, so the
  synthetic-wake gate must run first — a `<task-notification>` wake that
  consumed a steer would swallow operator guidance silently (`hooks.ts:543`).
- **The desktop toast is gated on config; the renderer emit never is.**
  `notify()` checks `config.notifications`, but `emit()` always fires, so
  avatars and the UI stay live regardless of the notification setting
  (`hooks.ts:635`).
- **`killAll()` clears the exit handler before killing anything.** Quit and
  reset must not archive every agent or storm `git worktree remove`
  (`pty.ts:581`).
- **An empty roster file must never win.** `useFileRoster` requires a non-empty
  file, and main's `RosterStore.write` refuses a first write that would blank a
  populated roster (`skipped: 'empty-first-write'`). Both halves exist because
  dev (`localhost:5173`) and packaged (`file://`) builds have separate
  `localStorage` origins. Pinned by `test/roster.test.cjs`.
- **Persistence is decided by a negative list.** `VOLATILE_AGENT_FIELDS`
  enumerates what is *not* saved, so a newly added `Agent` field persists by
  default. Adding a per-chunk run-state field without listing it there makes
  every burst of terminal output rewrite the roster (`store.ts:525`).
- **`updateAgent` also patches archived agents.** When the id is not on the
  floor but is in `archivedAgents`, the patch is applied there too and mirrored,
  so an edit made from the VACATION/ARCHIVED rows rides the next recall instead
  of silently no-opping (`store.ts:807`).
- **A vacationing agent cannot be deleted from the renderer.**
  `removeArchivedAgent` returns unchanged state when `target.vacation` is set;
  recall it first. Main holds the same brace in the registry (`store.ts:952`).
- **Interns leave no archived copy.** `archiveAgent` drops them entirely rather
  than filing them — the registry and the hive git log keep the record, only the
  UI forgets (`store.ts:918`).
- **The mock event loop is still wired.** `startMockLoop`
  (`store/mockEvents.ts`) runs on a genuinely empty floor or under
  `VITE_CTH_DEMO=1`, and stops the instant the first real PTY agent appears. In
  normal operation god always spawns, so it effectively never runs
  (`App.tsx:229`).

## Key files

| File | What lives in it |
|---|---|
| `src/main/pty.ts` | `PtyManager` — spawn, command resolution and its cache, env merge, Windows `cmd.exe` quoting, per-session output routing, identity guards, kill paths. Exports `buildSpawnEnv`, `buildCmdCommandLine`, `withHiveRuntimeFallback` for tests. |
| `src/main/hooks.ts` | `HookServer` — socket lifecycle, the ordered `handle()` pipeline, the gate returns, `additionalContext` merging, `emit`/`emitControl`/`notify`. |
| `src/main/index.ts` | The wiring. `ptyManager`/`hookServer` construction, `spawnAgentCore` and its gates, `teardownPty`, the `pty:*` IPC handlers, `createWindow`, `liveWebContents`, `healthCheckPtys`. Also hosts many non-spine subsystems. |
| `src/preload/index.ts` | The whole `window.cth` surface and its types; `contextBridge` publication; `CthApi`. |
| `src/preload/index.d.ts` | The global `Window.cth` declaration. |
| `src/renderer/src/store/store.ts` | `useStore`, the `Agent` and `QueuedMessage` shapes, roster hydration and the dual localStorage + `roster.json` persistence. |
| `src/renderer/src/store/config.ts` | Renderer-side mirror of `HarnessConfig` and the provider/model helpers, kept type-only so the renderer need not reach into preload. |
| `src/renderer/src/store/mockEvents.ts` | The empty-floor demo loop. |
| `src/renderer/src/hooks/usePtyParser.ts` | Claude-only byte-stream refinement: tool lines, block hints, context-limit sniffing, idle drift. |
| `src/renderer/src/hooks/queueDelivery.ts` | `deliverWithAcknowledgement` — acknowledge only after the send resolves. |
| `src/renderer/src/hooks/useRestoreTeam.ts` | "Restore team" and the automatic boot restore, with module-level state so both mount points share one run. |
| `src/renderer/src/hooks/useProviderModels.ts` | Static model list first, discovered auth-scoped list when main returns one. |
| `src/renderer/src/hooks/useTypewriter.ts` | Character-by-character reveal for the assistant text, `seed`-restartable. |
| `src/renderer/src/hooks/useHive.ts` | Renderer-side hive orchestration — see [hive.md](hive.md). Its `hive:hookEvent` effect is the event plane's terminus. |
| `src/renderer/src/hooks/useTelemetry.ts` | Fleet grid and span waterfall — see [telemetry.md](telemetry.md). |
