# Remote Plane — inbound triggers and outbound secrets

- **Coverage:** `src/main/webhook.ts`, `src/main/slack.ts`, `src/main/telegram.ts`, `src/shared/triggers.ts`, `src/main/triggerHistory.ts`, `src/main/config.ts`, `src/main/integrations.ts`, `src/main/integrationBroker.ts`, `src/shared/integrations.ts`, `src/renderer/src/integrations/registryClient.ts`, `src/shared/mcpCatalog.ts`
- **Depends on:** [The Hive](hive.md), [Munder Difflin Spec](spec.md)
- **Last Updated:** 2026-08-22

## Purpose

Two opposite flows across the app boundary, in one doc because they share the
same trust posture.

**Inbound**: everything that starts hive work without a human typing into the
app — an HTTP POST from an arbitrary caller, a Slack `@`-mention, a Telegram
message from a phone, and a mission on a timer. `src/shared/triggers.ts` names
these four (`schedules`, `context`, `webhook`, `org`) and is the one contract
main, preload and the renderer all import.

**Outbound**: how a credential the operator registered reaches a worker's HTTP
call *without reaching the worker*. `IntegrationBroker` is a loopback proxy that
injects the real secret at forward-time; the worker holds only a capability
handle.

Two deliberate gaps. The `org` trigger has persistence and a settings surface but
**no transport** — nothing reads `OrgTriggerConfig.apiKey` beyond the UI that
displays it (commit `9f44125`: *"ORG_API_KEY is config and UI only, as scoped —
no transport yet"*). And `IntegrationAuthType` has no `oauth2` member, so Gmail,
Google Calendar and Salesforce are deliberately absent from
`INTEGRATION_TEMPLATES`.

## Terminology

| Term | Symbol | What it means |
|---|---|---|
| Trigger mode | `TriggerMode` | How far an outside sender is trusted: `strict`, `allow-all`, `communication-only` |
| Inbound kind | `InboundKind` | `directive` (asks the hive to act) vs `communication` (informational) |
| Held message | `decision: 'pending'` | An inbound the mode gate stopped; it has no card until the operator approves |
| Capability token | `WebhookDispatch.token`, `IntegrationBroker.grant()` | An unguessable handle. Never a secret; grants exactly one narrow thing |
| Secret ref | `secretRefFor(id)` → `int:<id>` | The handle stored in config; the value lives in the encrypted store |
| Clone node | `CLONE_NODE_BLURB` | A teammate's own Munder Difflin install, addressed by org key |
| MCP tier | `McpTier` | `safe-readonly` / `write` / `secret` — decides whether an MCP server ships on |

## How an inbound webhook POST is authenticated

One `WebhookServer`, one tunnel, many endpoints. The endpoint id comes from the
request path (`readEndpointId`: `/foo` → `foo`, bare `/` → `LEGACY_ENDPOINT_ID`,
`/a/b` → `null`), so adding a webhook costs no extra port and no extra tunnel.
Each endpoint carries its own `secret`, so revoking one caller never disturbs
another.

The gate's defining property is that **failure modes are indistinguishable**.
An unknown endpoint id and a wrong secret produce an identical `401`:

``` typescript
private verifySecret(req, endpoint: WebhookEndpoint | null): boolean {
  const provided = req.headers['x-md-webhook-secret'];
  ...
  const b = Buffer.from(endpoint ? endpoint.secret : this.decoySecret);
  if (a.length !== b.length) return false;
  const equal = timingSafeEqual(a, b);
  return endpoint ? equal : false;   // unknown id: compared, then always fails
}
```

`decoySecret` is `randomBytes(32).toString('hex')` per process and never
exported. The encoding matters: the length check short-circuits before
`timingSafeEqual` runs, so the decoy's 64 characters are what a probe's compare
is measured against. The same reasoning drives `handleStatus`: the token lookup
runs *even when the id is unknown*, because skipping it would make "no such
webhook" measurably cheaper than "no such token" — the timing signal an
enumeration probe wants.

Ordering is deliberate. `handleRequest` rate-limits before parsing anything, and
`handleCreate` authenticates **before** reading the body, so an unauthenticated
peer cannot make the process buffer. Two fixed windows apply: `RATE_LIMIT`
globally and `PER_ENDPOINT_RATE_LIMIT` per endpoint (strictly lower, or it would
never bind), with every unknown id sharing the single `UNKNOWN_BUCKET` — per-id
buckets for ids we don't serve would grow memory unboundedly *and* let a prober
see that unknown ids never hit the per-endpoint limit.

Body validation is `validateAgainstSchema`, a deliberately small JSON-Schema
subset (`type`, `required`, `properties`, `enum`) written because the project has
no validation dependency. Anything it does not understand is ignored rather than
failed. On top of the operator's schema, `message` is required unconditionally,
so a schema edited to drop it fails here instead of producing an empty card.

## How the trust gate decides: routed or held

`isAutoAllowed(mode, kind)` is the whole gate, and it is the same gate for the
webhook and org sources.

| Mode | `directive` | `communication` |
|---|---|---|
| `strict` (`DEFAULT_TRIGGER_MODE`) | held | held |
| `allow-all` | routed | routed |
| `communication-only` | held | routed |

When the caller does not declare `kind`, `classifyInboundKind` guesses, and it
leans **`directive` on purpose**: only a leading question word ending in `?`
with no imperative verb reads as chatter. Mis-labelling a directive as
communication is what would let unapproved work through under
`communication-only`.

Routed means `handleWebhookMessage` (`src/main/index.ts`) mints a kanban card
and a god request, and answers `200` with the token and `taskId`. Held means the
message is written to the ledger as `pending`, the token digest is parked in the
`triggers.webhook.heldTokens` kv map, and the caller gets `202` with
`status: 'awaiting-approval'` — accepted, but honestly told no work started.

Either way the caller polls with `GET` + `x-md-webhook-token` (or `?token=`; the
header is preferred so the token stays out of access logs) and gets
`WebhookTaskStatus` for exactly that token, never a listing. The token is never
stored — the card carries `webhook.tokenHash`, a SHA-256 digest, and the held map
keys on the same digest. A token that resolves to nothing is `404` — unknown
token, unknown endpoint id, or both, indistinguishable. A request carrying no
token at all is `401`.

## How Slack messages become hive work

`SlackWebhookServer` implements only as much of the Slack Events API as the
harness needs — no `@slack/bolt`. Every request is verified with an HMAC-SHA256
over `v0:<ts>:<rawBody>` compared in constant time, plus a `REPLAY_WINDOW_SECONDS`
(5 minute) timestamp guard; any failure is `403`, and the raw body is buffered
verbatim because the HMAC needs it unparsed.

Not every channel message triggers. `shouldTrigger` (in the sibling
`slack-trigger.cjs`) fires only on an `@`-mention or a reply inside a thread the
bot was already mentioned in, tracked in the bounded `ActivatedThreads` FIFO. The
bot's own user id is learned from `authorizations[0].user_id` on the first
`event_callback`, avoiding an extra API scope. `SeenEvents` then deduplicates on
`dedupKey(ev)`, because an app subscribed to both `app_mention` and `message.*`
receives one `@`-mention as two callbacks, and because Slack retries un-acked
events. The handler always answers `200` so Slack stops retrying.

## How Telegram reaches the hive without a public port

`TelegramTrigger` long-polls `getUpdates` (25 s timeout) over `fetch`. The
machine **dials out**: no tunnelmole, no bound public port, no signature dance,
because the poll channel is authenticated by the bot token itself.

The token lives in `.env.telegram`, never in `config.json` — config is
renderer-visible and the env file is not. Settings edits it write-only through
`writeTelegramEnv`, and the value never crosses IPC back to the renderer;
`telegramEnvSummary` returns only `{ hasToken, chatId }`.

Access is **claim-once**. With `MD_TELEGRAM_CHAT_ID` unset, the first chat to
send `/start` becomes the owner and the id is appended back to the env file;
every other chat is dropped silently, with no reply that would confirm the bot
exists. `handleUpdate` is where both rules live.

`resolveTelegramRuntime(running, enabled, hasToken, envChanged)` is a pure
function returning `'start' | 'stop' | 'restart' | 'none'`, so the settings IPC
and the boot path share one decision table and a toggle takes effect live. Note
`enabled ?? true`: an unset flag means enabled, which preserves the pre-Settings
behaviour where the env file's presence alone switched the feature on.

## How a worker uses a credential it never sees

`IntegrationBroker` binds `127.0.0.1` only and is never tunneled. A worker calls
`<METHOD> http://127.0.0.1:<port>/i/<integrationId>/<path...>` with its
capability token in `Authorization: Bearer` or `X-MD-Broker-Token`. `handle()`
runs eight checks in order: loopback peer (defence in depth on top of the bind),
capability token, path shape, integration in *this worker's* allowed set, record
exists, record `enabled`, path confined under the integration origin, secret
available.

The confinement that makes this **not an open proxy** is `resolveUpstreamUrl`:
the worker selects an integration by id and never a host, and the resolved URL
must stay on the base origin and under the base path. It rejects `scheme://`
prefixes, protocol-relative `//host` overrides, and `..` segments — checked
after `decodeURIComponent`, so an encoded `%2e%2e` is caught too.

Header hygiene runs both ways. `STRIP_REQUEST` removes `authorization`,
`x-md-broker-token`, `host`, `cookie`, `content-length` and every hop-by-hop
header from the worker's request; then `buildAuthHeaders` injects the real
credential, deleting any same-named key first so the worker cannot shadow it.
`STRIP_RESPONSE` drops `content-encoding` / `content-length` (fetch already
decoded the body, so the upstream values would be wrong) and `set-cookie`.
Capability tokens are `randomBytes(32).toString('base64url')`, in memory only,
never persisted, revoked in `teardownPty`.

## Where the secret actually lives

`src/main/integrations.ts` keeps two things apart. The **registry** is
config-backed CRUD over `IntegrationRecord` — metadata only, safe to persist in
`config.json` and safe to cross IPC. The **secret store** is a separate file,
`<userData>/integration-secrets.json`, written `mode: 0o600`, with each value
encrypted through Electron `safeStorage`.

It fails closed:

``` typescript
if (!safeStorage.isEncryptionAvailable()) {
  return { ok: false,
    error: 'OS secret encryption is unavailable; refusing to store a secret in plaintext' };
}
```

There is no plaintext fallback. `getSecret` is main-internal and has no IPC
handler; the renderer's only view is `listRecordsRedacted()`, which destructures
`secretRef` away and replaces it with `hasSecret: boolean`. `registryClient.ts`
enforces the same invariant from its side: a secret flows one way, from the form
into `save()`'s `integrationsSetSecret` call, and is never read back.

## Which MCP servers ship on

`MCP_CATALOG` declares stdio MCP servers and tiers them for consent. Only
`safe-readonly` ships on. `defaultEnabled` is a hand-written per-entry field
held equal to `tier === 'safe-readonly'` by convention only — the invariant is
asserted in a comment (`mcpCatalog.ts:46-47`) and nothing enforces it.
`defaultMcpDefaults()` then seeds `config.mcpDefaults` from that field, so those
two cannot drift. `filesystem` and `git` carry a literal `<cwd>`
placeholder that the spawn-time merge replaces with the agent's own working
directory, so they are never whole-disk.

This is a *different transport* from the integrations registry, not a competing
one — stdio MCP servers versus HTTP REST endpoints behind the loopback broker.
Labels are kept aligned where they overlap (github/db/email/search).

## Which schedules wake god on a clock

`src/main/config.ts` owns the `ScheduledMission` shape and three shipped
missions. Only the trigger-plane part of that file is covered here.

| Mission | Cadence | Ships | What fires |
|---|---|---|---|
| `OPS_STANDUP_MISSION` | 1 h | enabled | A god request (or the cheap `runStandupClerk` when `standupTarget` is `clerk`); skipped while the floor is quiet |
| `ACTIONABLE_WATCH_MISSION` | 2 min | enabled | Mails god **only on a transition** — an actionable card id absent from `reportedActionableIds` |
| `COMPACT_MAINTENANCE_MISSION` | 2 h | disabled | Nothing but the auto-compact signal (`kind: 'compact'` makes `syncMissions` skip the dispatch) |

`ACTIONABLE_WATCH_MISSION.body` is empty **by design** — `armActionableWatch`
computes the mail per fire. The deleted heartbeat mission's configured body was
prose its arm never sent, and `stripHeartbeatMissions` exists so an install that
had the heartbeat *enabled* does not fall through to the generic dispatch path
and start sending that dead text every interval. Pinned by
`test/heartbeat-removal.test.cjs`.

`migrateTriggersV1` runs from inside `readConfig`, so it completes before any
consumer can observe the config. It folds the legacy single webhook
(`webhookSecret` / `webhookEnabled`) into one `WebhookTrigger` with the stable id
`legacy` — skipped when `webhookTriggers` is already populated, because
re-synthesising an entry would resurrect a revoked endpoint — and bumps
`compact-maintenance` from 1 h to 2 h **only if it still reads exactly 1 h**,
leaving a hand-tuned interval alone.

## What the ledger records

`src/main/triggerHistory.ts` writes `<userData>/trigger-history.json`, both
directions, newest first on disk as well as in memory (the Triggers tab re-reads
it on every render, so display order makes the read a slice instead of a sort).

It lives outside `config.json` because it is append-heavy while `writeConfig`
rewrites config wholesale, and because it is disposable — losing history must
never cost the user their settings. Nothing here throws at its caller: the caller
is always on a request path where failing to *record* an event must not fail the
event.

The security rule is structural, not a convention. `appendTriggerHistory` builds
the entry **field by field** rather than spreading the caller's object, so a
caller that hands over a whole `WebhookTrigger` (which carries `secret`) still
gets only the ledger fields persisted.

## Workflows

### An outside POST becomes hive work

Picking up where the gate above leaves off, once the POST is authenticated and
its body has passed the endpoint's schema:

| Step | Action | Location |
|---|---|---|
| 1 | Mint a 192-bit token; resolve mode and kind | `handleWebhookMessage` (`src/main/index.ts`) |
| 2a | Auto-allowed: card + god request, `decision: 'auto-allowed'`, `200` | `dispatchWebhookWork`, `appendTriggerHistory` |
| 2b | Held: `decision: 'pending'`, digest into `heldTokens()`, `202` | `appendTriggerHistory`, `persistHeldTokens` |
| 3 | Operator decides; approve takes the identical path 2a took | `triggerHistory:decide` IPC |
| 4 | Caller polls `GET` with its token | `lookupWebhookStatus` |

### A worker calls a registered REST API

| Step | Action | Location |
|---|---|---|
| 1 | Spawn grants a capability over `integrations.enabledIds()` | `IntegrationBroker.grant` ← `processSpawnRequest` |
| 2 | `MD_BROKER_URL` + `MD_BROKER_TOKEN` injected into the PTY env | `src/main/index.ts` `brokerEnv` |
| 3 | Worker calls `/i/<id>/<path>` on loopback | `IntegrationBroker.handle` |
| 4 | Path confined under the integration origin | `resolveUpstreamUrl` |
| 5 | Secret decrypted, injected as the upstream header | `getSecret` → `buildAuthHeaders` |
| 6 | Response streamed back with response headers sanitised | `IntegrationBroker.forward` |
| 7 | PTY teardown revokes the token | `IntegrationBroker.revoke` ← `teardownPty` |

## Integration points

**Into the hive.** `dispatchWebhookWork` writes the card under
`hive.withLedgerLock` and routes to god through `hive.send`. The card is what the
caller polls, so a failed card write returns `false` and the endpoint answers
`500`; the god send is best-effort by comparison, because the card already exists
and is pollable.

**Into the renderer.** Slack and Telegram hand text to the renderer
(`slack:incomingMessage`, `telegram:incomingMessage`) with a per-message
`autonomyPreamble` carrying that channel's reply handle; the renderer enqueues
into Michael's queue. `notifyTriggerHistoryUpdated` pushes
`triggerHistory:updated` so the Triggers tab live-refreshes.

**Into PTY env.** `processSpawnRequest` (`src/main/index.ts:6295`) calls
`integrationBroker.grant` and puts `MD_BROKER_URL` / `MD_BROKER_TOKEN` into
`AgentSpawnOptions.env`. Separately `process.env.MD_SLACK_REPLY_CONFIG` and
`MD_TELEGRAM_REPLY_CONFIG` point the bundled `md-slack-reply.cjs` /
`md-telegram-reply.cjs` helpers at their loopback endpoints.

**Reply endpoints.** Three loopback servers share one trust shape —
`SlackReplyServer`, `TelegramTrigger`'s `/reply`, and `IntegrationBroker`. All
bind `127.0.0.1`, all check a constant-time bearer token, and none is ever placed
behind the tunnel; only the webhook and Slack event ports are forwarded.
`SlackReplyServer` and `IntegrationBroker` additionally check
`isLoopback(req.socket.remoteAddress)`.

> ⚠ **VERIFY:** Three module headers (`src/main/integrations.ts`,
> `src/main/integrationBroker.ts`, `src/shared/integrations.ts`) cite
> `hive/docs/integrations-spec.md` as *"the contract"*; `registryClient.ts`
> quotes its §2 and §6 by number, and `src/shared/integrations.ts:298` cites §8.
> That file does not exist — `hive/docs/` holds
> only `integration-templates.md`, and a repo-wide `find` for the name comes back
> empty. Checked the working tree only, not the history of a deleted path.
> (raised 2026-08-22)

## Gotchas

- **`TelegramTrigger.stop()` cannot actually abort the in-flight poll.** The
  docstring says *"`stop()` aborts the in-flight poll"* and `stop()` calls
  `this.abort?.abort()`, but `abort` is declared `= null` at `telegram.ts:133`
  and **never assigned an `AbortController`** anywhere in the class. The
  `this.abort?.signal` passed to `getUpdates` is therefore always `undefined`.
  What actually stops the loop is the `running` flag, checked after the fetch
  resolves — so a stop or a `resolveTelegramRuntime` restart can sit for up to
  the 25 s poll timeout before the old loop exits.

- **The Telegram reply discovery file is not mode-restricted.**
  `startReplyEndpoint` writes `{ port, token }` to `telegram-reply.json` with a
  bare `writeFileSync` (no `mode`), so it lands at the process umask. Both
  siblings that hold equivalent material are explicit: `slack-reply.json` is
  written `{ mode: 0o600 }` and `integration-secrets.json` likewise.

  > ⚠ **INTENT UNVERIFIED:** Was the omitted `mode: 0o600` on
  > `telegram-reply.json` a decision or an oversight? Commit `b587365`
  > ("add Telegram trigger") describes the loopback token design but says nothing
  > about file permissions, and nothing in the tests or later commits touches it.
  > (raised 2026-08-22)

- **An unparseable endpoint schema disables schema validation entirely.**
  `parseSchema` returns `undefined` on a JSON parse failure, and
  `validateAgainstSchema` treats a non-object schema as *accept*. This is
  deliberate — a mistyped schema must not lock a caller out of an endpoint whose
  secret they legitimately hold — but it means the only surviving check is the
  unconditional `message` requirement in `handleCreate`.

- **Disabling an integration takes effect immediately; enabling one does not.**
  A worker's capability set is snapshotted from `integrations.enabledIds()` at
  spawn and frozen for its lifetime, so an integration enabled afterwards stays
  unreachable to a running worker. Disabling *is* honoured live, because
  `handle()` re-resolves the record and re-checks `rec.enabled` on every request.

- **A `202` is not a queue position.** A held message has no kanban card at all —
  the card is what approval creates. Its `GET` resolves through the `heldTokens()`
  digest map, not the task scan. If the entry ages past `TRIGGER_HISTORY_LIMIT`
  (500) while the operator deliberates, it becomes undecidable and
  `pruneHeldTokens` drops the mapping, after which the caller's polls return
  `404`.

- **Restarting the webhook server breaks every other caller.** The tunnel URL is
  ephemeral, so `reconcileWebhookServer` re-points a live server through
  `setEndpoints` instead of restarting it. A `start()` that binds the port but
  fails to open the tunnel returns `ok: false` *with the security boundary live* —
  `startWebhookServer` checks `server.listening()` before dropping the instance,
  because dropping it there would leak an unstoppable listener.

- **The Slack path has no request budget.** `SlackWebhookServer` has the HMAC,
  the replay window and `MAX_BODY_BYTES`, but no equivalent of the generic
  webhook's `RATE_LIMIT` / `PER_ENDPOINT_RATE_LIMIT` fixed windows — despite both
  being tunnel-exposed public surfaces.

  > ⚠ **INTENT UNVERIFIED:** Why does the generic webhook carry fixed-window rate
  > limits while the Slack server, on the same public tunnel shape, carries none?
  > `0357ab0`, which introduced `RATE_LIMIT`, describes the surface as *"modeled
  > on the Slack webhook"* and adds a *"body cap + fixed-window rate limit ahead
  > of any parse/crypto"* — without a word about why the model it copied has
  > neither. (raised 2026-08-22)

- **`registryClient.ts`'s header comment is stale.** It says *"⚠️ The preload
  bridge is NOT landed yet (Jim owns it)"* and describes an in-memory mock
  fallback. The bridge has since landed — `integrationsList` is at
  `src/preload/index.ts:1569` and all six `integrations:*` handlers exist in
  `src/main/index.ts` — so `liveBridge()` resolves and `mockClient` is
  unreachable in the packaged app.

  > ⚠ **VERIFY:** Is `mockClient` deliberately retained for a browser-only dev
  > server, or is it dead code? Checked the preload bridge and the main IPC
  > handlers only, not the renderer's dev entrypoints. (raised 2026-08-22)

- **Several MCP catalog entries are unverified.** `time`, `fetch`, `git`, `db`,
  `email-calendar` and `search-with-key` carry `// TODO-verify` on their launch
  spec — the transport (uvx vs an npm port) or the provider package was assumed,
  not confirmed against an installed server. A server that fails to resolve is
  non-fatal to the agent by design.

- **`getSecret` has no IPC handler, and that is load-bearing.** Every module
  header in the secret path repeats it. If one is ever added, the redaction in
  `listRecordsRedacted`, the write-only `save()` in `registryClient.ts`, and the
  field-by-field construction in `appendTriggerHistory` all become decorative.

## Key files

| File | What lives in it |
|---|---|
| `src/shared/triggers.ts` | The four trigger types, `TriggerMode`, `isAutoAllowed`, `classifyInboundKind`, `validateAgainstSchema`, `TriggerHistoryEntry`, the context-trigger defaults |
| `src/main/webhook.ts` | `WebhookServer`: the multi-endpoint secret gate, rate limiting, schema check, tunnel |
| `src/main/slack.ts` | `SlackWebhookServer` (HMAC + replay guard), `postSlackReply`, `SlackReplyServer` (loopback) |
| `src/main/telegram.ts` | `TelegramTrigger` long-poll, claim-once chat allowlist, `.env.telegram` read/write, loopback `/reply` |
| `src/main/triggerHistory.ts` | The append-only ledger and its `pending` → `approved`/`rejected` amendment |
| `src/main/config.ts` | `ScheduledMission` + the three shipped missions, `stripHeartbeatMissions`, `migrateTriggersV1`, `withTriggerDefaults`, and the `webhookTriggers` / `contextTrigger` / `orgTrigger` / `integrations` fields |
| `src/shared/integrations.ts` | `IntegrationRecord`, `validateIntegrationRecord`, `validateBaseUrl`, `buildAuthHeaders`, `resolveUpstreamUrl`, `INTEGRATION_TEMPLATES` |
| `src/main/integrations.ts` | Registry CRUD + the `safeStorage`-encrypted secret store |
| `src/main/integrationBroker.ts` | The loopback proxy, capability grants, header hygiene, upstream forwarding |
| `src/renderer/src/integrations/registryClient.ts` | The renderer's one doorway to the registry; write-only secrets |
| `src/shared/mcpCatalog.ts` | `MCP_CATALOG`, tiers, `defaultMcpDefaults()`, `isSafeReadonlyMcp` |

## Not covered

Only the trigger and integration surface of the 937-line `src/main/config.ts` is
documented above; its provider, breaker, knowledge-graph, realtime, Free Flow and
reflection sections belong to other docs. `slack-trigger.cjs` (`shouldTrigger`,
`ActivatedThreads`, `SeenEvents`, `dedupKey`) is required by `slack.ts` but sits
outside the globs; it is pinned by 31 cases in `test/slack.test.cjs`. The
main-process orchestration consuming this plane lives in `src/main/index.ts` and
is described here only from the seam.
