'use strict';

/**
 * Access-time orient gate — Card B (card agent-harness-b-access-time-or-
 * 2026-08-20, spec docs/superpowers/specs/2026-08-20-access-time-orient-
 * gate.md §12): the 16 acceptance cases against the pure decide function,
 * with fake probes (the orient-inject house pattern). Case 16 is the
 * tripwire: it runs the REAL orientationBlock (no mocking) so Card A's
 * render and Card B's parse can never drift apart silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { orientGate, BULLET_RE } = loadTs('src/main/orientGate.ts');
const { orientationBlock } = loadTs('src/main/orientInject.ts');

/** Fake probe: existsSync over a set of existing paths. */
function probeOf(existing) {
  const set = new Set(existing);
  return (p) => set.has(p);
}

const MERLIN = '/opt/django/projects/merlin_hlog';
const HOME = '/home/x/agent'; // session cwd, docs-less — the agent's own dir
const CWDS = [MERLIN];
const DOCS = [MERLIN + '/CLAUDE.md'];

/** One gate call against a fresh (or passed-in) seen-state. */
function gate(extra, prev) {
  return orientGate(prev ?? null, {
    sessionCwd: HOME,
    probe: probeOf(DOCS),
    context: () => ({ sessionCwd: HOME, provider: 'claude', registryCwds: CWDS }),
    ...extra,
  });
}

// 1. read into a registered, docs-carrying root outside cwd → deny naming it.
test('1 — first access into an unoriented docs root denies and records it', () => {
  const res = gate({
    toolName: 'Read',
    toolInput: { file_path: MERLIN + '/qbase/qslip/models.py' },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'denies');
  assert.match(res.deny, new RegExp(MERLIN));
  assert.match(res.deny, /CLAUDE\.md/);
  assert.ok(res.state.roots.has(MERLIN), 'root recorded');
});

// 2. the byte-identical call repeated → passes (deadlock-freedom).
test('2 — the verbatim retry passes', () => {
  const first = gate({
    toolName: 'Read',
    toolInput: { file_path: MERLIN + '/qbase/qslip/models.py' },
    sessionId: 's1',
  });
  const second = gate(
    {
      toolName: 'Read',
      toolInput: { file_path: MERLIN + '/qbase/qslip/models.py' },
      sessionId: 's1',
    },
    first.state,
  );
  assert.equal(second.deny, null);
});

// 3. a different path under the same (seen) root → passes.
test('3 — another path under a seen root passes', () => {
  const first = gate({
    toolName: 'Read',
    toolInput: { file_path: MERLIN + '/qbase/qslip/models.py' },
    sessionId: 's1',
  });
  const second = gate(
    {
      toolName: 'Bash',
      toolInput: { command: 'grep -r x ' + MERLIN + '/qbase/views.py' },
      sessionId: 's1',
    },
    first.state,
  );
  assert.equal(second.deny, null);
});

// 4. a path inside the session cwd subtree → passes; probe never invoked.
test('4 — inside-cwd call passes on the fast path without probing', () => {
  let probes = 0;
  const res = orientGate(null, {
    toolName: 'read',
    toolInput: { file_path: HOME + '/src/main.ts' },
    sessionId: 's1',
    sessionCwd: HOME,
    probe: () => {
      probes++;
      return true;
    },
    context: () => ({ sessionCwd: HOME, provider: 'claude', registryCwds: CWDS }),
  });
  assert.equal(res.deny, null);
  assert.equal(probes, 0, 'fast path never probes');
});

// 5. resolved root is an ancestor of the session cwd → passes. Bash (no
// path fast path) so the parse-loop exemption branch itself executes.
test('5 — a root that is ancestor-or-self of cwd is exempt', () => {
  const res = orientGate(null, {
    toolName: 'bash',
    toolInput: { command: 'grep -rn TODO ' + MERLIN + '/qbase/settings.py' },
    sessionId: 's1',
    sessionCwd: MERLIN + '/qbase',
    probe: probeOf(DOCS),
    context: () => ({ sessionCwd: MERLIN + '/qbase', provider: 'claude', registryCwds: CWDS }),
  });
  assert.equal(res.deny, null);
});

// 6. reading a docs file passes AND marks its root seen.
test('6 — reading the docs file itself passes and marks the root seen', () => {
  const first = gate({
    toolName: 'read',
    toolInput: { file_path: MERLIN + '/CLAUDE.md' },
    sessionId: 's1',
  });
  assert.equal(first.deny, null);
  assert.ok(first.state.roots.has(MERLIN), 'root marked seen by the read');
  const second = gate(
    { toolName: 'read', toolInput: { file_path: MERLIN + '/qbase/models.py' }, sessionId: 's1' },
    first.state,
  );
  assert.equal(second.deny, null, 'subtree access after orienting passes');
});

// 7. the incident case: psql by db name, no filesystem path in the command.
test('7 — bash psql by basename denies via the S2 idiom match', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'PGPASSWORD=x psql -h localhost -U merlin -d merlin_hlog' },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'denies');
  assert.match(res.deny, new RegExp(MERLIN));
});

