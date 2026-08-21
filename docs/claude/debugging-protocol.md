<!-- Generated from the asol-docs skill templates. Edit at source
     (asol-docs/templates/claude/debugging-protocol.md), not here — the drift
     report flags local edits as divergence. Project-specific debugging quirks
     belong in claude/onboarding.md under "Project deltas". -->

# Debugging Protocol

**For general debugging methodology:** use the `superpowers:systematic-debugging`
skill. This document covers the Django-specific patterns that supplement it.

------------------------------------------------------------------------

## Django-specific anti-patterns

When tracing execution flow (phase 1 of systematic-debugging), watch for these:

### Stale object state

- `bulk_update()` followed by `save()` on stale in-memory objects
- Objects created before relationships exist, then saved afterwards
- In-memory objects that do not reflect database changes from bulk operations
- Signal handlers that modify objects after bulk operations

### Why this matters

Individual components often work perfectly in isolation, and the bug lives in
the **interaction between operations**. A stale in-memory object overwrites
correct database state. Working components plus broken integration equals
production data corruption.

### Key questions

1. What writes to the database, and when?
2. Could any later operation undo an earlier one?
3. Do the objects reflect current database state before the operation runs?

------------------------------------------------------------------------

## Production data investigation

Investigating a data issue is not the same as debugging code. Use this protocol.

### Confidence indicators

Mark every finding with its confidence:

- **Confirmed** — directly verified through manual queries
- **Likely** — inferred from strong evidence
- **Possible** — suggested by partial evidence
- **Unknown** — no evidence found

### Cross-verification

Test data with more than one approach — a management command and a manual query.
When two tools disagree, manual verification is authoritative. State which method
produced each finding. Check that date filters and constraints actually filter.

### Example

**Bad:** "The check command shows TB 1719 has missing records, so it needs to be
fixed."

**Good:** "The check command flags TB 1719 as having 75 missing HVB records.
Manual verification shows these are all from 2025, the current cycle.
**Confirmed:** TB 1719 has no historical problem. **Tool issue:** the date filter
is not applied."

------------------------------------------------------------------------

## Feeding what you learned back into the docs

A debugging session is where scar tissue is produced, and it is the one write
path into an architecture doc that needs no gate. When a bug turns out to have a
non-obvious cause that the subsystem's architecture doc does not mention, add it
to that doc's Gotchas section in the same session, while it is verified and
fresh. Bump `Last Updated`. If you touched code outside the doc's coverage globs
while fixing it, extend the globs.
