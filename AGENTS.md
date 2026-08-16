# AGENTS.md

Read-me-first for any coding agent (or human) working in this repo. Pointers,
not duplication — the linked docs are the source of truth.

## What this is

Electron desktop app (macOS-first) that runs a local hive of CLI coding agents
(`claude`, Codex, Grok, Copilot, …) as Sims-style avatars in a 2D office.
Viewer/controller, not a CLI replacement.

## Commands

```bash
npm install        # postinstall rebuilds node-pty for Electron's ABI (most common setup failure)
npm run dev        # live-reloading Electron dev build
npm run typecheck  # node + web TS projects — part of the standard gate
npm run lint       # biome check (lint rules + format verification) — part of the standard gate
npm run test:focused   # node --test suite in test/ — part of the standard gate (files come from test/focused.list; adding a test = appending one line there)
npm run build      # production build — must work before any PR
```

**Standard gate** = `npm run typecheck && npm run lint && npm run test:focused` —
run all three before claiming a card done. Lint findings you can't resolve:
`npm run format` fixes formatting; ask god before suppressing a rule
(`biome-ignore` comments carry a reason). Biome config and rule deviations
live in `biome.json`.

## Process pointers

- If the **superpowers** skills are installed in the running engine (a user-level
  plugin — a fresh install may not have them), use them: **brainstorming** before
  building anything new, **systematic-debugging** for any bug,
  **test-driven-development** for features, **verification-before-completion**
  before claiming done. Superpowers ships a pi adaptation
  (`references/pi-tools.md` inside its using-superpowers skill).

## Architecture in one screen

Two data planes (see `SPEC.md`):

- **Event plane** — Claude Code hooks POST JSON to a Unix socket the main
  process owns (`src/main/hooks.ts`); drives avatar movement.
- **Terminal plane** — node-pty processes stream bytes to an xterm.js view
  (`src/main/pty.ts`).

Hive layer (`HIVE.md`, code in `src/main/hive.ts`, `memory.ts`, `roster.ts`):
agents live as files under `<harnessHome>/hive/` — `registry.json`, `board.md`,
`tasks.json`, `log.jsonl`, per-agent `agents/<id>/{identity,memory}.md` +
`inbox/`/`outbox/`.

**Invariants — violating these breaks the hive:**

- Only the Electron main process runs git / commits. Agents write plain files.
- Single writer per file: an agent writes only inside its own `agents/<id>/`.
  Cross-agent delivery = router moves `outbox/` → recipient `inbox/`.
- One JSON file per message, atomic temp-file + rename. `log.jsonl` is
  append-only. `board.md` has exactly one scribe (the god agent).

## Layout

| Path | What |
|---|---|
| `src/main/` | Main process: PTYs, git/fs bridges, hive, hooks, memory, config |
| `src/preload/` | Context-bridge IPC surface |
| `src/renderer/` | React + Pixi.js office scene (`src/renderer/src/scene/office/`), stores, components |
| `src/shared/` | Types shared across processes |
| `tools/mapgen/` | Python helpers for the Tiled office map |
| `test/` | `node --test` suites (`npm run test:focused`) — focused files listed in `test/focused.list`, one per line; append a line to add a test |
| `hive/` (repo root) | Static hive assets (`docs/integration-templates.md`) — `PROTOCOL.md` and `COMMANDS.md` are generated into the *runtime* hive from constants in `src/main/hive.ts` |

## UI rules (non-negotiable, `DESIGN.md`)

Animal Crossing × Earthbound × SNES aesthetic. Every new component derives from
the tokens in `src/renderer/src/design/tokens.ts` — no ad-hoc colors, spacing,
or fonts. `tokens.ts` and `tokens.css` are mirrored; change one, change the
other. Pixel-snapped, chunky, ≤8 colors per screen. Visual changes need a
screenshot in the PR.

## Conventions

- Branch off `main`, focused PRs, explain what + why.
- Pixel-art assets: LimeZu FREE VERSION license (non-commercial) — new art must
  be your own or compatibly licensed, and listed in
  `src/renderer/src/assets/ATTRIBUTION.md`.
- Telemetry events are a hard allowlist: `TELEMETRY.md` ↔ `src/main/analytics.ts`
  stay in lockstep.
- Docs vs reality: `HIVE.md` is what we're building *toward*; code is truth for
  what's *built*. Phases 0–3 are marked done there. `MEMORY_GRAPH_SPEC.md`
  describes an unbuilt feature.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