// 8. worktree path resolves to the OWNING checkout root via the S3 walk.
test('8 — worktree access names the owning checkout root', () => {
  const CK = '/some/unregistered/checkout';
  const res = orientGate(null, {
    toolName: 'read',
    toolInput: { file_path: CK + '/.worktrees/wt1/src/x.py' },
    sessionId: 's1',
    sessionCwd: HOME,
    probe: probeOf([CK, CK + '/AGENTS.md']),
    context: () => ({ sessionCwd: HOME, provider: 'claude', registryCwds: [] }),
  });
  assert.ok(res.deny, 'denies');
  assert.match(res.deny, new RegExp('- ' + CK + ': read AGENTS\\.md first'));
});

// 9. a docs-less directory passes silently.
test('9 — docs-less directories pass silently', () => {
  const res = gate({
    toolName: 'read',
    toolInput: { file_path: '/tmp/x/y/z.py' },
    sessionId: 's1',
  });
  assert.equal(res.deny, null);
});

// 10. grep/glob without a path field (defaults to cwd) pass.
test('10 — grep/glob without a path field pass', () => {
  assert.equal(
    gate({ toolName: 'grep', toolInput: { pattern: 'foo' }, sessionId: 's1' }).deny,
    null,
  );
  assert.equal(gate({ toolName: 'glob', toolInput: {}, sessionId: 's1' }).deny, null);
});

// 11. unknown tool names and missing/malformed tool_input pass.
test('11 — unknown tools and malformed input pass', () => {
  assert.equal(
    gate({ toolName: 'Write', toolInput: { file_path: MERLIN + '/x.py' }, sessionId: 's1' }).deny,
    null,
  );
  assert.equal(gate({ toolName: 'read', sessionId: 's1' }).deny, null);
  assert.equal(gate({ toolName: 'read', toolInput: 'garbage', sessionId: 's1' }).deny, null);
  assert.equal(
    gate({ toolName: 'read', toolInput: { file_path: 42 }, sessionId: 's1' }).deny,
    null,
  );
});

