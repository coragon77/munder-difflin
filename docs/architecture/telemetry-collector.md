# TelemetryCollector — Cost Plane & Circuit Breaker

- **Coverage:** `src/main/telemetry.ts`, `src/main/breaker.ts`, `src/main/usage.ts`, `src/main/burn.ts`, `src/main/pricing.ts`
- **Depends on:** [Hive](hive.md)
- **Last Updated:** 2026-08-22

## Purpose

This is the harness's **first-party cost plane**: it measures what every agent
spends, and it enforces a ceiling. Claude Code ships `--max-turns` but **no
dollar or token ceiling**, so the harness supplies one — a runaway agent is the
existential failure mode this subsystem exists to prevent.

It is not the anonymous product-analytics pipeline. That is
[Telemetry](telemetry.md) (`src/main/analytics.ts`), which sends events *out* to
PostHog. Nothing here ever leaves the machine: `TelemetryCollector` binds
**127.0.0.1 only**, with the loopback bind as the trust boundary (the same
posture as `slack.ts`).

## Mechanism

### Two ingest planes feed one collector

`TelemetryCollector` (`src/main/telemetry.ts`) accepts usage from two entirely
separate sources, and they are **not** interchangeable:

| Plane | Who pushes | Entry point | Feeds |
|---|---|---|---|
| **OTLP** (Claude Code only) | the agent process, over OTLP/HTTP **JSON** | `POST /v1/metrics`, `/v1/logs` | `getAgentUsage()`, `snapshot()`, spans |
| **Hook plane** (every other provider) | `HookServer` on `HIVE_SOCK` | `recordHookActivity/Span/Usage()` | `snapshot()` and spans **only** |

Claude Code is launched with `CLAUDE_CODE_ENABLE_TELEMETRY=1` and
`OTEL_EXPORTER_OTLP_ENDPOINT` pointed at `endpoint()` (injected by `ensureAgent`
in `hive.ts`, gated on the collector being bound). The port defaults to `0` — an
OS-assigned ephemeral port, deliberately not 4318, so the harness never collides
with a user's own collector. A malformed batch is dropped, never thrown into the
socket.

`claude_code.token.usage` and `claude_code.cost.usage` are **delta and
monotonic**, so `ingestMetrics` *sums* each export into a per-`session.id`
`SessionAccum` rather than treating a point as a total. `aggregateLive()` then
sums an agent's sessions — which is what makes totals survive `--resume` —
taking `sessionId` and `model` from the most recently active one.

### PII is stripped by construction, not by policy

Raw OTel records carry `user.email`, `user.account_id`, `organization.id` and a
hashed `user.id`. `flattenAttrs()` reads only `ATTR_ALLOWLIST`, so an identity
attribute is never even decoded and no raw record is ever persisted. Every
downstream store (`cost-ledger.jsonl`, the SQLite `cost_ledger` table) inherits
that guarantee.

### The locked seam: what a consumer may read

`src/main/usage.ts` declares the contract — Lane A #6.6, *Seam 1, the LOCKED
contract with Oscar/#7*. Its header (`usage.ts:4-6`) states the rule the whole
plane rests on, verbatim:

> The circuit breaker (breaker.ts) and the durable cost ledger (hive.ts
> appendCostLedger) consume usage ONLY through the `UsageProvider` interface —
> they never read transcripts, never compute tokens, and never recompute `usd`.

The contract is the **interface**, not one method: `getAgentUsage()` is the
primary pull half and `onAgentUsage()` the additive push half.

Two invariants bind every consumer:

1. **Samples are cumulative snapshots.** Velocity is the *diff* of consecutive
   pulls (Δoutput/Δt), never a single sample read as an increment.
2. **`model` arrives normalized** — the `[1m]` context-window suffix is already
   stripped.

`getAgentUsage()` prefers the live OTel aggregate and falls back to the
transcript reader (`readAgentUsage` in `transcript.ts`) when an agent has no live
telemetry; the swap is hidden inside the collector so the breaker never changes.
`onAgentUsage()` is the additive push half (OTel-only), and `onApiError()` is the
in-process feed for the breaker's error-storm arm — hook payloads carry no api
errors, so that arm has no other input source.

### Where the dollar figure comes from

`src/main/pricing.ts` is **fallback-only**. On the OTLP path the collector trusts
`claude_code.cost.usage`, which is Claude's own pre-computed per-model cost, and
never prices anything itself. `estimateCostUsd()` has three call sites:

