'use strict';

/**
 * vacation-flow (card vacation-mainproc-coverage-20260816).
 *
 * The vacation main-process layer (parkAgent / recallAgent /
 * processVacationRequest in index.ts) had ZERO automated coverage — the four
 * real defects the feature shipped with (TUI-repaint busy gate, park failure
 * not propagated, recall repair failure silently green, park→recall worktree
 * leak) were all found by review, none by tests. The pure decision rules were
 * already extracted and pinned (vacationBusy, shouldAdoptWorktree); this file
 * pins the remaining guard chains, extracted verbatim into vacationFlow.ts:
 *
 *   • parkAgentCore — the refusal ladder (disabled → unknown → god → intern →
 *     retired → already-parked → busy), the PTY teardown ORDER (drop worktree
 *     entries → kill → teardown → THEN persist), and the park failure
 *     propagation: a setVacation that reports false must log
 *     vacation_park_failed and answer not-ok — the agent is archived but NOT
 *     protected, and god must hear that, not "parked".
 *   • recallAgentCore — the recall ladder (disabled → unknown → retired →
 *     not-on-vacation → already-on-floor), the engine/cwd availability guards,
 *     the exact spawn recipe (isolate:false + the worktree cwd — the inputs
 *     shouldAdoptWorktree needs), and the repair block: a spawn that left the
 *     vacation flag set is repaired here; a repair that fails logs
 *     vacation_recall_repair_failed and answers not-ok instead of green.
 *   • vacationRequestTarget — the request parse/verb/id resolution: `agentId`
 *     or the `id` fallback spelling, trimmed; action "recall"
 *     case-insensitive; reason passthrough; the missing-id rejection.
 *
 * Characterization contract: these tests describe EXACTLY what the inline code
 * did at extraction time (main @ 0170dfa). Zero behavior change — if one of
 * these fails after an intentional behavior change, the change needs the test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parkAgentCore, recallAgentCore, vacationRequestTarget } = loadTs(
  'src/main/vacationFlow.ts',
);

// ─── harness ────────────────────────────────────────────────────────────────

/** A registry entry factory — only the fields the guard chains read. */
function entry(over = {}) {
  return {
    id: over.id ?? 'bob',
    name: over.name ?? 'Bob',
    status: 'idle',
    lastSeen: 0,
    cwd: over.cwd ?? '/floor/bob',
    role: over.role ?? 'worker',
    ...over,
  };
}

function registry(agents, godId = 'michael') {
  return { godId, agents };
}

/** Deps factory with an event tape: every side effect records
 *  `name[:detail]`, so tests assert ORDER, not just occurrence. */
function tape() {
  const events = [];
  return {
    events,
    push: (name, detail) => events.push(detail === undefined ? name : `${name}:${detail}`),
    has: (name) => events.some((e) => e === name || e.startsWith(`${name}:`)),
    before: (a, b) => events.indexOf(a) < events.indexOf(b),
  };
}

function parkDeps(over = {}) {
  const t = over.tape ?? tape();
  const reg = over.registry ?? registry({ bob: over.bob ?? entry() });
  const calls = { busy: 0 };
  const deps = {
    hiveEnabled: () => over.enabled ?? true,
    registry: () => reg,
    ptyForAgent: (id) => (over.ptyId !== undefined && id === 'bob' ? over.ptyId : undefined),
    busy: (_ptyId) => {
      calls.busy++;
      return over.busy ?? false;
    },
    dropWorktree: (ptyId) => t.push('dropWorktree', ptyId),
    killPty: (ptyId) => t.push('killPty', ptyId),
    teardownPty: (ptyId) => t.push('teardownPty', ptyId),
    setVacation: (id, v) => {
      t.push('setVacation', `${id}=${v}`);
      return over.setVacationResult ?? true;
    },
    appendLog: (e) => t.push('appendLog', JSON.stringify(e)),
    notifyVacationed: (e) => {
      t.push('notifyVacationed', JSON.stringify(e));
      if (over.notifyThrows) throw new Error('window gone');
    },
    log: (...args) => t.push('log', args.join(' ')),
    error: (...args) => t.push('error', args.join(' ')),
    ...over.deps,
  };
  return { deps, t, reg, calls };
}