// 12. fail open: throwing probe, empty registry, internal error — never throw.
test('12 — a broken gate fails open', () => {
  const throwing = () => {
    throw new Error('stat exploded');
  };
  const a = orientGate(null, {
    toolName: 'read',
    toolInput: { file_path: MERLIN + '/qbase/x.py' },
    sessionId: 's1',
    sessionCwd: HOME,
    probe: throwing,
    context: () => ({ sessionCwd: HOME, provider: 'claude', registryCwds: CWDS }),
  });
  assert.equal(a.deny, null, 'orientationBlock swallows probe throws');

  const b = orientGate(null, {
    toolName: 'read',
    toolInput: { file_path: MERLIN + '/qbase/x.py' },
    sessionId: 's1',
    sessionCwd: HOME,
    probe: probeOf(DOCS),
    context: () => ({ sessionCwd: HOME, provider: 'claude', registryCwds: [] }),
  });
  assert.equal(b.deny, null, 'empty registry passes');

  const c = orientGate(null, {
    toolName: 'read',
    toolInput: { file_path: MERLIN + '/qbase/x.py' },
    sessionId: 's1',
    sessionCwd: HOME,
    probe: probeOf(DOCS),
    context: () => {
      throw new Error('registry exploded');
    },
  });
  assert.equal(c.deny, null, 'context throws are caught by the gate');
});

// 13. refusal text: verbatim bullet (with graphify hint) + retry/once sentences.
test('13 — the refusal carries the verbatim bullet and the retry contract', () => {
  const res = orientGate(null, {
    toolName: 'read',
    toolInput: { file_path: MERLIN + '/qbase/models.py' },
    sessionId: 's1',
    sessionCwd: HOME,
    probe: probeOf([...DOCS, MERLIN + '/graphify-out/graph.json']),
    context: () => ({ sessionCwd: HOME, provider: 'claude', registryCwds: CWDS }),
  });
  assert.ok(res.deny);
  const bullet =
    '- ' +
    MERLIN +
    ': read CLAUDE.md first and follow what it mandates. Knowledge graph present: run `graphify query "<question>"` before any grep.';
  assert.ok(res.deny.includes(bullet), 'bullet line verbatim, graphify hint included');
  assert.match(res.deny, /re-run this exact call/);
  assert.match(res.deny, /once per directory per session/);
});

// 14. one bash command, two fresh roots → a single deny naming both.
test('14 — multiple fresh roots deny once, all recorded', () => {
  const A = '/srv/proj_alpha';
  const B = '/srv/proj_beta';
  const res = orientGate(null, {
    toolName: 'bash',
    toolInput: { command: 'diff -r ' + A + '/src ' + B + '/src' },
    sessionId: 's1',
    sessionCwd: HOME,
    probe: probeOf([A, B, A + '/CLAUDE.md', B + '/AGENTS.md']),
    context: () => ({ sessionCwd: HOME, provider: 'claude', registryCwds: [] }),
  });
  assert.ok(res.deny);
  assert.match(res.deny, new RegExp('- ' + A + ':'));
  assert.match(res.deny, new RegExp('- ' + B + ':'));
  assert.ok(res.state.roots.has(A) && res.state.roots.has(B), 'both recorded');
});

// 15. a new session_id replaces the seen-set; old roots refuse again once.
test('15 — session change resets the seen-set', () => {
  const first = gate({
    toolName: 'read',
    toolInput: { file_path: MERLIN + '/CLAUDE.md' },
    sessionId: 's1',
  });
  assert.ok(first.state.roots.has(MERLIN));
  const fresh = gate(
    { toolName: 'read', toolInput: { file_path: MERLIN + '/qbase/models.py' }, sessionId: 's2' },
    first.state,
  );
  assert.ok(fresh.deny, 'fresh session refuses the previously-seen root once more');
  assert.equal(fresh.state.sessionKey, 's2');
  const again = gate(
    { toolName: 'read', toolInput: { file_path: MERLIN + '/qbase/models.py' }, sessionId: 's2' },
    fresh.state,
  );
  assert.equal(again.deny, null);
});

// 16. TRIPWIRE: the REAL orientationBlock render parses back to its roots.
test('16 — tripwire: A render parses back through BULLET_RE', () => {
  const block = orientationBlock(
    'work in ' + MERLIN + ' today',
    '',
    'claude',
    [MERLIN],
    probeOf([...DOCS, MERLIN + '/graphify-out/graph.json']),
  );
  assert.ok(block, 'A renders a block on the fixture');
  const roots = [];
  for (const line of block.split('\n')) {
    const m = BULLET_RE.exec(line);
    if (m) roots.push(m[1]);
  }
  assert.deepEqual(roots, [MERLIN], 'parse extracts the rendered root back out');
});

