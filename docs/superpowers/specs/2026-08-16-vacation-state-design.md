# Vacation state for human-created agents — design

Date: 2026-08-16. Approved by Stefan in god's session (conversation, evening shift).
Author: god (Michael), brainstormed with Stefan.

## Problem

Idle human-created agents clutter the floor and burn tokens on every standup
broadcast, but archiving them lumps them in with dead agents and exposes them to
deletion. Stefan wants a third place: **On Vacation** — off the floor, zero cost,
individually recallable by god, protected from deletion.

The intended workflow (Stefan's words, condensed): god gets a task and writes a
card; assigns a human-created agent if possible — idle on the floor first; if the
fitting agent is on vacation, god fetches it back. When an agent has been idle
~30 minutes with no task, god sends it on vacation so it does not clutter the
floor. Sending and fetching are god's prerogative (autonomous, no approval);
Stefan additionally gets manual buttons.

## Agent taxonomy after this change

| State | Registry flags | Where shown | Cost | Recallable | Deletable |
|-------|---------------|-------------|------|-----------|-----------|
| Floor (working/idle) | none | floor cards | live PTY | — | no (kill/archive first) |
| **On Vacation** | `archived: true, vacation: true` | VACATION section | zero | yes — god or button | **no** (must end vacation → Archived first) |
| Archived | `archived: true` | ARCHIVED section | zero | yes (restore) | yes |
| Retired (fired interns) | `archived: true, retired: true` | hidden | zero | no (spawn refused) | yes |

Scope guard: **only human-created agents** can go on vacation. The park path
refuses interns (role `intern`) and god. `vacation` and `retired` are mutually
exclusive.

## Design decisions (settled with Stefan)

1. **Vacation is a flag on top of `archived`, not a fourth liveness state.**
   `archived` stays pure liveness (established 2026-08-16, same day as `retired`).
   A vacationer is genuinely not running, so the boot sweep, broadcast fan-out,
   heartbeat roster, and nudge poller all skip it with no new exemptions.
   Display keys on the flag: `vacation` → VACATION; `archived && !vacation &&
   !retired` → ARCHIVED; `retired` → hidden.
2. **God is autonomous both directions.** No approval gate — that is the point of
   the feature; otherwise archive/restore would suffice (Stefan, verbatim intent).
3. **Policy lives in the harness, not god's memory** (Stefan's standing rule:
   a fresh install's god must know it). The generated hive-root AGENTS.md /
   godLine gains: assignment order (idle floor agent → fetch fitting vacationer →
   intern/new spawn last) and the auto-park rule (idle ≥ 30 min, no doing/blocked
   card, drained inbox → vacation; god's judgment may hold an agent back).
4. **Mail accumulates.** A vacationer's inbox keeps accepting messages; nothing
   nudges (no PTY); mail drains on recall.
5. **Session is preserved.** Recall resumes the agent's persisted pane session
   (machinery: pane session persistence, on main since dc10e32).

## Components

### Main process (hive.ts / index.ts)

- **Registry**: persist `vacation?: boolean` on entries, same pattern as
  `retired` (445d135). Setter clears/sets consistently with `archived: true`.
- **Park path**: new watched drop-dir `<hive>/vacation-requests/` (mirror of
  `fire-requests/`): god drops `{ "agentId": "...", "reason": "..." }`. Harness
  validates — agent exists, is not god, role is not `intern`, not already
  vacationed/retired — then tears down the PTY cleanly (same teardown as the fire
  path uses, minus retirement), sets `archived: true, vacation: true`, broadcasts
  the roster change (`hive:agentArchived` or a dedicated `hive:agentVacationed`
  event — implementer's call, but the renderer must update without reload; see
  fire-path precedent b33ff42). Rejections are answered with an inform message
  into god's inbox and a log.jsonl entry.
- **Recall path**: the existing spawn-request/restore machinery. `ensureAgent` /
  `spawnAgentCore` already restore archived agents with role preserved
  (restoreFromArchive seam, f1e3145/302f393); the only change is clearing
  `vacation` on successful respawn. Spawn refusal stays keyed on `retired` only.
- **Session persistence boot-respawn MUST skip vacationers.** Without this guard
  every harness restart would respawn the entire pool onto the floor (the
  fired-intern-resurrection class of bug, fixed for `retired` in 445d135 —
  vacation needs the same treatment in the boot-respawn filter).
- **fleet.json**: vacationers leave the active roster and appear in a
  `vacation: [...]` pool (id, name, role/description, parkedAt) so god's
  roster injection can offer them as fetchable before any spawn.

### Renderer (store.ts / CommandCenterPanel.tsx / agents pane)

- **Store**: `vacationAgents` selector next to `archivedAgents`; the archived
  list excludes vacationers; the restorable-team list excludes them too
  (they come back individually, not via Restore team).
- **VACATION section** in the Command Center, directly above `ArchivedSection`
  (mounted at CommandCenterPanel.tsx:907, section component pattern at :999):
  name, role, parked-since, per-agent **Recall** button. No delete control.
- **Delete guard**: `removeArchivedAgent` (store) and its main-process handler
  both refuse when `vacation: true` — belt and braces. An **End vacation**
  action (clears `vacation`, keeps `archived`) demotes to ARCHIVED, after which
  normal deletion applies. Two-step deletion is a hard requirement.
- **Send on vacation button** in the agents pane for human-created agents
  (visible only for eligible agents: not god, not intern, currently idle).
  Uses the same main-process park path god uses — one code path.
- **Renderer reload safety**: vacationers must not respawn on Ctrl+R — same
  `onRosterChange` seam that keeps retired agents down (15d18e6/302f393).

### Harness-shipped policy (AGENTS.md / godLine constants)

- Assignment order: idle floor agent → fetch fitting vacationer → intern/new
  spawn last (extends the existing roster-first rule).
- Auto-park rule: on heartbeat, human-created agents idle ≥ 30 min with no
  doing/blocked card and a drained inbox go on vacation via vacation-requests/.
- The LIVE ROSTER / heartbeat injection lists the vacation pool as fetchable.

## Error handling

- Park request for a busy/working agent: refused (agent must be idle — the
  requester sees a rejection inform; god's policy already checks, the harness
  re-checks).
- Park request for intern/god/unknown/already-parked: refused with reason.
- Recall of a non-existent or retired agent: existing spawn-path refusals apply.
- Crash between PTY teardown and flag write: on next boot the agent is simply
  archived (liveness truth); god notices the missing vacationer and re-parks.
  No corrupt state is possible because `vacation` without a PTY is always safe.

## Testing (node --test, files added to test:focused by hand — no glob)

Mirror `hive-retired-agents.test.cjs`:

1. Park sets `archived + vacation`, tears down PTY, broadcasts; registry persists.
2. Park refuses interns, god, working agents, already-parked.
3. Recall clears `vacation`, preserves role, resumes session; agent leaves pool.
4. Delete refused while `vacation: true` (store + main); allowed after End
   vacation.
5. Session-persistence boot respawn skips vacationers; retired still skipped;
   plain archived still not respawned.
6. Renderer store selectors: vacationers absent from `archivedAgents` and from
   the restore-team list, present in `vacationAgents`.
7. fleet.json contains the vacation pool; active roster excludes vacationers.

## Out of scope (YAGNI, discussed)

- Harness-side auto-park timer (god's heartbeat policy does it; judgment stays
  with god).
- Vacation for interns (they are fired, never parked) or god.
- Auto-recall on inbox mail for a vacationer (god routes work explicitly).
- Notifying vacationed agents of anything (they are not running).

## Implementation notes

- Branch off current main (dc10e32 or later) in a worktree — Pam is working
  fix branches in the main checkout concurrently (inbox-wake-quieting, then
  telegram settings). Both touch index.ts and the AGENTS.md constants; god
  integrates sequentially and resolves overlaps at merge.
- One commit per component group is fine; tests + `npm run typecheck` green
  before the done-report. NO push — god integrates, Stefan calls the push.