function recallDeps(over = {}) {
  const t = over.tape ?? tape();
  const vic = over.vic ?? entry({ id: 'vic', name: 'Vic', cwd: '/wt/vic' });
  const reg = over.registry ?? registry({ vic });
  const deps = {
    hiveEnabled: () => over.enabled ?? true,
    registry: () => reg,
    isOnVacation: (id) =>
      typeof over.vacationFlags === 'function'
        ? over.vacationFlags(id)
        : (over.vacationFlags?.[id] ?? true),
    ptyForAgent: (id) => (over.ptyId !== undefined && id === 'vic' ? over.ptyId : undefined),
    recipe: over.recipe ?? {},
    defaultCommand: over.defaultCommand,
    commandAvailable: (bin) => {
      t.push('commandAvailable', bin);
      return over.commandAvailable ?? true;
    },
    pathExists: (p) => {
      t.push('pathExists', p);
      return over.pathExists ?? true;
    },
    spawn: async (opts) => {
      t.push('spawn', JSON.stringify(opts));
      if (over.spawnThrows) throw new Error('spawn blew up');
      return over.spawnResult ?? { ok: true, worktreePath: '/wt/vic' };
    },
    setVacation: (id, v) => {
      t.push('setVacation', `${id}=${v}`);
      return over.setVacationResult ?? true;
    },
    setArchived: (id, v) => t.push('setArchived', `${id}=${v}`),
    appendLog: (e) => t.push('appendLog', JSON.stringify(e)),
    notifySpawned: (e) => {
      t.push('notifySpawned', JSON.stringify(e));
      if (over.notifyThrows) throw new Error('window torn down');
    },
    log: (...args) => t.push('log', args.join(' ')),
    ...over.deps,
  };
  return { deps, t, reg };
}

// ─── vacationRequestTarget: parse / verb / id resolution ────────────────────

test('request: agentId resolves and is trimmed; park is the default verb', () => {
  const plan = vacationRequestTarget({ agentId: '  bob ' });
  assert.deepEqual(plan, { ok: true, agentId: 'bob', recall: false, reason: undefined });
});

test('request: the "id" fallback spelling ships in the docs and must work', () => {
  const plan = vacationRequestTarget({ id: 'vic' });
  assert.equal(plan.ok, true);
  assert.equal(plan.agentId, 'vic');
});

test('request: a non-string agentId falls back to id — a number must not leak through', () => {
  const plan = vacationRequestTarget({ agentId: 42, id: 'vic' });
  assert.equal(plan.ok, true);
  assert.equal(plan.agentId, 'vic');
});

test('request: both spellings missing or blank → rejected with the exact god-facing message', () => {
  assert.deepEqual(vacationRequestTarget({}), {
    ok: false,
    error: 'missing "agentId"',
  });
  assert.deepEqual(vacationRequestTarget({ agentId: '   ' }), {
    ok: false,
    error: 'missing "agentId"',
  });
  assert.deepEqual(vacationRequestTarget({ id: 7 }), {
    ok: false,
    error: 'missing "agentId"',
  });
});

test('request: verb is case-insensitive "recall"; anything else parks', () => {
  assert.equal(vacationRequestTarget({ agentId: 'a', action: 'recall' }).recall, true);
  assert.equal(vacationRequestTarget({ agentId: 'a', action: 'RECALL' }).recall, true);
  assert.equal(vacationRequestTarget({ agentId: 'a', action: 'park' }).recall, false);
  assert.equal(vacationRequestTarget({ agentId: 'a' }).recall, false);
  // a typo'd verb parks — the exact failure mode the belt-and-suspenders
  // comment warns about; the resolution does not second-guess it
  assert.equal(vacationRequestTarget({ agentId: 'a', action: 're-call' }).recall, false);
  // a non-string action is stringified, never matched
  assert.equal(vacationRequestTarget({ agentId: 'a', action: 5 }).recall, false);
});