// 17. FP1 (2026-08-21): hive-park --reason prose mentions the parked agent's
// project by name — the gate keyed on the REGISTERED CWD via the S2 basename
// idiom, though parking reads/writes nothing in that directory. A lifecycle
// primitive operates ON an agent, never IN its directory: its segment is
// exempt (card agent-orient-gate-fires-on-cal-2026-08-21).
test('17 — hive-park with project-name prose in --reason passes', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: {
      command: 'hive-park kevin-msvz1zi6 --reason "done with merlin_hlog for now"',
    },
    sessionId: 's1',
  });
  assert.equal(res.deny, null);
});

// 18. FP2 (2026-08-21): hive-dispatch --body prose carries a full project
// path — a MENTION, not an access; the worker is who enters the directory,
// and the worker has its own gate (plus Card A's injected ORIENT FIRST).
test('18 — hive-dispatch with a project path in --body prose passes', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: {
      command: 'hive-dispatch --card c1 --body "fix the exporter in ' + MERLIN + '/qbase today"',
    },
    sessionId: 's1',
  });
  assert.equal(res.deny, null);
});

// 18b. same shape via $HIVE_ROOT/bin path and inside a compound whose second
// segment IS a real read — only the primitive segment is exempt.
test('18b — $HIVE_ROOT/bin form passes; a sibling real read still denies', () => {
  const primitive = gate({
    toolName: 'Bash',
    toolInput: { command: '"$HIVE_ROOT/bin/hive-dispatch" --card c1 --body "see ' + MERLIN + '"' },
    sessionId: 's1',
  });
  assert.equal(primitive.deny, null);

  const mixed = gate({
    toolName: 'Bash',
    toolInput: {
      command: 'hive-card list && cat ' + MERLIN + '/qbase/manage.py',
    },
    sessionId: 's1',
  });
  assert.ok(mixed.deny, 'the non-primitive segment still denies');
  assert.match(mixed.deny, new RegExp(MERLIN));
});

// 18c. quote-awareness is load-bearing: `;` inside the --reason prose must
// not fracture the primitive segment into a "non-primitive" half (the
// shared-state gate's segments() mask does the splitting).
test('18c — shell metachars inside primitive prose do not fracture the exemption', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: {
      command: 'hive-park kevin-msvz1zi6 --reason "park; merlin_hlog idle | no cards"',
    },
    sessionId: 's1',
  });
  assert.equal(res.deny, null);
});

// 18d. sh -c wrapping recurses: a wrapped primitive is exempt, a wrapped
// real read is not.
test('18d — sh -c bodies recurse: primitive passes, real read denies', () => {
  const wrapped = gate({
    toolName: 'Bash',
    toolInput: { command: 'sh -c \'hive-park kevin --reason "merlin_hlog idle"\'' },
    sessionId: 's1',
  });
  assert.equal(wrapped.deny, null);

  const real = gate({
    toolName: 'Bash',
    toolInput: { command: "sh -c 'cat " + MERLIN + "/qbase/manage.py'" },
    sessionId: 's1',
  });
  assert.ok(real.deny, 'a wrapped real read still denies');
});

// 19. THE BACKSTOP: a genuine outside-cwd read still denies once, and the
// verbatim retry passes — the narrowing must not weaken the gate's real job
// (it fired correctly on god's first read into /opt/munder-difflin).
test('19 — a real directory read is still gated (deny once, retry passes)', () => {
  const first = gate({
    toolName: 'Bash',
    toolInput: { command: 'cat ' + MERLIN + '/qbase/manage.py' },
    sessionId: 's1',
  });
  assert.ok(first.deny, 'real read denies');
  assert.match(first.deny, new RegExp(MERLIN));
  const retry = gate(
    {
      toolName: 'Bash',
      toolInput: { command: 'cat ' + MERLIN + '/qbase/manage.py' },
      sessionId: 's1',
    },
    first.state,
  );
  assert.equal(retry.deny, null);
});

