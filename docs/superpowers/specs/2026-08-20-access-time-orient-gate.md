# Spec: access-time orient gate (orient-first backstop, Card B)

Card `agent-spec-card-b-access-time--2026-08-20`, follow-up to Card A
(`docs/superpowers/specs/2026-08-20-dispatch-orient-injection.md`, landed as
`db1139c`). Approved by Stefan in Robert's pane ("propose the cards to god.
Sounds good imho"). Author: Robert.

## 1. Problem and relationship to Card A

Card A injects an ORIENT FIRST block at dispatch time — it fires when the
dispatch TEXT references a docs-carrying directory. It cannot see directories
the agent discovers mid-task: a path from a grep result, a mail body, a board
entry, its own reasoning. Card B closes that hole at the ACCESS boundary: a
PreToolUse gate that, when a tool call resolves into a directory subtree
carrying a `CLAUDE.md` or `AGENTS.md` the session has not yet read, refuses
ONCE with a pointer naming the file, records the directory for the session,
and passes every later call into it. A is primary, B is the backstop.

Settled constraints carried in from the approved card (not re-decided here):
once per directory per session; pass SILENTLY when no docs file exists; the
refusal NAMES the file (self-healing); worktree paths resolve to the OWNING
installation root via an upward walk; trigger tools are Read, Grep, Glob,
Edit, Bash; hiveGate (`26d7de2`) is the precedent that PreToolUse gates work
on this floor; coverage varies by engine and that is accepted.

## 2. Where the gate lives: the main process, not a hook script

The floor's PreToolUse gating already runs INSIDE the Electron main process:
every engine bridge POSTs hook events to the Unix socket `HookServer` owns
(`src/main/hooks.ts`), and the server's return value is relayed back as the
hook decision. Two gates already sit at that boundary and return
`hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason }`:
the HITL control gate (`hooks.ts:402-419`) and god's shared-state gate
(`hooks.ts:421-448`, logic in `src/main/hiveGate.ts`).

Card B is a third block in that chain, wired in `handleEvent` DIRECTLY AFTER
the sharedStateGate block (so an operator pause or a shared-state refusal
wins first and is never double-reported), for ALL agents including god —
god's own prompt carries the same orient-first rule, and the once-per-session
cap bounds the cost of including him.

Consequences of running in main:

- **B imports `orientationBlock` directly** (`hive.ts:45` already does:
  `import { orientationBlock } from './orientInject'`). No `toString`
  serialization — that pattern exists only for the generated `bin/` CLIs.
- Logic goes in a new pure module `src/main/orientGate.ts` (no electron, no
  fs — the hiveGate house pattern, `hiveGate.ts:33-34`), probe injected, so
  tests load it directly. `hooks.ts` supplies `existsSync` and the state.

## 3. Exports B calls (the reuse contract)

B calls exactly ONE Card A export: **`orientationBlock(searchText,
assigneeCwd, assigneeProvider, registryCwds, probe)`** from
`src/main/orientInject.ts` — with `searchText` = the extracted text of §4,
`assigneeCwd` = `''` (S4, the always-include-own-cwd rule, is dispatch
semantics; B handles the agent's cwd via the §6 exemption instead — `''` is
skipped at `orientInject.ts:152-153`), `assigneeProvider` = the agent's
registry provider (picks CLAUDE.md vs AGENTS.md when both exist),
`registryCwds` = non-archived registry cwds exactly as the dispatch CLI
assembles them (`hive.ts:7013-7019`), `probe` = `existsSync`.

That one call IS the detection and the render: S1 full-path registry match,
S2 basename idiom (≥6 chars — this is what catches `psql -d merlin_hlog`,
the incident class with no filesystem path at all), S3 absolute-path upward
walk to the owning docs root (worktrees resolve to their checkout), deepest
root wins, docs-less roots drop silently, fail open.