test('request: reason passes through verbatim for the park log line', () => {
  const plan = vacationRequestTarget({ agentId: 'a', reason: 'quiet sprint' });
  assert.equal(plan.reason, 'quiet sprint');
});

test('request (pinned edge): a null JSON body throws — the inline code dereferenced raw.agentId', () => {
  // JSON.parse('null') parses fine; the inline resolution then dereferenced
  // null and the throw escaped processVacationRequest's parse try/catch.
  // Pinned as-is per the zero-behavior-change boundary of this card.
  assert.throws(() => vacationRequestTarget(null), TypeError);
});

// ─── parkAgentCore: the refusal ladder ──────────────────────────────────────

test('park: hive disabled refuses before anything is read', () => {
  const { deps, t } = parkDeps({ enabled: false });
  assert.deepEqual(parkAgentCore(deps, 'bob'), { ok: false, error: 'hive disabled' });
  assert.equal(t.events.length, 0); // no registry read, no side effects
});

test('park: unknown agent names the id in the refusal', () => {
  const { deps } = parkDeps();
  assert.deepEqual(parkAgentCore(deps, 'ghost'), {
    ok: false,
    error: 'no agent "ghost" in the registry',
  });
});

test('park: god does not go on vacation — by entry flag OR by registry godId', () => {
  const a = parkDeps({ bob: entry({ isGod: true }) });
  assert.deepEqual(parkAgentCore(a.deps, 'bob'), {
    ok: false,
    error: 'god does not go on vacation',
  });
  const b = parkDeps({ registry: registry({ bob: entry() }, 'bob') }); // godId match, no flag
  assert.deepEqual(parkAgentCore(b.deps, 'bob'), {
    ok: false,
    error: 'god does not go on vacation',
  });
});

test('park: interns are fired, never parked', () => {
  const { deps } = parkDeps({ bob: entry({ role: 'intern' }) });
  assert.deepEqual(parkAgentCore(deps, 'bob'), {
    ok: false,
    error: '"bob" is an intern — interns are fired, never parked',
  });
});

test('park: retired and vacation are mutually exclusive', () => {
  const { deps } = parkDeps({ bob: entry({ retired: true }) });
  assert.deepEqual(parkAgentCore(deps, 'bob'), {
    ok: false,
    error: '"bob" was fired — retired and vacation are mutually exclusive',
  });
});

test('park: an agent already flagged vacation is refused idempotently', () => {
  const { deps } = parkDeps({ bob: entry({ vacation: true }) });
  assert.deepEqual(parkAgentCore(deps, 'bob'), {
    ok: false,
    error: '"bob" is already on vacation',
  });
});

test('park: ladder precedence — god > intern > retired > already-parked', () => {
  // intern beats retired (checked first)
  const i = parkDeps({ bob: entry({ role: 'intern', retired: true }) });
  assert.match(parkAgentCore(i.deps, 'bob').error, /intern/);
  // retired beats already-parked
  const r = parkDeps({ bob: entry({ retired: true, vacation: true }) });
  assert.match(parkAgentCore(r.deps, 'bob').error, /mutually exclusive/);
  // god beats intern
  const g = parkDeps({ bob: entry({ isGod: true, role: 'intern' }) });
  assert.match(parkAgentCore(g.deps, 'bob').error, /god does not go/);
});

test('park: a busy agent is refused — "park it when it goes quiet"', () => {
  const { deps } = parkDeps({ ptyId: 'pty1', busy: true });
  assert.deepEqual(parkAgentCore(deps, 'bob'), {
    ok: false,
    error: '"bob" is actively working — park it when it goes quiet',
  });
});