// 20. review blocker 1a: single `&` (background) is not a `segments()`
// separator — a real read tacked on after a primitive must still deny.
test('20 — background `&` after a primitive still gates the real read', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list & cat ' + MERLIN + '/qbase/manage.py' },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the backgrounded real read denies');
  assert.match(res.deny, new RegExp(MERLIN));
  // fd-dup noise (`2>&1`) must not break the primitive itself.
  const dup = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list 2>&1' },
    sessionId: 's1',
  });
  assert.equal(dup.deny, null);
});

// 21. review blockers 1b/1c: redirects and live command substitutions inside
// an exempt primitive segment are real access — the shell opens the file /
// executes the substitution before the primitive runs.
test('21 — input redirects and $(…) bodies in primitive segments deny', () => {
  const rd = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list < ' + MERLIN + '/qbase/manage.py' },
    sessionId: 's1',
  });
  assert.ok(rd.deny, 'input redirect denies');

  const sub = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-park kevin --reason "$(cat ' + MERLIN + '/qbase/manage.py)"' },
    sessionId: 's1',
  });
  assert.ok(sub.deny, 'live command substitution denies');
});

// 22. review blocker 2: SH_C is unanchored — a real read BEFORE a trailing
// `sh -c 'primitive'` must not be swallowed by the recursion.
test('22 — text before a trailing sh -c is still scanned', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'cat ' + MERLIN + "/qbase/manage.py sh -c 'hive-card list'" },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the leading real read denies');
  assert.match(res.deny, new RegExp(MERLIN));
});

// 23. review finding 3: the documented launcher form
// `"$HIVE_NODE" "$HIVE_ROOT/bin/hive-restart-window" … --repo <project>`
// is a primitive invocation — its --repo prose is a mention, not an access.
test('23 — the $HIVE_NODE launcher form is recognized as primitive', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: {
      command: '"$HIVE_NODE" "$HIVE_ROOT/bin/hive-restart-window" arm deadbeef --repo ' + MERLIN,
    },
    sessionId: 's1',
  });
  assert.equal(res.deny, null);
});

// 24. the stdin form: hive-dispatch takes its contract by heredoc — the body
// lines are PROSE fed to the primitive, not commands, and must not deny.
test('24 — a heredoc-fed dispatch body is prose, not access', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: {
      command:
        '"$HIVE_ROOT/bin/hive-dispatch" --card c1 <<\'EOF\'\nfix the exporter in ' +
        MERLIN +
        '/qbase today\nEOF',
    },
    sessionId: 's1',
  });
  assert.equal(res.deny, null);
});

// 25. review round 2, finding 1a: a command AFTER a completed heredoc must
// not be absorbed into the primitive segment.
test('25 — a read after a heredoc terminator still denies', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: {
      command: "hive-dispatch --card c <<'EOF'\nbody\nEOF\ncat " + MERLIN + '/qbase/manage.py',
    },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the post-heredoc read denies');
  assert.match(res.deny, new RegExp(MERLIN));
});

// 26. round 2, finding 1b: the introducer-line TAIL after <<EOF (a pipe)
// is a real command — the heredoc body belongs to the primitive, the tail
// does not.
test('26 — a pipe tail on the heredoc introducer line still denies', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: {
      command: 'hive-dispatch --card c <<EOF | cat ' + MERLIN + '/qbase/manage.py\nbody\nEOF',
    },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the pipe tail denies');
  assert.match(res.deny, new RegExp(MERLIN));
});

