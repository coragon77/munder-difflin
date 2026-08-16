# Vacation State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give human-created agents a third resting place — **On Vacation**: off the floor, zero cost, individually recallable by god or a button, protected from one-click deletion.

**Architecture:** `vacation` is a persisted registry flag layered on top of `archived` (pure liveness), exactly as `retired` is (445d135). Main owns the flag and both transitions; a watched drop-dir `<hive>/vacation-requests/` gives god a Bash verb (park AND recall), three thin IPCs give the UI the *same* two functions, and the renderer mirrors the flag on its archived entries so the Command Center can split ARCHIVED into VACATION + ARCHIVED.

**Tech Stack:** Electron main (`src/main/hive.ts`, `src/main/index.ts`), preload bridge, React + zustand renderer, `node --test` (`.cjs`, via `test/load-ts.cjs`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-16-vacation-state-design.md` — authoritative, do not re-litigate.
- Only human-created agents may vacation: not god, not `role === 'intern'`, not `retired`. `vacation` and `retired` are mutually exclusive.
- `archived` stays pure liveness. A vacationer is `archived: true, vacation: true`.
- Two-step deletion is a hard requirement: delete is refused while `vacation` is set; **End vacation** demotes to ARCHIVED first.
- No push. Commits on `feat/vacation-state` only.
- Do **not** touch `useHive.ts` effect #3 (the nudge pipeline) — Pam owns that region.
- Tests: `node --test`, new files added to `test:focused` **by hand** (no glob).
- `npm run typecheck` must be green.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/main/hive.ts` | registry flag (`vacation`, `vacationSince`), `setVacation`/`isOnVacation`, `ensureAgent` clearing, roster-context vacation line, harness-shipped policy text |
| `src/main/index.ts` | `parkAgent`/`recallAgent`/`endVacation` core, `vacation-requests/` watcher, fleet `vacation` pool, IPC handlers |
| `src/preload/index.ts` | `hiveVacation*` bridge + `onHiveAgentVacationed` + `HiveRegistry.vacation` |
| `src/renderer/src/store/store.ts` | `Agent.vacation`, `archiveAgent(id, opts)`, `endVacationAgent`, delete guard, `vacationAgents`/`archivedOnlyAgents` selectors |
| `src/renderer/src/components/CommandCenterPanel.tsx` | `VacationSection` above `ArchivedSection`; ARCHIVED excludes vacationers |
| `src/renderer/src/components/AgentDetailPanel.tsx` | "Send on vacation" button (eligible agents only) |
| `src/renderer/src/hooks/useHive.ts` | effect 5b: `onHiveAgentVacationed` → `archiveAgent(id, {vacation:true})` |
| `src/renderer/src/hooks/useRestoreTeam.ts` | boot/manual restore skips registry vacationers |
| `test/hive-vacation.test.cjs` | registry + fleet-pool behaviour (spec tests 1,2,3,5,7) |
| `test/vacation-store.test.cjs` | renderer store selectors + delete guards (spec tests 4,6) |

---

### Task 1: Registry carries vacation

**Files:**
- Modify: `src/main/hive.ts` (`RegistryAgent`, `ensureAgent` upsert, next to `setRetired`)
- Test: `test/hive-vacation.test.cjs` (new)

**Interfaces:**
- Produces: `RegistryAgent.vacation?: boolean`, `RegistryAgent.vacationSince?: number`,
  `HiveManager.setVacation(id: string, vacation: boolean): void`,
  `HiveManager.isOnVacation(id: string): boolean`

- [ ] **Step 1: Write the failing tests** — `test/hive-vacation.test.cjs`, mirroring `test/hive-retired-agents.test.cjs`'s `floor()` helper. Cover: park sets `archived+vacation+vacationSince` and survives a fresh `HiveManager`; park refuses a retired agent and god; a respawn (`ensureAgent`) clears `vacation` while preserving role; `setVacation(id,false)` keeps `archived`; only a real flip calls `onRosterChange`, and a throwing snapshot writer does not roll back the flag.

- [ ] **Step 2: Run and watch it fail** — `node --test test/hive-vacation.test.cjs` → `setVacation is not a function`.

- [ ] **Step 3: Implement**

```ts
// RegistryAgent, next to `retired`:
  /** True while the agent is ON VACATION — parked by god (or the button), off the
   *  floor at zero cost, individually recallable and PROTECTED FROM DELETION.
   *  Layered on `archived` (liveness) exactly like `retired`, and mutually
   *  exclusive with it: a vacationer is resting, a retiree is gone. Ending the
   *  vacation clears this and leaves `archived` — that is the demotion to plain
   *  ARCHIVED which deletion requires. */
  vacation?: boolean;
  /** Epoch ms the agent was parked — the "parked 2h ago" the VACATION section and
   *  god's fetchable pool read. Cleared when the vacation ends. */
  vacationSince?: number;
```

```ts
// ensureAgent upsert, beside `archived: !!prev?.retired`:
      // A (re)spawn of a vacationer IS the recall — it is the only way back onto
      // the floor, so the flag clears here rather than in each caller.
      vacation: false,
      vacationSince: undefined,
```

```ts
  /**
   * Send an agent ON VACATION, or end one. Vacation is a flag on top of
   * `archived` (liveness), the same shape as `retired` (445d135) — a vacationer
   * genuinely has no PTY, so the boot sweep, broadcast fan-out, heartbeat roster
   * and nudge poller all skip it with no new exemptions.
   *
   * Parking also archives. ENDING a vacation deliberately does NOT unarchive: it
   * demotes the agent to plain ARCHIVED, which is the first half of the two-step
   * deletion the feature promises. The way back onto the floor is a respawn
   * (ensureAgent clears the flag).
   *
   * Refused for the retired (`vacation` and `retired` are mutually exclusive —
   * a fired agent is gone, not resting) and for god. The intern check lives at
   * the park path in main, which knows the caller; here we guard what the
   * registry itself can see. Best-effort + idempotent like setArchived/setRetired.
   */
  setVacation(id: string, vacation: boolean): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || !!agent.vacation === vacation) return;
      if (vacation && (agent.retired || agent.isGod || reg.godId === id)) return;
      agent.vacation = vacation;
      if (vacation) {
        agent.archived = true;
        agent.vacationSince = Date.now();
      } else {
        delete agent.vacationSince;
      }
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'vacation', agentId: id, vacation });
      this.commit(`hive: ${vacation ? 'park' : 'unpark'} ${id}`);
      try { this.onRosterChange?.(); } catch { /* snapshot is best-effort */ }
    } catch { /* best-effort — never crash a lifecycle handler */ }
  }

  /** True while the agent is parked. The fleet builder, the park path and the
   *  delete guards all read this. */
  isOnVacation(id: string): boolean {
    return !!this.registry().agents[id]?.vacation;
  }
```

- [ ] **Step 4: Run the tests** → PASS.

- [ ] **Step 5: Commit** — `feat(hive): registry carries a vacation flag on top of archived`

---

### Task 2: Park / recall / end-vacation in main + the drop-dir + fleet pool

**Files:**
- Modify: `src/main/index.ts` (`writeFleetSnapshot`, request dirs, worker tick, IPC block near `hive:registry`)
- Test: `test/hive-vacation.test.cjs` (extend — fleet pool shape)

**Interfaces:**
- Consumes: `hive.setVacation`, `hive.isOnVacation` (Task 1)
- Produces: `parkAgent(agentId: string, reason?: string): { ok: boolean; error?: string }`,
  `recallAgent(agentId: string): Promise<{ ok: boolean; error?: string }>`,
  IPC `hive:park` `(id, reason?)`, `hive:recall` `(id)`, `hive:endVacation` `(id)`;
  broadcast `hive:agentVacationed` `{ id, vacationSince }`; fleet.json gains
  `vacation: Array<{ id, name, role, cwd, parkedAt }>`

- [ ] **Step 1: Write the failing fleet-pool test** — mirror main's builder in the test (as `activeIds` already does) and assert a parked agent leaves the active roster and appears in the pool with `parkedAt`.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement — fleet pool** (`writeFleetSnapshot`)

```ts
    // Vacationers are NOT floor capacity (they have no PTY), but god must be able
    // to FETCH one back instead of spawning a stranger — so they ride along as a
    // separate pool the roster injection offers as fetchable.
    const vacation = Object.entries(reg.agents)
      .filter(([, a]) => !!a.vacation && !a.retired)
      .map(([id, a]) => ({
        id,
        name: a.name,
        role: a.role ?? 'agent',
        cwd: a.cwd,
        parkedAt: a.vacationSince ?? null
      }));
    hive.writeFleetSnapshot({ ts: now, agents, vacation });
```

- [ ] **Step 4: Implement — the two core functions** (beside `processFireRequest`)

```ts
/** An agent counts as BUSY when its PTY printed inside this window — the same
 *  objective, main-owned signal the repo checkout guard uses (index.ts:3254).
 *  Registry `status` is written once at spawn and never updated, so it cannot
 *  answer this. */
const VACATION_BUSY_MS = 10_000;

/** Send a human-created agent on vacation: validate, tear the PTY down cleanly,
 *  set `archived + vacation`, tell the floor. One code path for god's
 *  vacation-request, the UI button and the voice verb. */
function parkAgent(agentId: string, reason?: string): { ok: boolean; error?: string } {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled' };
  const reg = hive.registry();
  const entry = reg.agents[agentId];
  if (!entry) return { ok: false, error: `no agent "${agentId}" in the registry` };
  if (entry.isGod || reg.godId === agentId) return { ok: false, error: 'god does not go on vacation' };
  if (entry.role === 'intern') return { ok: false, error: `"${agentId}" is an intern — interns are fired, never parked` };
  if (entry.retired) return { ok: false, error: `"${agentId}" was fired — retired and vacation are mutually exclusive` };
  if (entry.vacation) return { ok: false, error: `"${agentId}" is already on vacation` };
  const ptyId = ptyForAgent(agentId);
  if (ptyId) {
    const last = ptyManager.lastOutputAt(ptyId);
    if (typeof last === 'number' && Date.now() - last < VACATION_BUSY_MS) {
      return { ok: false, error: `"${agentId}" is actively working — park it when it goes quiet` };
    }
    try { ptyManager.kill(ptyId); } catch { /* already gone — teardown is idempotent */ }
    teardownPty(ptyId);   // sets archived (liveness); vacation is the layer on top
  }
  hive.setVacation(agentId, true);
  const vacationSince = hive.registry().agents[agentId]?.vacationSince ?? Date.now();
  try { liveWebContents()?.send('hive:agentVacationed', { id: agentId, vacationSince }); } catch { /* window gone */ }
  hive.appendLog({ kind: 'vacation_park', agentId, reason: reason ?? null });
  console.log(`[vacation] parked ${agentId}${reason ? ` — ${reason}` : ''}`);
  return { ok: true };
}

/** Fetch a vacationer back onto the floor. The spawn is the recall: ensureAgent
 *  clears `vacation`, the registry keeps role/cwd/provider, and the session
 *  resume machinery reattaches the agent's own thread. The spawn RECIPE
 *  (command/model) lives in the renderer's roster mirror, so we read it back
 *  from roster.json and fall back to the configured default engine. */
async function recallAgent(agentId: string): Promise<{ ok: boolean; error?: string }> {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled' };
  const entry = hive.registry().agents[agentId];
  if (!entry) return { ok: false, error: `no agent "${agentId}" in the registry` };
  if (entry.retired) return { ok: false, error: `"${agentId}" was fired — reinstate them first` };
  if (ptyForAgent(agentId)) return { ok: false, error: `"${agentId}" is already on the floor` };
  const recipe = rosterRecipe(agentId);
  let command = recipe.command ?? readConfig().defaultCommand ?? 'claude';
  const provider = entry.provider ?? inferAgentProvider(command);
  {
    const preset = providerPreset(provider);
    if (readConfig().autoMode && preset.autoFlag && !command.includes(preset.autoFlag)) {
      command = `${command} ${preset.autoFlag}`;
    }
  }
  const bin = command.split(/\s+/)[0] || command;
  if (!ptyManager.isCommandAvailable(bin)) return { ok: false, error: `engine CLI "${bin}" is not installed` };
  const cwd = recipe.cwd ?? entry.cwd;
  if (!cwd || !existsSync(cwd)) return { ok: false, error: `cwd missing or not found (${cwd || 'unset'})` };
  const res = await spawnAgentCore({
    id: agentId, cwd, command, cols: 120, rows: 32,
    args: recipe.model ? ['--model', recipe.model] : [],
    hive: { id: agentId, name: entry.name, provider, role: entry.role, cwd },
    isolate: false, provider
  }, liveWebContents());
  if (!res.ok) return { ok: false, error: res.error ?? 'spawn failed' };
  try {
    liveWebContents()?.send('hive:agentSpawned', {
      id: agentId, name: entry.name, provider, cwd: res.worktreePath ?? cwd,
      command, role: entry.role, worktreePath: res.worktreePath
    });
  } catch { /* window torn down */ }
  hive.appendLog({ kind: 'vacation_recall', agentId });
  console.log(`[vacation] recalled ${agentId}`);
  return { ok: true };
}

/** The spawn recipe for an id from the renderer's roster mirror (roster.json) —
 *  `command`/`model`/`cwd` live in the renderer's Agent, not in the registry.
 *  Every field is optional: a missing mirror just means falling back to the
 *  configured default engine and the registry cwd. */
function rosterRecipe(id: string): { command?: string; model?: string; cwd?: string } {
  try {
    const snap = roster.read();
    if (!snap) return {};
    const rows = [...snap.agents, ...snap.archived, ...snap.restorable] as Array<{
      id?: string; command?: string; model?: string; cwd?: string;
    }>;
    const row = rows.find((a) => a?.id === id);
    return row ? { command: row.command, model: row.model, cwd: row.cwd } : {};
  } catch { return {}; }
}
```

- [ ] **Step 5: Implement — the drop-dir + watcher**

```ts
/** HIVE_ROOT/vacation-requests — the queue dir god drops park/recall requests
 *  into. Mirrors fire-requests, incl. the `.done`/`.failed` archive subdirs.
 *  `{ "agentId": "...", "reason": "..." }` parks; `"action": "recall"` fetches
 *  back. ONE dir for both directions: god is autonomous either way, and a second
 *  watcher would buy nothing. */
function vacationRequestsDir(): string | null {
  const root = hive.root();
  return root ? join(root, 'vacation-requests') : null;
}

async function processVacationRequest(filePath: string): Promise<void> {
  let raw: { agentId?: string; id?: string; action?: string; reason?: string };
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    informGod('[vacation rejected] unparseable request', `Could not parse vacation-request ${basename(filePath)} — ${String(e)}`);
    archiveRequestIn(vacationRequestsDir(), filePath, '.failed');
    return;
  }
  const fail = (reason: string): void => {
    informGod('[vacation rejected]', `Vacation-request ${basename(filePath)} rejected: ${reason}.`);
    archiveRequestIn(vacationRequestsDir(), filePath, '.failed');
  };
  // `id` accepted beside `agentId` — both spellings ship in the docs' sibling
  // request formats, and a typo here would otherwise read as a silent no-op.
  const agentId = (typeof raw.agentId === 'string' ? raw.agentId : typeof raw.id === 'string' ? raw.id : '').trim();
  if (!agentId) { fail('missing "agentId"'); return; }
  const recall = String(raw.action ?? 'park').toLowerCase() === 'recall';
  const res = recall ? await recallAgent(agentId) : parkAgent(agentId, raw.reason);
  if (!res.ok) { fail(res.error ?? 'unknown error'); return; }
  informGod(
    recall ? `[recalled] ${agentId}` : `[on vacation] ${agentId}`,
    recall
      ? `${agentId} is back on the floor — its pane resumed the agent's own session and its inbox drains on the next turn.`
      : `${agentId} is on vacation: terminal closed, zero cost, off the floor but NOT deletable. Fetch it back with an "action":"recall" vacation-request when work fits it.`
  );
  archiveRequestIn(vacationRequestsDir(), filePath, '.done');
}
```

Watcher step, right after the fire-requests block `(2b)` in `ephemeralWorkerTick`:

```ts
    // (2c) Vacation requests — god parking an idle human-created agent, or
    //      fetching one back. Interns and god are refused (they are fired /
    //      never parked); the harness re-checks every rule god's policy states.
    const vdir = vacationRequestsDir();
    if (vdir && existsSync(vdir)) {
      let files: string[] = [];
      try { files = readdirSync(vdir).filter(f => f.endsWith('.json')).sort(); } catch { /* dir vanished */ }
      for (const f of files) await processVacationRequest(join(vdir, f));
    }