- **`transcript.ts:228`** — the offline reconciler, when telemetry is off;
- **`telemetry.ts:275`** (`recordHookUsage`) — prices the in-memory `hookUsage`
  row, so non-Claude agents show a comparable `usd` in `fleet.json`;
- **`hooks.ts:332`** — inside the `CostSample` handler, and this is the one that
  matters most: it sets `usd` on the **durable ledger row** for every non-Claude
  agent. For those providers the table is not a fallback at all; it is the only
  cost figure that ever reaches `cost-ledger.jsonl`.

`priceFor()` matches by family substring (`opus` / `haiku` / `sonnet`) and falls
back to `SONNET`. It replaced the hard-coded Sonnet-for-everyone constants that
undercosted Opus by roughly 5× (cost bug #1, `fd05989`). Drift in the table is
harmless for Claude agents and directly wrong for everyone else.

### When the breaker trips

`CircuitBreaker` (`src/main/breaker.ts`) is **policy only** — no side effects. It
reads signals and returns `BreakerDecision[]`; the caller (`runBreakerBeat` in
`index.ts`) performs enforcement. Seven arms, evaluated in this order, first
match wins:

| Arm | Signal | Config |
|---|---|---|
| repeated identical tool call | `recordToolUse` key repeat | `repeatedToolLimit` (8) |
| api-error storm | `recordError` count | `errorStormLimit` (5) |
| per-agent token cap | this agent's total tokens | `agentTokenCaps[agentId]` |
| floor cost cap | floor total `usd`, top spender blamed | `costCapUsd` |
| floor token cap | floor total tokens, top spender blamed | `costCapTokens` |
| token velocity | Δoutput / Δminutes across beats | `tokenVelocityPerMin` (60 000) |
| no-progress | stale files **and** no distinct tool **and** `hasOpenWork` | `NO_PROGRESS_BEATS` (2) |

`costCapUsd` is **deprecated since v0.3.4** (config-file only, no UI, still
enforced for legacy configs); `costCapTokens` is the user-facing budget.

The last two arms share a gate: both need two consecutive samples, `dOut > 0`
(cumulative output actually grew since the previous beat) **and**
`nowMs >= compactingUntil`. The `dOut > 0` leg means an agent producing no output
is structurally exempt from the no-progress arm, however stale its files are.
`recordCompactStart` (PreCompact) opens that
exemption for `COMPACT_GRACE_MS` (5 min, a safety cap in case PostCompact never
arrives) and `recordCompactEnd` shortens it to `POST_COMPACT_GRACE_MS` (90 s),
because the compaction burst lands in the *next* beat's cumulative diff.
Compaction burns output tokens while touching no coordination file, which is the
exact false-positive shape of upstream issue #109 — the harness's own
auto-compact mission tripping its own breaker (`e0e2cee`).

Call identity for the loop arm is a 32-bit FNV-1a hash over the serialized
`tool_input`. A string field longer than 250 chars is replaced by its 250-char
prefix **plus** its length and an FNV digest of the whole value
(`breaker.ts:255-259`) — the prefix is still truncated, but the length and digest
restore the identity that plain truncation destroyed, which had collapsed
distinct `cd <dir> && …` commands sharing a 250-char prefix into one key and
steered working agents (`c4a0fbb`, `ed6f527`). The cap bounds allocation:
`hashKey` walks the characters without allocating, and this runs synchronously in
the hook reply path on every `PostToolUse`.
**No input means no identity:** `toolKey()` returns `null`, which
`recordToolUse()` counts as a distinct call, because bridges that ship
`PostToolUse` without `tool_input` (pi, opencode) made every `Bash` call hash
equal.

### How escalation and recovery move

The ladder is `healthy → steering → constrained → stopped`, **one level per
beat**, never a jump to a kill. A non-tripping beat de-escalates one level.
`hardStop` defaults to `false`, which caps the ladder at `constrained` — without
the opt-in the breaker can steer and constrain but never kills. `action` fires
only on *escalation*, so a durable steer message is not re-sent every beat.

## Workflows

### The breaker beat (~30 s, `runBreakerBeat`)

| Step | Action | Location |
|---|---|---|
| 1 | Skip archived, assistant and PTY-less entries | `index.ts` `runBreakerBeat` |
| 2 | `usageProvider.getAgentUsage(id)` | the locked seam |
| 3 | Append the sample to `cost-ledger.jsonl` **only when `sessionId` is truthy** | `hive.appendCostLedger` |
| 4 | Skip god for breaker inputs (never auto-steer the orchestrator) | `index.ts` |
| 5 | `breaker.tick(inputs, now)` | `breaker.ts` |
| 6 | Emit each state on `control:breakerState` (Seam 2) | `index.ts` |
| 7 | Enforce: `steer`/`constrain` send hive mail; `stop` kills the PTY | `index.ts` |

### The fleet snapshot beat (~8 s, `writeFleetSnapshot`)

Reads `telemetry.snapshot()` plus `breaker.levelFor(id)` and recomputes
`burnWindows(<hive>/cost-ledger.jsonl, BURN_WINDOW_MS, now)` into
`<hive>/fleet.json` — the file god reads, because `claude agents` cannot see
sibling sessions.

`burnWindows()` sums tokens per agent over a trailing 5 h window, reading the
ledger **incrementally** (only bytes appended since the last call) behind a
module-level cursor per path. A file that shrank — rotation or a manual edit —
resets the cursor and rescans; a half-written last line waits in `pending` until
its newline arrives.

**Unknown is never zero.** An agent with no in-window rows is *absent* from
`agents` (rendered `—`) and `total` is `null` when nobody has rows, because the
in-memory collector starts empty on every app restart — that lens is what read
`0.00` while tokens climbed (2026-08-18 incident). The ledger is append-only,
covers every provider, and survives restarts.

## Integration points

- **`hive.ts` — the durable writer.** `appendCostLedger(sample)` is the only
  durable cost store. Rows are fully snake_case (`agent_id`, `session_id`,
  `cache_read`, `cache_creation`, …) so migration into Kevin's `cost_ledger`
  SQLite table is a straight `INSERT…SELECT`. `ensureAgent` injects the OTel env.
- **`hooks.ts` — the hook plane.** Forwards `recordHookActivity` on any event,
  `recordHookSpan` on `PostToolUse`, `recordHookUsage` + a second
  `appendCostLedger` on `CostSample`, and feeds `breaker.recordToolUse` /
  `recordCompactStart` / `recordCompactEnd`.
- **`analytics.ts` / [telemetry.md](telemetry.md)** — the outbound
  product-analytics counterpart. Disjoint: no shared state, no shared events.
  `src/main/telemetry.ts` is owned by **this** doc as of 2026-08-21 (owner
  decision); telemetry.md covers `analytics.ts` only — its Coverage narrowing
  lands with this doc's commit.
- **`index.ts` `workerTokensUsed()` (`index.ts:7054-7056`)** — a third consumer
  of the locked seam. It pulls `getAgentUsage(workerId)` for the default-off
  per-worker token cap, which is separate from the breaker's `agentTokenCaps`
  arm.
- **Renderer** — `telemetry:event` pushes (`usage`, `tool_result`, `api_error`),
  `control:breakerState` pushes, and `telemetry:snapshot` for cold-start
  backfill (`levelFor`/`reasonFor` supply the badge so a reloaded window is not
  blank until the next beat, `b834d3b`).

## Gotchas

- **Hook-plane rows are deliberately barred from `getAgentUsage()`.** They land
  in `hookUsage` and surface only through `snapshot()`. Letting them into the
  locked seam would append cost-ledger rows on the 30 s beat that double-count
  the per-`CostSample` rows `hooks.ts` already writes, and would change breaker
  inputs. Pinned by `test/fleet-telemetry.test.cjs` — *"hook-plane rows never
  enter the locked getAgentUsage seam"*. In `snapshot()` the overlay order is
  hook rows first, OTLP on top, so an agent with both reports real OTLP totals.

  > ✔ **Resolved (2026-08-22, Stefan):** bug — the mixed units were never
  > intended. `burn.ts` `parseRow()` sums `input + output + cache_read +
  > cache_creation` for **every** row in the window, but the two ledger writers
  > disagree on units: `runBreakerBeat` appends **cumulative** snapshots every
  > ~30 s (`index.ts:1674`), while the `CostSample` path appends per-response
  > **deltas** (`hooks.ts:323`), so `burn5h` inflates for OTLP agents by roughly
  > the beat count (`test/burn-window.test.cjs` fixtures are all deltas; no dedup
  > or diff step exists). Fix owed: D3 in
  > `docs/goals/2026-08-22-intent-interview-decisions.md`.

- **The cost and token caps are ratchets, not thresholds.** Cumulative `usd` and
  token totals never decrease, so once the floor total crosses `costCapTokens`
  the top spender trips on *every* beat and climbs to the ceiling, then stays —
  there is no recovery path short of raising the cap or restarting the app (the
  in-memory accumulators clear; the ledger does not).
- **God spends but is never capped.** `runBreakerBeat` appends god's ledger row
  and then `continue`s before adding it to `inputs`. God's spend is therefore
  invisible to the floor-wide cost and token caps, which sum `inputs` only.
- **An agent on the transcript fallback is invisible to the ledger and to
  `burn5h`.** `transcriptFallback()` returns `sessionId: ''`, and step 3 of the
  beat gates on a truthy `sessionId`. That gate exists because a dead agent with
  a frozen transcript otherwise rewrote the identical row forever — 2,417
  duplicates were observed before it landed.
- **`AgentUsageSample` and `BreakerState` are each declared twice**, by different
  commits on the same day (2026-06-06), because the two lanes wrote their own
  copy in parallel:
  - `AgentUsageSample` — `telemetry.ts` (`fd05989`, Lane C) and `usage.ts`
    (`dc4e7bd`, Lane A). The shapes differ: `usage.ts` has nullable
    `sessionId`/`model`, `telemetry.ts` non-null.
  - `BreakerState` — `telemetry.ts` (`fd05989`) and `breaker.ts` (`9e690ba`),
    even though `telemetry.ts`'s own comment calls its copy "the shared type so
    both lanes import one shape".

  They are structurally compatible, so `const usageProvider: UsageProvider =
  telemetry` type-checks — but a field added to one is silently absent from the
  other.
- **Any log event whose name contains `error` feeds the error-storm arm.**
  `ingestLogs` matches `name === 'api_error' || name.includes('error')`, so an
  unrelated `*_error` event counts toward `errorStormLimit`.

  > ✔ **Resolved (2026-08-22, Stefan):** the substring breadth was never
  > intended (shipped that way in `fd05989`; nothing pinned it). Narrow the
  > match to `name === 'api_error'` exactly. Fix owed: D4 in
  > `docs/goals/2026-08-22-intent-interview-decisions.md`.

- **`tool_decision` attaches to the last span in the ring, not to its own tool
  call.** `ingestLogs` writes `ring[ring.length - 1].decision`, so out-of-order
  or interleaved decisions land on the wrong span.
- **The span ring is capped at `SPAN_RING_CAP` (200) per agent and never
  persisted**, and `stop()` deliberately *keeps* all accumulated state so a
  restart of the listener does not lose a live agent's totals.
- **`StubUsageProvider` has no caller.** `index.ts` wired the collector itself as
  the provider at integration (`const usageProvider: UsageProvider = telemetry`).
  Only the *types* from `usage.ts` are still imported — by `breaker.ts:26` and
  `hive.ts:41`.

  > ✔ **Resolved (2026-08-22, Stefan, delegated — pre-2026-08 code he did not
  > write):** leftover after the integration swap — delete `StubUsageProvider`
  > (`usage.ts:83`); the interface types stay. Fix owed: D5 in
  > `docs/goals/2026-08-22-intent-interview-decisions.md`.

- **`pricing.ts`'s own header is narrower than reality.** It says the table
  exists "solely for the OFFLINE transcript reconciler", but the hook plane
  prices through it too — `recordHookUsage` for the in-memory row and
  `hooks.ts:332` for the durable ledger row. The *live OTLP* claim still holds
  exactly: that path never calls `estimateCostUsd`.

## Key files

| File | What lives in it |
|---|---|
| `src/main/telemetry.ts` | `TelemetryCollector`, `ATTR_ALLOWLIST`, `SPAN_RING_CAP`, `MAX_BODY_BYTES` |
| `src/main/breaker.ts` | `CircuitBreaker`, `toolKey()`, `hashKey()`, `COMPACT_GRACE_MS`, `NO_PROGRESS_BEATS` |
| `src/main/usage.ts` | `UsageProvider`, `AgentUsageSample`, `StubUsageProvider` |
| `src/main/burn.ts` | `burnWindows()`, `resetBurnCursor()` |
| `src/main/pricing.ts` | `normalizeModel()`, `priceFor()`, `estimateCostUsd()`, `OPUS`/`SONNET`/`HAIKU` |

Tests: `breaker.test.cjs` (ladder, every trip arm, compaction exemptions,
no-progress debounce), `breaker-loop-identity.test.cjs` (input-less and
long-prefix calls are not loops), `breaker-standby-fps.test.cjs` (an idle agent
with no open work never trips), `fleet-telemetry.test.cjs` (hook-plane ingest,
OTLP preference, the barred seam), `burn-window.test.cjs` (window maths,
unknown-never-zero, shrink and partial-line resilience).