// 27. round 2, finding 2: herestrings, comments, and spaced delimiters are
// not heredocs that swallow the next command.
test('27 — herestring / comment / spaced-delimiter lines do not swallow the next command', () => {
  const a = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list <<<x\ncat ' + MERLIN + '/qbase/manage.py' },
    sessionId: 's1',
  });
  assert.ok(a.deny, 'herestring: the next line denies');

  const b = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list # <<EOF\ncat ' + MERLIN + '/qbase/manage.py' },
    sessionId: 's1',
  });
  assert.ok(b.deny, 'comment: the next line denies');

  const c = gate({
    toolName: 'Bash',
    toolInput: {
      command:
        'hive-dispatch --card c << EOF\nprose merlin_hlog here\nEOF\ncat ' +
        MERLIN +
        '/qbase/manage.py',
    },
    sessionId: 's1',
  });
  assert.ok(c.deny, 'spaced delimiter: body prose does not deny, the next line does');
});

// 28. round 2, finding 3: UNQUOTED command substitution with split chars
// must not fracture the segment — the substitution body is real access.
test('28 — unquoted $(…) with pipes denies, not fractures', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-park k --reason $(cat ' + MERLIN + '/qbase/manage.py | true)' },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the unquoted substitution body denies');
});

// 29. round 2, finding 4: process substitution bodies are real access.
test('29 — process substitution <(…) bodies deny', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-park k --reason <(cat ' + MERLIN + '/qbase/manage.py)' },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the process substitution body denies');
});

// 30. round 2, finding 5: quoted redirect operands still open the file.
test('30 — quoted redirect operands deny', () => {
  const in_ = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list < "' + MERLIN + '/qbase/manage.py"' },
    sessionId: 's1',
  });
  assert.ok(in_.deny, 'quoted input redirect denies');
  const out_ = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list > "' + MERLIN + '/qbase/manage.py"' },
    sessionId: 's1',
  });
  assert.ok(out_.deny, 'quoted output redirect denies');
});

// 31. round 2, finding 7: heredoc-body expansions follow the DELIMITER's
// quoting — quoted delimiter: prose (pass); unquoted: live (deny).
test('31 — heredoc bodies expand per delimiter quoting', () => {
  const quoted = gate({
    toolName: 'Bash',
    toolInput: {
      command:
        "hive-dispatch --card c <<'EOF'\nsee $(cat " + MERLIN + '/qbase/manage.py) in prose\nEOF',
    },
    sessionId: 's1',
  });
  assert.equal(quoted.deny, null, 'quoted delimiter: body is literal prose');

  const live = gate({
    toolName: 'Bash',
    toolInput: {
      command: 'hive-dispatch --card c <<EOF\nsee $(cat ' + MERLIN + '/qbase/manage.py)\nEOF',
    },
    sessionId: 's1',
  });
  assert.ok(live.deny, 'unquoted delimiter: body substitution is live access');
});

// 32. round 2, finding 8: fd-dup `2>&1` mid-arguments is not a background
// split — the primitive and its prose stay one segment.
test('32 — fd-dup 2>&1 mid-args does not fracture the primitive', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-dispatch --card c 2>&1 --body "work in merlin_hlog today"' },
    sessionId: 's1',
  });
  assert.equal(res.deny, null);
});

// 33. round 3, finding 1: no-space metachar tail after a heredoc op — the
// delimiter is a shell WORD, it must stop at | ; & ( ) < >.
test('33 — no-space <<EOF|cat tail denies; escaped and mixed delimiters lex as words', () => {
  const a = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list <<EOF|cat ' + MERLIN + '/qbase/manage.py\nbody\nEOF' },
    sessionId: 's1',
  });
  assert.ok(a.deny, 'no-space pipe tail denies');

  const b = gate({
    toolName: 'Bash',
    toolInput: {
      command: 'hive-card list <<\\EOF\nprose\nEOF\ncat ' + MERLIN + '/qbase/manage.py',
    },
    sessionId: 's1',
  });
  assert.ok(b.deny, 'escaped delimiter: body is prose, the next line denies');

  const c = gate({
    toolName: 'Bash',
    toolInput: {
      command: "hive-card list <<E'OF'\nprose\nEOF\ncat " + MERLIN + '/qbase/manage.py',
    },
    sessionId: 's1',
  });
  assert.ok(c.deny, 'mixed-quoted delimiter: same');
});