// ─── parkAgentCore: the teardown-and-persist flow ───────────────────────────

test('park: side-effect order — drop worktree entries, kill, teardown, THEN persist', () => {
  // The worktree maps MUST be dropped before teardownPty runs: teardown's
  // force-remove is correct for a closed terminal, catastrophic for a parked
  // worktree (the work IS the agent's state). Order is the contract.
  const { deps, t } = parkDeps({ ptyId: 'pty1' });
  assert.deepEqual(parkAgentCore(deps, 'bob'), { ok: true });
  assert.ok(t.before('dropWorktree:pty1', 'killPty:pty1'));
  assert.ok(t.before('killPty:pty1', 'teardownPty:pty1'));
  assert.ok(t.before('teardownPty:pty1', 'setVacation:bob=true'));
  assert.ok(
    t.before(
      'setVacation:bob=true',
      'appendLog:{"kind":"vacation_park","agentId":"bob","reason":null}',
    ),
  );
  assert.deepEqual(
    t.events.filter((e) => e.startsWith('dropWorktree')),
    ['dropWorktree:pty1'],
  );
  assert.ok(t.events.some((e) => e.startsWith('log:')));
  assert.equal(t.events.find((e) => e.startsWith('log:')).slice(4), '[vacation] parked bob');
});

test('park: no PTY means no busy check, no teardown — straight to the flag write', () => {
  const { deps, t, calls } = parkDeps({ ptyId: undefined });
  assert.deepEqual(parkAgentCore(deps, 'bob'), { ok: true });
  assert.equal(calls.busy, 0);
  assert.ok(!t.has('killPty'));
  assert.ok(!t.has('teardownPty'));
  assert.ok(!t.has('dropWorktree'));
  assert.ok(t.has('setVacation:bob=true'));
});

test('park: a kill of an already-gone PTY is swallowed — teardown is idempotent', () => {
  const { deps, t } = parkDeps({ ptyId: 'pty1', deps: undefined });
  const orig = deps.killPty;
  deps.killPty = (id) => {
    orig(id);
    throw new Error('already gone');
  };
  assert.deepEqual(parkAgentCore(deps, 'bob'), { ok: true });
  assert.ok(t.has('teardownPty:pty1'));
});

test('park: a dead renderer window is swallowed — the park itself still lands', () => {
  const { deps } = parkDeps({ notifyThrows: true });
  assert.deepEqual(parkAgentCore(deps, 'bob'), { ok: true });
});

test('park: setVacation reporting false FAILS the park — vacation_park_failed, honest error', () => {
  // vacation-review M3: the terminal is already gone and the agent sits
  // plain-archived; a failed flag write must not answer "protected, zero
  // cost, not deletable" while the registry holds none of that.
  const { deps, t } = parkDeps({ ptyId: 'pty1', setVacationResult: false });
  const res = parkAgentCore(deps, 'bob');
  assert.equal(res.ok, false);
  assert.equal(
    res.error,
    'could not persist the vacation flag — bob is archived but NOT protected; retry, or unarchive to restore it',
  );
  assert.ok(t.has('appendLog:{"kind":"vacation_park_failed","agentId":"bob"}'));
  assert.equal(
    t.events.find((e) => e.startsWith('error:')).slice(6),
    '[vacation] park bob failed: could not persist the vacation flag',
  );
  // the failure is honest about the intermediate state: teardown already ran
  assert.ok(
    t.before('teardownPty:pty1', 'appendLog:{"kind":"vacation_park_failed","agentId":"bob"}'),
  );
  // and no success log was appended
  assert.ok(!t.events.some((e) => e.includes('vacation_park"')));
});