```

and in `startEphemeralWorkerWatcher`, create the dir the way `spawnRequestsDir` is created.

- [ ] **Step 6: Implement — IPC** (beside `ipcMain.handle('hive:registry', …)`)

```ts
// The UI's park/recall/end-vacation buttons run the SAME functions god's
// vacation-requests do — one code path, so the rules can't drift between them.
ipcMain.handle('hive:park', (_e, id: string, reason?: string) => parkAgent(id, reason));
ipcMain.handle('hive:recall', (_e, id: string) => recallAgent(id));
// Ending a vacation demotes to plain ARCHIVED — the first half of the two-step
// deletion. It never respawns; that is what recall is for.
ipcMain.handle('hive:endVacation', (_e, id: string) => {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled' };
  hive.setVacation(id, false);
  return { ok: true };
});
```

Also extend the existing `setArchived` realtime action so an explicit unarchive
clears `vacation` alongside `retired` (`if (!archived) { hive.setRetired(id,false); hive.setVacation(id,false); }`).

- [ ] **Step 7: Run** `node --test test/hive-vacation.test.cjs` → PASS. `npm run typecheck:node` → green.

- [ ] **Step 8: Commit** — `feat(hive): vacation-requests park/recall path + fleet vacation pool`

---

### Task 3: Preload bridge

**Files:**
- Modify: `src/preload/index.ts` (`HiveRegistry` agent shape, api block, `onHiveAgentVacationed`)

**Interfaces:**
- Produces: `window.cth.hivePark(id, reason?)`, `hiveRecall(id)`, `hiveEndVacation(id)`,
  `onHiveAgentVacationed(cb)`; `HiveRegistry.agents[id].vacation?: boolean`,
  `.vacationSince?: number`, `.retired?: boolean`, `.role?: string`

- [ ] **Step 1: Extend the registry type**

```ts
    archived?: boolean;
    /** parked: off the floor, zero cost, recallable, NOT deletable */
    vacation?: boolean;
    vacationSince?: number;
    retired?: boolean;
    sessionId?: string;
