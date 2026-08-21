---
name: implementer
version: 1.0.0
description: |
  Spec-driven implementation chain for dispatched hive workers. Takes TWO
  inputs from the dispatch body — a spec path and an execution mode — and
  runs the whole chain once, so a dispatch never re-specifies it in prose:
  read the spec, plan via superpowers:writing-plans, create the worktree AT
  EXECUTION TIME (not before planning), execute in the named mode
  (subagent-driven / executing-plans / inline), finish via the HIVE
  finishing rule (target repo's house gates, local merge, push only on a
  fresh per-dispatch authorization). Use when god's dispatch hands you a
  spec file and names a mode, or a card says "implement per the spec".
  Replaces improvising the chain per task, and replaces
  superpowers:finishing-a-development-branch at the end.
allowed-tools:
  - Read
  - Bash
  - Edit
  - Write
---

## implementer — spec → plan → worktree (at execution) → execute (mode) → hive finish

Inputs, both from the dispatch prose (no flag exists — read the mail/card):

1. **Spec path** — a design/spec document, usually in the target repo.
2. **Execution mode** — `subagent-driven` (SDD), `executing-plans`
   (parallel session), or `inline` (trivial plans only).

### Step 0 — preconditions: FAIL LOUD, never improvise

- **Superpowers plugin present?** Probe for `superpowers:writing-plans`,
  `superpowers:using-git-worktrees`, and — for subagent-driven mode —
  `superpowers:subagent-driven-development` (invoke them, or locate their
  SKILL.md in the plugin cache). A fresh install may not carry the plugin
  (the repo's AGENTS.md says so). Any of them missing → STOP and mail god;
  running the chain without them is worse than refusing.
- **Mode named?** No execution mode in the dispatch → STOP and ask via
  hive-card ask. Do not silently default to SDD.
- **Spec path named and readable?** No → STOP and ask via hive-card ask.

Then orient: read the target repo's AGENTS.md/CLAUDE.md BEFORE grepping
(orient-first). Note three things it owns — docs rules (Step 2), worktree
rule (Step 3), gate commands (Step 5). The skill defers to all three.

### Step 1 — read the spec

Read the spec file in full. It is the binding authority for WHAT; the plan
is its argument for HOW. If the spec conflicts with a card note marked
resolved, or you believe a resolved decision is wrong once inside the code
— do not substitute your own; say so in the done-report.

### Step 2 — plan: superpowers:writing-plans

Announce it, then invoke `superpowers:writing-plans` against the spec.
Plan home defaults to that skill's `docs/superpowers/plans/
YYYY-MM-DD-<name>.md`; the target repo's docs rules override (qbase keeps
its own spec/plan homes). Do not create the worktree yet — that is Step 3,
deliberately after planning: a merlin worktree is a SEAT (private DB
clone), and a plan that concludes trunk or docs-only work must not have
wasted one.

### Step 3 — worktree AT EXECUTION TIME

Invoke `superpowers:using-git-worktrees` now, before executing task 1.
Worktree choice is TARGET-REPO POLICY, not yours and not a flag: read the
repo's own worktree rule and follow it. Precedents: munder-difflin —
always worktree (the live checkout IS the running app); merlin qbase —
the seat mechanism per the worktree-seats spec; docs-only work — none.
You may already BE in a worktree (a dispatched cwd often is) — the skill's
Step 0 detects existing isolation and skips creation.

### Step 4 — execute in the dispatch's mode

- `subagent-driven` — `superpowers:subagent-driven-development`: fresh
  implementer subagent per task, per-task review (spec compliance + code
  quality), whole-branch review at the end. Inject the code-philosophy
  skill (user-level asol-skills plugin) at the whole-branch gate; if
  absent, skip and say so in the done-report. Review is INTERNAL to the
  chain — the human spec review happened before dispatch and stays outside.
  Its rulings-not-stalls rule applies: decide, record
  `Ruling: <what> — <why> — <cost if wrong>`, keep going.
- `executing-plans` — `superpowers:executing-plans` in the session the
  dispatch names.
- `inline` — only for plans too small to benefit from subagents.

### Step 5 — the hive finishing rule

This REPLACES `superpowers:finishing-a-development-branch`: that skill
stops to ask a human and runs a generic npm test — a dispatched worker has
no human mid-task, and every repo has its own gates.

1. **House gates** — run the TARGET repo's gate commands verbatim from its
   AGENTS.md/CLAUDE.md (in the HarnessAgents repo:
   `npm run typecheck && npm run lint && npm run test:focused`). Red gate →
   STOP and mail god; never merge red.
2. **Merge locally** — merge your own branch into its target branch in your
   checkout. A rebase conflict you cannot cleanly resolve → STOP, mail god.
   EXCEPT: renderer/preload-touching work in this harness NEVER merges into
   the live checkout while the app runs — hold the branch and report the
   tip sha once (the restart window is god-owned).
3. **PUSH IS NEVER THE SKILL'S DEFAULT.** Green gates do not mean push.
   Push ONLY when the dispatch that started this work authorized THAT push,
   freshly: the authorization names repo, branch, and expected sha; states
   the operator authorized this push (quoting their words where possible);
   and arrives from god — the router's sender stamp is what makes a relay
   checkable. A standing policy ("always push after green gates") NEVER
   counts — this HOLD default also overrides the integrationMode: workers
   push-by-default posture for work dispatched through this skill; only a
   dispatch carrying the relay-form authorization (or an explicit push
   boundary in the dispatch) lifts it — and authorization is NOT retractable mid-flight once genuinely given
   (incident #3227 made the omission-failure once; only the operator's own
   word stops an authorized push). Absent an authorization: HOLD the branch
   at the gated local sha and report it — god decides.
4. **Any mismatch — sha differs from the dispatch, conflict, red gate, an
   authorization in imperfect form, or plain doubt — HOLD and ask via
   hive-card ask on the ASK ME board**, never by waiting in your pane.
   Standing boundaries stack on top, unweakened: the never-push merge
   skills (asol-git-merge-main, asol-git-merge-singletenant) keep their own
   rule; an explicit NO-push in a dispatch always wins.

### Step 6 — report to god

ONE mail: branch + tip sha, the gate commands with their numbers, plan
path, mode used, rulings, and review findings acted on or declined (with
why). Label every claim VERIFIED (check named) or INFERRED — god relays
VERIFIED unscrutinized and must flag the rest. Append durable facts to
your memory.md before ending the session.
