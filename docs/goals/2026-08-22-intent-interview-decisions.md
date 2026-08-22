# Intent-interview decisions — 2026-08-22

Fix decisions from the intent interview over the six coverage-round docs
(`ide.md`, `lifecycle.md`, `providers.md`, `realtime.md`, `remote.md`,
`telemetry-collector.md`). Every decision is Stefan's (2026-08-22); D5 and D7
were delegated to the interviewer's recommendation and accepted. This file is
the intake for harness cards — one card per item; check an item off when its
card exists. Each doc's closed marker points here by D-number.

| # | Subsystem | One-liner |
|---|---|---|
| D1 | realtime | `confirmAccepted()` passes negations ("don't kill Jim") |
| D2 | ide | CHANGES list uses agent `root`, siblings use `gitRoot` |
| D3 | telemetry-collector | `burn5h` sums cumulative OTLP rows as deltas |
| D4 | telemetry-collector | error-storm arm matches `*error*` substring |
| D5 | telemetry-collector | `StubUsageProvider` is dead code — delete |
| D6 | remote | `telegram-reply.json` written without `mode: 0o600` |
| D7 | remote | Slack webhook server has no rate limit |
| D8 | providers | `hasOssQuickPicks` excludes `qwen` |

## D1 — negation screening in voice confirms

- [ ] carded
- **Where:** `src/main/realtimeActions.ts:314` (`confirmAccepted`)
- **Defect:** the check only asks whether the confirm verb appears as a whole
  word, so `confirmAccepted('don\'t kill Jim', 'kill')` returns true. Bare
  affirmations are screened exactly; negations are not screened at all.
- **Decision:** never considered — a real gap, fix owed.
- **Fix shape:** add negation screening ahead of the verb match (reject
  phrases where the verb is negated), keep the existing bare-affirmation
  behavior. Doc: `docs/architecture/realtime.md` §voice confirms.

## D2 — CHANGES list root

- [ ] carded
- **Where:** IDE panel CHANGES list (see `docs/architecture/ide.md`; HISTORY
  and COMPARE were built against `gitRoot` in commit `7797d20`)
- **Defect:** CHANGES stays on the agent's `root` (worktree) while its two
  sibling panes deliberately resolve `gitRoot`.
- **Decision:** oversight — CHANGES should follow `gitRoot` like its siblings.

## D3 — burn5h unit mismatch

- [ ] carded
- **Where:** `src/main/burn.ts` (`parseRow`), writers `src/main/index.ts:1674`
  (`runBreakerBeat`, cumulative ~30 s snapshots) and `src/main/hooks.ts:323`
  (`CostSample`, per-response deltas)
- **Defect:** `burn5h` sums every ledger row alike, so cumulative OTLP
  snapshots inflate the window total by roughly the beat count. No dedup or
  diff step exists; `test/burn-window.test.cjs` fixtures are all deltas.
- **Decision:** bug — fix owed. The OTLP path's rows must be diffed (or the
  writer must emit deltas) before the window sum.

## D4 — error-storm substring match

- [ ] carded
- **Where:** `src/main/telemetry.ts` (`ingestLogs`), shipped in `fd05989`
- **Defect:** `name === 'api_error' || name.includes('error')` feeds the
  error-storm breaker arm, so any future `*_error` event name counts toward
  `errorStormLimit` — an arm that escalates up to killing a PTY.
- **Decision:** narrow to `name === 'api_error'` exactly. No current behavior
  changes (only one event name contains "error" today); the fix removes the
  future coupling.

## D5 — delete StubUsageProvider

- [ ] carded
- **Where:** `src/main/usage.ts:83`
- **Defect:** zero callers since integration wired the collector itself as
  provider; only the interface *types* are still imported (`breaker.ts:26`,
  `hive.ts:41`).
- **Decision:** leftover scaffolding from the two-lane build (2026-06-06) —
  delete the class, keep the types. (Delegated; recommendation accepted.)

## D6 — telegram-reply.json file mode

- [ ] carded
- **Where:** `src/main/telegram.ts` (`startReplyEndpoint`)
- **Defect:** `{ port, token }` written with bare `writeFileSync` at process
  umask, while both siblings holding equivalent secret material
  (`slack-reply.json`, `integration-secrets.json`) are explicit `mode: 0o600`.
- **Decision:** oversight — write it `mode: 0o600` like the siblings.

## D7 — Slack webhook rate limit

- [ ] carded
- **Where:** `src/main/slack.ts:112` (`SlackWebhookServer`)
- **Defect:** HMAC, replay window and `MAX_BODY_BYTES` exist, but none of the
  generic webhook's `RATE_LIMIT` / `PER_ENDPOINT_RATE_LIMIT` fixed windows —
  on the same public tunnel shape. `0357ab0` added the generic limits "ahead
  of any parse/crypto" to a surface "modeled on the Slack webhook".
- **Decision:** gap — give the Slack server the same fixed-window budget.
  (No prior decision existed; recommendation accepted.)

## D8 — qwen in the OSS quick-picks

- [ ] carded
- **Where:** `src/shared/ossModels.ts:92` (`hasOssQuickPicks`)
- **Defect:** covers `opencode`, `crush`, `pi` only; `qwen` drives any
  OpenAI-compatible endpoint and its preset predates the quick-picks
  (`3ad2089`, 2026-06-16 vs `f062dab`, 2026-06-22).
- **Decision:** oversight — add `qwen`.

## Decided without a card

`lifecycle.md:84` — branch retirement kill-switch: **leave as-is, deliberate**
(Stefan, 2026-08-22, after discussion). The merge-watcher arming is the
pipeline's opt-in and retirement only deletes proven-landed branches with a
pushed archive tag; no code change owed. Rationale recorded in the marker's
resolution in `docs/architecture/lifecycle.md`.
