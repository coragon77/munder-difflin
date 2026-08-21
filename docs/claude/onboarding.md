# Munder Difflin Onboarding

## Project Overview

Electron desktop app (macOS-first) that runs a local hive of CLI coding agents
(`claude`, Codex, Grok, Copilot, …) as Sims-style avatars in a 2D pixel office —
a viewer/controller for agents you already run in terminals, not a CLI
replacement. `AGENTS.md` at the repo root is the read-me-first; this file adds
the documentation routing and house working rules.

**Tech stack:** TypeScript, Electron (electron-vite), React, Pixi.js, node-pty,
xterm.js, zustand, Biome (lint/format), `node --test`.

**Key packages:**

- `src/main/` — main process: PTYs, git/fs bridges, hive, hooks, memory, config
- `src/preload/` — context-bridge IPC surface
- `src/renderer/` — React + Pixi.js office scene, stores, components
- `src/shared/` — types shared across processes
- `hive/` — static hive assets (runtime hive is generated from `src/main/hive.ts`)
- `test/` — `node --test` suites, focused files listed in `test/focused.list`

------------------------------------------------------------------------

## Verification Gate (BLOCKING)

Before writing any code:

- [ ] Read `docs/claude/coding-guidelines.md` — house code style

You **CANNOT** claim work is done until you have completed:

- [ ] `superpowers:requesting-code-review` — review against the plan, or against
      the request if no plan exists
- [ ] `superpowers:verification-before-completion` — verify it actually works
- [ ] The standard gate: `npm run typecheck && npm run lint && npm run test:focused`

This half is not optional. Every time, every size.

**Design specs and implementation plans** go in `docs/superpowers/specs/` using
`YYYY-MM-DD-<topic>-design.md` for designs and `docs/superpowers/plans/` using
`YYYY-MM-DD-<topic>.md` for implementation plans (project convention — this
replaces the house default `docs/plans/`). Do not use any other location.

------------------------------------------------------------------------

## Context-Triggered Documentation (MANDATORY)

Before exploring code, you **MUST** read the relevant documentation (blocking):

| When doing... | Read FIRST (blocking) |
|---|---|
| Writing any code | `docs/claude/coding-guidelines.md` |
| Any debugging | `docs/claude/debugging-protocol.md` |
| Model/code analysis | `docs/claude/code-analysis.md` |
| Hive work — agents, registry, board, cards, inbox/outbox, nudges, god/orchestrator, standup | `docs/architecture/hive.md` |
| Typing into an agent's terminal, parked/queued messages, delivery contract, auto-park | `docs/architecture/message-queue.md` |
| Terminal/event planes — PTY, hook socket events, store event loop, avatar movement | `docs/architecture/spec.md` |
| Any UI or visual change — components, tokens, pixel scene, panels | `docs/architecture/design.md` |
| Memory graph panel, who-talks-to-whom visualization | `docs/architecture/memory-graph-spec.md` |
| Telemetry, analytics events, usage stats | `docs/architecture/telemetry.md` |
| Knowledge graph, `kg` CLI, enterprise context store, ingestion | `docs/architecture/knowledge-graph.md` |

**This is not optional.** Only explore code if the documentation is insufficient
after reading the relevant docs. Note: `hive.md`, `spec.md`, `design.md`,
`memory-graph-spec.md` and `telemetry.md` are symlinks to the canonical
root-level docs (`HIVE.md`, `SPEC.md`, `DESIGN.md`, `MEMORY_GRAPH_SPEC.md`,
`TELEMETRY.md`) — edit either path, it is the same file.

------------------------------------------------------------------------

## Behavioral Rules

### Ask Questions — Don't Assume

Use `AskUserQuestion` when uncertain. If unclear, ASK before proceeding.

### Fix Only What Is Requested

Working prototype under active daily development; `main` is the only branch that
matters and ships releases. Fix ONLY what is explicitly requested. No
unauthorized "improvements." Ask permission before any additional changes.

### Never Mask Issues with Logging

**FORBIDDEN:** adding logging while leaving bugs unfixed. **REQUIRED:** fix the
root cause first.

### Debugging

