---
name: new-agent
version: 1.0.0
description: |
  Start a FRESH conversation in an EXISTING agent's pane, without a card:
  resolves an agent name (e.g. "Creed") to its agent id and runs
  $HIVE_ROOT/bin/hive-new <agentId> --lead "<topic>". Use when the operator
  says "new Creed", "give <name> a fresh conversation", "/new-agent <name>
  [topic]", or wants an agent's pane reset for new work. NOT for hiring —
  a brand-new agent is spawn-requests/ (see COMMANDS.md). Never targets the
  god pane (the CLI refuses it).
allowed-tools:
  - Read
  - Bash
---

## new-agent — fresh conversation for an existing agent

Two steps: resolve the name, run the CLI. Do not improvise alternatives
(no direct pane writes, no card juggling — the CLI is the surface).

1. **Resolve the agent** — read `$HIVE_ROOT/registry.json`. Accept, in order:
   - an exact agent **id** (`creed-msvfirau`) — use as-is;
   - a case-insensitive **name** match (`Creed`, `creed`);
   - a unique **id prefix** (`creed-` when only one match).
   Multiple matches (several Pams/Dwights) → STOP and list the candidates
   with their roles; ask which one. No match at all → say so, do not spawn.

2. **Run it** — the optional topic becomes the lead line (the fresh
   conversation's first user turn, so it is named/anchored by the topic):

   ```bash
   "$HIVE_ROOT/bin/hive-new" <agentId> --lead "<topic>"
   ```

   Omit `--lead` when no topic was given. Quote the topic; keep it one line.

3. **Report** — relay the CLI's output line verbatim: the request is queued,
   delivered on the next poll (~1.5s), and only once the agent's pane goes
   idle (a busy agent keeps its conversation until it finishes). Remind the
   operator of that idle-gate when they expect an instant reset.

Notes: the previous conversation stays resumable by the card-session
machinery if a card ever points at it; memory.md is the bridge between
conversations, so nothing durable is lost by a /new.
