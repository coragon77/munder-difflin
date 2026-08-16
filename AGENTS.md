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
npm run typecheck  # node + web TS projects — the de-facto CI gate, keep it green
npm run test:focused   # node --test suite in test/ (CONTRIBUTING.md predates it)
npm run build      # production build — must work before any PR
```

## Architecture in one screen

Two data planes (see `SPEC.md`):

- **Event plane** — Claude Code hooks POST JSON to a Unix socket the main
  process owns (`src/main/hooks.ts`); drives avatar movement.
- **Terminal plane** — tmux `pipe-pane` bytes → xterm.js view (`src/main/pty.ts`).

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
| `test/` | `node --test` suites (`npm run test:focused`) |
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
