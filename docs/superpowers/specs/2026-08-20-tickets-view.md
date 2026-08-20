# Spec: "tickets" view in the harness (card agent-spec-tickets-view-in-the-2026-08-20)

Author: Robert (advisory). Status: awaiting Stefan's decision on the one open point
(§2, who writes the JSON), everything else implementable as written.

## 1. What this is

Stefan wants the `/ticket-overview` data — today a markdown digest Angela refreshes
into the Obsidian vault — readable inside the harness: a "tickets" button, backed by
a JSON file "like the other stuff".

The `/ticket-overview` skill (`~/.claude/skills/ticket-overview/`) is a
three-phase pipeline around a deterministic script, `overview.py`:

- `build` fetches Redmine, writes `~/.cache/ticket-overview/state.json`
  (full open-ticket table + `generated_at` + `active_ids`) and
  `manifest.json` (tickets needing fresh recaps).
- a Haiku subagent writes `recaps-in.json` (per-ticket 1–2 line recaps).
- `finish` merges recaps into `cache.json` (keyed by `(id, updated_on)`),
  resolves a recap per active ticket, renders markdown to
  `~/Dropbox/Obsidian Vault/Digest/Redmine Queue.md` (a symlink into
  `/home/sfuchs/Dokumente/Obsidian Vault` — same vault, no discrepancy) and stdout.

So the structured data already exists as JSON; what's missing is one merged,
stable-contract file and a harness surface that shows it.

## 2. Who writes the JSON — DECIDED and SHIPPED (2026-08-20)

Stefan approved option B in Robert's pane and Robert implemented it the same day:
`cmd_finish` in BOTH skill repos now writes the contract file — asol-claude-skills
commit `6c2f6a3`, asol-skills (pi companion, `skills/ticket-overview/`) commit
`9a9b1e2`. Verified with a live standalone `finish` run: 95 tickets, 21 active,
21 recaps, `generated_at` matching state.json, markdown note unchanged. Note
`generated_at` is **local time `"YYYY-MM-DD HH:MM"`** (the script's `now_iso()`),
not ISO-8601-Z — parse accordingly for the 26 h staleness rule. §4–§10 remain
the open implementation work. Original decision text kept below for context.

**Recommended (option B): `overview.py finish` writes one additional file,**
`~/.cache/ticket-overview/tickets.json` — the merged view (table + recaps), the
same dataset the markdown is rendered from, written in the same function that
already computes `recap_map` (overview.py `cmd_finish`, ~10 added lines). The
markdown and the JSON become two renderings of one run — **not** two sources of
truth; both carry the run's `generated_at`.

This needs Stefan's go because `overview.py` is his skill script (this card's
boundary forbade *me* changing it, and the skill is personal tooling under
`~/.claude/skills/`, not harness code). The change is: after `report = render(...)`,
dump `{version, generated_at, redmine_base, tickets:[...]}` with `save_json`.

**Fallback (option A), if the skill must stay untouched:** the harness main process
reads `state.json` + `cache.json` itself and resolves recaps with the same rule
`cache.tickets[id].updated_on == ticket.updated_on → recap valid`. Works today with
zero skill changes, but couples the harness to the skill's *private cache internals*
(`cache.json` is an implementation detail and 200 KB of journals). Use only if
option B is refused; if `overview.py`'s cache format ever changes, migrate to B.

**Rejected (option C): harness fetches Redmine itself.** It duplicates the skill's
collection logic and cannot produce the recaps (LLM-written). The recaps are the
valuable half of the digest.

## 3. The contract file

Path: `~/.cache/ticket-overview/tickets.json`. Deliberately **not** in
`<harnessHome>/hive/`: the hive dir is a git repo where agents may only write
inside their own `agents/<id>/` (AGENTS.md invariant, "Single writer per file"),
and this is refreshable display data, not coordination state — losing it costs one
skill re-run. No git churn, no committer needed.

Shape (version-gated; unknown fields ignored):

```json
{
  "version": 1,
  "generated_at": "2026-08-20 08:31",
  "redmine_base": "https://redmine.asol.at",
  "tickets": [
    {
      "id": 3229,
      "subject": "…",
      "priority": "Hoch",
      "priority_id": 5,
      "status": "In Bearbeitung",
      "project": "…",
      "updated_on": "2026-08-19T14:02:11Z",
      "roles": "A",
      "active": true,
      "recap": "…state sentence… **Next:** …" 
    }
  ]
}
```

- `tickets` comes pre-sorted by the script (its existing `state_sort_key`:
  priority desc, then updated desc). The renderer preserves order — no sorting
  logic duplicated in TS.