**Root extraction — the parse contract.** `orientationBlock` returns a
rendered string, not roots. B parses its bullet lines with
`/^- (\/.+?): read (CLAUDE\.md|AGENTS\.md) first/` per line. This couples B
to A's render line; the coupling is deliberate (god's instruction: reuse, do
not reimplement) and guarded by acceptance case 16 — a tripwire test that
runs the REAL `orientationBlock` on a fixture and asserts the parse, so a
render change fails B's suite before it ships. The parsed bullet lines are
reused VERBATIM in the refusal (§7) — they already carry the root, the
provider-correct docs filename, and the graphify hint. The `(+N more)`
overflow line is not parsed; overflow roots simply get their own refusal on
their next access (consistent with once-per-root).

Decided against: a shared `resolveOrientRoot()` refactor of orientInject.ts
(touches Jessica's landed code and its CLI serialization for zero catch-rate
gain) and a private re-implementation of the walk (two walkers drift).

## 4. What text is scanned, per tool

Extraction is a per-tool field allowlist on `tool_input` (never
`JSON.stringify(tool_input)` — Edit/Write content fields quote paths from
foreign directories and would over-fire):

| Tool (normalized lowercase) | searchText |
|---|---|
| `read`, `edit` | `tool_input.file_path`, else `tool_input.path` (pi naming) |
| `grep`, `glob` | `tool_input.path` — absent (defaults to cwd) → pass |
| `bash` | `tool_input.command`, first 32 KB |
| anything else | pass (Write/NotebookEdit deliberately not gated — the approved card names five tools; extending is a one-line allowlist change later) |

**Bash stays in scope.** The motivating incident (2026-08-20) was psql-only
access — `psql -d merlin_hlog` carries no path, and only S2's basename match
fires on it. Dropping Bash would drop the incident class B exists for. The
cheap-correct extraction is: hand the RAW command string to
`orientationBlock` and let S1/S2/S3 scan it. No shell parsing, no
quote-masking (hiveGate's `maskQuoted` exists to stop SMUGGLING around a
hard ban; B's threat model is forgetting, not evasion — a quoted or inert
path mention that false-positives costs one refusal per root per session,
capped by design). Relative-path-only commands inside the agent's cwd
resolve to exempt roots (§6) and pass.

## 5. Session state

- **Where:** main-process memory, owned by the `hooks.ts` wiring:
  `Map<agentId, { sessionKey: string, roots: Set<string> }>`. One entry per
  agent — when an event arrives with a different `session_id`, the entry is
  REPLACED (old set dropped). Memory is bounded by fleet size.
- **Key:** `session_id` from the hook payload (claude sends it natively; the
  pi bridge posts it explicitly, `hive.ts:8112`); when absent, the constant
  `'proc'` — the gate then fires once per agent per harness run.
- **`/new` / `/clear`:** new `session_id` → fresh set → each root refuses
  once more. Correct: a fresh session has read nothing.
- **Harness restart:** in-memory state is lost → refire once per root.
  Deliberate, not a gap: after a restart every session's actual
  read-history is unknown, and one extra self-healing refusal per root is
  cheaper than persisting state that can go stale (no file, no schema, no
  cleanup). Decided against persistence.

Two ways a root becomes "seen": (a) it was named in a refusal (recorded
BEFORE the deny returns — §7); (b) the session READS a docs file — any
`read` whose target basename is `CLAUDE.md` or `AGENTS.md` marks its
directory as seen and passes unconditionally. (b) both prevents the absurd
deny-of-the-pointer deadlock and gives voluntary orienters a free pass.

## 6. The cwd exemption (why most calls never probe)

Engines auto-load their docs chain for the session cwd: claude loads
`CLAUDE.md` from cwd upward and discovers nested ones on access; pi loads
`AGENTS.md`. Refusing there is pure noise. So:

- **Fast path:** for path tools, a path inside the session cwd subtree
  passes before any probe or `orientationBlock` call (one `startsWith`).
