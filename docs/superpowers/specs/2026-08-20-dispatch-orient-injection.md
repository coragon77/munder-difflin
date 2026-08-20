# Spec: dispatch-time orientation injection (orient-first as mechanism, Card A)

Card: agent-harness-orient-first-mus-2026-08-20 · Author: Robert (advisory) · Status: DRAFT for god's review
Sibling: Card B (access-time PreToolUse gate, agent-harness-b-access-time-or-2026-08-20) is the backstop layer and is NOT covered here.

## 1. Problem

The orient-first rule ("read the target directory's CLAUDE.md/AGENTS.md before grepping,
reading source, or forming a plan") exists as prose in every worker's spawn prompt and
still fails: on 2026-08-20 an advisory agent worked a merlin_hpt task entirely from board
+ mail context, ran psql against the installation's database without ever reading its
CLAUDE.md, and the operator had to intervene twice. The forced docs pass then materially
changed the design under discussion. Root cause: the rule's trigger ("directories the task
touches") never fires when the facts arrive via board/mail and the access is not a file
read. The fix is a mechanism at the one place every task passes through: the dispatch.

Operator's requirement (Stefan, 2026-08-20, near-verbatim): every time the harness lets an
agent access code on his system it must check for AGENTS.md/CLAUDE.md and read it, and use
the doc tree + graphify he installed — "this is mandatory or you will just waste tokens
and produce a subpar solution."

## 2. Where the injection happens

`hive-dispatch` is the single sanctioned todo→doing path (its own refusal texts enforce
this), so it is the choke point. The CLI is generated from the `HIVE_DISPATCH_CLI`
template string in `src/main/hive.ts` (currently starting ~:6619) and rewritten to
`$HIVE_ROOT/bin/hive-dispatch` at bootstrap (~:888) — the change ships via harness
restart, never by editing `hive/bin` in place.

Injection point: inside the CLI's `main()`, AFTER the locked ledger transaction (so
`cardId`/`cardTitle` and the card object are known) and BEFORE the contract mail is
composed (~:7016-7038). The injected block is appended to `body` so it rides the contract
mail itself — the artifact the worker reads at its task boundary — and is therefore
automatically archived in outbox/.sent and the recipient's inbox/.done (that archive IS
the audit trail; no log.jsonl write, see §7).

Implementation pattern: the detection/render logic is ONE pure function defined in
`src/main/hive.ts` (or a sibling module) and serialized into the CLI template the same way
`cardHeld` already is (`const cardHeldFn = ${cardHeld};`, ~:6808). Main-process tests then
exercise exactly the code the CLI runs.

Secondary site, in scope because it is trivial: `hive-hire` (HIVE_HIRE_CLI, same file)
takes a REQUIRED `--cwd` — no detection needed, the target directory is declared. Append
the same block (for that one directory) to the intern's objective before it is written
into the spawn request. Interns are the least-oriented agents on the floor; skipping them
would reopen the gap at its widest point.

## 3. Detection: which directories a dispatch references

Inputs (concatenated into one search text):

1. the contract body (`--body`/stdin),
2. the card TITLE (`card.title` — for `--card` dispatches read from the ledger inside the
   lock; for `--title` dispatches the flag value),
3. the card NOTES (`card.description` — the field `hive-card --notes` and the tasks-tab
   "add" feature write; absent on most cards, include when present).