- `active` = status ≠ `Neu` (the script's `is_active`). `recap` is `null` for
  inactive tickets and for active tickets whose recap is missing/stale.
- `roles` is the skill's compact string (A=assigned, R=reported, W=watching).

## 4. Main process

One read-only IPC, modeled on `hive:board` (preload index.ts:887):

- preload: `tickets(): Promise<TicketsState | null>` → `ipcRenderer.invoke('app:tickets')`.
- main: handler reads `~/.cache/ticket-overview/tickets.json`, `JSON.parse`,
  returns `null` on missing file / parse error / `version !== 1`. No watcher, no
  cache — the renderer polls (see §5), file is ~20 KB.
- Type `TicketsState` in `src/shared/` (both processes import it).

## 5. Primary surface: a `tickets` tab in CommandCenterPanel

The queue is **floor-wide** (Stefan's Redmine queue, produced by whichever agent
runs the skill), not one agent's private state — so the data's home is the
CommandCenter, sibling of the board. Model: `BoardTab`
(CommandCenterPanel.tsx:444–523) — read-only view, 5 s `setInterval` poll, "keep
last good on error", exactly the cadence TasksKanban uses.

- Add `'tickets'` to the `CCTab` union (:52) and `TABS` (:82 region), icon: reuse
  an existing `IconName` (`'ledger'` acceptable; do not add new art).
- Layout, top to bottom:
  - **Freshness header — mandatory, not optional** (the board tab once showed
    three-day-old content for three days unnoticed):
    `N open — refreshed <relative> (<absolute generated_at>)`.
    If `generated_at` is older than **26 h** (Angela's morning cadence + slack):
    a warning-styled stale badge, e.g. `STALE — last run <absolute>`; use existing
    warning tokens from `design/tokens.ts`, no ad-hoc colors.
  - **Table**, script order preserved: `#id · subject · priority · status ·
    project · roles · updated`. For rows with a `recap`, render it as a secondary
    line under the subject (render the `**Next:**` bold marker; recaps are 1–2
    lines by contract). `#id` is a link to `<redmine_base>/issues/<id>`, opened in
    the external browser (follow the harness's existing external-link handling).
  - No filters, no search, no grouping in v1 — the pre-sorted order already puts
    urgent-and-active on top.
- Empty state (IPC returned `null`): `No ticket data yet — run /ticket-overview
  (Angela owns it).` — same tone as BoardTab's missing-board copy (:510).

## 6. The button Stefan asked for: detail-view deep link

`AgentDetailPanel` header gets a small `PixelButton` labeled `TICKETS`, shown
**only** for agents whose registry `capabilities` include `'tickets'`
(`AgentMeta.capabilities?: string[]`, hive.ts:234 — the field exists and is
currently decorative). Clicking fires the existing seq-keyed `ccTabRequest`
store mechanism (CommandCenterPanel.tsx:125–138, the "office task board →
'tasks'" precedent) with `tab: 'tickets'`.

This honors "a button in the detail view" without making floor-wide data
per-agent: the button is a shortcut on the producing agent, the data lives in the
CommandCenter.

Ops step at rollout: add `"tickets"` to Angela's registry `capabilities`.
⚠ Do it via a direct registry edit by god/main — **not** via the renderer edit
dialog, which as of 2026-08-19 overwrites `role` with the live status text
("on standby") as collateral (usePtyParser.ts:72–79 → AddAgentModal prefill →
setAgentMeta; diagnosed on card agent-stop-the-registry-role-d).

## 7. Staleness rule (summary)

| state | display |
|---|---|
| file missing / unparsable / wrong version | empty state with the run instruction |
| `generated_at` ≤ 26 h | plain freshness header |
| `generated_at` > 26 h | freshness header + warning badge |

The 5 s poll makes *display* freshness a non-issue; `generated_at` is the only
*data* freshness there is. 26 h derives from the current once-a-morning cadence;
keep it a named constant.

## 8. Read-only, with the acting door left open

v1 is strictly read-only plus the external Redmine link per row. The obvious
future step — click a ticket, dispatch it to an agent — is *not* painted
impossible: the "task-detail assign pre-fills the Floor dispatch box" precedent
(CommandCenterPanel.tsx:139 region) is the mechanism a later card would reuse
with a row-level action. Out of scope here.

## 9. Explicitly out of scope

- Any change to what `/ticket-overview` collects, recaps, or renders to Obsidian.
- Redmine writes of any kind, or credentials in the harness.
- Notifications/badges outside the tab (no dock badges, no toasts on stale).
- Filtering, search, grouping, per-column sort in the view.
- Scheduling the skill from the harness (Angela's cadence is her goal text).

## 10. Acceptance

1. Skill run → tab shows the same tickets and recaps as the Obsidian note, same
   order, freshness header correct.
2. Delete `tickets.json` → empty state; restore → recovers within one 5 s poll.
3. Fake `generated_at` 3 days old → stale badge.
4. Agent without the `tickets` capability shows no button; Angela shows it and
   the click lands on the tab.
5. Standard gate green (`npm run typecheck && npm run lint && npm run test:focused`).