- **Root exemption:** a resolved root `R` passes when the session cwd starts
  with `R` (R is ancestor-or-self of cwd — the auto-loaded upward chain).
- Session cwd = payload `cwd` when it is a string (claude sends it,
  `hooks.ts:435`), else the agent's registry cwd (pi's bridge sends none).

A path under cwd that resolves to a NESTED docs root under cwd is exempt via
the fast path; engines' own nested discovery covers it. Cross-directory
access — the failure class — is exactly what remains.

## 7. Refusal mechanics

The gate DENIES the call (`permissionDecision: 'deny'`) — not
pass-with-warning, because `additionalContext` lands after the tool result
is already in context: the un-oriented read would have happened, which is
Card A's moment, not B's. The approved card text says refuse once; this is
it.

**Record-then-deny, deadlock-free by construction:** the fresh roots are
added to the session's seen-set BEFORE the deny is returned. The agent's
verbatim retry passes — no second refusal is possible, whatever the agent
does in between. Flow: extract → block = `orientationBlock(...)` → `''` →
pass; else parse roots → drop seen roots and cwd-exempt roots → none left →
pass; else record all fresh roots, deny once naming all of them.

Refusal text (bullet lines verbatim from A's render):

```
ORIENT FIRST (access gate): this call enters directories whose onboarding docs this session has not read.
- /opt/django/projects/merlin_hlog: read CLAUDE.md first and follow what it mandates. Knowledge graph present: run `graphify query "<question>"` before any grep.
Read the file(s) above, then re-run this exact call — it will pass. This gate fires once per directory per session.
```

## 8. Per-engine coverage (verified per bridge)

The gate itself is engine-agnostic — it answers the socket; whether a deny
takes effect depends on each bridge relaying it. Unknown tool names and
absent fields pass, so partially-covered engines degrade to no-op, never to
breakage.

| Engine | Deny channel today | B status |
|---|---|---|
| claude | native `hookSpecificOutput` relay, proven live by HITL + hiveGate (`hooks.ts:411-417`) | **v1, day one** |
| agy | shim translates deny → `{decision:'deny', reason}` (`hive.ts:8021`) | v1 (free; tool names pass through, unmatched names no-op) |
| grok | shim translates deny (`hive.ts:8609-8611`) | v1 (same) |
| pi | bridge posts PreToolUse WITHOUT awaiting the response — the reply is read later, for steer only (`hive.ts:8112`, post reader `:8087-8090`) → **cannot deny today** | phase 2: make the `tool_call` handler await the socket reply and apply pi's extension block mechanism. Pi CAN block in principle ("Pi auto-approves tools in non-interactive runs unless an extension blocks", `hive.ts:8062-8064`) but the exact API shape is UNVERIFIED — verify against pi 0.84's .d.ts before building, and re-smoke-test the bridge (it was live-verified 2026-08-15; adding an await path invalidates that) |
| codex | no PreToolUse deny channel (notify-based, thinner by design) | out of scope — Card A covers |
| opencode | plugin posts `tool.execute.before` and reads the reply for steer only (`hive.ts:8224`) | out of scope — same reasoning; LIVE-UNVERIFIED bridge anyway |

This matches the settled framing: A primary, B backstop, coverage varies.

## 9. Cost

Fires on every PreToolUse on the floor, so per-call work is the budget:

- Inside-cwd path call (the overwhelming majority): ONE `startsWith`. No
  probe, no regex, no allocation of note.
- Outside-cwd path call / any Bash call: one `orientationBlock` run — ~N
  `indexOf` scans + ≤N regex constructions (N = registry cwds, ~20-30 today)
  over ≤32 KB of text, plus a handful of `existsSync` stats (S3 walk ≤8
  steps, docs probes ≤2 per surviving root). No file is ever opened or read.
- Precedent: hiveGate already runs a char-by-char quote mask over EVERY god
  Bash command (`hiveGate.ts:128+`); B's per-call work is the same order.
- Seen-root short-circuit: roots already recorded are dropped after the
  parse; the probe cost repeats only until the root is seen, then only the
  `orientationBlock` string scan remains for outside-cwd calls.

No cross-call memo of stat results in v1 (stats are ~µs; a TTL cache is rot
surface). Add one only if telemetry ever shows the gate in a profile.

## 10. Failure behavior and invariants

- FAIL OPEN, three layers: `orientationBlock` catches internally and returns
  `''` (`orientInject.ts:198-200`); the gate's decide function wraps its own
  extract/parse/state work in try/catch → pass; the `hooks.ts` call site
  wraps the gate → no `hookSpecificOutput`. A broken gate must never block a
  tool call.
- The gate never blocks the SAME (agent, session, root) twice.
- A deny is always accompanied by the recorded root(s) — never deny without
  recording (that would be the deadlock).
- Reading a docs file is never denied.
- Ordering: HITL control gate → sharedStateGate → orient gate. B never
  fires on a call an earlier gate already denied.
- The gate does not write files, does not log to the ledger; it emits the
  same `emitControl` telemetry the sibling gates do (`hooks.ts:409, :438`)
  so refusals are visible on the floor.

## 11. Testing

`test/orient-gate.test.cjs` (node --test, one line appended to
`test/focused.list`), loading `src/main/orientGate.ts` directly with fake
probes (a `Set` of existing paths, the orient-inject house pattern) and a
fake seen-state. The acceptance list below is the test list. The tripwire
case (16) runs the real `orientationBlock` import — no mocking — so A's
render and B's parse can never drift apart silently.

## 12. Acceptance

1. `read` of `/opt/django/projects/merlin_hlog/qbase/qslip/models.py`
   (agent cwd elsewhere, `merlin_hlog` a registered cwd whose root carries
   `CLAUDE.md`) → deny; reason names `/opt/django/projects/merlin_hlog` and
   `CLAUDE.md`; root recorded.
2. The byte-identical call repeated → passes. (Deadlock-freedom.)
3. A DIFFERENT path under the same root → passes (root already seen).
4. `read` of a path inside the session cwd subtree → passes, and the probe
   was never invoked (fast-path assertion).
5. Root is an ancestor of the session cwd (cwd
   `/opt/.../merlin_hlog/qbase`, access resolving to `/opt/.../merlin_hlog`)
   → passes (auto-loaded upward chain).
6. `read` of `/opt/.../merlin_hlog/CLAUDE.md` on a fresh session → passes
   AND marks the root seen; a following read into the subtree passes.
7. `bash` with `PGPASSWORD=x psql -h localhost -U merlin -d merlin_hlog`
   (no filesystem path in the command) → deny via S2 basename match. (The
   incident case.)
8. `bash` touching `/some/unregistered/checkout/.worktrees/wt1/src/x.py`
   where `/some/unregistered/checkout` carries `AGENTS.md` → deny naming
   the OWNING checkout root (S3 upward walk through the worktree).
9. Path into a docs-less directory (`/tmp/x/y`) → pass, silently.
10. `grep`/`glob` without a `path` field → pass.
11. Unknown tool name, or missing/malformed `tool_input` → pass.
12. Probe that throws, empty registry, or an internal error → pass (fail
    open; assert no exception escapes the gate).
13. Deny reason contains the verbatim A bullet line for the root (including
    the graphify hint when `graphify-out/graph.json` probes true) and the
    "re-run this exact call" + "once per directory per session" sentences.
14. One `bash` command referencing TWO fresh roots → a single deny naming
    both; both recorded.
15. Same agent, new `session_id` → seen-set reset; the first access into a
    previously-seen root denies once again.
16. Tripwire: the REAL `orientationBlock` run on a fixture text + fake probe
    set yields a block whose bullet lines the parse regex extracts back to
    the expected roots. (Fails if A's render line ever changes shape.)