Rationale for 2+3 (god's question Q2): yes, include both. Titles routinely name the
directory ("merlin_hpt: fix the …") while the contract says "the installation"; notes are
human-written context the contract does not repeat. Both are already in hand at the
injection point — zero extra I/O. The card id is NOT scanned (it is a slug of the title;
scanning it adds only false positives like `agent-merlin-hpt-…` → already covered by the
title).

Signals, evaluated in order; a hit resolves to an ORIENTATION ROOT (the directory whose
CLAUDE.md/AGENTS.md must be read):

S1. Registry cwd match — full path. Normalize every non-archived `registry.json`
    `agents[*].cwd` (strip trailing `/`). A cwd is referenced when the search text
    contains it as a path prefix (i.e. the text contains `<cwd>` followed by end,
    whitespace, quote, or `/`). DEEPEST MATCH WINS: `/opt/django/projects/merlin_hpt/qbase/x`
    matches both the registered parent `/opt/django/projects` and
    `/opt/django/projects/merlin_hpt` — only the deeper root is kept.

S2. Registry cwd match — basename. For every registered cwd whose last path segment is
    ≥ 6 chars (guards against generic segments like `dev`), a word-boundary,
    case-sensitive match of that segment in the text references the cwd. This catches the
    dominant human idiom: bare "merlin_hpt" with no path. Ambiguity rule: if one basename
    maps to several registered cwds (e.g. a live checkout and a worktree of it), prefer
    the non-worktree path (the one NOT under a `worktrees/` or `.worktrees/` segment);
    if still ambiguous, include each (they are distinct real directories).

S3. Absolute path fallback. Extract absolute-path tokens with
    `/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g` (two or more segments). For each token
    not already covered by S1: walk from the longest EXISTING prefix of the token upward
    toward `/`, and take the FIRST (nearest) directory that contains `CLAUDE.md` or
    `AGENTS.md` as the orientation root. Depth cap: 8 upward steps; never accept `/`,
    `/home`, `/home/<user>`, `/opt`, `/tmp` themselves as roots. This covers estate
    directories no agent currently staffs (registry has no row) and worktrees (a git
    worktree contains its own checked-out AGENTS.md, so the walk stops right at the
    worktree root).

S4. Assignee's own cwd — ALWAYS a candidate, unconditionally (see Q1, §6). Taken from the
    registry entry of `--assignee` (already loaded for validation).

Post-processing:

- Union all roots, dedupe (after symlink-free normalization; do NOT resolve symlinks —
  paths are compared as written, matching how agents address them).
- Drop any root that contains NEITHER `CLAUDE.md` NOR `AGENTS.md` (nothing to orient on;
  the block never says "no docs found" — that root is simply omitted).
- Order: assignee cwd first, then by first appearance in the search text.
- Cap: at most 5 roots are rendered. If more were detected, the block's last line says
  `(+N more directories referenced — orient in each before working there.)` — never a
  silent truncation.

## 4. Probes per root (cheap, existsSync only)

For each surviving root R:

- `docsFile` = `CLAUDE.md` if `R/CLAUDE.md` exists, else `AGENTS.md`; if BOTH exist, name
  `CLAUDE.md` for claude-provider assignees and `AGENTS.md` otherwise (the assignee's
  `provider` is in its registry entry; this matches which file each engine treats as
  native).
- `hasGraph` = `R/graphify-out/graph.json` exists.

No file is opened or read at dispatch time; the probes are 2-3 `existsSync` calls per
root. No caching: the dispatch rate (a few per hour) makes staleness handling more code
than the probes cost.

## 5. The injected block, verbatim

Appended to the contract body, separated by one blank line:

```
--- ORIENT FIRST (injected by hive-dispatch) ---
This task references directories that carry their own onboarding docs. In each one, BEFORE
grepping, reading source, or forming a plan — and even if the task is advisory and your
facts arrive from the board or mail — orient first:
- <root>: read <docsFile> first and follow what it mandates. Knowledge graph present: run
  `graphify query "<question>"` before any grep.
- <root>: read <docsFile> first and follow what it mandates.
(+N more directories referenced — orient in each before working there.)
```

- One bullet per root; the graphify sentence appears only when `hasGraph`.
- The `(+N more …)` line appears only when the cap in §3 truncated.
- When ZERO roots survive, NOTHING is appended — no marker line (see Q3, §6).
- The header names the injector ("injected by hive-dispatch") so a worker quoting its
  dispatch upward never attributes the text to god, and Card B's gate can recognize
  oriented dispatches if it ever wants to.

## 6. God's three questions, answered

Q1 — re-injection cost for an agent who already lives in the directory: inject
unconditionally, no suppression. The block costs ~4-6 short lines (≈60-90 tokens) per
dispatch — noise-wise it is a standing checklist item, and that is the desired effect: the
2026-08-20 failure was an agent whose facts "already lived" in context. Suppression
("engine auto-loaded the cwd CLAUDE.md at session start") is per-engine guesswork —
claude auto-loads CLAUDE.md cwd-upward, pi/codex read AGENTS.md, and the merlin
installations carry ONLY CLAUDE.md, so a pi or codex assignee gets nothing natively; and
--adopt/--resume dispatches land mid-session where any auto-load is long compacted away.
Deterministic and slightly redundant beats clever and leaky. Revisit only if operators
report the noise, with a per-agent opt-out field — not shipped now.

Q2 — card title and notes: yes, both are scanned (§3, inputs 2-3). A card can name a
directory the contract does not; both fields are already in memory at the injection point.

Q3 — should a no-directory dispatch say so explicitly: no — stay silent. Three reasons.
(a) The detector is best-effort regex + registry; an explicit "this task references no
directory" is an ASSERTED NEGATIVE the detector cannot guarantee, and a wrong assertion
actively licenses the agent to skip orienting when it later does touch code — worse than
saying nothing. (b) Every board-only/advisory/mail-only dispatch would carry a permanent
noise line. (c) Auditability does not need it: the injected block (or its absence) is
preserved verbatim in the mail archive, and Card B is the designed backstop for missed
detection. 

## 7. Failure behavior and invariants

- Fail open: the entire detect-probe-render step is wrapped in try/catch; on ANY error the
  dispatch proceeds with the body unmodified. Orientation must never block or delay a
  dispatch — Card B backstops, and a broken injector must not take hive-dispatch down
  with it.
- No new writes: the CLI gains no log.jsonl append (log.jsonl single-writer discipline
  stays untouched); the mail archive is the audit surface.
- Registry read reuses the CLI's existing `readRegistry()`; an unreadable registry
  degrades detection to S3+nothing (S1/S2/S4 skipped), it does not fail the dispatch —
  note the CLI already hard-fails earlier on unreadable registry for assignee validation,
  so in practice this path only covers a registry that lost `cwd` fields.
- The injected block is APPENDED, never merged into god's prose; god's contract stays
  byte-identical above the separator.

## 8. Testing

- The pure function — `orientationBlock(searchText, assigneeCwd, assigneeProvider,
  registryCwds, probe)` → string ('' when nothing to inject), with `probe` an injected
  `(path) => boolean` — lives in main-process code, is serialized into the CLI template
  (cardHeld pattern), and gets `test/orient-inject.test.cjs` + a line in
  `test/focused.list`. Cases: full-path hit; basename hit ("merlin_hpt" bare); deepest
  root beats registered parent (/opt/django/projects); upward-walk fallback finds a
  worktree's own AGENTS.md; both-docs-files provider split; graphify line on/off; dedupe;
  cap + "+N more" line; zero-hit → empty string; probe throwing → empty string
  (fail open).
- One CLI-level test in the existing hive-dispatch suite: dispatch with a body naming a
  fixture directory (fixture hive per FIXTURES-ONLY rule) asserts the delivered mail body
  ends with the block. Live floor is never used for testing.

## 9. Explicitly out of scope

- Card B (PreToolUse access gate) — separate card, designed after A lands.
- Enforcing that the agent actually READS the named file or follows onboarding.md deeper —
  the harness guards the entry point; instruction-following carries the chain (accepted
  limitation, held on 2026-08-20 once the entry point was forced).
- God's manual `hive-mail` messages (non-card mail) and peer worker→worker mail — only
  the two card-creating CLIs (`hive-dispatch`, `hive-hire`) inject.
- Spawn-prompt/identity changes, engine-native CLAUDE.md/AGENTS.md auto-load behavior,
  and any per-engine config-dir work.
- Non-filesystem access mapping (e.g. deriving `merlin_hpt` from a `psql -d merlin_hpt`
  command) — that is Card B territory if anywhere.
- A per-agent suppression/opt-out field (Q1) — only if operators report noise.

## 10. Acceptance

1. A dispatch whose body or card title/notes names a merlin installation (path or bare
   name) delivers a contract mail ending in the ORIENT FIRST block with that
   installation's CLAUDE.md named, graphify line included where graphify-out/ exists.
2. A dispatch naming no directory delivers a byte-identical body (no marker).
3. `hive-hire` spawn objectives carry the block for their `--cwd`.
4. Standard gate green (`npm run typecheck && npm run lint && npm run test:focused`)
   including the new test file.
5. No dispatch can fail because of the injector (fault injection in tests: probe throws →
   dispatch still succeeds, body unmodified).