test('park: reason is logged through — vacation_park carries it, null without', () => {
  const a = parkDeps({ ptyId: 'pty1' });
  parkAgentCore(a.deps, 'bob', 'quiet sprint');
  assert.ok(a.t.has('appendLog:{"kind":"vacation_park","agentId":"bob","reason":"quiet sprint"}'));
  assert.match(
    a.t.events.find((e) => e.startsWith('log:')).slice(4),
    /^\[vacation\] parked bob — quiet sprint$/,
  );

  const b = parkDeps();
  parkAgentCore(b.deps, 'bob');
  assert.ok(b.t.has('appendLog:{"kind":"vacation_park","agentId":"bob","reason":null}'));
});

test('park: the floor is told the PERSISTED vacationSince, re-read after the write', () => {
  const t = tape();
  let reg = registry({ bob: entry() });
  const deps = parkDeps({ tape: t, registry: reg }).deps;
  const orig = deps.setVacation;
  deps.setVacation = (id, v) => {
    const ok = orig(id, v);
    reg = registry({ bob: entry({ vacation: true, vacationSince: 1234 }) });
    return ok;
  };
  // registry() is a closure over the outer `reg` — make it live
  deps.registry = () => reg;
  parkAgentCore(deps, 'bob');
  assert.ok(t.has('notifyVacationed:{"id":"bob","vacationSince":1234}'));
});

test('park: a vanished vacationSince falls back to now for the floor event', () => {
  const { deps, t } = parkDeps();
  const before = Date.now();
  parkAgentCore(deps, 'bob');
  const evt = JSON.parse(
    t.events.find((e) => e.startsWith('notifyVacationed')).slice('notifyVacationed:'.length),
  );
  assert.ok(evt.vacationSince >= before && evt.vacationSince <= Date.now());
});

// ─── recallAgentCore: the refusal ladder ────────────────────────────────────

test('recall: hive disabled refuses first', async () => {
  const { deps } = recallDeps({ enabled: false });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), { ok: false, error: 'hive disabled' });
});

test('recall: unknown agent names the id', async () => {
  const { deps } = recallDeps();
  assert.deepEqual(await recallAgentCore(deps, 'ghost'), {
    ok: false,
    error: 'no agent "ghost" in the registry',
  });
});

test('recall: a retired agent must be reinstated first', async () => {
  const { deps } = recallDeps({ vic: entry({ id: 'vic', name: 'Vic', retired: true }) });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), {
    ok: false,
    error: '"vic" was fired — reinstate them first',
  });
});

test('recall: only a vacationer can be recalled — one check covers the park ladder', async () => {
  const { deps } = recallDeps({ vacationFlags: { vic: false } });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), {
    ok: false,
    error: '"vic" is not on vacation — nothing to recall',
  });
});

test('recall: an agent with a live PTY is already on the floor', async () => {
  const { deps } = recallDeps({ ptyId: 'pty9' });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), {
    ok: false,
    error: '"vic" is already on the floor',
  });
});

// ─── recallAgentCore: availability guards and the spawn recipe ──────────────

test("recall: engine CLI availability is checked on the command's first token", async () => {
  const { deps, t } = recallDeps({ recipe: { command: 'mycli --fast' }, commandAvailable: false });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), {
    ok: false,
    error: 'engine CLI "mycli" is not installed',
  });
  assert.ok(t.has('commandAvailable:mycli'));
  // refused before any cwd check or spawn
  assert.ok(!t.has('spawn'));
});

test('recall: command resolution — recipe wins, then the configured default, then claude', async () => {
  const a = recallDeps({ recipe: { command: 'zcli' }, commandAvailable: false });
  await recallAgentCore(a.deps, 'vic');
  assert.ok(a.t.has('commandAvailable:zcli'));

  const b = recallDeps({ defaultCommand: 'defcli', commandAvailable: false });
  await recallAgentCore(b.deps, 'vic');
  assert.ok(b.t.has('commandAvailable:defcli'));

  const c = recallDeps({ commandAvailable: false });
  await recallAgentCore(c.deps, 'vic');
  assert.ok(c.t.has('commandAvailable:claude'));
});

