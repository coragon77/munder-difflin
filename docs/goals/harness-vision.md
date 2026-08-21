# Munder Difflin harness — vision

**Status:** draft — deliberately a beginning; chapter V2 fills it · **Opened:** 2026-08-21 · **Expected scale:** spans the harness rewrite, multi-month

This is a goals document, not a spec. Chapters go through the normal spec/plan workflow; this document records direction and decisions, it never replaces them.

## Why

Stefan forked the harness about a week before this document opened. It is a nice demo, but "kinda unsuited to how I work and my goals" (Stefan, 2026-08-21). A week of multi-agent rewriting followed. Running Fable as the orchestrator "literally set my token limits on fire" — nearly the whole budget in two days, spent on orchestration itself. The downgrade to Opus brought visible quality decay: the harness "became more complicated", the orchestrator got "lost in minutae while forgetting the picture", asked-for bug fixes did not land, and on 2026-08-21 it spent a session arguing whether an agent may merge and push — "something I authorized and encoded in the harness days ago".

The root diagnosis, in Stefan's words: "the biggest problem is that MY vision of the software and the vision of the original creator differ." No artifact states Stefan's vision, so every session infers the original's vision from the code — and re-derives, re-litigates, or drifts. Without a codified intent layer, that decay compounds with every knob turned. This document is where the vision gets stated. It starts nearly empty on purpose: the vision discussion that fills it is gated on correct architecture docs, because "It won't work any other way."

## Scope

In:

- The direction of the harness: what it is for, and how Stefan works with it.
- The orchestration architecture (router-god, advisors, what the harness automates vs. what models decide).
- Which parts of the original creator's product-shaped vision stay, change, or go.

Out:

- The architecture-docs burn-down (tracked in `2026-08-21-asol-docs-update-burndown.md`).
- Day-to-day feature and bug cards.
- The documentation methodology itself (that lives in the asol-docs skill).

## Facts a new session must not re-derive

| Fact | Source |
|---|---|
| The repo is a hard fork of `chaitanyagiri/munder-difflin`, forked ~2026-08-14; upstream is pull-only; the landing site (munderdiffl.in) belongs to upstream and its copy here is archived under `archived_docs/` | Stefan, 2026-08-21; commit `aefd53f` |
| The harness was rewritten for a week by multiple agents running on the harness itself | Stefan, 2026-08-21; Office-persona card references in `git log` |
| Fable as orchestrator consumed nearly the full token budget in two days, on orchestration overhead | Stefan, 2026-08-21 |
| The Opus orchestrator showed real degradation: lost in minutiae, forgot the picture, left asked-for fixes unfixed, re-argued the settled merge/push authorization | Stefan, 2026-08-21 |
| Current escalation practice: Stefan tells the god agent (Michael) to get an opinion from "Robert", a specialised Fable advisor — "That works wonders for the budget." | Stefan, 2026-08-21 |
| Orientation tooling exists (graphify = code structure, MemPalace = session memory) but the authored intent layer was missing until the asol-docs adoption | Stefan, 2026-08-21; commits `216d602`, `31e71a6` |
| The documentation approach is Stefan's 15+ years of ERP-service practice, codified in the asol-docs skill and applied to the ERP a year earlier | Stefan, 2026-08-21 |
| The docs burn-down already pays: C2 surfaced a confirmed code bug (kitty-detach typing bypasses the delivery gates; dead read-only veil), recorded in the burn-down tracker | C2 transaction, commit `19142b6` |

## Decided

| Decision | Settled by |
|---|---|
| Sequencing: document what exists first — thoroughly, inferring intent where citable — then create the vision document and discuss approaches. "It won't work any other way." | Stefan, 2026-08-21 |
| "Docs are correct" gate: drift report clean on staleness, integrity, and canon; zero open INTENT markers, each answered by Stefan; every `src/` cluster documented or deliberately driftignored ("Its as you say") | Stefan, 2026-08-21 |
| Target orchestration: Opus with medium thinking as the god/router, the harness giving it tools "so that it only needs to route and not think so much"; specialised Fable agents as on-demand advisors | Stefan, 2026-08-21 |
| Agents are authorized to merge and push — "authorized and encoded in the harness days ago" (where it is encoded: see Open questions) | Stefan, 2026-08-21 |
| The vision document gets created and the approach discussion happens with a fresh Fable session once the docs gate is met | Stefan, 2026-08-21 |

## Open questions

| Question | Owner | Unblocked by |
|---|---|---|
| Which parts of the original's product-shaped code stay, change, or go? | Stefan | V2 vision discussion |
| Where exactly is the merge/push authorization encoded, and which blocking-read doc should route it so no session re-argues it? | Stefan | Locating it; the burn-down interviews |
| How does Michael know when to consult an advisor without Stefan prompting each time? | Stefan | V2 approach discussion |
| What exact tool/context surface must the harness give the router-god so routing needs no deep thinking? | Stefan | V2 approach discussion |
| What does an advisor like Robert receive as input — raw access to docs/cards/repo, or Michael's digest? | Stefan | V2 approach discussion |

## Living rules

- Check off chapters as they complete; append dated status entries here rather than rewriting history; supersede with a companion or handover doc if the arc changes.
- V2 rewrites Why/Scope/Decided into the full vision statement — that rewrite is the one sanctioned exception to "never rewrite history", and it happens in the V2 session with Stefan present.
- A chapter kickoff brief carries: the chapter row with its `done =`, the Decided table, the standing constraints, the pointers in Facts, and the current drift-report state. It carries no task list, no code or model sketches, and no wording that lets a chapter skip its spec/plan cycle.

## Chapters

Each chapter is the input to the next — docs feed the discussion, the discussion feeds the review. That order is the point ("It won't work any other way").

- [ ] **V1. Architecture docs correct**
  - done = the drift report meets the gate in Decided: staleness/integrity/canon clean, zero open INTENT markers each answered by Stefan, every `src/` cluster documented or deliberately driftignored.
  - Detail tracked in `2026-08-21-asol-docs-update-burndown.md` (C1, C2 done; C3 running), plus a coverage-gap resolution round after it.
- [ ] **V2. Vision discussion with a fresh Fable session**
  - done = this document's Why/Scope/Decided rewritten as the full vision; divergences from the original creator's vision enumerated with keep/change/drop dispositions.
- [ ] **V3. Code-vs-intent review**
  - done = a review run compared each architecture doc against its code; every mismatch filed as either a bug card or an undocumented decision.

Later chapters TBD after V2 — candidates were named in discussion (simplification audit, codified escalation triggers) but none is decided.
