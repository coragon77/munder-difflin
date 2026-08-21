# Worktree Seats — parallel agents on one merlin installation

Date: 2026-08-18 · Status: approved (Stefan, 2026-08-18) · Scope: qbase (all branches via merge pipeline), pilot installation merlin_schultzundschirm

## Problem

Several tickets for one customer need code changes, data changes, and migrations
in parallel, but a merlin installation has exactly one runtime: one dev database
(name from `instance_settings.DB_NAME`), one Elasticsearch namespace, one
`log/`. Git worktrees isolate code only; two agents migrating or mutating data
on the shared DB corrupt each other regardless of git. Divergent migrations on
one DB are not merely risky — the first `migrate` breaks the other agent's ORM
state.

## Decision

Extend the existing `qbase/.worktrees/<name>/` convention (gitignored via
`/.worktrees/` in `qbase/.gitignore`; settings support in
`qbase/settings.py:106-119`; documented in `docs/4.1/claude/onboarding.md:160-166`
and `:199-210`) so that a worktree carrying an empty `.seat` marker file gets a
private runtime database, a private Elasticsearch index namespace, and a private
log directory. Such a worktree is called a **seat**: one agent's complete,
runnable, disposable working environment. Everything an agent mutates is
per-seat; everything read-only stays a symlink to the trunk installation.

Rejected alternatives: a freestanding `seats/` layout (second convention no doc
or script knows), and PYTHONPATH-shadowed per-seat `instance_settings.py`
(forgotten env var silently writes to the trunk DB — unacceptable for
autonomous agents).

## 1. Settings extension (qbase)

All in `qbase/qbase/settings.py`, inert unless the marker exists. A worktree is
a seat iff `<worktree>/.seat` exists (empty file; add `.seat` to
`qbase/.gitignore`).

- In the existing `.worktrees` branch (line 111): when the marker is present,
  set `DATABASES["default"]["NAME"] = truncate_name(f"{db_name}__{worktree_name}", 63, 8)`
  — same derivation the test-DB name already uses. The test-DB name then derives
  from the seat DB name, so seat test runs stay isolated too. Record the seat
  name in a module-level variable (e.g. `_SEAT_NAME`, `None` otherwise) for the
  two later sites.
- `ELASTIC_INDEX_ID` (line 598) is assigned after the branch: append
  `_{_SEAT_NAME}` when set. Index names become `merlin_<slug(id_seat)>_<indexname>`
  (`qform/ibackends/elasticsearch_backend.py:686-692`), giving each seat a
  disjoint, prefix-deletable ES namespace.
- `LOG_DIR` (line 789) likewise: `normjoin(BASE_DIR, "log", _SEAT_NAME)` when
  set, so parallel seats do not interleave log files.

The double underscore in `<db>__<seat>` is the namespace guard rail used by
teardown (below). PostgreSQL's 63-byte identifier cap is handled by
`truncate_name` exactly as the existing test-DB line does.

The `.worktrees` settings branch already exists identically on
`feature/dj5_single_tenant` (settings.py:108-120) and
`feature/dj5_multi_tenant` (settings.py:146-158); this extension flows there
through the regular merge pipeline (asol-git-merge-main,
asol-git-merge-singletenant).

## 2. Seat lifecycle scripts (qbase root, precedent: set_base_url.sh)

- `create_seatbase.sh` — restores the installation's clonesource dump into
  `merlin_<db>_seatbase`, a database nothing ever connects to; template-cloning
  from it therefore always succeeds. Run once; re-run when the dump refreshes
  (seatbase refresh is the resident agent's job, alongside the existing
  update_system.sh flow).
- `create_seat.sh <name>` — from the trunk qbase checkout: ensure the
  `.worktrees/` sibling symlinks exist (`data`, `instance`, `qenv` — the
  arbeitskreis pattern; schultzundschirm currently lacks `qenv`), plus a real
  `log/` dir; `git worktree add .worktrees/<name>` (must run from within
  `qbase/`, per onboarding.md:162-166); `touch .worktrees/<name>/.seat`;
  `createdb -T merlin_<db>_seatbase merlin_<db>__<name>`.
- `drop_seat.sh <name>` — drop the seat DB only if its name matches
  `merlin_<db>__*` (never trunk); delete the seat's ES indexes by prefix
  (`DELETE merlin_<slug>_*` over the seat's suffixed index id — no whole-index
  management command exists, only per-document `delete_from_index`);
  `git worktree remove`.

Postgres rights: one-time `ALTER ROLE merlin CREATEDB` (approved) so seat
create/drop runs under the existing `merlin` credentials without root — unlike
`recreate_db.sh`, which needs `su postgres`.

## 3. Agent workflow inside a seat

From the seat root the documented workflow holds verbatim:
`source ../qenv/bin/activate && python manage.py …` (one level up is
`.worktrees/`, where the `qenv` symlink lives). First step after provisioning is
`python manage.py migrate` — the seatbase carries dump-time state. Then: ticket
branch in the worktree, migrations and destructive data experiments against the
private DB (wrecked DB = re-clone in seconds), and
`python manage.py recreate_indices <slug>` for only the querylists the ticket
touches (a fresh seat starts with empty indexes). Test DBs are already
per-worktree via the existing settings code.

Conventions, not code: runserver ports are picked per seat (any free port);
graphify — seats query the trunk `graphify-out/`, never run `graphify update`
from a seat; only trunk updates after landing.

## 4. Landing (integrator role)

All ticket work happens in seats, including the resident agent's own tickets.
The resident agent (Toby for schultzundschirm) is the only hand on trunk:

1. Seat agent pushes the ticket branch.
2. Resident merges it into `main` on the trunk checkout, resolves migration
   numbering collisions, runs trunk `migrate` plus at minimum the affected
   apps' tests (qbase `main` is every 4.1 customer's production branch).
3. Resident pushes — autonomously, superpowers-style; CI runs on push.
4. Seat is dropped (`drop_seat.sh`) or re-cloned for the next ticket.

Landing is serial by construction; parallelism lives in the seats.

## 5. Docs, rollout, hive side

- `docs/4.1/claude/onboarding.md`: extend the Git Worktrees section (:160-166)
  and the Testing Guidelines table (:199-210) with seat semantics (marker,
  runtime-DB naming, ES suffix, per-seat log). Port to 4.2/4.2t following the
  existing precedent commits (467b5f9a5, f56283a56).
- Rollout: schultzundschirm first (clean `.worktrees`). Precondition elsewhere:
  hlog, oegb, hlog42 have diverged `.worktrees` contents (real data copies,
  stale stubs) that need cleanup before seats go there; a2demo/bupress/kampa
  carry empty leftovers.
- Hive (not part of the qbase change): visiting hires get their seat path as
  registry `cwd`; god dispatches by seat; the resident agent owns seat
  provisioning, teardown, and seatbase refresh.

## Out of scope (v1 cuts, revisit when needed)

- Customer-repo isolation: `.worktrees/instance` is one shared symlink, and the
  `instance_settings` import (settings.py:21-24) runs before the worktree
  branch (settings.py:111), so per-seat instance dirs would need an
  import-order change. Customer-repo tickets serialize on the shared checkout
  (they are the minority: template overrides, management commands).
- Per-seat base URL / `set_base_url.sh` integration.
- A whole-index-drop management command (teardown uses the ES HTTP API).