// 34. round 3, finding 2: MULTIPLE heredocs on one line — every body is
// read, each with ITS OWN delimiter quoting.
test('34 — two heredocs: each body keeps its own expansion rules', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: {
      command:
        "hive-dispatch --card c <<A <<'B'\nsee $(cat " + MERLIN + '/qbase/manage.py)\nA\nprose\nB',
    },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the UNQUOTED first body expands — its substitution denies');
});

// 35. round 3, finding 3: UNQUOTED backticks are live commands too — the
// pipe inside must not fracture the segment.
test('35 — unquoted backtick substitution with a pipe denies', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-park k --reason `cat ' + MERLIN + '/qbase/manage.py | true`' },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the backtick body denies');
});

// 36. round 3, finding 4: an ESCAPED redirect char is a word, so a
// following & is background — not an fd-dup continuation.
test('36 — \\>& then a real read denies; canonical 2>&1 still passes', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list \\>& cat ' + MERLIN + '/qbase/manage.py' },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'escaped > + background & + read denies');
  const canon = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list 2>&1 --body "work in merlin_hlog"' },
    sessionId: 's1',
  });
  assert.equal(canon.deny, null);
});

// 37. round 3, finding 5: a redirect operand is a FILE the shell opens —
// never a command, so a file named hive-* must not hit the primitive test.
test('37 — a redirect operand named hive-card denies (files are not commands)', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list < ' + MERLIN + '/bin/hive-card' },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the operand path denies');
});

// 38. round 3, finding 6: quoted and unquoted fragments CONCATENATE into
// one operand word.
test('38 — fragmented quoted operands concatenate and deny', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: {
      command: 'hive-card list < "/opt/django/projects"/merlin_hlog/qbase/manage.py',
    },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the concatenated operand denies');
});

// 39. round 3, finding 7: sh -c is exec-position — its -c ARGUMENT is the
// script, words after it are data, and a trailing heredoc belongs to sh.
test('39 — sh -c + heredoc: prose passes, a live body substitution denies', () => {
  const prose = gate({
    toolName: 'Bash',
    toolInput: {
      command: "sh -c 'hive-dispatch --card c --body x' <<'EOF'\nwork in " + MERLIN + ' today\nEOF',
    },
    sessionId: 's1',
  });
  assert.equal(prose.deny, null, 'quoted-delimiter heredoc prose passes');

  const live = gate({
    toolName: 'Bash',
    toolInput: {
      command: 'sh -c \'hive-park k --reason "$(cat ' + MERLIN + '/qbase/manage.py)\""',
    },
    sessionId: 's1',
  });
  assert.ok(live.deny, 'the substitution inside the -c body denies');
});

// 40. round 3, finding 8: >&word is an fd-dup only when the word is ALL
// digits (or exactly -); a digit-prefixed FILENAME is an operand.
test('40 — >&1log is a file operand, not an fd-dup', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list >&' + MERLIN + '/1log' },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'digit-prefixed operand path denies');
});

// 41. sweep find: an EMPTY quoted delimiter (<<"") terminates on the blank
// line — a path after it is its own command, not heredoc prose.
test('41 — empty quoted delimiter terminates on the blank line', () => {
  const res = gate({
    toolName: 'Bash',
    toolInput: { command: 'hive-card list <<""\n\n' + MERLIN + '/qbase/manage.py' },
    sessionId: 's1',
  });
  assert.ok(res.deny, 'the path after the blank-line terminator denies');
});