test('recall: cwd must resolve — recipe cwd wins over the registry cwd', async () => {
  const unset = recallDeps({
    vic: entry({ id: 'vic', name: 'Vic', cwd: undefined }),
    recipe: {},
  });
  assert.deepEqual(await recallAgentCore(unset.deps, 'vic'), {
    ok: false,
    error: 'cwd missing or not found (unset)',
  });

  const gone = recallDeps({ recipe: { cwd: '/gone' }, pathExists: false });
  assert.deepEqual(await recallAgentCore(gone.deps, 'vic'), {
    ok: false,
    error: 'cwd missing or not found (/gone)',
  });

  const won = recallDeps({ recipe: { cwd: '/wt/vic', command: 'claude' } });
  await recallAgentCore(won.deps, 'vic');
  const spec = JSON.parse(won.t.events.find((e) => e.startsWith('spawn')).slice('spawn:'.length));
  assert.equal(spec.cwd, '/wt/vic'); // the worktree — not the registry cwd
});

test('recall: the spawn recipe is pinned — isolate:false into the existing worktree', async () => {
  // isolate:false + cwd = the worktree path are the exact inputs
  // shouldAdoptWorktree needs to re-register the re-entered worktree
  // (worktree-adopt tests pin that half). Cols/rows/model flag likewise.
  const { deps, t } = recallDeps({
    recipe: { command: 'claude --x', model: 'opus', cwd: '/wt/vic', permissionMode: 'ask' },
    vic: entry({ id: 'vic', name: 'Vic', role: 'worker', provider: 'grok', cwd: '/old/cwd' }),
  });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), { ok: true });
  const spec = JSON.parse(t.events.find((e) => e.startsWith('spawn')).slice('spawn:'.length));
  assert.equal(spec.id, 'vic');
  assert.equal(spec.command, 'claude --x');
  assert.equal(spec.cols, 120);
  assert.equal(spec.rows, 32);
  assert.deepEqual(spec.args, ['--model', 'opus']);
  assert.deepEqual(spec.hive, {
    id: 'vic',
    name: 'Vic',
    provider: 'grok', // the registry entry's provider wins over inference
    role: 'worker',
    cwd: '/wt/vic',
  });
  assert.equal(spec.isolate, false);
  assert.equal(spec.provider, 'grok');
  assert.equal(spec.permissionMode, 'ask'); // the hire-time choice, never overridden
});

test('recall: provider falls back to inference from the command when the entry has none', async () => {
  const { inferAgentProvider } = loadTs('src/shared/agentProvider.ts');
  const { deps, t } = recallDeps({
    recipe: { command: 'codex', cwd: '/wt/vic' },
    vic: entry({ id: 'vic', name: 'Vic', cwd: '/wt/vic' }), // provider unset
  });
  await recallAgentCore(deps, 'vic');
  const spec = JSON.parse(t.events.find((e) => e.startsWith('spawn')).slice('spawn:'.length));
  assert.equal(spec.provider, inferAgentProvider('codex'));
});

// ─── recallAgentCore: spawn outcomes and the vacation-flag repair ───────────

test('recall: a failed spawn reports its error and never touches the flag', async () => {
  const { deps, t } = recallDeps({ spawnResult: { ok: false, error: 'no tty' } });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), { ok: false, error: 'no tty' });
  assert.ok(!t.has('setVacation:vic=false'));
  assert.ok(!t.events.some((e) => e.includes('vacation_recall')));
});

test('recall: a throwing spawn is caught and reported — never escapes to the watcher', async () => {
  const { deps } = recallDeps({ spawnThrows: true });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), {
    ok: false,
    error: 'Error: spawn blew up',
  });
});