```

- [ ] **Step 2: Add the three invokes + the listener**

```ts
  /** Park a human-created agent (the same main path god's vacation-requests use). */
  hivePark: (id: string, reason?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:park', id, reason),
  /** Fetch a vacationer back onto the floor — the respawn IS the recall. */
  hiveRecall: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:recall', id),
  /** Demote a vacationer to plain ARCHIVED (step one of the two-step delete). */
  hiveEndVacation: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:endVacation', id),
  /** A MAIN-initiated park — the renderer moves the card into VACATION, since it
   *  did not initiate the park itself. Sibling of onHiveAgentArchived. */
  onHiveAgentVacationed: (cb: (e: { id: string; vacationSince?: number }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: string; vacationSince?: number }) => cb(payload);
    ipcRenderer.on('hive:agentVacationed', listener);
    return () => ipcRenderer.removeListener('hive:agentVacationed', listener);
  },
```

- [ ] **Step 3: `npm run typecheck` → green. Commit** — `feat(preload): vacation bridge (park/recall/end + vacationed broadcast)`

---

### Task 4: Renderer store — the flag, the split, the delete guard

**Files:**
- Modify: `src/renderer/src/store/store.ts`
- Test: `test/vacation-store.test.cjs` (new)

**Interfaces:**
- Produces: `Agent.vacation?: boolean`, `Agent.vacationSince?: number`,
  `archiveAgent(id: string, opts?: { vacation?: boolean; vacationSince?: number })`,
  `endVacationAgent(id: string): void`,
  `vacationAgents(s: State): Agent[]`, `archivedOnlyAgents(s: State): Agent[]`

- [ ] **Step 1: Write the failing tests** — `test/vacation-store.test.cjs`, shimming
  `window`/`localStorage` before the store import exactly as `test/restore-team.test.cjs` does.
  Cover: parking moves the card into `archivedAgents` flagged `vacation`, drops it from
  `restorableAgents`, and persists both; `vacationAgents` holds it while `archivedOnlyAgents`
  does not; `removeArchivedAgent` refuses while parked; `endVacationAgent` clears the flag and
  then deletion works; a respawn (`addAgent`) removes it from the archived list.

- [ ] **Step 2: Run → fail** (`endVacationAgent is not a function`).

- [ ] **Step 3: Implement**

```ts
// Agent, next to `archived`:
  /** True while this agent is ON VACATION — archived AND parked: shown in the
   *  Command Center's VACATION section instead of ARCHIVED, recallable with one
   *  click, and refused by the delete control until the vacation is ended. */
  vacation?: boolean;
  /** Epoch ms this agent was parked — drives the "parked 2h ago" line. */
  vacationSince?: number;