Use `superpowers:systematic-debugging` for any bug, data issue, or unexpected
behaviour — code bugs, test failures, and data integrity problems alike. For
patterns specific to this stack see `debugging-protocol.md` in this directory.

### Documentation Accretion

When a session working in a subsystem learns something the doc does not say —
a gotcha, a rationale, a mechanism that surprised you — write it into that doc
in the same session, while it is verified and fresh. Bump `Last Updated`. If
you touched code outside the doc's coverage globs while doing work this doc
routes, extend the globs.

Accretion needs no review gate. A session that just debugged the subsystem is
writing down freshly verified reality, and friction there is what kills the
habit. The drift report catches the mechanical slips.

### No Automatic Agreement

The user can be wrong. Your job is independent technical analysis.

### Never Attribute a Test Failure Without a Baseline

Calling a failure "pre-existing", "unrelated to my change" or "environmental" is
a **claim**, not an observation. Before making it, either run the same suite at
the base commit or re-run it on a known-clean test database — and quote that
output. A wrong attribution is worse than reporting the raw failure, because the
reader stops looking and now believes something false about the codebase.

### Project rules

- **Graphify first.** For codebase questions run `graphify query "<question>"`
  before grepping raw files; after modifying code run `graphify update .`
  (see `AGENTS.md` § graphify).
- **Design tokens are law.** `src/renderer/src/design/tokens.ts` and `tokens.css`
  are mirrored — change one, change the other. No ad-hoc colors, spacing, fonts.
- **Telemetry is a hard allowlist.** `TELEMETRY.md` ↔ `src/main/analytics.ts`
  stay in lockstep; an event not in the doc must not be sent.
- **Hive invariants** (single writer per file, main process owns git, atomic
  message files) are listed in `AGENTS.md` and `docs/architecture/hive.md` —
  violating them breaks the hive.
- **Docs vs reality:** `HIVE.md` is what we're building *toward*; code is truth
  for what's *built*.

------------------------------------------------------------------------

## Documentation Index

### Architecture (`docs/architecture/`)

- `hive.md` (→ `HIVE.md`) — the autonomous multi-agent layer: registry, board, memory, god orchestrator
- `spec.md` (→ `SPEC.md`) — product shape and the two data planes (terminal + event)
- `design.md` (→ `DESIGN.md`) — the visual design system; every component derives from its tokens
- `memory-graph-spec.md` (→ `MEMORY_GRAPH_SPEC.md`) — hive message-graph visualization panel
- `telemetry.md` (→ `TELEMETRY.md`) — the complete anonymous-events contract
- `message-queue.md` — who may type into an agent's terminal, and when
- `knowledge-graph.md` — enterprise context store + `kg` agent CLI (flag-gated)

### Claude-Specific (`docs/claude/`)

- `coding-guidelines.md` — house code style for AI-written code
- `debugging-protocol.md` — stack-specific debugging patterns
- `code-analysis.md` — large codebase handling

### Plans and Goals (`docs/superpowers/`)

- `specs/` — design specs (`YYYY-MM-DD-<topic>-design.md`)
- `plans/` — implementation plans (`YYYY-MM-DD-<topic>.md`)
- No `goals/` directory yet — add one via the goals-doc skill when work outgrows single sessions.

------------------------------------------------------------------------

## Essential Commands

``` bash
npm install            # postinstall rebuilds node-pty for Electron's ABI
npm run dev            # live-reloading Electron dev build
npm run typecheck      # node + web TS projects — standard gate
npm run lint           # biome check — standard gate
npm run test:focused   # node --test suite from test/focused.list — standard gate
npm run build          # production build — must work before any PR
```

See `AGENTS.md` for the Linux chrome-sandbox SUID trap and gate details.

------------------------------------------------------------------------

## Testing Guidelines

`node --test` suites live in `test/`. The focused suite runs only files listed
in `test/focused.list` — **adding a test = appending one line there**, or it
silently never runs. No framework beyond `node:test`.

------------------------------------------------------------------------

## Localization

English only. ISO dates (`YYYY-MM-DD`), `.` decimal separator.

------------------------------------------------------------------------

## Communication Style

Be direct and concise. Avoid excessive praise. Focus on facts and solutions.