test('recall: ensureAgent already cleared the flag → no repair, floor notified, logged', async () => {
  // The FAST path: the ladder's vacation check passes, then the spawn itself
  // clears the flag, so the recall does not call setVacation/setArchived at all.
  let vacationChecks = 0;
  const { deps, t } = recallDeps({
    vacationFlags: () => ++vacationChecks < 2, // ladder: true, post-spawn: false
    spawnResult: { ok: true, worktreePath: '/wt/vic' },
    vic: entry({ id: 'vic', name: 'Vic', role: 'worker', cwd: '/wt/vic' }),
  });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), { ok: true });
  assert.ok(!t.events.some((e) => e.startsWith('setVacation')));
  assert.ok(!t.events.some((e) => e.startsWith('setArchived')));
  const evt = JSON.parse(
    t.events.find((e) => e.startsWith('notifySpawned')).slice('notifySpawned:'.length),
  );
  assert.equal(evt.id, 'vic');
  assert.equal(evt.name, 'Vic');
  assert.equal(evt.cwd, '/wt/vic'); // worktreePath when the spawn reports one
  assert.equal(evt.worktreePath, '/wt/vic');
  assert.ok(t.has('appendLog:{"kind":"vacation_recall","agentId":"vic"}'));
  assert.equal(t.events.find((e) => e.startsWith('log:')).slice(4), '[vacation] recalled vic');
});

test('recall: the floor event cwd falls back to the spawn cwd when no worktree was made', async () => {
  let vacationChecks = 0;
  const { deps, t } = recallDeps({
    vacationFlags: () => ++vacationChecks < 2,
    spawnResult: { ok: true }, // no worktreePath
    vic: entry({ id: 'vic', name: 'Vic', role: 'worker', cwd: '/wt/vic' }),
  });
  await recallAgentCore(deps, 'vic');
  const evt = JSON.parse(
    t.events.find((e) => e.startsWith('notifySpawned')).slice('notifySpawned:'.length),
  );
  assert.equal(evt.cwd, '/wt/vic');
  assert.equal(evt.worktreePath, undefined);
});

test('recall: a stuck flag is repaired — clear, unarchive, log vacation_recall_repair', async () => {
  // spawnAgentCore swallows ensureAgent failures by design; the recall must
  // not trust the green spawn. Repair order: setVacation(false) →
  // setArchived(false) → repair log.
  const { deps, t } = recallDeps({ vacationFlags: { vic: true } });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), { ok: true });
  assert.ok(t.before('setVacation:vic=false', 'setArchived:vic=false'));
  assert.ok(
    t.before(
      'setArchived:vic=false',
      'appendLog:{"kind":"vacation_recall_repair","agentId":"vic"}',
    ),
  );
  assert.ok(
    t.before(
      'appendLog:{"kind":"vacation_recall_repair","agentId":"vic"}',
      'appendLog:{"kind":"vacation_recall","agentId":"vic"}',
    ),
  );
});

test('recall: repair failure is LOUD — vacation_recall_repair_failed, not-ok, no fake green', async () => {
  // vacation-review M3: the agent is live but invisible to every roster read
  // while its PTY burns tokens. God must be told, not discover a dead route.
  const { deps, t } = recallDeps({ vacationFlags: { vic: true }, setVacationResult: false });
  const res = await recallAgentCore(deps, 'vic');
  assert.equal(res.ok, false);
  assert.equal(
    res.error,
    'vic is spawned but the vacation flag is stuck — it is invisible to the rosters; check registry.json',
  );
  assert.ok(t.has('appendLog:{"kind":"vacation_recall_repair_failed","agentId":"vic"}'));
  assert.ok(!t.events.some((e) => e.startsWith('setArchived')));
  assert.ok(!t.has('appendLog:{"kind":"vacation_recall","agentId":"vic"}')); // no success log
});

test('recall: a dead renderer window is swallowed — the recall still lands', async () => {
  const { deps } = recallDeps({ notifyThrows: true });
  assert.deepEqual(await recallAgentCore(deps, 'vic'), { ok: true });
});