```

```ts
  // State signature:
  archiveAgent: (id: string, opts?: { vacation?: boolean; vacationSince?: number }) => void;
  /** End a vacation locally: the entry stays archived but loses the flag, which
   *  is what re-enables deletion. Main owns the registry half (hiveEndVacation). */
  endVacationAgent: (id: string) => void;
```

```ts
  // archiveAgent implementation — signature + the archived copy:
  archiveAgent: (id, opts) =>
    …
      const archivedEntry: Agent = {
        ...target,
        archived: true,
        // A park is an archive PLUS the flag — same teardown, different shelf.
        ...(opts?.vacation ? { vacation: true, vacationSince: opts.vacationSince ?? Date.now() } : {}),
        ptyId: undefined,
        status: 'idle',
        action: opts?.vacation ? 'on vacation' : 'archived',
        …
```

An already-archived agent (parked while its terminal was already closed) hits the
`!target` early return, so patch that branch too:

```ts
      const target = s.agents.find((a) => a.id === id);
      if (!target) {
        // No floor card: main parked an agent whose terminal was already gone.
        // Flag the existing archived entry in place so it still lands in VACATION.
        if (opts?.vacation && s.archivedAgents.some((a) => a.id === id)) {
          const archivedAgents = s.archivedAgents.map((a) =>
            a.id === id ? { ...a, vacation: true, vacationSince: opts.vacationSince ?? Date.now() } : a);
          persistArchived(archivedAgents);
          return wasRestorable ? { archivedAgents, restorableAgents } : { archivedAgents };
        }
        return wasRestorable ? { restorableAgents } : s;
      }
```

```ts
  endVacationAgent: (id) =>
    set((s) => {
      if (!s.archivedAgents.some((a) => a.id === id && a.vacation)) return s;
      const archivedAgents = s.archivedAgents.map((a) =>
        a.id === id ? { ...a, vacation: undefined, vacationSince: undefined, action: 'archived' } : a);
      persistArchived(archivedAgents);
      return { archivedAgents };
    }),
  removeArchivedAgent: (id) =>
    set((s) => {
      const target = s.archivedAgents.find((a) => a.id === id);
      if (!target) return s;
      // BELT: a vacationer is protected from deletion — end the vacation first
      // (that demotes it to plain ARCHIVED). Main holds the braces: the registry
      // flag only clears through hive:endVacation.
      if (target.vacation) return s;
      …
```

```ts
// Beside selectedAgent():
/** Parked agents — shown in the Command Center's VACATION section. Derived from
 *  `archivedAgents` rather than stored beside it, so the two lists cannot fall
 *  out of step. Wrap the call in useMemo: it returns a fresh array. */
export function vacationAgents(s: State): Agent[] {
  return s.archivedAgents.filter((a) => a.vacation);
}
/** Genuinely archived agents — vacationers live on their own shelf. */
export function archivedOnlyAgents(s: State): Agent[] {
  return s.archivedAgents.filter((a) => !a.vacation);
}
```

- [ ] **Step 4: Run** `node --test test/vacation-store.test.cjs` → PASS.

- [ ] **Step 5: Commit** — `feat(store): vacation shelf, recall-safe archive, delete guard`

---

### Task 5: UI — VACATION section, the park button, the broadcast listener, restore-team skip

**Files:**
- Modify: `src/renderer/src/components/CommandCenterPanel.tsx` (`ArchivedSection`, new `VacationSection`, mount point)
- Modify: `src/renderer/src/components/AgentDetailPanel.tsx` (header button)
- Modify: `src/renderer/src/hooks/useHive.ts` (effect **5b** only — never effect #3)
- Modify: `src/renderer/src/hooks/useRestoreTeam.ts` (skip registry vacationers)

**Interfaces:**
- Consumes: `vacationAgents`, `archivedOnlyAgents`, `endVacationAgent`, `archiveAgent(id, opts)` (Task 4); `window.cth.hivePark/hiveRecall/hiveEndVacation/onHiveAgentVacationed` (Task 3)

- [ ] **Step 1: `VacationSection`** — copy `ArchivedSection`'s shape; per row: name, role/`description`, "parked 2h ago", **Recall** and **End vacation** buttons, **no delete control**. Mount `<VacationSection />` immediately above `<ArchivedSection />`.

```tsx
function VacationSection() {
  const archived = useStore((s) => s.archivedAgents);
  const vacationers = useMemo(() => archived.filter((a) => a.vacation), [archived]);
  const endVacationAgent = useStore((s) => s.endVacationAgent);
  const [busy, setBusy] = useState<string | null>(null);
  if (vacationers.length === 0) return null;
  const recall = async (id: string) => {
    setBusy(id);
    try { await window.cth.hiveRecall(id); } finally { setBusy(null); }
  };
  const end = async (id: string) => {
    setBusy(id);
    try { await window.cth.hiveEndVacation(id); endVacationAgent(id); } finally { setBusy(null); }
  };
  …
}
```

`ArchivedSection` switches to `archived.filter((a) => !a.vacation)` (same `useMemo` shape) so a vacationer never shows on both shelves.

- [ ] **Step 2: "Send on vacation" button** in `AgentDetailPanel`'s header, left of the destructive kill button:

```tsx
  // Only human-created hires go on vacation — god runs the floor and interns get
  // fired, never parked. `isReal` keeps the button off a card with no terminal.
  const canPark = isReal && agentClassOf(agent) === 'human';
  const onPark = async () => {
    const res = await window.cth.hivePark(agent.id, 'parked from the agent pane');
    if (!res.ok) { setOpenTerminalError(res.error ?? 'could not park this agent'); return; }
    if (agent.ptyId) disposeTerminal(agent.ptyId);
    archiveAgent(agent.id, { vacation: true });
  };
```

- [ ] **Step 3: `useHive` effect 5b** — add beside `offArchive`:

```ts
    // A MAIN-initiated PARK. Same shape as the archive broadcast, different
    // shelf: the card lands in VACATION, keeps its record, and is undeletable
    // until the vacation ends.
    const offVacation = window.cth.onHiveAgentVacationed?.((e) => {
      if (e?.id) useStore.getState().archiveAgent(e.id, { vacation: true, vacationSince: e.vacationSince });
    });
    return () => { offSpawn?.(); offArchive?.(); offVacation?.(); };
```

- [ ] **Step 4: restore-team skip** — in `restoreTeam()`, before the spawn loop:

```ts
    // A VACATIONER MUST NOT COME BACK ON ITS OWN. Restore-team also runs
    // automatically at boot, so without this a restart would walk the whole
    // parked pool back onto the floor — the resurrection class of bug `retired`
    // was given its own flag to stop (445d135). The registry is the authority;
    // the renderer's own copy can be stale after a crash mid-park.
    let parked = new Set<string>();
    try {
      const reg = await window.cth.hiveRegistry();
      parked = new Set(Object.entries(reg.agents).filter(([, a]) => a.vacation).map(([id]) => id));
    } catch { /* registry unreadable — fall through, the spawn door still refuses nothing */ }
    const restorableAgents = useStore.getState().restorableAgents.filter((a) => !parked.has(a.id));
```

- [ ] **Step 5:** `npm run typecheck` → green. **Commit** — `feat(ui): VACATION section, park button, recall — parked agents stay parked across a restart`

---

### Task 6: Harness-shipped policy + test wiring + green gate

**Files:**
- Modify: `src/main/hive.ts` (`HIVE_ROOT_AGENTS_MD`, `HIRING_AGENTS_MD`, godLine, `rosterContext`)
- Modify: `package.json` (`test:focused`)

- [ ] **Step 1: `rosterContext()`** — read the pool from fleet.json and append one line when non-empty:

```ts
      const pool = Array.isArray((snap as { vacation?: unknown[] }).vacation)
        ? (snap as { vacation: Array<{ id: string; name?: string; role?: string }> }).vacation : [];
      const vacationLine = pool.length
        ? ` ON VACATION (parked, zero cost, FETCHABLE — prefer fetching a fitting one back over spawning anyone new): `
          + `${pool.map((v) => `${v.id}${v.name ? ` "${v.name}"` : ''} (${v.role ?? 'agent'})`).join('; ')}.`
        : '';
```

- [ ] **Step 2: `HIVE_ROOT_AGENTS_MD`** — a new "## Vacation (orchestrator/god)" section stating the assignment order (idle floor agent → fetch a fitting vacationer → intern/new spawn last), the auto-park rule (human-created, idle ≥ 30 min, no doing/blocked card, drained inbox → park; god's judgment may hold one back), and that vacationers are protected from deletion. Extend the existing "Roster first" section's ladder to name the vacation pool.

- [ ] **Step 3: `HIRING_AGENTS_MD`** — a "**Parking a human-created agent**" block with both request templates:

````markdown
```bash
cat > "${HIVE_ROOT:-…}/vacation-requests/park-pam.json" <<'EOF'
{ "agentId": "pam-1", "reason": "idle 30min, no open card" }
EOF
```
…and to fetch them back:
```bash
cat > "${HIVE_ROOT:-…}/vacation-requests/recall-pam.json" <<'EOF'
{ "agentId": "pam-1", "action": "recall" }
EOF
```
````

- [ ] **Step 4: godLine** — one clause: check the vacation pool in fleet.json before spawning; park idle human-created agents via `vacation-requests/`; interns are fired, never parked.

- [ ] **Step 5: `package.json`** — append `test/hive-vacation.test.cjs test/vacation-store.test.cjs` to `test:focused` by hand.

- [ ] **Step 6: Full gate** — `npm run test:focused` and `npm run typecheck`, both green. Fix anything red.

- [ ] **Step 7: Commit** — `docs(hive): ship the vacation policy in AGENTS.md + wire the tests`

---

## Self-Review

**Spec coverage:** registry flag → T1; park path + broadcast + rejections + inform → T2; recall clearing `vacation` → T1 (`ensureAgent`) + T2 (`recallAgent`); boot-respawn skip → T5 step 4; fleet pool → T2; store selectors + archived exclusion + restorable exclusion → T4/T5; VACATION section → T5; both delete guards → T4 (store) + T2 (registry-owned flag, cleared only via `hive:endVacation`); park button → T5; reload safety → T5 step 4; policy text → T6; tests 1–7 → T1/T2/T4.

---

## Deviations from spec

All three raised with god before implementation and **APPROVED** (2026-08-16,
conv-f491cb). Recorded here so the spec/plan pair stays honest.

1. The spec routes recall through "the existing spawn-request/restore machinery", but `spawn-requests/` mints `intern-<id>`/`worker-<id>` ids — it cannot address an existing human-created agent. Recall is therefore the second verb of the *same* `vacation-requests/` watcher (`"action": "recall"`), which keeps decision #2 ("god is autonomous both directions") real with one watcher instead of two.
2. "…and its main-process handler" for the delete guard: this codebase has **no** main-process delete-agent handler (deletion is renderer-only — `removeArchivedAgent` drops the renderer entry; the registry always keeps its record). The braces are therefore the registry itself: `vacation` only clears through `hive:endVacation`/a respawn, so the renderer cannot delete a parked agent even with a stale local flag.
3. Busy detection uses `ptyManager.lastOutputAt` (the repo-checkout guard's precedent), because `RegistryAgent.status` is written once at spawn and never updated.
